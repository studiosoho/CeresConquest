/**
 * ShipTrails — JATOS DE MOTOR das naves: o sinal principal de direção,
 * movimento e presença numa nave de 45 px. O caça de Homeworld 3 que venceu
 * o recorte da R3 lê SÓ por isso ("sem o rastro, o nariz e a silhueta mal se
 * sustentam"): dois jatos azuis compridos e saturados + ponto quente na saída
 * de cada bocal.
 *
 * UM JATO POR BOCAL (ShipMeshGenerator: 2, 2, 2 e 4 motores). Cada bocal
 * grava onde ESTEVE nos últimos TRAIL_SECONDS, e o jato é uma fita por esses
 * pontos — comprimento ∝ velocidade, a curva desenha a trajetória, e parada
 * o jato recolhe para dentro do bocal. Os bocais são os do casco AMPLIADO
 * (posição × screenScale): sem isso o jato nasceria no centro de mundo e
 * passaria inteiro debaixo do casco inflado. A fita mora na camada de efeitos
 * (layers.ts), ATRÁS do casco.
 *
 * CABEÇA QUENTE no bocal, dentro desta mesma malha aditiva (e não como luz
 * emissiva no GlowLayer — a camada de luzes das naves custava ~1,84 ms no
 * A/B e foi removida): um losango com o centro em ciano quase branco e as
 * pontas em preto (= nada). Existe mesmo parada (marcha lenta, mais fraca) e
 * aponta pela POPA do casco, não pela trajetória. É o ÚNICO ponto que pode
 * passar do limiar de bloom (0,80), e é pequeno: ~9 × 7 px no piso.
 *
 * CORPO: azul SATURADO (Palette.ship.trail) que afina e escurece para trás.
 * Presença por croma, não por estouro: a luminância de um azul puro é baixa,
 * então o corpo vai a ganho alto e continua sob o limiar, somado ao céu ou à
 * rocha. Fora do GlowLayer: traço nítido, não borrão.
 *
 * CUSTO: UMA malha para todos os jatos (capacidade cresce em dobro), só
 * posições e cores reescritas por frame — 1 draw aditivo, com 1 ou 60 naves
 * (medido na R3: 0,05 ms).
 */

import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Constants } from "@babylonjs/core/Engines/constants";
import { SHIP_MAX_SPEED } from "@ceres/shared";
import { Palette } from "./Palette";
import { MASK_MAIN_ONLY } from "./layers";
import type { Nozzle } from "./ShipMeshGenerator";

/** pontos por jato (fita de TRAIL_POINTS−1 quadriláteros) */
const TRAIL_POINTS = 18;
/**
 * Janela de tempo do jato. R4: 0,4 → 0,55 s. A 1654 u/s (a velocidade do
 * recorte julgado, ~⅓ da máxima) e zoom 0.12 dá 0,55 × 1654 × 0,12 ≈ 110 px:
 * ~2,5 cascos — o jato do caça de referência tem ~4 cascos e o nosso de 0,4 s
 * (~80 px, e apagado) foi lido como "mancha curta". Na máxima, ~340 px.
 * R5: 0,55 → 0,45 s (~90 px a 1654 u/s), junto com o afunilamento forte
 * abaixo — "duas linhas paralelas de largura constante, mais longas que a
 * nave, parecem traçador de interface".
 */
const TRAIL_SECONDS = 0.45;
/** amostras guardadas por bocal (cobre a janela até ~230 fps) */
const HIST = 128;
/** salto maior que isto num frame = troca de origem flutuante → recomeça */
const MAX_JUMP = 1500;
/** velocidade em que o jato chega ao brilho pleno (metade da máxima) */
const FULL_SPEED = SHIP_MAX_SPEED * 0.5;
/** abaixo disto a nave está parada: só a cabeça em marcha lenta */
const MIN_SPEED = 60;
/** meia-largura do corpo na boca, em raios de bocal (largura cheia SÓ ali) */
const BODY_HALF_W = 0.85;
/**
 * Perfil do corpo ao longo do jato (f = 0 no bocal, 1 na cauda): largura
 * ∝ (1−f)^TAPER, brilho ∝ (1−f)^FADE. R4 usava 0,35 e 0,8 — a 45 px isso é
 * uma fita de largura constante que se apaga tarde, e o cego leu "traçador".
 * Com 1,5 e 1,8, a metade de trás já tem ≤ 35 % da largura e ≤ 29 % do
 * brilho: o jato é uma cunha que nasce no ponto quente e some — a cauda do
 * caça de referência.
 */
const TAPER = 1.5;
const FADE = 1.8;
/** cabeça: comprimento para trás e meia-largura, em raios de bocal */
const HEAD_LEN = 3.2;
const HEAD_HALF_W = 1.3;
/**
 * Brilho da cabeça: marcha lenta → velocidade plena. Medido na sonda do
 * recorte (6 recortes, luminância LINEAR > 0,80 = entra no bloom): com a
 * cabeça até 1,25 e o núcleo do corpo a 0,6, eram ~38 px por nave acima do
 * limiar — um borrão pequeno, não um ponto. Com 0,95 e 0,35: ~12 px por jato
 * a 1654 u/s (só o miolo onde a cabeça encontra o início do corpo), ~1 px
 * por jato a 400 u/s, ~24 px na velocidade máxima.
 */
const HEAD_IDLE = 0.35;
const HEAD_FULL = 0.95;
/** núcleo claro do corpo logo após a cabeça (o jato SAI do ponto quente) */
const CORE_GAIN = 0.2;

const rgbOf = (hex: number) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

interface Hist {
  xs: Float64Array;
  ys: Float64Array;
  ts: Float64Array;
  /** índice da amostra mais recente */
  head: number;
  count: number;
  seen: boolean;
  /** escala deste frame: meia-largura do corpo e da cabeça (u), comprimento
   *  da cabeça (u), direção da POPA em cena, ganhos do corpo e da cabeça */
  bodyW: number;
  headW: number;
  headL: number;
  backX: number;
  backY: number;
  gainBody: number;
  gainHead: number;
}

/** vértices por jato: corpo (2 por ponto) + cabeça (centro + 4 pontas) */
const VERTS = TRAIL_POINTS * 2 + 5;

export class ShipTrails {
  private scene: Scene;
  private parent: TransformNode;
  private hist = new Map<string, Hist>();
  private mesh: Mesh | null = null;
  private capacity = 0;
  private positions = new Float32Array(0);
  private colors = new Float32Array(0);
  private mat: StandardMaterial;
  private glow: GlowLayer;
  private enabled = true;
  /** chave de A/B: desenhar as cabeças quentes */
  heads = true;
  private readonly body = rgbOf(Palette.ship.trail);
  private readonly hot = rgbOf(Palette.ship.trailHot);

  constructor(scene: Scene, glow: GlowLayer, parent: TransformNode) {
    this.scene = scene;
    this.glow = glow;
    this.parent = parent;
    // receita das estrelas: emissivo × cor de vértice, aditivo, profundidade
    // testada e não escrita (o casco oculta o trecho do jato sob ele)
    const m = new StandardMaterial("shipTrailMat", scene);
    m.disableLighting = true;
    m.emissiveColor = Color3.White();
    m.diffuseColor = Color3.Black();
    m.specularColor = Color3.Black();
    m.backFaceCulling = false;
    m.alpha = 0.9999;
    m.alphaMode = Constants.ALPHA_ADD;
    m.disableDepthWrite = true;
    this.mat = m;
  }

  /**
   * Registra os bocais da nave neste frame. Coordenadas de JOGO (as de
   * drawJet); bocais no quadro local de cena, escala de mundo; `scale` =
   * escala de tela da classe.
   */
  record(id: string, x: number, y: number, angle: number, speed: number, t: number,
    nozzles: readonly Nozzle[], scale: number): void {
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const k = Math.min(1, speed / FULL_SPEED);
    const moving = speed >= MIN_SPEED;
    for (let n = 0; n < nozzles.length; n++) {
      const nz = nozzles[n];
      // local de cena (+X nariz, +Y bombordo) → jogo (y para baixo, ângulo a):
      // cena gira −a e nega y, então Δjogo = (lx·cos a + ly·sin a, lx·sin a − ly·cos a)
      const lx = nz.x * scale, ly = nz.y * scale;
      const sx = x + lx * ca + ly * sa;
      const sy = y + lx * sa - ly * ca;
      const key = `${id}#${n}`;
      let h = this.hist.get(key);
      if (!h) {
        h = {
          xs: new Float64Array(HIST), ys: new Float64Array(HIST), ts: new Float64Array(HIST),
          head: -1, count: 0, seen: false,
          bodyW: 0, headW: 0, headL: 0, backX: 0, backY: 0, gainBody: 0, gainHead: 0,
        };
        this.hist.set(key, h);
      }
      const rr = nz.r * scale;
      h.bodyW = BODY_HALF_W * rr;
      h.headW = HEAD_HALF_W * rr;
      h.headL = HEAD_LEN * rr;
      // popa em CENA: frente de cena = (cos a, −sin a)
      h.backX = -ca;
      h.backY = sa;
      h.gainBody = moving ? 0.55 + 0.45 * k : 0;
      h.gainHead = HEAD_IDLE + (HEAD_FULL - HEAD_IDLE) * k;
      h.seen = true;
      if (h.count > 0) {
        if (Math.hypot(sx - h.xs[h.head], sy - h.ys[h.head]) > MAX_JUMP) h.count = 0; // origem mudou
        else if (t <= h.ts[h.head]) { h.xs[h.head] = sx; h.ys[h.head] = sy; continue; }
      }
      h.head = (h.head + 1) % HIST;
      h.xs[h.head] = sx;
      h.ys[h.head] = sy;
      h.ts[h.head] = t;
      h.count = Math.min(HIST, h.count + 1);
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.mesh?.setEnabled(on);
  }

  /** Reconstrói todos os jatos vistos neste frame; esquece os outros. */
  flush(t: number): void {
    for (const [key, h] of this.hist) if (!h.seen) this.hist.delete(key);
    const n = this.hist.size;
    if (n > this.capacity) this.grow(Math.max(32, this.capacity * 2, n));
    if (!this.mesh) return;

    const P = TRAIL_POINTS;
    const pos = this.positions, col = this.colors;
    pos.fill(0);
    col.fill(0);
    const px = new Float64Array(P), py = new Float64Array(P);
    const B = this.body, Hc = this.hot;
    const setC = (v: number, r: number, g: number, b: number) => {
      col[v * 4] = r; col[v * 4 + 1] = g; col[v * 4 + 2] = b; col[v * 4 + 3] = 1;
    };

    let slot = 0;
    for (const h of this.hist.values()) {
      h.seen = false;
      const base = slot * VERTS;
      slot++;
      if (h.count < 1) continue;

      // ── corpo: reamostra a janela [t − T, t] em P pontos (0 = bocal, agora)
      if (h.gainBody > 0 && h.count >= 2) {
        const oldest = (h.head - h.count + 1 + HIST) % HIST;
        let j = h.head;
        for (let i = 0; i < P; i++) {
          const target = Math.max(h.ts[oldest], t - (TRAIL_SECONDS * i) / (P - 1));
          while (j !== oldest && h.ts[(j - 1 + HIST) % HIST] >= target) j = (j - 1 + HIST) % HIST;
          const a = j, bIdx = j === oldest ? j : (j - 1 + HIST) % HIST;
          const span = h.ts[a] - h.ts[bIdx];
          const f = span > 1e-9 ? Math.min(1, Math.max(0, (h.ts[a] - target) / span)) : 0;
          px[i] = h.xs[a] + (h.xs[bIdx] - h.xs[a]) * f;
          py[i] = h.ys[a] + (h.ys[bIdx] - h.ys[a]) * f;
        }
        let nx = h.backY, ny = -h.backX; // normal padrão: perpendicular à popa
        for (let i = 0; i < P; i++) {
          const i0 = Math.max(0, i - 1), i1 = Math.min(P - 1, i + 1);
          const dx = px[i1] - px[i0], dy = -(py[i1] - py[i0]); // jogo → cena
          const l = Math.hypot(dx, dy);
          if (l > 1e-6) { nx = -dy / l; ny = dx / l; }
          const f = i / (P - 1);
          const w = h.bodyW * Math.pow(1 - f, TAPER);
          const cb = h.gainBody * Math.pow(1 - f, FADE);
          // núcleo claro nos primeiros ~15 %: o jato SAI da cabeça quente
          const ch = h.gainBody * CORE_GAIN * Math.max(0, 1 - f / 0.12);
          const v = base + i * 2;
          const sx = px[i], sy = -py[i];
          pos[v * 3] = sx + nx * w; pos[v * 3 + 1] = sy + ny * w;
          pos[v * 3 + 3] = sx - nx * w; pos[v * 3 + 4] = sy - ny * w;
          const r = B[0] * cb + Hc[0] * ch, g = B[1] * cb + Hc[1] * ch, bl = B[2] * cb + Hc[2] * ch;
          setC(v, r, g, bl);
          setC(v + 1, r, g, bl);
        }
      }

      // ── cabeça quente: losango no bocal, apontando pela popa do casco
      if (this.heads) {
        const hx = h.xs[h.head], hy = -h.ys[h.head];
        const bx = h.backX, by = h.backY, qx = by, qy = -bx;
        const c = base + P * 2;
        const cxp = hx + bx * h.headL * 0.25, cyp = hy + by * h.headL * 0.25;
        const pts = [
          [cxp, cyp],                                               // centro
          [hx - bx * h.headL * 0.25, hy - by * h.headL * 0.25],     // frente (sob o bocal)
          [cxp + qx * h.headW, cyp + qy * h.headW],                 // lado
          [hx + bx * h.headL, hy + by * h.headL],                   // ponta de trás
          [cxp - qx * h.headW, cyp - qy * h.headW],                 // outro lado
        ];
        for (let q = 0; q < 5; q++) {
          pos[(c + q) * 3] = pts[q][0];
          pos[(c + q) * 3 + 1] = pts[q][1];
        }
        const g = h.gainHead;
        setC(c, Hc[0] * g, Hc[1] * g, Hc[2] * g);
        for (let q = 1; q < 5; q++) setC(c + q, 0, 0, 0);
      }
    }
    this.mesh.updateVerticesData(VertexBuffer.PositionKind, pos, false, false);
    this.mesh.updateVerticesData(VertexBuffer.ColorKind, col, false, false);
  }

  private grow(cap: number): void {
    if (this.mesh) {
      this.glow.removeExcludedMesh(this.mesh);
      this.mesh.dispose(false, false);
    }
    this.capacity = cap;
    const P = TRAIL_POINTS;
    this.positions = new Float32Array(cap * VERTS * 3);
    this.colors = new Float32Array(cap * VERTS * 4);
    const indices: number[] = [];
    for (let s = 0; s < cap; s++) {
      const base = s * VERTS;
      for (let i = 0; i < P - 1; i++) {
        const a = base + i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const c = base + P * 2;
      indices.push(c, c + 1, c + 2, c, c + 2, c + 3, c, c + 3, c + 4, c, c + 4, c + 1);
    }
    const mesh = new Mesh("shipTrails", this.scene);
    const vd = new VertexData();
    vd.positions = this.positions;
    vd.colors = this.colors;
    vd.indices = indices;
    vd.applyToMesh(mesh, true);
    mesh.material = this.mat;
    mesh.parent = this.parent;
    mesh.isPickable = false;
    // posições mudam todo frame: sem caixa envolvente confiável para culling
    mesh.alwaysSelectAsActiveMesh = true;
    // fita plana no plano de jogo: de lado, no cockpit, é um risco
    mesh.layerMask = MASK_MAIN_ONLY;
    // fora do GlowLayer: traço nítido, sem halo (ver CORPO no cabeçalho)
    this.glow.addExcludedMesh(mesh);
    mesh.setEnabled(this.enabled);
    this.mesh = mesh;
  }

  dispose(): void {
    if (this.mesh) {
      this.glow.removeExcludedMesh(this.mesh);
      this.mesh.dispose(false, false);
    }
    this.mat.dispose();
    this.hist.clear();
  }
}
