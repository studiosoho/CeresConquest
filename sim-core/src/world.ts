import {
  MINING_RANGE,
  MINING_RATE,
  NEUTRAL_INPUT,
  relVec,
  type ShipInput,
  type WorldPos,
} from "@ceres/shared";
import { makeShip, stepShip, type ShipState } from "./ship";
import { sectorAsteroids, type Asteroid } from "./procgen";
import { collideShip } from "./collision";

/**
 * Mundo de simulação: puro, sem rede, sem engine, sem I/O.
 * O servidor roda a instância autoritativa; o cliente pode rodar uma
 * instância local para predição.
 */
export class SimWorld {
  readonly seed: number;
  readonly ships = new Map<string, ShipState>();
  private readonly inputs = new Map<string, ShipInput>();

  constructor(seed: number) {
    this.seed = seed;
  }

  addShip(id: string, pos: WorldPos): ShipState {
    const ship = makeShip(pos);
    this.ships.set(id, ship);
    return ship;
  }

  removeShip(id: string): void {
    this.ships.delete(id);
    this.inputs.delete(id);
  }

  setInput(id: string, input: ShipInput): void {
    this.inputs.set(id, input);
  }

  tick(dt: number): void {
    for (const [id, ship] of this.ships) {
      const input = this.inputs.get(id) ?? NEUTRAL_INPUT;
      stepShip(ship, input, dt);
      collideShip(ship, this.seed);
      ship.mining = false;
      if (input.mine) {
        const target = this.nearestAsteroid(ship);
        if (target) {
          ship.ore += MINING_RATE * dt;
          ship.mining = true;
        }
      }
    }
  }

  /** Asteroide minerável mais próximo da nave (borda dentro de MINING_RANGE). */
  nearestAsteroid(pos: WorldPos): Asteroid | null {
    let best: Asteroid | null = null;
    let bestDist = MINING_RANGE;
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
