import { SHIP_RADIUS } from "./scale";

// Estruturas construíveis pelo jogador. São criações persistentes da partida
// (não procgen) — o servidor é a autoridade e as sincroniza. Os specs abaixo
// (custo, raio, produção) são compartilhados para o cliente exibir custos.

export type StructureType = "miningStation" | "hq";

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
};

/** Distância máxima até um asteroide para poder erguer uma estação de mineração. */
export const BUILD_ASTEROID_RANGE = 600;
