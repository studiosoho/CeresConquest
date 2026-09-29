import { SHIP_RADIUS } from "./scale";
import { STRUCTURE_SPECS, type StructureType } from "./structures";
import { normalizePos, type WorldPos } from "./coords";

/**
 * Geometria das VAGAS de hangar de uma estrutura — fonte única para o
 * servidor (onde a nave pousa, onde fica a nave pousada) e para o cliente
 * (onde desenha as placas). Antes ela só existia no render, e o servidor
 * pousava toda nave no centro da estrutura.
 *
 * As vagas são uma fileira à FRENTE do prédio. A frente aponta para
 * `Structure.angle` — a direção de onde o builder estava ao construir —, e o
 * asteroide que hospeda uma estrutura NÃO gira no plano, então a posição de
 * cada vaga é fixa no mundo e igual para todo mundo.
 *
 * Quadro local (coordenadas do jogo, origem no centro da estrutura): a fileira
 * corre ao longo de +x, centrada; a frente é −y. Vagas EXPANDIDAS
 * (0..expandedBays-1) são mais largas e vêm primeiro; as normais, quadradas.
 */

/** lado da vaga normal (ataque e transporte) */
export const BAY_SLOT_NORMAL = SHIP_RADIUS * 2.0;
/** largura e altura da vaga expandida (qualquer classe) */
export const BAY_SLOT_EXPANDED_W = SHIP_RADIUS * 3.2;
export const BAY_SLOT_EXPANDED_H = SHIP_RADIUS * 2.4;
/** folga entre vagas vizinhas */
export const BAY_GAP = SHIP_RADIUS * 0.5;

/** Uma vaga no quadro local da estrutura. */
export interface BaySlot {
  /** centro, no quadro local (a frente é −y) */
  x: number;
  y: number;
  w: number;
  h: number;
  expanded: boolean;
}

/** O mínimo de uma estrutura que decide a fileira de vagas. */
export interface BayHost {
  type: StructureType;
  shipBays: number;
  expandedBays: number;
}

/** A fileira de vagas no quadro local, na ordem dos índices. */
export function bayLayout(host: BayHost): BaySlot[] {
  const n = Math.max(0, host.shipBays);
  const exp = Math.max(0, Math.min(n, host.expandedBays));
  const width = (i: number) => (i < exp ? BAY_SLOT_EXPANDED_W : BAY_SLOT_NORMAL);
  let total = 0;
  for (let i = 0; i < n; i++) total += width(i) + (i > 0 ? BAY_GAP : 0);
  const y = -(STRUCTURE_SPECS[host.type].radius + BAY_SLOT_EXPANDED_H * 0.6);
  const out: BaySlot[] = [];
  let x = -total / 2;
  for (let i = 0; i < n; i++) {
    const expanded = i < exp;
    const w = width(i);
    out.push({ x: x + w / 2, y, w, h: expanded ? BAY_SLOT_EXPANDED_H : BAY_SLOT_NORMAL, expanded });
    x += w + BAY_GAP;
  }
  return out;
}

/**
 * Rotação do quadro local para o mundo: a frente (−y local) aponta para
 * `structAngle`. Com φ = ângulo + π/2, R(φ)·(0, −1) = (cos a, sin a).
 */
export function bayFrameAngle(structAngle: number): number {
  return structAngle + Math.PI / 2;
}

/** Ponto do quadro local de uma estrutura levado ao mundo. */
export function structLocalToWorld(
  host: WorldPos & { angle: number },
  lx: number,
  ly: number,
): WorldPos {
  const phi = bayFrameAngle(host.angle);
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const p = { sx: host.sx, sy: host.sy, x: host.x + c * lx - s * ly, y: host.y + s * lx + c * ly };
  normalizePos(p);
  return p;
}

/** Posição no mundo do CENTRO da vaga `bay` (null se o índice não existe). */
export function bayWorldPos(host: BayHost & WorldPos & { angle: number }, bay: number): WorldPos | null {
  const slot = bayLayout(host)[bay];
  return slot ? structLocalToWorld(host, slot.x, slot.y) : null;
}
