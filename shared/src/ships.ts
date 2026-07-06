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
  builder: { label: "Builder", cost: 300 },
  mining: { label: "Nave de mineração", cost: 80 },
  attack: { label: "Nave de ataque", cost: 150 },
};

import type { AsteroidClass } from "./scale";
import { MINING_RATE } from "./constants";

/** Vagas EXPANDIDAS (mining + attack + builder) no QG — fixo. */
export const HQ_EXPANDED_BAYS = 2;
/** Vagas NORMAIS (attack + builder) no QG — fixo. */
export const HQ_NORMAL_BAYS = 4;
/** Total de vagas de nave no QG. */
export const HQ_SHIP_BAYS = HQ_EXPANDED_BAYS + HQ_NORMAL_BAYS;

/** Vagas EXPANDIDAS na estação de mineração (mining + attack + builder) — fixo. */
export const STATION_EXPANDED_BAYS = 2;
/** Vagas NORMAIS na estação de mineração — fixo (nenhuma). */
export const STATION_NORMAL_BAYS = 0;
/** Total de vagas de nave na estação. */
export const STATION_SHIP_BAYS = STATION_EXPANDED_BAYS + STATION_NORMAL_BAYS;

/** Vagas de ARANHAS mineradoras na estação, pela classe do asteroide. */
export const STATION_SPIDER_BAYS: Record<AsteroidClass, number> = { small: 2, medium: 4, large: 6 };

/** Taxa de mineração por classe de nave (caça não minera; builder à metade). */
export const MINING_RATE_BY_KIND: Record<ShipKind, number> = {
  builder: MINING_RATE / 2,
  mining: MINING_RATE,
  attack: 0,
};

/** A aranha mineradora minera 1,5× mais rápido que a nave mineradora. */
export const SPIDER_MINING_MULT = 1.5;

/** Velocidade de caminhada da aranha na superfície (unidades/s). */
export const SPIDER_SPEED = 130;
/** Tempo minerando num ponto antes de voltar para descarregar (s). */
export const SPIDER_MINE_TIME = 5;

/** Distância máxima até a própria estrutura para ancorar. */
export const DOCK_RANGE = 500;

/** Naves em taxiamento voam no dobro da velocidade (e sem colisão). */
export const TAXI_SPEED_MULT = 2;
