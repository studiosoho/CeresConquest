import type { StructureType, WorldPos } from "@ceres/shared";

/**
 * Estrutura construída por um jogador. Vive no estado da partida (não é
 * procgen): o servidor cria via comando e sincroniza. Estática — não se move.
 */
export interface Structure extends WorldPos {
  id: string;
  type: StructureType;
  /** sessionId do dono */
  owner: string;
  /** orientação (rad), apontando para fora da borda do asteroide */
  angle: number;
}
