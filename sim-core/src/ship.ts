import {
  SHIP_THRUST,
  SHIP_MAX_SPEED,
  SHIP_TURN_RATE,
  SHIP_DRAG,
  normalizePos,
  type ShipInput,
  type ShipKind,
  type WorldPos,
} from "@ceres/shared";

/** Estado de uma nave na simulação. Sem nada de renderização. */
export interface ShipState extends WorldPos {
  vx: number;
  vy: number;
  angle: number;
  ore: number;
  mining: boolean;
  /** sessionId do dono ("" = neutra) */
  owner: string;
  kind: ShipKind;
  /** ancorada no QG (congelada, pode produzir) */
  anchored: boolean;
}

export function makeShip(pos: WorldPos, owner = "", kind: ShipKind = "builder"): ShipState {
  return {
    sx: pos.sx,
    sy: pos.sy,
    x: pos.x,
    y: pos.y,
    vx: 0,
    vy: 0,
    angle: 0,
    ore: 0,
    mining: false,
    owner,
    kind,
    anchored: false,
  };
}

/**
 * Integra um passo de física da nave. Determinística e pura de efeitos —
 * usada pelo servidor (autoritativo) e pelo cliente (predição local).
 */
export function stepShip(s: ShipState, input: ShipInput, dt: number): void {
  s.angle += input.turn * SHIP_TURN_RATE * dt;

  if (input.thrust) {
    s.vx += Math.cos(s.angle) * SHIP_THRUST * dt;
    s.vy += Math.sin(s.angle) * SHIP_THRUST * dt;
  }

  const drag = Math.exp(-SHIP_DRAG * dt);
  s.vx *= drag;
  s.vy *= drag;

  const speed = Math.hypot(s.vx, s.vy);
  if (speed > SHIP_MAX_SPEED) {
    const k = SHIP_MAX_SPEED / speed;
    s.vx *= k;
    s.vy *= k;
  }

  s.x += s.vx * dt;
  s.y += s.vy * dt;
  normalizePos(s);
}
