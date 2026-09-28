// Constantes do mundo. 1 unidade ≈ 1 km na escala do jogo (mapa 1:10 do sistema solar).
import { BELT_WIDTH } from "./scale";

/** Lado de um setor da grade, em unidades. */
export const SECTOR_SIZE = 10_000;

/** Raio do centro do cinturão a partir do Sol, em setores (~Ceres a 1:10). */
export const BELT_CENTER_SECTORS = 4_155;

/** Cinturão: anel fino de espessura BELT_WIDTH (≈ 10 diâmetros do maior asteroide). */
const BELT_HALF_WIDTH_SECTORS = BELT_WIDTH / 2 / SECTOR_SIZE;
export const BELT_INNER_SECTORS = BELT_CENTER_SECTORS - BELT_HALF_WIDTH_SECTORS;
export const BELT_OUTER_SECTORS = BELT_CENTER_SECTORS + BELT_HALF_WIDTH_SECTORS;

// ── Nave: voo newtoniano ─────────────────────────────────────────────
// O vácuo NÃO tem arrasto. Aqui não existe termo de atrito com o meio: o que
// muda a velocidade é empuxo (aceleração ao longo do nariz) e impacto. O que
// muda a atitude é torque (aceleração ANGULAR — a nave tem momento de inércia,
// não é um cursor). Os números POR CLASSE (massa, inércia, empuxo, torque)
// vivem em `shared/src/ships.ts` → SHIP_PHYSICS; aqui ficam só os globais.

/** Empuxo de referência — o do builder. Base da escala de empuxo das classes. */
export const SHIP_THRUST = 1200; // força; aceleração = empuxo / massa (u/s²)
/** Velocidade de projeto de referência — a do builder (unidades/s). */
export const SHIP_MAX_SPEED = 5200;

/**
 * NÃO EXISTE FREIO ESCONDIDO NESTE MODELO.
 *
 * A velocidade de projeto de cada casco (`maxSpeed` em SHIP_PHYSICS) é um
 * LIMITADOR DE EMPUXO, não uma força de frenagem: o computador de bordo corta
 * o motor quando não há mais folga até a velocidade nominal. Nada é subtraído
 * da nave — só deixa de ser somado. As consequências são visíveis e
 * explicáveis pelo jogador:
 *  · uma nave que chegue ACIMA da nominal (quique, fim do modo táxi) MANTÉM
 *    essa velocidade; o motor apenas não a aumenta mais, e ela ainda pode
 *    empurrar de lado ou de ré para se recompor;
 *  · nenhuma desaceleração aparece na ficha da nave sem estar na ficha.
 * A versão anterior fazia o excedente decair a 6·(v−teto), o que a 7000 u/s
 * valia 8,8× o próprio motor — arrasto disfarçado. Foi removida.
 */

/**
 * Trim do RCS: frenagem ASSISTIDA de autoridade limitada, em força (a
 * desaceleração por classe é esta força / massa efetiva). Isto é AUXÍLIO DE
 * JOGABILIDADE explícito, não física — deriva total é fiel mas frustrante num
 * RTS. É a ÚNICA desaceleração não pedida pelo jogador em todo o modelo, ela
 * é constante (não proporcional à velocidade) e vale 30/massa u/s²: 0,6 %/s a
 * 5000 u/s (ruído em cruzeiro) e o suficiente para encostar numa vaga sem
 * duelar com a inércia.
 */
export const SHIP_ASSIST_FORCE = 30;

/**
 * Autoridade do RCS para SEGURAR a atitude, como fração do torque de manobra.
 * Também é auxílio de pilotagem, e do mesmo tipo do trim linear: desaceleração
 * angular CONSTANTE, vinda dos mesmos propulsores que giram a nave, com
 * autoridade menor que a de manobra. Um rodopio de impacto de 3 rad/s leva
 * ~0,6 s (builder) para ser anulado — dá para ver o computador trabalhando,
 * em vez de o momento angular sumir sozinho.
 */
export const RCS_ATTITUDE_HOLD = 0.5;

/**
 * Sub-passo FIXO do integrador (s). Não é "o dt fatiado": é o passo real com
 * que a física roda, sempre, e o `dt` do frame só decide QUANTOS deles cabem.
 *
 * O esquema anterior fatiava (n = ceil(dt/passo), h = dt/n) e este comentário
 * afirmava que os dois lados caíam em h = 1/120. Não caíam: um frame real de
 * 16,667 ms é um fio maior que 1/60, o `ceil` subia para n = 3 e h virava
 * 5,556 ms; o tick de 50 ms do servidor dava h = 8,333 ms. Sete microssegundos
 * a mais no frame derrubavam o passo em 33%, e cliente e servidor integravam
 * diferente — justamente o que o sub-passo fixo existia para impedir.
 *
 * Agora quem manda é um acumulador com resíduo carregado entre chamadas
 * (`drainSubsteps`, em sim-core/src/ship.ts): sobra do frame anterior + dt novo,
 * roda o número inteiro de sub-passos de 1/120 que couber, guarda o resto. A
 * 20 Hz saem 6 por tick e a 60 Hz saem 2 por frame, com h IDÊNTICO, e uma taxa
 * de quadros irregular só muda a distribuição, nunca o passo.
 */
export const PHYSICS_SUBSTEP = 1 / 120;

/**
 * NÃO EXISTE MAIS UM TETO DE SUB-PASSOS POR CHAMADA.
 *
 * Existia: `PHYSICS_MAX_SUBSTEPS = 32`, com um ramo em `drainSubsteps` que
 * descartava o excedente. Era CÓDIGO MORTO, e dá para provar em uma linha: o
 * acumulador nunca guarda mais que o teto de pendência abaixo, ou seja, no
 * máximo 30 sub-passos. O ramo dos 32 nunca rodava, nunca foi exercitado por
 * teste nenhum, e um limite que não limita é pior que nenhum: dá a impressão de
 * haver uma rede embaixo.
 *
 * O mecanismo é UM só, e é o teto de PENDÊNCIA logo abaixo — aplicado nas três
 * entradas da simulação (SimWorld.tick, stepShipInWorld, stepShip). O pior caso
 * de custo por chamada é PIOR_CASO_SUBPASSOS, derivado dele, e há teste
 * travando esse número.
 */

/**
 * TETO DO TEMPO PENDENTE (s) numa chamada de física — servidor E cliente. O
 * limite é sobre `atraso carregado + dt novo`, e não sobre o `dt` sozinho.
 *
 * A distinção é o conserto desta rodada, e ela vale um número: com
 * `min(dt, teto)` o excedente do quadro era DESCARTADO, então cinco chamadas de
 * 0,2 s (5 fps) entregavam 339,38 u/s onde dez de 0,1 s entregavam 885,00 —
 * metade do tempo de parede simplesmente sumia, e a predição do cliente
 * escorregava para trás do servidor POR CONSTRUÇÃO, com nada além do blend para
 * ressincronizar. O acumulador de passo fixo existe justamente para carregar
 * tempo entre chamadas; o clamp de dt jogava fora o que ele deveria carregar.
 *
 * Agora o excedente fica no acumulador e é gasto nas chamadas seguintes, e o
 * teto passa a ser do ATRASO: o que não couber em 0,25 s de pendência é perdido
 * de uma vez, declaradamente. Um tick de 3 s injeta 0,25 s de mundo, não 3 s —
 * o servidor continua sem poder saltar à frente da predição por um stall de GC,
 * e um cliente a 4 fps ou mais não perde nada.
 *
 * O teto é aplicado DENTRO da simulação (SimWorld.tick, stepShipInWorld,
 * stepShip), não só em quem chama — durante meses ele existia no render loop do
 * cliente e faltava no servidor. Vale para física, mineração e produção ao mesmo
 * tempo, porque o SimWorld usa como dt da economia o tempo que a física
 * REALMENTE gastou (steps × PHYSICS_SUBSTEP).
 *
 * Preço, medido no tick completo do SimWorld com 60 caças em voo no cinturão
 * (máquina de desenvolvimento, Node 22): tick(0,25) = 30 sub-passos, mediana
 * 10,7 ms e pior de 20 amostras 21,3 ms, contra 1,6 ms do tick de regime
 * (0,05 s). Cabe no orçamento de 50 ms — e só acontece depois de um engasgo.
 */
export const SIM_MAX_DT = 0.25;

/**
 * Pior caso de sub-passos numa chamada de física, DERIVADO do teto de pendência:
 * o acumulador nunca guarda mais que SIM_MAX_DT, então a conta é exata (não há
 * mais o "+1" do resíduo, porque o resíduo agora está DENTRO do teto). Não é um
 * limite imposto a nada — é a conta de custo, e existe para que o orçamento por
 * tick seja um número conferível em vez de uma suposição. Vale 30.
 */
export const PHYSICS_WORST_CASE_SUBSTEPS = Math.floor(SIM_MAX_DT / PHYSICS_SUBSTEP);

// rampa de empuxo: o motor faz spool de RAMP_MIN até 100% (tempo por classe)
export const THRUST_RAMP_MIN = 0.4; // fração inicial do empuxo
export const THRUST_SPOOL_DOWN_RATE = 3; // frações de spool perdidas por segundo

// ── Impacto ───────────────────────────────────────────────────────────
// Resposta de colisão por IMPULSO com restituição: e = 0 é perfeitamente
// inelástico (a nave gruda e escorrega), e = 1 devolve toda a energia. A
// restituição efetiva é `casco (por classe) × superfície (abaixo)`.
//
// Asteroide, Ceres e fronteira são tratados como PAREDE IMÓVEL, e ponto: a
// simulação nunca move um asteroide (ele é procedural, recalculado da semente
// — não há onde guardar um recuo), então fingir troca de momento entre dois
// corpos seria descontar um recuo que não acontece. Nave × nave, aí sim, é
// impulso de dois corpos de verdade — lá os dois recuam mesmo (collideShipPair).

/** Fator da rocha nua: o asteroide é a superfície mais elástica do jogo. */
export const ASTEROID_SURFACE_RESTITUTION = 1.0;
/** Ceres é enorme e coberto de regolito: absorve boa parte do impacto. */
export const CERES_SURFACE_RESTITUTION = 0.7;
/** Fronteira da arena é campo de contenção: devolve pouco, só não deixa sair. */
export const BOUNDARY_SURFACE_RESTITUTION = 0.35;

/**
 * ATRITO É DE COULOMB: |jt| ≤ μ·|jn|. O impulso tangencial não tem vida
 * própria — ele é o que o impulso NORMAL sustenta, e nada além disso.
 *
 * A versão anterior era `jt = 0,06 · vt` e NÃO olhava para a normal. Medido:
 * com vn = −0,2 u/s a razão |jt|/|jn| dava 565, e o MESMO Δvt = −113,09 saía de
 * vn = −2000 e de vn = −0,2. Isso não é atrito, é um amortecedor viscoso ligado
 * à tangente: encostar de leve custava tanto quanto capotar. Era ele que
 * transformava a fronteira da arena em papel mata-mosca (ver
 * BOUNDARY_SURFACE_FRICTION).
 *
 * Com o limite, o contato tem os dois regimes de verdade:
 *  · GRUDA — quando μ·|jn| dá conta, o deslizamento da casca morre inteiro
 *    (Δvt = −vt_casca) e o resultado depende de ω, como manda ω×r;
 *  · DESLIZA — quando não dá, sai exatamente μ·|jn|, no sentido do escorregão.
 *    Aí a MAGNITUDE não depende mais do escorregão (é assim o atrito seco), mas
 *    o SENTIDO sim: uma casca girando rápido o bastante é arrastada ao
 *    contrário.
 *
 * SOBRE OS VALORES. São números de atrito seco plausíveis — metal raspando
 * rocha, regolito, metal —, escolhidos pelo que fazem com a TRANSLAÇÃO. O giro
 * que o impulso tangencial imprime é consequência (Δω = R·jt/k², e com a massa
 * concentrada — k de 10 a 19 u, ver ships.ts — o mesmo impulso gira bastante),
 * e quem o contém é o TETO de giro (IMPACT_SPIN_MAX), auxílio declarado.
 *
 * Por uma rodada estes valores foram rebaixados a (12/26)² ≈ 0,21 do que são,
 * para que o giro de impacto de cruzeiro continuasse em ~3 rad/s depois que k
 * encolheu para caber no casco. O atrito linear foi junto e ficou abaixo de
 * gelo sobre gelo: raspão do caça a 6000 u/s e 30° perdia 46 u/s de tangente
 * (219 antes), e a nave prensada de nariz contra Ceres a pleno empuxo por 2 s
 * saía MAIS rápida, 1000 → 1026 u/s (816 antes). Calibrar giro às custas do
 * atrito linear é trocar um erro por outro; o giro tem o teto para isso.
 */
/** Rocha nua: metal contra rocha — agarra menos que o regolito, mais que casco × casco. */
export const ASTEROID_SURFACE_FRICTION = 0.07;
/** Regolito de Ceres: solto, a nave enterra um pouco — a superfície que MAIS agarra. */
export const CERES_SURFACE_FRICTION = 0.09;
/**
 * Fronteira da arena: ZERO, e não por conveniência. Ela é um campo de
 * contenção — não há matéria na tangente para agarrar coisa nenhuma. Um campo
 * empurra ao longo da normal e pronto.
 *
 * Era o defeito mais grave de JOGABILIDADE do modelo. Com atrito na borda e
 * auxílio LIGADO, 10 s raspando a fronteira (qualquer um dos três raios de
 * arena: 80k/200k/500k) comiam 1000 u/s tangenciais até 0,00 u/s, e 4000 u/s
 * deixavam 19,8% da velocidade com av = −39,2 rad/s — 3,3× o próprio
 * IMPACT_SPIN_MAX, 8,4 s de RCS para anular. Raspar a borda custava a nave.
 *
 * O zero é modelagem — campo não tem superfície para agarrar. O contato
 * PRENSADO contra rocha, que tem superfície, é outra história e está em
 * `spinShare` (collision.ts): lá o atrito age até o giro encostar na assíntota
 * e some quando ela trava ω — auxílio de jogabilidade declarado, não física.
 */
export const BOUNDARY_SURFACE_FRICTION = 0;
/** Casco contra casco: metal liso dos dois lados, o par que menos agarra. */
export const HULL_FRICTION = 0.05;

/**
 * Abaixo desta velocidade de aproximação (u/s) o contato é tratado como
 * REPOUSO (e = 0): sem isto a nave encostada numa rocha fica quicando em
 * micro-impactos para sempre.
 */
export const RESTING_CONTACT_SPEED = 40;

/**
 * Tranco de rotação do impacto: até onde ele é LINEAR no impulso tangencial
 * (rad/s). Abaixo disto, Δω = -R·Δvt/k² passa intocado.
 *
 * A versão anterior tinha um teto duro em 1,2 rad/s. Um teto que satura em
 * praticamente todo contato do jogo (rocha acima de 484 u/s tangenciais no
 * caça; nave × nave a 2000 u/s com parâmetro de impacto ≥ 0,5) não é teto: é
 * um valor fixo com nome de teto — raspar de leve e capotar a 6 km/s davam
 * exatamente o mesmo rodopio, e o jogador não tinha como aprender nada com o
 * impacto.
 *
 * O que NÃO vale mais: "a faixa que o jogo usa fica dentro da parte linear".
 * Com k fisicamente plausível (massa dentro do casco, ver ships.ts) e μ de
 * atrito seco de verdade, o mesmo impulso gira bem mais. Medido, raspão a 30°
 * contra rocha: builder 3,5 rad/s a 500 u/s, 9,4 a 2000, 11,9 a 6000;
 * cargueiro 1,3 / 4,8 / 9,7. Ou seja: o cruzeiro já está na parte que
 * satura — a curva continua crescente (impactos diferentes, rodopios
 * diferentes), mas quem segura o valor é o limitador de rodopio, declarado.
 */
export const IMPACT_SPIN_LINEAR = 3.0;

/**
 * ASSÍNTOTA do tranco de rotação (rad/s). Passando da faixa linear a curva
 * fecha suavemente (exponencial, ver `softSaturate` em collision.ts) e tende a
 * este valor: no contínuo nunca fica plana. Em ponto flutuante ela ENCOSTA —
 * com tranco acumulado acima de ~330 rad/s o termo exponencial some e o
 * resultado arredonda para o teto; um raspão a 20 000 u/s já chega lá. O que
 * cortar acima do teto é momento angular jogado fora de propósito (limitador
 * de rodopio, ver `spinShare`). 12 rad/s é ~4× a rotação
 * nominal do caça — capota feio, mas o RCS anula em ~1,7 s de autoridade
 * declarada, então continua sendo situação recuperável e não morte por sorteio.
 */
export const IMPACT_SPIN_MAX = 12.0;

// ── Mineração ─────────────────────────────────────────────────────────
export const MINING_RANGE = 250; // distância máxima até a borda do asteroide
export const MINING_RATE = 25; // minério/s

// ── Rede ──────────────────────────────────────────────────────────────
export const TICK_RATE = 20; // ticks de simulação por segundo no servidor

/**
 * CHUTE FIXO (s) da idade de um snapshot do servidor quando o cliente o usa
 * pela primeira vez na predição — latência de ida mais até um quadro de
 * espera. NÃO É MEDIDO: o estado da sala não carrega relógio do servidor e não
 * há ping. É o que a predição usa para adiantar o fantasma do outro casco até o
 * presente (FlightEnv.contactsAge), e só está certo quando a latência real
 * está perto de 50 ms.
 *
 * Onde vale e onde quebra, medido na matriz 4×4 (phystrace §11; outro casco
 * com auxílio, SEM o blend da nave própria):
 *  · 16 a 75 ms: o Δv do choque predito sai a 0,13% do servidor; o outro casco
 *    nasce até 88 u fora do lugar e o choque acontece fora de hora.
 *  · 0 ms (LAN): o fantasma nasce ADIANTADO demais, até 130 u; em choques
 *    oblíquos rentes o choque predito some (medido pelo crítico: 16 de 80).
 *  · 100 a 300 ms: o chute fica curto, o snapshot anterior ao choque passa por
 *    posterior e ressuscita o casco — o choque se repete: erro de Δv 27% a
 *    100 ms, 65% a 200 ms, 64% a 300 ms.
 * O conserto não é outro número aqui: é medir a idade (carimbo de tempo no
 * estado da sala), que é netcode.
 */
export const SNAPSHOT_AGE_FIXED_GUESS = 0.05;
export const SERVER_LOCATION_PROD = "https://ceresconquestalfa.onrender.com"
export const SERVER_LOCATION = 'ws://localhost'

export const DEFAULT_PORT = 2567;
