import { Room, type Client } from "colyseus";
import {
  MSG_INPUT,
  MSG_BUILD,
  MSG_PRODUCE,
  MSG_ANCHOR,
  MSG_SWAP,
  MSG_AUTOMINE,
  MSG_TAXI,
  TICK_RATE,
  SECTOR_SIZE,
  MAP_SIZES,
  DEFAULT_MAP_SIZE,
  STRUCTURE_SPECS,
  SHIP_PRODUCTION,
  HANGAR_CAP,
  STATION_MINING_CAP,
  STATION_HANGAR_CAP,
  DOCK_RANGE,
  BUILD_ASTEROID_RANGE,
  relVec,
  dist,
  type MapSize,
  type ShipInput,
  type BuildCommand,
  type ProduceCommand,
  type TaxiCommand,
} from "@ceres/shared";
import { SimWorld, findClearSpawn, type ShipState } from "@ceres/sim-core";
import { MatchState, ShipSchema, StructureSchema, PlayerSchema } from "../schema/State";
import { mapSpawns, beltBasePoint, type SpawnStrategy } from "../spawn";
import {
  computeBotInput,
  computeMinerInput,
  computeTaxiInput,
  makeBotState,
  type BotState,
} from "../bots";

/** Nº de jogadores-teste autônomos (bots) por padrão. */
const DEFAULT_BOTS = 10;

export interface MatchOptions {
  maxPlayers?: number;
  worldSeed?: number;
  spawnStrategy?: SpawnStrategy;
  mapSize?: MapSize;
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

  onCreate(options: MatchOptions = {}) {
    this.maxClients = options.maxPlayers ?? 12;
    const botCount = options.bots ?? DEFAULT_BOTS;
    const mapSize = options.mapSize ?? DEFAULT_MAP_SIZE;
    const radiusSectors = MAP_SIZES[mapSize].radiusSectors;
    const seed = options.worldSeed ?? (Math.random() * 0xffffffff) >>> 0;

    this.sim = new SimWorld(seed);
    // spawns em setores distintos do cinturão dentro da arena do mapa
    this.spawns = mapSpawns(seed, radiusSectors, this.maxClients + botCount);

    // fronteira circular: centro no ponto base do cinturão, raio pelo tamanho
    const base = beltBasePoint(seed);
    const center = { sx: base.sx, sy: base.sy, x: SECTOR_SIZE / 2, y: SECTOR_SIZE / 2 };
    const radiusUnits = radiusSectors * SECTOR_SIZE;
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

    this.setSimulationInterval((deltaMs) => this.tick(deltaMs / 1000), 1000 / TICK_RATE);
    console.log(
      `[room] match criada — seed=${seed} mapa=${mapSize}(${radiusSectors}s) ` +
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

  /** Alterna a ancoragem da nave ativa: ancora se estiver perto de uma estrutura própria. */
  private tryToggleAnchor(sessionId: string): void {
    const ship = this.activeShipOf(sessionId);
    if (!ship) return;
    if (ship.anchored) {
      ship.anchored = false;
      return;
    }
    if (this.nearestOwnStructure(sessionId, ship, DOCK_RANGE)) ship.anchored = true;
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

  /** Configura a mineradora ancorada numa estação para minerar sozinha. */
  private tryAutoMine(sessionId: string): void {
    const active = this.activeShipOf(sessionId);
    if (!active || active.kind !== "mining" || !active.anchored) return;
    const station = this.nearestOwnStructure(sessionId, active, DOCK_RANGE, "miningStation");
    if (!station) return;

    // capacidade: no máximo STATION_MINING_CAP mineradoras por estação
    let count = 0;
    for (const s of this.sim.ships.values()) {
      if (s.autoMining && s.stationId === station.id) count++;
    }
    if (count >= STATION_MINING_CAP) return;

    // transfere o controle para outra nave ANTES de largar a mineradora
    const activeId = this.activeShip.get(sessionId)!;
    if (!this.transferControl(sessionId, activeId)) return; // não pode ficar sem nave

    active.autoMining = true;
    active.stationId = station.id;
    active.anchored = false;
    console.log(`[room] ${sessionId} configurou auto-mineração em ${station.id}`);
  }

  /**
   * Requisita um táxi: despacha uma nave guardada no hangar próprio mais
   * próximo para a estrutura onde o jogador está ancorado, se houver vaga lá.
   */
  private tryTaxi(sessionId: string, shipId?: string): void {
    const active = this.activeShipOf(sessionId);
    if (!active || !active.anchored) return;
    const dest = this.nearestOwnStructure(sessionId, active, DOCK_RANGE);
    if (!dest) return;

    let best: { id: string; ship: ShipState; src: (typeof dest) } | null = null;

    // nave escolhida pelo jogador (qual nave de qual QG)
    if (shipId) {
      const s = this.sim.ships.get(shipId);
      const src = s ? this.sim.structures.get(s.hqId) : undefined;
      if (s && src && s.owner === sessionId && s.stored && s.hqId !== dest.id) {
        best = { id: shipId, ship: s, src };
      }
    }

    // fallback: nave do hangar próprio mais perto do destino
    if (!best) {
      let bestDist = Infinity;
      for (const [id, s] of this.sim.ships) {
        if (s.owner !== sessionId || !s.stored || s.hqId === dest.id) continue;
        const src = this.sim.structures.get(s.hqId);
        if (!src) continue;
        const d = dist(src, dest);
        if (d < bestDist) {
          bestDist = d;
          best = { id, ship: s, src };
        }
      }
    }
    if (!best) return; // nenhuma nave disponível
    if (!this.hangarHasFreeSlot(sessionId, dest, best.ship.kind)) return; // destino sem vaga

    // despacha: sai do hangar de origem e voa até o destino
    const local = findClearSpawn(this.sim.seed, best.src.sx, best.src.sy);
    best.ship.stored = false;
    best.ship.anchored = false;
    best.ship.taxiTo = dest.id;
    best.ship.sx = best.src.sx;
    best.ship.sy = best.src.sy;
    best.ship.x = local.x;
    best.ship.y = local.y;
    best.ship.vx = 0;
    best.ship.vy = 0;
    console.log(`[room] ${sessionId} táxi: ${best.ship.kind} de ${best.src.id} → ${dest.id}`);
  }

  /** Há vaga no hangar da estrutura para uma nave deste tipo (conta em trânsito)? */
  private hangarHasFreeSlot(
    sessionId: string,
    struct: { id: string; type: "hq" | "miningStation" },
    kind: ShipState["kind"],
  ): boolean {
    let count = 0;
    for (const s of this.sim.ships.values()) {
      if (s.owner !== sessionId) continue;
      const heading = (s.stored && s.hqId === struct.id) || s.taxiTo === struct.id;
      if (!heading) continue;
      if (struct.type === "hq" ? s.kind === kind : true) count++;
    }
    return count < (struct.type === "hq" ? HANGAR_CAP : STATION_HANGAR_CAP);
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
    this.state.structures.set(id, ss);
    console.log(`[room] ${sessionId} construiu ${type} no asteroide ${ast.id}`);
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

    // hangar deste QG: no máximo HANGAR_CAP naves de cada tipo
    let count = 0;
    for (const s of this.sim.ships.values()) {
      if (s.owner === sessionId && s.hqId === hq.id && s.kind === kind) count++;
    }
    if (count >= HANGAR_CAP) return;

    this.sim.spendOre(sessionId, spec.cost);
    const id = `sh-${this.shipSeq++}`;
    const ship = this.spawnShip(id, hq, sessionId, kind);
    ship.hqId = hq.id;
    ship.stored = true; // fica guardada no hangar (3b: mineradora busca estação)
    this.state.ships.set(id, this.mirrorSpawn(ship));
    console.log(`[room] ${sessionId} fabricou ${kind} no hangar do QG ${hq.id}`);
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
    return s;
  }

  private tick(dt: number) {
    // IA dos bots neutros
    for (const [id, bot] of this.bots) {
      const ship = this.sim.ships.get(id);
      if (ship) this.sim.setInput(id, computeBotInput(ship, this.sim, bot, dt));
    }
    // IA das auto-mineradoras → rumam à estação e mineram
    for (const [id, ship] of this.sim.ships) {
      if (!ship.autoMining) continue;
      const station = this.sim.structures.get(ship.stationId);
      if (station) this.sim.setInput(id, computeMinerInput(ship, this.sim, station));
    }
    // IA do táxi → voa até o destino; ao chegar, guarda no hangar de lá
    for (const [id, ship] of this.sim.ships) {
      if (!ship.taxiTo) continue;
      const dest = this.sim.structures.get(ship.taxiTo);
      if (!dest) {
        ship.taxiTo = "";
        continue;
      }
      if (dist(ship, dest) <= DOCK_RANGE) {
        ship.stored = true;
        ship.hqId = ship.taxiTo;
        ship.taxiTo = "";
        ship.anchored = false;
        ship.vx = 0;
        ship.vy = 0;
        this.sim.setInput(id, { thrust: false, turn: 0, mine: false });
        console.log(`[room] táxi chegou: ${ship.kind} guardado em ${ship.hqId}`);
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
      s.autoMining = ship.autoMining;
      s.stationId = ship.stationId;
    }
    // minério e nave ativa por jogador
    for (const [sid, p] of this.state.players) {
      p.ore = this.sim.getOre(sid);
      p.activeShip = this.activeShip.get(sid) ?? "";
    }
  }
}
