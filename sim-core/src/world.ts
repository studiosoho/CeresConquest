import {
  MINING_RANGE,
  MINING_RATE_BY_KIND,
  NEUTRAL_INPUT,
  STRUCTURE_SPECS,
  TAXI_SPEED_MULT,
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
  /** minério por jogador (sessionId → quantidade) */
  readonly playerOre = new Map<string, number>();
  private readonly inputs = new Map<string, ShipInput>();
  private boundaryCenter: WorldPos | null = null;
  private boundaryRadius = 0;

  constructor(seed: number) {
    this.seed = seed;
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

  tick(dt: number): void {
    const passthrough = this.occupiedAsteroids();
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
        ship.vx = 0;
        ship.vy = 0;
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
      // ancorada: congelada no QG (não se move, não minera)
      if (ship.anchored) {
        ship.vx = 0;
        ship.vy = 0;
        ship.mining = false;
        continue;
      }
      // aranha (auto-mineração): movida pela lógica da estação, fora da física
      if (ship.autoMining) continue;
      const input = this.inputs.get(id) ?? NEUTRAL_INPUT;
      // em taxiamento: dobro da velocidade e sem colisão (caminho reto)
      const isTaxi = !!ship.taxiTo;
      stepShip(ship, input, dt, isTaxi ? TAXI_SPEED_MULT : 1);
      if (!isTaxi) collideShip(ship, this.seed, passthrough);
      if (this.boundaryCenter) clampToBoundary(ship, this.boundaryCenter, this.boundaryRadius);
      // em voo livre não se minera — mineração só pousado ou via aranhas
      ship.mining = false;
    }

    // estruturas autônomas produzem minério para o dono
    for (const st of this.structures.values()) {
      const rate = STRUCTURE_SPECS[st.type].productionRate;
      if (rate > 0) this.addOre(st.owner, rate * dt);
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
