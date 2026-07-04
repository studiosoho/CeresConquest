import { relVec, MINING_RANGE, type ShipInput, type WorldPos } from "@ceres/shared";
import type { SimWorld, ShipState } from "@ceres/sim-core";

/**
 * Jogadores-teste autônomos: naves pilotadas por IA simples no servidor.
 * Só geram ShipInput — passam pelo MESMO sim-core (física, colisão, mineração)
 * que um jogador humano. Comportamento de scout: vagueia pelo cinturão,
 * minera oportunisticamente ao passar perto e desvia de asteroides próximos.
 */
export interface BotState {
  heading: number;
  wanderTimer: number;
}

export function makeBotState(): BotState {
  return { heading: Math.random() * Math.PI * 2, wanderTimer: 0 };
}

/** Vira para longe se a borda do asteroide está a menos disto. */
const AVOID_EDGE = 150;
const TURN_DEADZONE = 0.08;

export function computeBotInput(
  ship: ShipState,
  world: SimWorld,
  bot: BotState,
  dt: number,
): ShipInput {
  // rumo de vagueio muda de tempos em tempos
  bot.wanderTimer -= dt;
  if (bot.wanderTimer <= 0) {
    bot.heading += (Math.random() - 0.5) * 1.5;
    bot.wanderTimer = 2 + Math.random() * 3;
  }

  let desired = bot.heading;
  let mine = false;
  const near = world.nearestAsteroid(ship);
  if (near) {
    const { dx, dy } = relVec(ship, near);
    const edge = Math.hypot(dx, dy) - near.radius;
    if (edge < MINING_RANGE) mine = true;
    if (edge < AVOID_EDGE) desired = Math.atan2(dy, dx) + Math.PI; // afasta-se
  }

  const da = Math.atan2(Math.sin(desired - ship.angle), Math.cos(desired - ship.angle));
  const turn: ShipInput["turn"] = da > TURN_DEADZONE ? 1 : da < -TURN_DEADZONE ? -1 : 0;
  return { thrust: true, turn, mine };
}

/** IA do táxi: menor caminho — linha reta até o destino (voa sem colisão). */
export function computeTaxiInput(ship: ShipState, dest: WorldPos): ShipInput {
  const { dx, dy } = relVec(ship, dest);
  const desired = Math.atan2(dy, dx);
  const da = Math.atan2(Math.sin(desired - ship.angle), Math.cos(desired - ship.angle));
  const turn: ShipInput["turn"] = da > TURN_DEADZONE ? 1 : da < -TURN_DEADZONE ? -1 : 0;
  return { thrust: Math.abs(da) < 1.2, turn, mine: false };
}

/**
 * IA da mineradora auto-mineradora: navega até a estação e minera o asteroide
 * dela. Se já há asteroide ao alcance, minera parada; senão, ruma à estação.
 */
export function computeMinerInput(ship: ShipState, world: SimWorld, station: WorldPos): ShipInput {
  if (world.nearestAsteroid(ship)) {
    return { thrust: false, turn: 0, mine: true };
  }
  const { dx, dy } = relVec(ship, station);
  const desired = Math.atan2(dy, dx);
  const da = Math.atan2(Math.sin(desired - ship.angle), Math.cos(desired - ship.angle));
  const turn: ShipInput["turn"] = da > TURN_DEADZONE ? 1 : da < -TURN_DEADZONE ? -1 : 0;
  return { thrust: Math.abs(da) < 1.2, turn, mine: false };
}
