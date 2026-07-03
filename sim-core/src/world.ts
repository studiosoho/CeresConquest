import {
  MINING_RANGE,
  MINING_RATE,
  NEUTRAL_INPUT,
  STRUCTURE_SPECS,
  relVec,
  type ShipInput,
  type WorldPos,
} from "@ceres/shared";
import { makeShip, stepShip, type ShipState } from "./ship";
import { sectorAsteroids, type Asteroid } from "./procgen";
import { collideShip, clampToBoundary } from "./collision";
import type { Structure } from "./structures";

/**
 * Mundo de simulação: puro, sem rede, sem engine, sem I/O.
 * O servidor roda a instância autoritativa; o cliente pode rodar uma
 * instância local para predição.
 */
export class SimWorld {
  readonly seed: number;
  readonly ships = new Map<string, ShipState>();
  readonly structures = new Map<string, Structure>();
  private readonly inputs = new Map<string, ShipInput>();
  private boundaryCenter: WorldPos | null = null;
  private boundaryRadius = 0;

  constructor(seed: number) {
    this.seed = seed;
  }

  /** Define a fronteira circular do mapa (centro + raio em unidades). */
  setBoundary(center: WorldPos, radiusUnits: number): void {
    this.boundaryCenter = { ...center };
    this.boundaryRadius = radiusUnits;
  }

  addShip(id: string, pos: WorldPos, owner = "", kind: ShipState["kind"] = "starter"): ShipState {
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

  tick(dt: number): void {
    for (const [id, ship] of this.ships) {
      const input = this.inputs.get(id) ?? NEUTRAL_INPUT;
      stepShip(ship, input, dt);
      collideShip(ship, this.seed);
      if (this.boundaryCenter) clampToBoundary(ship, this.boundaryCenter, this.boundaryRadius);
      ship.mining = false;
      if (input.mine) {
        const target = this.nearestAsteroid(ship);
        if (target) {
          ship.ore += MINING_RATE * dt;
          ship.mining = true;
        }
      }
    }

    // estruturas autônomas produzem minério para o dono
    for (const st of this.structures.values()) {
      const rate = STRUCTURE_SPECS[st.type].productionRate;
      if (rate <= 0) continue;
      const owner = this.ships.get(st.owner);
      if (owner) owner.ore += rate * dt;
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
