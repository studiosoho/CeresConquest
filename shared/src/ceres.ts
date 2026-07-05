// Ceres: o planeta anão, objetivo de conquista do jogo. Vive dentro do
// cinturão de asteroides, com diâmetro igual à largura do cinturão.

import { mulberry32 } from "./rng";
import { BELT_CENTER_SECTORS, SECTOR_SIZE } from "./constants";
import { BELT_WIDTH } from "./scale";
import type { WorldPos } from "./coords";

/** Raio de Ceres — seu diâmetro é exatamente a largura do cinturão. */
export const CERES_RADIUS = BELT_WIDTH / 2;

/**
 * Posição de Ceres no cinturão: determinística pela semente do mundo, então
 * servidor e cliente calculam o MESMO ponto sem precisar sincronizar nada
 * pela rede (como a procgen dos asteroides).
 *
 * Protótipo: os jogadores nascem perto daqui (ver mapSpawns). Na versão
 * final, o spawn dos jogadores é independente e aleatório — só a posição
 * de Ceres continua fixa por partida.
 */
export function ceresPosition(seed: number): WorldPos & { angle: number } {
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const angle = rng() * Math.PI * 2;
  const R = BELT_CENTER_SECTORS;
  return {
    sx: Math.round(Math.cos(angle) * R),
    sy: Math.round(Math.sin(angle) * R),
    x: SECTOR_SIZE / 2,
    y: SECTOR_SIZE / 2,
    angle,
  };
}
