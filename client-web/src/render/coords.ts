import { Vector3 } from "@babylonjs/core/Maths/math.vector";

/**
 * coords — fronteira única entre o espaço do jogo (Y para baixo, herdado do
 * Phaser e mantido em sim-core/rede) e o espaço de cena do Babylon (Y para
 * cima). O plano do jogo é o plano XY da cena, câmera olhando ao longo de Z.
 *
 * TODA conversão de posição/ângulo entre jogo e render passa por aqui —
 * nenhum renderer nega Y ou ângulo por conta própria.
 */

/** Posição do jogo → posição de cena (plano XY, z = 0). */
export function toScene(x: number, y: number): Vector3 {
  return new Vector3(x, -y, 0);
}

/**
 * Ângulo do jogo → rotação Z da cena. Ao negar Y o sentido de rotação
 * inverte junto; negar o ângulo restaura o giro visual original.
 */
export function toSceneAngle(a: number): number {
  return -a;
}

/** Posição de cena → jogo (inversa; usada no unproject do ponteiro). */
export function toGame(sceneX: number, sceneY: number): { x: number; y: number } {
  return { x: sceneX, y: -sceneY };
}
