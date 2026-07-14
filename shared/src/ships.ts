// Classes de nave e produção no QG.
// - builder:   a nave que o jogador pilota e usa para construir estruturas.
// - mining:    fabricada no QG; minera pousada / autonomamente na estação.
// - attack:    fabricada no QG; combate (munição perfurante + granada).
// - transport: fabricada no QG; carrega minério (estação → base inicial)
//              e rações (base inicial → QG/estação).

export type ShipKind = "builder" | "mining" | "attack" | "transport";

/** Classes fabricáveis no QG. */
export type ProducibleKind = "builder" | "mining" | "attack" | "transport";

export interface ShipProductionSpec {
  label: string;
  /** custo em minério */
  cost: number;
}

export const SHIP_PRODUCTION: Record<ProducibleKind, ShipProductionSpec> = {
  builder: { label: "Builder", cost: 300 },
  mining: { label: "Nave de mineração", cost: 80 },
  attack: { label: "Nave de ataque", cost: 150 },
  transport: { label: "Nave de transporte", cost: 120 },
};

// ── Carga (nave de transporte) ────────────────────────────────────────
/** Tipo de carga no porão ("" = vazio). */
export type CargoKind = "" | "ore" | "rations";
/** Capacidade do porão da nave de transporte (minério OU rações). */
export const TRANSPORT_CARGO_CAP = 500;

import type { AsteroidClass } from "./scale";
import { MINING_RATE } from "./constants";

// Vagas de hangar por tipo: EXPANDIDAS aceitam QUALQUER classe; NORMAIS
// aceitam SOMENTE ataque e transporte. Logo builder/mineração só cabem nas
// expandidas, e ataque/transporte preferem as normais (transbordando para as
// expandidas quando não há normal livre).

/** Vagas EXPANDIDAS (qualquer classe) no QG — fixo. */
export const HQ_EXPANDED_BAYS = 2;
/** Vagas NORMAIS (só ataque/transporte) no QG — fixo. */
export const HQ_NORMAL_BAYS = 4;
/** Total de vagas de nave no QG. */
export const HQ_SHIP_BAYS = HQ_EXPANDED_BAYS + HQ_NORMAL_BAYS;

/** Vagas EXPANDIDAS na estação de mineração — fixo. */
export const STATION_EXPANDED_BAYS = 2;
/** Vagas NORMAIS na estação de mineração — fixo (nenhuma). */
export const STATION_NORMAL_BAYS = 0;
/** Total de vagas de nave na estação. */
export const STATION_SHIP_BAYS = STATION_EXPANDED_BAYS + STATION_NORMAL_BAYS;

/** Vagas EXPANDIDAS na base inicial — fixo. */
export const BASE_EXPANDED_BAYS = 1;
/** Vagas NORMAIS na base inicial — fixo. */
export const BASE_NORMAL_BAYS = 4;
/** Total de vagas de nave na base inicial. */
export const BASE_SHIP_BAYS = BASE_EXPANDED_BAYS + BASE_NORMAL_BAYS;

/** Vagas EXPANDIDAS no centro de distribuição de rações — fixo. */
export const RATION_CENTER_EXPANDED_BAYS = 1;
/** Vagas NORMAIS no centro de distribuição de rações — fixo (nenhuma). */
export const RATION_CENTER_NORMAL_BAYS = 0;
/** Total de vagas de nave no centro de distribuição. */
export const RATION_CENTER_SHIP_BAYS = RATION_CENTER_EXPANDED_BAYS + RATION_CENTER_NORMAL_BAYS;

/** Vagas de ARANHAS mineradoras na estação, pela classe do asteroide. */
export const STATION_SPIDER_BAYS: Record<AsteroidClass, number> = { small: 2, medium: 4, large: 6 };

/** Taxa de mineração por classe de nave (ataque/transporte não mineram). */
export const MINING_RATE_BY_KIND: Record<ShipKind, number> = {
  builder: MINING_RATE / 2,
  mining: MINING_RATE,
  attack: 0,
  transport: 0,
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

// ── Combate (nave de ataque) ──────────────────────────────────────────
/** Velocidade do projétil perfurante (unidades/s). */
export const BULLET_SPEED = 1_000;
/** Alcance máximo do projétil perfurante antes de sumir (unidades). */
export const BULLET_RANGE = 8_000;
/** Raio de detecção de colisão do projétil. */
export const BULLET_RADIUS = 30;
/** Dano do projétil perfurante (HP). */
export const BULLET_DAMAGE = 25;
/** Cooldown entre disparos perfurantes (s). */
export const BULLET_COOLDOWN = 0.25;
/** Estoque máximo de munição perfurante. */
export const BULLET_AMMO_MAX = 120;

/** Velocidade da granada de proximidade (unidades/s). */
export const GRENADE_SPEED = 1_000;
/** Raio de detonação por proximidade (unidades). */
export const GRENADE_PROX_RADIUS = 120;
/** Raio de dano da explosão (unidades). */
export const GRENADE_BLAST_RADIUS = 300;
/** Dano máximo da granada (no centro da explosão). */
export const GRENADE_DAMAGE = 120;
/** Cooldown entre granadas (s). */
export const GRENADE_COOLDOWN = 2.0;
/** Estoque máximo de granadas. */
export const GRENADE_AMMO_MAX = 10;
/** HP máximo de qualquer nave. */
export const SHIP_HP_MAX = 100;
