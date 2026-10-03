import {
  THRUST_RAMP_MIN,
  THRUST_SPOOL_DOWN_RATE,
  PHYSICS_SUBSTEP,
  SIM_MAX_DT,
  MISSILE_AMMO_MAX,
  MINE_AMMO_MAX,
  SHIP_HP_MAX,
  shipPhysics,
  cargoLoadFactor,
  normalizePos,
  type ShipInput,
  type ShipKind,
  type CargoKind,
  type ShipLayer,
  type WorldPos,
} from "@ceres/shared";

/** Estado de uma nave na simulação. Sem nada de renderização. */
export interface ShipState extends WorldPos {
  vx: number;
  vy: number;
  angle: number;
  /**
   * Velocidade angular (rad/s). A nave tem momento de inércia: o leme aplica
   * TORQUE nesta grandeza, e ela é que gira o nariz. É o que separa uma nave
   * de um cursor — e o motivo de a atitude não parar no instante em que o
   * jogador solta a tecla.
   */
  av: number;
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
  /**
   * Resíduo do acumulador de passo fixo (s): o pedaço de tempo que sobrou da
   * última chamada por não completar um sub-passo inteiro. É o que faz o
   * integrador rodar SEMPRE com h = PHYSICS_SUBSTEP em vez de fatiar o dt do
   * frame — ver `drainSubsteps`. Fica na nave (e não num global) para as
   * entradas de nave única: a predição do cliente e os testes. O SimWorld tem o
   * seu próprio, porque lá todas as naves precisam avançar em trava.
   */
  stepAccum: number;
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
  /** porão de carga (nave de transporte): tipo ("" = vazio) e quantidade */
  cargoKind: CargoKind;
  cargoAmount: number;
  /** kits de construção a bordo (builder; logistics.ts) — separado do porão de minério */
  kits: number;
  /** rações a bordo (builder) */
  rations: number;
  /** HP atual da nave (0 = destruída) */
  hp: number;
  /** mini mísseis restantes (weapons.ts; recarrega atracada num QG) */
  ammo: number;
  /** minas restantes (recarrega atracada num QG) */
  grenadeAmmo: number;
  /** cooldown até o próximo míssil ou disparo de laser (s) */
  fireCooldown: number;
  /** cooldown até a próxima mina (s) */
  grenadeCooldown: number;
  /**
   * Camada de voo em que a nave ESTÁ (ver shared/layers.ts e layers.ts). Nasce
   * em cruzeiro: é por onde as naves circulam; a superfície é para pousar,
   * minerar e atacar.
   */
  layer: ShipLayer;
  /** camada de DESTINO da transição em curso; "" = parada em `layer` */
  layerTo: ShipLayer | "";
  /** progresso da transição 0..1 (ver advanceLayer) */
  layerProgress: number;
  /**
   * Impulso normal acumulado em choques casco × casco desde a última vez que o
   * servidor o converteu em dano (massa·u/s). Ver Body.hullImpulse.
   */
  hullImpulse: number;
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
    av: 0,
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
    stepAccum: 0,
    bay: -1,
    landingPhase: "",
    landingProgress: 0,
    landingTargetX: 0,
    landingTargetY: 0,
    landingOriginX: 0,
    landingOriginY: 0,
    landingAsteroidSpin: 0,
    cargoKind: "",
    cargoAmount: 0,
    kits: 0,
    rations: 0,
    hp: SHIP_HP_MAX,
    ammo: kind === "attack" ? MISSILE_AMMO_MAX : 0,
    grenadeAmmo: kind === "attack" ? MINE_AMMO_MAX : 0,
    fireCooldown: 0,
    grenadeCooldown: 0,
    layer: "cruise",
    layerTo: "",
    layerProgress: 0,
    hullImpulse: 0,
  };
}

/**
 * Congela a nave: zera velocidade LINEAR e ANGULAR, o spool do motor e o
 * RESÍDUO do acumulador de passo. Usada nos estados em que a posição não é da
 * física (ancorada, pousando, guardada no hangar). Zerar `av` junto é
 * obrigatório — senão a nave retoma o giro que tinha ao atracar no instante em
 * que solta.
 *
 * E o `stepAccum` pelo mesmo motivo, um nível abaixo: ele é tempo de simulação
 * ainda não gasto, e sobrevivia à atracação inteira. Uma nave que atracasse com
 * 0,005 s no acumulador soltava com esse pedaço guardado e rodava um sub-passo
 * a mais no primeiro quadro de voo — um estado congelado não pode carregar
 * tempo pendente do voo anterior.
 */
export function freezeShip(s: ShipState): void {
  s.vx = 0;
  s.vy = 0;
  s.av = 0;
  s.thrustRamp = 0;
  s.stepAccum = 0;
}

/**
 * Tolerância do acumulador: um sub-passo "cheio" a menos de uma parte em 10⁹
 * conta como cheio. Sem isto, 0,05 s (o tick de 20 Hz) daria ora 6 ora 5
 * sub-passos conforme o último bit de 6×(1/120) — e a paridade com o cliente
 * dependeria de arredondamento binário.
 */
const SUBSTEP_EPS = PHYSICS_SUBSTEP * 1e-9;

/**
 * ACUMULADOR DE PASSO FIXO. Recebe o tempo já acumulado e devolve quantos
 * sub-passos de tamanho EXATO `PHYSICS_SUBSTEP` cabem nele, mais o resíduo que
 * fica guardado para a próxima chamada.
 *
 * Isto substitui o esquema anterior (`n = ceil(dt/passo)`, `h = dt/n`), que
 * NUNCA entregava h = 1/120 na prática apesar de todos os comentários do modelo
 * afirmarem que sim: um frame real de 16,667 ms é um fio de cabelo maior que
 * 1/60, o `ceil` subia para n = 3 e h despencava para 5,556 ms — 33% menor que
 * o prometido. E o tick de 50 ms do servidor caía em h = 8,333 ms. Ou seja:
 * cliente e servidor integravam com passos DIFERENTES, que era exatamente o que
 * o sub-passo fixo existia para evitar.
 *
 * Com o resíduo carregado entre chamadas, h é 1/120 sempre, para qualquer taxa
 * de quadros. O preço é a simulação ficar até um sub-passo (8,3 ms) atrás do
 * relógio de parede — atraso limitado, que nunca acumula, e o padrão de
 * qualquer integrador de passo fixo.
 *
 * NÃO HÁ MAIS TETO DE SUB-PASSOS AQUI DENTRO. Havia (`PHYSICS_MAX_SUBSTEPS =
 * 32`, com o excedente descartado), e era código morto demonstrável: esta
 * função só recebe o que `admitTime` deixou passar, no máximo SIM_MAX_DT, ou
 * seja 30 sub-passos. O ramo nunca rodou, nenhum teste o alcançava, e uma rede
 * que ninguém pode cair em cima é pior que nenhuma — passa a impressão de
 * proteção onde a proteção é OUTRA, o teto de pendência aplicado nas três
 * entradas da simulação. Quem quiser o pior caso tem
 * PHYSICS_WORST_CASE_SUBSTEPS, que é derivado de SIM_MAX_DT e tem teste.
 */
export function drainSubsteps(accumulated: number): { steps: number; rest: number } {
  if (!(accumulated > 0)) return { steps: 0, rest: 0 };
  const steps = Math.floor((accumulated + SUBSTEP_EPS) / PHYSICS_SUBSTEP);
  // o max(0, …) absorve o épsilon: o resíduo nunca fica negativo, então o
  // acumulador não pode derivar para trás ao longo de milhões de chamadas
  return { steps, rest: Math.max(0, accumulated - steps * PHYSICS_SUBSTEP) };
}

/**
 * ADMISSÃO DE TEMPO DE PAREDE no acumulador. É a ÚNICA porta por onde `dt`
 * entra na física, nas três entradas (stepShip, stepShipInWorld, SimWorld.tick),
 * e o teto que ela aplica é sobre o TOTAL PENDENTE — atraso carregado mais dt
 * novo — e não sobre o `dt` da chamada.
 *
 * Era `accum += min(dt, SIM_MAX_DT)`, e o excedente do quadro sumia. Medido: 5
 * chamadas de 0,2 s davam v = 339,38 u/s contra 885,00 de 10 chamadas de 0,1 s
 * — a 5 fps, METADE do tempo de parede era descartada, sempre, e a predição do
 * cliente ficava para trás do servidor por construção. Não era engasgo raro: é
 * o regime de quem joga em máquina fraca.
 *
 * Com o excedente guardado, o quadro seguinte roda os sub-passos que faltaram e
 * a simulação alcança o relógio. O que o teto ainda impede é a pendência CRESCER
 * sem fim: passando de SIM_MAX_DT o excesso é perdido de uma vez, e essa perda é
 * declarada — sem ela, um cliente que não dá conta acumularia atraso para sempre
 * e afundaria em câmera lenta (a "espiral da morte" do passo fixo).
 */
export function admitTime(accum: number, dt: number): number {
  return Math.min(accum + dt, SIM_MAX_DT);
}

/**
 * Limitador de TORQUE do leme, gêmeo do de empuxo: o comando só é cortado na
 * parte que AUMENTA |ω| além da rotação nominal. Torque CONTRÁRIO ao giro passa
 * sempre, inteiro, esteja a nave onde estiver.
 *
 * A versão anterior fazia `Math.max(s.av, rated)` e com isso IGNORAVA o torque
 * contrário: uma nave a 8 rad/s que segurasse o leme contra ficava em 8,000
 * rad/s por dez segundos, enquanto SOLTAR o leme a recuperava em 0,83 s. O
 * jogador que reagia certo a um rodopio era punido por reagir — e não é caso
 * exótico: um raspão a 2000 u/s, velocidade de cruzeiro, já impõe rotação acima
 * da nominal de TODAS as classes (9,4 rad/s no builder a 30°, contra 2,6 de
 * nominal; 4,8 no cargueiro, contra 1,15). O limite
 * nominal governa o que o leme pode ALCANÇAR, nunca o que ele pode DESFAZER.
 */
function governedSpin(av: number, dav: number, rated: number): number {
  const target = av + dav;
  const mag = Math.abs(target);
  // o comando REDUZ (ou mantém) o giro: nada a limitar, é freio, não aceleração
  if (mag <= Math.abs(av)) return target;
  // o comando AUMENTA: só até a nominal — ou até onde a nave já estava, se um
  // impacto a jogou acima dela (aí o leme não pode piorar, mas também não é
  // obrigado a nada)
  const ceiling = Math.max(rated, Math.abs(av));
  return mag <= ceiling ? target : (target < 0 ? -ceiling : ceiling);
}

/**
 * Limitador de empuxo ("governor"): soma à velocidade só a parte do incremento
 * de empuxo que o computador de bordo autoriza.
 *
 * A regra é UMA, e é uma afirmação sobre a componente PARALELA à velocidade: o
 * motor não pode AUMENTAR |v| além da nominal. O incremento é decomposto na
 * base (v̂, v̂⊥) e cada pedaço é julgado pelo que ele faz com o módulo:
 *  · PERPENDICULAR — passa inteira, sempre. É ela que curva a trajetória; no
 *    contínuo, força perpendicular não muda módulo nenhum.
 *  · RETRÓGRADA (paralela negativa) — passa inteira, sempre. Frear não precisa
 *    de licença.
 *  · PRÓGRADA — cortada na folga que ainda existe até a nominal, e zero se a
 *    nave já está acima dela (quique, fim do táxi).
 *
 * Isto NÃO tira velocidade de ninguém: só deixa de somar. Uma nave arremessada
 * acima da nominal CONTINUA acima dela até o piloto (ou o trim) resolver.
 *
 * A versão anterior resolvia |v + s·Δ| = L para o vetor INTEIRO. Parece o
 * mesmo, não é: acima da nominal L vira |v|, e aí QUALQUER Δ a menos de 90° da
 * velocidade dava s = 0 — motor morto justo onde o piloto mais precisa dele.
 * Medido: caça a 8400 u/s com o nariz a 90° acumulava |Δv| = 37,5 u/s em 1 s,
 * exatamente o trim, ou seja, empuxo zero, contradizendo o comentário que
 * prometia "empurrar para os lados". O mesmo defeito matava o RCS lateral.
 *
 * FECHAMENTO DO RESÍDUO. Somar Δ⊥ a v cresce |v| em Δ⊥²/(2|v|) por sub-passo,
 * porque a soma vetorial de Euler sai da circunferência que a força
 * perpendicular deveria percorrer. É erro de discretização puro — no contínuo,
 * força perpendicular gira o vetor e não mexe no módulo. Deixar passar valia
 * +1,70 u/s² sem teto: com o auxílio desligado, um caça com o nariz a 90° subia
 * de 6000 para 6511 u/s em cinco minutos, ou seja, o governor VAZAVA e só o
 * trim escondia isso. Por isso, ao fim do sub-passo, se o módulo passou do
 * limite L = max(nominal, |v| de ENTRADA), ele volta a L.
 *
 * Isso não é freio escondido, e a diferença é verificável: o corte devolve no
 * máximo o que o MOTOR somou neste sub-passo e nunca desce abaixo do |v| com
 * que a nave entrou. Sem empuxo a função sequer é chamada. A direção que o
 * empuxo perpendicular imprimiu é preservada inteira — o vetor gira, só não
 * engorda.
 */
function applyGovernedThrust(s: ShipState, dx: number, dy: number, rated: number): void {
  const vv = s.vx * s.vx + s.vy * s.vy;
  const vmag = Math.sqrt(vv);
  if (vv <= 1e-18) {
    // parada: não existe v̂ para decompor. Tudo é prógrado a partir do zero, e
    // a folga é a nominal inteira.
    const dmag = Math.hypot(dx, dy);
    const g = dmag > rated ? rated / dmag : 1;
    s.vx += dx * g;
    s.vy += dy * g;
  } else {
    const ux = s.vx / vmag;
    const uy = s.vy / vmag;
    const along = dx * ux + dy * uy; // componente paralela, com sinal
    // perpendicular = o que sobra do vetor. Sem pedágio.
    s.vx += dx - along * ux;
    s.vy += dy - along * uy;
    // paralela: livre se for retrógrada, senão limitada à folga até a nominal
    const allowed = along <= 0 ? along : Math.min(along, Math.max(0, rated - vmag));
    s.vx += allowed * ux;
    s.vy += allowed * uy;
  }
  // fecha o resíduo de segunda ordem (ver acima): o motor nunca AUMENTA |v|
  // além do limite, mesmo empurrando de través, mesmo sem auxílio ligado
  const limit = Math.max(rated, vmag);
  const after = Math.hypot(s.vx, s.vy);
  if (after > limit) {
    const k = limit / after;
    s.vx *= k;
    s.vy *= k;
  }
}

/**
 * Um sub-passo de integração — semi-implícito (Euler simplético): primeiro a
 * aceleração muda a velocidade, depois a velocidade JÁ ATUALIZADA move a
 * posição. É o integrador estável para forças de mola/amortecimento e não
 * bombeia energia como o Euler explícito.
 *
 * Exportado porque o mundo precisa intercalar colisão ENTRE sub-passos (ver
 * flight.ts): resolver contato uma vez por tick deixa nave rápida atravessar
 * rocha, e faz cliente (60 Hz) e servidor (20 Hz) discordarem sobre o que bateu.
 */
export function shipSubstep(
  s: ShipState,
  input: ShipInput,
  h: number,
  speedMult: number,
): void {
  const p = shipPhysics(s.kind);
  // carga a bordo é MASSA: divide tudo que é força/massa (ver cargoLoadFactor)
  const load = cargoLoadFactor(s.kind, s.cargoAmount);

  // ── 1. Atitude: TORQUE, não velocidade angular ─────────────────────
  // Com o leme, aceleração angular α = τ/I até a rotação nominal — limitador
  // de torque, não freio. Sem leme, o RCS SEGURA a atitude com autoridade
  // finita e declarada (auxílio de pilotagem, ver RCS_ATTITUDE_HOLD): o giro
  // some porque propulsores o combatem, não porque o vácuo o comeu.
  // `assistOff` (flight assist off) desliga a RETENÇÃO de atitude: o giro
  // passa a ser conservado de verdade e só o leme o desfaz. O torque de manobra
  // continua igual — o interruptor tira o auxílio, não a autoridade.
  if (input.turn !== 0) {
    s.av = governedSpin(s.av, input.turn * (p.angularAccel / load) * h, p.maxTurnRate);
  } else if (s.av !== 0 && !input.assistOff) {
    const stop = (p.attitudeHold / load) * h;
    s.av = s.av > 0 ? Math.max(0, s.av - stop) : Math.min(0, s.av + stop);
  }
  s.angle += s.av * h;

  // ── 2. Empuxo: motor principal + RCS de translação ─────────────────
  // O motor principal faz spool (sobe de RAMP_MIN a 100% em `spoolTime`, mais
  // lento nos cascos pesados) e só empurra ao longo do NARIZ. O RCS de
  // translação é OUTRO propulsor — bicos na casca, empuxo pequeno e
  // INSTANTÂNEO (não há turbina para acelerar) — e empurra de lado ou de ré
  // sem girar o casco. Fora estes dois, NADA acelera a nave.
  //
  // Os dois somam num ÚNICO incremento e passam UMA vez pelo governor: é o
  // mesmo limite de velocidade para ambos, e é por isso que strafe acima da
  // nominal funciona (o que o governor barra nunca foi a componente
  // perpendicular — ver applyGovernedThrust).
  const cos = Math.cos(s.angle);
  const sin = Math.sin(s.angle);
  let dx = 0;
  let dy = 0;
  if (input.thrust) {
    s.thrustRamp = Math.min(1, s.thrustRamp + h / p.spoolTime);
    const power = THRUST_RAMP_MIN + (1 - THRUST_RAMP_MIN) * s.thrustRamp;
    const dv = (p.accel / load) * speedMult * power * h;
    dx += cos * dv;
    dy += sin * dv;
  } else {
    s.thrustRamp = Math.max(0, s.thrustRamp - h * THRUST_SPOOL_DOWN_RATE);
  }
  // comando do RCS no referencial do CASCO: `lat` para boreste (o lado para
  // onde `turn: 1` varre o nariz) e `fwd` só negativo — o RCS freia de proa,
  // não substitui o motor principal para a frente.
  const lat = input.strafe ?? 0;
  const fwd = input.retro ? -1 : 0;
  if (lat !== 0 || fwd !== 0) {
    // orçamento ÚNICO: pedir lateral e ré juntos REPARTE o empuxo do RCS, não
    // soma. São os mesmos bicos na mesma linha de alimentação — a diagonal sai
    // com o mesmo módulo do eixo puro, e não 1,41× dele.
    const budget = Math.hypot(fwd, lat);
    const dv = ((p.rcsAccel / load) * speedMult * h) / budget;
    dx += (fwd * cos - lat * sin) * dv;
    dy += (fwd * sin + lat * cos) * dv;
  }
  if (dx !== 0 || dy !== 0) {
    applyGovernedThrust(s, dx, dy, p.maxSpeed * speedMult);
  }

  // ── 3. Trim assistido do RCS ───────────────────────────────────────
  // A ÚNICA desaceleração que a nave sofre sem o jogador pedir: constante,
  // pequena e declarada (SHIP_ASSIST_FORCE). Nunca inverte o sentido. Com
  // `assistOff` ela some junto com a retenção de atitude — é o mesmo
  // interruptor porque é o mesmo tipo de coisa: auxílio de jogabilidade, não
  // física. Com ele desligado a deriva é total, como no vácuo de verdade.
  const speed = Math.hypot(s.vx, s.vy);
  if (speed > 0 && !input.assistOff) {
    const k = Math.max(0, speed - (p.assistDecel / load) * speedMult * h) / speed;
    s.vx *= k;
    s.vy *= k;
  }

  // ── 4. Posição ─────────────────────────────────────────────────────
  s.x += s.vx * h;
  s.y += s.vy * h;
}

/**
 * Integra um passo de física da nave, SEM colisão — use `stepShipInWorld`
 * (flight.ts) quando houver mundo em volta. Roda igual no servidor
 * (autoritativo) e no cliente (predição local).
 *
 * `dt` vem do frame do cliente e do tick do servidor, então varia; é fatiado
 * em sub-passos de tamanho fixo (PHYSICS_SUBSTEP), o que deixa o resultado
 * quase independente de dt e estável até dt = 0,1 s.
 *
 * Reprodutível: mesma sequência de entradas → mesma saída, sem relógio nem
 * sorteio no caminho. (Bit a bit entre motores JS diferentes NÃO é garantido —
 * exp/cos/sin/hypot são "implementation-approximated" na ECMA-262 — e a
 * arquitetura não precisa disso: a reconciliação é blend exponencial contra o
 * estado autoritativo, não rollback+replay.)
 *
 * `speedMult` escala empuxo e velocidade nominal (táxi = 2×).
 */
export function stepShip(s: ShipState, input: ShipInput, dt: number, speedMult = 1): void {
  // dt = 0 (o cliente usa isso só para renormalizar a posição), dt negativo ou
  // NaN: nada a integrar. `!(dt > 0)` também barra NaN.
  if (!(dt > 0)) {
    normalizePos(s);
    return;
  }
  s.stepAccum = admitTime(s.stepAccum, dt);
  const { steps, rest } = drainSubsteps(s.stepAccum);
  s.stepAccum = rest;
  for (let i = 0; i < steps; i++) shipSubstep(s, input, PHYSICS_SUBSTEP, speedMult);
  normalizePos(s);
}
