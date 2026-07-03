// Classes de nave e custos de produção no QG. A nave inicial ("starter") é a
// pilotada pelo jogador; scout e nave de ataque são fabricadas no QG.

export type ShipKind = "starter" | "scout" | "attack";

/** Classes que podem ser fabricadas no QG. */
export type ProducibleKind = "scout" | "attack";

export interface ShipProductionSpec {
  label: string;
  /** custo em minério */
  cost: number;
}

export const SHIP_PRODUCTION: Record<ProducibleKind, ShipProductionSpec> = {
  scout: { label: "Scout", cost: 80 },
  attack: { label: "Nave de ataque", cost: 150 },
};
