import { SHIP_RADIUS } from "./scale";

// Estruturas construíveis pelo jogador. São criações persistentes da partida
// (não procgen) — o servidor é a autoridade e as sincroniza. Os specs abaixo
// (custo, raio, produção) são compartilhados para o cliente exibir custos.

export type StructureType = "miningStation" | "hq" | "initialBase" | "rationCenter";

export interface StructureSpec {
  label: string;
  /** custo em minério */
  cost: number;
  /** raio da estrutura, em unidades (proporcional à escala da nave) */
  radius: number;
  /** exige um asteroide por perto para ser construída */
  requiresAsteroid: boolean;
  /** minério/s gerado passivamente para o dono (0 = nenhum) */
  productionRate: number;
  /**
   * Pontos de vida. Só naves de ataque no nível das estações (superfície ou
   * modo ataque) a atingem; em zero, a estrutura explode com as naves
   * guardadas no hangar dela. Referência: o perfurante tira 25, a granada até
   * 120, e uma nave de ataque carrega 120 perfurantes.
   */
  hp: number;
}

export const STRUCTURE_SPECS: Record<StructureType, StructureSpec> = {
  miningStation: {
    label: "Estação de mineração",
    cost: 100,
    radius: SHIP_RADIUS * 4,
    requiresAsteroid: true,
    // a estação sozinha NÃO minera — quem produz são as aranhas atreladas
    productionRate: 0,
    hp: 600,
  },
  hq: {
    label: "Quartel-general",
    cost: 300,
    radius: SHIP_RADIUS * 6,
    requiresAsteroid: true,
    productionRate: 0,
    hp: 1500,
  },
  initialBase: {
    label: "Base inicial",
    cost: 0, // concedida ao jogador no início da partida, não construível
    radius: SHIP_RADIUS * 5,
    requiresAsteroid: true,
    productionRate: 0,
    hp: 1000,
  },
  rationCenter: {
    label: "Centro de distribuição de rações",
    cost: 200,
    radius: SHIP_RADIUS * 4,
    requiresAsteroid: true,
    productionRate: 0,
    hp: 600,
  },
};

/** Distância máxima até um asteroide para poder erguer uma estação de mineração. */
export const BUILD_ASTEROID_RANGE = 600;

/** Alcance máximo dos drones de ração lançados pelo centro de distribuição (unidades). */
export const RATION_DRONE_RANGE = 3 * 10_000; // 3 setores
/** Rações entregues por drone por viagem. */
export const RATION_DRONE_AMOUNT = 100;
/** Intervalo entre lançamentos de drones (s). */
export const RATION_DRONE_INTERVAL = 30;

// ── Logística física ──────────────────────────────────────────────────
/** Estoque máximo de minério LOCAL da estação (aranhas/builder enchem). */
export const STATION_ORE_STORE = 5000;
/** Rações/s que a base inicial recebe da Terra (fluxo contínuo). */
export const BASE_RATION_INCOME = 5;
/** Estoque máximo de rações de qualquer estrutura. */
export const RATION_STORE_CAP = 2000;

// ── Estação de mineração de Ceres: níveis ─────────────────────────────
/**
 * Em Ceres só se constrói ESTAÇÃO DE MINERAÇÃO, e ela EVOLUI: a cada nível
 * novas instalações ocupam a plataforma (o render desenha os anexos) e a
 * estação fica maior em tudo — HP, estoque local, vagas de aranha e uma
 * produção própria de minério que vai para o estoque (a logística continua
 * física: o transporte leva à base). Nas rochas a estação não evolui.
 */
export const CERES_STATION_MAX_LEVEL = 5;
/** Vagas de aranha a mais por nível acima do 1. */
export const CERES_STATION_SPIDER_BAYS_PER_LEVEL = 2;
/** Minério/s que cada nível acima do 1 põe no estoque local da estação. */
export const CERES_STATION_ORE_RATE_PER_LEVEL = 3;
/** Anexos (prédios novos na plataforma) que cada nível acima do 1 acrescenta. */
export const CERES_STATION_ANNEXES_PER_LEVEL = 2;

/** Custo (minério) para subir a estação de Ceres do nível `level` ao seguinte. */
export function ceresStationUpgradeCost(level: number): number {
  return 200 * level;
}

/** HP máximo de uma estrutura no nível dado: +50% por nível acima do 1. */
export function structureMaxHp(type: StructureType, level = 1): number {
  return STRUCTURE_SPECS[type].hp * (1 + 0.5 * (Math.max(1, level) - 1));
}

/** Capacidade do estoque local de minério de uma estação no nível dado. */
export function stationOreCap(level = 1): number {
  return STATION_ORE_STORE * Math.max(1, level);
}
