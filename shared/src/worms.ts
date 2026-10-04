/**
 * MINHOCAS GIGANTES — o núcleo de Ceres é um NINHO. Ele acorda quando um
 * jogador evolui uma estação de mineração de Ceres ao nível WORM_WAKE_LEVEL:
 * a terra começa a tremer (alertas ao dono em WORM_QUAKE_WARN_TIME e
 * WORM_QUAKE_DANGER_TIME) e, em WORM_QUAKE_BREACH_TIME, a minhoca rompe a
 * cratera — a estação explode com as naves do hangar e a primeira minhoca sai
 * na hora. A cratera fica como a TOCA (o buraco de saída, na mesma
 * plataforma). A partir daí, de tempos em tempos (WORM_SPAWN_INTERVAL, até
 * WORM_MAX vivas), uma minhoca sai da toca e caça — estruturas e naves dos
 * jogadores e também os bots; sem presa ao alcance, vagueia SALTANDO da borda
 * de Ceres para as rochas mais próximas e voltando pelo mesmo caminho.
 * Passado WORM_ROAM_TIME, volta para a toca, fica lá WORM_DEN_TIME e sobe
 * para uma nova ronda — enquanto a toca estiver aberta.
 *
 * ATAQUE: numa estrutura ela faz INVESTIDAS — entra pela lateral da rocha,
 * mergulha rumo à estrutura e passa RASPANDO ao lado dela (WORM_RAM_DAMAGE,
 * sorteado entre o prédio e as naves do hangar), afasta-se até
 * WORM_RAM_RETREAT, dá a volta e investe de novo; por WORM_SIEGE_TIME — depois
 * procura outra presa. Cada investida tem WORM_CRIT_CHANCE de ser CRÍTICA: em
 * vez de raspar, ela vai no CENTRO da estrutura, que é destruída inteira. Nave ela engole inteira. Quem a fere (turreta ou nave)
 * vira o alvo: ela se volta contra o atacante mais perto.
 *
 * DUAS CAMADAS. Ela navega no FUNDO (a camada Z do centro dos asteroides:
 * por dentro das rochas e, entre elas, nessa mesma profundidade) e ali só
 * alcança o que está no nível das estruturas (estruturas, naves pousadas,
 * atracadas, na superfície ou em modo ataque). Chegando perto do CENTRO de
 * uma rocha ela DECIDE: segue para a estação ou sai na DIAGONAL, subindo até
 * a camada de CRUZEIRO, atrás das naves de ataque que voam ali perto
 * (WORM_CHASE_RANGE; com estação em jogo, WORM_CHASE_CHANCE — certeza se uma
 * delas a feriu). No cruzeiro ela persegue as naves em cruzeiro por até
 * WORM_CHASE_TIME e depois MERGULHA de novo para o fundo. Subir e descer
 * levam 1/WORM_CLIMB_RATE s — andando, a rampa é diagonal; o corpo refaz
 * a rampa da cabeça. No cruzeiro o corpo todo fica exposto.
 *
 * TAPAR A TOCA: naves de ataque entram no modo ataque sobre o buraco ([F]),
 * lançam minas nele (elas param dentro do buraco) e detonam as minas com
 * mísseis — a detonação de uma leva todas as que estão no buraco. Somadas
 * WORM_HOLE_SEAL_MINES minas detonadas, a toca desaba: nenhuma minhoca sai
 * mais, as que estão fora se enterram em Ceres ao fim da ronda, e a
 * plataforma volta a aceitar construção (e um novo nível 2 reabre o ciclo).
 *
 * Como as minhocas de Duna, ela viaja ENTERRADA nos corpos (Ceres, rochas) e
 * sobrevive no vácuo: entre um corpo e outro, SALTA — o corpo exposto fica
 * no espaço, onde pode ser atingido e onde quem bate nele toma dano. A
 * CABEÇA engole inteira a nave que alcança; numa estrutura, morde
 * (WORM_BITE_DAMAGE a cada WORM_BITE_INTERVAL). Pode morrer (WORM_HP).
 *
 * O corpo é uma corrente de WORM_SEGMENTS gomos, cada um a WORM_SPACING do
 * anterior (segue a cabeça como um trem); o raio afina da cabeça à cauda.
 */

/** gomos do corpo (o 0 é a cabeça) */
export const WORM_SEGMENTS = 26;
/** distância entre gomos (u) */
export const WORM_SPACING = 170;
/** raio do corpo junto à cabeça e na ponta da cauda (u) */
export const WORM_HEAD_RADIUS = 210;
export const WORM_TAIL_RADIUS = 70;
/** a nave cujo centro entra neste raio da cabeça é engolida inteira */
export const WORM_MOUTH_RADIUS = 260;
/** velocidade de caça (u/s) — as naves em cruzeiro ainda conseguem fugir */
export const WORM_SPEED = 2200;
/** giro máximo da cabeça (rad/s) */
export const WORM_TURN_RATE = 1.3;
export const WORM_HP = 1500;
/** dano de cada investida que toca a estrutura (sorteado entre o prédio e o hangar) */
export const WORM_RAM_DAMAGE = 120;
/** chance de uma investida ser crítica (vai no centro e destrói a estrutura inteira) */
export const WORM_CRIT_CHANCE = 0.1;
/** decisão no centro da rocha: naves de ataque em cruzeiro a até esta distância da cabeça a atraem (u) */
export const WORM_CHASE_RANGE = 12000;
/** com uma estação em jogo, a chance de trocá-la pelas naves de ataque (vingança: sempre) */
export const WORM_CHASE_CHANCE = 0.5;
/** tempo máximo de perseguição no cruzeiro antes de mergulhar de volta (s) */
export const WORM_CHASE_TIME = 20;
/** subida/descida entre o fundo e o cruzeiro, em fração da altura por s */
export const WORM_CLIMB_RATE = 0.5;
/** a cabeça decide perto do centro da rocha: a até esta fração do raio dela (mínimo WORM_DECIDE_MIN) */
export const WORM_DECIDE_FRACTION = 0.5;
export const WORM_DECIDE_MIN = 1000;
/** depois do toque, ela se afasta até esta distância além do corpo do prédio e dá a volta (u) */
export const WORM_RAM_RETREAT = 3000;
/** quanto tempo ela fica circulando uma estrutura antes de procurar outra presa (s) */
export const WORM_SIEGE_TIME = 25;
/** um atacante continua sendo lembrado como alvo de vingança por este tempo (s) */
export const WORM_REVENGE_MEMORY = 6;
/** tremores depois do nível 2 em Ceres: 1º alerta, 2º alerta e a cratera rompendo (s) */
export const WORM_QUAKE_WARN_TIME = 40;
export const WORM_QUAKE_DANGER_TIME = 60;
export const WORM_QUAKE_BREACH_TIME = 70;
/** dano em quem bate no corpo exposto, no máximo uma vez por WORM_BODY_COOLDOWN por nave */
export const WORM_BODY_DAMAGE = 15;
export const WORM_BODY_COOLDOWN = 1;
/** alcance do faro: alvos além disto são ignorados (u) */
export const WORM_SENSE_RANGE = 30_000;
/** intervalo entre uma minhoca e a seguinte (s); a primeira sai junto com a cratera */
export const WORM_SPAWN_INTERVAL = 240;
/** minhocas vivas ao mesmo tempo */
export const WORM_MAX = 2;

/** nível da estação de Ceres que acorda o ninho */
export const WORM_WAKE_LEVEL = 2;
/** tempo de ronda de cada minhoca fora da toca (s) */
export const WORM_ROAM_TIME = 150;
/** descanso dentro da toca entre uma ronda e a próxima (s) */
export const WORM_DEN_TIME = 50;
/** id do alvo do modo ataque sobre a toca */
export const WORM_HOLE_ID = "wormhole";
/** raio do buraco: a mina que chega aqui para dentro dele (u) */
export const WORM_HOLE_RADIUS = 650;
/** minas detonadas no buraco para tapá-lo */
export const WORM_HOLE_SEAL_MINES = 3;

/** Raio do gomo `i` (0 = cabeça): afina até a cauda. */
export function wormRadiusAt(i: number): number {
  const t = i / (WORM_SEGMENTS - 1);
  return WORM_HEAD_RADIUS + (WORM_TAIL_RADIUS - WORM_HEAD_RADIUS) * t * t;
}
