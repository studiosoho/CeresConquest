import {
  shipPhysics,
  cargoLoadFactor,
  relVec,
  type ShipInput,
  type ShipKind,
  type WorldPos,
} from "@ceres/shared";

/**
 * Piloto automático newtoniano.
 *
 * Com física de voo de verdade, o controle "aponta para o alvo e segura o
 * acelerador" que serve num modelo de cursor vira um desastre: a nave passa
 * reto pelo destino a milhares de u/s, faz a volta, passa reto de novo e
 * orbita para sempre. Quem voa por inércia precisa FREAR — e como o único
 * motor é o principal, frear significa apontar o nariz para trás (retrógrado)
 * e queimar. É exatamente isso que este módulo produz, em forma de ShipInput:
 * a IA do servidor não ganha nenhum poder que o jogador não tenha.
 *
 * Puro e reprodutível: só aritmética sobre o estado da nave e do alvo, sem
 * relógio nem sorteio.
 */

/** Estado mínimo que o piloto precisa ler. Toda ShipState satisfaz isto. */
export interface Pilotable extends WorldPos {
  vx: number;
  vy: number;
  angle: number;
  av: number;
  kind: ShipKind;
  /** carga a bordo: entra na conta porque muda a massa (e a frenagem) */
  cargoAmount?: number;
}

/**
 * Sobra de giro se o leme fosse solto agora. O RCS segura a atitude com
 * desaceleração angular CONSTANTE, então a nave ainda roda ω²/(2·a) antes de
 * parar — o piloto desconta isso do erro e assenta no rumo em vez de oscilar
 * em torno dele.
 */
function turnCommand(ship: Pilotable, err: number, hold: number): ShipInput["turn"] {
  const overshoot = (Math.sign(ship.av) * ship.av * ship.av) / (2 * hold);
  const lead = err - overshoot;
  return lead > TURN_DEADZONE ? 1 : lead < -TURN_DEADZONE ? -1 : 0;
}

export interface SeekOptions {
  /** Velocidade de cruzeiro desejada (u/s). Padrão: o teto da classe. */
  cruise?: number;
  /** Raio em torno do alvo em que já se considera chegado (u). */
  arriveRadius?: number;
  /** Multiplicador de empuxo em vigor (táxi = 2×) — entra na curva de frenagem. */
  speedMult?: number;
}

/**
 * Margem da curva de frenagem: o piloto planeja usar só 70% do empuxo
 * disponível para parar. A sobra é o que absorve erro de mira, giro no meio
 * do caminho e um dt maior que o previsto — sem ela a nave chega em cima do
 * alvo ainda a toda e passa reto.
 */
const BRAKE_MARGIN = 0.7;
/** Abaixo deste Δv (u/s) já está bom o bastante: corta o motor. */
const DV_DEADZONE = 12;
/** Erro de atitude (rad) abaixo do qual o leme para de corrigir. */
const TURN_DEADZONE = 0.05;
/** Cone (rad) em que vale a pena empurrar: fora dele o empuxo iria para o lado errado. */
const THRUST_CONE = 0.5;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * POR QUE O PILOTO AUTOMÁTICO NÃO USA O RCS DE TRANSLAÇÃO.
 *
 * Ele PODE — `ShipInput.strafe`/`retro` são do jogador e da IA igualmente, sem
 * nada exclusivo de nenhum dos dois. Foi implementado e medido, em quatro
 * variantes (RCS sempre; só com o motor cortado; só na fase terminal; só quando
 * o erro é lateral), no percurso padrão dos testes, com o critério "estacionar
 * dentro de 250 u abaixo de 40 u/s":
 *
 *   classe      sem RCS   sempre   só sem motor   só terminal
 *   builder      13,85     14,35      14,50         14,20
 *   mining       16,30     16,97      16,97         16,67
 *   attack       11,57     12,32      12,35         11,95
 *   transport    22,70     23,62      23,80         23,10
 *
 * Todas as variantes FICARAM MAIS LENTAS, 3–6%. O motivo é estrutural e está
 * logo abaixo, em `seekInput`: a curva de frenagem resolve `s = v·t_virar +
 * v²/(2a)` para um ÚNICO eixo de empuxo. Empurrar de lado durante o cruzeiro
 * acrescenta velocidade que o plano não previu, e o piloto chega quente e
 * precisa assentar. O RCS só ganhou (−10% no caça) num intercepto puramente
 * lateral, que não é o caso comum.
 *
 * Ou seja: aproveitar o RCS aqui exige REESCREVER a lei de guiamento para duas
 * autoridades de empuxo, não pendurar dois campos no comando. Isso é uma
 * mudança de projeto, não um ajuste, e não se faz sem pedir. Fica registrado
 * com número em vez de virar um "melhoramento" que ninguém mediu.
 */

/**
 * Comando para chegar a `target` e PARAR lá, respeitando a inércia do casco.
 *
 * O método é o clássico "velocidade desejada − velocidade atual":
 *  1. a velocidade desejada aponta para o alvo, com módulo limitado pela curva
 *     de frenagem v = √(2·a·s) — a maior velocidade da qual ainda dá para
 *     parar na distância que resta;
 *  2. o Δv entre ela e a velocidade real é a direção em que o motor precisa
 *     empurrar. Longe do alvo isso aponta para frente; chegando, aponta para
 *     trás sozinho, e a nave faz a manobra de frenagem retrógrada sem nenhum
 *     caso especial escrito à mão;
 *  3. o leme mira nesse Δv com COMPENSAÇÃO DE INÉRCIA (ver `turnCommand`).
 *
 * Carga a bordo entra na conta: um cargueiro cheio acelera e freia 1/1,5 do
 * que acelera e freia vazio, e o piloto começa a frear mais cedo por isso.
 */
export function seekInput(ship: Pilotable, target: WorldPos, opts: SeekOptions = {}): ShipInput {
  const p = shipPhysics(ship.kind);
  const load = cargoLoadFactor(ship.kind, ship.cargoAmount ?? 0);
  const mult = opts.speedMult ?? 1;
  const accel = (p.accel / load) * mult;
  const cruise = Math.min(opts.cruise ?? Infinity, p.maxSpeed * mult);

  const { dx, dy } = relVec(ship, target);
  const d = Math.hypot(dx, dy);
  const remaining = Math.max(0, d - (opts.arriveRadius ?? 0));

  // Curva de frenagem, com o TEMPO DE VIRAR embutido. `v² = 2·a·s` sozinho
  // supõe que o freio liga na hora; mas o único motor aponta para a frente, e
  // apontá-lo para trás custa até meia volta — 2,7 s no cargueiro. Ignorar isso
  // faz a nave lenta chegar rápido demais, passar do alvo e orbitar. Resolvendo
  // `s = v·t_virar + v²/(2a)` em v:
  const brake = accel * BRAKE_MARGIN;
  const flip = Math.PI / p.maxTurnRate; // pior caso: inverter a atitude
  const approach = Math.min(
    cruise,
    brake * (Math.sqrt(flip * flip + (2 * remaining) / brake) - flip),
  );
  const inv = d > 1e-6 ? 1 / d : 0;
  const dvx = dx * inv * approach - ship.vx;
  const dvy = dy * inv * approach - ship.vy;

  if (Math.hypot(dvx, dvy) < DV_DEADZONE) {
    return { thrust: false, turn: 0, mine: false };
  }

  const err = wrap(Math.atan2(dvy, dvx) - ship.angle);
  const turn = turnCommand(ship, err, p.attitudeHold / load);
  return { thrust: Math.abs(err) < THRUST_CONE, turn, mine: false };
}

/**
 * Comando só de atitude: aponta o nariz para um rumo e segura lá, com a mesma
 * compensação de inércia do `seekInput`. Útil para quem precisa mirar sem sair
 * do lugar.
 */
export function faceInput(ship: Pilotable, heading: number, thrust = false): ShipInput {
  const p = shipPhysics(ship.kind);
  const load = cargoLoadFactor(ship.kind, ship.cargoAmount ?? 0);
  const err = wrap(heading - ship.angle);
  const turn = turnCommand(ship, err, p.attitudeHold / load);
  return { thrust: thrust && Math.abs(err) < THRUST_CONE, turn, mine: false };
}
