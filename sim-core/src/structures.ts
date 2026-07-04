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
  /** orientação base (rad) — o visual gira junto com o asteroide hospedeiro */
  angle: number;
  /** asteroide hospedeiro (id da procgen). A estrutura vive DENTRO dele; */
  /** o asteroide deixa de colidir e só comporta uma estrutura. */
  asteroidId: string;
}
