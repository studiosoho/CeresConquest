import {
  MINING_RANGE,
  MINING_RATE_BY_KIND,
  NEUTRAL_INPUT,
  STRUCTURE_SPECS,
  TAXI_SPEED_MULT,
  PHYSICS_SUBSTEP,
  BASE_RATION_INCOME,
  RATION_STORE_CAP,
  ceresPosition,
  normalizePos,
  relVec,
  type ShipInput,
  type WorldPos,
} from "@ceres/shared";
import { makeShip, freezeShip, drainSubsteps, admitTime, type ShipState } from "./ship";
import { sectorAsteroids, type Asteroid } from "./procgen";
import { flightSubstep, resolveHullContacts, type FlightEnv } from "./flight";
import type { Structure } from "./structures";

/**
 * Mundo de simulação: puro, sem rede, sem engine, sem I/O.
 * O servidor roda a instância autoritativa; o cliente pode rodar uma
 * instância local para predição.
 *
 * Sobre "determinismo", com precisão: não há relógio nem sorteio no caminho
 * quente, então a mesma sequência de entradas dá a mesma saída — e o cliente
 * usa exatamente o mesmo `flightSubstep` do servidor, com o mesmo h. O que NÃO
 * se promete é igualdade bit a bit entre motores JS diferentes: exp, cos, sin,
 * atan2 e hypot são "implementation-approximated" na ECMA-262. A arquitetura
 * não depende disso — a reconciliação é blend exponencial contra o estado
 * autoritativo (ver GameScene.blendTowards), não rollback+replay, que é o
 * esquema que exigiria bit-exatidão.
 */
export class SimWorld {
  readonly seed: number;
  readonly ships = new Map<string, ShipState>();
  readonly structures = new Map<string, Structure>();
  /** minério por jogador (sessionId → quantidade) */
  readonly playerOre = new Map<string, number>();
  /** posição de Ceres — derivada da semente (igual em servidor e cliente) */
  readonly ceres: WorldPos;
  private readonly inputs = new Map<string, ShipInput>();
  private boundaryCenter: WorldPos | null = null;
  private boundaryRadius = 0;
  /**
   * Resíduo do acumulador de passo fixo do MUNDO (s). É do mundo, e não de cada
   * nave, porque os contatos nave × nave exigem que todas avancem em TRAVA: se
   * cada casco drenasse o próprio acumulador, duas naves poderiam rodar números
   * diferentes de sub-passos no mesmo tick e os pares seriam resolvidos em
   * instantes distintos.
   */
  private stepAccum = 0;

  constructor(seed: number) {
    this.seed = seed;
    this.ceres = ceresPosition(seed);
  }

  getOre(owner: string): number {
    return this.playerOre.get(owner) ?? 0;
  }

  addOre(owner: string, amount: number): void {
    if (!owner) return;
    this.playerOre.set(owner, this.getOre(owner) + amount);
  }

  /** Gasta minério se houver saldo; devolve true se debitou. */
  spendOre(owner: string, amount: number): boolean {
    if (this.getOre(owner) < amount) return false;
    this.playerOre.set(owner, this.getOre(owner) - amount);
    return true;
  }

  /** Define a fronteira circular do mapa (centro + raio em unidades). */
  setBoundary(center: WorldPos, radiusUnits: number): void {
    this.boundaryCenter = { ...center };
    this.boundaryRadius = radiusUnits;
  }

  addShip(id: string, pos: WorldPos, owner = "", kind: ShipState["kind"] = "builder"): ShipState {
    const ship = makeShip(pos, owner, kind);
    this.ships.set(id, ship);
    return ship;
  }

  removeShip(id: string): void {
    this.ships.delete(id);
    this.inputs.delete(id);
  }

  addStructure(st: Structure): void {
    this.structures.set(st.id, st);
  }

  setInput(id: string, input: ShipInput): void {
    this.inputs.set(id, input);
  }

  /** Asteroides ocupados por estruturas — atravessáveis (sem colisão). */
  occupiedAsteroids(): Set<string> {
    const set = new Set<string>();
    for (const st of this.structures.values()) {
      if (st.asteroidId) set.add(st.asteroidId);
    }
    return set;
  }

  /**
   * Avança o mundo. O tempo entra por `admitTime` AQUI DENTRO: um tick engasgado
   * (GC, IO, instância dormindo no PaaS) não pode injetar segundos de mundo de
   * uma vez só. Antes o teto vivia apenas no MatchRoom, do lado do servidor, e no
   * render loop, do lado do cliente — duas disciplinas de quem chama, uma delas
   * ausente por meses.
   *
   * O `dt` que a ECONOMIA usa é o tempo que a física REALMENTE gastou
   * (steps × PHYSICS_SUBSTEP), e não o `rawDt` limitado. É a mesma grandeza para
   * os dois por construção, então mineração e produção não podem mais andar num
   * ritmo e o mundo em outro — nem quando o acumulador guarda um pedaço de
   * quadro para a chamada seguinte.
   */
  tick(rawDt: number): void {
    this.stepAccum = admitTime(this.stepAccum, rawDt);
    const { steps, rest } = drainSubsteps(this.stepAccum);
    this.stepAccum = rest;
    // tempo de simulação efetivamente gasto neste tick — o relógio de TUDO
    const dt = steps * PHYSICS_SUBSTEP;
    const passthrough = this.occupiedAsteroids();
    // naves em voo livre neste tick: só elas entram no laço de física e nos
    // contatos nave × nave (as congeladas/guardadas ficam fora do mundo)
    const flying: Array<{ id: string; ship: ShipState; input: ShipInput; mult: number }> = [];

    for (const [id, ship] of this.ships) {
      // guardada no hangar: fora do mundo, não simula
      if (ship.stored) {
        ship.mining = false;
        continue;
      }
      // pouso em asteroide: a sala controla posição/fases — SEM física nem
      // colisão (senão a colisão empurraria a nave para fora do asteroide).
      // Pousada ("landed") com anchored=true = mineração automática ligada.
      if (ship.landingPhase !== "") {
        freezeShip(ship); // zera também a velocidade ANGULAR e o spool
        ship.mining = false;
        if (ship.landingPhase === "landed" && ship.anchored) {
          const rate = MINING_RATE_BY_KIND[ship.kind];
          if (rate > 0) {
            this.addOre(ship.owner, rate * dt);
            ship.mining = true;
          }
        }
        continue;
      }
      // ancorada: congelada na estrutura (não se move). Builder ancorado
      // numa estação pode minerar via toggle (setado pela sala ANTES deste
      // tick) — preserva ship.mining nesse caso; nas demais (QG, outras
      // classes), permanece congelada e sem minerar.
      if (ship.anchored) {
        freezeShip(ship); // atracada: nem deriva nem giro residual
        const station = this.structures.get(ship.hqId);
        const canMineHere = ship.kind === "builder" && station?.type === "miningStation";
        if (!canMineHere) ship.mining = false;
        continue;
      }
      // aranha (auto-mineração): movida pela lógica da estação, fora da física
      if (ship.autoMining) continue;
      // em taxiamento: dobro da velocidade e sem colisão (caminho reto)
      flying.push({
        id,
        ship,
        input: this.inputs.get(id) ?? NEUTRAL_INPUT,
        mult: ship.taxiTo ? TAXI_SPEED_MULT : 1,
      });
      // sem mineração em voo livre — só pousado em asteroide vazio (landed)
      // ou ancorado numa estação (toggle); ver os branches acima
      ship.mining = false;
    }

    // ── Física: todas as naves avançam em TRAVA no mesmo sub-passo ─────
    // Integrar uma nave o dt inteiro antes de olhar para a próxima faria os
    // contatos nave × nave acontecerem em instantes diferentes. Em trava, cada
    // sub-passo é: mover todo mundo (com os contatos estáticos do mundo) e só
    // então resolver os pares.
    //
    // A trava sozinha NÃO tirava a dependência de ordem (este comentário já
    // disse que tirava): com os pares resolvidos em sequência, o caça parado
    // entre dois cargueiros simétricos a ±3000 u/s saía a −3364,9 ou +3364,9
    // conforme a ordem no Map, e depois conforme a ordem dos ids. Quem tira é
    // o solver de `resolveHullContacts`: contatos simultâneos resolvidos juntos
    // por iteração até convergir, numa solução única. A ordenação por id fica
    // só para o que sobra de sequência (a ordem das passadas de rocha), e para
    // qualquer instância que simule o mesmo estado andar igual.
    flying.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
    if (steps > 0 && flying.length > 0) {
      const env: FlightEnv = {
        seed: this.seed,
        passthrough,
        ceres: this.ceres, // planeta anão: sólido
        boundaryCenter: this.boundaryCenter,
        boundaryRadius: this.boundaryRadius,
      };
      // Táxi: corredor de trânsito. Sem `seed` = sem colisão com asteroide
      // (caminho reto, como sempre foi) e fora dos contatos nave × nave — só a
      // fronteira da arena continua valendo. É de propósito: uma nave em
      // taxiamento a 2× de velocidade acertando o jogador o arremessaria para
      // fora do mapa por uma decisão que não foi dele.
      const taxiEnv: FlightEnv = {
        boundaryCenter: this.boundaryCenter,
        boundaryRadius: this.boundaryRadius,
      };
      const contacts = flying.filter((f) => f.mult === 1).map((f) => f.ship);
      const from: WorldPos[] = contacts.map((c) => ({ sx: c.sx, sy: c.sy, x: c.x, y: c.y }));
      const h = PHYSICS_SUBSTEP;
      // passo FIXO com resíduo carregado entre ticks: h é sempre
      // PHYSICS_SUBSTEP, igualzinho ao do cliente, em qualquer taxa de tick
      for (let step = 0; step < steps; step++) {
        for (let i = 0; i < contacts.length; i++) {
          const c = contacts[i];
          from[i] = { sx: c.sx, sy: c.sy, x: c.x, y: c.y };
        }
        for (const f of flying) {
          flightSubstep(f.ship, f.input, h, f.mult, f.mult > 1 ? taxiEnv : env);
        }
        // cascos: varredura por eventos + solver iterativo, e os sólidos com a
        // última palavra — o MESMO caminho da predição (ver resolveHullContacts)
        if (contacts.length > 1) resolveHullContacts(contacts, from, h, env);
      }
      for (const f of flying) normalizePos(f.ship);
    }

    // estruturas autônomas produzem minério para o dono
    for (const st of this.structures.values()) {
      const rate = STRUCTURE_SPECS[st.type].productionRate;
      if (rate > 0) this.addOre(st.owner, rate * dt);
      // base inicial recebe rações da Terra continuamente
      if (st.type === "initialBase") {
        st.rationStore = Math.min(RATION_STORE_CAP, st.rationStore + BASE_RATION_INCOME * dt);
      }
    }
  }

  /** Asteroide minerável mais próximo da nave (borda dentro de maxRange). */
  nearestAsteroid(pos: WorldPos, maxRange: number = MINING_RANGE): Asteroid | null {
    let best: Asteroid | null = null;
    let bestDist = maxRange;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        for (const a of sectorAsteroids(this.seed, pos.sx + ox, pos.sy + oy)) {
          const { dx, dy } = relVec(pos, a);
          const edgeDist = Math.hypot(dx, dy) - a.radius;
          if (edgeDist < bestDist) {
            best = a;
            bestDist = edgeDist;
          }
        }
      }
    }
    return best;
  }
}
