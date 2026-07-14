/**
 * PlanetRenderer — Ceres como malha GreasedLine construída uma vez
 * (contorno duplo + crateras + núcleo mineral), só transform por frame.
 * Substitui o pipeline de RenderTexture do Phaser: a geometria é construída
 * direto em unidades de mundo (CERES_RADIUS) — não precisa mais do conceito
 * de "raio de textura" separado, que só existia por causa do raster.
 */

import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { GreasedLineBaseMesh } from "@babylonjs/core/Meshes/GreasedLine/greasedLineBaseMesh";
import { CERES_RADIUS, mulberry32 } from "@ceres/shared";
import { Palette } from "./Palette";
import { createLineBundle, disposeLineBundle, circlePts, type LinePart } from "./lineUtils";
import { toScene, toSceneAngle } from "./coords";

const R = CERES_RADIUS;
const CONTOUR_PX = 2.2;
const CRATER_PX = 1.3;
const CORE_PX = 1.6;
const CRATER_DIM = 0.5;
const INNER_RING_DIM = 0.5;
const CORE_TICK_DIM = 0.5;
/** mesma semente usada no Phaser original */
const CRATER_SEED_XOR = 0xce7e5;
/** velocidade angular decorativa (rad/s no espaço do jogo) */
const SPIN_RATE = 0.008;

export class PlanetRenderer {
  private scene: Scene;
  private glow: GlowLayer;
  private root: TransformNode | null = null;
  private contour: GreasedLineBaseMesh | null = null;
  private craters: GreasedLineBaseMesh | null = null;
  private core: GreasedLineBaseMesh | null = null;

  constructor(scene: Scene, glow: GlowLayer) {
    this.scene = scene;
    this.glow = glow;
  }

  /** Constrói a geometria de Ceres a partir da semente do mundo. Chamar uma vez. */
  init(worldSeed: number): void {
    if (this.root) return;
    const p = Palette.ceres;

    this.root = new TransformNode("ceres", this.scene);

    // contorno duplo (borda + anel interno)
    const contourParts: LinePart[] = [
      { pts: circlePts(0, 0, R * 0.985, 48), closed: true, color: p.body },
      { pts: circlePts(0, 0, R * 0.94, 48), closed: true, color: p.body, dim: INNER_RING_DIM },
    ];
    this.contour = createLineBundle("ceres_contour", this.scene, contourParts, {
      baseWidth: CONTOUR_PX,
      sizeAttenuation: true,
      glow: this.glow,
    });
    this.contour.parent = this.root;

    // crateras
    const crng = mulberry32((worldSeed ^ CRATER_SEED_XOR) >>> 0);
    const craterParts: LinePart[] = [];
    for (let i = 0; i < 9; i++) {
      const ang = crng() * Math.PI * 2;
      const rr = R * (0.25 + crng() * 0.55);
      const cr = R * (0.04 + crng() * 0.09);
      craterParts.push({
        pts: circlePts(Math.cos(ang) * rr, Math.sin(ang) * rr, cr, 20),
        closed: true,
        color: p.crater,
        dim: CRATER_DIM,
      });
    }
    this.craters = createLineBundle("ceres_craters", this.scene, craterParts, {
      baseWidth: CRATER_PX,
      sizeAttenuation: true,
      glow: this.glow,
    });
    this.craters.parent = this.root;

    // núcleo mineral: anel central + cruz de mira
    const coreParts: LinePart[] = [
      { pts: circlePts(0, 0, R * 0.16, 24), closed: true, color: p.core },
      { pts: [{ x: -R * 0.22, y: 0 }, { x: -R * 0.1, y: 0 }], color: p.core, dim: CORE_TICK_DIM },
      { pts: [{ x: R * 0.1, y: 0 }, { x: R * 0.22, y: 0 }], color: p.core, dim: CORE_TICK_DIM },
      { pts: [{ x: 0, y: -R * 0.22 }, { x: 0, y: -R * 0.1 }], color: p.core, dim: CORE_TICK_DIM },
      { pts: [{ x: 0, y: R * 0.1 }, { x: 0, y: R * 0.22 }], color: p.core, dim: CORE_TICK_DIM },
    ];
    this.core = createLineBundle("ceres_core", this.scene, coreParts, {
      baseWidth: CORE_PX,
      sizeAttenuation: true,
      glow: this.glow,
    });
    this.core.parent = this.root;
  }

  /** Posiciona/gira Ceres (pos em coordenadas de render do jogo). */
  tick(pos: { x: number; y: number }, tt: number): void {
    if (!this.root) return;
    const p = toScene(pos.x, pos.y);
    this.root.position.x = p.x;
    this.root.position.y = p.y;
    this.root.rotation.z = toSceneAngle(tt * SPIN_RATE);
  }

  destroy(): void {
    if (this.contour) disposeLineBundle(this.contour, this.glow);
    if (this.craters) disposeLineBundle(this.craters, this.glow);
    if (this.core) disposeLineBundle(this.core, this.glow);
    this.root?.dispose();
    this.root = null;
    this.contour = null;
    this.craters = null;
    this.core = null;
  }
}
