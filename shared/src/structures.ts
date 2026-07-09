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
}

export const STRUCTURE_SPECS: Record<StructureType, StructureSpec> = {
  miningStation: {
    label: "Estação de mineração",
    cost: 100,
    radius: SHIP_RADIUS * 4,
    requiresAsteroid: true,
    // a estação sozinha NÃO minera — quem produz são as aranhas atreladas
    productionRate: 0,
  },
  hq: {
    label: "Quartel-general",
    cost: 300,
    radius: SHIP_RADIUS * 6,
    requiresAsteroid: true,
    productionRate: 0,
  },
  initialBase: {
    label: "Base inicial",
    cost: 0, // concedida ao jogador no início da partida, não construível
    radius: SHIP_RADIUS * 5,
    requiresAsteroid: true,
    productionRate: 0,
  },
  rationCenter: {
    label: "Centro de distribuição de rações",
    cost: 200,
    radius: SHIP_RADIUS * 4,
    requiresAsteroid: true,
    productionRate: 0,
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
