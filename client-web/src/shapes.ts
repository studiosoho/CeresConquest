import { SHIP_RADIUS, mulberry32, type StructureType, type ShipKind } from "@ceres/shared";

/**
 * Geometria wireframe (estilo Asteroids): assets são listas de vértices,
 * derivadas de sementes e da escala de tamanhos — nunca imagens. A mesma
 * definição servirá ao renderer 3D do desktop.
 */

const R = SHIP_RADIUS;

/** Nave inicial/scout: triângulo com entalhe traseiro, apontando para +x. */
export const SHIP_VERTS: Array<{ x: number; y: number }> = [
  { x: R, y: 0 },
  { x: -R * 0.66, y: R * 0.55 },
  { x: -R * 0.33, y: 0 },
  { x: -R * 0.66, y: -R * 0.55 },
];

/**
 * Builder "feijão": silhueta oval arredondada com cabine saliente na frente.
 * Mais rechonchuda que o scout — transmite utilidade, não velocidade.
 */
const BUILDER_VERTS: Array<{ x: number; y: number }> = [
  { x: R * 1.0, y: 0 },
  { x: R * 0.7, y: R * 0.45 },
  { x: R * 0.1, y: R * 0.7 },
  { x: -R * 0.5, y: R * 0.65 },
  { x: -R * 0.9, y: R * 0.3 },
  { x: -R * 0.9, y: -R * 0.3 },
  { x: -R * 0.5, y: -R * 0.65 },
  { x: R * 0.1, y: -R * 0.7 },
  { x: R * 0.7, y: -R * 0.45 },
];

/** Nave de ataque: silhueta mais larga e agressiva (asas). */
const ATTACK_VERTS: Array<{ x: number; y: number }> = [
  { x: R * 1.15, y: 0 },
  { x: -R * 0.3, y: R * 0.4 },
  { x: -R * 0.7, y: R * 0.85 },
  { x: -R * 0.45, y: 0 },
  { x: -R * 0.7, y: -R * 0.85 },
  { x: -R * 0.3, y: -R * 0.4 },
];

/** Nave de mineração: silhueta atarracada de carga. */
const MINING_VERTS: Array<{ x: number; y: number }> = [
  { x: R * 0.8, y: 0 },
  { x: R * 0.2, y: R * 0.6 },
  { x: -R * 0.7, y: R * 0.5 },
  { x: -R * 0.7, y: -R * 0.5 },
  { x: R * 0.2, y: -R * 0.6 },
];

/** Vértices da nave conforme a classe. */
export function shipVerts(kind: ShipKind): Array<{ x: number; y: number }> {
  if (kind === "attack") return ATTACK_VERTS;
  if (kind === "mining") return MINING_VERTS;
  return BUILDER_VERTS; // builder
}

/** Velocidade angular normalizada [-1,1] da rotação leve de um asteroide. */
// fonte única no shared — o servidor usa a MESMA função (nave pousada
// gira em sincronia com o visual do asteroide)
export { asteroidSpin } from "@ceres/shared";

/**
 * Silhueta de asteroide em formato "batata", determinística pela shapeSeed:
 * alongamento (aspect) + duas protuberâncias de baixa frequência + pequeno
 * ruído por vértice. Normalizada para que o raio máximo seja exatamente
 * `radius` — mantém coerência com a colisão/mineração do sim-core.
 */
export function asteroidVerts(
  shapeSeed: number,
  radius: number,
): Array<{ x: number; y: number }> {
  const rng = mulberry32(shapeSeed);
  const n = 10 + Math.floor(rng() * 7); // 10–16 vértices

  // alongamento tipo batata, distribuído entre os dois eixos
  const aspect = 1 + rng() * 1.0; // 1.0 – 2.0
  const sx = Math.sqrt(aspect);
  const sy = 1 / sx;
  const rot = rng() * Math.PI * 2;

  // duas ondas de baixa frequência dão a lombada irregular da batata
  const a1 = 0.12 + rng() * 0.18;
  const p1 = rng() * Math.PI * 2;
  const k1 = 2 + Math.floor(rng() * 2); // 2–3
  const a2 = 0.04 + rng() * 0.1;
  const p2 = rng() * Math.PI * 2;
  const k2 = 4 + Math.floor(rng() * 3); // 4–6

  const raw: Array<{ x: number; y: number }> = [];
  let maxD = 0;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const rr =
      1 + a1 * Math.sin(k1 * t + p1) + a2 * Math.sin(k2 * t + p2) + (rng() - 0.5) * 0.08;
    const px = Math.cos(t) * rr * sx;
    const py = Math.sin(t) * rr * sy;
    const cx = px * Math.cos(rot) - py * Math.sin(rot);
    const cy = px * Math.sin(rot) + py * Math.cos(rot);
    const d = Math.hypot(cx, cy);
    if (d > maxD) maxD = d;
    raw.push({ x: cx, y: cy });
  }

  const k = radius / maxD; // normaliza para bounding = radius
  return raw.map((v) => ({ x: v.x * k, y: v.y * k }));
}

/** Silhueta geométrica de uma estrutura, reconhecível pelo contorno. */
export function structureVerts(
  type: StructureType,
  radius: number,
): Array<{ x: number; y: number }> {
  if (type === "hq") {
    // losango (quadrado a 45°) — o quartel-general
    return [
      { x: 0, y: -radius },
      { x: radius, y: 0 },
      { x: 0, y: radius },
      { x: -radius, y: 0 },
    ];
  }
  // estação de mineração: hexágono
  const verts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    verts.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius });
  }
  return verts;
}
