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
  // 1. Localizar o alvo mais próximo
  const near = world.nearestAsteroid(ship);

  let desiredAngle = bot.heading;
  let thrust = false;
  let mine = false;

  if (near) {
    // Calcular vetor relativo e distância até a superfície do asteroide
    const { dx, dy } = relVec(ship, near);
    const distanceToEdge = Math.hypot(dx, dy) - near.radius;
    const angleToAsteroid = Math.atan2(dy, dx);

    // COMPORTAMENTO DINÂMICO BASEADO NA DISTÂNCIA
    if (distanceToEdge < AVOID_EDGE) {
      // ESTADO: EVITAR COLISÃO (Muito perto!)
      // Aponta para o lado oposto e acelera para fugir do impacto
      desiredAngle = angleToAsteroid + Math.PI;
      thrust = true;

    } else if (distanceToEdge < MINING_RANGE) {
      // ESTADO: MINERAÇÃO (Na distância ideal)
      mine = true;
      // Ajusta o ângulo para ficar de frente para o asteroide enquanto minera
      desiredAngle = angleToAsteroid;

      // Suavização do movimento: só acelera se estiver se afastando demais do alcance
      if (distanceToEdge > MINING_RANGE * 0.7) {
        thrust = true;
      }
      // Dica: Se o seu jogo aceitar "thrust" negativo (ré), você poderia aplicar aqui 
      // caso o bot estivesse deslizando rápido demais em direção ao asteroide.

    } else {
      // ESTADO: APROXIMAÇÃO (Alvo avistado, mas longe)
      desiredAngle = angleToAsteroid;
      thrust = true;
    }

    // Salva o último rumo conhecido do asteroide caso perca o alvo de vista
    bot.heading = desiredAngle;

  } else {
    // ESTADO: VAGUEAR (Nenhum asteroide no mapa)
    bot.wanderTimer -= dt;
    if (bot.wanderTimer <= 0) {
      bot.heading += (Math.random() - 0.5) * 2.0; // Um pouco mais de variação ao vaguear
      bot.wanderTimer = 1.5 + Math.random() * 2;
    }
    desiredAngle = bot.heading;
    thrust = true; // Mantém movimento de busca
  }

  // 2. Controle de Rotação (Sua lógica original com Deadzone)
  const da = Math.atan2(Math.sin(desiredAngle - ship.angle), Math.cos(desiredAngle - ship.angle));
  let turn: ShipInput["turn"] = 0;

  if (da > TURN_DEADZONE) turn = 1;
  else if (da < -TURN_DEADZONE) turn = -1;

  // 3. Otimização de Impulso (Evita gastar combustível/energia girando no próprio eixo)
  // Se o bot precisar fazer uma curva muito fechada (maior que ~45 graus ou 0.8 radianos),
  // ele desliga o motor, gira primeiro, e depois acelera.
  if (Math.abs(da) > 0.8 && !mine) {
    thrust = false;
  }

  return { thrust, turn, mine };
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
