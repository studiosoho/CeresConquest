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
  TICK_RATE,
  SECTOR_SIZE,
  STRUCTURE_SPECS,
  SHIP_PRODUCTION,
  HQ_SHIP_BAYS,
  HQ_EXPANDED_BAYS,
  STATION_SHIP_BAYS,
  STATION_EXPANDED_BAYS,
  STATION_SPIDER_BAYS,
  DOCK_RANGE,
  BUILD_ASTEROID_RANGE,
  STATION_MINE_BUFFER,
  MINING_RATE_BY_KIND,
  asteroidClassOf,
  asteroidSpinRate,
  relVec,
  dist,
  type ShipInput,
  type BuildCommand,
  type ProduceCommand,
  type TaxiCommand,
  type LandActionCommand,
} from "@ceres/shared";
import {
  SimWorld,
  findClearSpawn,
  sectorAsteroids,
  type ShipState,
  type Structure,
} from "@ceres/sim-core";
import { MatchState, ShipSchema, StructureSchema, PlayerSchema } from "../schema/State";
import { mapSpawns, beltBasePoint, type SpawnStrategy } from "../spawn";
import { computeBotInput, computeTaxiInput, makeBotState, type BotState } from "../bots";
import { makeSpiderState, stepSpider, type SpiderState } from "../spiders";

/** Nº de jogadores-teste autônomos (bots) por padrão. */
const DEFAULT_BOTS = 10;

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

  onCreate(options: MatchOptions = {}) {
    this.maxClients = options.maxPlayers ?? 12;
    const botCount = options.bots ?? DEFAULT_BOTS;
    const radiusSectors = options.mapSize === "large" ? 50
      : options.mapSize === "medium" ? 20 : 8;
    const seed = options.worldSeed ?? (Math.random() * 0xffffffff) >>> 0;

    this.sim = new SimWorld(seed);
    // spawns em setores distintos do cinturão dentro da arena do mapa
    this.spawns = mapSpawns(seed, radiusSectors, this.maxClients + botCount);

    // fronteira circular: centro no ponto base do cinturão, raio pelo tamanho
    const base = beltBasePoint(seed);
    const center = { sx: base.sx, sy: base.sy, x: SECTOR_SIZE / 2, y: SECTOR_SIZE / 2 };
    const radiusUnits = radiusSectors * SECTOR_SIZE;
    this.arenaCenter = center;
    this.sim.setBoundary(center, radiusUnits);

    this.setState(new MatchState());
    this.state.worldSeed = seed;
    this.state.mapCenterSx = base.sx;
    this.state.mapCenterSy = base.sy;
    this.state.mapRadius = radiusUnits;

    // popula a partida com jogadores-teste autônomos (mineradoras neutras)
    for (let i = 0; i < botCount; i++) {
      const id = `bot-${i}`;
      const ship = this.spawnShip(id, this.spawns[this.maxClients + i], "", "mining");
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

    this.setSimulationInterval((deltaMs) => this.tick(deltaMs / 1000), 1000 / TICK_RATE);
    console.log(
      `[room] match criada — seed=${seed} raio=${radiusSectors}s ` +
        `maxPlayers=${this.maxClients} bots=${botCount}`,
    );
  }

  onJoin(client: Client) {
    const base = this.spawns[this.spawnIndex++ % this.spawns.length];
    const id = `p${this.shipSeq++}`;
    const ship = this.spawnShip(id, base, client.sessionId, "builder");
    this.activeShip.set(client.sessionId, id);
    // espelha a posição de spawn JÁ no join — o primeiro estado que o
    // cliente recebe precisa ser real, não os defaults do schema
    this.state.ships.set(id, this.mirrorSpawn(ship));
    const p = new PlayerSchema();
    p.activeShip = id;
    this.state.players.set(client.sessionId, p);
    this.sim.playerOre.set(client.sessionId, 0);
    console.log(`[room] ${client.sessionId} entrou — nave ${id} setor (${ship.sx}, ${ship.sy})`);
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
  private bayWorldPos(struct: Structure, bay: number): { x: number; y: number } {
    const SHIP_R = 20; // SHIP_RADIUS
    const slotN  = SHIP_R * 2.0;
    const slotEW = SHIP_R * 3.2;
    const slotEH = SHIP_R * 2.4;
    const gap    = SHIP_R * 0.5;
    const structRadius = struct.type === "hq" ? SHIP_R * 6 : SHIP_R * 4;
    const y0 = structRadius + slotEH * 0.6; // mesma fórmula do cliente

    // ângulo atual da estrutura = ângulo base + rotação do asteroide até agora
    const spin = this.asteroidSpinOf(this.getShapeSeedForStruct(struct));
    const currentAngle = struct.angle + spin * this.elapsed;

    // largura total para centralizar
    let totalW = 0;
    for (let i = 0; i < struct.shipBays; i++) {
      totalW += (i < struct.expandedBays ? slotEW : slotN) + (i > 0 ? gap : 0);
    }
    let curX = -totalW / 2;
    for (let i = 0; i < struct.shipBays; i++) {
      const sw = i < struct.expandedBays ? slotEW : slotN;
      const cx = curX + sw / 2;
      if (i === bay) {
        const cos = Math.cos(currentAngle);
        const sin = Math.sin(currentAngle);
        return {
          x: struct.x + cx * cos - y0 * sin,
          y: struct.y + cx * sin + y0 * cos,
        };
      }
      curX += sw + gap;
    }
    return { x: struct.x, y: struct.y };
  }

  /** Retorna a shapeSeed do asteroide hospedeiro de uma estrutura. */
  private getShapeSeedForStruct(struct: Structure): number {
    for (const a of sectorAsteroids(this.sim.seed, struct.sx, struct.sy)) {
      if (a.id === struct.asteroidId) return a.shapeSeed;
    }
    return 0;
  }

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

    // builder e mining: pousam no asteroide mais próximo dentro do DOCK_RANGE * 2
    if (ship.kind === "builder" || ship.kind === "mining") {
      const ast = this.sim.nearestAsteroid(ship, DOCK_RANGE * 2);
      console.log(`[anchor] ${sessionId} ship=(${ship.sx},${ship.sy},${Math.round(ship.x)},${Math.round(ship.y)}) ast=${ast?.id ?? "none"} edgeDist=${ast ? Math.round(Math.hypot((ast.sx - ship.sx) * 10000 + ast.x - ship.x, (ast.sy - ship.sy) * 10000 + ast.y - ship.y) - ast.radius) : "n/a"}`);
      if (ast) {
        const ownStruct = [...this.sim.structures.values()].find(
          s => s.asteroidId === ast.id && s.owner === sessionId,
        );
        const anyStruct = !ownStruct && [...this.sim.structures.values()].some(s => s.asteroidId === ast.id);

        if (ownStruct) {
          // asteroide com estrutura PRÓPRIA: anima até a vaga livre
          const effectiveKind = ship.kind === "builder" ? "mining" : ship.kind;
          const bay = this.firstFreeShipBay(ownStruct, effectiveKind);
          if (bay < 0) return; // hangar cheio
          const spin = this.asteroidSpinOf(ast.shapeSeed);
          const bayPos = this.bayWorldPos(ownStruct, bay);
          ship.landingPhase = "landing";
          ship.landingProgress = 0;
          ship.landingOriginX = ship.x;
          ship.landingOriginY = ship.y;
          ship.landingTargetX = bayPos.x;
          ship.landingTargetY = bayPos.y;
          ship.landingAsteroidSpin = spin;
          ship.anchoredAsteroidId = "";
          ship.hqId = ownStruct.id;
          ship.bay = bay;
          ship.vx = 0;
          ship.vy = 0;
          return;
        }

        if (!anyStruct) {
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

    // pousa em estrutura própria com vaga compatível (sem asteroide próximo)
    const struct = this.nearestOwnStructure(sessionId, ship, DOCK_RANGE);
    if (!struct) return;
    const bay2 = this.firstFreeShipBay(struct, ship.kind);
    if (bay2 < 0) return;
    ship.anchored = true;
    ship.hqId = struct.id;
    ship.anchoredAsteroidId = "";
    ship.landingPhase = "";
    ship.bay = bay2;
    ship.sx = struct.sx;
    ship.sy = struct.sy;
    ship.x = struct.x;
    ship.y = struct.y;
    ship.vx = 0;
    ship.vy = 0;
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

    // guarda a nave ativa neste hangar
    active.stored = true;
    active.anchored = false;
    active.hqId = struct.id;
    this.sim.setInput(this.activeShip.get(sessionId)!, { thrust: false, turn: 0, mine: false });

    // tira a nave escolhida do hangar, ancorada na estrutura
    const [nid, next] = pick;
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
        shipBays, expandedBays, spiderBays, nextShipBay: 0, nextSpiderBay: 0, mineBuffer: 0,
      });
      const ss = new StructureSchema();
      ss.stype = "miningStation"; ss.owner = sessionId;
      ss.sx = ast.sx; ss.sy = ast.sy; ss.x = ast.x; ss.y = ast.y;
      ss.angle = angle; ss.asteroidId = ast.id; ss.asteroidClass = cls;
      ss.shipBays = shipBays; ss.expandedBays = expandedBays;
      ss.spiderBays = spiderBays; ss.nextShipBay = 0; ss.nextSpiderBay = 0;
      this.state.structures.set(id, ss);

      // builder ocupa a primeira vaga da estação recém-construída
      ship.hqId = id;
      ship.bay = 0;
      ship.anchored = true;
      ship.anchoredAsteroidId = "";
      ship.landingPhase = "";
      ship.sx = ast.sx; ship.sy = ast.sy; ship.x = ast.x; ship.y = ast.y;
      console.log(`[room] ${sessionId} construiu miningStation (via pouso) em ${cls} — builder na vaga 0`);
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
        shipBays, expandedBays, spiderBays: 0, nextShipBay: 0, nextSpiderBay: 0, mineBuffer: 0,
      });
      const ss = new StructureSchema();
      ss.stype = "hq"; ss.owner = sessionId;
      ss.sx = ast.sx; ss.sy = ast.sy; ss.x = ast.x; ss.y = ast.y;
      ss.angle = angle; ss.asteroidId = ast.id; ss.asteroidClass = cls;
      ss.shipBays = shipBays; ss.expandedBays = expandedBays;
      ss.spiderBays = 0; ss.nextShipBay = 0; ss.nextSpiderBay = 0;
      this.state.structures.set(id, ss);
      ship.hqId = id;
      ship.bay = 0;
      ship.anchored = true;
      ship.anchoredAsteroidId = "";
      ship.landingPhase = "";
      ship.sx = ast.sx; ship.sy = ast.sy; ship.x = ast.x; ship.y = ast.y;
      console.log(`[room] ${sessionId} construiu hq (via pouso) em ${cls}`);
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

  /**
   * Requisita um táxi: despacha uma nave guardada no hangar próprio mais
   * próximo para a estrutura onde o jogador está ancorado, se houver vaga lá.
   */
  private tryTaxi(sessionId: string, shipId?: string): void {
    const active = this.activeShipOf(sessionId);
    if (!active || !active.anchored) return;
    // táxi só está disponível ancorado numa ESTAÇÃO DE MINERAÇÃO própria
    const dest = this.nearestOwnStructure(sessionId, active, DOCK_RANGE, "miningStation");
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
    if (this.firstFreeShipBay(dest, "builder", true) < 0) return; // estação sem vaga (conta em trânsito)

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
   * `kind` filtra por compatibilidade: mining só cabe em vaga expandida.
   * `countTransit` inclui táxis a caminho na contagem de capacidade.
   */
  private firstFreeShipBay(struct: Structure, kind: "builder" | "mining" | "attack" = "builder", countTransit = false): number {
    const taken = new Set<number>();
    let transit = 0;
    for (const s of this.sim.ships.values()) {
      if (s.hqId === struct.id && (s.stored || s.anchored) && s.bay >= 0) taken.add(s.bay);
      if (countTransit && s.taxiTo === struct.id) transit++;
    }
    // vagas expandidas: índices 0..expandedBays-1
    // vagas normais:    índices expandedBays..shipBays-1
    const end = kind === "mining" ? struct.expandedBays : struct.shipBays;
    for (let i = 0; i < end; i++) {
      if (!taken.has(i)) return i;
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

  /** Tira uma nave do hangar e a posiciona ancorada NA posição da estrutura. */
  private deployFromHangar(
    ship: ShipState,
    struct: { id: string; sx: number; sy: number; x: number; y: number },
  ): void {
    ship.stored = false;
    ship.anchored = true;
    ship.sx = struct.sx;
    ship.sy = struct.sy;
    ship.x = struct.x;
    ship.y = struct.y;
    ship.vx = 0;
    ship.vy = 0;
  }

  /** Estrutura própria MAIS PRÓXIMA (opcionalmente de um tipo) dentro de `range`. */
  private nearestOwnStructure(
    sessionId: string,
    from: ShipState,
    range: number,
    type?: "hq" | "miningStation",
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
      mineBuffer: 0,
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

    // builder ocupa a primeira vaga da estrutura recém-construída
    const activeShip = this.activeShipOf(sessionId);
    if (activeShip) {
      activeShip.hqId = id;
      activeShip.bay = 0;
      activeShip.anchored = true;
      activeShip.anchoredAsteroidId = "";
      activeShip.landingPhase = "";
      activeShip.sx = ast.sx; activeShip.sy = ast.sy;
      activeShip.x = ast.x; activeShip.y = ast.y;
      activeShip.vx = 0; activeShip.vy = 0;
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

    // capacidade = vagas de nave do QG (pela classe do asteroide)
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
        // se pousando em estrutura, atualiza o target para acompanhar a rotação do asteroide
        if (ship.hqId) {
          const struct = this.sim.structures.get(ship.hqId);
          if (struct) {
            const bayPos = this.bayWorldPos(struct, ship.bay);
            ship.landingTargetX = bayPos.x;
            ship.landingTargetY = bayPos.y;
          }
        }
        ship.x = ship.landingOriginX + (ship.landingTargetX - ship.landingOriginX) * t;
        ship.y = ship.landingOriginY + (ship.landingTargetY - ship.landingOriginY) * t;
        ship.vx = 0; ship.vy = 0;
        if (t >= 1) {
          if (ship.hqId) {
            // pouso em estrutura própria: finaliza como ancorado na posição da vaga
            ship.landingPhase = "";
            ship.anchored = true;
            ship.anchoredAsteroidId = "";
            const struct = this.sim.structures.get(ship.hqId);
            if (struct) {
              ship.sx = struct.sx; ship.sy = struct.sy;
              // mantém a posição da vaga (landingTargetX/Y) em vez de mover para o centro
              ship.x = ship.landingTargetX;
              ship.y = ship.landingTargetY;
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
    // BUILDER minerando na estação: acumula no buffer (junto com as aranhas)
    for (const ship of this.sim.ships.values()) {
      if (!ship.anchored || !ship.mining || ship.kind !== "builder") continue;
      const station = this.sim.structures.get(ship.hqId);
      if (!station || station.type !== "miningStation") continue;
      if (station.mineBuffer >= STATION_MINE_BUFFER) { ship.mining = false; continue; }
      const rate = MINING_RATE_BY_KIND["builder"];
      station.mineBuffer = Math.min(STATION_MINE_BUFFER, station.mineBuffer + rate * dt);
    }
    // ARANHAS mineradoras → caminham pelo asteroide e descarregam na estação
    for (const [id, spider] of this.spiders) {
      const ship = this.sim.ships.get(id);
      const station = ship ? this.sim.structures.get(ship.stationId) : undefined;
      if (!ship || !station) {
        this.spiders.delete(id);
        continue;
      }
      // aranha para quando o buffer da estação está cheio
      if (station.mineBuffer >= STATION_MINE_BUFFER) {
        ship.mining = false;
        continue;
      }
      const unloaded = stepSpider(ship, station, spider, dt);
      if (unloaded > 0) {
        station.mineBuffer = Math.min(STATION_MINE_BUFFER, station.mineBuffer + unloaded);
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
        const freeBay = this.firstFreeShipBay(dest);
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
      s.mineBuffer = st.mineBuffer;
    }
    // minério e nave ativa por jogador
    for (const [sid, p] of this.state.players) {
      p.ore = this.sim.getOre(sid);
      p.activeShip = this.activeShip.get(sid) ?? "";
    }
  }
}
