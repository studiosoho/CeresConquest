import { Room, type Client } from "colyseus";
import {
  MSG_INPUT,
  MSG_BUILD,
  MSG_PRODUCE,
  MSG_ANCHOR,
  TICK_RATE,
  SECTOR_SIZE,
  MAP_SIZES,
  DEFAULT_MAP_SIZE,
  STRUCTURE_SPECS,
  SHIP_PRODUCTION,
  HANGAR_CAP,
  DOCK_RANGE,
  BUILD_ASTEROID_RANGE,
  relVec,
  dist,
  normalizePos,
  type MapSize,
  type ShipInput,
  type BuildCommand,
  type ProduceCommand,
} from "@ceres/shared";
import { SimWorld, findClearSpawn, type ShipState } from "@ceres/sim-core";
import { MatchState, ShipSchema, StructureSchema } from "../schema/State";
import { mapSpawns, beltBasePoint, type SpawnStrategy } from "../spawn";
import { computeBotInput, makeBotState, type BotState } from "../bots";

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
      this.sim.setInput(client.sessionId, input);
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

    this.setSimulationInterval((deltaMs) => this.tick(deltaMs / 1000), 1000 / TICK_RATE);
    console.log(
      `[room] match criada — seed=${seed} mapa=${mapSize}(${radiusSectors}s) ` +
        `maxPlayers=${this.maxClients} bots=${botCount}`,
    );
  }

  onJoin(client: Client) {
    const base = this.spawns[this.spawnIndex++ % this.spawns.length];
    const ship = this.spawnShip(client.sessionId, base, client.sessionId, "builder");
    // espelha a posição de spawn JÁ no join — o primeiro estado que o
    // cliente recebe precisa ser real, não os defaults do schema
    this.state.ships.set(client.sessionId, this.mirrorSpawn(ship));
    console.log(`[room] ${client.sessionId} entrou — setor (${ship.sx}, ${ship.sy})`);
  }

  onLeave(client: Client) {
    // remove a frota inteira do jogador (nave inicial + naves produzidas)
    for (const [id, ship] of [...this.sim.ships]) {
      if (id === client.sessionId || ship.owner === client.sessionId) {
        this.sim.removeShip(id);
        this.bots.delete(id);
        this.state.ships.delete(id);
      }
    }
    console.log(`[room] ${client.sessionId} saiu`);
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

  /** Alterna a ancoragem: só ancora se estiver perto do próprio QG. */
  private tryToggleAnchor(sessionId: string): void {
    const ship = this.sim.ships.get(sessionId);
    if (!ship) return;
    if (ship.anchored) {
      ship.anchored = false;
      return;
    }
    if (this.nearestOwnHq(sessionId, ship, DOCK_RANGE)) ship.anchored = true;
  }

  /** QG do jogador dentro de `range` da nave (ou null). */
  private nearestOwnHq(sessionId: string, from: ShipState, range: number) {
    for (const st of this.sim.structures.values()) {
      if (st.owner === sessionId && st.type === "hq" && dist(from, st) <= range) return st;
    }
    return null;
  }

  /** Valida e constrói uma estrutura, encostada na borda do asteroide mais próximo. */
  private tryBuild(sessionId: string, type?: BuildCommand["type"]): void {
    const ship = this.sim.ships.get(sessionId);
    if (!ship || !type) return;
    const spec = STRUCTURE_SPECS[type];
    if (!spec || ship.ore < spec.cost) return;

    // ambos (QG e estação) fixam-se na borda de um asteroide próximo
    const ast = this.sim.nearestAsteroid(ship, BUILD_ASTEROID_RANGE);
    if (!ast) return;

    // ponto na borda, no lado voltado para a nave, com a estrutura orientada para fora
    const { dx, dy } = relVec(ast, ship);
    const d = Math.hypot(dx, dy) || 1;
    const nx = dx / d;
    const ny = dy / d;
    const off = ast.radius + spec.radius * 0.5;
    const pos = { sx: ast.sx, sy: ast.sy, x: ast.x + nx * off, y: ast.y + ny * off };
    normalizePos(pos);
    const angle = Math.atan2(ny, nx);

    ship.ore -= spec.cost;
    const id = `st-${this.structSeq++}`;
    this.sim.addStructure({ id, type, owner: sessionId, sx: pos.sx, sy: pos.sy, x: pos.x, y: pos.y, angle });

    const ss = new StructureSchema();
    ss.stype = type;
    ss.owner = sessionId;
    ss.sx = pos.sx;
    ss.sy = pos.sy;
    ss.x = pos.x;
    ss.y = pos.y;
    ss.angle = angle;
    this.state.structures.set(id, ss);
    console.log(`[room] ${sessionId} construiu ${type} na borda de asteroide — setor (${pos.sx}, ${pos.sy})`);
  }

  /** Fabrica uma nave — só com a nave ancorada no QG e respeitando o hangar. */
  private tryProduce(sessionId: string, kind?: ProduceCommand["kind"]): void {
    const pilot = this.sim.ships.get(sessionId);
    if (!pilot || !kind) return;
    const spec = SHIP_PRODUCTION[kind];
    if (!spec || pilot.ore < spec.cost) return;
    if (!pilot.anchored) return; // precisa estar ancorado no QG

    const hq = this.nearestOwnHq(sessionId, pilot, DOCK_RANGE);
    if (!hq) return;

    // hangar: no máximo HANGAR_CAP naves de cada tipo por jogador
    let count = 0;
    for (const s of this.sim.ships.values()) {
      if (s.owner === sessionId && s.kind === kind) count++;
    }
    if (count >= HANGAR_CAP) return;

    pilot.ore -= spec.cost;
    const id = `sh-${this.shipSeq++}`;
    const ship = this.spawnShip(id, hq, sessionId, kind);
    this.bots.set(id, makeBotState()); // pilotagem autônoma por enquanto
    this.state.ships.set(id, this.mirrorSpawn(ship));
    console.log(`[room] ${sessionId} fabricou ${kind} no QG — setor (${ship.sx}, ${ship.sy})`);
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
    return s;
  }

  private tick(dt: number) {
    // IA dos bots → input no mesmo pipeline dos humanos
    for (const [id, bot] of this.bots) {
      const ship = this.sim.ships.get(id);
      if (ship) this.sim.setInput(id, computeBotInput(ship, this.sim, bot, dt));
    }
    this.sim.tick(dt);
    // espelha sim-core → schema (delta-encoding fica por conta do Colyseus)
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
      s.ore = ship.ore;
      s.mining = ship.mining;
      s.anchored = ship.anchored;
    }
  }
}
