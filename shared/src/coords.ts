import { SECTOR_SIZE, BELT_INNER_SECTORS, BELT_OUTER_SECTORS } from "./constants";

/**
 * Posição no mundo: setor (inteiro, sem limite de precisão relevante) +
 * posição local dentro do setor (float pequeno → precisão estável).
 */
export interface WorldPos {
  sx: number;
  sy: number;
  x: number;
  y: number;
}

/** Recoloca a posição local no intervalo [0, SECTOR_SIZE), ajustando o setor. */
export function normalizePos(p: WorldPos): void {
  while (p.x < 0) {
    p.x += SECTOR_SIZE;
    p.sx--;
  }
  while (p.x >= SECTOR_SIZE) {
    p.x -= SECTOR_SIZE;
    p.sx++;
  }
  while (p.y < 0) {
    p.y += SECTOR_SIZE;
    p.sy--;
  }
  while (p.y >= SECTOR_SIZE) {
    p.y -= SECTOR_SIZE;
    p.sy++;
  }
}

/** Vetor de `a` até `b`, em unidades, atravessando setores. Válido para distâncias próximas. */
export function relVec(a: WorldPos, b: WorldPos): { dx: number; dy: number } {
  return {
    dx: (b.sx - a.sx) * SECTOR_SIZE + (b.x - a.x),
    dy: (b.sy - a.sy) * SECTOR_SIZE + (b.y - a.y),
  };
}

/** Distância entre duas posições próximas, em unidades. */
export function dist(a: WorldPos, b: WorldPos): number {
  const { dx, dy } = relVec(a, b);
  return Math.hypot(dx, dy);
}

/** O setor está dentro do anel do cinturão de asteroides? */
export function sectorInBelt(sx: number, sy: number): boolean {
  const r = Math.hypot(sx + 0.5, sy + 0.5);
  return r >= BELT_INNER_SECTORS && r <= BELT_OUTER_SECTORS;
}
