import { Room, type Client } from "colyseus";
import { MSG_INPUT, TICK_RATE, type ShipInput } from "@ceres/shared";
import { SimWorld } from "@ceres/sim-core";
import { MatchState, ShipSchema } from "../schema/State";
import { neighboringSpawns, type SpawnStrategy } from "../spawn";

export interface MatchOptions {
  maxPlayers?: number;
  worldSeed?: number;
  spawnStrategy?: SpawnStrategy;
}

/**
 * Sala do modo partida (início/fim). O SimWorld é a autoridade; o schema
 * Colyseus é só o espelho sincronizado para os clientes.
 */
export class MatchRoom extends Room<MatchState> {
  private sim!: SimWorld;
  private spawns: ReturnType<typeof neighboringSpawns> = [];
  private spawnIndex = 0;

  onCreate(options: MatchOptions = {}) {
    this.maxClients = options.maxPlayers ?? 10;
    const seed = options.worldSeed ?? (Math.random() * 0xffffffff) >>> 0;

    this.sim = new SimWorld(seed);
    // por ora só "neighboring"; outras estratégias entram aqui (plugáveis)
    this.spawns = neighboringSpawns(seed, this.maxClients);

    this.setState(new MatchState());
    this.state.worldSeed = seed;

    this.onMessage(MSG_INPUT, (client: Client, input: ShipInput) => {
      this.sim.setInput(client.sessionId, input);
    });

    this.setSimulationInterval((deltaMs) => this.tick(deltaMs / 1000), 1000 / TICK_RATE);
    console.log(`[room] match criada — seed=${seed} maxPlayers=${this.maxClients}`);
  }

  onJoin(client: Client) {
    const pos = this.spawns[this.spawnIndex++ % this.spawns.length];
    const ship = this.sim.addShip(client.sessionId, pos);
    // espelha a posição de spawn JÁ no join — o primeiro estado que o
    // cliente recebe precisa ser real, não os defaults do schema
    const s = new ShipSchema();
    s.sx = ship.sx;
    s.sy = ship.sy;
    s.x = ship.x;
    s.y = ship.y;
    this.state.ships.set(client.sessionId, s);
    console.log(`[room] ${client.sessionId} entrou — setor (${pos.sx}, ${pos.sy})`);
  }

  onLeave(client: Client) {
    this.sim.removeShip(client.sessionId);
    this.state.ships.delete(client.sessionId);
    console.log(`[room] ${client.sessionId} saiu`);
  }

  private tick(dt: number) {
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
