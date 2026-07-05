import type { StructureType, WorldPos, AsteroidClass } from "@ceres/shared";

export interface Structure extends WorldPos {
  id: string;
  type: StructureType;
  owner: string;
  angle: number;
  asteroidId: string;
  asteroidClass: AsteroidClass;
  /** total de vagas de nave (expandidas + normais) */
  shipBays: number;
  /** vagas expandidas: aceitam mining, attack e builder */
  expandedBays: number;
  spiderBays: number;
  nextShipBay: number;
  nextSpiderBay: number;
  /** buffer de minério acumulado pelas aranhas (descarregado pelo builder) */
  mineBuffer: number;
}
