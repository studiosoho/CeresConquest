import {
  BELT_INNER_SECTORS,
  BELT_OUTER_SECTORS,
  SECTOR_SIZE,
  mulberry32,
  type WorldPos,
} from "@ceres/shared";

export type SpawnStrategy = "neighboring" | "scattered" | "random";

/** Offsets em espiral a partir do quadrante base — jogadores vizinhos. */
const NEIGHBOR_OFFSETS: Array<[number, number]> = [
  [0, 0], [1, 0], [0, 1], [-1, 0], [0, -1],
  [1, 1], [-1, 1], [-1, -1], [1, -1],
  [2, 0], [0, 2], [-2, 0], [0, -2], [2, 1], [1, 2], [-2, -1],
];

/**
 * Estratégia "neighboring": escolhe um quadrante base no anel do cinturão
 * (determinístico pela semente da sessão) e distribui os jogadores em
 * quadrantes adjacentes, no centro de cada setor.
 */
export function neighboringSpawns(seed: number, count: number): WorldPos[] {
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const angle = rng() * Math.PI * 2;
  const ringRadius = Math.round((BELT_INNER_SECTORS + BELT_OUTER_SECTORS) / 2);
  const baseSx = Math.round(Math.cos(angle) * ringRadius);
  const baseSy = Math.round(Math.sin(angle) * ringRadius);

  const spawns: WorldPos[] = [];
  for (let i = 0; i < count; i++) {
    const [ox, oy] = NEIGHBOR_OFFSETS[i % NEIGHBOR_OFFSETS.length];
    spawns.push({
      sx: baseSx + ox,
      sy: baseSy + oy,
      x: SECTOR_SIZE / 2,
      y: SECTOR_SIZE / 2,
    });
  }
  return spawns;
}
