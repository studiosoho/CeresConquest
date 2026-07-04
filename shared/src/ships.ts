// Classes de nave e produção no QG.
// - builder: a nave que o jogador pilota e usa para construir estruturas.
// - mining:  fabricada no QG; minera autonomamente (no protótipo).
// - attack:  fabricada no QG; autônoma (no protótipo).

export type ShipKind = "builder" | "mining" | "attack";

/** Classes fabricáveis no QG. */
export type ProducibleKind = "mining" | "attack";

export interface ShipProductionSpec {
  label: string;
  /** custo em minério */
  cost: number;
}

export const SHIP_PRODUCTION: Record<ProducibleKind, ShipProductionSpec> = {
  mining: { label: "Nave de mineração", cost: 80 },
  attack: { label: "Nave de ataque", cost: 150 },
};

/** Capacidade do hangar do QG por tipo de nave. */
export const HANGAR_CAP = 2;

/** Distância máxima até o próprio QG para ancorar. */
export const DOCK_RANGE = 500;
