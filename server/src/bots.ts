import {
  relVec,
  MINING_RANGE,
  DOCK_RANGE,
  TAXI_SPEED_MULT,
  type ShipInput,
  type WorldPos,
} from "@ceres/shared";
import { seekInput, faceInput, type SimWorld, type ShipState } from "@ceres/sim-core";

/**
 * Jogadores-teste autônomos: naves pilotadas por IA simples no servidor.
 * Só geram ShipInput — passam pelo MESMO sim-core (física, colisão, mineração)
 * que um jogador humano. Comportamento de scout: vagueia pelo cinturão,
 * minera oportunisticamente ao passar perto e desvia de asteroides próximos.
 */
/**
 * FROTA DOS BOTS: naves de ataque produzidas pelo QG dos bots em Ceres (uma a
 * cada BOT_BUILD_INTERVAL, até BOT_FLEET_MAX — as vagas do QG). Cada uma vive
 * num ciclo:
 *  - "raid": voa até a estrutura de jogador mais perto, desce ao modo ataque
 *    sobre ela e dispara os BOT_AMMO mísseis que leva;
 *  - "return": sem munição (ou sem alvo), volta ao QG e pousa numa vaga;
 *  - "reload": atracada, recarrega em BOT_RELOAD_TIME s, conserta o casco
 *    (BOT_REPAIR_TIME do zero ao cheio) e espera na vaga.
 *
 * ATAQUE EM ONDA: os bots prontos (atracados, recarregados e consertados) só saem em GRUPO
 * — quando BOT_WAVE_SIZE deles estão prontos e há alvo, saem juntos, no mesmo
 * instante. Sozinho, um bot caía nas turretas antes de o próximo existir.
 */
export interface BotState {
  heading: number;
  wanderTimer: number;
  phase: "raid" | "return" | "reload";
  /** s que faltam para terminar a recarga (fase "reload") */
  reload: number;
  /** próximo disparo permitido (s de partida) — o bot atira mais devagar que o jogador */
  nextShot: number;
  /** sentido em que circula a estação no modo ataque (como A/D do jogador) */
  orbitDir: -1 | 1;
}

/** Dono das naves e do QG dos bots (as estruturas de jogador têm o sessionId). */
export const BOT_OWNER = "";
/** Frota máxima — o número de vagas do QG. */
export const BOT_FLEET_MAX = 6;
/** Intervalo de produção de um bot novo no QG (s). */
export const BOT_BUILD_INTERVAL = 120;
/** Mísseis por saída. */
export const BOT_AMMO = 2;
/** Recarga atracado no QG (s). */
export const BOT_RELOAD_TIME = 60;
/** Conserto atracado no QG: tempo para ir de 0 ao HP cheio (s); proporcional ao dano. */
export const BOT_REPAIR_TIME = 120;
/** Bots por grupo de ataque. */
export const BOT_WAVE_SIZE = 3;
/** Intervalo entre disparos (s). */
export const BOT_FIRE_INTERVAL = 1.2;
/** Erro de mira (rad) abaixo do qual o bot dispara. */
export const BOT_AIM_TOLERANCE = 0.02;

/** Bot recém-produzido: já armado, atracado, pronto para sair. */
export function makeBotState(): BotState {
  return {
    heading: Math.random() * Math.PI * 2, wanderTimer: 0, phase: "reload", reload: 0, nextShot: 0,
    orbitDir: Math.random() < 0.5 ? -1 : 1,
  };
}

/** Vira para longe se a borda do asteroide está a menos disto. */
const AVOID_EDGE = 150;

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
      // Voando por inércia, "acelerar até chegar" acaba em espatifada na
      // rocha: o piloto automático planeja a frenagem e estaciona à distância
      // de mineração.
      bot.heading = angleToAsteroid;
      return seekInput(ship, near, { arriveRadius: near.radius + MINING_RANGE * 0.6 });
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

  // 2. Controle de Rotação — via faceInput, que compensa a INÉRCIA angular.
  // Com momento de inércia, um leme liga/desliga puro passa do rumo e volta,
  // oscilando; faceInput desconta a sobra de giro e assenta no rumo.
  const da = Math.atan2(Math.sin(desiredAngle - ship.angle), Math.cos(desiredAngle - ship.angle));

  // 3. Otimização de Impulso (Evita gastar combustível/energia girando no próprio eixo)
  // Se o bot precisar fazer uma curva muito fechada (maior que ~45 graus ou 0.8 radianos),
  // ele desliga o motor, gira primeiro, e depois acelera.
  if (Math.abs(da) > 0.8 && !mine) {
    thrust = false;
  }

  const { turn } = faceInput(ship, desiredAngle);
  return { thrust, turn, mine };
}

/**
 * IA do táxi: linha reta até o destino (voa sem colisão), mas com FRENAGEM.
 * Sem isto a nave passaria reto pela janela de atracação a alguns milhares de
 * u/s e orbitaria a estrutura para sempre — a inércia não perdoa piloto que
 * só sabe acelerar. Chega devagar, dentro do DOCK_RANGE.
 */
export function computeTaxiInput(ship: ShipState, dest: WorldPos): ShipInput {
  return seekInput(ship, dest, {
    speedMult: TAXI_SPEED_MULT,
    arriveRadius: DOCK_RANGE * 0.5,
  });
}

/**
 * IA da mineradora auto-mineradora: navega até a estação e minera o asteroide
 * dela. Se já há asteroide ao alcance, minera parada; senão, ruma à estação.
 */
export function computeMinerInput(ship: ShipState, world: SimWorld, station: WorldPos): ShipInput {
  if (world.nearestAsteroid(ship)) {
    return { thrust: false, turn: 0, mine: true };
  }
  // navega até a estação e PARA lá (frenagem retrógrada inclusa)
  return seekInput(ship, station, { arriveRadius: MINING_RANGE * 0.5 });
}
