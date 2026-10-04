import {
  WORM_HP,
  WORM_ROAM_TIME,
  WORM_SEGMENTS,
  WORM_SPACING,
  WORM_TURN_RATE,
  normalizePos,
  relVec,
  type WorldPos,
} from "@ceres/shared";

/**
 * Uma minhoca gigante (shared/worms.ts) do lado da sala: a cabeça (posição
 * e rumo), a corrente de gomos que a segue e o estado da caça. A IA (alvo,
 * mordida, dano) mora na MatchRoom; aqui só o movimento.
 */
export interface Worm extends WorldPos {
  angle: number;
  hp: number;
  /** gomos, 0 = cabeça (mesma posição dela) */
  segs: WorldPos[];
  /** gomo `i` fora de todo corpo (no vácuo) ou com a cabeça erguida: atingível */
  exposed: boolean[];
  /** alvo atual: id de nave ou de estrutura ("" = nenhum, volta ao ninho) */
  target: string;
  /** s até reavaliar o alvo */
  retarget: number;
  /** reservado (sem uso nas investidas) */
  bite: number;
  /** investida: indo para a estrutura ("in") ou se afastando dela depois do toque ("out") */
  pass: "in" | "out";
  /** a investida em curso: sorteada (`rolled`), crítica (vai no centro) e o lado por onde raspa (±1) */
  rolled: boolean;
  crit: boolean;
  side: 1 | -1;
  /**
   * CAMADA (shared/worms.ts, DUAS CAMADAS): quer o cruzeiro (`high`) ou o
   * fundo; a altura da cabeça (`alt`, 0 = fundo .. 1 = cruzeiro) anda até lá
   * a WORM_CLIMB_RATE e cada gomo herda a dela pelo caminho (`lift`).
   */
  high: boolean;
  alt: number;
  lift: number[];
  /** s que ainda restam de perseguição no cruzeiro */
  chase: number;
  /** a rocha onde ela já decidiu (perto do centro) nesta passagem ("" = nenhuma) */
  decided: string;
  /** 0..1 — cabeça erguida para fora do chão (perto da presa) */
  breach: number;
  /** 0..1 — boca aberta */
  mouth: number;
  /** s de ronda que ainda faltam; acabou, volta para a toca */
  roam: number;
  /**
   * Vagando sem presa: a EXCURSÃO atual — os pontos que faltam (`route`), o
   * caminho de volta pelo mesmo trajeto (`back`) e se ela está na ida (`away`).
   */
  route: WorldPos[];
  back: WorldPos[];
  away: boolean;
  /** s que faltam de descanso dentro da toca (−1 = fora, na ronda) */
  den: number;
  /** s que faltam no cerco à estrutura-alvo (−1 = não está cercando) */
  siege: number;
  /** estruturas que ela já cercou nesta ronda (não volta a elas, salvo por vingança) */
  besieged: Set<string>;
  /** quem a feriu (nave ou estrutura da turreta) → instante (s de partida) */
  attackers: Map<string, number>;
}

/** Minhoca recém-saída do ninho: a corrente toda encolhida no ponto de saída. */
export function makeWorm(at: WorldPos, angle: number): Worm {
  const p = { sx: at.sx, sy: at.sy, x: at.x, y: at.y };
  return {
    ...p, angle, hp: WORM_HP,
    segs: Array.from({ length: WORM_SEGMENTS }, () => ({ ...p })),
    exposed: new Array<boolean>(WORM_SEGMENTS).fill(false),
    target: "", retarget: 0, bite: 0, pass: "in", rolled: false, crit: false, side: 1, breach: 0, mouth: 0,
    high: false, alt: 0, lift: new Array<number>(WORM_SEGMENTS).fill(0), chase: 0, decided: "",
    roam: WORM_ROAM_TIME, route: [], back: [], away: false, den: -1,
    siege: -1, besieged: new Set(), attackers: new Map(),
  };
}

/**
 * Vira a cabeça para `goal` (no giro máximo), avança `speed`·dt e puxa a
 * corrente: cada gomo fica a WORM_SPACING do anterior — o corpo refaz o
 * caminho da cabeça, como um trem — e a altura também: cada gomo puxado
 * herda, na mesma proporção, a altura do da frente.
 */
export function moveWorm(w: Worm, goal: WorldPos | null, speed: number, dt: number): void {
  if (goal) {
    const { dx, dy } = relVec(w, goal);
    const want = Math.atan2(dy, dx);
    const da = Math.atan2(Math.sin(want - w.angle), Math.cos(want - w.angle));
    const max = WORM_TURN_RATE * dt;
    w.angle += Math.max(-max, Math.min(max, da));
  }
  w.x += Math.cos(w.angle) * speed * dt;
  w.y += Math.sin(w.angle) * speed * dt;
  normalizePos(w);
  const segs = w.segs;
  Object.assign(segs[0], { sx: w.sx, sy: w.sy, x: w.x, y: w.y });
  w.lift[0] = w.alt;
  for (let i = 1; i < segs.length; i++) {
    const { dx, dy } = relVec(segs[i], segs[i - 1]);
    const d = Math.hypot(dx, dy);
    if (d <= WORM_SPACING) continue;
    const k = (d - WORM_SPACING) / d;
    segs[i].x += dx * k;
    segs[i].y += dy * k;
    w.lift[i] += (w.lift[i - 1] - w.lift[i]) * k;
    normalizePos(segs[i]);
  }
}
