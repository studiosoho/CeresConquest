import { STRUCTURE_SPECS, type StructureType } from "./structures";
import { structLocalToWorld } from "./bays";
import type { WorldPos } from "./coords";

/**
 * TURRETAS de defesa das estruturas.
 *
 * O builder atracado numa estrutura própria constrói uma turreta por vez,
 * pagando TURRET_COST de minério do PORÃO dele (BUILDER_ORE_CAP; carregado
 * com [E] no estoque de uma estação ou da carteira, na base/QG). Durante a
 * obra (TURRET_BUILD_TIME) o builder fica TRAVADO na vaga: não decola — o
 * jogador só sai trocando de nave ([C]) ou chamando um táxi.
 *
 * Pronta, a turreta defende sozinha: atira nas naves inimigas em MODO ATAQUE
 * daquela estrutura (as que estão no nível dela), com acerto instantâneo.
 *
 * Os lugares das turretas ficam no MESMO quadro local das vagas (bays.ts):
 * origem no centro da estrutura, frente (onde ficam as vagas) em −y. As
 * turretas ocupam os flancos e os fundos do prédio, longe da fileira de vagas
 * — fonte única para o servidor (de onde o tiro sai) e o render.
 */

/** turretas por estrutura */
export const TURRET_MAX = 4;
/** minério (do porão do builder) por turreta */
export const TURRET_COST = 120;
/** duração da obra (s) — o builder fica travado na vaga até o fim */
export const TURRET_BUILD_TIME = 20;
/** alcance do tiro, a partir da turreta (u) */
export const TURRET_RANGE = 3000;
export const TURRET_DAMAGE = 6;
/** intervalo entre tiros de UMA turreta (s) */
export const TURRET_COOLDOWN = 0.8;

/** porão de minério do builder */
export const BUILDER_ORE_CAP = 300;

/** Centro do lugar da turreta `i` no quadro local da estrutura. */
export function turretSlot(type: StructureType, i: number): { x: number; y: number } {
  const r = STRUCTURE_SPECS[type].radius;
  const side = i % 2 === 0 ? -1 : 1;
  // 0/1: flancos, à altura do prédio; 2/3: cantos dos fundos (+y)
  return i < 2 ? { x: side * (r + 65), y: r * 0.15 } : { x: side * (r * 0.8), y: r + 65 };
}

/** Posição no mundo da turreta `i` da estrutura. */
export function turretWorldPos(host: WorldPos & { angle: number; type: StructureType }, i: number): WorldPos {
  const s = turretSlot(host.type, i);
  return structLocalToWorld(host, s.x, s.y);
}
