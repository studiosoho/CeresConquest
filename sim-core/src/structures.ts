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
  /** vagas expandidas: índices 0..expandedBays-1 (builder/mineração) */
  expandedBays: number;
  spiderBays: number;
  nextShipBay: number;
  nextSpiderBay: number;
  /** minério LOCAL acumulado (estação: aranhas/builder enchem; transporte esvazia) */
  oreStore: number;
  /** rações em estoque (base inicial recebe da Terra; transporte distribui) */
  rationStore: number;
}
