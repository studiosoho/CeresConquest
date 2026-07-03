import { mulberry32 } from "@ceres/shared";

/**
 * Geometria wireframe (estilo Asteroids): assets são listas de vértices,
 * derivadas de sementes — nunca imagens. A mesma definição servirá ao
 * renderer 3D do desktop.
 */

/** Nave: triângulo com entalhe traseiro, apontando para +x. */
export const SHIP_VERTS: Array<{ x: number; y: number }> = [
  { x: 18, y: 0 },
  { x: -12, y: 10 },
  { x: -6, y: 0 },
  { x: -12, y: -10 },
];

/** Silhueta lascada de asteroide, determinística pela shapeSeed. */
export function asteroidVerts(
  shapeSeed: number,
  radius: number,
): Array<{ x: number; y: number }> {
  const rng = mulberry32(shapeSeed);
  const n = 8 + Math.floor(rng() * 5); // 8–12 vértices
  const verts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) {
    const theta = (i / n) * Math.PI * 2;
    const r = radius * (0.7 + rng() * 0.45);
    verts.push({ x: Math.cos(theta) * r, y: Math.sin(theta) * r });
  }
  return verts;
}
