// Tamanhos de mapa configuráveis. O "mapa" é uma fronteira circular em torno
// da região de spawn no cinturão — define a arena do modo partida. O raio é
// dado em setores; a espessura do cinturão e o resto do mundo não mudam.

export type MapSize = "small" | "medium" | "large";

export interface MapSpec {
  /** raio da fronteira, em setores a partir do centro da arena */
  radiusSectors: number;
}

export const MAP_SIZES: Record<MapSize, MapSpec> = {
  small: { radiusSectors: 8 },
  medium: { radiusSectors: 20 },
  large: { radiusSectors: 50 },
};

/** Padrão do protótipo. */
export const DEFAULT_MAP_SIZE: MapSize = "small";

/** Reverso, para exibir o nome do tamanho a partir do raio recebido pela rede. */
export function mapSizeFromRadiusSectors(rs: number): MapSize | "custom" {
  for (const k of Object.keys(MAP_SIZES) as MapSize[]) {
    if (Math.abs(MAP_SIZES[k].radiusSectors - rs) < 0.5) return k;
  }
  return "custom";
}
