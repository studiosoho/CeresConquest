import {
  SHIP_THRUST,
  SHIP_MAX_SPEED,
  SHIP_TURN_RATE,
  SHIP_DRAG,
  THRUST_RAMP_TIME,
  THRUST_RAMP_MIN,
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
  mining: boolean;
  /** sessionId do dono ("" = neutra) */
  owner: string;
  kind: ShipKind;
  /** ancorada no QG (congelada, pode produzir/trocar) */
  anchored: boolean;
  /** estrutura de origem (hangar). "" = sem hangar (ex.: builder inicial) */
  hqId: string;
  /** asteroide onde o builder está pousado para minerar ("" = nenhum) */
  anchoredAsteroidId: string;
  /** guardada no hangar (fora do mundo: não simula nem renderiza) */
  stored: boolean;
  /** mineradora configurada para minerar sozinha numa estação */
  autoMining: boolean;
  /** estação à qual a mineradora está atrelada ("" = nenhuma) */
  stationId: string;
  /** táxi: estrutura de destino em trânsito ("" = não está indo a lugar nenhum) */
  taxiTo: string;
  /** rampa de empuxo 0..1 — sobe suavemente enquanto acelera (leve aceleração) */
  thrustRamp: number;
  /** vaga de hangar ocupada (-1 = nenhuma) */
  bay: number;
  /**
   * Fase de pouso/decolagem do builder num asteroide vazio.
   * "" = nenhuma, "landing" = descendo, "landed" = pousado, "liftoff" = subindo
   */
  landingPhase: "" | "landing" | "landed" | "liftoff";
  /** progresso da animação 0..1 */
  landingProgress: number;
  /** posição alvo dentro do asteroide (ponto de pouso) */
  landingTargetX: number;
  landingTargetY: number;
  /** posição de origem antes do pouso (para animação) */
  landingOriginX: number;
  landingOriginY: number;
  /** velocidade angular do asteroide hospedeiro (rad/s) — nave gira junto */
  landingAsteroidSpin: number;
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
    mining: false,
    owner,
    kind,
    anchored: false,
    hqId: "",
    anchoredAsteroidId: "",
    stored: false,
    autoMining: false,
    stationId: "",
    taxiTo: "",
    thrustRamp: 0,
    bay: -1,
    landingPhase: "",
    landingProgress: 0,
    landingTargetX: 0,
    landingTargetY: 0,
    landingOriginX: 0,
    landingOriginY: 0,
    landingAsteroidSpin: 0,
  };
}

/**
 * Integra um passo de física da nave. Determinística e pura de efeitos —
 * usada pelo servidor (autoritativo) e pelo cliente (predição local).
 *
 * `speedMult` escala empuxo e velocidade máxima (táxi = 2×).
 */
export function stepShip(s: ShipState, input: ShipInput, dt: number, speedMult = 1): void {
  s.angle += input.turn * SHIP_TURN_RATE * dt;

  // leve aceleração: o empuxo sobe de RAMP_MIN a 100% ao segurar acelerar
  if (input.thrust) {
    s.thrustRamp = Math.min(1, s.thrustRamp + dt / THRUST_RAMP_TIME);
    const power = THRUST_RAMP_MIN + (1 - THRUST_RAMP_MIN) * s.thrustRamp;
    s.vx += Math.cos(s.angle) * SHIP_THRUST * speedMult * power * dt;
    s.vy += Math.sin(s.angle) * SHIP_THRUST * speedMult * power * dt;
  } else {
    s.thrustRamp = Math.max(0, s.thrustRamp - dt * 3);
  }

  const drag = Math.exp(-SHIP_DRAG * dt);
  s.vx *= drag;
  s.vy *= drag;

  const maxSpeed = SHIP_MAX_SPEED * speedMult;
  const speed = Math.hypot(s.vx, s.vy);
  if (speed > maxSpeed) {
    const k = maxSpeed / speed;
    s.vx *= k;
    s.vy *= k;
  }

  s.x += s.vx * dt;
  s.y += s.vy * dt;
  normalizePos(s);
}
