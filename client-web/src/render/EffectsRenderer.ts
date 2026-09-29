/**
 * EffectsRenderer — rastros de motor, feixe de mineração, projéteis, zona
 * de pouso e fronteira da arena. Estilo retrô vetorial: linhas e pontos,
 * sem preenchimentos — o halo de fósforo do Phaser (passada dupla
 * translúcida) morreu, o GlowLayer da cena dá o brilho de graça.
 *
 * Contagens variam por frame (número de naves com jato, de projéteis) — em
 * vez de recriar malhas a cada frame, um `LinePool` por categoria reaproveita
 * as malhas via `setPoints()` (mesma contagem de pontos sempre) e apenas
 * habilita/desabilita entradas extras. Singletons (feixe, zona de pouso,
 * fronteira) são reposicionados por transform; a zona de pouso só reconstrói
 * geometria quando o raio muda (troca de asteroide-alvo).
 *
 * Simplificações deliberadas ao portar do Phaser: pulsos de ALPHA (brilho)
 * viraram pulsos de RAIO/geometria (compatíveis com retained-mode sem tocar
 * cor por frame).
 *
 * RODADA 3 DAS NAVES: o "V" de chama (uma GreasedLine por nave em movimento,
 * material próprio, no glow, a partir do centro de MUNDO) sumia inteiro sob o
 * casco ampliado pelo piso de tela e custava um draw por nave em cada passe.
 * Virou o rastro de ShipTrails: histórico da popa do casco AMPLIADO, uma
 * malha só para todas as naves.
 */

import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreateGreasedLine } from "@babylonjs/core/Meshes/Builders/greasedLineBuilder";
import type { GreasedLineBaseMesh } from "@babylonjs/core/Meshes/GreasedLine/greasedLineBaseMesh";
import type { ShipKind } from "@ceres/shared";
import { Palette } from "./Palette";
import { createLineBundle, disposeLineBundle, circlePts, c3, type LinePart } from "./lineUtils";
import { toScene, toSceneAngle } from "./coords";
import { EFFECTS_LAYER_Z, MASK_MAIN_ONLY } from "./layers";
import { ShipTrails } from "./ShipTrails";
import { shipMeshData } from "./ShipMeshGenerator";
import { ShipAB } from "./shipAB";

const BEAM_PX = 2.6;
const BULLET_PX = 2.2;
const GRENADE_PX = 2.2;
const LANDZONE_PX = 2;
const BOUNDARY_PX = 2.5;
const ATTACK_RING_PX = 2;
const HP_BAR_PX = 5;

/**
 * Pool de malhas de mesma forma (mesma contagem de pontos por slot),
 * reaproveitadas via `setPoints()` — sem dispose/recriação em regime
 * permanente. `next()` consome um slot (cria se preciso); `end()` esconde
 * os slots não usados neste frame.
 */
class LinePool {
  private scene: Scene;
  private glow: GlowLayer;
  private color: number;
  private width: number;
  private prefix: string;
  private parent: TransformNode;
  private pool: GreasedLineBaseMesh[] = [];
  private used = 0;

  /**
   * `layerMask`: câmeras que veem o pool (ver layers.ts). Indicadores de HUD —
   * barra de HP, anel de ataque — ficam só na principal (MASK_MAIN_ONLY): no
   * visor do cockpit virariam riscos soltos.
   */
  constructor(
    scene: Scene, glow: GlowLayer, prefix: string, color: number, width: number, parent: TransformNode,
    private layerMask?: number,
  ) {
    this.scene = scene;
    this.glow = glow;
    this.prefix = prefix;
    this.color = color;
    this.width = width;
    this.parent = parent;
  }

  begin(): void {
    this.used = 0;
  }

  /** Consome o próximo slot do pool, atualizando seus pontos (parts = sub-linhas). */
  next(parts: Vector3[][]): GreasedLineBaseMesh {
    let mesh = this.pool[this.used];
    if (!mesh) {
      mesh = CreateGreasedLine(
        `${this.prefix}_${this.pool.length}`,
        { points: parts, updatable: true },
        { width: this.width, sizeAttenuation: true, color: c3(this.color) },
        this.scene,
      ) as GreasedLineBaseMesh;
      mesh.parent = this.parent;
      if (this.layerMask !== undefined) mesh.layerMask = this.layerMask;
      this.glow.referenceMeshToUseItsOwnMaterial(mesh);
      this.pool.push(mesh);
    } else {
      mesh.setEnabled(true);
      mesh.setPoints(parts);
    }
    this.used++;
    return mesh;
  }

  /** Esconde os slots do pool não consumidos neste frame. */
  end(): void {
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].setEnabled(false);
  }

  dispose(): void {
    for (const m of this.pool) {
      this.glow.unReferenceMeshFromUsingItsOwnMaterial(m);
      m.dispose(false, true);
    }
    this.pool = [];
    this.used = 0;
  }
}

export class EffectsRenderer {
  private scene: Scene;
  private glow: GlowLayer;

  private trails: ShipTrails;
  /** tempo do último drawJet — o rastro é reconstruído no endFrame */
  private lastT = 0;
  private bulletPool: LinePool;
  private grenadePool: LinePool;
  private attackPool: LinePool;
  private hpBackPool: LinePool;
  private hpOwnPool: LinePool;
  private hpEnemyPool: LinePool;

  // feixe de mineração — singleton dinâmico (posições mudam todo frame)
  private beamMesh: GreasedLineBaseMesh | null = null;
  private beamUsedThisFrame = false;

  // zona de pouso — singleton; geometria só reconstrói quando o raio muda
  private landZoneRoot: TransformNode | null = null;
  private landZoneMesh: GreasedLineBaseMesh | null = null;
  private landZoneRadius = -1;
  private landZoneUsedThisFrame = false;

  // fronteira da arena — singleton estático (raio não muda durante a partida)
  private boundaryRoot: TransformNode | null = null;
  private boundaryMesh: GreasedLineBaseMesh | null = null;

  /** raiz da camada de voo: TODO efeito é filho dela (z = EFFECTS_LAYER_Z) */
  private layerRoot: TransformNode;

  constructor(scene: Scene, glow: GlowLayer) {
    this.scene = scene;
    this.glow = glow;
    this.layerRoot = new TransformNode("fxLayer", scene);
    this.layerRoot.position.z = EFFECTS_LAYER_Z;
    this.trails = new ShipTrails(scene, glow, this.layerRoot);
    this.bulletPool = new LinePool(scene, glow, "bullet", Palette.fx.bullet, BULLET_PX, this.layerRoot);
    this.grenadePool = new LinePool(scene, glow, "grenade", Palette.fx.grenade, GRENADE_PX, this.layerRoot);
    this.attackPool = new LinePool(scene, glow, "attackRing", Palette.fx.attackRing, ATTACK_RING_PX, this.layerRoot, MASK_MAIN_ONLY);
    this.hpBackPool = new LinePool(scene, glow, "hpBack", Palette.fx.hpBack, HP_BAR_PX + 2, this.layerRoot, MASK_MAIN_ONLY);
    this.hpOwnPool = new LinePool(scene, glow, "hpOwn", Palette.fx.hpOwn, HP_BAR_PX, this.layerRoot, MASK_MAIN_ONLY);
    this.hpEnemyPool = new LinePool(scene, glow, "hpEnemy", Palette.fx.hpEnemy, HP_BAR_PX, this.layerRoot, MASK_MAIN_ONLY);
  }

  beginFrame(): void {
    this.bulletPool.begin();
    this.grenadePool.begin();
    this.attackPool.begin();
    this.hpBackPool.begin();
    this.hpOwnPool.begin();
    this.hpEnemyPool.begin();
    this.beamUsedThisFrame = false;
    this.landZoneUsedThisFrame = false;
  }

  /** Esconde os slots/singletons não usados neste frame. Chamar ao final do draw(). */
  endFrame(): void {
    this.trails.setEnabled(ShipAB.trails);
    this.trails.heads = ShipAB.trailHeads;
    this.trails.flush(this.lastT);
    this.bulletPool.end();
    this.grenadePool.end();
    this.attackPool.end();
    this.hpBackPool.end();
    this.hpOwnPool.end();
    this.hpEnemyPool.end();
    if (!this.beamUsedThisFrame) this.beamMesh?.setEnabled(false);
    if (!this.landZoneUsedThisFrame) this.landZoneRoot?.setEnabled(false);
  }

  // ── rastro de motor ───────────────────────────────────────────────

  /**
   * Registra os jatos da nave neste frame (ver ShipTrails): um por bocal da
   * classe. Chamar para TODA nave visível, parada ou não — o histórico precisa
   * da continuidade para o jato recolher quando ela para, e a cabeça quente
   * fica acesa em marcha lenta. `scale` = escala de tela da classe
   * (ShipRenderer.screenScale): os jatos nascem nos bocais do casco AMPLIADO.
   */
  drawJet(x: number, y: number, angle: number, speed: number, tt: number, id: string, kind: ShipKind, scale: number): void {
    const d = shipMeshData(kind);
    this.lastT = tt;
    this.trails.record(id, x, y, angle, speed, tt, d.nozzles, scale);
  }

  // ── feixe de mineração ────────────────────────────────────────────
  // Todo: alterar para LaserBeam para naves de ataque, pois não existe mais mineração à longa distancia

  drawMiningBeam(fromX: number, fromY: number, toX: number, toY: number, tt: number): void {
    this.beamUsedThisFrame = true;
    const ringR = BEAM_PX * (2 + Math.sin(tt * 12));
    const parts: Vector3[][] = [
      [toScene(fromX, fromY), toScene(toX, toY)],
      circlePts(toX, toY, ringR, 14).map((p) => toScene(p.x, p.y)),
    ];

    if (!this.beamMesh) {
      this.beamMesh = CreateGreasedLine(
        "beam",
        { points: parts, updatable: true },
        { width: BEAM_PX, sizeAttenuation: true, color: c3(Palette.fx.beam) },
        this.scene,
      ) as GreasedLineBaseMesh;
      this.beamMesh.parent = this.layerRoot;
      this.glow.referenceMeshToUseItsOwnMaterial(this.beamMesh);
    } else {
      this.beamMesh.setEnabled(true);
      this.beamMesh.setPoints(parts);
    }
  }

  // ── projéteis ─────────────────────────────────────────────────────

  drawBullet(x: number, y: number): void {
    const r = BULLET_PX * 1.1;
    const pts = circlePts(x, y, r, 8).map((p) => toScene(p.x, p.y));
    this.bulletPool.next([pts]);
  }

  drawGrenade(x: number, y: number, tt: number): void {
    const core = circlePts(x, y, GRENADE_PX * 1.2, 8).map((p) => toScene(p.x, p.y));
    const ringR = GRENADE_PX * (3 + Math.sin(tt * 14));
    const ring = circlePts(x, y, ringR, 16).map((p) => toScene(p.x, p.y));
    this.grenadePool.next([core, ring]);
  }

  // ── camadas e combate ─────────────────────────────────────────────

  /**
   * Nave em modo ataque de estação: anel tracejado vermelho em volta dela,
   * girando — ela está no nível das estações, sem colisão, e é alvo delas.
   */
  drawAttackRing(x: number, y: number, radius: number, tt: number): void {
    const segs = 6;
    const parts: Vector3[][] = [];
    for (let i = 0; i < segs; i++) {
      const a0 = tt * 1.6 + (i / segs) * Math.PI * 2;
      const arc: Vector3[] = [];
      for (let k = 0; k <= 4; k++) {
        const a = a0 + (k / 4) * ((Math.PI * 2) / segs) * 0.6;
        arc.push(toScene(x + Math.cos(a) * radius, y + Math.sin(a) * radius));
      }
      parts.push(arc);
    }
    this.attackPool.next(parts);
  }

  /**
   * Barra de HP de uma estrutura, centrada em (x, y), com `width` de mundo:
   * fundo escuro e o trecho cheio na cor do dono (própria verde, inimiga
   * vermelha).
   */
  drawHpBar(x: number, y: number, width: number, frac: number, own: boolean): void {
    const f = Math.min(1, Math.max(0, frac));
    const x0 = x - width / 2;
    this.hpBackPool.next([[toScene(x0, y), toScene(x0 + width, y)]]);
    if (f <= 0) return;
    (own ? this.hpOwnPool : this.hpEnemyPool).next([[toScene(x0, y), toScene(x0 + width * f, y)]]);
  }

  // ── zona de pouso ─────────────────────────────────────────────────

  /** Círculo tracejado girando lentamente — só reconstrói ao trocar de raio. */
  drawLandZone(x: number, y: number, radius: number, tt: number): void {
    this.landZoneUsedThisFrame = true;

    if (!this.landZoneRoot || Math.abs(radius - this.landZoneRadius) > 0.5) {
      if (this.landZoneMesh) disposeLineBundle(this.landZoneMesh, this.glow);
      this.landZoneRoot?.dispose();
      this.landZoneRadius = radius;

      this.landZoneRoot = new TransformNode("landzone", this.scene);
      this.landZoneRoot.parent = this.layerRoot;
      const segs = 24;
      const parts: LinePart[] = [];
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = a0 + ((Math.PI * 2) / segs) * 0.55;
        const dash: Array<{ x: number; y: number }> = [];
        const steps = 4;
        for (let s = 0; s <= steps; s++) {
          const a = a0 + ((a1 - a0) * s) / steps;
          dash.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius });
        }
        parts.push({ pts: dash, color: Palette.fx.landZone, dim: 0.6 });
      }
      this.landZoneMesh = createLineBundle("landzone_mesh", this.scene, parts, {
        baseWidth: LANDZONE_PX,
        sizeAttenuation: true,
        glow: this.glow,
      });
      this.landZoneMesh.parent = this.landZoneRoot;
    }

    this.landZoneRoot.setEnabled(true);
    const p = toScene(x, y);
    this.landZoneRoot.position.x = p.x;
    this.landZoneRoot.position.y = p.y;
    this.landZoneRoot.rotation.z = toSceneAngle(tt * 0.15);
  }

  // ── fronteira da arena ────────────────────────────────────────────

  /** Círculo simples (raio fixo durante a partida) — construído uma vez. */
  drawBoundary(cx: number, cy: number, radius: number): void {
    if (!this.boundaryRoot) {
      this.boundaryRoot = new TransformNode("boundary", this.scene);
      this.boundaryRoot.parent = this.layerRoot;
      this.boundaryMesh = createLineBundle(
        "boundary_mesh",
        this.scene,
        [{ pts: circlePts(0, 0, radius, 96), closed: true, color: Palette.fx.boundary }],
        { baseWidth: BOUNDARY_PX, sizeAttenuation: true, glow: this.glow },
      );
      this.boundaryMesh.parent = this.boundaryRoot;
    }
    const p = toScene(cx, cy);
    this.boundaryRoot.position.x = p.x;
    this.boundaryRoot.position.y = p.y;
  }

  destroy(): void {
    this.trails.dispose();
    this.bulletPool.dispose();
    this.attackPool.dispose();
    this.hpBackPool.dispose();
    this.hpOwnPool.dispose();
    this.hpEnemyPool.dispose();
    this.grenadePool.dispose();
    if (this.beamMesh) disposeLineBundle(this.beamMesh, this.glow);
    if (this.landZoneMesh) disposeLineBundle(this.landZoneMesh, this.glow);
    this.landZoneRoot?.dispose();
    if (this.boundaryMesh) disposeLineBundle(this.boundaryMesh, this.glow);
    this.boundaryRoot?.dispose();
    this.layerRoot.dispose();
  }
}
