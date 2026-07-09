/**
 * EffectsRenderer — todos os efeitos visuais dinâmicos por frame:
 * jatos de propulsão, feixe de mineração, projéteis, zona de pouso,
 * fronteira da arena. Estilo retrô vetorial: linhas e pontos, sem
 * preenchimentos nem glow — a chama do motor pisca como no Asteroids.
 * Sem conhecer lógica de jogo ou rede.
 */

import Phaser from "phaser";
import { SHIP_RADIUS, SHIP_MAX_SPEED } from "@ceres/shared";
import { Palette } from "./Palette";

const SCREEN_LINE_WIDTH = 4;
const SCREEN_BEAM_WIDTH = 3;

export class EffectsRenderer {
  private jetGfx!: Phaser.GameObjects.Graphics;
  private beamGfx!: Phaser.GameObjects.Graphics;
  private projGfx!: Phaser.GameObjects.Graphics;
  private landZoneGfx!: Phaser.GameObjects.Graphics;
  private boundaryGfx!: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene, container: Phaser.GameObjects.Container) {
    this.jetGfx = scene.add.graphics();
    this.beamGfx = scene.add.graphics();
    this.projGfx = scene.add.graphics();
    this.landZoneGfx = scene.add.graphics();
    this.boundaryGfx = scene.add.graphics();

    container.add(this.jetGfx);
    container.add(this.beamGfx);
    container.add(this.projGfx);
    container.add(this.landZoneGfx);
    container.add(this.boundaryGfx);
  }

  beginFrame(): void {
    this.jetGfx.clear();
    this.beamGfx.clear();
    this.projGfx.clear();
    this.landZoneGfx.clear();
    this.boundaryGfx.clear();
  }

  // ── jato de propulsão ─────────────────────────────────────────────

  /**
   * Chama do motor à la Asteroids: um "V" de linhas saindo da traseira,
   * que pisca rápido e cresce com a velocidade. Chamar para cada nave
   * em movimento. `tt` = time.now / 1000.
   */
  drawJet(x: number, y: number, angle: number, speed: number, tt: number): void {
    const k = Math.min(speed / (SHIP_MAX_SPEED * 2), 1);
    if (k < 0.03) return;

    // cintilação: a chama some ~1/3 do tempo, dessincronizada por nave
    if (Math.sin(tt * 42 + x * 0.011 + y * 0.007) < -0.45) return;

    const R = SHIP_RADIUS;
    const back = angle + Math.PI;
    const bx = Math.cos(back);
    const by = Math.sin(back);
    const px_ = -by;
    const py_ = bx;

    // raiz da chama na traseira da nave; comprimento tremula levemente
    const rootX = x + bx * R * 0.55;
    const rootY = y + by * R * 0.55;
    const half = R * 0.3;
    const len = R * (0.7 + 1.9 * k) * (0.85 + 0.25 * Math.sin(tt * 57 + x * 0.017));

    const pts = [
      { x: rootX + px_ * half, y: rootY + py_ * half },
      { x: rootX + bx * len, y: rootY + by * len },
      { x: rootX - px_ * half, y: rootY - py_ * half },
    ];
    this.jetGfx.lineStyle(R * 0.3, Palette.fx.jet, 0.14);
    this.jetGfx.strokePoints(pts, false, false);
    this.jetGfx.lineStyle(R * 0.12, Palette.fx.jet, 0.9);
    this.jetGfx.strokePoints(pts, false, false);
  }

  // ── feixe de mineração ────────────────────────────────────────────

  drawMiningBeam(
    fromX: number, fromY: number,
    toX: number, toY: number,
    zoom: number,
    tt: number,
  ): void {
    const beamW = Phaser.Math.Clamp(SCREEN_BEAM_WIDTH / zoom, 0.5, 60);
    // feixe: linha única que tremula de intensidade
    const flick = 0.65 + 0.3 * Math.sin(tt * 22);
    this.beamGfx.lineStyle(beamW, Palette.fx.beam, flick);
    this.beamGfx.lineBetween(fromX, fromY, toX, toY);
    // ponto de impacto: círculo pequeno em contorno
    this.beamGfx.lineStyle(beamW * 0.7, Palette.fx.beam, flick);
    this.beamGfx.strokeCircle(toX, toY, beamW * (2 + Math.sin(tt * 12)));
  }

  // ── projéteis ─────────────────────────────────────────────────────

  drawBullet(x: number, y: number, zoom: number): void {
    const pw = Phaser.Math.Clamp(SCREEN_LINE_WIDTH / zoom, 0.5, 40);
    // ponto branco, como no arcade
    this.projGfx.fillStyle(Palette.fx.bullet, 1);
    this.projGfx.fillCircle(x, y, pw * 1.1);
  }

  drawGrenade(x: number, y: number, zoom: number, tt: number): void {
    const pw = Phaser.Math.Clamp(SCREEN_LINE_WIDTH / zoom, 0.5, 40);
    const pulse = 0.6 + 0.4 * Math.sin(tt * 14);
    // ponto central + anel em contorno pulsante
    this.projGfx.fillStyle(Palette.fx.grenade, pulse);
    this.projGfx.fillCircle(x, y, pw * 1.2);
    this.projGfx.lineStyle(pw * 0.6, Palette.fx.grenade, 0.7 * pulse);
    this.projGfx.strokeCircle(x, y, pw * (3 + Math.sin(tt * 14)));
  }

  // ── zona de pouso ─────────────────────────────────────────────────

  drawLandZone(x: number, y: number, radius: number, zoom: number, tt: number): void {
    const pulse = 0.35 + 0.35 * Math.sin(tt * 4.5);
    const lw = Phaser.Math.Clamp(SCREEN_LINE_WIDTH / zoom, 0.5, 100);
    // círculo tracejado girando lentamente — sem preenchimento
    this.landZoneGfx.lineStyle(lw, Palette.fx.landZone, 0.25 + pulse * 0.5);
    this.dashedCircle(this.landZoneGfx, x, y, radius, 24, tt * 0.15);
  }

  /** Círculo tracejado: `segs` arcos com vãos iguais, com rotação `phase`. */
  private dashedCircle(
    g: Phaser.GameObjects.Graphics,
    cx: number, cy: number, radius: number,
    segs: number, phase: number,
  ): void {
    const step = (Math.PI * 2) / segs;
    for (let i = 0; i < segs; i++) {
      const a0 = phase + i * step;
      g.beginPath();
      g.arc(cx, cy, radius, a0, a0 + step * 0.55);
      g.strokePath();
    }
  }

  // ── fronteira da arena ────────────────────────────────────────────

  drawBoundary(cx: number, cy: number, radius: number, zoom: number): void {
    const bw = Phaser.Math.Clamp(SCREEN_LINE_WIDTH / zoom, 0.5, 120);
    this.boundaryGfx.lineStyle(bw * 3, Palette.fx.boundary, 0.12);
    this.boundaryGfx.strokeCircle(cx, cy, radius);
    this.boundaryGfx.lineStyle(bw, Palette.fx.boundary, 0.7);
    this.boundaryGfx.strokeCircle(cx, cy, radius);
  }

  destroy(): void {
    this.jetGfx.destroy();
    this.beamGfx.destroy();
    this.projGfx.destroy();
    this.landZoneGfx.destroy();
    this.boundaryGfx.destroy();
  }
}
