import {
  SECTOR_SIZE,
  CERES_RADIUS,
  sectorInBelt,
  ceresPosition,
  type WorldPos,
} from "@ceres/shared";

export type SpawnStrategy = "neighboring" | "scattered" | "random";

/** Margem entre a borda de Ceres e o setor de spawn mais próximo. */
const CERES_SPAWN_MARGIN_SECTORS = 1;

/**
 * Distribui `count` spawns em setores distintos do cinturão dentro do mapa,
 * espalhados ao longo da pista (direção tangente) e por FORA do raio de
 * Ceres (protótipo: nasce perto dela, nunca dentro). Fica em 85% do raio
 * da arena para garantir que ninguém nasça encostado na fronteira.
 */
export function mapSpawns(seed: number, radiusSectors: number, count: number): WorldPos[] {
  const base = ceresPosition(seed);
  const tx = -Math.sin(base.angle);
  const ty = Math.cos(base.angle);
  const inner = radiusSectors * 0.85;
  const r = Math.ceil(inner);
  const ceresRadiusSectors = CERES_RADIUS / SECTOR_SIZE + CERES_SPAWN_MARGIN_SECTORS;

  const cands: Array<{ sx: number; sy: number; proj: number }> = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > inner * inner) continue;
      if (d2 < ceresRadiusSectors * ceresRadiusSectors) continue; // dentro de Ceres: pula
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
