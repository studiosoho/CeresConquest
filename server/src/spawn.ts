import {
  BELT_CENTER_SECTORS,
  SECTOR_SIZE,
  sectorInBelt,
  mulberry32,
  type WorldPos,
} from "@ceres/shared";

export type SpawnStrategy = "neighboring" | "scattered" | "random";

/** Ponto base da arena no anel do cinturão, determinístico pela semente. */
export function beltBasePoint(seed: number): { sx: number; sy: number; angle: number } {
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const angle = rng() * Math.PI * 2;
  const R = BELT_CENTER_SECTORS;
  return {
    sx: Math.round(Math.cos(angle) * R),
    sy: Math.round(Math.sin(angle) * R),
    angle,
  };
}

/**
 * Distribui `count` spawns em setores distintos do cinturão dentro do mapa,
 * espalhados ao longo da pista (direção tangente). Fica em 85% do raio para
 * garantir que ninguém nasça encostado na fronteira.
 */
export function mapSpawns(seed: number, radiusSectors: number, count: number): WorldPos[] {
  const base = beltBasePoint(seed);
  const tx = -Math.sin(base.angle);
  const ty = Math.cos(base.angle);
  const inner = radiusSectors * 0.85;
  const r = Math.ceil(inner);

  const cands: Array<{ sx: number; sy: number; proj: number }> = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > inner * inner) continue;
      const sx = base.sx + dx;
      const sy = base.sy + dy;
      if (!sectorInBelt(sx, sy)) continue;
      cands.push({ sx, sy, proj: dx * tx + dy * ty });
    }
  }
  cands.sort((a, b) => a.proj - b.proj);

  const spawns: WorldPos[] = [];
  for (let i = 0; i < count; i++) {
    const c = cands.length
      ? cands[Math.min(Math.floor(((i + 0.5) * cands.length) / count), cands.length - 1)]
      : { sx: base.sx, sy: base.sy };
    spawns.push({ sx: c.sx, sy: c.sy, x: SECTOR_SIZE / 2, y: SECTOR_SIZE / 2 });
  }
  return spawns;
}
