import {
  CERES_RADIUS, PHYSICS_SUBSTEP, normalizePos,
  type ShipInput, type WorldPos,
} from "@ceres/shared";
import { shipSubstep, drainSubsteps, admitTime, type ShipState } from "./ship";
import {
  collideShip, collideCeres, clampToBoundary, sweepHulls, separateHulls, type Body,
} from "./collision";
import { advanceLayer, collidesWithWorld, hullContactGroup } from "./layers";

/**
 * Voo COM mundo em volta: integração e colisão no mesmo laço de sub-passos.
 *
 * Por que isto existe em vez de "integra o dt inteiro e depois colide uma vez":
 * resolver o contato só no fim do passo deixa uma nave rápida atravessar a
 * rocha. A 20 Hz do servidor, o deslocamento por tick a 7000 u/s é de 350 u —
 * comparável ao raio de uma rocha pequena, e a varredura de parâmetros de
 * impacto mostrava mais de 17% da seção de choque passando batido; a 60 Hz do
 * cliente, quase nada passava. Ou seja: além de furar rocha, cliente e
 * servidor DISCORDAVAM sobre o que tinha batido.
 *
 * Com a colisão dentro do sub-passo os dois rodam exatamente o mesmo
 * h = PHYSICS_SUBSTEP e resolvem a mesma sequência de contatos. Quem garante o
 * h fixo é o acumulador de resíduo (`drainSubsteps`): enquanto o passo era
 * `dt/ceil(dt/1/120)`, um frame de 16,667 ms virava h = 5,556 ms e o tick de
 * 50 ms virava h = 8,333 ms.
 *
 * Contra rocha e contra outro casco o choque é CONTÍNUO: o trecho percorrido
 * no sub-passo é varrido, e o choque é resolvido no instante do toque —
 * `sweepRocks` para rocha, `sweepHulls` para cascos (em collision.ts). Para
 * cascos isto só passou a valer também em CADEIA nesta rodada: a varredura par
 * a par deixava o casco do meio de três atravessar o último (12 a 21 de 24
 * fases a 3000–6000 u/s, medido pelo crítico). O que está medido agora: cadeia
 * de três e três corpos simultâneos, 24 fases, 3000 a 12 000 u/s, zero
 * atravessam. Os limites são do esquema: movimento em linha reta dentro do
 * sub-passo e no máximo 16 eventos de contato por sub-passo.
 */
export interface FlightEnv {
  /**
   * Semente do mundo (procgen dos asteroides). AUSENTE = a nave não colide com
   * asteroide nenhum — é o modo táxi, que voa em linha reta pelo cinturão.
   */
  seed?: number;
  /**
   * Asteroides atravessáveis (os que hospedam estruturas), iguais para todas as
   * naves. Só é usado quando `passthroughByOwner` está ausente.
   */
  passthrough?: ReadonlySet<string>;
  /**
   * Asteroides atravessáveis POR DONO: na superfície, asteroide com estação
   * própria se atravessa e com estação inimiga é sólido. Presente, substitui
   * `passthrough` — dono sem entrada no mapa não atravessa nenhum.
   */
  passthroughByOwner?: ReadonlyMap<string, ReadonlySet<string>>;
  /** posição de Ceres; ausente = não testa o planeta */
  ceres?: WorldPos | null;
  /** raio de Ceres (padrão: CERES_RADIUS) */
  ceresRadius?: number;
  /** centro da fronteira circular da arena; ausente = arena sem borda */
  boundaryCenter?: WorldPos | null;
  /** raio da fronteira em unidades */
  boundaryRadius?: number;
  /**
   * OUTROS cascos com que resolver contato dentro do sub-passo. Existe para a
   * predição do cliente, que simula UMA nave (a própria) contra os snapshots
   * das demais e precisa dos mesmos contatos nave × nave que o servidor resolve
   * em `SimWorld.tick` — sem isto, uma colisão não predita divergia 624 u de
   * posição e 4633 u/s de velocidade em 0,2 s.
   *
   * O servidor NÃO usa este campo: lá todas as naves andam em trava e os pares
   * são resolvidos depois do sub-passo de todo mundo (ver world.ts).
   *
   * SÃO SNAPSHOTS, e a simulação os trata como tais: `Readonly` no tipo, e o par
   * é resolvido contra uma CÓPIA local de cada um (o FANTASMA, ver `ghostsFor`).
   * Nada em flight.ts entrega estes objetos a `collideShipPair`: a predição já
   * escreveu nos objetos do estado autoritativo (1314,97 u/s de vx injetados em
   * 20 frames), e o conserto do lado do cliente não sobreviveu.
   */
  contacts?: readonly Readonly<Body>[];
  /**
   * Ids ESTÁVEIS dos contatos, paralelos a `contacts` (o id da nave no estado da
   * sala). Com eles o fantasma de uma nave sobrevive à troca de snapshot, e a
   * predição sabe que o snapshot novo é ANTERIOR ao choque que ela já resolveu
   * (ver `ghostsFor`). Sem eles, cada objeto snapshot é uma nave nova, e com
   * latência o choque é resolvido duas vezes. Também dão a ORDEM canônica dos
   * pares, a mesma do servidor (ids em ordem crescente).
   */
  contactIds?: readonly string[];
  /**
   * IDADE dos snapshots, em s, no início desta chamada: quanto tempo antes do
   * presente da predição está o instante que eles descrevem (latência de rede +
   * o tempo desde que chegaram). Usada quando um snapshot aparece pela primeira
   * vez: o fantasma nasce ADIANTADO em inércia por essa idade, em vez de nascer
   * no passado. Ausente = 0, que só é verdade com latência zero.
   */
  contactsAge?: number;
}

/**
 * Sólidos do mundo (rocha e planeta): parede, sem meio-termo.
 *
 * `from` só é passado na passada que segue o VOO — lá a nave percorreu um
 * trecho, e ele é varrido contra as rochas (ver `sweepRocks`). Nas passadas de
 * acomodação (depois da fronteira, depois dos pares) a nave foi TELEPORTADA,
 * não voou: o segmento entre as duas posições não é trajetória nenhuma e
 * varrê-lo inventaria contatos.
 *
 * Devolve `true` quando mexeu na nave.
 */
export function resolveSolids(s: Body, env: FlightEnv, from?: Readonly<WorldPos>): boolean {
  // rocha e planeta só existem para quem está PARADO NA SUPERFÍCIE: em
  // cruzeiro, em modo ataque e em transição a nave passa por cima (layers.ts)
  if (!collidesWithWorld(s)) return false;
  let moved = false;
  if (env.seed !== undefined) moved = collideShip(s, env.seed, passthroughFor(s, env), from);
  if (env.ceres && collideCeres(s, env.ceres, env.ceresRadius ?? CERES_RADIUS)) moved = true;
  return moved;
}

const NO_PASSTHROUGH: ReadonlySet<string> = new Set();

/** Asteroides que ESTE corpo atravessa na superfície (ver FlightEnv.passthroughByOwner). */
function passthroughFor(s: Body, env: FlightEnv): ReadonlySet<string> | undefined {
  if (!env.passthroughByOwner) return env.passthrough;
  return env.passthroughByOwner.get(s.owner ?? "") ?? NO_PASSTHROUGH;
}

/**
 * Um sub-passo completo: integra e resolve os contatos do mundo.
 *
 * `ghosts` são os cascos COM QUE COLIDIR que não pertencem a este laço — as
 * cópias locais dos snapshots da predição do cliente, mantidas por
 * `stepShipInWorld`, já na ordem canônica. Andam em inércia no mesmo mundo
 * (batem em rocha como qualquer casco), e o par com a nave é resolvido com
 * varredura. Devolve os ÍNDICES dos fantasmas que tocaram a nave.
 *
 * O servidor chama esta função SEM fantasmas (SimWorld.tick resolve os pares
 * depois do sub-passo de todas as naves); a ordem dentro do sub-passo é a mesma
 * nos dois caminhos: voo, sólidos, fronteira, pares (varridos), sólidos de novo
 * para quem o par mexeu, e o par de novo com o casco que o sólido segurou
 * PRESO.
 */
export function flightSubstep(
  s: ShipState,
  input: ShipInput,
  h: number,
  speedMult: number,
  env: FlightEnv | null,
  ghosts?: Body[] | null,
): number[] {
  const touched: number[] = [];
  const from: WorldPos = { sx: s.sx, sy: s.sy, x: s.x, y: s.y };
  shipSubstep(s, input, h, speedMult);
  // a transição de camada anda no MESMO relógio do voo: servidor e predição
  // chegam à camada nova no mesmo sub-passo, e a colisão logo abaixo já é a
  // da camada em que a nave está ao fim dele
  advanceLayer(s, h);
  if (!env) return touched;
  normalizePos(s); // colisão precisa do setor certo para varrer a vizinhança
  resolveSolids(s, env, from);
  if (env.boundaryCenter && (env.boundaryRadius ?? 0) > 0) {
    // A fronteira roda DEPOIS dos sólidos: com raio de 500 000 u ela corta o
    // cinturão, e onde a borda passa por cima de uma rocha o empurrão para
    // dentro enfiava a nave na pedra (repousava 20 u dentro dela). Rocha é
    // matéria, fronteira é campo: se o campo mexeu na nave, os sólidos são
    // reprocessados e ganham o desempate. O preço é a nave poder assentar
    // alguns metros ALÉM da linha da fronteira quando fica entalada entre as
    // duas — o lado certo para errar, porque lá fora não há nada sólido.
    if (clampToBoundary(s, env.boundaryCenter, env.boundaryRadius as number)) {
      resolveSolids(s, env);
    }
  }
  if (!ghosts || ghosts.length === 0) return touched;
  const froms: WorldPos[] = [from];
  for (const g of ghosts) {
    // o fantasma anda em inércia junto com o sub-passo — a predição não conhece
    // o comando do outro jogador — e bate em rocha como o casco do servidor
    const gFrom: WorldPos = { sx: g.sx, sy: g.sy, x: g.x, y: g.y };
    froms.push(gFrom);
    g.x += g.vx * h;
    g.y += g.vy * h;
    normalizePos(g);
    resolveSolids(g, env, gFrom);
  }
  // a nave e TODOS os fantasmas no mesmo solver do servidor, fantasma contra
  // fantasma incluído: a cadeia de três cascos é a mesma dos dois lados
  const hit = resolveHullContacts([s, ...ghosts], froms, h, env);
  for (let i = 0; i < ghosts.length; i++) if (hit[i + 1]) touched.push(i);
  return touched;
}

/**
 * Contatos casco × casco de um sub-passo, e a última palavra dos sólidos.
 * SERVIDOR (SimWorld.tick, com todas as naves em voo) e PREDIÇÃO (a nave e os
 * fantasmas) chamam isto do mesmo jeito, com os cascos já movidos e as
 * posições de começo do sub-passo em `from`.
 *
 *  1. `sweepHulls`: varredura por eventos + solver iterativo (collision.ts).
 *  2. Quem o par mexeu passa de novo pelos sólidos: a separação pode empurrar
 *     o casco para dentro de uma rocha já resolvida neste sub-passo (sem isto
 *     assentava 23,1 u dentro da pedra). Quem a rocha segurou fica PRESO.
 *  3. `separateHulls` desfaz sobreposição residual, com os presos de massa
 *     infinita — senão rocha e par se revezavam e os cascos terminavam o tick
 *     sobrepostos 5,1–10,2 u. Quem ele mexe volta aos sólidos; até 3 voltas.
 *
 * Devolve quais cascos tocaram outro casco.
 */
export function resolveHullContacts(
  bodies: Body[],
  from: readonly Readonly<WorldPos>[],
  h: number,
  env: FlightEnv,
): boolean[] {
  // naves só se tocam dentro da MESMA camada: cada grupo (cruzeiro, superfície)
  // é um problema de contato separado; modo ataque e transição ficam de fora
  const touched = new Array<boolean>(bodies.length).fill(false);
  for (const group of HULL_GROUPS) {
    const idx: number[] = [];
    for (let i = 0; i < bodies.length; i++) if (hullContactGroup(bodies[i]) === group) idx.push(i);
    if (idx.length < 2) continue;
    const hit = resolveHullGroup(idx.map((i) => bodies[i]), idx.map((i) => from[i]), h, env);
    for (let k = 0; k < idx.length; k++) if (hit[k]) touched[idx[k]] = true;
  }
  return touched;
}

const HULL_GROUPS = ["cruise", "surface"] as const;

/** Um grupo de contato (cascos da mesma camada): o solver e os sólidos. */
function resolveHullGroup(
  bodies: Body[],
  from: readonly Readonly<WorldPos>[],
  h: number,
  env: FlightEnv,
): boolean[] {
  const touched = sweepHulls(bodies, from, h);
  for (const b of bodies) normalizePos(b);
  const pinned = bodies.map((b, i) => touched[i] && resolveSolids(b, env));
  for (let round = 0; round < 3; round++) {
    const moved = separateHulls(bodies, pinned);
    let again = false;
    for (let i = 0; i < bodies.length; i++) {
      if (!moved[i]) continue;
      normalizePos(bodies[i]);
      if (!pinned[i] && resolveSolids(bodies[i], env)) {
        pinned[i] = true;
        again = true;
      }
    }
    if (!again) break;
  }
  return touched;
}

/**
 * Integra `dt` de voo com colisão intercalada. É ESTE o ponto de entrada que
 * servidor (SimWorld.tick) e predição do cliente devem usar — chamar
 * `stepShip` e colidir depois reintroduz o tunelamento descrito acima.
 *
 * `env = null` desliga a colisão (modo táxi, que voa em linha reta).
 *
 * O tempo entra por `admitTime` AQUI DENTRO: um engasgo não pode injetar
 * segundos de mundo de uma vez. O que o teto limita é a PENDÊNCIA, não o `dt`:
 * o excedente de um quadro lento fica guardado e roda no seguinte.
 *
 * OS FANTASMAS — o que eles garantem e em que condição. Resolver o par contra o
 * snapshot congelado não é o par do servidor: o snapshot não recua, e o mesmo
 * par disparava a cada sub-passo (Δv predito de 1,083 a 2,758× o do servidor).
 * O fantasma é uma cópia que recua, anda em inércia e persiste entre quadros
 * (ver `ghostsFor`). Mas o snapshot descreve o PASSADO: chega com a latência de
 * rede e fica em uso até o seguinte. Um fantasma que nasce na posição do
 * snapshot enfrenta a nave predita contra um outro casco atrasado — medido pelo
 * crítico: razão de Δv 0,44–1,48 com 16 ms de idade e 0,65–2,60 com 50–75 ms,
 * erro de posição até 586 u. Por isso o fantasma nasce adiantado pela idade
 * (`contactsAge`), e snapshot anterior a um choque que a predição já resolveu
 * não o desfaz. A paridade com o servidor vale NA MEDIDA em que a idade
 * informada é a real — ver o bloco de predição no GameScene sobre de onde ela
 * vem.
 */
export function stepShipInWorld(
  s: ShipState,
  input: ShipInput,
  dt: number,
  speedMult: number,
  env: FlightEnv | null,
): void {
  if (!(dt > 0)) {
    normalizePos(s);
    return;
  }
  s.stepAccum = admitTime(s.stepAccum, dt);
  const { steps, rest } = drainSubsteps(s.stepAccum);
  s.stepAccum = rest;
  const book = ghostsFor(s, env);
  for (let i = 0; i < steps; i++) {
    const touched = flightSubstep(s, input, PHYSICS_SUBSTEP, speedMult, env, book?.bodies);
    if (book) {
      book.clock += PHYSICS_SUBSTEP;
      for (const k of touched) book.entries[k].lastContact = book.clock;
    }
  }
  normalizePos(s);
}

/** Um fantasma, o snapshot de onde ele nasceu e o último choque predito com ele. */
interface GhostEntry {
  src: Readonly<Body>;
  seen: GhostKey;
  ghost: Body;
  /** relógio da predição (s) no fim do último sub-passo em que tocou a nave */
  lastContact: number;
}
type GhostKey = Pick<
  Body, "sx" | "sy" | "x" | "y" | "vx" | "vy" | "av" | "kind" | "cargoAmount" | "layer" | "layerTo" | "owner"
>;

/** Estado da predição de UMA nave: relógio próprio e fantasmas por chave. */
interface GhostBook {
  /** tempo simulado (s) desde que a nave começou a ser predita com contatos */
  clock: number;
  byKey: Map<unknown, GhostEntry>;
  /** os desta chamada, na ordem canônica, e os corpos na mesma ordem */
  entries: GhostEntry[];
  bodies: Body[];
}

/**
 * Fantasmas vivos por nave predita. É estado da predição fora do `ShipState`, e
 * declarado aqui por isso: `stepShipInWorld` com contatos NÃO é função só dos
 * argumentos, depende também das chamadas anteriores para a mesma nave (como
 * já dependia do `stepAccum`). WeakMap: nave que sai de cena leva tudo junto.
 */
const ghostBook = new WeakMap<ShipState, GhostBook>();

function sameSnapshot(k: GhostKey, c: Readonly<Body>): boolean {
  return k.sx === c.sx && k.sy === c.sy && k.x === c.x && k.y === c.y
    && k.vx === c.vx && k.vy === c.vy && k.av === c.av
    && k.kind === c.kind && k.cargoAmount === c.cargoAmount
    // trocar de camada muda contra o que o casco colide: é snapshot novo
    && k.layer === c.layer && k.layerTo === c.layerTo && k.owner === c.owner;
}

function keyOf(c: Readonly<Body>): GhostKey {
  return {
    sx: c.sx, sy: c.sy, x: c.x, y: c.y, vx: c.vx, vy: c.vy,
    av: c.av, kind: c.kind, cargoAmount: c.cargoAmount,
    // o fantasma precisa da CAMADA do snapshot: sem ela cairia em cruzeiro e o
    // par com uma nave na superfície simplesmente não existiria na predição
    layer: c.layer, layerTo: c.layerTo, owner: c.owner,
  };
}

/**
 * Os fantasmas desta chamada. As regras, na ordem:
 *
 *  1. MESMO snapshot (mesmo objeto, mesmo conteúdo) → o fantasma CONTINUA de
 *     onde parou, com o recuo que levou e a inércia que andou. É o caso de todo
 *     quadro entre dois estados do servidor.
 *  2. Snapshot NOVO de uma nave cujo fantasma tocou a nave predita DEPOIS do
 *     instante que esse snapshot descreve (relógio − idade) → o snapshot ainda
 *     não sabe do choque; o fantasma CONTINUA. Sem isto (ou sem ids, que é o
 *     mesmo), o snapshot de antes do choque ressuscitava o outro casco na
 *     posição de antes e o choque se repetia: razão de Δv até 1,81 a 75 ms.
 *  3. Snapshot novo sem esse conflito → o fantasma RENASCE dele, adiantado em
 *     inércia pela idade: x + v·idade.
 *
 * A regra 2 precisa de `contactIds` (sem eles, cada objeto é uma nave nova) e
 * de uma idade que não fique muito ABAIXO da real: informada menor, o snapshot
 * passa por mais novo do que é. Medido com o chute fixo de 50 ms (o do
 * GameScene): latência real de 16 a 75 ms, Δv do choque a 0,13% do servidor;
 * de 100 ms para cima o chute fica curto e o choque se repete (27–65% de erro).
 * O preço, declarado: durante um contato sustentado nenhum snapshot é aceito,
 * e o fantasma é todo da predição até o contato acabar — a correção chega pelo
 * blend contra o estado autoritativo.
 *
 * Os fantasmas saem na ordem crescente de id, a mesma em que o servidor
 * resolve os pares; sem ids, na ordem da lista.
 */
function ghostsFor(s: ShipState, env: FlightEnv | null): GhostBook | null {
  const contacts = env?.contacts;
  if (!contacts || contacts.length === 0) {
    ghostBook.delete(s);
    return null;
  }
  const ids = env?.contactIds;
  const age = env?.contactsAge ?? 0;
  const book = ghostBook.get(s) ?? { clock: 0, byKey: new Map(), entries: [], bodies: [] };
  const order = contacts.map((c, i) => i);
  if (ids) order.sort((i, j) => (ids[i] < ids[j] ? -1 : ids[i] > ids[j] ? 1 : 0));
  const byKey = new Map<unknown, GhostEntry>();
  const entries: GhostEntry[] = [];
  const snapTime = book.clock - age;
  for (const i of order) {
    const c = contacts[i];
    if ((c as unknown) === s) continue;
    const key = ids ? ids[i] : c;
    let entry = book.byKey.get(key);
    const fresh = !entry || entry.src !== c || !sameSnapshot(entry.seen, c);
    if (fresh) {
      if (entry && entry.lastContact > snapTime) {
        // regra 2: o snapshot é de antes do choque predito — só registra que foi visto
        entry.src = c;
        entry.seen = keyOf(c);
      } else {
        // regra 3: renasce do snapshot, adiantado pela idade
        const ghost: Body = { ...keyOf(c) };
        ghost.x += c.vx * age;
        ghost.y += c.vy * age;
        normalizePos(ghost);
        entry = { src: c, seen: keyOf(c), ghost, lastContact: entry?.lastContact ?? -Infinity };
      }
    }
    byKey.set(key, entry as GhostEntry);
    entries.push(entry as GhostEntry);
  }
  book.byKey = byKey;
  book.entries = entries;
  book.bodies = entries.map((e) => e.ghost);
  ghostBook.set(s, book);
  return book;
}
