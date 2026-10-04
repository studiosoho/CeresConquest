/**
 * CockpitInterior — o INTERIOR da cabine, desenhado na câmera de cockpit:
 * painel inclinado no rodapé, colunas e arco da capota, luzes indicadoras.
 *
 *  - COCKPIT EM TELA CHEIA: o painel tem o RADAR ao vivo no centro e, à
 *    direita, a TELA onde a vista de cima é desenhada (o viewport da câmera
 *    principal cai exatamente sobre ela — PANEL_SCREEN).
 *  - COCKPIT NO QUADRO PEQUENO (vista principal de cima): o mesmo interior,
 *    mais simples e estático — sem radar e sem a tela; as luzes ficam fixas.
 *
 * A geometria é montada no quadro LOCAL da câmera (+X direita, +Y cima, +Z
 * frente) a partir de frações da tela (coordenadas normalizadas −1..1) e de
 * uma profundidade: o painel ocupa sempre o mesmo pedaço do quadro em
 * qualquer proporção de janela, e a moldura da tela coincide com o recorte
 * do viewport. Refaz quando o modo ou a proporção mudam.
 *
 * Low poly e facetado como o resto do jogo, mas com a luz "assada" nas cores
 * dos vértices: dentro da cabine o rig de luz do mundo (que segue o
 * enquadramento de cima) não faz sentido. Fica no grupo de render 1 — sempre
 * por cima do mundo, mesmo atracado rente à plataforma.
 */

import type { Scene } from "@babylonjs/core/scene";
import type { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Material } from "@babylonjs/core/Materials/material";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MASK_FP_ONLY } from "./layers";

/**
 * Tela do painel (cockpit em tela cheia) em frações do canvas, com y a partir
 * de BAIXO como o Viewport do Babylon: a câmera principal desenha a vista de
 * cima aqui.
 */
export const PANEL_SCREEN = { left: 0.655, bottom: 0.04, width: 0.27, height: 0.215 };
/** Tela da ESQUERDA (espelho da vista de cima): o dashboard de carga. */
const DASH_SCREEN = { left: 0.075, bottom: 0.04, width: 0.27, height: 0.195 };
/** altura da textura do dashboard (a largura segue a proporção da tela) */
const DASH_PX = 288;

/**
 * O que o dashboard de carga mostra: depósitos de minério e ração, o rack de
 * kits no casco (uma placa a cada kitsCap/5 kits: 2 de um lado, 3 do outro)
 * e a esteira da refinaria. Tetos 0 = a nave não leva aquilo.
 */
export interface CargoDashboard {
  kind: string;
  ore: number;
  oreCap: number;
  rations: number;
  rationsCap: number;
  kits: number;
  kitsCap: number;
  /** teto do porão somado (0 = sem teto somado) */
  holdCap: number;
  /** lotes na refinaria, contando o que está na esteira */
  refineQueue: number;
  /** progresso do lote na esteira (0..1) */
  refineProgress: number;
  /** duração de um lote (s) — dá a velocidade da esteira */
  refineTime: number;
  /** minério e kits de um lote (legenda) */
  refineOre: number;
  refineKits: number;
  /** refino automático ligado ([E]) */
  autoRefine: boolean;
}

/** Um contato no radar: posição relativa (u) — frente e direita da nave — e o que é. */
export interface RadarBlip {
  fwd: number;
  right: number;
  kind: "fleet" | "enemy" | "ownStructure" | "enemyStructure" | "shot" | "worm" | "wormHead";
}

/** alcance do radar (u) */
export const RADAR_RANGE = 9000;
const RADAR_PX = 256;
/** voltas por segundo da varredura */
const RADAR_SWEEP = 0.5;

// ── cores (luz "assada") ──
const BODY = new Color3(0.15, 0.17, 0.2);
const LIP = new Color3(0.32, 0.34, 0.38);
const ACCENT = new Color3(0.22, 0.75, 0.82);
const STRUT = new Color3(0.07, 0.08, 0.1);
const BEZEL = new Color3(0.27, 0.29, 0.33);
const LAMPS = [new Color3(0.3, 1, 0.45), new Color3(1, 0.75, 0.2), new Color3(1, 0.3, 0.25), new Color3(0.3, 0.85, 1)];
/** luz falsa da cabine: de cima e um pouco da frente */
const CABIN_LIGHT = new Vector3(0.25, 0.85, -0.45).normalize();

interface Builder {
  positions: number[];
  colors: number[];
  indices: number[];
}

export class CockpitInterior {
  private scene: Scene;
  private camera: FreeCamera;
  private body: Mesh | null = null;
  private radar: Mesh | null = null;
  private bodyMat: StandardMaterial;
  private radarMat: StandardMaterial;
  private radarTex: DynamicTexture;
  private dash: Mesh | null = null;
  private dashMat: StandardMaterial;
  private dashTex: DynamicTexture | null = null;
  private dashKey = "";
  private lastDash = 0;
  private key = "";
  private full = false;
  private lastRadar = 0;

  constructor(scene: Scene, camera: FreeCamera, glow: GlowLayer) {
    this.scene = scene;
    this.camera = camera;
    this.occludeGlow(glow);
    this.bodyMat = new StandardMaterial("cockpitInterior", scene);
    this.bodyMat.disableLighting = true;
    this.bodyMat.emissiveColor = Color3.White(); // a cor vem dos vértices
    this.bodyMat.diffuseColor = Color3.Black();
    this.bodyMat.backFaceCulling = false;
    this.radarTex = new DynamicTexture("cockpitRadar", { width: RADAR_PX, height: RADAR_PX }, scene, false);
    this.radarMat = new StandardMaterial("cockpitRadar", scene);
    this.radarMat.disableLighting = true;
    this.radarMat.emissiveTexture = this.radarTex;
    this.radarMat.diffuseColor = Color3.Black();
    this.radarMat.backFaceCulling = false;
    this.dashMat = new StandardMaterial("cockpitDash", scene);
    this.dashMat.disableLighting = true;
    this.dashMat.diffuseColor = Color3.Black();
    this.dashMat.backFaceCulling = false;
  }

  /**
   * Monta (ou mantém) o interior para o modo e a proporção atuais do
   * viewport do cockpit. `visible` falso esconde tudo (sem nave própria).
   */
  layout(full: boolean, aspect: number, visible: boolean): void {
    const key = `${full}|${aspect.toFixed(3)}|${this.camera.fov.toFixed(3)}`;
    if (key !== this.key) {
      this.key = key;
      this.full = full;
      this.rebuild(full, aspect);
    }
    this.body?.setEnabled(visible);
    this.radar?.setEnabled(visible && full);
    this.dash?.setEnabled(visible && full);
  }

  /**
   * Redesenha o dashboard de carga (só em tela cheia). Com a esteira rodando,
   * ~20 vezes por segundo; parada, só quando algum número muda.
   */
  updateDashboard(d: CargoDashboard | null, now: number): void {
    if (!this.full || !this.dashTex) return;
    const running = !!d && d.refineQueue > 0;
    const key = d
      ? `${d.kind}|${Math.floor(d.ore)}|${d.oreCap}|${Math.floor(d.rations)}|${d.rationsCap}|${d.kits}|${d.kitsCap}|${d.refineQueue}`
      : "-";
    if (running ? now - this.lastDash < 1 / 20 : key === this.dashKey) return;
    this.dashKey = key;
    this.lastDash = now;
    const size = this.dashTex.getSize();
    drawDashboard(this.dashTex.getContext() as CanvasRenderingContext2D, size.width, size.height, d, now);
    this.dashTex.update();
  }

  /** Redesenha o radar (só em tela cheia; ~15 vezes por segundo). */
  updateRadar(blips: readonly RadarBlip[], now: number): void {
    if (!this.full || now - this.lastRadar < 1 / 15) return;
    this.lastRadar = now;
    const ctx = this.radarTex.getContext() as CanvasRenderingContext2D;
    const c = RADAR_PX / 2;
    const R = c - 6;
    ctx.fillStyle = "#03140f";
    ctx.fillRect(0, 0, RADAR_PX, RADAR_PX);
    // anéis e cruz
    ctx.strokeStyle = "rgba(80,255,160,0.35)";
    ctx.lineWidth = 2;
    for (const k of [1, 2 / 3, 1 / 3]) {
      ctx.beginPath();
      ctx.arc(c, c, R * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(c, c - R); ctx.lineTo(c, c + R);
    ctx.moveTo(c - R, c); ctx.lineTo(c + R, c);
    ctx.stroke();
    // varredura: cunha que gira e se apaga para trás
    const a = ((now * RADAR_SWEEP) % 1) * Math.PI * 2 - Math.PI / 2;
    for (let k = 0; k < 12; k++) {
      ctx.fillStyle = `rgba(80,255,160,${0.16 * (1 - k / 12)})`;
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.arc(c, c, R, a - (k + 1) * 0.05, a - k * 0.05);
      ctx.closePath();
      ctx.fill();
    }
    // contatos (frente para cima)
    const color: Record<RadarBlip["kind"], string> = {
      fleet: "#7dff9e", enemy: "#ff5a4a", ownStructure: "#7dff9e", enemyStructure: "#ff5a4a", shot: "#ffd27a",
      worm: "#ff9a3c", wormHead: "#ff9a3c",
    };
    for (const b of blips) {
      const x = c + (b.right / RADAR_RANGE) * R;
      const y = c - (b.fwd / RADAR_RANGE) * R;
      if (Math.hypot(x - c, y - c) > R) continue;
      ctx.fillStyle = color[b.kind];
      if (b.kind === "ownStructure" || b.kind === "enemyStructure") ctx.fillRect(x - 5, y - 5, 10, 10);
      else if (b.kind === "shot") ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      else if (b.kind === "worm" || b.kind === "wormHead") {
        // minhoca: o corpo em contas, a cabeça maior
        ctx.beginPath();
        ctx.arc(x, y, b.kind === "wormHead" ? 7 : 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      else {
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // a própria nave no centro
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(c, c - 8); ctx.lineTo(c + 5, c + 6); ctx.lineTo(c - 5, c + 6);
    ctx.closePath();
    ctx.fill();
    this.radarTex.update();
  }

  /**
   * O interior TAPA o brilho do que está atrás dele. O GlowLayer é composto
   * por cima da imagem pronta: excluído do glow, o interior deixava o brilho
   * das linhas do mundo (zona de pouso, feixes) vazar por cima do painel.
   * Aqui ele entra no mapa de brilho em PRETO; as demais malhas seguem a
   * regra padrão do Babylon (emissivo × nível da textura × intensidade).
   */
  private occludeGlow(glow: GlowLayer): void {
    glow.customEmissiveColorSelector = (mesh: AbstractMesh, _sub: unknown, material: Material, result) => {
      if (mesh === this.body || mesh === this.radar || mesh === this.dash) {
        result.set(0, 0, 0, 1);
        return;
      }
      const m = material as unknown as { emissiveColor?: Color3; emissiveTexture?: { level: number } | null; emissiveIntensity?: number; alpha: number } | null;
      if (m?.emissiveColor) {
        const level = (m.emissiveTexture?.level ?? 1) * (m.emissiveIntensity ?? 1);
        result.set(m.emissiveColor.r * level, m.emissiveColor.g * level, m.emissiveColor.b * level, m.alpha);
      } else {
        result.set(glow.neutralColor.r, glow.neutralColor.g, glow.neutralColor.b, glow.neutralColor.a);
      }
    };
  }

  dispose(): void {
    this.body?.dispose();
    this.radar?.dispose();
    this.bodyMat.dispose();
    this.radarMat.dispose();
    this.radarTex.dispose();
    this.dash?.dispose();
    this.dashMat.dispose();
    this.dashTex?.dispose();
  }

  // ── geometria ────────────────────────────────────────────────────────

  private rebuild(full: boolean, aspect: number): void {
    this.body?.dispose();
    this.radar?.dispose();
    this.dash?.dispose();
    this.body = null;
    this.radar = null;
    this.dash = null;
    const tanV = Math.tan(this.camera.fov / 2);
    const tanH = tanV * aspect;
    /** ponto da tela (nx, ny ∈ −1..1) na profundidade d, no quadro da câmera */
    const P = (nx: number, ny: number, d: number) => new Vector3(nx * d * tanH, ny * d * tanV, d);

    // o painel: topo mais alto em tela cheia; no quadro pequeno, rebaixado
    const top = full ? -0.4 : -0.62;
    const bottom = -1.2;
    /** profundidade do painel: inclinado (topo longe, base perto) e curvo nas laterais */
    const depth = (nx: number, ny: number) => {
      const t = (ny - bottom) / (top - bottom);
      return 24 + 12 * t - 4 * nx * nx;
    };
    const S = (nx: number, ny: number, lift = 0) => P(nx, ny, depth(nx, ny) - lift);

    const b: Builder = { positions: [], colors: [], indices: [] };
    // corpo do painel: faixas facetadas
    // malha fina: as luzes e molduras acompanham a curva sem afundar nas faces
    const cols = 20;
    const rows = 4;
    for (let i = 0; i < cols; i++) {
      const x0 = -1.25 + (2.5 * i) / cols;
      const x1 = -1.25 + (2.5 * (i + 1)) / cols;
      for (let r = 0; r < rows; r++) {
        const y0 = bottom + ((top - bottom) * r) / rows;
        const y1 = bottom + ((top - bottom) * (r + 1)) / rows;
        this.quad(b, S(x0, y0), S(x1, y0), S(x1, y1), S(x0, y1), BODY.scale(1 + 0.03 * r));
      }
      // borda elevada (capô do painel) e o filete de destaque
      const lip = top + 0.045;
      this.quad(b, S(x0, top), S(x1, top), P(x1, lip, depth(x1, top) + 1.5), P(x0, lip, depth(x0, top) + 1.5), LIP);
      this.quad(b, P(x0, lip, depth(x0, top) + 1.5), P(x1, lip, depth(x1, top) + 1.5),
        P(x1, lip + 0.012, depth(x1, top) + 1.6), P(x0, lip + 0.012, depth(x0, top) + 1.6), ACCENT, true);
    }
    // colunas laterais da capota e o arco de cima
    const strut = (xa: number, ya: number, xb: number, yb: number, w: number) => {
      const d = 30;
      this.quad(b, P(xa - w, ya, d), P(xa + w, ya, d), P(xb + w, yb, d), P(xb - w, yb, d), STRUT);
    };
    strut(-1.16, top, -0.86, 1.25, 0.05);
    strut(1.16, top, 0.86, 1.25, 0.05);
    this.quad(b, P(-1.3, 0.93, 31), P(1.3, 0.93, 31), P(1.3, 1.3, 31), P(-1.3, 1.3, 31), STRUT);

    // luzes indicadoras à esquerda (fixas no quadro pequeno); em tela cheia,
    // uma fileira só, por cima do dashboard de carga
    if (full) {
      for (let k = 0; k < 8; k++) {
        const x = -0.84 + k * 0.065;
        const y = -0.485;
        const col = LAMPS[k % LAMPS.length];
        this.quad(b, S(x, y, 1), S(x + 0.045, y, 1), S(x + 0.045, y + 0.032, 1), S(x, y + 0.032, 1), col, true);
      }
    } else {
      for (let r = 0; r < 2; r++) {
        for (let k = 0; k < 4; k++) {
          const x = -0.88 + k * 0.1;
          const y = -0.8 - r * 0.09;
          const col = LAMPS[(k + r) % LAMPS.length].scale(0.55);
          this.quad(b, S(x, y, 1), S(x + 0.06, y, 1), S(x + 0.06, y + 0.05, 1), S(x, y + 0.05, 1), col, true);
        }
      }
    }

    let radarCenter: { nx: number; ny: number; r: number } | null = null;
    if (full) {
      // RADAR: moldura poligonal no centro do painel
      const ry = (top + bottom) / 2 + 0.05;
      const rr = 0.25; // raio, em fração da meia-altura da tela
      radarCenter = { nx: 0, ny: ry, r: rr };
      const seg = 16;
      for (let k = 0; k < seg; k++) {
        const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
        const ring = (a: number, k2: number) => S((Math.cos(a) * rr * k2) / aspect, ry + Math.sin(a) * rr * k2, 1);
        this.quad(b, ring(a0, 1.0), ring(a1, 1.0), ring(a1, 1.16), ring(a0, 1.16), BEZEL);
      }
      // TELA da vista de cima (recorte do viewport) e, espelhada, a do
      // dashboard de carga: moldura em volta de cada uma
      const t = 0.022;
      const fr = (xa: number, ya: number, xb: number, yb: number) =>
        this.quad(b, S(xa, ya, 1), S(xb, ya, 1), S(xb, yb, 1), S(xa, yb, 1), BEZEL);
      for (const sc of [PANEL_SCREEN, DASH_SCREEN]) {
        const r = screenRect(sc);
        fr(r.x0 - t, r.y0 - t * aspect, r.x1 + t, r.y0);
        fr(r.x0 - t, r.y1, r.x1 + t, r.y1 + t * aspect);
        fr(r.x0 - t, r.y0, r.x0, r.y1);
        fr(r.x1, r.y0, r.x1 + t, r.y1);
      }
    }

    this.body = this.toMesh("cockpitInterior", b, this.bodyMat);
    if (radarCenter) this.radar = this.radarMesh(radarCenter, aspect, S);
    if (full) this.dash = this.dashMesh(aspect, S);
  }

  /**
   * Tela do dashboard: grade fina que acompanha a curva do painel, com a
   * textura refeita na proporção da tela (texto sem esticar).
   */
  private dashMesh(aspect: number, S: (nx: number, ny: number, lift?: number) => Vector3): Mesh {
    const ratio = (DASH_SCREEN.width / DASH_SCREEN.height) * aspect;
    const w = Math.max(DASH_PX, Math.min(1024, Math.round(DASH_PX * ratio)));
    if (!this.dashTex || this.dashTex.getSize().width !== w) {
      this.dashTex?.dispose();
      this.dashTex = new DynamicTexture("cockpitDash", { width: w, height: DASH_PX }, this.scene, false);
      this.dashMat.emissiveTexture = this.dashTex;
    }
    this.dashKey = ""; // textura nova ou tela nova: redesenha
    const r = screenRect(DASH_SCREEN);
    const cols = 8;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= cols; i++) {
      const u = i / cols;
      const x = r.x0 + (r.x1 - r.x0) * u;
      for (const v of [0, 1]) {
        const p = S(x, r.y0 + (r.y1 - r.y0) * v, 1.2);
        positions.push(p.x, p.y, p.z);
        uvs.push(u, v);
      }
      if (i > 0) {
        const k = (i - 1) * 2;
        indices.push(k, k + 2, k + 3, k, k + 3, k + 1);
      }
    }
    const m = new Mesh("cockpitDash", this.scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.uvs = uvs;
    vd.indices = indices;
    vd.applyToMesh(m);
    return this.attach(m, this.dashMat);
  }

  /** Quadrilátero com sombreamento "assado" (ou cor pura, se `flat`). */
  private quad(b: Builder, p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, color: Color3, flat = false): void {
    const n = Vector3.Cross(p1.subtract(p0), p3.subtract(p0)).normalize();
    // o lado que olha para a câmera (−Z do quadro da câmera)
    if (n.z > 0) n.scaleInPlace(-1);
    // sombreamento suave: a curvatura deixava faces de costas para a luz quase pretas
    const shade = flat ? 1 : 0.8 + 0.45 * Math.max(0, Vector3.Dot(n, CABIN_LIGHT));
    const base = b.positions.length / 3;
    for (const p of [p0, p1, p2, p3]) {
      b.positions.push(p.x, p.y, p.z);
      b.colors.push(color.r * shade, color.g * shade, color.b * shade, 1);
    }
    b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  private toMesh(name: string, b: Builder, mat: StandardMaterial): Mesh {
    const m = new Mesh(name, this.scene);
    const vd = new VertexData();
    vd.positions = b.positions;
    vd.colors = b.colors;
    vd.indices = b.indices;
    vd.applyToMesh(m);
    return this.attach(m, mat);
  }

  /** Disco do radar com coordenadas de textura (círculo da DynamicTexture). */
  private radarMesh(
    c: { nx: number; ny: number; r: number },
    aspect: number,
    S: (nx: number, ny: number, lift?: number) => Vector3,
  ): Mesh {
    const seg = 32;
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const center = S(c.nx, c.ny, 1.2);
    positions.push(center.x, center.y, center.z);
    uvs.push(0.5, 0.5);
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      const p = S(c.nx + (Math.cos(a) * c.r) / aspect, c.ny + Math.sin(a) * c.r, 1.2);
      positions.push(p.x, p.y, p.z);
      uvs.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
      if (k > 0) indices.push(0, k, k + 1);
    }
    const m = new Mesh("cockpitRadar", this.scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.uvs = uvs;
    vd.indices = indices;
    vd.applyToMesh(m);
    return this.attach(m, this.radarMat);
  }

  private attach(m: Mesh, mat: StandardMaterial): Mesh {
    m.material = mat;
    m.parent = this.camera;
    m.layerMask = MASK_FP_ONLY;
    m.renderingGroupId = 1;
    m.isPickable = false;
    m.alwaysSelectAsActiveMesh = true;
    return m;
  }
}

/** Retângulo de uma tela do painel (frações do canvas) em coordenadas −1..1. */
function screenRect(sc: { left: number; bottom: number; width: number; height: number }) {
  return {
    x0: sc.left * 2 - 1,
    x1: (sc.left + sc.width) * 2 - 1,
    y0: sc.bottom * 2 - 1,
    y1: (sc.bottom + sc.height) * 2 - 1,
  };
}

// ── dashboard de carga (desenho 2D na textura) ─────────────────────────

const UI = "#7fd8e6";
const UI_DIM = "rgba(127,216,230,0.32)";
const ORE_COL = "#d08c46";
const FOOD_COL = "#7dff9e";
const KIT_COL = "#f2b84b";
const KIT_EDGE = "#7a4f12";
/** placas do rack de kits: 2 à esquerda, 3 à direita; ordem de encher alternada */
const PLATE_ORDER: ReadonlyArray<{ side: -1 | 1; slot: number }> = [
  { side: 1, slot: 0 }, { side: -1, slot: 0 }, { side: 1, slot: 1 }, { side: -1, slot: 1 }, { side: 1, slot: 2 },
];

type Font = (k: number) => string;

export function drawDashboard(ctx: CanvasRenderingContext2D, W: number, H: number, d: CargoDashboard | null, now: number): void {
  ctx.fillStyle = "#04101a";
  ctx.fillRect(0, 0, W, H);
  // linhas de varredura bem fracas: cara de monitor
  ctx.fillStyle = "rgba(90,200,230,0.035)";
  for (let y = 0; y < H; y += 6) ctx.fillRect(0, y, W, 2);
  ctx.textBaseline = "middle";
  const pad = H * 0.05;
  const font: Font = (k) => `bold ${Math.round(H * k)}px monospace`;

  // cabeçalho
  ctx.font = font(0.07);
  ctx.fillStyle = UI;
  ctx.textAlign = "left";
  ctx.fillText(d ? `${d.kind.toUpperCase()} · CARGO` : "CARGO", pad, pad + H * 0.035);
  if (d && d.holdCap > 0) {
    const total = Math.floor(d.ore) + Math.floor(d.rations) + d.kits;
    ctx.textAlign = "right";
    ctx.fillStyle = total >= d.holdCap ? "#ff7a5a" : UI;
    ctx.fillText(`HOLD ${total}/${d.holdCap}`, W - pad, pad + H * 0.035);
  }
  ctx.fillStyle = UI_DIM;
  ctx.fillRect(pad, pad + H * 0.08, W - 2 * pad, 2);
  if (!d) {
    ctx.textAlign = "center";
    ctx.font = font(0.08);
    ctx.fillText("NO SHIP", W / 2, H / 2);
    return;
  }

  const top = pad + H * 0.12;
  const bottom = H - pad;
  const h = bottom - top;
  // três colunas: depósitos | nave com o rack de kits | refinaria
  const xG = pad;
  const wG = W * 0.22;
  const xS = xG + wG + pad;
  const wS = W * 0.27;
  const xR = xS + wS + pad;
  const wR = W - xR - pad;
  ctx.fillStyle = UI_DIM;
  ctx.fillRect(xS - pad / 2, top, 1.5, h);
  ctx.fillRect(xR - pad / 2, top, 1.5, h);

  const tw = (wG - pad * 0.6) / 2;
  drawTank(ctx, xG, top, tw, h, "ORE", d.ore, d.oreCap, ORE_COL, font);
  drawTank(ctx, xG + tw + pad * 0.6, top, tw, h, "FOOD", d.rations, d.rationsCap, FOOD_COL, font);
  drawKitRack(ctx, xS, top, wS, h, d, font);
  drawRefinery(ctx, xR, top, wR, h, d, now, font);
}

/** Tanque vertical: rótulo, nível e número. */
function drawTank(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  label: string, value: number, cap: number, color: string, font: Font,
): void {
  const lh = h * 0.13;
  ctx.textAlign = "center";
  ctx.font = font(0.058);
  ctx.fillStyle = cap > 0 ? color : UI_DIM;
  ctx.fillText(label, x + w / 2, y + lh / 2);
  const ty = y + lh;
  const th = h - lh * 2.3;
  ctx.strokeStyle = cap > 0 ? UI : UI_DIM;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, ty, w - 2, th);
  if (cap > 0) {
    const f = Math.max(0, Math.min(1, value / cap));
    const fh = (th - 6) * f;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.8;
    ctx.fillRect(x + 4, ty + th - 3 - fh, w - 8, fh);
    ctx.globalAlpha = 1;
    if (fh > 2) {
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.fillRect(x + 4, ty + th - 3 - fh, w - 8, 2);
    }
  }
  // marcas de quarto
  ctx.fillStyle = UI_DIM;
  for (let k = 1; k < 4; k++) ctx.fillRect(x + 1, ty + (th * k) / 4, w * 0.25, 1.5);
  ctx.font = font(0.062);
  ctx.fillStyle = cap > 0 ? "#e8fbff" : UI_DIM;
  ctx.fillText(cap > 0 ? `${Math.floor(value)}` : "—", x + w / 2, ty + th + lh * 0.55);
  ctx.font = font(0.045);
  ctx.fillStyle = UI_DIM;
  if (cap > 0) ctx.fillText(`/${cap}`, x + w / 2, ty + th + lh * 1.1);
}

/** Casco visto de cima, com as placas de kits presas nas laterais. */
function drawKitRack(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  d: CargoDashboard, font: Font,
): void {
  const hasRack = d.kitsCap > 0;
  const cx = x + w / 2;
  const iconH = h * 0.74;
  const cy = y + iconH / 2 + h * 0.02;
  const s = Math.min(iconH, w * 1.3); // escala: casco de 1 de comprimento
  const P = (u: number, v: number): [number, number] => [cx + u * s, cy + v * s];
  const poly = (pts: Array<[number, number]>) => {
    ctx.beginPath();
    pts.forEach(([u, v], i) => (i ? ctx.lineTo(...P(u, v)) : ctx.moveTo(...P(u, v))));
    ctx.closePath();
  };

  // placas: tamanho fixo, 3 na direita, 2 na esquerda (centradas)
  const plateH = 0.2;
  const plateW = 0.13;
  const gap = 0.035;
  const slotY = (side: -1 | 1, slot: number) => {
    const n = side === 1 ? 3 : 2;
    const span = n * plateH + (n - 1) * gap;
    return -span / 2 + 0.06 + slot * (plateH + gap);
  };
  const per = hasRack ? d.kitsCap / PLATE_ORDER.length : 1;
  if (hasRack) {
    for (let i = 0; i < PLATE_ORDER.length; i++) {
      const { side, slot } = PLATE_ORDER[i];
      const v0 = slotY(side, slot);
      // suporte do casco até a placa
      ctx.fillStyle = "#3a4650";
      ctx.fillRect(...P(side === 1 ? 0.15 : -0.205, v0 + plateH / 2 - 0.02), 0.055 * s, 0.04 * s);
      const [px, py] = P(side === 1 ? 0.205 : -0.335, v0);
      const pw = plateW * s;
      const ph = plateH * s;
      const fill = Math.max(0, Math.min(1, (d.kits - i * per) / per));
      if (fill >= 1) {
        ctx.fillStyle = KIT_COL;
        ctx.fillRect(px, py, pw, ph);
        // nervuras da placa
        ctx.strokeStyle = KIT_EDGE;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
        ctx.beginPath();
        ctx.moveTo(px + 3, py + ph / 2);
        ctx.lineTo(px + pw - 3, py + ph / 2);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.fillRect(px + 2, py + 2, pw - 4, 2);
      } else {
        if (fill > 0) {
          ctx.fillStyle = KIT_COL;
          ctx.globalAlpha = 0.4;
          ctx.fillRect(px, py + ph * (1 - fill), pw, ph * fill);
          ctx.globalAlpha = 1;
        }
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = UI_DIM;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(px, py, pw, ph);
        ctx.setLineDash([]);
      }
    }
  }

  // casco (nariz para cima)
  poly([[0, -0.48], [0.1, -0.3], [0.15, -0.05], [0.15, 0.32], [0.09, 0.45], [-0.09, 0.45], [-0.15, 0.32], [-0.15, -0.05], [-0.1, -0.3]]);
  ctx.fillStyle = "#24303a";
  ctx.fill();
  ctx.strokeStyle = UI;
  ctx.lineWidth = 2;
  ctx.stroke();
  // capota e motores
  poly([[0, -0.36], [0.05, -0.24], [-0.05, -0.24]]);
  ctx.fillStyle = UI;
  ctx.fill();
  ctx.fillStyle = "#ff9a4a";
  ctx.fillRect(...P(-0.08, 0.45), 0.05 * s, 0.035 * s);
  ctx.fillRect(...P(0.03, 0.45), 0.05 * s, 0.035 * s);

  ctx.textAlign = "center";
  const ly = y + iconH + h * 0.1;
  if (hasRack) {
    const plates = Math.min(PLATE_ORDER.length, Math.floor(d.kits / per));
    ctx.font = font(0.064);
    ctx.fillStyle = KIT_COL;
    ctx.fillText(`KITS ${d.kits}/${d.kitsCap}`, cx, ly);
    ctx.font = font(0.045);
    ctx.fillStyle = UI_DIM;
    ctx.fillText(`${plates}/${PLATE_ORDER.length} PLATES · ${per}/plate`, cx, ly + h * 0.1);
  } else {
    ctx.font = font(0.05);
    ctx.fillStyle = UI_DIM;
    ctx.fillText("NO KIT RACK", cx, ly);
  }
}

/** Esteira da refinaria: minério entra, passa na prensa e sai em kits. */
function drawRefinery(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  d: CargoDashboard, now: number, font: Font,
): void {
  const has = d.kitsCap > 0;
  const running = has && d.refineQueue > 0;
  ctx.textAlign = "left";
  ctx.font = font(0.058);
  ctx.fillStyle = has ? UI : UI_DIM;
  ctx.fillText("REFINERY", x, y + h * 0.06);
  ctx.textAlign = "right";
  if (running) {
    ctx.fillStyle = Math.floor(now * 2) % 2 ? "#7dff9e" : "#3f9a58";
    ctx.fillText(d.autoRefine ? "● AUTO" : "● RUN", x + w, y + h * 0.06);
  } else {
    ctx.fillStyle = UI_DIM;
    ctx.fillText(!has ? "—" : d.autoRefine ? "AUTO" : "OFF", x + w, y + h * 0.06);
  }
  if (!has) {
    ctx.textAlign = "center";
    ctx.font = font(0.05);
    ctx.fillText("NO REFINERY", x + w / 2, y + h * 0.45);
    return;
  }

  // esteira: dois roletes e a lona; anda o comprimento todo em um lote
  const r = h * 0.075;
  const bx0 = x + r + 2;
  const bx1 = x + w - r - 2;
  const by = y + h * 0.42;
  const len = bx1 - bx0;
  const speed = len / Math.max(0.1, d.refineTime);
  const travel = running ? now * speed : 0;
  ctx.fillStyle = "#16232b";
  ctx.beginPath();
  ctx.arc(bx0, by, r, Math.PI / 2, (Math.PI * 3) / 2);
  ctx.arc(bx1, by, r, -Math.PI / 2, Math.PI / 2);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = UI;
  ctx.lineWidth = 2;
  ctx.stroke();
  // taliscas: em cima andam para a direita, embaixo voltam
  const sp = r * 0.9;
  ctx.fillStyle = "#5d7582";
  const off = travel % sp;
  for (let tx = bx0 + off; tx < bx1; tx += sp) ctx.fillRect(tx - 1.5, by - r - 1, 3, 5);
  for (let tx = bx1 - off; tx > bx0; tx -= sp) ctx.fillRect(tx - 1.5, by + r - 4, 3, 5);
  // roletes com raios girando
  for (const rx of [bx0, bx1]) {
    ctx.beginPath();
    ctx.arc(rx, by, r * 0.62, 0, Math.PI * 2);
    ctx.fillStyle = "#2c3a44";
    ctx.fill();
    ctx.strokeStyle = UI_DIM;
    ctx.stroke();
    const a0 = travel / r;
    ctx.strokeStyle = "#8fb0bf";
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      const a = a0 + (k * Math.PI * 2) / 3;
      ctx.moveTo(rx, by);
      ctx.lineTo(rx + Math.cos(a) * r * 0.55, by + Math.sin(a) * r * 0.55);
    }
    ctx.stroke();
  }

  // o lote em cima da lona: minério antes da prensa, kits depois
  const mid = (bx0 + bx1) / 2;
  const hoodW = len * 0.26;
  const surf = by - r;
  if (running) {
    const ix = bx0 + len * Math.max(0, Math.min(1, d.refineProgress));
    if (ix < mid) drawOrePile(ctx, ix, surf, r * 0.75);
    else drawKitStack(ctx, ix, surf, r * 0.75);
  }
  // prensa (por cima do lote, que some dentro dela)
  const hoodH = h * 0.2;
  const pump = running ? Math.abs(Math.sin(now * 7)) : 0;
  ctx.fillStyle = "#3a4a56";
  ctx.fillRect(mid - hoodW / 2, surf - hoodH, hoodW, hoodH - 1);
  ctx.strokeStyle = UI;
  ctx.lineWidth = 2;
  ctx.strokeRect(mid - hoodW / 2, surf - hoodH, hoodW, hoodH - 1);
  ctx.fillStyle = "#8fb0bf";
  ctx.fillRect(mid - hoodW * 0.12, surf - hoodH - h * 0.05 + pump * h * 0.03, hoodW * 0.24, h * 0.05);
  if (running) {
    ctx.fillStyle = `rgba(255,170,60,${0.35 + 0.45 * pump})`;
    ctx.fillRect(mid - hoodW / 2 + 3, surf - 6, hoodW - 6, 5);
  }

  // progresso do lote
  const py = by + r + h * 0.1;
  const ph = h * 0.06;
  ctx.strokeStyle = UI_DIM;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(bx0 - r, py, len + 2 * r, ph);
  ctx.textAlign = "center";
  if (running) {
    ctx.fillStyle = KIT_COL;
    ctx.fillRect(bx0 - r + 2, py + 2, (len + 2 * r - 4) * d.refineProgress, ph - 4);
    ctx.font = font(0.05);
    ctx.fillStyle = "#e8fbff";
    const left = Math.max(0, (1 - d.refineProgress) * d.refineTime);
    ctx.fillText(`BATCH ${Math.floor(d.refineProgress * 100)}% · ${left.toFixed(1)}s`, x + w / 2, py + ph + h * 0.06);
  } else {
    ctx.font = font(0.045);
    ctx.fillStyle = UI_DIM;
    ctx.fillText(d.autoRefine ? `waiting ${d.refineOre} ore · [E] off` : `[E] auto: ${d.refineOre} ore → ${d.refineKits} kits`, x + w / 2, py + ph + h * 0.06);
  }

  // lotes aguardando: um monte de minério por lote
  const waiting = Math.max(0, d.refineQueue - 1);
  const qy = y + h * 0.9;
  ctx.textAlign = "left";
  ctx.font = font(0.05);
  ctx.fillStyle = waiting > 0 ? UI : UI_DIM;
  const label = `QUEUE ${waiting}`;
  ctx.fillText(label, x, qy);
  const show = Math.min(waiting, 6);
  const qx = x + ctx.measureText(label).width + r * 0.9;
  for (let k = 0; k < show; k++) drawOrePile(ctx, qx + k * r * 1.25, qy + r * 0.35, r * 0.5);
  if (waiting > show) {
    ctx.fillStyle = UI;
    ctx.fillText(`+${waiting - show}`, qx + show * r * 1.25, qy);
  }
}

/** Montinho de minério (três pedras) com a base em (x, base). */
function drawOrePile(ctx: CanvasRenderingContext2D, x: number, base: number, s: number): void {
  const rocks: Array<[number, number, number]> = [[-0.45, 0, 0.5], [0.4, 0, 0.45], [0, -0.45, 0.5]];
  for (const [dx, dy, rr] of rocks) {
    const cx = x + dx * s;
    const cy = base - rr * s + dy * s;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + dx;
      const q = rr * s * (k % 2 ? 0.85 : 1);
      if (k) ctx.lineTo(cx + Math.cos(a) * q, cy + Math.sin(a) * q);
      else ctx.moveTo(cx + Math.cos(a) * q, cy + Math.sin(a) * q);
    }
    ctx.closePath();
    ctx.fillStyle = ORE_COL;
    ctx.fill();
    ctx.strokeStyle = "#6e4420";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** Pilha de placas de kit saindo da prensa, com a base em (x, base). */
function drawKitStack(ctx: CanvasRenderingContext2D, x: number, base: number, s: number): void {
  const pw = s * 1.6;
  const ph = s * 0.28;
  for (let k = 0; k < 4; k++) {
    const py = base - (k + 1) * (ph + 1);
    ctx.fillStyle = KIT_COL;
    ctx.fillRect(x - pw / 2, py, pw, ph);
    ctx.strokeStyle = KIT_EDGE;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - pw / 2, py, pw, ph);
  }
}
