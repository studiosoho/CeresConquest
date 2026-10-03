import { CERES_RADIUS, ceresPosition, relVec, type WorldPos } from "@ceres/shared";
import { sectorAsteroids } from "./procgen";

/**
 * O corpo (Ceres ou uma rocha) sob o ponto `p`, ou null no vácuo. É onde a
 * minhoca viaja ENTERRADA (shared/worms.ts); fora de todo corpo ela está
 * saltando, exposta. Servidor (dano, colisão) e cliente (altura de cada gomo)
 * usam a mesma conta.
 */
export interface WormBody {
  /** "ceres" ou o id do asteroide */
  id: string;
  center: WorldPos;
  radius: number;
  /** distância do ponto ao centro do corpo */
  d: number;
}

export function wormBodyAt(seed: number, p: WorldPos): WormBody | null {
  const c = ceresPosition(seed);
  const rc = relVec(p, c);
  const dc = Math.hypot(rc.dx, rc.dy);
  if (dc < CERES_RADIUS) return { id: "ceres", center: c, radius: CERES_RADIUS, d: dc };
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      for (const a of sectorAsteroids(seed, p.sx + ox, p.sy + oy)) {
        const { dx, dy } = relVec(p, a);
        const d = Math.hypot(dx, dy);
        if (d < a.radius) return { id: a.id, center: a, radius: a.radius, d };
      }
    }
  }
  return null;
}
