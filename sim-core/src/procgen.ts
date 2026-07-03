import {
  SECTOR_SIZE,
  SHIP_RADIUS,
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

// ── Densidade: asteroides-alvo por setor (ajuste aqui para mais/menos cheio) ──
const MIN_ASTEROIDS_PER_SECTOR = 10;
const MAX_ASTEROIDS_PER_SECTOR = 18;
/** expoente da distribuição de tamanhos: >1 → muitos pequenos, poucos gigantes */
const SIZE_SKEW = 3;
/** tentativas de posicionamento sem sobreposição antes de descartar um asteroide */
const PLACEMENT_TRIES = 12;
/**
 * Folga mínima entre superfícies de asteroides. Com ≥ 2·SHIP_RADIUS, os
 * círculos de colisão "inflados" (raio + SHIP_RADIUS) nunca se sobrepõem —
 * então a nave nunca fica espremida entre dois asteroides.
 */
const MIN_GAP = 2 * SHIP_RADIUS;

/**
 * Conteúdo determinístico de um setor: mesmo (worldSeed, sx, sy) → mesmos
 * asteroides, em qualquer máquina. Fora do cinturão, vazio.
 */
export function sectorAsteroids(worldSeed: number, sx: number, sy: number): Asteroid[] {
  if (!sectorInBelt(sx, sy)) return [];

  const sectorSeed = hash3(worldSeed, sx, sy);
  const rng = mulberry32(sectorSeed);
  const target =
    MIN_ASTEROIDS_PER_SECTOR +
    Math.floor(rng() * (MAX_ASTEROIDS_PER_SECTOR - MIN_ASTEROIDS_PER_SECTOR + 1));

  // raios enviesados para o pequeno; os maiores são posicionados primeiro
  // (empacotam melhor e sobram os buracos para os pequenos)
  const radii: number[] = [];
  for (let i = 0; i < target; i++) {
    const t = rng();
    radii.push(
      ASTEROID_MIN_RADIUS *
        Math.pow(ASTEROID_MAX_RADIUS / ASTEROID_MIN_RADIUS, Math.pow(t, SIZE_SKEW)),
    );
  }
  radii.sort((a, b) => b - a);

  const asteroids: Asteroid[] = [];
  for (const radius of radii) {
    // margem = raio + meia-folga: mantém o asteroide inteiro dentro do setor
    // E afastado da borda, garantindo a folga mesmo contra setores vizinhos
    const margin = Math.min(radius + MIN_GAP / 2, SECTOR_SIZE * 0.45);
    let x = 0;
    let y = 0;
    let placed = false;
    for (let attempt = 0; attempt < PLACEMENT_TRIES; attempt++) {
      x = margin + rng() * (SECTOR_SIZE - 2 * margin);
      y = margin + rng() * (SECTOR_SIZE - 2 * margin);
      placed = asteroids.every(
        (o) => Math.hypot(x - o.x, y - o.y) >= radius + o.radius + MIN_GAP,
      );
      if (placed) break;
    }
    if (!placed) continue; // não coube sem sobrepor — descarta

    const i = asteroids.length;
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
