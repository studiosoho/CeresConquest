import {
  BELT_CENTER_SECTORS,
  SECTOR_SIZE,
  mulberry32,
  type WorldPos,
} from "@ceres/shared";

export type SpawnStrategy = "neighboring" | "scattered" | "random";

/** Espaçamento tangencial entre jogadores, em setores. */
const NEIGHBOR_SPACING = 2;

/**
 * Estratégia "neighboring": escolhe um ponto base no anel do cinturão
 * (determinístico pela semente da sessão) e distribui os jogadores ao longo
 * da direção TANGENTE ao cinturão. Como a pista é fina radialmente, espalhar
 * pela tangente mantém todos dentro do cinturão e em setores vizinhos.
 */
export function neighboringSpawns(seed: number, count: number): WorldPos[] {
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const angle = rng() * Math.PI * 2;
  const R = BELT_CENTER_SECTORS;
  const baseSx = Math.cos(angle) * R;
  const baseSy = Math.sin(angle) * R;
  // tangente = perpendicular ao raio
  const tx = -Math.sin(angle);
  const ty = Math.cos(angle);

  const spawns: WorldPos[] = [];
  for (let i = 0; i < count; i++) {
    const off = (i - (count - 1) / 2) * NEIGHBOR_SPACING;
    spawns.push({
      sx: Math.round(baseSx + tx * off),
      sy: Math.round(baseSy + ty * off),
      x: SECTOR_SIZE / 2,
      y: SECTOR_SIZE / 2,
    });
  }
  return spawns;
}
