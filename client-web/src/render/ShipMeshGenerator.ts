/**
 * ShipMeshGenerator — casco SÓLIDO low poly por classe de nave, em DUAS
 * camadas que se desenham como dois draws instanciados por classe
 * (MeshFactory), mais a posição dos BOCAIS para os jatos (ShipTrails):
 *   - `hull`   — peças CONVEXAS de faceta chapada, iluminadas pelo rig global
 *                (chave quente, rim frio, hemisférica). Fora do glow.
 *   - `livery` — a MARCA DO DONO: uma divisa (chevron) PINTADA no dorso,
 *                iluminada como o casco, na cor do dono (buffer por instância).
 *   - `nozzles`— onde nasce cada jato; o ponto quente do motor é a cabeça do
 *                jato (ShipTrails), não geometria do casco.
 *
 * ── HISTÓRICO DA PEÇA (o que cada rodada do cego derrubou) ─────────────
 * R1 "ponto branco de 15 px": wireframe puro não tem plano para a luz talhar
 *    → casco sólido + piso de tamanho em tela (ShipRenderer).
 * R2 "retângulo branco chapado": o shader padrão faz `clamp(luz·difuso)·
 *    corDeVértice`; com o albedo na cor de vértice e difuso branco, toda
 *    faceta acima de 1,0 de luz saturava no MESMO valor. O difuso agora É o
 *    albedo de referência (Palette.ship.hull) e a cor de vértice só leva a
 *    RAZÃO de cada peça sobre ele. Casco neutro para todo dono.
 * R3 "ícone visto de cima": a câmera ortográfica vê o TOPO, e topo chato é
 *    valor médio por construção → telhados de duas águas.
 * R4 "grampo sem nariz; luzes vermelha/verde leem como interface": cunha
 *    fechada com proa em ponta; a camada emissiva inteira saiu (~1,1 ms
 *    medidos devolvidos); direção e movimento passaram aos jatos.
 * R5 "brasão de duas cores cortado por uma linha reta; contorno de 1 px é
 *    adesivo; cápsula de bala sem asa nem ressalto":
 *    - o telhado ganhou CHANFRO: topo estreito + ombro a ~37° + flanco a
 *      ~60°, três facetas por bordo → a transição claro→escuro vira DEGRAUS
 *      (volume), não uma aresta de bandeira;
 *    - os flancos íngremes (|nz| pequeno) recebem albedo mais alto
 *      (EDGE_BOOST): é neles que a chave (do lado aceso) e o rim frio (do
 *      lado de sombra) batem quase de frente, então a borda do casco se
 *      separa do fundo POR LUZ, e só onde há luz — o oposto de um contorno,
 *      que é igual em volta toda;
 *    - a cumeeira é interrompida por uma cabine maior de vidro escuro, e a
 *      silhueta ganhou asas curtas em flecha e deriva — cara de aeronave;
 *    - a fita-contorno de dono saiu; o dono é a divisa pintada no dorso.
 *
 * PEÇAS CONVEXAS: cada peça é o casco convexo de uma nuvem de pontos autorada
 * (estações de casco, caixas, prismas); coplanares saem com a MESMA normal —
 * um plano chapado só, que é o que low poly quer.
 *
 * FORMA COMUNICA MASSA (shared/ships.ts): caça (0,8) dardo de asa em flecha;
 * construtora (1,0) cunha de trabalho de asa curta; mineradora (1,4) corpo
 * alto e pesado com broca e tremonhas; cargueiro (2,6) tijolo comprido de
 * contêineres com quatro motores. No regime de tela o tamanho mínimo também
 * escala com ∛massa (`shipFloorPx`), e há um jato por motor (2, 2, 2, 4).
 *
 * Espaços de coordenadas:
 *   - Autoria no quadro de PROJETO: x = nariz, y = bombordo (esquerda do
 *     piloto), z = para cima (dorso).
 *   - `finalize` converte ao quadro local de cena da nave (+X nariz, +Y
 *     bombordo, −Z = dorso, voltado para a câmera principal) e normaliza o
 *     alcance radial máximo em planta para `planR × SHIP_RADIUS` — em escala
 *     de mundo a nave não cresce um milímetro. A conversão espelha Z, o que
 *     inverte o enrolamento; as normais são espelhadas junto (continuam para
 *     fora) e os materiais não fazem culling.
 *
 * Geometria puramente visual e determinística por classe — sem engine,
 * entidades, multiplayer ou lógica de jogo.
 */

import { SHIP_RADIUS, SHIP_PHYSICS } from "@ceres/shared";
import type { ShipKind } from "@ceres/shared";
import { Palette } from "./Palette";

/** alcance radial em planta por classe, em múltiplos de SHIP_RADIUS — os
 *  mesmos máximos de antes (a broca estica a mineradora). NÃO subir: é a
 *  escala de MUNDO, e a colisão é um círculo de SHIP_RADIUS */
const PLAN_RADIUS: Record<ShipKind, number> = {
  builder: 1.0,
  mining: 1.35,
  attack: 1.15,
  transport: 1.12,
};

/** piso de comprimento em tela (px) para a massa de referência — a
 *  justificativa do número está no cabeçalho de ShipRenderer */
export const MIN_SHIP_PX = 44;

/** piso de comprimento em tela da classe: MIN_SHIP_PX · ∛massa */
export function shipFloorPx(kind: ShipKind): number {
  return MIN_SHIP_PX * Math.cbrt(SHIP_PHYSICS[kind].mass);
}

/**
 * Albedo extra dos FLANCOS íngremes (faces com |nz| < EDGE_NZ no quadro de
 * projeto), FRIO: metal em ângulo rasante devolve o ambiente, e o nosso é
 * azul. A 45 px o flanco é a faixa de 2–3 px na borda da silhueta.
 *   - Com o albedo de referência, o lado de sombra (rim 0,5 efetivo + fill
 *     hemisférico, os dois vindos de baixo-direita) saía em ~(18,31,47) —
 *     o valor do céu (~(22,52,78)): "a metade escura some no fundo".
 *   - Um realce CINZA grande (1,8–2,4×, testado na sonda) resolvia a sombra
 *     mas estourava o flanco do lado da CHAVE em branco puro — o fio claro de
 *     contorno de novo, e acima do limiar de bloom.
 *   - Realce por canal (1,1 / 1,35 / 1,8): do lado da chave (luz âmbar,
 *     pobre em azul) o flanco fecha em ~(210,230,220), sem clampar; do lado
 *     do rim/fill (luz azul) ele sobe a ~(28,66,160) — uma borda de luz fria
 *     ACIMA do céu, só onde a luz de recorte bate. É luz, não traço.
 */
const EDGE_BOOST: RGB = [1.1, 1.35, 1.8];
const EDGE_NZ = 0.6;

/** malha de faceta chapada: 3 vértices exclusivos por triângulo */
export interface SolidData {
  positions: number[];
  normals: number[];
  /** RGBA por vértice */
  colors: number[];
  indices: number[];
}

/** bocal de motor no quadro local de CENA (escala de mundo) */
export interface Nozzle {
  x: number;
  y: number;
  /** raio do bocal (u) — dá a largura do jato e da cabeça quente */
  r: number;
}

export interface ShipMeshData {
  /** casco iluminado; cor de vértice = RAZÃO do albedo sobre Palette.ship.hull */
  hull: SolidData;
  /** divisa do dono (cor de vértice branca; o dono entra por instância) */
  livery: SolidData;
  /** bocais (onde cada jato nasce) */
  nozzles: Nozzle[];
  /** ponto de vista do cockpit (dentro da cabine), no quadro local da nave */
  eye: { x: number; y: number; z: number };
  /** comprimento em planta (unidades de mundo) — base do piso de tela */
  length: number;
  /** maior +Z de cena (o ventre, lado oposto à câmera) — ShipRenderer segura
   *  esse ponto no lugar quando infla a malha, para ela crescer PARA A
   *  CÂMERA e nunca afundar na camada das rochas (layers.ts) */
  belly: number;
}

// ── cores (albedo) ─────────────────────────────────────────────────────

type RGB = readonly [number, number, number];
const rgb = (hex: number, k = 1): RGB => [
  (((hex >> 16) & 0xff) / 255) * k,
  (((hex >> 8) & 0xff) / 255) * k,
  ((hex & 0xff) / 255) * k,
];

/** albedo de referência (vira o difuso do material) */
const REF = rgb(Palette.ship.hull);
/** albedo absoluto → razão sobre a referência (a cor de vértice do casco) */
const ratio = (hex: number): RGB => {
  const a = rgb(hex);
  return [a[0] / REF[0], a[1] / REF[1], a[2] / REF[2]];
};

const C = {
  hull: ratio(Palette.ship.hull),
  dark: ratio(Palette.ship.hullDark),
  trim: ratio(Palette.ship.trim),
  hazard: ratio(Palette.ship.hazard),
  glass: ratio(Palette.ship.glass),
  cargo: Palette.ship.cargo.map((h) => ratio(h)),
  white: [1, 1, 1] as RGB,
};

// ── casco convexo 3D ───────────────────────────────────────────────────

type V = [number, number, number];

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

interface Face { a: number; b: number; c: number; n: V; d: number }

/**
 * Casco convexo incremental. As nuvens aqui têm ≤ ~40 pontos, então o O(n²)
 * direto é irrelevante (roda uma vez por classe) e a simplicidade vale mais.
 * Pontos coplanares a uma face existente são ignorados — a face continua
 * triangulada, mas todos os triângulos dela têm a mesma normal.
 */
function convexHull(raw: V[]): { pts: V[]; faces: Face[] } {
  const pts: V[] = [];
  for (const q of raw) {
    if (!pts.some((p) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) < 1e-7)) pts.push(q);
  }
  const eps = 1e-6;

  // tetraedro inicial: extremos sucessivos
  const i0 = 0;
  let i1 = 0, best = -1;
  for (let i = 1; i < pts.length; i++) {
    const v = sub(pts[i], pts[i0]);
    const m = dot(v, v);
    if (m > best) { best = m; i1 = i; }
  }
  let i2 = 0; best = -1;
  const e01 = sub(pts[i1], pts[i0]);
  for (let i = 0; i < pts.length; i++) {
    const c = cross(e01, sub(pts[i], pts[i0]));
    const m = dot(c, c);
    if (m > best) { best = m; i2 = i; }
  }
  let i3 = 0; best = -1;
  const n012 = cross(e01, sub(pts[i2], pts[i0]));
  for (let i = 0; i < pts.length; i++) {
    const m = Math.abs(dot(n012, sub(pts[i], pts[i0])));
    if (m > best) { best = m; i3 = i; }
  }
  const inner: V = [0, 1, 2].map((k) => (pts[i0][k] + pts[i1][k] + pts[i2][k] + pts[i3][k]) / 4) as V;

  const make = (a: number, b: number, c: number): Face | null => {
    let n = cross(sub(pts[b], pts[a]), sub(pts[c], pts[a]));
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-12) return null;
    n = [n[0] / len, n[1] / len, n[2] / len];
    // orienta para FORA: o ponto interior do tetraedro inicial continua
    // dentro do casco para sempre (o casco só cresce)
    if (dot(n, sub(inner, pts[a])) > 0) return { a, b: c, c: b, n: [-n[0], -n[1], -n[2]], d: -dot(n, pts[a]) };
    return { a, b, c, n, d: dot(n, pts[a]) };
  };

  let faces = [make(i0, i1, i2), make(i0, i1, i3), make(i0, i2, i3), make(i1, i2, i3)].filter(
    (f): f is Face => f !== null,
  );
  const used = new Set([i0, i1, i2, i3]);

  for (let i = 0; i < pts.length; i++) {
    if (used.has(i)) continue;
    const p = pts[i];
    const visible = faces.filter((f) => dot(f.n, p) - f.d > eps);
    if (visible.length === 0) continue;
    // horizonte: arestas dirigidas das faces visíveis cuja reversa não é visível
    const edges = new Set<string>();
    for (const f of visible) for (const [u, v] of [[f.a, f.b], [f.b, f.c], [f.c, f.a]]) edges.add(`${u},${v}`);
    faces = faces.filter((f) => !visible.includes(f));
    for (const f of visible) {
      for (const [u, v] of [[f.a, f.b], [f.b, f.c], [f.c, f.a]]) {
        if (edges.has(`${v},${u}`)) continue;
        const nf = make(u, v, i);
        if (nf) faces.push(nf);
      }
    }
  }
  return { pts, faces };
}

// ── acumuladores ───────────────────────────────────────────────────────

const ONE: RGB = [1, 1, 1];

class Solid {
  positions: number[] = [];
  normals: number[] = [];
  colors: number[] = [];
  indices: number[] = [];

  /**
   * Peça convexa (casco dos pontos), faceta chapada, cor única. Com `edges`,
   * as faces íngremes (|nz| < EDGE_NZ) recebem EDGE_BOOST — ver a nota da
   * constante: a borda da silhueta separada do fundo pela LUZ.
   */
  add(points: V[], c: RGB, edges = false): void {
    const { pts, faces } = convexHull(points);
    for (const f of faces) {
      const k = edges && Math.abs(f.n[2]) < EDGE_NZ ? EDGE_BOOST : ONE;
      const base = this.positions.length / 3;
      for (const i of [f.a, f.b, f.c]) {
        const q = pts[i];
        this.positions.push(q[0], q[1], q[2]);
        this.normals.push(f.n[0], f.n[1], f.n[2]);
        this.colors.push(c[0] * k[0], c[1] * k[1], c[2] * k[2], 1);
      }
      this.indices.push(base, base + 1, base + 2);
    }
  }
}

class Build {
  hull = new Solid();
  livery = new Solid();
  /** bocais em quadro de projeto: [x, y, raio] */
  nozzles: [number, number, number][] = [];
  eye: V = [0, 0, 0];
}

// ── primitivas (quadro de projeto) ─────────────────────────────────────

/** espelha em Y (bombordo/estibordo); pontos na linha de centro não duplicam */
const sym = (pts: V[]): V[] => {
  const out: V[] = [];
  for (const q of pts) {
    out.push(q);
    if (Math.abs(q[1]) > 1e-6) out.push([q[0], -q[1], q[2]]);
  }
  return out;
};

/** estação de casco: pares (y, z) do lado de bombordo, espelhados */
const station = (x: number, yz: [number, number][]): V[] => sym(yz.map(([y, z]) => [x, y, z] as V));

/** caixa alinhada aos eixos */
const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): V[] => {
  const out: V[] = [];
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) out.push([x, y, z]);
  return out;
};

/** o mesmo conjunto de pontos com Y invertido (peça do outro bordo) */
const flipY = (pts: V[]): V[] => pts.map(([x, y, z]) => [x, -y, z] as V);

/**
 * Prisma poligonal ao longo de X (nacelas, colares, broca): raio r0 em x0 e
 * r1 em x1 (r1 = 0 → cone). Fase escolhida para deixar uma ARESTA para cima
 * (R3): de cima, um prisma de topo chato mostrava um plano de valor médio;
 * com a aresta no alto ele mostra duas águas, uma acesa e outra na sombra.
 */
const prismX = (x0: number, x1: number, cy: number, cz: number, r0: number, r1: number, n: number): V[] => {
  const off = (n / 4) % 1;
  const out: V[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i + off) / n) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    out.push([x0, cy + c * r0, cz + s * r0], [x1, cy + c * r1, cz + s * r1]);
  }
  return out;
};

/** nacela de motor (prisma escuro) + bocal registrado para o jato */
function engine(b: Build, x0: number, x1: number, y: number, z: number, rBack: number, rFront: number, n: number): void {
  b.hull.add(prismX(x0, x1, y, z, rBack, rFront, n), C.dark);
  b.nozzles.push([x0, y, rBack]);
}

/**
 * DIVISA DO DONO (R5, no lugar da fita-contorno): um V pintado sobre as
 * águas do dorso, com o vértice para a PROA. Por que esta forma e este lugar:
 *   - é pintura, não traço: iluminada pelo rig como o casco (acende na água
 *     da chave, apaga na de sombra), então pertence ao volume em vez de
 *     recortá-lo — o "adesivo" do veredito era o contorno, que é igual em
 *     volta toda e independe da luz;
 *   - fica DENTRO da silhueta, no dorso (o que a câmera de cima vê), e não
 *     desenha a borda;
 *   - o V aponta o nariz: reforça a direção em vez de competir com ela;
 *   - cor do dono pura no albedo: branca na nave própria, verde-fósforo na
 *     frota, cinza-azulado nas alheias — o jogador separa a própria frota
 *     pela divisa acesa, como separaria pintura de esquadrão.
 * Uma lâmina por bordo, entre `y0` (junto da cumeeira) e `y1` (no ombro),
 * assentada na altura do telhado dada por `zAt(y)` e erguida LIVERY_LIFT.
 */
const LIVERY_LIFT = 0.035;
const LIVERY_TH = 0.03;
function chevron(b: Build, xi: number, d: number, w: number, y0: number, y1: number, zAt: (y: number) => number): void {
  for (const s of [1, -1]) {
    const pts: V[] = [];
    for (const [x, y] of [[xi, y0], [xi - w, y0], [xi - d, y1], [xi - d - w, y1]] as const) {
      const z = zAt(y) + LIVERY_LIFT;
      pts.push([x, s * y, z], [x, s * y, z + LIVERY_TH]);
    }
    b.livery.add(pts, C.white);
  }
}

// ── manifestos por classe ──────────────────────────────────────────────
// Números em unidades de projeto (a normalização de `finalize` reescala);
// a construtora tem ~4,3 de comprimento como referência.

const ASSEMBLE: Record<ShipKind, (b: Build) => void> = {
  // CONSTRUTORA — cunha fechada de proa em ponta (R4) com TELHADO
  // CHANFRADO (R5): topo estreito, ombro a ~37°, flanco a ~60° — três
  // facetas por bordo, a sombra chega em degraus. Cabine grande de vidro
  // escuro que QUEBRA a cumeeira no terço dianteiro, toco de guindaste e
  // deriva que a quebram de novo atrás, asas curtas em flecha que tiram a
  // silhueta de "cápsula de bala", pods de motor abertos na popa.
  builder: (b) => {
    b.hull.add([
      [2.25, 0, 0.12],
      ...station(1.40, [[0.10, 0.62], [0.34, 0.46], [0.50, 0.10], [0.30, -0.24]]),
      ...station(0.30, [[0.14, 0.84], [0.46, 0.60], [0.74, 0.12], [0.52, -0.32]]),
      ...station(-1.20, [[0.14, 0.82], [0.48, 0.58], [0.78, 0.10], [0.54, -0.30]]),
      ...station(-1.65, [[0.12, 0.64], [0.42, 0.44], [0.70, 0.06], [0.48, -0.24]]),
    ], C.hull, true);
    // cabine: bloco claro com teto em empena + para-brisa escuro inclinado
    b.hull.add([
      ...station(0.45, [[0.30, 0.76], [0.14, 1.04]]),
      ...station(1.02, [[0.28, 0.76], [0.12, 1.04]]),
    ], C.trim);
    b.hull.add([
      ...station(1.02, [[0.12, 1.02], [0.28, 0.76]]),
      ...station(1.40, [[0.10, 0.64], [0.22, 0.60]]),
    ], C.glass);
    // asas curtas em flecha, com vinco (duas águas)
    const wing: V[] = [
      [-0.25, 0.66, 0.14], [-0.25, 0.66, -0.06], [-1.35, 0.70, 0.12], [-1.35, 0.70, -0.06],
      [-0.75, 0.68, 0.30],
      [-1.05, 1.12, 0.22], [-1.45, 1.12, 0.20], [-1.25, 1.12, 0.28], [-1.05, 1.12, 0.12], [-1.45, 1.12, 0.12],
    ];
    b.hull.add(wing, C.hull, true);
    b.hull.add(flipY(wing), C.hull, true);
    // toco de guindaste (empena escura) e deriva dorsal
    b.hull.add([...station(-0.20, [[0.12, 0.74]]), [-0.20, 0, 1.00], ...station(-0.45, [[0.12, 0.74]]), [-0.45, 0, 1.00]], C.dark);
    b.hull.add([[-1.00, 0.03, 0.80], [-1.00, -0.03, 0.80], [-1.55, 0.03, 1.14], [-1.55, -0.03, 1.14], [-1.65, 0.04, 0.62], [-1.65, -0.04, 0.62]], C.dark);
    for (const s of [1, -1]) engine(b, -2.05, -1.15, 0.56 * s, 0.02, 0.24, 0.27, 6);
    chevron(b, 0.22, 0.30, 0.16, 0.15, 0.44, (y) => (y <= 0.14 ? 0.83 : 0.83 - (y - 0.14) * 0.75));
    b.eye = [1.00, 0, 0.92];
  },

  // CAÇA — dardo: casco de CUMEEIRA central (duas águas a ~50°), asa em
  // flecha com VINCO ao longo da envergadura, canhões longos passando do
  // bordo de ataque, deriva dorsal na cauda e dois motores colados — os dois
  // jatos paralelos do caça de referência.
  attack: (b) => {
    b.hull.add([
      [2.10, 0, 0.02],
      ...station(1.20, [[0, 0.30], [0.20, 0.04], [0.12, -0.14]]),
      ...station(-0.40, [[0, 0.42], [0.32, 0.04], [0.20, -0.20]]),
      ...station(-1.45, [[0, 0.34], [0.30, 0.02], [0.20, -0.16]]),
    ], C.hull, true);
    // canopy em gota sobre a cumeeira
    b.hull.add([
      [1.35, 0, 0.27], [0.95, 0, 0.50], [0.30, 0, 0.50],
      ...station(1.05, [[0.10, 0.33]]), ...station(0.45, [[0.14, 0.40]]),
    ], C.glass);
    // deriva dorsal (a cauda "alta" diz de que lado é a popa)
    b.hull.add([[-0.40, 0.04, 0.42], [-0.40, -0.04, 0.42], [-1.35, 0.04, 0.72], [-1.35, -0.04, 0.72], [-1.45, 0.05, 0.34], [-1.45, -0.05, 0.34]], C.dark);
    const wing: V[] = [
      [0.35, 0.22, 0.02], [0.35, 0.22, -0.06],
      [-1.25, 0.26, 0.02], [-1.25, 0.26, -0.06],
      [-0.45, 0.24, 0.30],
      [-0.95, 1.40, 0.08], [-1.45, 1.40, 0.08], [-1.20, 1.40, 0.20],
      [-0.95, 1.40, 0.02], [-1.45, 1.40, 0.02],
    ];
    b.hull.add(wing, C.hull, true);
    b.hull.add(flipY(wing), C.hull, true);
    for (const s of [1, -1]) {
      b.hull.add(box(-0.70, 0.20, 0.64 * s, 0.84 * s, 0.10, 0.28), C.dark);
      b.hull.add(box(0.20, 1.30, 0.70 * s, 0.78 * s, 0.15, 0.23), C.dark);
      engine(b, -1.85, -1.00, 0.20 * s, 0.08, 0.17, 0.20, 6);
    }
    chevron(b, 0.12, 0.26, 0.14, 0.03, 0.22, (y) => 0.40 - y * 1.19);
    b.eye = [0.80, 0, 0.42];
  },

  // MINERADORA — corpo pesado em TELHADO CHANFRADO alto (topo, ombro,
  // flanco e ventre por bordo), broca cônica em faixa de segurança na proa
  // (a broca É o nariz), tremonhas de minério nos flancos e cabine em empena
  // deslocada para bombordo (assimetria de nave de serviço).
  mining: (b) => {
    b.hull.add([
      ...station(1.25, [[0.10, 0.62], [0.30, 0.48], [0.52, 0.18], [0.46, -0.22], [0.20, -0.36]]),
      ...station(0.75, [[0.16, 0.92], [0.46, 0.66], [0.80, 0.22], [0.70, -0.30], [0.30, -0.46]]),
      ...station(-1.00, [[0.18, 0.96], [0.50, 0.70], [0.86, 0.22], [0.74, -0.30], [0.32, -0.48]]),
      ...station(-1.55, [[0.14, 0.74], [0.40, 0.54], [0.74, 0.14], [0.62, -0.22], [0.28, -0.36]]),
    ], C.hull, true);
    b.hull.add(prismX(1.15, 1.50, 0, 0.06, 0.50, 0.50, 8), C.dark);
    b.hull.add(prismX(1.50, 2.75, 0, 0.06, 0.44, 0, 6), C.hazard);
    const hopper: V[] = [];
    for (const x of [0.55, -1.15]) {
      for (const [y, z] of [[0.78, 0.34], [1.02, 0.18], [1.02, -0.22], [0.78, -0.32]] as const) hopper.push([x, y, z]);
    }
    hopper.push([0.72, 0.80, 0.20], [0.72, 0.80, -0.20]); // chanfro de proa
    b.hull.add(hopper, C.cargo[0], true);
    b.hull.add(flipY(hopper), C.cargo[0], true);
    // cabine a bombordo, empena assimétrica
    const cab: V[] = [];
    for (const x of [0.30, 0.80]) cab.push([x, 0.12, 0.84], [x, 0.50, 0.60], [x, 0.31, 1.04]);
    cab.push([0.98, 0.14, 0.78], [0.98, 0.48, 0.60], [0.98, 0.31, 0.86]);
    b.hull.add(cab, C.trim);
    for (const s of [1, -1]) engine(b, -2.05, -1.20, 0.42 * s, 0.00, 0.30, 0.34, 8);
    chevron(b, 0.00, 0.28, 0.16, 0.18, 0.46, (y) => (y <= 0.17 ? 0.945 : 0.945 - (y - 0.17) * 0.8));
    b.eye = [0.62, 0.30, 0.86];
  },

  // CARGUEIRO — tijolo comprido (a maior área em planta do jogo) com PROA EM
  // CUNHA e casco em telhado chanfrado; os oito contêineres têm TAMPA
  // INCLINADA para o próprio bordo (~35°), então o convés inteiro vira um
  // telhado de duas águas. Ponte em empena de dois andares com mastro na
  // proa e QUATRO motores (quatro jatos).
  transport: (b) => {
    b.hull.add([
      ...station(2.45, [[0, 0.36], [0.26, 0.04], [0.18, -0.20]]),
      ...station(1.85, [[0.14, 0.66], [0.44, 0.46], [0.74, 0.06], [0.58, -0.36]]),
      ...station(-2.00, [[0.14, 0.66], [0.46, 0.46], [0.78, 0.06], [0.62, -0.40]]),
      ...station(-2.45, [[0.12, 0.56], [0.42, 0.40], [0.74, 0.02], [0.56, -0.32]]),
    ], C.hull, true);
    // ponte em empena, dois andares, + mastro
    b.hull.add([
      ...station(1.95, [[0.28, 0.58]]), [1.95, 0, 0.74],
      [1.70, 0, 0.98], [1.25, 0, 0.98],
      ...station(1.25, [[0.34, 0.62]]), ...station(1.70, [[0.34, 0.64]]),
    ], C.trim);
    b.hull.add([...station(1.60, [[0.16, 0.92]]), [1.60, 0, 1.12], ...station(1.32, [[0.16, 0.92]]), [1.32, 0, 1.12]], C.trim);
    b.hull.add(box(1.40, 1.46, -0.03, 0.03, 1.10, 1.30), C.dark);
    const rows: [number, number][] = [[1.05, 0.32], [0.22, -0.55], [-0.65, -1.40], [-1.50, -1.95]];
    const lid = (x0: number, x1: number): V[] => {
      const out: V[] = [];
      for (const x of [x0, x1]) out.push([x, 0.06, 0.40], [x, 0.70, 0.40], [x, 0.06, 1.00], [x, 0.70, 0.56]);
      return out;
    };
    rows.forEach(([x1, x0], r) => {
      b.hull.add(lid(x0, x1), C.cargo[(r * 2) % 3], true);
      b.hull.add(flipY(lid(x0, x1)), C.cargo[(r * 2 + 1) % 3], true);
    });
    for (const y of [0.22, 0.60, -0.22, -0.60]) engine(b, -2.95, -2.10, y, 0.00, 0.19, 0.22, 6);
    chevron(b, 2.28, 0.20, 0.12, 0.04, 0.26, (y) => 0.52 - y * 0.7);
    b.eye = [1.50, 0, 0.80];
  },
};

// ── conversão de quadro + normalização de escala ───────────────────────

function finalize(b: Build, kind: ShipKind): ShipMeshData {
  let maxPlan = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity;
  const hp = b.hull.positions;
  for (let i = 0; i < hp.length; i += 3) {
    maxPlan = Math.max(maxPlan, Math.hypot(hp[i], hp[i + 1]));
    minX = Math.min(minX, hp[i]);
    maxX = Math.max(maxX, hp[i]);
    minZ = Math.min(minZ, hp[i + 2]);
  }
  const k = (PLAN_RADIUS[kind] * SHIP_RADIUS) / maxPlan;

  // projeto (x nariz, y bombordo, z dorso) → cena (x, y, −z); normais idem
  const conv = (s: Solid): SolidData => {
    const positions = new Array<number>(s.positions.length);
    const normals = new Array<number>(s.normals.length);
    for (let i = 0; i < s.positions.length; i += 3) {
      positions[i] = s.positions[i] * k;
      positions[i + 1] = s.positions[i + 1] * k;
      positions[i + 2] = -s.positions[i + 2] * k;
      normals[i] = s.normals[i];
      normals[i + 1] = s.normals[i + 1];
      normals[i + 2] = -s.normals[i + 2];
    }
    return { positions, normals, colors: s.colors, indices: s.indices };
  };

  return {
    hull: conv(b.hull),
    livery: conv(b.livery),
    nozzles: b.nozzles.map(([x, y, r]) => ({ x: x * k, y: y * k, r: r * k })),
    eye: { x: b.eye[0] * k, y: b.eye[1] * k, z: -b.eye[2] * k },
    length: (maxX - minX) * k,
    belly: -minZ * k,
  };
}

const cache = new Map<ShipKind, ShipMeshData>();

/** Geometria da nave conforme a classe — computada uma vez e compartilhada
 *  por TODAS as naves daquela classe (ver MeshFactory). */
export function shipMeshData(kind: ShipKind): ShipMeshData {
  let data = cache.get(kind);
  if (!data) {
    const b = new Build();
    ASSEMBLE[kind](b);
    data = finalize(b, kind);
    cache.set(kind, data);
  }
  return data;
}
