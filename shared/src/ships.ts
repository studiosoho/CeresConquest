// Classes de nave e produção no QG.
// - builder: a nave que o jogador pilota e usa para construir estruturas.
// - mining:  fabricada no QG; minera autonomamente (no protótipo).
// - attack:  fabricada no QG; autônoma (no protótipo).

export type ShipKind = "builder" | "mining" | "attack";

/** Classes fabricáveis no QG. */
export type ProducibleKind = "builder" | "mining" | "attack";

export interface ShipProductionSpec {
  label: string;
  /** custo em minério */
  cost: number;
}

export const SHIP_PRODUCTION: Record<ProducibleKind, ShipProductionSpec> = {
  builder: { label: "Builder", cost: 100 },
  mining: { label: "Nave de mineração", cost: 80 },
  attack: { label: "Nave de ataque", cost: 150 },
};

/** Capacidade do hangar do QG por tipo de nave (2 de cada → 6 no total). */
export const HANGAR_CAP = 2;

/** Máximo de mineradoras auto-minerando (atreladas) por estação de mineração. */
export const STATION_MINING_CAP = 4;

/** Vagas do hangar de guarda da estação (para trocar/táxi). Usado no 3c. */
export const STATION_HANGAR_CAP = 2;

/** Distância máxima até a própria estrutura para ancorar. */
export const DOCK_RANGE = 500;
