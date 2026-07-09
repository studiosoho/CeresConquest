/**
 * PlanetRenderer — Ceres com relevo, iluminação direcional, crateras
 * e núcleo mineral. Textura gerada uma única vez via generateTexture.
 * Sem conhecer lógica de jogo, rede ou física.
 */

import Phaser from "phaser";
import { CERES_RADIUS, mulberry32 } from "@ceres/shared";
import { Palette } from "./Palette";

const TEX_KEY = "planet_ceres";
/** Raio visual de Ceres em unidades de mundo — proporcional ao maior asteroide. */
const VISUAL_RADIUS = CERES_RADIUS;
/** Raio em pixels da textura gerada (independente da escala do mundo). */
const TEX_RADIUS = 512;
const MARGIN = TEX_RADIUS * 0.12;
const TEX_SIZE = (TEX_RADIUS + MARGIN) * 2;

export class PlanetRenderer {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private sprite: Phaser.GameObjects.Sprite | null = null;
  private rt: Phaser.GameObjects.RenderTexture | null = null;
  private generated = false;

  constructor(scene: Phaser.Scene, container: Phaser.GameObjects.Container) {
    this.scene = scene;
    this.container = container;
  }

  /** Gera a textura e cria o sprite. Chamar uma vez quando a semente for conhecida. */
  init(worldSeed: number): void {
    if (this.generated) return;
    this.generated = true;

    const size = Math.ceil(TEX_SIZE);
    const cx = size / 2;
    const cy = size / 2;

    // RenderTexture.draw(obj, x, y) desenha obj com offset (x,y) dentro do RT,
    // ignorando a posição do objeto — passamos cx,cy para centralizar o desenho
    const rt = this.scene.add.renderTexture(0, 0, size, size);
    const g = this.scene.add.graphics();
    this.drawCeres(g, worldSeed);
    rt.draw(g, cx, cy);
    rt.saveTexture(TEX_KEY);
    g.destroy();
    rt.setVisible(false);
    this.rt = rt; // mantém o RT vivo — destroy() invalida a textura

    this.sprite = this.scene.add.sprite(0, 0, TEX_KEY);
    this.sprite.setOrigin(0.5, 0.5);
    // escala: a textura tem TEX_RADIUS px, mas Ceres ocupa VISUAL_RADIUS unidades de mundo
    this.sprite.setScale(VISUAL_RADIUS / TEX_RADIUS);
    this.container.add(this.sprite);
    this.container.sendToBack(this.sprite);
  }

  /** Atualiza posição e rotação lenta a cada frame. */
  tick(pos: { x: number; y: number }, tt: number): void {
    if (!this.sprite) return;
    this.sprite.setPosition(pos.x, pos.y);
    this.sprite.setRotation(tt * 0.008);
  }

  destroy(): void {
    this.sprite?.destroy();
    this.sprite = null;
    this.rt?.destroy();
    this.rt = null;
    if (this.scene.textures.exists(TEX_KEY)) this.scene.textures.remove(TEX_KEY);
    this.generated = false;
  }

  // ── desenho ───────────────────────────────────────────────────────

  private drawCeres(g: Phaser.GameObjects.Graphics, worldSeed: number): void {
    const R = TEX_RADIUS;
    const p = Palette.ceres;
    // larguras em pixels de textura — traço fino de monitor vetorial
    const coreW = 3;
    const haloW = 10;

    // ── contorno duplo (borda vetorial com halo de fósforo) ───────────
    g.lineStyle(haloW, p.body, 0.15);
    g.strokeCircle(0, 0, R * 0.985);
    g.lineStyle(coreW, p.body, 1);
    g.strokeCircle(0, 0, R * 0.985);
    g.lineStyle(coreW * 0.7, p.body, 0.5);
    g.strokeCircle(0, 0, R * 0.94);

    // ── crateras: círculos em contorno ────────────────────────────────
    const crng = mulberry32((worldSeed ^ 0xce7e5) >>> 0);
    for (let i = 0; i < 9; i++) {
      const ang = crng() * Math.PI * 2;
      const rr = R * (0.25 + crng() * 0.55);
      const cr = R * (0.04 + crng() * 0.09);
      g.lineStyle(coreW * 0.8, p.crater, 0.55);
      g.strokeCircle(Math.cos(ang) * rr, Math.sin(ang) * rr, cr);
    }

    // ── núcleo mineral: anel central com cruz de mira ─────────────────
    g.lineStyle(coreW, p.core, 0.85);
    g.strokeCircle(0, 0, R * 0.16);
    g.lineStyle(coreW * 0.7, p.core, 0.5);
    g.lineBetween(-R * 0.22, 0, -R * 0.1, 0);
    g.lineBetween(R * 0.1, 0, R * 0.22, 0);
    g.lineBetween(0, -R * 0.22, 0, -R * 0.1);
    g.lineBetween(0, R * 0.1, 0, R * 0.22);
  }
}
