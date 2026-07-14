/**
 * HudRenderer — HUD em overlay DOM sobre o canvas (texto monospace + barras
 * via CSS) e um `<canvas>` 2D dedicado para o minimapa. Decisão 3 do plano de
 * migração: o HUD sai do engine Babylon inteiramente — nem GlowLayer, nem
 * câmera, nem GreasedLine entram aqui. Sem conhecer lógica de jogo, rede ou
 * física: GameScene passa os dados, HudRenderer decide como exibir.
 *
 * O painel de status ancora via CSS `left`/`right` (não recalcula largura a
 * partir da largura da tela como o Phaser fazia) — por isso `drawStatus` e
 * `drawMinimap` não recebem mais dimensões de tela; o clip do minimapa vem de
 * graça do próprio retângulo do `<canvas>`, sem precisar de geometry mask.
 */

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

/** `0xRRGGBB` → string CSS, com alpha opcional. */
function cssColor(hex: number, alpha = 1): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export class HudRenderer {
  private root: HTMLDivElement;
  private statusPanel: HTMLDivElement;
  private statusText: HTMLDivElement;
  private hpBarOuter: HTMLDivElement;
  private hpBarFill: HTMLDivElement;
  private ammoBars: HTMLDivElement;
  private bulletBarFill: HTMLDivElement;
  private grenadeBarFill: HTMLDivElement;
  private minimapCanvas: HTMLCanvasElement;
  private minimapCtx: CanvasRenderingContext2D;

  constructor() {
    this.root = document.createElement("div");
    this.root.style.cssText =
      "position:fixed;inset:0;pointer-events:none;font-family:monospace;" +
      "color:#d8e8f8;z-index:5;user-select:none;";

    this.statusPanel = document.createElement("div");
    this.statusPanel.style.cssText =
      `position:absolute;left:0;top:0;max-width:780px;` +
      `right:${MINIMAP_SIZE + MINIMAP_MARGIN * 3}px;` +
      `background:${cssColor(0x000000, 0.6)};border:1px solid ${cssColor(Palette.ui.minimapBorder, 0.6)};` +
      "padding:8px 12px;box-sizing:border-box;";

    this.statusText = document.createElement("div");
    this.statusText.style.cssText = "font-size:15px;line-height:22px;white-space:pre-line;";
    this.statusPanel.appendChild(this.statusText);

    const makeBar = (): { outer: HTMLDivElement; fill: HTMLDivElement } => {
      const outer = document.createElement("div");
      outer.style.cssText =
        `width:120px;height:6px;margin-top:4px;background:${cssColor(0x0a1018, 0.7)};` +
        `border:1px solid ${cssColor(0x3a5060, 0.8)};box-sizing:border-box;`;
      const fill = document.createElement("div");
      fill.style.cssText = "height:100%;width:0;";
      outer.appendChild(fill);
      return { outer, fill };
    };

    const hpBar = makeBar();
    this.hpBarOuter = hpBar.outer;
    this.hpBarFill = hpBar.fill;
    this.statusPanel.appendChild(this.hpBarOuter);

    this.ammoBars = document.createElement("div");
    const bulletBar = makeBar();
    const grenadeBar = makeBar();
    this.bulletBarFill = bulletBar.fill;
    this.grenadeBarFill = grenadeBar.fill;
    bulletBar.outer.style.height = "5px";
    grenadeBar.outer.style.height = "5px";
    grenadeBar.outer.style.marginTop = "3px";
    this.ammoBars.appendChild(bulletBar.outer);
    this.ammoBars.appendChild(grenadeBar.outer);
    this.statusPanel.appendChild(this.ammoBars);

    this.minimapCanvas = document.createElement("canvas");
    this.minimapCanvas.style.cssText =
      `position:absolute;right:${MINIMAP_MARGIN}px;top:${MINIMAP_MARGIN}px;` +
      `width:${MINIMAP_SIZE}px;height:${MINIMAP_SIZE}px;`;
    const dpr = window.devicePixelRatio || 1;
    this.minimapCanvas.width = MINIMAP_SIZE * dpr;
    this.minimapCanvas.height = MINIMAP_SIZE * dpr;
    const ctx = this.minimapCanvas.getContext("2d");
    if (!ctx) throw new Error("2D context indisponível para o minimapa");
    this.minimapCtx = ctx;
    this.minimapCtx.scale(dpr, dpr);

    this.root.appendChild(this.statusPanel);
    this.root.appendChild(this.minimapCanvas);
    document.body.appendChild(this.root);
  }

  // ── painel de status ──────────────────────────────────────────────

  drawStatus(ship: HudShipData, ctx: HudContextData): void {
    const lPhase = ship.landingPhase;
    this.hpBarOuter.style.display = "none";
    this.ammoBars.style.display = "none";

    if (lPhase === "landing") {
      const pct = Math.round(ship.landingProgress * 100);
      this.statusText.textContent = `⬇ Pousando… ${pct}%`;
      return;
    }

    if (lPhase === "landed") {
      this.statusText.textContent = this.buildLandedText(ship, ctx);
      return;
    }

    // ── painel principal em voo ───────────────────────────────────────
    this.statusText.textContent = this.buildFlightText(ship, ctx);

    this.hpBarOuter.style.display = "";
    const hpFrac = Math.max(0, Math.min(1, ship.hp / 100));
    const hpColor = hpFrac > 0.5 ? "#44dd88" : hpFrac > 0.25 ? "#ffcc00" : "#ff3322";
    this.hpBarFill.style.width = `${hpFrac * 100}%`;
    this.hpBarFill.style.background = hpColor;

    if (ship.kind === "attack" && ship.ammoMax > 0) {
      this.ammoBars.style.display = "";
      this.bulletBarFill.style.width = `${(ship.ammo / ship.ammoMax) * 100}%`;
      this.bulletBarFill.style.background = cssColor(Palette.fx.bullet, 0.85);
      this.grenadeBarFill.style.width = `${(ship.grenadeAmmo / ship.grenadeMax) * 100}%`;
      this.grenadeBarFill.style.background = cssColor(Palette.fx.grenade, 0.85);
    }
  }

  // ── minimapa ──────────────────────────────────────────────────────

  drawMinimap(data: MinimapData): void {
    const size = MINIMAP_SIZE;
    const cx = size / 2;
    const cy = size / 2;
    const range = data.minimapFull && data.mapRadius > 0 ? data.mapRadius : MINIMAP_RANGE;
    const k = size / 2 / range;
    const half = size / 2;
    const own = data.own;
    const g = this.minimapCtx;

    g.clearRect(0, 0, size, size);

    // radar de arcade: fundo preto e uma única borda de linha
    g.fillStyle = cssColor(Palette.ui.minimapBg, 0.7);
    g.fillRect(0, 0, size, size);
    g.strokeStyle = cssColor(Palette.ui.minimapBorder, 0.8);
    g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, size - 1, size - 1);

    // grade de setores
    g.strokeStyle = cssColor(Palette.ui.minimapGrid, 0.6);
    for (let i = -1; i <= 2; i++) {
      const dx = (i * SECTOR_SIZE - own.x) * k;
      if (Math.abs(dx) < half) {
        g.beginPath();
        g.moveTo(cx + dx, 0);
        g.lineTo(cx + dx, size);
        g.stroke();
      }
      const dy = (i * SECTOR_SIZE - own.y) * k;
      if (Math.abs(dy) < half) {
        g.beginPath();
        g.moveTo(0, cy + dy);
        g.lineTo(size, cy + dy);
        g.stroke();
      }
    }

    // fronteira da arena
    if (data.minimapFull && data.mapCenter && data.mapRadius > 0) {
      const mc = data.toRender(data.mapCenter);
      g.strokeStyle = cssColor(Palette.fx.boundary, 0.6);
      g.beginPath();
      g.arc(cx + (mc.x - own.x) * k, cy + (mc.y - own.y) * k, data.mapRadius * k, 0, Math.PI * 2);
      g.stroke();
    }

    // Ceres
    if (data.ceres) {
      const cp = data.toRender(data.ceres);
      const ccx = cx + (cp.x - own.x) * k;
      const ccy = cy + (cp.y - own.y) * k;
      const cr = CERES_RADIUS * k;
      g.beginPath();
      g.arc(ccx, ccy, cr, 0, Math.PI * 2);
      g.fillStyle = cssColor(Palette.ceres.body, 0.25);
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = cssColor(Palette.ceres.body, 0.9);
      g.stroke();
    }

    // asteroides
    for (const a of data.asteroids) {
      const dx = (a.rx - own.x) * k;
      const dy = (a.ry - own.y) * k;
      if (Math.abs(dx) < half - 2 && Math.abs(dy) < half - 2) {
        g.fillStyle = ASTEROID_CLASSES[a.asteroidClass as keyof typeof ASTEROID_CLASSES].color;
        g.globalAlpha = 0.85;
        g.beginPath();
        g.arc(cx + dx, cy + dy, 1.5, 0, Math.PI * 2);
        g.fill();
        g.globalAlpha = 1;
      }
    }

    // naves remotas
    g.fillStyle = "#8899aa";
    g.globalAlpha = 0.9;
    for (const r of data.remotes) {
      const dx = (r.rx - own.x) * k;
      const dy = (r.ry - own.y) * k;
      if (Math.abs(dx) < half - 2 && Math.abs(dy) < half - 2) {
        g.beginPath();
        g.arc(cx + dx, cy + dy, 2.5, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.globalAlpha = 1;

    // nave própria: ponto + seta de direção
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.arc(cx, cy, 3.5, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#ffffff";
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(data.angle) * 10, cy + Math.sin(data.angle) * 10);
    g.stroke();
  }

  destroy(): void {
    this.root.remove();
  }

  // ── helpers privados ──────────────────────────────────────────────

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
