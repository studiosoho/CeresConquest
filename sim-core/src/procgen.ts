import { SECTOR_SIZE, sectorInBelt, hash3, mulberry32 } from "@ceres/shared";

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

const MIN_RADIUS = 40;
const MAX_RADIUS = 130;
const MIN_COUNT = 5;
const MAX_COUNT = 14;

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
    const radius = MIN_RADIUS + rng() * (MAX_RADIUS - MIN_RADIUS);
    // margem para o asteroide não vazar a borda do setor
    const x = radius + rng() * (SECTOR_SIZE - 2 * radius);
    const y = radius + rng() * (SECTOR_SIZE - 2 * radius);
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
