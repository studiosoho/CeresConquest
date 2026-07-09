/**
 * HudRenderer — HUD futurista desenhado com Graphics + Text.
 * Sem conhecer lógica de jogo, rede ou física.
 * GameScene passa os dados; HudRenderer decide como exibir.
 */

import Phaser from "phaser";
import { CERES_RADIUS, SECTOR_SIZE, ASTEROID_CLASSES } from "@ceres/shared";
import type { ShipKind, WorldPos } from "@ceres/shared";
import { Palette } from "./Palette";

const MINIMAP_SIZE = 220;
const MINIMAP_MARGIN = 12;
const MINIMAP_RANGE = 15_000;

export interface HudShipData {
  kind: ShipKind;
  hp: number;
  ammo: number;
  grenadeAmmo: number;
  ammoMax: number;
  grenadeMax: number;
  cargoKind: string;
  cargoAmount: number;
  mining: boolean;
  anchored: boolean;
  landingPhase: string;
  landingProgress: number;
}

export interface HudContextData {
  ore: number;
  zoom: number;
  isFlying: boolean;
  inLandZone: boolean;
  canAnchor: boolean;
  anchorHint: string;
  swapHint: string;
  autoHint: string;
  stationBufferHint: string;
  storeHint: string;
  cargoHint: string;
  ammoHint: string;
  taxiLine: string;
  prodLine: string;
  anchorTag: string;
  landHint: string;
}

export interface MinimapData {
  own: { x: number; y: number };
  angle: number;
  remotes: Array<{ rx: number; ry: number }>;
  asteroids: Array<{ rx: number; ry: number; asteroidClass: string }>;
  ceres: WorldPos | null;
  mapCenter: WorldPos | null;
  mapRadius: number;
  minimapFull: boolean;
  toRender: (p: WorldPos) => { x: number; y: number };
}

export class HudRenderer {
  private panelGfx!: Phaser.GameObjects.Graphics;
  private statusText!: Phaser.GameObjects.Text;
  private minimapGfx!: Phaser.GameObjects.Graphics;
  private minimapMask!: Phaser.GameObjects.Graphics;

  constructor(scene: Phaser.Scene, container: Phaser.GameObjects.Container) {
    this.panelGfx = scene.add.graphics();
    this.statusText = scene.add.text(0, 0, "", {
      fontFamily: "monospace",
      fontSize: "15px",
      color: "#d8e8f8",
      lineSpacing: 4,
    });
    this.minimapGfx = scene.add.graphics();
    this.minimapMask = scene.make.graphics();
    this.minimapGfx.setMask(this.minimapMask.createGeometryMask());

    container.add([this.panelGfx, this.statusText, this.minimapGfx]);
  }

  resize(width: number, height: number): void {
    void height;
    void width;
    // reposiciona o texto no próximo draw
  }

  // ── painel de status ──────────────────────────────────────────────

  drawStatus(ship: HudShipData, ctx: HudContextData, screenW: number): void {
    this.panelGfx.clear();

    const lPhase = ship.landingPhase;

    if (lPhase === "landing") {
      const pct = Math.round(ship.landingProgress * 100);
      this.drawPanel(0, 0, 260, 36);
      this.statusText.setPosition(12, 8);
      this.statusText.setText(`⬇ Pousando… ${pct}%`);
      return;
    }

    if (lPhase === "landed") {
      const lines = this.buildLandedText(ship, ctx);
      this.drawPanel(0, 0, 420, 8 + lines.split("\n").length * 22);
      this.statusText.setPosition(12, 8);
      this.statusText.setText(lines);
      return;
    }

    // ── painel principal em voo ───────────────────────────────────────
    const lines = this.buildFlightText(ship, ctx);
    const lineCount = lines.split("\n").length;
    const panelW = Math.min(screenW - MINIMAP_SIZE - MINIMAP_MARGIN * 3, 780);
    const panelH = 12 + lineCount * 22;
    this.drawPanel(0, 0, panelW, panelH);
    this.statusText.setPosition(12, 8);
    this.statusText.setText(lines);

    // ── barra de HP ───────────────────────────────────────────────────
    const barY = panelH + 6;
    const barW = 120;
    const barH = 6;
    const hpFrac = Math.max(0, Math.min(1, ship.hp / 100));
    const hpColor = hpFrac > 0.5 ? 0x44dd88 : hpFrac > 0.25 ? 0xffcc00 : 0xff3322;
    this.panelGfx.fillStyle(0x0a1018, 0.7);
    this.panelGfx.fillRect(12, barY, barW, barH);
    this.panelGfx.fillStyle(hpColor, 0.9);
    this.panelGfx.fillRect(12, barY, barW * hpFrac, barH);
    this.panelGfx.lineStyle(1, 0x3a5060, 0.8);
    this.panelGfx.strokeRect(12, barY, barW, barH);

    // ── barras de munição (nave de ataque) ────────────────────────────
    if (ship.kind === "attack" && ship.ammoMax > 0) {
      const ammoY = barY + 10;
      const ammoFrac = ship.ammo / ship.ammoMax;
      const grenFrac = ship.grenadeAmmo / ship.grenadeMax;
      // perfurante
      this.panelGfx.fillStyle(0x0a1018, 0.7);
      this.panelGfx.fillRect(12, ammoY, barW, 5);
      this.panelGfx.fillStyle(Palette.fx.bullet, 0.85);
      this.panelGfx.fillRect(12, ammoY, barW * ammoFrac, 5);
      this.panelGfx.lineStyle(1, 0x3a5060, 0.6);
      this.panelGfx.strokeRect(12, ammoY, barW, 5);
      // granada
      this.panelGfx.fillStyle(0x0a1018, 0.7);
      this.panelGfx.fillRect(12, ammoY + 8, barW, 5);
      this.panelGfx.fillStyle(Palette.fx.grenade, 0.85);
      this.panelGfx.fillRect(12, ammoY + 8, barW * grenFrac, 5);
      this.panelGfx.lineStyle(1, 0x3a5060, 0.6);
      this.panelGfx.strokeRect(12, ammoY + 8, barW, 5);
    }
  }

  // ── minimapa ──────────────────────────────────────────────────────

  drawMinimap(data: MinimapData, screenW: number, screenH: number): void {
    const size = MINIMAP_SIZE;
    const x0 = screenW - size - MINIMAP_MARGIN;
    const y0 = MINIMAP_MARGIN;
    const cx = x0 + size / 2;
    const cy = y0 + size / 2;
    const range = data.minimapFull && data.mapRadius > 0 ? data.mapRadius : MINIMAP_RANGE;
    const k = size / 2 / range;
    const half = size / 2;
    const own = data.own;

    const g = this.minimapGfx;
    this.minimapMask.clear();
    this.minimapMask.fillStyle(0xffffff);
    this.minimapMask.fillRect(x0, y0, size, size);

    g.clear();

    // radar de arcade: fundo preto e uma única borda de linha
    g.fillStyle(Palette.ui.minimapBg, 0.7);
    g.fillRect(x0, y0, size, size);
    g.lineStyle(1, Palette.ui.minimapBorder, 0.8);
    g.strokeRect(x0, y0, size, size);

    // grade de setores
    g.lineStyle(1, Palette.ui.minimapGrid, 0.6);
    for (let i = -1; i <= 2; i++) {
      const dx = (i * SECTOR_SIZE - own.x) * k;
      if (Math.abs(dx) < half) g.lineBetween(cx + dx, y0, cx + dx, y0 + size);
      const dy = (i * SECTOR_SIZE - own.y) * k;
      if (Math.abs(dy) < half) g.lineBetween(x0, cy + dy, x0 + size, cy + dy);
    }

    // fronteira da arena
    if (data.minimapFull && data.mapCenter && data.mapRadius > 0) {
      const mc = data.toRender(data.mapCenter);
      g.lineStyle(1, Palette.fx.boundary, 0.6);
      g.strokeCircle(cx + (mc.x - own.x) * k, cy + (mc.y - own.y) * k, data.mapRadius * k);
    }

    // Ceres
    if (data.ceres) {
      const cp = data.toRender(data.ceres);
      const ccx = cx + (cp.x - own.x) * k;
      const ccy = cy + (cp.y - own.y) * k;
      const cr = CERES_RADIUS * k;
      g.fillStyle(Palette.ceres.body, 0.25);
      g.fillCircle(ccx, ccy, cr);
      g.lineStyle(1.5, Palette.ceres.body, 0.9);
      g.strokeCircle(ccx, ccy, cr);
    }

    // asteroides
    for (const a of data.asteroids) {
      const dx = (a.rx - own.x) * k;
      const dy = (a.ry - own.y) * k;
      if (Math.abs(dx) < half - 2 && Math.abs(dy) < half - 2) {
        const col = parseInt(
          ASTEROID_CLASSES[a.asteroidClass as keyof typeof ASTEROID_CLASSES].color.slice(1), 16,
        );
        g.fillStyle(col, 0.85);
        g.fillCircle(cx + dx, cy + dy, 1.5);
      }
    }

    // naves remotas
    for (const r of data.remotes) {
      const dx = (r.rx - own.x) * k;
      const dy = (r.ry - own.y) * k;
      if (Math.abs(dx) < half - 2 && Math.abs(dy) < half - 2) {
        g.fillStyle(0x8899aa, 0.9);
        g.fillCircle(cx + dx, cy + dy, 2.5);
      }
    }

    // nave própria: ponto + seta de direção
    g.fillStyle(0xffffff, 1);
    g.fillCircle(cx, cy, 3.5);
    g.lineStyle(1.5, 0xffffff, 1);
    const ang = data.angle;
    g.lineBetween(cx, cy, cx + Math.cos(ang) * 10, cy + Math.sin(ang) * 10);

    // label "RADAR"
    void screenH;
  }

  destroy(): void {
    this.panelGfx.destroy();
    this.statusText.destroy();
    this.minimapGfx.destroy();
    this.minimapMask.destroy();
  }

  // ── helpers privados ──────────────────────────────────────────────

  private drawPanel(x: number, y: number, w: number, h: number): void {
    // painel de arcade: fundo preto e uma única borda de linha
    this.panelGfx.fillStyle(0x000000, 0.6);
    this.panelGfx.fillRect(x, y, w, h);
    this.panelGfx.lineStyle(1, Palette.ui.minimapBorder, 0.6);
    this.panelGfx.strokeRect(x, y, w, h);
  }

  private buildFlightText(ship: HudShipData, ctx: HudContextData): string {
    const kindLabel: Record<ShipKind, string> = {
      builder: "Builder", mining: "Mineração", attack: "Ataque", transport: "Transporte",
    };
    const line1 =
      `⬡ ${ctx.ore} min  ·  ${kindLabel[ship.kind]}  ·  ${ctx.zoom.toFixed(2)}×` +
      `${ctx.anchorTag}${ctx.anchorHint}${ctx.swapHint}${ctx.autoHint}` +
      `${ctx.stationBufferHint}${ctx.ammoHint}${ctx.storeHint}${ctx.cargoHint}`;
    const line2 =
      `W/↑ acelerar · A/D girar${ctx.landHint}` +
      (ship.kind === "attack"
        ? " · [ESP] disparar · [G] granada"
        : `${ctx.isFlying ? " · [G] auto-minerar · [C] trocar" : ""}`) +
      " · roda/+/- zoom";
    return [line1, line2, ctx.prodLine, ctx.taxiLine].filter(Boolean).join("\n");
  }

  private buildLandedText(ship: HudShipData, ctx: HudContextData): string {
    const miningOn = ship.anchored;
    return (
      `⬡ Pousado no asteroide${miningOn ? "  ·  ⛏ MINERANDO (minério: " + ctx.ore + ")" : ""}\n` +
      (miningOn
        ? "[ESPAÇO] parar mineração\n[F] decolar — pare a mineração antes"
        : "[ESPAÇO] iniciar mineração automática\n" +
          (ship.kind === "builder"
            ? `[1] construir estação  [2] construir QG  [3] centro de rações\n`
            : "") +
          "[F] decolar")
    );
  }
}
