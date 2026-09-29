import { LAYER_TRANSITION_TIME, type ShipLayer } from "@ceres/shared";
import type { Body } from "./collision";
import type { ShipState } from "./ship";

/**
 * Regras de camada que a FÍSICA precisa — contra o que cada nave colide. As
 * regras de QUANDO trocar de camada (descer sobre asteroide vazio pousa, a nave
 * de ataque sobre estação entra em modo ataque, sai dele ao deixar a área) são
 * do servidor; aqui ficam só o estado, a transição e a matriz de colisão, para
 * que servidor e predição do cliente não possam discordar sobre quem bate.
 *
 * Matriz (ver shared/layers.ts para o porquê de cada linha):
 *
 *                 cruzeiro     superfície        ataque    em transição
 *   rochas        —            sólidas           —         —
 *   Ceres         —            sólida            —         —
 *   fronteira     sólida       sólida            sólida    sólida
 *   outra nave    mesma camada mesma camada      —         —
 *
 * "Asteroide com estação" na superfície: atravessável se a estação é do dono da
 * nave, sólido se é de outro — quem monta o conjunto por dono é o SimWorld.
 */

/** Camada efetiva do corpo; ausente = cruzeiro, a camada padrão. */
export function layerOf(b: Readonly<Body>): ShipLayer {
  return b.layer ?? "cruise";
}

/** Em transição entre camadas: não colide com nada (e o servidor a trata como invulnerável). */
export function inLayerTransition(b: Readonly<Body>): boolean {
  return !!b.layerTo;
}

/** Colide com os sólidos do mundo (rochas e Ceres)? Só parada na superfície. */
export function collidesWithWorld(b: Readonly<Body>): boolean {
  return !inLayerTransition(b) && layerOf(b) === "surface";
}

/**
 * Grupo de contato casco × casco: naves só se tocam dentro do MESMO grupo. Modo
 * ataque e transição não entram em grupo nenhum — atravessam tudo.
 */
export function hullContactGroup(b: Readonly<Body>): "cruise" | "surface" | null {
  if (inLayerTransition(b)) return null;
  const l = layerOf(b);
  return l === "attack" ? null : l;
}

/**
 * Começa a transição para a camada `to`. Não faz nada (e devolve false) se a
 * nave já está nela ou já está a caminho dela. Uma transição em curso para
 * OUTRA camada é substituída — a nave passa a ir para `to` a partir do zero.
 */
export function beginLayerChange(s: ShipState, to: ShipLayer): boolean {
  if (s.layerTo === to) return false;
  if (!s.layerTo && s.layer === to) return false;
  s.layerTo = to;
  s.layerProgress = 0;
  return true;
}

/**
 * Coloca a nave numa camada NA HORA, sem transição — para os casos em que outra
 * animação já fez a travessia (o pouso e a decolagem têm a própria).
 */
export function setLayer(s: ShipState, layer: ShipLayer): void {
  s.layer = layer;
  s.layerTo = "";
  s.layerProgress = 0;
}

/**
 * Avança a transição em curso por `h` segundos de simulação. Chamado a cada
 * sub-passo de voo — o mesmo h fixo no servidor e na predição —, então a
 * chegada acontece no mesmo sub-passo nos dois lados.
 */
export function advanceLayer(s: ShipState, h: number): void {
  if (!s.layerTo) return;
  s.layerProgress += h / LAYER_TRANSITION_TIME;
  if (s.layerProgress >= 1 - 1e-9) setLayer(s, s.layerTo);
}
