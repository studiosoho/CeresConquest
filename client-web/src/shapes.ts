import { SHIP_RADIUS, type ShipKind } from "@ceres/shared";

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

/**
 * Nave de transporte: contêiner longo com cabine estreita na frente —
 * um caminhão espacial, feito para o porão, não para a briga.
 */
const TRANSPORT_VERTS: Array<{ x: number; y: number }> = [
  { x: R * 1.05, y: 0 },
  { x: R * 0.75, y: R * 0.3 },
  { x: R * 0.45, y: R * 0.3 },
  { x: R * 0.35, y: R * 0.6 },
  { x: -R * 0.95, y: R * 0.6 },
  { x: -R * 0.95, y: -R * 0.6 },
  { x: R * 0.35, y: -R * 0.6 },
  { x: R * 0.45, y: -R * 0.3 },
  { x: R * 0.75, y: -R * 0.3 },
];

/** Vértices da nave conforme a classe. */
export function shipVerts(kind: ShipKind): Array<{ x: number; y: number }> {
  if (kind === "attack") return ATTACK_VERTS;
  if (kind === "mining") return MINING_VERTS;
  if (kind === "transport") return TRANSPORT_VERTS;
  return BUILDER_VERTS; // builder
}

/** Velocidade angular normalizada [-1,1] da rotação leve de um asteroide. */
// fonte única no shared — o servidor usa a MESMA função (nave pousada
// gira em sincronia com o visual do asteroide)
export { asteroidSpin } from "@ceres/shared";

// A silhueta 2D de asteroide (asteroidVerts) foi substituída pela malha 3D
// determinística de render/AsteroidMeshGenerator.ts — mesma invariante de
// normalização (silhueta XY máxima = radius, coerente com a colisão).
