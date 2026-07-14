import { Room, type Client } from "colyseus";
import {
  MSG_INPUT,
  MSG_BUILD,
  MSG_PRODUCE,
  MSG_ANCHOR,
  MSG_SWAP,
  MSG_AUTOMINE,
  MSG_TAXI,
  MSG_LAND_ACTION,
  MSG_EXPAND,
  MSG_CARGO,
  MSG_FIRE,
  TICK_RATE,
  SECTOR_SIZE,
  STRUCTURE_SPECS,
  SHIP_PRODUCTION,
  HQ_SHIP_BAYS,
  HQ_EXPANDED_BAYS,
  STATION_SHIP_BAYS,
  STATION_EXPANDED_BAYS,
  STATION_SPIDER_BAYS,
  BASE_SHIP_BAYS,
  BASE_EXPANDED_BAYS,
  STATION_ORE_STORE,
  RATION_STORE_CAP,
  RATION_DRONE_RANGE,
  RATION_DRONE_AMOUNT,
  RATION_DRONE_INTERVAL,
  RATION_CENTER_SHIP_BAYS,
  RATION_CENTER_EXPANDED_BAYS,
  TRANSPORT_CARGO_CAP,
  DOCK_RANGE,
  BUILD_ASTEROID_RANGE,
  MINING_RATE_BY_KIND,
  BULLET_SPEED,
  BULLET_RANGE,
  BULLET_RADIUS,
  BULLET_DAMAGE,
  BULLET_COOLDOWN,
  GRENADE_SPEED,
  GRENADE_PROX_RADIUS,
  GRENADE_BLAST_RADIUS,
  GRENADE_DAMAGE,
  GRENADE_COOLDOWN,
  asteroidClassOf,
  asteroidSpinRate,
  ceresPosition,
  relVec,
  dist,
  normalizePos,
  type ShipInput,
  type ShipKind,
  type BuildCommand,
  type ProduceCommand,
  type TaxiCommand,
  type LandActionCommand,
  type FireCommand,
} from "@ceres/shared";
import {
  SimWorld,
  findClearSpawn,
  sectorAsteroids,
  type ShipState,
  type Structure,
} from "@ceres/sim-core";
import { MatchState, ShipSchema, StructureSchema, PlayerSchema, ProjectileSchema } from "../schema/State";
import { mapSpawns, type SpawnStrategy } from "../spawn";
import { computeBotInput, computeTaxiInput, makeBotState, type BotState } from "../bots";
import { makeSpiderState, stepSpider, type SpiderState } from "../spiders";

/** Nº de jogadores-teste autônomos (bots) por padrão. */
const DEFAULT_BOTS = 30;

export interface MatchOptions {
  maxPlayers?: number;
  worldSeed?: number;
  spawnStrategy?: SpawnStrategy;
  mapSize?: string;
  bots?: number;
}

/**
 * Sala do modo partida (início/fim). O SimWorld é a autoridade; o schema
 * Colyseus é só o espelho sincronizado para os clientes.
 */
export class MatchRoom extends Room<MatchState> {
  private sim!: SimWorld;
  private spawns: ReturnType<typeof mapSpawns> = [];
  private spawnIndex = 0;
  private bots = new Map<string, BotState>();
  private structSeq = 0;
  private shipSeq = 0;
  /** nave que cada jogador pilota (sessionId → shipId) */
  private activeShip = new Map<string, string>();
  /** estado das aranhas mineradoras (shipId → SpiderState) */
  private spiders = new Map<string, SpiderState>();
  /** centro da arena (para expandir a fronteira) */
  private arenaCenter = { sx: 0, sy: 0, x: 0, y: 0 };
  /** tempo total acumulado (s) — usado para calcular ângulo atual dos asteroides */
  private elapsed = 0;
  /** projéteis ativos (id → estado) */
  private projSeq = 0;
  private projectiles = new Map<string, {
    kind: "bullet" | "grenade";
    owner: string;
    sx: number; sy: number; x: number; y: number;
    vx: number; vy: number;
    traveled: number;
  }>();
  /** timer por centro de distribuição (structId → segundos até próximo drone) */
  private rationDroneTimers = new Map<string, number>();

  onCreate(options: MatchOptions = {}) {
    this.maxClients = options.maxPlayers ?? 12;
    const botCount = options.bots ?? DEFAULT_BOTS;
    const radiusSectors = options.mapSize === "large" ? 50
      : options.mapSize === "medium" ? 20 : 8;
    const seed = options.worldSeed ?? (Math.random() * 0xffffffff) >>> 0;

    this.sim = new SimWorld(seed);
    // spawns em setores distintos do cinturão dentro da arena do mapa
    this.spawns = mapSpawns(seed, radiusSectors, this.maxClients + botCount);

    // fronteira circular: centrada em Ceres, raio pelo tamanho do mapa
    const base = ceresPosition(seed);
    const center = { sx: base.sx, sy: base.sy, x: SECTOR_SIZE / 2, y: SECTOR_SIZE / 2 };
    const radiusUnits = radiusSectors * SECTOR_SIZE;
    this.arenaCenter = center;
    this.sim.setBoundary(center, radiusUnits);

    this.setState(new MatchState());
    this.state.worldSeed = seed;
    this.state.mapCenterSx = base.sx;
    this.state.mapCenterSy = base.sy;
    this.state.mapRadius = radiusUnits;

    // popula a partida com jogadores-teste autônomos (attack neutros)
    for (let i = 0; i < botCount; i++) {
      const id = `bot-${i}`;
      const ship = this.spawnShip(id, this.spawns[this.maxClients + i], "", "attack");
      this.state.ships.set(id, this.mirrorSpawn(ship));
      this.bots.set(id, makeBotState());
    }

    this.onMessage(MSG_INPUT, (client: Client, input: ShipInput) => {
      const active = this.activeShip.get(client.sessionId);
      if (active) this.sim.setInput(active, input);
    });

    this.onMessage(MSG_BUILD, (client: Client, cmd: BuildCommand) => {
      this.tryBuild(client.sessionId, cmd?.type);
    });

    this.onMessage(MSG_PRODUCE, (client: Client, cmd: ProduceCommand) => {
      this.tryProduce(client.sessionId, cmd?.kind);
    });

    this.onMessage(MSG_ANCHOR, (client: Client) => {
      this.tryToggleAnchor(client.sessionId);
    });

    this.onMessage(MSG_SWAP, (client: Client) => {
      this.trySwap(client.sessionId);
    });

    this.onMessage(MSG_AUTOMINE, (client: Client) => {
      this.tryAutoMine(client.sessionId);
    });

    this.onMessage(MSG_TAXI, (client: Client, cmd: TaxiCommand) => {
      this.tryTaxi(client.sessionId, cmd?.shipId);
    });

    this.onMessage(MSG_LAND_ACTION, (client: Client, cmd: LandActionCommand) => {
      this.tryLandAction(client.sessionId, cmd?.action);
    });

    this.onMessage(MSG_EXPAND, () => this.expandMap());

    this.onMessage(MSG_CARGO, (client: Client) => {
      this.tryCargo(client.sessionId);
    });

    this.onMessage(MSG_FIRE, (client: Client, cmd: FireCommand) => {
      this.tryFire(client.sessionId, cmd?.kind);
    });

    this.setSimulationInterval((deltaMs) => this.tick(deltaMs / 1000), 1000 / TICK_RATE);
    console.log(
      `[room] match criada — seed=${seed} raio=${radiusSectors}s ` +
      `maxPlayers=${this.maxClients} bots=${botCount}`,
    );
  }

  onJoin(client: Client) {
    const base = this.spawns[this.spawnIndex++ % this.spawns.length];
    const id = `p${this.shipSeq++}`;
    const ship = this.spawnShip(id, base, client.sessionId, "builder"); // default: builder
    this.activeShip.set(client.sessionId, id);
    // espelha a posição de spawn JÁ no join — o primeiro estado que o
    // cliente recebe precisa ser real, não os defaults do schema
    this.state.ships.set(id, this.mirrorSpawn(ship));
    const p = new PlayerSchema();
    p.activeShip = id;
    this.state.players.set(client.sessionId, p);
    this.sim.playerOre.set(client.sessionId, 0);
    // o jogador RECEBE a Base Inicial no asteroide livre mais próximo do spawn
    this.grantInitialBase(client.sessionId, ship);
    console.log(`[room] ${client.sessionId} entrou — nave ${id} setor (${ship.sx}, ${ship.sy})`);
  }

  /**
   * Concede a Base Inicial do jogador no asteroide livre mais próximo do
   * ponto de spawn. Ela liga o jogador à Terra: recebe rações (fluxo
   * contínuo) e recebe minério dos transportes (creditando a carteira).
   */
  private grantInitialBase(sessionId: string, spawn: { sx: number; sy: number; x: number; y: number }): void {
    const occupied = new Set(
      [...this.sim.structures.values()].map((s) => s.asteroidId),
    );
    let best: ReturnType<typeof this.sim.nearestAsteroid> = null;
    let bd = Infinity;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        for (const a of sectorAsteroids(this.sim.seed, spawn.sx + ox, spawn.sy + oy)) {
          if (occupied.has(a.id)) continue;
          const { dx, dy } = relVec(spawn, a);
          const d = Math.hypot(dx, dy) - a.radius;
          if (d < bd) {
            bd = d;
            best = a;
          }
        }
      }
    }
    if (!best) {
      console.log(`[room] ${sessionId} sem asteroide livre por perto — base inicial não concedida`);
      return;
    }

    const { dx, dy } = relVec(best, spawn);
    const angle = Math.atan2(dy, dx);
    const cls = asteroidClassOf(best.radius);
    const id = `st-${this.structSeq++}`;
    this.sim.addStructure({
      id, type: "initialBase", owner: sessionId,
      sx: best.sx, sy: best.sy, x: best.x, y: best.y,
      angle, asteroidId: best.id, asteroidClass: cls,
      shipBays: BASE_SHIP_BAYS, expandedBays: BASE_EXPANDED_BAYS,
      spiderBays: 0, nextShipBay: 0, nextSpiderBay: 0,
      oreStore: 0, rationStore: 0,
    });
    const ss = new StructureSchema();
    ss.stype = "initialBase"; ss.owner = sessionId;
    ss.sx = best.sx; ss.sy = best.sy; ss.x = best.x; ss.y = best.y;
    ss.angle = angle; ss.asteroidId = best.id; ss.asteroidClass = cls;
    ss.shipBays = BASE_SHIP_BAYS; ss.expandedBays = BASE_EXPANDED_BAYS;
    ss.spiderBays = 0; ss.nextShipBay = 0; ss.nextSpiderBay = 0;
    this.state.structures.set(id, ss);
    console.log(`[room] base inicial de ${sessionId} concedida em ${best.id} (${cls})`);
  }

  onLeave(client: Client) {
    // remove a frota inteira do jogador (nave ativa + hangar + produzidas)
    for (const [id, ship] of [...this.sim.ships]) {
      if (ship.owner === client.sessionId) {
        this.sim.removeShip(id);
        this.bots.delete(id);
        this.state.ships.delete(id);
      }
    }
    this.activeShip.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
    this.sim.playerOre.delete(client.sessionId);
    console.log(`[room] ${client.sessionId} saiu`);
  }

  private activeShipOf(sessionId: string): ShipState | undefined {
    const id = this.activeShip.get(sessionId);
    return id ? this.sim.ships.get(id) : undefined;
  }

  /** Cria uma nave no sim num ponto livre dentro do setor de spawn dado. */
  private spawnShip(
    id: string,
    base: { sx: number; sy: number },
    owner = "",
    kind: ShipState["kind"] = "builder",
  ): ShipState {
    const local = findClearSpawn(this.sim.seed, base.sx, base.sy);
    return this.sim.addShip(id, { sx: base.sx, sy: base.sy, x: local.x, y: local.y }, owner, kind);
  }

  /**
   * Alterna a ancoragem da nave ativa. Ancorar = ocupar a PRIMEIRA vaga
   * livre do hangar de naves da estrutura; sem vaga, não ancora.
   */
  /** Velocidade angular de um asteroide pela shapeSeed (rad/s) — fonte única no shared. */
  private asteroidSpinOf(shapeSeed: number): number {
    return asteroidSpinRate(shapeSeed);
  }

  /**
   * Posição mundial da vaga `bay` de uma estrutura.
   * Usa a mesma geometria do drawStructInto no cliente:
   * vagas expandidas (0..expandedBays-1) são mais largas, normais são quadradas.
   * O offset local é rotacionado pelo ângulo da estrutura.
   */
  private tryToggleAnchor(sessionId: string): void {
    const ship = this.activeShipOf(sessionId);
    if (!ship) return;

    // cancela pouso/decolagem em andamento com [F]
    if (ship.landingPhase === "landing" || ship.landingPhase === "liftoff") return;

    // pousado num asteroide: [F] decola imediatamente
    if (ship.landingPhase === "landed") {
      if (ship.anchored) return; // minerando: pare antes ([SPACE])
      ship.landingPhase = "";
      ship.anchored = false;
      ship.anchoredAsteroidId = "";
      ship.bay = -1;
      return;
    }

    // desancora de estrutura (QG/estação)
    if (ship.anchored) {
      ship.anchored = false;
      ship.bay = -1;
      ship.anchoredAsteroidId = "";
      ship.landingProgress = 0;
      if (!ship.stored) ship.hqId = "";
      return;
    }

    // pouso no asteroide mais próximo dentro do DOCK_RANGE
    {
      const ast = this.sim.nearestAsteroid(ship, DOCK_RANGE);
      if (ast) {
        const ownStruct = [...this.sim.structures.values()].find(
          s => s.asteroidId === ast.id && s.owner === sessionId,
        );
        const anyStruct = !ownStruct && [...this.sim.structures.values()].some(s => s.asteroidId === ast.id);

        if (ownStruct) {
          // estrutura PRÓPRIA: QUALQUER classe anima até a VAGA DE POUSO —
          // o centro (0,0) da estrutura. Uma só por estrutura.
          if (this.padOccupied(ownStruct.id)) return;
          const spin = this.asteroidSpinOf(ast.shapeSeed);
          ship.landingPhase = "landing";
          ship.landingProgress = 0;
          ship.landingOriginX = ship.x;
          ship.landingOriginY = ship.y;
          ship.landingTargetX = ownStruct.x;
          ship.landingTargetY = ownStruct.y;
          ship.landingAsteroidSpin = spin;
          ship.anchoredAsteroidId = "";
          ship.hqId = ownStruct.id;
          ship.bay = -1; // vaga de pouso não consome vaga de hangar
          ship.vx = 0;
          ship.vy = 0;
          return;
        }

        // asteroide VAZIO: só builder e mining pousam (para minerar/construir)
        if (!anyStruct && (ship.kind === "builder" || ship.kind === "mining")) {
          // asteroide sem estrutura: anima até o centro
          const spin = this.asteroidSpinOf(ast.shapeSeed);
          ship.landingPhase = "landing";
          ship.landingProgress = 0;
          ship.landingOriginX = ship.x;
          ship.landingOriginY = ship.y;
          ship.landingTargetX = ast.x;
          ship.landingTargetY = ast.y;
          ship.landingAsteroidSpin = spin;
          ship.anchoredAsteroidId = ast.id;
          ship.hqId = "";
          ship.bay = -1;
          ship.vx = 0;
          ship.vy = 0;
          return;
        }
        // asteroide com estrutura ALHEIA: cai para busca de estrutura própria
      }
    }

    // pousa em estrutura própria (sem asteroide próximo): vaga de pouso
    const struct = this.nearestOwnStructure(sessionId, ship, DOCK_RANGE);
    if (!struct) return;
    if (this.padOccupied(struct.id)) return; // vaga de pouso ocupada
    ship.anchored = true;
    ship.hqId = struct.id;
    ship.anchoredAsteroidId = "";
    ship.landingPhase = "";
    ship.bay = -1; // vaga de pouso não consome vaga de hangar
    ship.sx = struct.sx;
    ship.sy = struct.sy;
    ship.x = struct.x;
    ship.y = struct.y;
    ship.vx = 0;
    ship.vy = 0;
    ship.mining = false; // zera resíduo de mineração em voo livre
  }

  /** A vaga de pouso (centro da estrutura) está ocupada? */
  private padOccupied(structId: string): boolean {
    for (const s of this.sim.ships.values()) {
      if (s.hqId === structId && s.anchored && !s.stored) return true;
    }
    return false;
  }

  /** Troca a nave ativa por uma do hangar da estrutura ancorada. */
  private trySwap(sessionId: string): void {
    const active = this.activeShipOf(sessionId);
    if (!active || !active.anchored) return;
    const struct = this.nearestOwnStructure(sessionId, active, DOCK_RANGE);
    if (!struct) return;

    // naves guardadas no hangar desta estrutura
    let pick: [string, ShipState] | null = null;
    for (const [id, s] of this.sim.ships) {
      if (s.owner === sessionId && s.hqId === struct.id && s.stored) {
        pick = [id, s];
        break;
      }
    }
    if (!pick) return; // hangar vazio

    // guarda a nave ativa neste hangar — ela herda a vaga que a nave
    // escolhida vai liberar (a escolhida sai para a vaga de pouso)
    const [nid, next] = pick;
    const freedBay = next.bay;
    active.stored = true;
    active.anchored = false;
    active.hqId = struct.id;
    active.bay = freedBay >= 0 ? freedBay : this.firstFreeShipBay(struct, active.kind);
    this.sim.setInput(this.activeShip.get(sessionId)!, { thrust: false, turn: 0, mine: false });

    // tira a nave escolhida do hangar → vaga de pouso (centro)
    this.deployFromHangar(next, struct);
    this.activeShip.set(sessionId, nid);
    console.log(`[room] ${sessionId} trocou de nave → ${next.kind} (${nid})`);
  }

  /**
   * Transforma a mineradora ancorada numa ARANHA mineradora da estação:
   * ela passa a caminhar pelo asteroide, minerando e descarregando sozinha.
   */
  private tryAutoMine(sessionId: string): void {
    const active = this.activeShipOf(sessionId);
    if (!active || active.kind !== "mining" || !active.anchored) return;
    const station = this.nearestOwnStructure(sessionId, active, DOCK_RANGE, "miningStation");
    if (!station) return;

    // vagas de aranha da estação (2/4/6 pela classe do asteroide)
    if (station.nextSpiderBay >= station.spiderBays) return;

    // raio do asteroide hospedeiro (para a aranha caminhar na superfície)
    let astRadius = 400;
    for (const a of sectorAsteroids(this.sim.seed, station.sx, station.sy)) {
      if (a.id === station.asteroidId) astRadius = a.radius;
    }

    // transfere o controle para outra nave ANTES de largar a mineradora
    const activeId = this.activeShip.get(sessionId)!;
    if (!this.transferControl(sessionId, activeId)) return; // não pode ficar sem nave

    active.autoMining = true;
    active.stationId = station.id;
    active.anchored = false;
    active.bay = -1; // libera a vaga de nave — a aranha usa vaga de aranha
    active.hqId = "";
    this.spiders.set(activeId, makeSpiderState(astRadius));
    station.nextSpiderBay += 1;
    console.log(`[room] ${sessionId} aranha mineradora ativa em ${station.id} (${station.nextSpiderBay}/${station.spiderBays})`);
  }

  /**
   * Ação do builder após pousar num asteroide vazio:
   * "mine" = inicia mineração automática, "build" = constrói estação, "liftoff" = decola.
   * "stationmine" = coleta o buffer da estação (builder ancorado na estação).
   */
  private tryLandAction(sessionId: string, action?: string): void {
    const ship = this.activeShipOf(sessionId);
    if (!ship) return;

    // coleta buffer da estação: builder ancorado (qualquer fase)
    if (action === "stationmine") {
      this.tryStationMine(sessionId);
      return;
    }

    if ((ship.kind !== "builder" && ship.kind !== "mining") || ship.landingPhase !== "landed") return;

    if (action === "liftoff") {
      if (ship.anchored) return;
      ship.landingPhase = "";
      ship.anchored = false;
      ship.anchoredAsteroidId = "";
      return;
    }

    if (action === "mine") {
      // liga/desliga a mineração automática; PERMANECE pousado ("landed")
      ship.anchored = !ship.anchored;
      return;
    }

    if (action === "build" && ship.kind === "builder") {
      // constrói estação de mineração no asteroide pousado
      const spec = STRUCTURE_SPECS["miningStation"];
      if (this.sim.getOre(sessionId) < spec.cost) return;

      // encontra o asteroide pelo id armazenado
      const astId = ship.anchoredAsteroidId;
      let ast = null;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          for (const a of sectorAsteroids(this.sim.seed, ship.sx + ox, ship.sy + oy)) {
            if (a.id === astId) { ast = a; break; }
          }
          if (ast) break;
        }
        if (ast) break;
      }
      if (!ast) return;

      // 1 estrutura por asteroide
      for (const st of this.sim.structures.values()) {
        if (st.asteroidId === ast.id) return;
      }

      const { dx, dy } = relVec(ast, ship);
      const angle = Math.atan2(dy, dx);
      const cls = asteroidClassOf(ast.radius);
      const shipBays = STATION_SHIP_BAYS;
      const expandedBays = STATION_EXPANDED_BAYS;
      const spiderBays = STATION_SPIDER_BAYS[cls];

      this.sim.spendOre(sessionId, spec.cost);
      const id = `st-${this.structSeq++}`;
      this.sim.addStructure({
        id, type: "miningStation", owner: sessionId,
        sx: ast.sx, sy: ast.sy, x: ast.x, y: ast.y,
        angle, asteroidId: ast.id, asteroidClass: cls,
        shipBays, expandedBays, spiderBays, nextShipBay: 0, nextSpiderBay: 0,
        oreStore: 0, rationStore: 0,
      });
      const ss = new StructureSchema();
      ss.stype = "miningStation"; ss.owner = sessionId;
      ss.sx = ast.sx; ss.sy = ast.sy; ss.x = ast.x; ss.y = ast.y;
      ss.angle = angle; ss.asteroidId = ast.id; ss.asteroidClass = cls;
      ss.shipBays = shipBays; ss.expandedBays = expandedBays;
      ss.spiderBays = spiderBays; ss.nextShipBay = 0; ss.nextSpiderBay = 0;
      this.state.structures.set(id, ss);

      // builder fica na vaga de pouso (centro) da estação recém-construída
      ship.hqId = id;
      ship.bay = -1;
      ship.anchored = true;
      ship.anchoredAsteroidId = "";
      ship.landingPhase = "";
      ship.sx = ast.sx; ship.sy = ast.sy; ship.x = ast.x; ship.y = ast.y;
      ship.mining = false; // zera resíduo de mineração em voo livre
      console.log(`[room] ${sessionId} construiu miningStation (via pouso) em ${cls} — builder na vaga de pouso`);
    }

    if (action === "buildhq" && ship.kind === "builder") {
      const spec = STRUCTURE_SPECS["hq"];
      if (this.sim.getOre(sessionId) < spec.cost) return;
      const astId = ship.anchoredAsteroidId;
      let ast = null;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          for (const a of sectorAsteroids(this.sim.seed, ship.sx + ox, ship.sy + oy)) {
            if (a.id === astId) { ast = a; break; }
          }
          if (ast) break;
        }
        if (ast) break;
      }
      if (!ast) return;
      for (const st of this.sim.structures.values()) {
        if (st.asteroidId === ast.id) return;
      }
      const { dx, dy } = relVec(ast, ship);
      const angle = Math.atan2(dy, dx);
      const cls = asteroidClassOf(ast.radius);
      const shipBays = HQ_SHIP_BAYS;
      const expandedBays = HQ_EXPANDED_BAYS;
      this.sim.spendOre(sessionId, spec.cost);
      const id = `st-${this.structSeq++}`;
      this.sim.addStructure({
        id, type: "hq", owner: sessionId,
        sx: ast.sx, sy: ast.sy, x: ast.x, y: ast.y,
        angle, asteroidId: ast.id, asteroidClass: cls,
        shipBays, expandedBays, spiderBays: 0, nextShipBay: 0, nextSpiderBay: 0,
        oreStore: 0, rationStore: 0,
      });
      const ss = new StructureSchema();
      ss.stype = "hq"; ss.owner = sessionId;
      ss.sx = ast.sx; ss.sy = ast.sy; ss.x = ast.x; ss.y = ast.y;
      ss.angle = angle; ss.asteroidId = ast.id; ss.asteroidClass = cls;
      ss.shipBays = shipBays; ss.expandedBays = expandedBays;
      ss.spiderBays = 0; ss.nextShipBay = 0; ss.nextSpiderBay = 0;
      this.state.structures.set(id, ss);
      ship.hqId = id;
      ship.bay = -1; // vaga de pouso (centro)
      ship.anchored = true;
      ship.anchoredAsteroidId = "";
      ship.landingPhase = "";
      ship.sx = ast.sx; ship.sy = ast.sy; ship.x = ast.x; ship.y = ast.y;
      ship.mining = false; // zera resíduo de mineração em voo livre
      console.log(`[room] ${sessionId} construiu hq (via pouso) em ${cls}`);
    }

    if (action === "buildration" && ship.kind === "builder") {
      const spec = STRUCTURE_SPECS["rationCenter"];
      if (this.sim.getOre(sessionId) < spec.cost) return;
      const astId = ship.anchoredAsteroidId;
      let ast = null;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          for (const a of sectorAsteroids(this.sim.seed, ship.sx + ox, ship.sy + oy)) {
            if (a.id === astId) { ast = a; break; }
          }
          if (ast) break;
        }
        if (ast) break;
      }
      if (!ast) return;
      for (const st of this.sim.structures.values()) {
        if (st.asteroidId === ast.id) return;
      }
      const { dx, dy } = relVec(ast, ship);
      const angle = Math.atan2(dy, dx);
      const cls = asteroidClassOf(ast.radius);
      this.sim.spendOre(sessionId, spec.cost);
      const id = `st-${this.structSeq++}`;
      this.sim.addStructure({
        id, type: "rationCenter", owner: sessionId,
        sx: ast.sx, sy: ast.sy, x: ast.x, y: ast.y,
        angle, asteroidId: ast.id, asteroidClass: cls,
        shipBays: RATION_CENTER_SHIP_BAYS, expandedBays: RATION_CENTER_EXPANDED_BAYS,
        spiderBays: 0, nextShipBay: 0, nextSpiderBay: 0,
        oreStore: 0, rationStore: 0,
      });
      const ss = new StructureSchema();
      ss.stype = "rationCenter"; ss.owner = sessionId;
      ss.sx = ast.sx; ss.sy = ast.sy; ss.x = ast.x; ss.y = ast.y;
      ss.angle = angle; ss.asteroidId = ast.id; ss.asteroidClass = cls;
      ss.shipBays = RATION_CENTER_SHIP_BAYS; ss.expandedBays = RATION_CENTER_EXPANDED_BAYS;
      ss.spiderBays = 0; ss.nextShipBay = 0; ss.nextSpiderBay = 0;
      this.state.structures.set(id, ss);
      this.rationDroneTimers.set(id, RATION_DRONE_INTERVAL);
      ship.hqId = id;
      ship.bay = -1;
      ship.anchored = true;
      ship.anchoredAsteroidId = "";
      ship.landingPhase = "";
      ship.sx = ast.sx; ship.sy = ast.sy; ship.x = ast.x; ship.y = ast.y;
      ship.mining = false;
      console.log(`[room] ${sessionId} construiu rationCenter em ${cls}`);
    }
  }

  /**
   * Builder ancorado na estação: SPACE liga/desliga sua mineração automática.
   * O minério acumula no buffer da estação (junto com as aranhas).
   */
  private tryStationMine(sessionId: string): void {
    const ship = this.activeShipOf(sessionId);
    if (!ship || ship.kind !== "builder" || !ship.anchored) return;
    const station = this.sim.structures.get(ship.hqId);
    if (!station || station.type !== "miningStation") return;
    ship.mining = !ship.mining;
  }

  /** Dispara um projétil da nave de ataque (perfurante ou granada). */
  private tryFire(sessionId: string, kind?: "bullet" | "grenade"): void {
    const ship = this.activeShipOf(sessionId);
    if (!ship || ship.kind !== "attack" || ship.anchored || ship.stored) return;
    if (!kind) return;
    if (kind === "bullet") {
      if (ship.ammo <= 0 || ship.fireCooldown > 0) return;
      ship.ammo--;
      ship.fireCooldown = BULLET_COOLDOWN;
    } else {
      if (ship.grenadeAmmo <= 0 || ship.grenadeCooldown > 0) return;
      ship.grenadeAmmo--;
      ship.grenadeCooldown = GRENADE_COOLDOWN;
    }
    const speed = kind === "bullet" ? BULLET_SPEED : GRENADE_SPEED;
    const id = `pr-${this.projSeq++}`;
    const proj = {
      kind,
      owner: sessionId,
      sx: ship.sx, sy: ship.sy,
      x: ship.x + Math.cos(ship.angle) * 30,
      y: ship.y + Math.sin(ship.angle) * 30,
      vx: ship.vx + Math.cos(ship.angle) * speed,
      vy: ship.vy + Math.sin(ship.angle) * speed,
      traveled: 0,
    };
    this.projectiles.set(id, proj);
    const ps = new ProjectileSchema();
    ps.kind = kind; ps.owner = sessionId;
    ps.sx = proj.sx; ps.sy = proj.sy;
    ps.x = proj.x; ps.y = proj.y;
    ps.vx = proj.vx; ps.vy = proj.vy;
    ps.traveled = 0;
    this.state.projectiles.set(id, ps);
  }

  /**
   * Carga/descarga do transporte pousado na vaga de pouso. O contexto
   * decide a operação (uma por aperto de [E]):
   * - com RAÇÕES a bordo e estrutura que recebe rações (QG/estação/base):
   *   descarrega no estoque da estrutura;
   * - com MINÉRIO a bordo na base inicial: descarrega → credita a carteira
   *   (o minério "é enviado à Terra");
   * - vazio na estação com minério em estoque: carrega minério;
   * - vazio na base inicial com rações em estoque: carrega rações.
   */
  private tryCargo(sessionId: string): void {
    const ship = this.activeShipOf(sessionId);
    if (!ship || ship.kind !== "transport" || !ship.anchored) return;
    const struct = this.sim.structures.get(ship.hqId);
    if (!struct || struct.owner !== sessionId) return;

    // descarrega rações em qualquer estrutura própria
    if (ship.cargoKind === "rations" && ship.cargoAmount > 0) {
      const space = RATION_STORE_CAP - struct.rationStore;
      const moved = Math.min(ship.cargoAmount, Math.max(0, space));
      if (moved <= 0) return;
      struct.rationStore += moved;
      ship.cargoAmount -= moved;
      if (ship.cargoAmount <= 0) { ship.cargoKind = ""; ship.cargoAmount = 0; }
      console.log(`[room] ${sessionId} descarregou ${Math.round(moved)} rações em ${struct.id}`);
      return;
    }

    // descarrega minério na base inicial → credita a carteira (envio à Terra)
    if (ship.cargoKind === "ore" && ship.cargoAmount > 0) {
      if (struct.type === "initialBase") {
        this.sim.addOre(sessionId, ship.cargoAmount);
        console.log(`[room] ${sessionId} entregou ${Math.round(ship.cargoAmount)} de minério na base`);
        ship.cargoKind = "";
        ship.cargoAmount = 0;
      } else if (struct.type === "miningStation") {
        // devolve ao estoque da estação (desistiu da viagem)
        const space = STATION_ORE_STORE - struct.oreStore;
        const moved = Math.min(ship.cargoAmount, Math.max(0, space));
        if (moved <= 0) return;
        struct.oreStore += moved;
        ship.cargoAmount -= moved;
        if (ship.cargoAmount <= 0) { ship.cargoKind = ""; ship.cargoAmount = 0; }
      }
      return;
    }

    // porão vazio: carrega o que a estrutura oferece
    if (struct.type === "miningStation" && struct.oreStore > 0) {
      const moved = Math.min(TRANSPORT_CARGO_CAP, struct.oreStore);
      struct.oreStore -= moved;
      ship.cargoKind = "ore";
      ship.cargoAmount = moved;
      console.log(`[room] ${sessionId} carregou ${Math.round(moved)} de minério em ${struct.id}`);
      return;
    }
    if (struct.type === "initialBase" && struct.rationStore > 0) {
      const moved = Math.min(TRANSPORT_CARGO_CAP, struct.rationStore);
      struct.rationStore -= moved;
      ship.cargoKind = "rations";
      ship.cargoAmount = moved;
      console.log(`[room] ${sessionId} carregou ${Math.round(moved)} rações na base`);
    }
  }

  /**
   * Requisita um táxi: despacha uma nave guardada no hangar próprio mais
   * próximo para a estrutura onde o jogador está ancorado, se houver vaga lá.
   */
  private tryTaxi(sessionId: string, shipId?: string): void {
    const active = this.activeShipOf(sessionId);
    if (!active || !active.anchored) return;
    // táxi disponível ancorado numa ESTAÇÃO DE MINERAÇÃO ou BASE INICIAL
    // próprias (ex.: da base, solicitar um transporte de um QG próximo)
    const dest =
      this.nearestOwnStructure(sessionId, active, DOCK_RANGE, "miningStation") ??
      this.nearestOwnStructure(sessionId, active, DOCK_RANGE, "initialBase");
    if (!dest) return;

    let best: { id: string; ship: ShipState; src: { id: string; sx: number; sy: number; x: number; y: number } } | null = null;

    // nave escolhida pelo jogador — precisa estar guardada num QG
    if (shipId) {
      const s = this.sim.ships.get(shipId);
      const src = s ? this.sim.structures.get(s.hqId) : undefined;
      if (s && src && src.type === "hq" && s.owner === sessionId && s.stored) {
        best = { id: shipId, ship: s, src };
      }
    }

    // fallback: nave guardada no QG mais próximo da estação
    if (!best) {
      let bestDist = Infinity;
      for (const [id, s] of this.sim.ships) {
        if (s.owner !== sessionId || !s.stored) continue;
        const src = this.sim.structures.get(s.hqId);
        if (!src || src.type !== "hq") continue;
        const d = dist(src, dest);
        if (d < bestDist) {
          bestDist = d;
          best = { id, ship: s, src };
        }
      }
    }
    if (!best) return; // nenhuma nave em QG
    // vaga no destino compatível com a CLASSE da nave
    if (this.firstFreeShipBay(dest, best.ship.kind) < 0) return;

    // despacha: spawna DO hangar (posição do QG) e voa reto até a estação
    best.ship.stored = false;
    best.ship.anchored = false;
    best.ship.taxiTo = dest.id;
    best.ship.sx = best.src.sx;
    best.ship.sy = best.src.sy;
    best.ship.x = best.src.x;
    best.ship.y = best.src.y;
    best.ship.vx = 0;
    best.ship.vy = 0;
    console.log(`[room] ${sessionId} táxi: ${best.ship.kind} de ${best.src.id} → ${dest.id} (2x, sem colisão)`);
  }

  /**
   * Primeira vaga LIVRE do hangar de naves da estrutura (-1 = cheio).
   * O hangar guarda apenas naves ARMAZENADAS (stored) — a nave pousada
   * fica na vaga de pouso, no centro da estrutura, e não conta aqui.
   * `kind` decide QUAIS vagas a nave pode ocupar:
   * - vagas EXPANDIDAS (índices 0..expandedBays-1): qualquer classe;
   * - vagas NORMAIS (índices expandedBays..shipBays-1): SOMENTE ataque e
   *   transporte.
   * Builder e mineração, portanto, só cabem nas expandidas; ataque/transporte
   * preferem as normais e TRANSBORDAM para as expandidas quando as normais
   * estão cheias, sem impedir builder/mineração de guardar (ver ordem abaixo).
   */
  private firstFreeShipBay(struct: Structure, kind: ShipKind): number {
    const taken = new Set<number>();
    for (const s of this.sim.ships.values()) {
      if (s.hqId === struct.id && s.stored && s.bay >= 0) taken.add(s.bay);
    }
    const normalOnly = kind === "attack" || kind === "transport";
    if (normalOnly) {
      // ataque/transporte: normais primeiro, expandidas como transbordo
      for (let i = struct.expandedBays; i < struct.shipBays; i++) {
        if (!taken.has(i)) return i;
      }
      for (let i = 0; i < struct.expandedBays; i++) {
        if (!taken.has(i)) return i;
      }
    } else {
      // builder/mineração: SOMENTE expandidas
      for (let i = 0; i < struct.expandedBays; i++) {
        if (!taken.has(i)) return i;
      }
    }
    return -1;
  }

  /** Passa o controle do jogador para outra nave própria (prefere um builder). */
  private transferControl(sessionId: string, excludeId: string): boolean {
    let target: [string, ShipState] | null = null;
    for (const [id, s] of this.sim.ships) {
      if (id === excludeId || s.owner !== sessionId || s.autoMining) continue;
      if (!target || (s.kind === "builder" && target[1].kind !== "builder")) target = [id, s];
    }
    if (!target) return false;
    const [tid, ts] = target;
    if (ts.stored) {
      const struct = ts.hqId ? this.sim.structures.get(ts.hqId) : undefined;
      if (struct) this.deployFromHangar(ts, struct);
      else ts.stored = false;
    }
    this.activeShip.set(sessionId, tid);
    return true;
  }

  /** Tira uma nave do hangar e a ancora na vaga de pouso (centro da estrutura). */
  private deployFromHangar(
    ship: ShipState,
    struct: { id: string; sx: number; sy: number; x: number; y: number },
  ): void {
    ship.stored = false;
    ship.anchored = true;
    ship.bay = -1; // vaga de pouso não consome vaga de hangar
    ship.sx = struct.sx;
    ship.sy = struct.sy;
    ship.x = struct.x;
    ship.y = struct.y;
    ship.vx = 0;
    ship.vy = 0;
    ship.mining = false;
  }

  /** Estrutura própria MAIS PRÓXIMA (opcionalmente de um tipo) dentro de `range`. */
  private nearestOwnStructure(
    sessionId: string,
    from: ShipState,
    range: number,
    type?: "hq" | "miningStation" | "initialBase",
  ) {
    let best: ReturnType<typeof this.sim.structures.get> = undefined;
    let bestD = range;
    for (const st of this.sim.structures.values()) {
      if (st.owner !== sessionId) continue;
      if (type && st.type !== type) continue;
      const d = dist(from, st);
      if (d <= bestD) {
        bestD = d;
        best = st;
      }
    }
    return best ?? null;
  }

  /**
   * Valida e constrói uma estrutura DENTRO do asteroide mais próximo.
   * O asteroide hospedeiro deixa de colidir e só comporta uma estrutura.
   */
  private tryBuild(sessionId: string, type?: BuildCommand["type"]): void {
    const ship = this.activeShipOf(sessionId);
    if (!ship || !type) return;
    // só o builder pode construir
    if (ship.kind !== "builder") return;
    const spec = STRUCTURE_SPECS[type];
    if (!spec || this.sim.getOre(sessionId) < spec.cost) return;

    const ast = this.sim.nearestAsteroid(ship, BUILD_ASTEROID_RANGE);
    if (!ast) return;

    // 1 estrutura por asteroide (de qualquer jogador)
    for (const st of this.sim.structures.values()) {
      if (st.asteroidId === ast.id) return;
    }

    // a estrutura vive no CENTRO do asteroide; orientação base voltada à nave
    const { dx, dy } = relVec(ast, ship);
    const angle = Math.atan2(dy, dx);

    const cls = asteroidClassOf(ast.radius);
    // vagas fixas: QG tem 2 expandidas + 4 normais; estação tem 2 expandidas
    const shipBays = type === "hq" ? HQ_SHIP_BAYS : STATION_SHIP_BAYS;
    const expandedBays = type === "hq" ? HQ_EXPANDED_BAYS : STATION_EXPANDED_BAYS;
    const spiderBays = type === "miningStation" ? STATION_SPIDER_BAYS[cls] : 0;

    this.sim.spendOre(sessionId, spec.cost);
    const id = `st-${this.structSeq++}`;
    this.sim.addStructure({
      id,
      type,
      owner: sessionId,
      sx: ast.sx,
      sy: ast.sy,
      x: ast.x,
      y: ast.y,
      angle,
      asteroidId: ast.id,
      asteroidClass: cls,
      shipBays,
      expandedBays,
      spiderBays,
      nextShipBay: 0,
      nextSpiderBay: 0,
      oreStore: 0,
      rationStore: 0,
    });

    const ss = new StructureSchema();
    ss.stype = type;
    ss.owner = sessionId;
    ss.sx = ast.sx;
    ss.sy = ast.sy;
    ss.x = ast.x;
    ss.y = ast.y;
    ss.angle = angle;
    ss.asteroidId = ast.id;
    ss.asteroidClass = cls;
    ss.shipBays = shipBays;
    ss.expandedBays = expandedBays;
    ss.spiderBays = spiderBays;
    ss.nextShipBay = 0;
    ss.nextSpiderBay = 0;
    this.state.structures.set(id, ss);

    // builder fica na vaga de pouso (centro) da estrutura recém-construída
    const activeShip = this.activeShipOf(sessionId);
    if (activeShip) {
      activeShip.hqId = id;
      activeShip.bay = -1;
      activeShip.anchored = true;
      activeShip.anchoredAsteroidId = "";
      activeShip.landingPhase = "";
      activeShip.sx = ast.sx; activeShip.sy = ast.sy;
      activeShip.x = ast.x; activeShip.y = ast.y;
      activeShip.vx = 0; activeShip.vy = 0;
      // zera resíduo de mineração em voo livre — ancorar começa sempre
      // parado; a mineração na estação liga só via toggle explícito
      activeShip.mining = false;
    }
    console.log(
      `[room] ${sessionId} construiu ${type} em asteroide ${cls} (naves:${shipBays} aranhas:${spiderBays})`,
    );
  }

  /**
   * Fabrica uma nave no hangar do QG mais próximo, respeitando a capacidade.
   * Basta estar ancorado em QUALQUER estrutura própria (ex.: numa estação de
   * mineração, a nave é construída no QG mais próximo dela).
   */
  private tryProduce(sessionId: string, kind?: ProduceCommand["kind"]): void {
    const pilot = this.activeShipOf(sessionId);
    if (!pilot || !kind) return;
    const spec = SHIP_PRODUCTION[kind];
    if (!spec || this.sim.getOre(sessionId) < spec.cost) return;
    if (!pilot.anchored) return; // precisa estar ancorado numa estrutura

    const hq = this.nearestOwnStructure(sessionId, pilot, Infinity, "hq");
    if (!hq) return;

    // capacidade = vagas de nave do QG compatíveis com a classe produzida
    const bay = this.firstFreeShipBay(hq, kind);
    if (bay < 0) return; // hangar cheio ou sem vaga compatível

    this.sim.spendOre(sessionId, spec.cost);
    const id = `sh-${this.shipSeq++}`;
    const ship = this.spawnShip(id, hq, sessionId, kind);
    ship.hqId = hq.id;
    ship.stored = true;
    ship.bay = bay; // vaga calculada por firstFreeShipBay
    this.state.ships.set(id, this.mirrorSpawn(ship));
    console.log(`[room] ${sessionId} fabricou ${kind} — vaga ${ship.bay} do QG ${hq.id}`);
  }

  /** Expande a arena para o próximo tamanho: 8 → 20 → 50 setores. */
  private expandMap(): void {
    const cur = Math.round(this.state.mapRadius / SECTOR_SIZE);
    const next = cur < 20 ? 20 : cur < 50 ? 50 : 0;
    if (!next) return;
    const radiusUnits = next * SECTOR_SIZE;
    this.sim.setBoundary(this.arenaCenter, radiusUnits);
    this.state.mapRadius = radiusUnits;
    console.log(`[room] arena expandida: ${cur} → ${next} setores`);
  }

  /** Destrói uma nave (remove do mundo; se for do jogador, transfere controle). */
  private destroyShip(shipId: string): void {
    const ship = this.sim.ships.get(shipId);
    if (!ship) return;
    // transfere controle se for a nave ativa de algum jogador
    for (const [sid, active] of this.activeShip) {
      if (active === shipId) {
        this.transferControl(sid, shipId);
        break;
      }
    }
    this.sim.removeShip(shipId);
    this.spiders.delete(shipId);
    this.state.ships.delete(shipId);
    console.log(`[room] nave ${shipId} destruída`);
  }

  private mirrorSpawn(ship: ShipState): ShipSchema {
    const s = new ShipSchema();
    s.sx = ship.sx;
    s.sy = ship.sy;
    s.x = ship.x;
    s.y = ship.y;
    s.owner = ship.owner;
    s.kind = ship.kind;
    s.anchored = ship.anchored;
    s.stored = ship.stored;
    s.hqId = ship.hqId;
    s.autoMining = ship.autoMining;
    s.stationId = ship.stationId;
    s.bay = ship.bay;
    s.landingPhase = ship.landingPhase;
    s.landingProgress = ship.landingProgress;
    s.landingTargetX = ship.landingTargetX;
    s.landingTargetY = ship.landingTargetY;
    s.landingOriginX = ship.landingOriginX;
    s.landingOriginY = ship.landingOriginY;
    s.landingAsteroidSpin = ship.landingAsteroidSpin;
    s.cargoKind = ship.cargoKind;
    s.cargoAmount = ship.cargoAmount;
    s.hp = ship.hp;
    s.ammo = ship.ammo;
    s.grenadeAmmo = ship.grenadeAmmo;
    return s;
  }

  private tick(dt: number) {
    this.elapsed += dt;
    // Animação de pouso/decolagem do builder
    const LAND_DURATION = 1.5;
    for (const [, ship] of this.sim.ships) {
      if (ship.landingPhase === "landing") {
        ship.landingProgress = Math.min(1, ship.landingProgress + dt / LAND_DURATION);
        const t = ship.landingProgress;
        // a vaga de pouso é o CENTRO da estrutura (0,0) — ponto fixo da
        // rotação do asteroide, então o alvo não precisa ser recalculado
        ship.x = ship.landingOriginX + (ship.landingTargetX - ship.landingOriginX) * t;
        ship.y = ship.landingOriginY + (ship.landingTargetY - ship.landingOriginY) * t;
        ship.vx = 0; ship.vy = 0;
        if (t >= 1) {
          if (ship.hqId) {
            // pouso em estrutura própria: ancora na vaga de pouso (centro)
            ship.landingPhase = "";
            ship.anchored = true;
            ship.anchoredAsteroidId = "";
            ship.mining = false; // zera resíduo de mineração em voo livre
            const struct = this.sim.structures.get(ship.hqId);
            if (struct) {
              ship.sx = struct.sx; ship.sy = struct.sy;
              ship.x = struct.x;
              ship.y = struct.y;
            }
          } else {
            // pouso em asteroide vazio: fica no estado "landed"
            ship.landingPhase = "landed";
            ship.angle = 0;
          }
        }
      } else if (ship.landingPhase === "liftoff") {
        // fase removida: decolagem é instantânea via tryToggleAnchor
        ship.landingPhase = "";
        ship.anchored = false;
        ship.anchoredAsteroidId = "";
      }
    }
    // IA dos bots neutros
    for (const [id, bot] of this.bots) {
      const ship = this.sim.ships.get(id);
      if (ship) this.sim.setInput(id, computeBotInput(ship, this.sim, bot, dt));
    }
    // BUILDER minerando na estação: enche o estoque LOCAL da estação —
    // logística física: o transporte leva até a base inicial, e só a
    // descarga lá credita a carteira
    for (const ship of this.sim.ships.values()) {
      if (!ship.anchored || !ship.mining || ship.kind !== "builder") continue;
      const station = this.sim.structures.get(ship.hqId);
      if (!station || station.type !== "miningStation") continue;
      if (station.oreStore >= STATION_ORE_STORE) { ship.mining = false; continue; }
      const rate = MINING_RATE_BY_KIND["builder"];
      station.oreStore = Math.min(STATION_ORE_STORE, station.oreStore + rate * dt);
    }
    // ARANHAS mineradoras → caminham pelo asteroide e descarregam no
    // estoque LOCAL da estação (param quando ele está cheio)
    for (const [id, spider] of this.spiders) {
      const ship = this.sim.ships.get(id);
      const station = ship ? this.sim.structures.get(ship.stationId) : undefined;
      if (!ship || !station) {
        this.spiders.delete(id);
        continue;
      }
      if (station.oreStore >= STATION_ORE_STORE) {
        ship.mining = false;
        continue;
      }
      const unloaded = stepSpider(ship, station, spider, dt);
      if (unloaded > 0) {
        station.oreStore = Math.min(STATION_ORE_STORE, station.oreStore + unloaded);
      }
    }
    // IA do táxi → voa até o destino; ao chegar, estaciona na 1ª vaga livre
    for (const [id, ship] of this.sim.ships) {
      if (!ship.taxiTo) continue;
      const dest = this.sim.structures.get(ship.taxiTo);
      if (!dest) {
        ship.taxiTo = "";
        continue;
      }
      if (dist(ship, dest) <= DOCK_RANGE) {
        const freeBay = this.firstFreeShipBay(dest, ship.kind);
        ship.stored = true;
        ship.hqId = ship.taxiTo;
        ship.taxiTo = "";
        ship.anchored = false;
        ship.bay = freeBay >= 0 ? freeBay : 0;
        ship.vx = 0;
        ship.vy = 0;
        this.sim.setInput(id, { thrust: false, turn: 0, mine: false });
        console.log(`[room] táxi chegou: ${ship.kind} na vaga ${ship.bay} de ${ship.hqId}`);
      } else {
        this.sim.setInput(id, computeTaxiInput(ship, dest));
      }
    }
    // PROJÉTEIS: move, colide, expira
    for (const [id, proj] of this.projectiles) {
      const step = Math.hypot(proj.vx, proj.vy) * dt;
      proj.x += proj.vx * dt;
      proj.y += proj.vy * dt;
      normalizePos(proj);
      proj.traveled += step;

      let hit = false;
      if (proj.kind === "bullet") {
        // expira por distância
        if (proj.traveled >= BULLET_RANGE) { hit = true; }
        else {
          // colide com naves inimigas
          for (const [sid, target] of this.sim.ships) {
            if (target.owner === proj.owner || target.stored || target.anchored) continue;
            const { dx, dy } = relVec(proj, target);
            if (Math.hypot(dx, dy) <= BULLET_RADIUS + 20) {
              target.hp = Math.max(0, target.hp - BULLET_DAMAGE);
              hit = true;
              if (target.hp <= 0) this.destroyShip(sid);
              break;
            }
          }
        }
      } else {
        // granada: detona por proximidade com nave inimiga
        for (const [, target] of this.sim.ships) {
          if (target.owner === proj.owner || target.stored || target.anchored) continue;
          const { dx, dy } = relVec(proj, target);
          if (Math.hypot(dx, dy) <= GRENADE_PROX_RADIUS) {
            // dano em área
            for (const [sid2, t2] of this.sim.ships) {
              if (t2.owner === proj.owner || t2.stored) continue;
              const { dx: dx2, dy: dy2 } = relVec(proj, t2);
              const d2 = Math.hypot(dx2, dy2);
              if (d2 <= GRENADE_BLAST_RADIUS) {
                const dmg = GRENADE_DAMAGE * (1 - d2 / GRENADE_BLAST_RADIUS);
                t2.hp = Math.max(0, t2.hp - dmg);
                if (t2.hp <= 0) this.destroyShip(sid2);
              }
            }
            hit = true;
            break;
          }
        }
        // expira por distância (2× alcance do perfurante)
        if (proj.traveled >= BULLET_RANGE * 2) hit = true;
      }

      if (hit) {
        this.projectiles.delete(id);
        this.state.projectiles.delete(id);
      } else {
        const ps = this.state.projectiles.get(id);
        if (ps) {
          ps.sx = proj.sx; ps.sy = proj.sy;
          ps.x = proj.x; ps.y = proj.y;
          ps.traveled = proj.traveled;
        }
      }
    }
    // cooldowns de disparo
    for (const ship of this.sim.ships.values()) {
      if (ship.fireCooldown > 0) ship.fireCooldown = Math.max(0, ship.fireCooldown - dt);
      if (ship.grenadeCooldown > 0) ship.grenadeCooldown = Math.max(0, ship.grenadeCooldown - dt);
    }
    // CENTRO DE DISTRIBUIÇÃO DE RAÇÕES: a cada RATION_DRONE_INTERVAL s,
    // entrega RATION_DRONE_AMOUNT rações a cada estrutura própria dentro do alcance
    for (const [id, center] of this.sim.structures) {
      if (center.type !== "rationCenter") continue;
      if (center.rationStore <= 0) continue;
      let timer = this.rationDroneTimers.get(id) ?? RATION_DRONE_INTERVAL;
      timer -= dt;
      if (timer <= 0) {
        timer = RATION_DRONE_INTERVAL;
        for (const target of this.sim.structures.values()) {
          if (target.id === id || target.owner !== center.owner) continue;
          if (target.type === "rationCenter") continue;
          const { dx, dy } = relVec(center, target);
          if (Math.hypot(dx, dy) > RATION_DRONE_RANGE) continue;
          const delivered = Math.min(RATION_DRONE_AMOUNT, center.rationStore);
          if (delivered <= 0) break;
          const space = RATION_STORE_CAP - target.rationStore;
          const moved = Math.min(delivered, Math.max(0, space));
          if (moved <= 0) continue;
          target.rationStore += moved;
          center.rationStore -= moved;
          console.log(`[room] drone de rações: ${Math.round(moved)} de ${id} → ${target.id}`);
        }
      }
      this.rationDroneTimers.set(id, timer);
    }
    this.sim.tick(dt);
    // espelha sim-core → schema
    for (const [id, ship] of this.sim.ships) {
      const s = this.state.ships.get(id);
      if (!s) continue;
      s.sx = ship.sx;
      s.sy = ship.sy;
      s.x = ship.x;
      s.y = ship.y;
      s.vx = ship.vx;
      s.vy = ship.vy;
      s.angle = ship.angle;
      s.mining = ship.mining;
      s.anchored = ship.anchored;
      s.stored = ship.stored;
      s.hqId = ship.hqId;
      s.anchoredAsteroidId = ship.anchoredAsteroidId;
      s.autoMining = ship.autoMining;
      s.stationId = ship.stationId;
      s.bay = ship.bay;
      s.landingPhase = ship.landingPhase;
      s.landingProgress = ship.landingProgress;
      s.landingTargetX = ship.landingTargetX;
      s.landingTargetY = ship.landingTargetY;
      s.landingOriginX = ship.landingOriginX;
      s.landingOriginY = ship.landingOriginY;
      s.landingAsteroidSpin = ship.landingAsteroidSpin;
      s.cargoKind = ship.cargoKind;
      s.cargoAmount = ship.cargoAmount;
      s.hp = ship.hp;
      s.ammo = ship.ammo;
      s.grenadeAmmo = ship.grenadeAmmo;
    }
    // estruturas
    for (const [id, st] of this.sim.structures) {
      const s = this.state.structures.get(id);
      if (!s) continue;
      s.stype = st.type;
      s.owner = st.owner;
      s.sx = st.sx;
      s.sy = st.sy;
      s.x = st.x;
      s.y = st.y;
      s.angle = st.angle;
      s.asteroidId = st.asteroidId;
      s.asteroidClass = st.asteroidClass;
      s.shipBays = st.shipBays;
      s.expandedBays = st.expandedBays;
      s.spiderBays = st.spiderBays;
      s.nextShipBay = st.nextShipBay;
      s.nextSpiderBay = st.nextSpiderBay;
      s.oreStore = st.oreStore;
      s.rationStore = st.rationStore;
    }
    // minério e nave ativa por jogador
    for (const [sid, p] of this.state.players) {
      p.ore = this.sim.getOre(sid);
      p.activeShip = this.activeShip.get(sid) ?? "";
    }
  }
}
