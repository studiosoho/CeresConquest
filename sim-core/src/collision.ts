import {
  SHIP_RADIUS,
  SECTOR_SIZE,
  relVec,
  normalizePos,
  type WorldPos,
} from "@ceres/shared";
import { sectorAsteroids } from "./procgen";

/** Qualquer corpo móvel com posição + velocidade (a nave, por ora). */
export interface Body extends WorldPos {
  vx: number;
  vy: number;
}

/**
 * Colisão nave × asteroides, determinística e pura — roda idêntica no servidor
 * (autoritativo) e na predição do cliente. Trata cada asteroide como círculo
 * de raio `a.radius` (a silhueta batata está inscrita nele). Empurra a nave
 * para fora e remove a componente de velocidade que aponta para dentro
 * (deslizamento ao longo da superfície).
 *
 * `passthrough`: ids de asteroides SEM colisão (os que hospedam estruturas) —
 * a nave os atravessa para alcançar a estrutura no interior.
 */
export function collideShip(
  ship: Body,
  seed: number,
  passthrough?: ReadonlySet<string>,
): void {
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      for (const a of sectorAsteroids(seed, ship.sx + ox, ship.sy + oy)) {
        if (passthrough?.has(a.id)) continue;
        const { dx, dy } = relVec(a, ship); // do centro do asteroide até a nave
        const d = Math.hypot(dx, dy);
        const minDist = a.radius + SHIP_RADIUS;
        if (d >= minDist) continue;

        // normal de saída; se a nave estiver exatamente no centro, empurra em +x
        let nx = 1;
        let ny = 0;
        let dd = 0;
        if (d > 1e-6) {
          nx = dx / d;
          ny = dy / d;
          dd = d;
        }
        const penetration = minDist - dd;
        ship.x += nx * penetration;
        ship.y += ny * penetration;

        const vn = ship.vx * nx + ship.vy * ny;
        if (vn < 0) {
          ship.vx -= vn * nx;
          ship.vy -= vn * ny;
        }
      }
    }
  }
  normalizePos(ship);
}

/**
 * Fronteira do mapa: mantém a nave dentro de um raio a partir do centro da
 * arena. Empurra de volta e remove a velocidade que aponta para fora.
 * Pura e determinística — roda no servidor e na predição do cliente.
 */
export function clampToBoundary(ship: Body, center: WorldPos, radiusUnits: number): void {
  const { dx, dy } = relVec(center, ship);
  const d = Math.hypot(dx, dy);
  if (d <= radiusUnits || d === 0) return;

  const nx = dx / d;
  const ny = dy / d;
  const pen = d - radiusUnits;
  ship.x -= nx * pen;
  ship.y -= ny * pen;

  const vn = ship.vx * nx + ship.vy * ny; // componente para fora
  if (vn > 0) {
    ship.vx -= vn * nx;
    ship.vy -= vn * ny;
  }
  normalizePos(ship);
}

/** Folga (dist. à superfície do asteroide mais próximo) num ponto local do setor. */
function clearanceAt(seed: number, sx: number, sy: number, x: number, y: number): number {
  const point: WorldPos = { sx, sy, x, y };
  let minClear = Infinity;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      for (const a of sectorAsteroids(seed, sx + ox, sy + oy)) {
        const { dx, dy } = relVec(a, point);
        const clear = Math.hypot(dx, dy) - a.radius - SHIP_RADIUS;
        if (clear < minClear) minClear = clear;
      }
    }
  }
  return minClear;
}

/**
 * Acha uma posição local livre de asteroides no setor para spawn. Varre uma
 * grade de candidatos e devolve o primeiro com folga confortável; se o setor
 * estiver cheio, devolve o de maior folga (melhor esforço).
 */
export function findClearSpawn(seed: number, sx: number, sy: number): { x: number; y: number } {
  const PREFERRED = SHIP_RADIUS * 3;
  const N = 8;
  let best = { x: SECTOR_SIZE / 2, y: SECTOR_SIZE / 2 };
  let bestClear = -Infinity;
  for (let iy = 0; iy < N; iy++) {
    for (let ix = 0; ix < N; ix++) {
      const x = ((ix + 0.5) / N) * SECTOR_SIZE;
      const y = ((iy + 0.5) / N) * SECTOR_SIZE;
      const clear = clearanceAt(seed, sx, sy, x, y);
      if (clear > bestClear) {
        bestClear = clear;
        best = { x, y };
      }
      if (clear >= PREFERRED) return { x, y };
    }
  }
  return best;
}
