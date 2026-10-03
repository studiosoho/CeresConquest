/**
 * LOGÍSTICA — kits de construção e rações.
 *
 * NÃO HÁ CARTEIRA GLOBAL: minério e kits moram em PORÕES e nos BUFFERS das
 * estruturas (base inicial, QG, estação de mineração). Quem leva de um lado
 * para o outro são as naves. O porão do BUILDER leva minério, kits e rações:
 * até BUILDER_ITEM_CAP de cada, e nunca mais que BUILDER_HOLD_TOTAL somados
 * (holdRoom). A nave de mineração leva só minério, até SHIP_ORE_HOLD.
 *
 * KITS DE CONSTRUÇÃO: a moeda das CONSTRUÇÕES (estruturas, turretas,
 * evoluções). Cada [E] do builder refina REFINE_ORE do minério do PORÃO em
 * REFINE_KITS kits, em REFINE_TIME s — em qualquer lugar, inclusive pousado
 * minerando. O jogador começa com STARTING_KITS kits a bordo. Naves custam
 * minério do buffer do QG que as fabrica.
 *
 * BROCA: toda estação de mineração escava DRILL_BASE_RATE minério/s por
 * nível para o próprio buffer; evolui com kits (stationUpgradeCost).
 *
 * CONSERTO: [G] no builder atracado numa estrutura própria danificada liga o
 * conserto automático — REPAIR_RATE HP/s, 1 kit a cada REPAIR_HP_PER_KIT HP,
 * pago do porão do builder e depois do buffer da estrutura.
 *
 * RAÇÕES: estações de mineração e QGs precisam delas para funcionar. Toda
 * estrutura dessas nasce com STRUCTURE_START_RATIONS; cada ciclo de coleta de
 * uma aranha consome RATIONS_PER_MINING_CYCLE, e cada nave fabricada no QG
 * consome RATIONS_PER_SHIP. Sem rações, as máquinas param.
 *
 * DRONES DE RAÇÃO: a central de rações mantém uma frota de drones que leva
 * rações do estoque dela para as estações e QGs do jogador, sozinha. Três
 * melhorias independentes, pagas em kits: número de drones, velocidade e
 * carga. Drones voam no nível de cruzeiro e podem ser abatidos (mísseis,
 * laser, minas); a central repõe um perdido depois de DRONE_REBUILD_TIME.
 */

// ── kits de construção ────────────────────────────────────────────────
/** minério do porão refinado por [E] */
export const REFINE_ORE = 50;
/** kits que saem de um lote (5 de minério = 1 kit) */
export const REFINE_KITS = 10;
/** duração do refino de um lote (s) */
export const REFINE_TIME = 5;
/** porão do builder: teto de cada item (minério, kits, rações) e do total somado */
export const BUILDER_ITEM_CAP = 250;
export const BUILDER_HOLD_TOTAL = 500;
/** porão de minério da nave de mineração */
export const SHIP_ORE_HOLD = 300;

export type HoldItem = "ore" | "kits" | "rations";
/** O conteúdo do porão de uma nave (o minério é cargoAmount com cargoKind "ore"). */
export interface HoldContents { kind: string; cargoKind: string; cargoAmount: number; kits: number; rations: number }

/**
 * Espaço livre no porão para `item`: no builder, o teto do item e o do total
 * (BUILDER_ITEM_CAP / BUILDER_HOLD_TOTAL); na nave de mineração, só minério
 * até SHIP_ORE_HOLD; nas demais, nada (o transporte tem regra própria).
 */
export function holdRoom(s: Readonly<HoldContents>, item: HoldItem): number {
  const ore = s.cargoKind === "ore" ? s.cargoAmount : 0;
  if (s.kind === "mining") return item === "ore" && (s.cargoKind === "" || s.cargoKind === "ore") ? Math.max(0, SHIP_ORE_HOLD - ore) : 0;
  if (s.kind !== "builder") return 0;
  if (item === "ore" && s.cargoKind !== "" && s.cargoKind !== "ore") return 0;
  const have = item === "ore" ? ore : item === "kits" ? s.kits : s.rations;
  return Math.max(0, Math.min(BUILDER_ITEM_CAP - have, BUILDER_HOLD_TOTAL - (ore + s.kits + s.rations)));
}
/** kits com que o builder do jogador começa a partida */
export const STARTING_KITS = 100;

// ── broca da estação de mineração ─────────────────────────────────────
/** minério/s que a broca escava por nível da estação */
export const DRILL_BASE_RATE = 4;
/** minério escavado por ciclo de rações da broca (cada ciclo consome RATIONS_PER_MINING_CYCLE) */
export const DRILL_CYCLE_ORE = 100;
/** custo em kits de evoluir a estação do nível `level` para o seguinte (null = no máximo) */
export const STATION_UPGRADE_COSTS: readonly number[] = [100, 150, 200, 250];
export function stationUpgradeCost(level: number): number | null {
  return STATION_UPGRADE_COSTS[level - 1] ?? null;
}
// ── conserto de estruturas ([G] no builder atracado) ─────────────────
/** HP recuperado por kit gasto no conserto */
export const REPAIR_HP_PER_KIT = 10;
/** velocidade do conserto (HP/s) */
export const REPAIR_RATE = 25;

/** buffer de minério e de kits da base inicial e do QG (a estação usa stationOreCap) */
export const STRUCTURE_ORE_CAP = 5000;
export const STRUCTURE_KIT_CAP = 1000;

// ── rações ────────────────────────────────────────────────────────────
/** rações com que uma estação de mineração ou um QG nasce */
export const STRUCTURE_START_RATIONS = 100;
/** rações consumidas por ciclo de coleta de uma aranha mineradora */
export const RATIONS_PER_MINING_CYCLE = 10;
/** rações consumidas por nave fabricada no QG */
export const RATIONS_PER_SHIP = 10;

// ── drones de ração ───────────────────────────────────────────────────
/** As três melhorias da central de rações. */
export type DroneTrack = "drones" | "speed" | "cargo";
export const DRONE_TRACKS: readonly DroneTrack[] = ["drones", "speed", "cargo"];
/** níveis de melhoria por trilha (0 = de fábrica) */
export const DRONE_TRACK_MAX = 4;
/** custo em kits de cada nível (o índice é o nível atual) */
export const DRONE_UPGRADE_COST: readonly number[] = [60, 90, 120, 150];

export const DRONE_BASE_COUNT = 2;
export const DRONE_BASE_CARGO = 10;
/** velocidade de cruzeiro do drone (u/s), antes da melhoria */
export const DRONE_BASE_SPEED = 900;
export const DRONE_HP = 20;
/** raio de acerto do drone (u) */
export const DRONE_RADIUS = 25;
/** tempo para a central repor um drone abatido (s) */
export const DRONE_REBUILD_TIME = 30;

/** O que a central entrega com as melhorias `lv` (cada trilha 0..DRONE_TRACK_MAX). */
export function droneStats(lv: Readonly<Record<DroneTrack, number>>): { count: number; speed: number; cargo: number } {
  return {
    count: DRONE_BASE_COUNT + lv.drones,
    speed: DRONE_BASE_SPEED * (1 + 0.25 * lv.speed),
    cargo: DRONE_BASE_CARGO + 5 * lv.cargo,
  };
}

/** Custo em kits do próximo nível de uma trilha (null = no máximo). */
export function droneUpgradeCost(level: number): number | null {
  return level >= DRONE_TRACK_MAX ? null : DRONE_UPGRADE_COST[level];
}
