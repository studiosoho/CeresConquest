/**
 * AsteroidRenderer — gera texturas procedurais de asteroides (uma por
 * shapeSeed+radius) e gerencia os sprites no worldLayer.
 * Sem conhecer lógica de jogo, rede ou física.
 */

import Phaser from "phaser";
import { asteroidSpinRate, mulberry32 } from "@ceres/shared";
import type { WorldPos } from "@ceres/shared";
import { asteroidVerts } from "../shapes";
import { Palette } from "./Palette";

/** Dados de um asteroide para o renderer. */
export interface AsteroidRenderData extends WorldPos {
  shapeSeed: number;
  radius: number;
  asteroidClass: "small" | "medium" | "large";
}

interface AsteroidEntry {
  sprite: Phaser.GameObjects.Sprite;
  spin: number;
}

export class AsteroidRenderer {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private texKeys = new Map<string, string>(); // `${shapeSeed}_${radius}` → key
  private texRts = new Map<string, Phaser.GameObjects.RenderTexture>(); // key → RT vivo
  private entries: AsteroidEntry[] = [];
  /** posições de render para o minimapa */
  readonly nearbyPositions: Array<{ rx: number; ry: number; asteroidClass: string }> = [];

  constructor(scene: Phaser.Scene, container: Phaser.GameObjects.Container) {
    this.scene = scene;
    this.container = container;
  }

  /** Reconstrói todos os sprites para o grid 3×3 de setores. */
  rebuild(asteroids: AsteroidRenderData[], toRender: (p: WorldPos) => { x: number; y: number }): void {
    for (const e of this.entries) e.sprite.destroy();
    this.entries = [];
    this.nearbyPositions.length = 0;

    for (const a of asteroids) {
      const key = this.getOrCreateTexture(a);
      const pos = toRender(a);
      const sprite = this.scene.add.sprite(pos.x, pos.y, key);
      sprite.setOrigin(0.5, 0.5);
      this.container.add(sprite);
      this.container.sendToBack(sprite);

      const spinNorm = this.spinRate(a.shapeSeed);
      this.entries.push({ sprite, spin: spinNorm });
      this.nearbyPositions.push({ rx: pos.x, ry: pos.y, asteroidClass: a.asteroidClass });
    }
  }

  /** Aplica rotação leve a cada frame (tt = time.now / 1000). */
  tick(tt: number): void {
    for (const e of this.entries) e.sprite.setRotation(e.spin * tt);
  }

  destroy(): void {
    for (const e of this.entries) e.sprite.destroy();
    this.entries = [];
    for (const key of this.texKeys.values()) {
      if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
    }
    this.texKeys.clear();
    for (const rt of this.texRts.values()) rt.destroy();
    this.texRts.clear();
  }

  // ── geração de textura ────────────────────────────────────────────

  private getOrCreateTexture(a: AsteroidRenderData): string {
    const cacheKey = `${a.shapeSeed}_${Math.round(a.radius)}`;
    const existing = this.texKeys.get(cacheKey);
    if (existing) return existing;

    const texKey = `ast_${cacheKey}`;
    const margin = a.radius * 0.15;
    const size = (a.radius + margin) * 2;
    const cx = size / 2;
    const cy = size / 2;

    // RenderTexture.draw(obj, x, y) desenha obj com offset (x,y) dentro do RT,
    // ignorando a posição do objeto — passamos cx,cy para centralizar o desenho
    const rt = this.scene.add.renderTexture(0, 0, Math.ceil(size), Math.ceil(size));
    const g = this.scene.add.graphics();
    this.drawAsteroid(g, a);
    rt.draw(g, cx, cy);
    rt.saveTexture(texKey);
    g.destroy();
    rt.setVisible(false);
    // não destrói o RT — destroy() invalida a textura salva no TextureManager
    this.texRts.set(texKey, rt);

    this.texKeys.set(cacheKey, texKey);
    return texKey;
  }

  private drawAsteroid(g: Phaser.GameObjects.Graphics, a: AsteroidRenderData): void {
    const verts = asteroidVerts(a.shapeSeed, a.radius);
    const p = Palette.asteroid;

    // largura de traço absoluta (unidades de mundo) — como o feixe de um
    // monitor vetorial, a linha não engrossa com o tamanho da rocha
    const coreW = 5;
    const haloW = 16;

    // ── contorno wireframe (halo de fósforo + núcleo) ─────────────────
    g.lineStyle(haloW, p.line, 0.13);
    g.strokePoints(verts, true, true);
    g.lineStyle(coreW, p.line, 0.95);
    g.strokePoints(verts, true, true);

    // ── crateras: círculos em contorno, sem preenchimento ─────────────
    const crng = mulberry32((a.shapeSeed ^ 0xabcd1234) >>> 0);
    const nCraters = 2 + Math.floor(crng() * 3);
    for (let c = 0; c < nCraters; c++) {
      const ang = crng() * Math.PI * 2;
      const d = crng() * a.radius * 0.55;
      const cr = a.radius * (0.06 + crng() * 0.1);
      g.lineStyle(coreW * 0.7, p.crater, 0.4);
      g.strokeCircle(Math.cos(ang) * d, Math.sin(ang) * d, cr);
    }
  }

  private spinRate(shapeSeed: number): number {
    return asteroidSpinRate(shapeSeed); // fonte única do shared
  }
}
