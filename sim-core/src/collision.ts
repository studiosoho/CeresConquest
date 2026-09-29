import {
  SHIP_RADIUS,
  SECTOR_SIZE,
  ASTEROID_SURFACE_RESTITUTION,
  CERES_SURFACE_RESTITUTION,
  BOUNDARY_SURFACE_RESTITUTION,
  ASTEROID_SURFACE_FRICTION,
  CERES_SURFACE_FRICTION,
  BOUNDARY_SURFACE_FRICTION,
  HULL_FRICTION,
  RESTING_CONTACT_SPEED,
  IMPACT_SPIN_LINEAR,
  IMPACT_SPIN_MAX,
  shipPhysics,
  cargoLoadFactor,
  relVec,
  normalizePos,
  type ShipKind,
  type ShipLayer,
  type WorldPos,
} from "@ceres/shared";
import { sectorAsteroids, type Asteroid } from "./procgen";

/** Qualquer corpo móvel com posição + velocidade (a nave, por ora). */
export interface Body extends WorldPos {
  vx: number;
  vy: number;
  /**
   * Velocidade angular (rad/s), se o corpo tiver atitude. Opcional: um raspão
   * imprime — e RETIRA — rotação só de quem sabe girar. Ausente significa corpo
   * rotacionalmente rígido (inércia infinita): não gira e não entra na inércia
   * efetiva do contato.
   */
  av?: number;
  /**
   * Classe do casco — define massa e restituição no impacto. Vem do PRÓPRIO
   * corpo de propósito: assim servidor e predição do cliente chegam ao mesmo
   * resultado sem precisar combinar parâmetros na chamada.
   */
  kind?: ShipKind;
  /** Carga no porão — é massa, e massa muda quem empurra quem. */
  cargoAmount?: number;
  /**
   * Camada de voo (ver shared/layers.ts). Ausente = cruzeiro: é a camada
   * padrão, e é o que vale para um snapshot que ainda não traz o campo.
   */
  layer?: ShipLayer;
  /** Camada de destino durante uma transição; "" ou ausente = parada numa camada. */
  layerTo?: ShipLayer | "";
  /**
   * Dono. Na superfície decide quais asteroides com estação são atravessáveis:
   * os de estação PRÓPRIA; os de estação inimiga são sólidos.
   */
  owner?: string;
  /**
   * Impulso normal acumulado em choques casco × casco (massa·u/s), somado pelo
   * solver a cada contato resolvido. É a matéria-prima do dano de colisão: quem
   * o converte em dano — e o zera — é o servidor. Ausente = não acumula.
   */
  hullImpulse?: number;
}

/**
 * Saturação SUAVE: identidade até `linear`, e daí para cima fecha em
 * exponencial rumo à assíntota `ceiling` — sem encostar no contínuo; em ponto
 * flutuante, com excesso acima de ~37 vezes o vão (teto − linear), o termo
 * exponencial vira zero e o resultado é o próprio teto.
 *
 * A diferença para um `clamp` é a única que importa aqui: a derivada nunca é
 * zero. Um teto duro transforma tudo que passa dele no MESMO número — e foi
 * exatamente isso que aconteceu com o tranco de impacto, que saturava em
 * praticamente todo contato real e virou constante disfarçada de limite. Com
 * esta curva, impactos diferentes continuam dando resultados diferentes por
 * toda a faixa, e o limite continua sendo um limite.
 */
function softSaturate(x: number, linear: number, ceiling: number): number {
  const a = Math.abs(x);
  if (a <= linear) return x;
  const span = ceiling - linear;
  const out = linear + span * (1 - Math.exp(-(a - linear) / span));
  return x < 0 ? -out : out;
}

/**
 * Inversa de `softSaturate`: dado um giro já saturado, devolve o giro "cru" que
 * o produziria. Diverge (+∞) em cima da assíntota, que é onde ela tem que
 * divergir — nada finito chega lá.
 */
function spinUnsaturate(y: number): number {
  const a = Math.abs(y);
  if (a <= IMPACT_SPIN_LINEAR) return y;
  const span = IMPACT_SPIN_MAX - IMPACT_SPIN_LINEAR;
  const t = 1 - (a - IMPACT_SPIN_LINEAR) / span;
  if (t <= 0) return y < 0 ? -Infinity : Infinity;
  const out = IMPACT_SPIN_LINEAR - span * Math.log(t);
  return y < 0 ? -out : out;
}

/**
 * Tranco de rotação RÍGIDO de um impulso tangencial por unidade de massa `dvt`
 * aplicado na casca: Δω = −R·dvt/k². O impulso age a SHIP_RADIUS do centro de
 * massa, logo tem braço; a massa cancela (J = m·Δvt, I = m·k²), por isso carga
 * a bordo não muda o tranco — só o raio de giração muda. Sem `av` (corpo
 * rotacionalmente rígido), zero.
 */
function rigidSpinKick(body: Body, dvt: number): number {
  if (body.av === undefined) return 0;
  const k = shipPhysics(body.kind).gyration;
  return (-SHIP_RADIUS * dvt) / (k * k);
}

/**
 * LIMITADOR DE RODOPIO — auxílio de jogabilidade DECLARADO, não física. Devolve
 * a fração f ∈ [0, 1] do tranco rígido `dav` que chega a ω; o resto é
 * momento angular que o jogo JOGA FORA, conscientemente, para que um choque
 * nunca ponha a nave a mais de IMPACT_SPIN_MAX.
 *
 * O contato em si é físico e fica inteiro: o impulso tangencial de Coulomb sai
 * todo da translação, e o giro que ele imprimiria é R·jt/k². O limitador age
 * DEPOIS, só sobre ω, com duas regras:
 *  · FREIO passa inteiro (f = 1): o tranco que reduz |ω| não tem teto — a
 *    mesma assimetria do leme (ver `governedSpin`). Antes a saturação comprimia
 *    até o freio: Δω de −1,271 em ω = 5 e −0,018 em ω = 11,9.
 *  · ACELERAÇÃO de giro satura suave rumo a IMPACT_SPIN_MAX, e a saturação é do
 *    CONTATO inteiro: soma-se na coordenada não saturada e re-satura (400
 *    sub-passos encostado numa rocha chegavam a 74,17 rad/s quando cada tranco
 *    saturava sozinho). Um impacto a partir do repouso dá `softSaturate(tranco)`.
 *
 * Por que o limitador NÃO escala também o impulso linear (como esteve por duas
 * rodadas, sob o nome de "amarra impulso ↔ giro"): porque aí quem pagava o teto
 * de giro era o ATRITO LINEAR. No teto a rocha virava gelo com a casca ainda
 * escorregando a 3354 u/s, e com k fisicamente plausível (massa concentrada, o
 * mesmo impulso gira bastante) quase todo raspão satura — o raspão do caça a
 * 6000 u/s e 30° perdia 60 u/s de tangente em vez de 219. Entre sacrificar o
 * atrito e declarar o limitador, o modelo declara o limitador: é uma sangria
 * de momento angular com nome, como o trim é uma sangria de momento linear.
 */
function spinShare(body: Body, dav: number): number {
  if (body.av === undefined || dav === 0) return 1;
  const av = body.av;
  if (Math.abs(av + dav) <= Math.abs(av)) return 1; // freio: sem teto
  const raw = spinUnsaturate(av);
  // além da assíntota (só se chega por fora do contato): não pode piorar
  if (!Number.isFinite(raw)) return 0;
  const next = softSaturate(raw + dav, IMPACT_SPIN_LINEAR, IMPACT_SPIN_MAX);
  return Math.min(1, Math.max(0, (next - av) / dav));
}

/**
 * Braço de alavanca do contato na inércia efetiva: R²/k² (rígido).
 *
 * Um impulso tangencial aplicado na CASCA não move só o centro de massa — ele
 * também torce o corpo, e as duas coisas saem do mesmo impulso. A inércia que o
 * contato "sente" na tangente é 1/m_ef = (1/m)·(1 + R²/k²): é este termo que
 * faz um casco de k grande resistir mais a ser posto para rodar. Corpo sem `av`
 * devolve 0 e se comporta como o modelo puramente translacional. O limitador
 * de rodopio NÃO entra aqui: ele age depois, só sobre ω (ver `spinShare`).
 */
function spinLever(body: Body): number {
  if (body.av === undefined) return 0;
  const k = shipPhysics(body.kind).gyration;
  return (SHIP_RADIUS * SHIP_RADIUS) / (k * k);
}

/**
 * Resolve um impacto por IMPULSO contra uma superfície IMÓVEL.
 *
 * `nx,ny` é a normal de saída (unitária, aponta da superfície para o corpo).
 * Asteroide, Ceres e fronteira são parede, sem meio-termo: a simulação nunca
 * move um asteroide (é procedural, recalculado da semente — não há onde
 * guardar um recuo), então a resposta é a de corpo contra corpo imóvel e o
 * contra-impulso é declaradamente descartado. Fingir troca de momento com uma
 * massa finita descontaria um recuo que não acontece.
 *
 * Sem teleporte e sem parada seca: a componente normal INVERTE com restituição
 * e a tangencial só perde o atrito da raspada.
 */
function resolveImpact(
  body: Body,
  nx: number,
  ny: number,
  surfaceRestitution: number,
  surfaceFriction: number,
): void {
  const vn = body.vx * nx + body.vy * ny;
  if (vn >= 0) return; // já está saindo da superfície — não há impacto

  const p = shipPhysics(body.kind);
  // contato de repouso: encostar devagar assenta em vez de quicar
  const e = -vn < RESTING_CONTACT_SPEED ? 0 : Math.min(1, p.restitution * surfaceRestitution);

  // impulso normal por unidade de massa da nave: J/m = -(1+e)·vn.
  // A rotação não entra aqui: ω×r é perpendicular a r, que é a própria normal,
  // então girar não aproxima nem afasta a casca da parede.
  const jn = -(1 + e) * vn;
  body.vx += jn * nx;
  body.vy += jn * ny;

  // ── atrito da raspada, na tangente (t = normal girada 90°) ──────────
  // O atrito age onde os corpos SE TOCAM, e a casca no ponto de contato não se
  // move com a velocidade do centro de massa: ela leva junto ω×r. Com o contato
  // a R do centro, sobre a normal, isso vale exatamente v·t − ω·R.
  //
  // Ignorar esse termo (era o que acontecia) deixava a rotação fora do contato
  // dos dois lados: raspar com ω = +5, 0 ou −5 dava vx = 225,00 nos três casos,
  // e ω saía intacto. O impacto só sabia SOMAR giro; nada no modelo o tirava, o
  // que é errado até de intuição — encostar um pião na parede o freia.
  //
  // E o atrito é de COULOMB: o tangencial não pode passar de μ·|jn| (ver as
  // constantes de atrito em shared/constants.ts). O impulso que GRUDA a casca —
  // o que mataria o deslizamento inteiro — é o alvo; μ·|jn| é o que o contato
  // consegue pagar. Sem esse teto o atrito era um amortecedor viscoso pendurado
  // na tangente: a razão |jt|/|jn| chegava a 565 com vn = −0,2 u/s, e o mesmo
  // Δvt saía de uma encostada e de um capotamento.
  const tx = -ny;
  const ty = nx;
  const lever = spinLever(body);
  const vtSurface = body.vx * tx + body.vy * ty - (body.av ?? 0) * SHIP_RADIUS;
  // o impulso se reparte entre transladar e torcer, daí o (1 + R²/k²)
  const jtStick = -vtSurface / (1 + lever);
  const jt = clampFriction(jtStick, surfaceFriction * jn);
  if (jt === 0) return;
  // o impulso inteiro na translação; no giro, o que o limitador de rodopio
  // deixa passar (ver `spinShare`)
  const dav = rigidSpinKick(body, jt);
  body.vx += jt * tx;
  body.vy += jt * ty;
  if (body.av !== undefined) body.av += spinShare(body, dav) * dav;
}

/**
 * Teto de Coulomb: devolve `jtStick` se ele couber em `cap`, senão o próprio
 * `cap` no sentido do escorregão. Nunca INVERTE o deslizamento (é atrito, não
 * mola) porque o clamp é em magnitude, com o sinal do alvo preservado.
 */
function clampFriction(jtStick: number, cap: number): number {
  const mag = Math.abs(jtStick);
  if (mag <= cap) return jtStick;
  return jtStick < 0 ? -cap : cap;
}

/** Opções do contato nave × nave. */
export interface PairOptions {
  /**
   * Onde cada casco estava no COMEÇO do sub-passo. Com os dois (e `h`), o par é
   * testado sobre o movimento RELATIVO inteiro do sub-passo, e não só sobre as
   * posições finais — ver "VARREDURA" em `collideShipPair`.
   */
  aFrom?: Readonly<WorldPos>;
  bFrom?: Readonly<WorldPos>;
  /** duração do sub-passo (s): o resto dele é cumprido com a velocidade nova */
  h?: number;
  /**
   * Casco PRESO: encostado num sólido que acabou de segurá-lo neste sub-passo.
   * Para este contato ele tem massa infinita — não se move nem recebe impulso, e
   * quem sai do caminho é o outro. Sem isto, o cargueiro que prensa o caça
   * contra a rocha e a rocha se revezavam empurrando o caça de volta, e os
   * cascos terminavam o tick sobrepostos 5–10 u.
   */
  pinA?: boolean;
  pinB?: boolean;
}

/**
 * Contato NAVE × NAVE — o único caso em que os dois corpos recuam de verdade,
 * e por isso o único resolvido como choque de dois corpos: impulso
 * j = -(1+e)·v_rel·n / (1/m₁ + 1/m₂), repartido por massa inversa. Momento
 * linear conservado (Σ m·v constante), sem energia criada (e = média das
 * restituições dos dois cascos, sempre < 1).
 *
 * A massa usada é a EFETIVA, com carga a bordo: um cargueiro cheio empurra o
 * caça para fora do caminho, não o contrário.
 *
 * VARREDURA. Com `aFrom`/`bFrom`/`h`, o par é contínuo: se os cascos começaram
 * o sub-passo separados, acha-se o instante t em que a distância RELATIVA cruza
 * 2R e o choque é resolvido lá, com a normal de lá, e cada casco cumpre o resto
 * do sub-passo com a velocidade nova. Sem isso o passo relativo (50–100 u a
 * velocidades de jogo) pulava o diâmetro de 40 u: medido, caça a 6000 u/s
 * contra nave parada, mira central, atravessava em 5 de 24 fases; de frente
 * contra outra a 5200 u/s, em 13 de 24. Sem `from` (ou com os cascos já
 * sobrepostos no começo — contato sustentado), o teste é o de posição final.
 *
 * Custo: par a par, O(n²) sobre as naves EM VOO, uma vez por sub-passo. Medido
 * no tick completo do SimWorld a 20 Hz (orçamento de 50 ms), com colisão de
 * mundo incluída, antes da varredura: 10 naves = 0,80 ms (1,6% do tick),
 * 30 = 2,59 ms, 60 = 6,38 ms, 120 = 19,85 ms. A varredura acrescenta uma
 * equação de 2º grau por par. Passando de ~150 naves em voo, o conserto é uma
 * grade espacial por setor para gerar só os pares vizinhos.
 *
 * OS DOIS LADOS SÃO ESCRITOS, sempre. A predição do cliente, que só tem o
 * snapshot autoritativo do outro jogador, NÃO chama isto com aquele objeto: ela
 * resolve o par contra um FANTASMA local (ver `stepShipInWorld`). Já houve a
 * versão em que a predição passava o objeto do servidor direto aqui — 1314,97
 * u/s de vx injetados na nave do outro em 20 frames —, e ela VOLTOU depois de
 * consertada do lado do cliente. O que impede a volta agora é o tipo:
 * `env.contacts` é `readonly Readonly<Body>[]` e nada em flight.ts entrega esses
 * objetos a esta função.
 *
 * Devolve `true` quando MEXEU nos corpos. Quem chama precisa disso: separar o
 * par pode enfiar um dos cascos numa rocha que já tinha sido resolvida neste
 * sub-passo, e aí os sólidos têm de ser reprocessados (ver `flightSubstep` e
 * `SimWorld.tick`).
 */
export function collideShipPair(a: Body, b: Body, opt?: PairOptions): boolean {
  const minDist = 2 * SHIP_RADIUS;
  const pa = shipPhysics(a.kind);
  const pb = shipPhysics(b.kind);
  const ma = pa.mass * cargoLoadFactor(a.kind ?? "builder", a.cargoAmount ?? 0);
  const mb = pb.mass * cargoLoadFactor(b.kind ?? "builder", b.cargoAmount ?? 0);
  // preso = massa infinita; os dois presos (entalados) voltam às massas reais
  const both = !!opt?.pinA && !!opt?.pinB;
  const invA = opt?.pinA && !both ? 0 : 1 / ma;
  const invB = opt?.pinB && !both ? 0 : 1 / mb;

  // ── varredura: o choque no instante em que a distância relativa cruza 2R ──
  if (opt?.aFrom && opt.bFrom && opt.h) {
    const r0 = relVec(opt.aFrom, opt.bFrom); // b − a no começo do sub-passo
    const c = r0.dx * r0.dx + r0.dy * r0.dy - minDist * minDist;
    if (c > 0) {
      const r1 = relVec(a, b);
      const ex = r1.dx - r0.dx;
      const ey = r1.dy - r0.dy;
      const A = ex * ex + ey * ey;
      const B = r0.dx * ex + r0.dy * ey;
      const disc = B * B - A * c;
      if (A > 1e-12 && B < 0 && disc >= 0) {
        const t = (-B - Math.sqrt(disc)) / A; // a raiz menor: o toque
        if (t <= 1) {
          // os dois cascos de volta ao instante do toque
          const da = relVec(opt.aFrom, a);
          const db = relVec(opt.bFrom, b);
          a.x -= (1 - t) * da.dx;
          a.y -= (1 - t) * da.dy;
          b.x -= (1 - t) * db.dx;
          b.y -= (1 - t) * db.dy;
          pairImpulse(a, b, (r0.dx + t * ex) / minDist, (r0.dy + t * ey) / minDist, invA, invB, pa.restitution, pb.restitution);
          // e o resto do sub-passo com a velocidade de saída
          const rest = (1 - t) * opt.h;
          a.x += a.vx * rest;
          a.y += a.vy * rest;
          b.x += b.vx * rest;
          b.y += b.vy * rest;
          return true;
        }
      }
      // começou separado e o trecho relativo não cruzou 2R: o teste de ponto
      // abaixo só sobra para o arredondamento na borda
    }
  }

  const { dx, dy } = relVec(a, b); // de a para b
  const d = Math.hypot(dx, dy);
  if (d >= minDist) return false;

  // normal de a para b; se coincidirem exatamente, separa em +x
  let nx = 1;
  let ny = 0;
  if (d > 1e-6) {
    nx = dx / d;
    ny = dy / d;
  }

  // separação repartida por massa inversa: o leve é quem mais sai do caminho
  // (e o preso não sai)
  const pen = minDist - (d > 1e-6 ? d : 0);
  const sepA = pen * (invA / (invA + invB));
  const sepB = pen - sepA;
  a.x -= nx * sepA;
  a.y -= ny * sepA;
  b.x += nx * sepB;
  b.y += ny * sepB;
  pairImpulse(a, b, nx, ny, invA, invB, pa.restitution, pb.restitution);
  return true;
}

/** Impulso normal + atrito + giro de um par em contato, normal `n` de a para b. */
function pairImpulse(
  a: Body, b: Body, nx: number, ny: number, invA: number, invB: number, restA: number, restB: number,
): void {
  // velocidade relativa ao longo da normal (positiva = se afastando)
  const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (vn >= 0) return;

  const e = -vn < RESTING_CONTACT_SPEED ? 0 : Math.min(1, (restA + restB) / 2);
  const j = (-(1 + e) * vn) / (invA + invB);
  a.vx -= j * invA * nx;
  a.vy -= j * invA * ny;
  b.vx += j * invB * nx;
  b.vy += j * invB * ny;

  // ── atrito de casco a casco ─────────────────────────────────────────
  // Mesma correção do contato com parede: o que raspa são as CASCAS, e cada uma
  // leva o ω×r do seu corpo. Os dois pontos de contato ficam a R do respectivo
  // centro, em lados opostos da normal, então as duas rotações entram com o
  // MESMO sinal na velocidade relativa da superfície: −R·(ω_a + ω_b). Casco
  // preso (inv = 0) não translada nem gira por este contato.
  const tx = -ny;
  const ty = nx;
  const leverA = invA > 0 ? spinLever(a) : 0;
  const leverB = invB > 0 ? spinLever(b) : 0;
  const vt =
    (b.vx - a.vx) * tx + (b.vy - a.vy) * ty - SHIP_RADIUS * ((a.av ?? 0) + (b.av ?? 0));
  const jtStick = -vt / (invA * (1 + leverA) + invB * (1 + leverB));
  // mesmo teto de Coulomb do contato com parede, sobre o impulso normal `j`
  // deste par: casco liso contra casco liso agarra menos que rocha nua
  const jt0 = clampFriction(jtStick, HULL_FRICTION * Math.abs(j));
  if (jt0 === 0) return;
  // e os dois trancos de rotação têm o MESMO sentido, não sentidos opostos: o
  // atrito pega `a` de um lado do seu centro e `b` do lado oposto do dele, e as
  // forças também são opostas, então os dois torques caem no mesmo sinal.
  const davA = rigidSpinKick(a, jt0 * invA);
  const davB = rigidSpinKick(b, jt0 * invB);
  // o impulso tangencial inteiro nos dois (momento linear conservado); no giro
  // de cada um, o que o limitador de rodopio deixa passar
  a.vx -= jt0 * invA * tx;
  a.vy -= jt0 * invA * ty;
  b.vx += jt0 * invB * tx;
  b.vy += jt0 * invB * ty;
  if (a.av !== undefined) a.av += spinShare(a, davA) * davA;
  if (b.av !== undefined) b.av += spinShare(b, davB) * davB;
}

/** Massa efetiva (com carga) e restituição de um casco. */
function hullMass(b: Body): number {
  return shipPhysics(b.kind).mass * cargoLoadFactor(b.kind ?? "builder", b.cargoAmount ?? 0);
}

/**
 * CONTATOS DE UM GRUPO DE CASCOS NUM SUB-PASSO — varredura por EVENTOS e
 * solver ITERATIVO. É o que o servidor (SimWorld.tick) e a predição (a nave e
 * os fantasmas) usam; `collideShipPair` fica para o par isolado.
 *
 * Por que não "par a par, cada um com sua varredura". Resolver um par e
 * empurrar os dois pelo resto do sub-passo sem reconferir os outros pares
 * abria túnel em cadeia: cargueiro → caça encostado noutro caça, o casco do
 * meio começava o par seguinte já sobreposto, caía no teste de ponto, passava
 * do centro e a normal invertia — medido pelo crítico, atravessava em 12 de 24
 * fases a 3000 u/s, 21 a 4000, 19 a 6000, e em espaço aberto a cadeia deixava
 * 25–40 u de sobreposição. E a ordem dos pares decidia o resultado: no mesmo
 * berço, 0,9 u/s de erro contra a referência de passo fino numa ordem de ids e
 * 2851 u/s na outra.
 *
 * O esquema:
 *  1. Cada casco anda em linha reta de `from` até onde o voo o deixou. Acha-se
 *     o PRIMEIRO instante do sub-passo em que algum par se toca (ou já está
 *     encostado e se aproximando), leva-se TODO MUNDO até esse instante, e
 *     resolve-se o GRUPO inteiro de contatos daquele instante de uma vez.
 *  2. O grupo é resolvido por Gauss-Seidel projetado (PGS) nos impulsos
 *     normais, até convergir: cada contato tem alvo vn ≥ −e·vn₀ (vn₀ = a
 *     aproximação no instante do toque) e impulso acumulado ≥ 0. As velocidades
 *     a que isso converge são a projeção das velocidades de entrada, na métrica
 *     das massas, sobre o conjunto que respeita todos os alvos — solução ÚNICA,
 *     então a ordem de varredura só muda o caminho até ela, não o ponto de
 *     chegada (a menos da tolerância de convergência).
 *  3. Quem teve a velocidade mudada refaz o resto do sub-passo com ela; os
 *     outros seguem a reta de antes. Volta ao passo 1, até 16 eventos.
 *
 * O atrito de casco a casco vem depois do grupo convergir, todos os contatos
 * a partir das mesmas velocidades (ver `hullFriction`), com o teto de Coulomb
 * sobre o impulso normal ACUMULADO de cada contato.
 *
 * Posições: escreve em cada corpo a posição final (no referencial do setor de
 * `bodies[0]`; quem chama normaliza). Devolve quais cascos tocaram alguém.
 */
export function sweepHulls(
  bodies: Body[],
  from: readonly Readonly<WorldPos>[],
  h: number,
): boolean[] {
  const n = bodies.length;
  const touched = new Array<boolean>(n).fill(false);
  if (n < 2) return touched;
  const minD = 2 * SHIP_RADIUS;
  const base: WorldPos = { sx: bodies[0].sx, sy: bodies[0].sy, x: bodies[0].x, y: bodies[0].y };
  const inv = bodies.map((b) => 1 / hullMass(b));
  const rest = bodies.map((b) => shipPhysics(b.kind).restitution);
  // posição no instante atual (P) e no fim do sub-passo (E), referencial local
  const P = from.map((f) => relVec(base, f));
  const E = bodies.map((b) => relVec(base, b));
  // FASE LARGA: só os pares cujas caixas varridas (de P a E, infladas pelo
  // raio) se cruzam. Com o aglomerado de 60 naves, de 1770 pares sobram as
  // dezenas que de fato se tocam.
  let tNow = 0;
  // o instante em que o grupo encostado foi resolvido pela última vez: um
  // contato SUSTENTADO só vira evento uma vez por instante (ver acima)
  let solvedAt = -1;
  for (let ev = 0; ev < MAX_HULL_EVENTS && tNow < 1; ev++) {
    const span = 1 - tNow;
    // refeita a cada evento: quem mudou de velocidade mudou de caixa
    const cand = broadPairs(P, E, SHIP_RADIUS + CONTACT_SLOP);
    let tBest = Infinity;
    for (const [i, j] of cand) {
      const dx = P[j].dx - P[i].dx;
      const dy = P[j].dy - P[i].dy;
      const d = Math.hypot(dx, dy);
      if (d <= minD + CONTACT_SLOP) {
        // encostados: evento AGORA se estão se aproximando — e só se o grupo
        // ainda não foi resolvido neste mesmo instante
        if (solvedAt === tNow) continue;
        const vn = ((bodies[j].vx - bodies[i].vx) * dx + (bodies[j].vy - bodies[i].vy) * dy) / (d || 1);
        if (vn < -APPROACH_TOL) tBest = tNow;
        continue;
      }
      const ex = E[j].dx - E[i].dx - dx;
      const ey = E[j].dy - E[i].dy - dy;
      const A = ex * ex + ey * ey;
      const B = dx * ex + dy * ey;
      if (A <= 1e-12 || B >= 0) continue;
      // aproximação LENTA (abaixo de RESTING_CONTACT_SPEED, e = 0 de qualquer
      // jeito): não vira evento próprio — entra como contato ESPECULATIVO no
      // grupo (ver abaixo). Num aglomerado empurrado por motor é quase todo par
      const vnLine = ((bodies[j].vx - bodies[i].vx) * dx + (bodies[j].vy - bodies[i].vy) * dy) / d;
      if (-vnLine < RESTING_CONTACT_SPEED) {
        if (solvedAt !== tNow && d - minD < -vnLine * span * h) tBest = tNow;
        continue;
      }
      const c = d * d - minD * minD;
      const disc = B * B - A * c;
      if (disc < 0) continue;
      const tau = (-B - Math.sqrt(disc)) / A;
      if (tau <= 1) tBest = Math.min(tBest, tNow + tau * span);
    }
    if (tBest === Infinity) break;
    // todo mundo até o instante do evento
    const k = span > 0 ? (tBest - tNow) / span : 0;
    if (k > 0) {
      for (let i = 0; i < n; i++) {
        P[i] = { dx: P[i].dx + (E[i].dx - P[i].dx) * k, dy: P[i].dy + (E[i].dy - P[i].dy) * k };
      }
    }
    tNow = tBest;
    // o GRUPO: todo par encostado neste instante, e os ESPECULATIVOS — pares
    // ainda separados que se aproximam devagar e fechariam a folga antes do fim
    // do sub-passo: alvo vn ≥ −folga/tempo restante, ou seja, podem chegar a
    // encostar, não a entrar
    const leftT = (1 - tNow) * h;
    const cs: HullContact[] = [];
    for (const [i, j] of cand) {
      const dx = P[j].dx - P[i].dx;
      const dy = P[j].dy - P[i].dy;
      const d = Math.hypot(dx, dy);
      const nx = d > 1e-9 ? dx / d : 1;
      const ny = d > 1e-9 ? dy / d : 0;
      const vn0 = (bodies[j].vx - bodies[i].vx) * nx + (bodies[j].vy - bodies[i].vy) * ny;
      if (d > minD + CONTACT_SLOP) {
        const gap = d - minD;
        if (leftT > 0 && -vn0 < RESTING_CONTACT_SPEED && gap < -vn0 * leftT) {
          cs.push({ i, j, nx, ny, target: -gap / leftT, lam: 0 });
        }
        continue;
      }
      const e = -vn0 < RESTING_CONTACT_SPEED ? 0 : Math.min(1, (rest[i] + rest[j]) / 2);
      cs.push({ i, j, nx, ny, target: vn0 < 0 ? -e * vn0 : 0, lam: 0 });
    }
    const v0 = bodies.map((b) => [b.vx, b.vy]);
    solveNormals(bodies, cs, inv);
    // o impulso normal de cada contato vai para os DOIS cascos: é o que cada
    // um sentiu, e o que o servidor transforma em dano (só onde o campo existe)
    for (const ct of cs) {
      if (ct.lam <= 0) continue;
      const a = bodies[ct.i];
      const b = bodies[ct.j];
      if (a.hullImpulse !== undefined) a.hullImpulse += ct.lam;
      if (b.hullImpulse !== undefined) b.hullImpulse += ct.lam;
    }
    // atrito, com o impulso normal acumulado de cada contato
    hullFriction(bodies, cs, inv);
    solvedAt = tNow;
    // quem mudou de velocidade refaz o resto do sub-passo com ela
    const left = leftT;
    for (let i = 0; i < n; i++) {
      if (bodies[i].vx === v0[i][0] && bodies[i].vy === v0[i][1]) continue;
      touched[i] = true;
      E[i] = { dx: P[i].dx + bodies[i].vx * left, dy: P[i].dy + bodies[i].vy * left };
    }
  }
  for (let i = 0; i < n; i++) {
    bodies[i].sx = base.sx;
    bodies[i].sy = base.sy;
    bodies[i].x = base.x + E[i].dx;
    bodies[i].y = base.y + E[i].dy;
  }
  return touched;
}

/** Um contato casco × casco do grupo: índices, normal de i para j, alvo e impulso acumulado. */
interface HullContact {
  i: number;
  j: number;
  nx: number;
  ny: number;
  target: number;
  lam: number;
}

/**
 * Folga (u) dentro da qual dois cascos contam como ENCOSTADOS: entram no grupo
 * de todo evento e não geram evento de varredura próprio. Cobre o
 * arredondamento e o resíduo da acomodação (≤ 1e-6 u) com margem.
 */
const CONTACT_SLOP = 1e-3;
/**
 * Sobreposição (u) que a acomodação tolera: abaixo disto o par já conta como
 * encostado (CONTACT_SLOP) e quem cuida dele é o solver de velocidade no
 * sub-passo seguinte. Exigir 1e-6 fazia a acomodação por Jacobi rodar as 32
 * voltas em TODO sub-passo num aglomerado prensado, sem convergir.
 */
const SEPARATION_TOL = CONTACT_SLOP;
/** Aproximação (u/s) abaixo da qual um par encostado não é evento. */
const APPROACH_TOL = 1e-3;
/** Teto de eventos por sub-passo. */
const MAX_HULL_EVENTS = 16;
/** Teto de voltas da acomodação por posição. */
const MAX_SEPARATION_ITERATIONS = 8;
/** Teto de voltas do PGS por evento. */
const MAX_PGS_ITERATIONS = 200;
/** Convergência do PGS: maior correção de velocidade relativa numa volta (u/s). */
const PGS_TOLERANCE = 1e-9;

/**
 * Gauss-Seidel projetado nos impulsos normais do grupo: cada contato com
 * impulso acumulado ≥ 0 e alvo vn ≥ target. Para quando a maior correção de
 * velocidade relativa numa volta fica abaixo de PGS_TOLERANCE, ou no teto de
 * MAX_PGS_ITERATIONS voltas (declarado: cadeias longas encostadas podem chegar
 * no teto; aí o resíduo de aproximação é desfeito por posição, em
 * `separateHulls`, e resolvido no sub-passo seguinte).
 */
function solveNormals(bodies: Body[], cs: HullContact[], inv: readonly number[]): void {
  for (let it = 0; it < MAX_PGS_ITERATIONS; it++) {
    let change = 0;
    for (const ct of cs) {
      const a = bodies[ct.i];
      const b = bodies[ct.j];
      const vn = (b.vx - a.vx) * ct.nx + (b.vy - a.vy) * ct.ny;
      const w = inv[ct.i] + inv[ct.j];
      const next = Math.max(0, ct.lam + (ct.target - vn) / w);
      const d = next - ct.lam;
      if (d === 0) continue;
      ct.lam = next;
      a.vx -= d * inv[ct.i] * ct.nx;
      a.vy -= d * inv[ct.i] * ct.ny;
      b.vx += d * inv[ct.j] * ct.nx;
      b.vy += d * inv[ct.j] * ct.ny;
      change = Math.max(change, Math.abs(d) * w);
    }
    if (change < PGS_TOLERANCE) break;
  }
}

/**
 * FASE LARGA por varredura e poda no eixo x: pares (i < j) cujas caixas —
 * a reta de P a E de cada um, inflada por `pad` — se cruzam. Ordenados por
 * (i, j), para que o resultado não dependa da ordem da ordenação.
 */
function broadPairs(
  P: ReadonlyArray<{ dx: number; dy: number }>,
  E: ReadonlyArray<{ dx: number; dy: number }>,
  pad: number,
): Array<[number, number]> {
  const n = P.length;
  const box = P.map((p, i) => ({
    i,
    x0: Math.min(p.dx, E[i].dx) - pad,
    x1: Math.max(p.dx, E[i].dx) + pad,
    y0: Math.min(p.dy, E[i].dy) - pad,
    y1: Math.max(p.dy, E[i].dy) + pad,
  }));
  box.sort((a, b) => a.x0 - b.x0 || a.i - b.i);
  const out: Array<[number, number]> = [];
  for (let a = 0; a < n; a++) {
    const A = box[a];
    for (let b = a + 1; b < n && box[b].x0 <= A.x1; b++) {
      const B = box[b];
      if (B.y0 > A.y1 || B.y1 < A.y0) continue;
      out.push(A.i < B.i ? [A.i, B.i] : [B.i, A.i]);
    }
  }
  out.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  return out;
}

/**
 * Atrito de casco a casco de um GRUPO de contatos, com o impulso normal
 * acumulado de cada um já aplicado (mesmo modelo de `pairImpulse`: Coulomb
 * sobre o normal, casca com ω×r, limitador de rodopio). Jacobi: todos os
 * impulsos tangenciais saem das MESMAS velocidades, então a ordem dos contatos
 * não entra. O limitador de rodopio age por casco, sobre a SOMA dos trancos
 * dele — o teto vale mesmo com dois contatos girando o mesmo casco.
 */
function hullFriction(
  bodies: Body[],
  cs: ReadonlyArray<{ i: number; j: number; nx: number; ny: number; lam: number }>,
  inv: readonly number[],
): void {
  const jts = cs.map((ct) => {
    if (ct.lam <= 0) return 0;
    const a = bodies[ct.i];
    const b = bodies[ct.j];
    const tx = -ct.ny;
    const ty = ct.nx;
    const vt =
      (b.vx - a.vx) * tx + (b.vy - a.vy) * ty - SHIP_RADIUS * ((a.av ?? 0) + (b.av ?? 0));
    const k = inv[ct.i] * (1 + spinLever(a)) + inv[ct.j] * (1 + spinLever(b));
    return clampFriction(-vt / k, HULL_FRICTION * ct.lam);
  });
  const dav = bodies.map(() => 0);
  cs.forEach((ct, c) => {
    dav[ct.i] += rigidSpinKick(bodies[ct.i], jts[c] * inv[ct.i]);
    dav[ct.j] += rigidSpinKick(bodies[ct.j], jts[c] * inv[ct.j]);
  });
  cs.forEach((ct, c) => {
    if (jts[c] === 0) return;
    const a = bodies[ct.i];
    const b = bodies[ct.j];
    const tx = -ct.ny;
    const ty = ct.nx;
    a.vx -= jts[c] * inv[ct.i] * tx;
    a.vy -= jts[c] * inv[ct.i] * ty;
    b.vx += jts[c] * inv[ct.j] * tx;
    b.vy += jts[c] * inv[ct.j] * ty;
  });
  bodies.forEach((b, i) => {
    if (b.av !== undefined && dav[i] !== 0) b.av += spinShare(b, dav[i]) * dav[i];
  });
}

/**
 * ACOMODAÇÃO: desfaz sobreposição residual entre cascos, por posição, até não
 * sobrar nenhuma acima de 1e-6 u. Casco PRESO (segurado por um sólido neste
 * sub-passo) tem massa infinita: não se move, e quem vem contra ele perde a
 * componente de aproximação (e = 0) — a rocha, através dele, é que segura.
 * Jacobi: as correções de uma volta saem todas das mesmas posições, então a
 * ordem dos pares não entra. Devolve quais cascos se moveram.
 */
export function separateHulls(bodies: Body[], pinned: readonly boolean[]): boolean[] {
  const n = bodies.length;
  const moved = new Array<boolean>(n).fill(false);
  const minD = 2 * SHIP_RADIUS;
  const inv = bodies.map((b, i) => (pinned[i] ? 0 : 1 / hullMass(b)));
  // posições locais (referencial de bodies[0]); corrigidas no lugar, par a par
  const Q = bodies.map((b) => relVec(bodies[0], b));
  const pairs = broadPairs(Q, Q, SHIP_RADIUS + SEPARATION_TOL);
  for (let it = 0; it < MAX_SEPARATION_ITERATIONS; it++) {
    let worst = 0;
    for (const [i, j] of pairs) {
      const dx = Q[j].dx - Q[i].dx;
      const dy = Q[j].dy - Q[i].dy;
      const d = Math.hypot(dx, dy);
      const pen = minD - d;
      if (pen <= SEPARATION_TOL) continue;
      worst = Math.max(worst, pen);
      const nx = d > 1e-9 ? dx / d : 1;
      const ny = d > 1e-9 ? dy / d : 0;
      let ia = inv[i];
      let ib = inv[j];
      if (ia + ib === 0) {
        ia = 1 / hullMass(bodies[i]);
        ib = 1 / hullMass(bodies[j]);
      }
      const sa = (pen * ia) / (ia + ib);
      Q[i] = { dx: Q[i].dx - nx * sa, dy: Q[i].dy - ny * sa };
      Q[j] = { dx: Q[j].dx + nx * (pen - sa), dy: Q[j].dy + ny * (pen - sa) };
      if (sa > 0) moved[i] = true;
      if (pen - sa > 0) moved[j] = true;
      // contra um casco preso, a aproximação morre (a rocha segura)
      if (inv[i] === 0 || inv[j] === 0) {
        const a = bodies[i];
        const b = bodies[j];
        const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (vn < 0) {
          const jn = -vn / (ia + ib);
          a.vx -= jn * ia * nx;
          a.vy -= jn * ia * ny;
          b.vx += jn * ib * nx;
          b.vy += jn * ib * ny;
        }
      }
    }
    if (worst <= SEPARATION_TOL) break;
  }
  for (let i = 0; i < n; i++) {
    if (!moved[i]) continue;
    bodies[i].sx = bodies[0].sx;
    bodies[i].sy = bodies[0].sy;
  }
  const bx = bodies[0].x;
  const by = bodies[0].y;
  for (let i = 0; i < n; i++) {
    if (!moved[i]) continue;
    bodies[i].x = bx + Q[i].dx;
    bodies[i].y = by + Q[i].dy;
  }
  return moved;
}

/**
 * Colisão nave × asteroides: pura, sem estado escondido nem relógio — o
 * servidor (autoritativo) e a predição do cliente rodam o MESMO código sobre
 * as mesmas entradas. Trata cada asteroide como círculo de raio `a.radius` (a
 * silhueta batata está inscrita nele). Resolve o impacto por impulso: a rocha
 * nua é a superfície mais elástica do jogo, então bater nela QUICA.
 *
 * `passthrough`: ids de asteroides SEM colisão (os que hospedam estruturas) —
 * a nave os atravessa para alcançar a estrutura no interior.
 *
 * `from`: onde a nave ESTAVA no começo do sub-passo. Com ele, o trecho
 * percorrido é varrido contra TODAS as rochas da vizinhança (`sweepRocks`),
 * choque a choque na ordem do tempo. Sem ele — e, com ele, para o que sobrar —
 * vale o teste de ponto: tira a nave de dentro da rocha pela normal do ponto
 * final. É o certo para as passadas de acomodação (depois da fronteira,
 * depois dos pares), onde a nave não percorreu trajetória nenhuma: foi
 * teleportada.
 *
 * Devolve `true` quando MEXEU na nave (posição ou velocidade).
 */
export function collideShip(
  ship: Body,
  seed: number,
  passthrough?: ReadonlySet<string>,
  from?: Readonly<WorldPos>,
): boolean {
  // tudo relativo à posição final com que a nave chegou: rochas e trecho
  const base: WorldPos = { sx: ship.sx, sy: ship.sy, x: ship.x, y: ship.y };
  const n = gatherRocks(seed, base, passthrough);
  const rk = rockBuf;
  let moved = from ? sweepRocks(ship, n, base, from) : false;

  // teste de ponto: contato sustentado (começou dentro) e acomodação. A posição
  // da nave relativa à base só muda quando um empurrão a mexe — é recalculada
  // ali, com a mesma conta de relVec, em vez de a cada rocha
  let px = (ship.sx - base.sx) * SECTOR_SIZE + (ship.x - base.x);
  let py = (ship.sy - base.sy) * SECTOR_SIZE + (ship.y - base.y);
  for (let i = 0; i < n; i++) {
    const kr = rk[3 * i + 2];
    const dx = px - rk[3 * i];
    const dy = py - rk[3 * i + 1];
    // descarte barato de quem está CLARAMENTE fora (Math.hypot é cara e quase
    // toda rocha da vizinhança está longe); a folga relativa de 1e-9 fica muito
    // acima do erro de arredondamento das duas contas, então só passa adiante
    // quem o teste exato abaixo decidiria — o resultado não muda
    if (dx * dx + dy * dy > kr * kr * (1 + 1e-9)) continue;
    const d = Math.hypot(dx, dy);
    if (d >= kr) continue;
    // normal de saída; se a nave estiver exatamente no centro, empurra em +x
    let nx = 1;
    let ny = 0;
    let dd = 0;
    if (d > 1e-6) {
      nx = dx / d;
      ny = dy / d;
      dd = d;
    }
    const penetration = kr - dd;
    ship.x += nx * penetration;
    ship.y += ny * penetration;
    resolveImpact(ship, nx, ny, ASTEROID_SURFACE_RESTITUTION, ASTEROID_SURFACE_FRICTION);
    moved = true;
    px = (ship.sx - base.sx) * SECTOR_SIZE + (ship.x - base.x);
    py = (ship.sy - base.sy) * SECTOR_SIZE + (ship.y - base.y);
  }
  normalizePos(ship);
  return moved;
}

/**
 * Rochas da vizinhança de `collideShip`, infladas pelo raio do casco, com o
 * centro relativo à base: trincas (cx, cy, r) num buffer REAPROVEITADO. A
 * colisão com rocha roda várias vezes por nave por sub-passo (voo, e de novo
 * para quem o par de cascos mexeu), e montar um objeto por rocha — ~130 nos 9
 * setores do cinturão — a cada chamada era o custo dominante do tick com naves
 * amontoadas na superfície. Só `collideShip` escreve nele, e o consome antes
 * de devolver; nada o guarda entre chamadas.
 */
let rockBuf = new Float64Array(3 * 256);

/** Vizinhança 3×3 da última chamada: com as naves agrupadas, quase sempre a mesma. */
let nearSeed = NaN;
let nearSx = NaN;
let nearSy = NaN;
const nearSectors: Asteroid[][] = [];

/** Preenche `rockBuf` com as rochas sólidas em volta de `base`; devolve quantas. */
function gatherRocks(seed: number, base: Readonly<WorldPos>, passthrough?: ReadonlySet<string>): number {
  if (seed !== nearSeed || base.sx !== nearSx || base.sy !== nearSy) {
    nearSectors.length = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) nearSectors.push(sectorAsteroids(seed, base.sx + ox, base.sy + oy));
    }
    nearSeed = seed;
    nearSx = base.sx;
    nearSy = base.sy;
  }
  // conjunto vazio (o caso comum: ninguém com estação por perto) nem é consultado
  const skip = passthrough && passthrough.size > 0 ? passthrough : null;
  let n = 0;
  for (const sector of nearSectors) {
    for (const a of sector) {
      if (skip && skip.has(a.id)) continue;
      if (3 * (n + 1) > rockBuf.length) {
        const grown = new Float64Array(rockBuf.length * 2);
        grown.set(rockBuf);
        rockBuf = grown;
      }
      // a mesma conta de relVec(base, a), na mesma ordem: bit a bit igual
      rockBuf[3 * n] = (a.sx - base.sx) * SECTOR_SIZE + (a.x - base.x);
      rockBuf[3 * n + 1] = (a.sy - base.sy) * SECTOR_SIZE + (a.y - base.y);
      rockBuf[3 * n + 2] = a.radius + SHIP_RADIUS;
      n++;
    }
  }
  return n;
}

/**
 * VARREDURA do trecho percorrido no sub-passo contra TODAS as rochas próximas:
 * acha a entrada de MENOR t entre elas, resolve o choque lá (normal da
 * superfície tocada), e recomeça do ponto de contato com a velocidade nova e o
 * tempo que sobrou — até 4 choques por sub-passo.
 *
 * Por que não basta o ponto final. A margem de tunelamento que flight.ts
 * anuncia é a do choque FRONTAL. O raspão é outro alvo: entrando `p` na rocha
 * mínima (raio efetivo ≈220 u), a corda mede 2·√(2·220·p) — 42 u com p = 1 u —,
 * e o passo de 50 u de uma nave a 6000 u/s pula a corda inteira. Pior que
 * sumir, o teste de ponto SORTEIA: detectar ou não depende da fase do sub-passo
 * em relação à rocha. E o "ponto de maior aproximação" (uma versão anterior)
 * não serve: lá a velocidade é perpendicular à normal, vn = 0, e o impulso sai
 * nulo — 10 de 24 fases registradas a 6000 u/s.
 *
 * Por que a MENOR entrada, e por que recomeçar. A versão anterior resolvia a
 * primeira rocha na ordem de iteração, não a primeira no tempo, e não
 * reconferia o trecho que sobrava: em corredores estreitos a 6000 u/s (medido
 * pelo crítico), 87 de 1340 passagens terminavam o sub-passo dentro de outra
 * rocha (até 20,3 u) e 188 divergiam da referência fina em até 4292 u/s.
 *
 * Rocha em que a nave COMEÇOU dentro (contato sustentado) fica de fora: não há
 * entrada, e quem resolve é o teste de ponto. A rocha que acabou de ser tocada
 * também, na volta seguinte: saindo dela por um disco convexo, não se reentra
 * numa reta.
 */
function sweepRocks(ship: Body, n: number, base: WorldPos, from: Readonly<WorldPos>): boolean {
  const rk = rockBuf;
  const f0 = relVec(base, from);
  let p0x = f0.dx;
  let p0y = f0.dy;
  let p1x = 0;
  let p1y = 0;
  // duração do trecho: o integrador faz e = v·h com a velocidade atual
  const v2 = ship.vx * ship.vx + ship.vy * ship.vy;
  let h = v2 > 1e-12 ? (-p0x * ship.vx - p0y * ship.vy) / v2 : 0;
  if (!(h > 0)) return false;
  let last = -1;
  let hit = false;
  for (let iter = 0; iter < 4; iter++) {
    const ex = p1x - p0x;
    const ey = p1y - p0y;
    const A = ex * ex + ey * ey;
    if (A <= 1e-12) break;
    let best = Infinity;
    let bi = -1;
    for (let i = 0; i < n; i++) {
      if (i === last) continue;
      const kr = rk[3 * i + 2];
      const ox = p0x - rk[3 * i];
      const oy = p0y - rk[3 * i + 1];
      const c = ox * ox + oy * oy - kr * kr;
      if (c <= 0) continue; // começou dentro: é do teste de ponto
      const B = ox * ex + oy * ey;
      if (B >= 0) continue; // afastando-se do centro
      const disc = B * B - A * c;
      if (disc < 0) continue;
      const t = (-B - Math.sqrt(disc)) / A;
      if (t <= 1 && t < best) {
        best = t;
        bi = i;
      }
    }
    if (bi < 0) break;
    const kx = rk[3 * bi];
    const ky = rk[3 * bi + 1];
    const kr = rk[3 * bi + 2];
    const qx = p0x + best * ex;
    const qy = p0y + best * ey;
    resolveImpact(ship, (qx - kx) / kr, (qy - ky) / kr, ASTEROID_SURFACE_RESTITUTION, ASTEROID_SURFACE_FRICTION);
    h *= 1 - best;
    p0x = qx;
    p0y = qy;
    p1x = qx + ship.vx * h;
    p1y = qy + ship.vy * h;
    last = bi;
    hit = true;
  }
  if (hit) {
    ship.sx = base.sx;
    ship.sy = base.sy;
    ship.x = base.x + p1x;
    ship.y = base.y + p1y;
  }
  return hit;
}

/**
 * Colisão com Ceres (ou qualquer corpo circular grande): mantém a nave FORA
 * do raio dado. O planeta anão é imóvel (massa infinita na prática) e coberto
 * de regolito, então absorve boa parte do impacto — quica bem menos que a
 * rocha nua. Pura, sem estado escondido — servidor e predição rodam igual.
 * Devolve `true` quando mexeu na nave.
 */
export function collideCeres(ship: Body, center: WorldPos, radiusUnits: number): boolean {
  const { dx, dy } = relVec(center, ship); // do centro de Ceres até a nave
  const d = Math.hypot(dx, dy);
  const minDist = radiusUnits + SHIP_RADIUS;
  if (d >= minDist) return false;

  // normal de saída; se estiver exatamente no centro, empurra em +x
  let nx = 1;
  let ny = 0;
  let dd = 0;
  if (d > 1e-6) {
    nx = dx / d;
    ny = dy / d;
    dd = d;
  }
  const pen = minDist - dd;
  ship.x += nx * pen;
  ship.y += ny * pen;

  resolveImpact(ship, nx, ny, CERES_SURFACE_RESTITUTION, CERES_SURFACE_FRICTION);
  normalizePos(ship);
  return true;
}

/**
 * Fronteira do mapa: mantém a nave dentro de um raio a partir do centro da
 * arena. É um campo de contenção, não uma parede de rocha — devolve pouco,
 * só o suficiente para a nave não sair, e não agarra NADA na tangente
 * (BOUNDARY_SURFACE_FRICTION = 0 — campo não tem superfície para raspar; ver
 * lá o que o atrito na borda estava custando ao jogador). Pura, sem estado
 * escondido — servidor e predição rodam igual.
 *
 * Devolve `true` quando MOVEU a nave. Quem chama precisa disso: com raio de
 * 500 000 u a fronteira corta o cinturão, e empurrar para dentro pode enfiar a
 * nave numa rocha que já tinha sido resolvida neste sub-passo (ver
 * `flightSubstep`, que por isso reprocessa os sólidos depois).
 */
export function clampToBoundary(ship: Body, center: WorldPos, radiusUnits: number): boolean {
  const { dx, dy } = relVec(center, ship);
  const d = Math.hypot(dx, dy);
  if (d <= radiusUnits || d === 0) return false;

  const nx = dx / d;
  const ny = dy / d;
  const pen = d - radiusUnits;
  ship.x -= nx * pen;
  ship.y -= ny * pen;

  // a normal de saída do campo aponta para DENTRO da arena (-n)
  resolveImpact(ship, -nx, -ny, BOUNDARY_SURFACE_RESTITUTION, BOUNDARY_SURFACE_FRICTION);
  normalizePos(ship);
  return true;
}

/** Folga (dist. à superfície do asteroide mais próximo) num ponto local do setor. */
function clearanceAt(seed: number, sx: number, sy: number, x: number, y: number): number {
  const point: WorldPos = { sx, sy, x, y };
  let minClear = Infinity;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      for (const a of sectorAsteroids(seed, sx + ox, sy + oy)) {
        const { dx, dy } = relVec(a, point);
        const clear = Math.hypot(dx, dy) - a.radius - SHIP_RADIUS;
        if (clear < minClear) minClear = clear;
      }
    }
  }
  return minClear;
}

/**
 * Acha uma posição local livre de asteroides no setor para spawn. Varre uma
 * grade de candidatos e devolve o primeiro com folga confortável; se o setor
 * estiver cheio, devolve o de maior folga (melhor esforço).
 */
export function findClearSpawn(seed: number, sx: number, sy: number): { x: number; y: number } {
  const PREFERRED = SHIP_RADIUS * 3;
  const N = 8;
  let best = { x: SECTOR_SIZE / 2, y: SECTOR_SIZE / 2 };
  let bestClear = -Infinity;
  for (let iy = 0; iy < N; iy++) {
    for (let ix = 0; ix < N; ix++) {
      const x = ((ix + 0.5) / N) * SECTOR_SIZE;
      const y = ((iy + 0.5) / N) * SECTOR_SIZE;
      const clear = clearanceAt(seed, sx, sy, x, y);
      if (clear > bestClear) {
        bestClear = clear;
        best = { x, y };
      }
      if (clear >= PREFERRED) return { x, y };
    }
  }
  return best;
}
