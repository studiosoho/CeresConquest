import {
  SECTOR_SIZE,
  sectorInBelt,
  hash3,
  mulberry32,
  ASTEROID_MIN_RADIUS,
  ASTEROID_MAX_RADIUS,
} from "@ceres/shared";

/**
 * Asteroide gerado proceduralmente. NUNCA é armazenado nem sincronizado:
 * é recalculável de (seedDoMundo, setor). Só deltas (minerado, colonizado)
 * serão persistidos, em fase futura.
 */
export interface Asteroid {
  id: string;
  sx: number;
  sy: number;
  /** posição local dentro do setor */
  x: number;
  y: number;
  radius: number;
  /** semente da silhueta — o cliente deriva o polígono wireframe dela */
  shapeSeed: number;
}

const MIN_COUNT = 3;
const MAX_COUNT = 8;
/** expoente da distribuição de tamanhos: >1 → muitos pequenos, poucos gigantes */
const SIZE_SKEW = 3;

/**
 * Conteúdo determinístico de um setor: mesmo (worldSeed, sx, sy) → mesmos
 * asteroides, em qualquer máquina. Fora do cinturão, vazio.
 */
export function sectorAsteroids(worldSeed: number, sx: number, sy: number): Asteroid[] {
  if (!sectorInBelt(sx, sy)) return [];

  const sectorSeed = hash3(worldSeed, sx, sy);
  const rng = mulberry32(sectorSeed);
  const count = MIN_COUNT + Math.floor(rng() * (MAX_COUNT - MIN_COUNT + 1));

  const asteroids: Asteroid[] = [];
  for (let i = 0; i < count; i++) {
    // distribuição enviesada para o pequeno: raio = min·(max/min)^(t^skew)
    const t = rng();
    const radius =
      ASTEROID_MIN_RADIUS *
      Math.pow(ASTEROID_MAX_RADIUS / ASTEROID_MIN_RADIUS, Math.pow(t, SIZE_SKEW));
    // margem para o centro não colar na borda do setor
    const margin = Math.min(radius, SECTOR_SIZE * 0.45);
    const x = margin + rng() * (SECTOR_SIZE - 2 * margin);
    const y = margin + rng() * (SECTOR_SIZE - 2 * margin);
    asteroids.push({
      id: `${sx}:${sy}:${i}`,
      sx,
      sy,
      x,
      y,
      radius,
      shapeSeed: hash3(sectorSeed, i, 0x51),
    });
  }
  return asteroids;
}
