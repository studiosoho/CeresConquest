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

/** Um contato no radar: posição relativa (u) — frente e direita da nave — e o que é. */
export interface RadarBlip {
  fwd: number;
  right: number;
  kind: "fleet" | "enemy" | "ownStructure" | "enemyStructure" | "shot";
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
    };
    for (const b of blips) {
      const x = c + (b.right / RADAR_RANGE) * R;
      const y = c - (b.fwd / RADAR_RANGE) * R;
      if (Math.hypot(x - c, y - c) > R) continue;
      ctx.fillStyle = color[b.kind];
      if (b.kind === "ownStructure" || b.kind === "enemyStructure") ctx.fillRect(x - 5, y - 5, 10, 10);
      else if (b.kind === "shot") ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
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
      if (mesh === this.body || mesh === this.radar) {
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
  }

  // ── geometria ────────────────────────────────────────────────────────

  private rebuild(full: boolean, aspect: number): void {
    this.body?.dispose();
    this.radar?.dispose();
    this.body = null;
    this.radar = null;
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

    // luzes indicadoras à esquerda (fixas no quadro pequeno)
    const lampY = full ? -0.62 : -0.8;
    for (let r = 0; r < 2; r++) {
      for (let k = 0; k < 4; k++) {
        const x = -0.88 + k * 0.1;
        const y = lampY - r * 0.09;
        const col = LAMPS[(k + r) % LAMPS.length].scale(full ? 1 : 0.55);
        this.quad(b, S(x, y, 1), S(x + 0.06, y, 1), S(x + 0.06, y + 0.05, 1), S(x, y + 0.05, 1), col, true);
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
      // TELA da vista de cima: moldura em volta do recorte do viewport
      const sx0 = PANEL_SCREEN.left * 2 - 1;
      const sx1 = (PANEL_SCREEN.left + PANEL_SCREEN.width) * 2 - 1;
      const sy0 = PANEL_SCREEN.bottom * 2 - 1;
      const sy1 = (PANEL_SCREEN.bottom + PANEL_SCREEN.height) * 2 - 1;
      const t = 0.022;
      const fr = (xa: number, ya: number, xb: number, yb: number) =>
        this.quad(b, S(xa, ya, 1), S(xb, ya, 1), S(xb, yb, 1), S(xa, yb, 1), BEZEL);
      fr(sx0 - t, sy0 - t * aspect, sx1 + t, sy0);
      fr(sx0 - t, sy1, sx1 + t, sy1 + t * aspect);
      fr(sx0 - t, sy0, sx0, sy1);
      fr(sx1, sy0, sx1 + t, sy1);
    }

    this.body = this.toMesh("cockpitInterior", b, this.bodyMat);
    if (radarCenter) this.radar = this.radarMesh(radarCenter, aspect, S);
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
