import { Room, type Client } from "colyseus";
import {
  MSG_INPUT,
  TICK_RATE,
  SECTOR_SIZE,
  MAP_SIZES,
  DEFAULT_MAP_SIZE,
  type MapSize,
  type ShipInput,
} from "@ceres/shared";
import { SimWorld, findClearSpawn, type ShipState } from "@ceres/sim-core";
import { MatchState, ShipSchema } from "../schema/State";
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

    // popula a partida com jogadores-teste autônomos
    for (let i = 0; i < botCount; i++) {
      const id = `bot-${i}`;
      const ship = this.spawnShip(id, this.spawns[this.maxClients + i]);
      this.state.ships.set(id, this.mirrorSpawn(ship));
      this.bots.set(id, makeBotState());
    }

    this.onMessage(MSG_INPUT, (client: Client, input: ShipInput) => {
      this.sim.setInput(client.sessionId, input);
    });

    this.setSimulationInterval((deltaMs) => this.tick(deltaMs / 1000), 1000 / TICK_RATE);
    console.log(
      `[room] match criada — seed=${seed} mapa=${mapSize}(${radiusSectors}s) ` +
        `maxPlayers=${this.maxClients} bots=${botCount}`,
    );
  }

  onJoin(client: Client) {
    const base = this.spawns[this.spawnIndex++ % this.spawns.length];
    const ship = this.spawnShip(client.sessionId, base);
    // espelha a posição de spawn JÁ no join — o primeiro estado que o
    // cliente recebe precisa ser real, não os defaults do schema
    this.state.ships.set(client.sessionId, this.mirrorSpawn(ship));
    console.log(`[room] ${client.sessionId} entrou — setor (${ship.sx}, ${ship.sy})`);
  }

  onLeave(client: Client) {
    this.sim.removeShip(client.sessionId);
    this.state.ships.delete(client.sessionId);
    console.log(`[room] ${client.sessionId} saiu`);
  }

  /** Cria uma nave no sim num ponto livre dentro do setor de spawn dado. */
  private spawnShip(id: string, base: { sx: number; sy: number }): ShipState {
    const local = findClearSpawn(this.sim.seed, base.sx, base.sy);
    return this.sim.addShip(id, { sx: base.sx, sy: base.sy, x: local.x, y: local.y });
  }

  private mirrorSpawn(ship: ShipState): ShipSchema {
    const s = new ShipSchema();
    s.sx = ship.sx;
    s.sy = ship.sy;
    s.x = ship.x;
    s.y = ship.y;
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
    }
  }
}
