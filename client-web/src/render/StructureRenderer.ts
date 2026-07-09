/**
 * StructureRenderer — desenha estruturas (miningStation, hq, initialBase)
 * com fill colorido, detalhes e hangares com mini-sprites das naves.
 * Redesenha apenas quando a ocupação do hangar muda (assinatura).
 */

import Phaser from "phaser";
import { SHIP_RADIUS, STRUCTURE_SPECS } from "@ceres/shared";
import type { StructureType, ShipKind } from "@ceres/shared";
import { structureVerts, shipVerts } from "../shapes";
import { Palette } from "./Palette";

export interface StructureRenderData {
  id: string;
  stype: StructureType;
  owner: string;
  angle: number;
  shipBays: number;
  expandedBays: number;
  own: boolean;
  spin: number;
  x: number;
  y: number;
}

interface StructEntry {
  gfx: Phaser.GameObjects.Graphics;
  lastSig: string;
  spin: number;
  own: boolean;
  type: StructureType;
  radius: number;
  shipBays: number;
  expandedBays: number;
}

export class StructureRenderer {
  private scene: Phaser.Scene;
  private container: Phaser.GameObjects.Container;
  private entries = new Map<string, StructEntry>();
  private strokeWidth = 4;

  constructor(scene: Phaser.Scene, container: Phaser.GameObjects.Container) {
    this.scene = scene;
    this.container = container;
  }

  setStrokeWidth(w: number): void {
    this.strokeWidth = w;
  }

  /** Atualiza ou cria a entrada para uma estrutura. */
  upsert(data: StructureRenderData, occupants: ShipKind[]): void {
    let entry = this.entries.get(data.id);
    if (!entry) {
      const gfx = this.scene.add.graphics();
      this.container.add(gfx);
      entry = {
        gfx,
        lastSig: "\0",
        spin: data.spin,
        own: data.own,
        type: data.stype,
        radius: STRUCTURE_SPECS[data.stype].radius,
        shipBays: data.shipBays,
        expandedBays: data.expandedBays,
      };
      this.entries.set(data.id, entry);
    }

    const sig = occupants.join(",");
    if (sig !== entry.lastSig) {
      entry.lastSig = sig;
      this.redraw(entry, occupants);
    }

    entry.gfx.setPosition(data.x, data.y).setRotation(data.angle + entry.spin * 0); // spin aplicado em tick()
  }

  /** Aplica rotação por frame (tt = time.now / 1000). */
  tick(id: string, x: number, y: number, angle: number, tt: number): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.gfx.setPosition(x, y).setRotation(angle + entry.spin * tt);
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.gfx.destroy();
      this.entries.delete(id);
    }
  }

  /** Invalida todas as assinaturas → redesenha no próximo upsert. */
  invalidateAll(): void {
    for (const e of this.entries.values()) e.lastSig = "\0";
  }

  destroy(): void {
    for (const e of this.entries.values()) e.gfx.destroy();
    this.entries.clear();
  }

  // ── desenho ───────────────────────────────────────────────────────

  private redraw(entry: StructEntry, occupants: ShipKind[]): void {
    const g = entry.gfx;
    const w = this.strokeWidth;
    const R = entry.radius;
    const verts = structureVerts(entry.type, R);
    const ownColor = entry.own ? Palette.structure.own : Palette.structure.other;

    g.clear();

    // ── contorno principal (wireframe puro, com halo de fósforo) ──────
    g.lineStyle(w * 3, ownColor, 0.14);
    g.strokePoints(verts, true, true);
    g.lineStyle(w, ownColor, 1);
    g.strokePoints(verts, true, true);

    // ── detalhes internos por tipo ────────────────────────────────────
    if (entry.type === "miningStation") this.drawMiningDetails(g, R, w, ownColor);
    else if (entry.type === "hq") this.drawHqDetails(g, R, w, ownColor);
    else if (entry.type === "initialBase") this.drawBaseDetails(g, R, w, ownColor);
    else if (entry.type === "rationCenter") this.drawRationDetails(g, R, w, ownColor);

    // ── hangares ──────────────────────────────────────────────────────
    this.drawHangars(g, entry, occupants, w);
  }

  private drawMiningDetails(g: Phaser.GameObjects.Graphics, R: number, w: number, col: number): void {
    // painéis solares (linhas horizontais no topo)
    g.lineStyle(Math.max(w * 0.4, 0.5), col, 0.45);
    for (let i = -2; i <= 2; i++) {
      g.lineBetween(i * R * 0.08, -R * 0.42, i * R * 0.08, -R * 0.58);
    }
    // indicador de estoque (retângulo central)
    g.lineStyle(Math.max(w * 0.35, 0.4), col, 0.35);
    g.strokeRect(-R * 0.18, -R * 0.08, R * 0.36, R * 0.16);
  }

  private drawHqDetails(g: Phaser.GameObjects.Graphics, R: number, w: number, col: number): void {
    // torre central: linha vertical
    g.lineStyle(Math.max(w * 0.5, 0.5), col, 0.5);
    g.lineBetween(0, -R * 0.95, 0, -R * 0.42);
    // antenas laterais
    g.lineStyle(Math.max(w * 0.3, 0.3), col, 0.4);
    g.lineBetween(-R * 0.38, -R * 0.38, -R * 0.55, -R * 0.55);
    g.lineBetween(R * 0.38, -R * 0.38, R * 0.55, -R * 0.55);
    // janelas (pontos)
    g.fillStyle(col, 0.6);
    for (let i = -1; i <= 1; i++) {
      g.fillRect(i * R * 0.12 - R * 0.03, R * 0.55, R * 0.06, R * 0.1);
    }
  }

  private drawRationDetails(g: Phaser.GameObjects.Graphics, R: number, w: number, col: number): void {
    // antena central
    g.lineStyle(Math.max(w * 0.4, 0.5), col, 0.55);
    g.lineBetween(0, -R * 0.42, 0, -R * 0.95);
    g.lineBetween(-R * 0.08, -R * 0.72, R * 0.08, -R * 0.72);
    // silos laterais (retângulos)
    g.lineStyle(Math.max(w * 0.35, 0.4), col, 0.4);
    g.strokeRect(-R * 0.62, R * 0.22, R * 0.24, R * 0.4);
    g.strokeRect(R * 0.38, R * 0.22, R * 0.24, R * 0.4);
    // indicador de nível de rações (linha horizontal nos silos)
    g.lineStyle(Math.max(w * 0.3, 0.3), 0xffcc44, 0.5);
    g.lineBetween(-R * 0.62, R * 0.42, -R * 0.38, R * 0.42);
    g.lineBetween(R * 0.38, R * 0.42, R * 0.62, R * 0.42);
  }

  private drawBaseDetails(g: Phaser.GameObjects.Graphics, R: number, w: number, col: number): void {
    // cúpula habitacional (arco)
    g.lineStyle(Math.max(w * 0.45, 0.5), col, 0.5);
    const steps = 12;
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= steps; i++) {
      const a = Math.PI + (i / steps) * Math.PI;
      pts.push({ x: Math.cos(a) * R * 0.38, y: Math.sin(a) * R * 0.28 - R * 0.12 });
    }
    g.strokePoints(pts, false, false);
    // antena (linha fina no topo)
    g.lineStyle(Math.max(w * 0.3, 0.3), col, 0.55);
    g.lineBetween(0, -R * 0.42, 0, -R * 0.95);
    g.lineBetween(-R * 0.06, -R * 0.72, R * 0.06, -R * 0.72);
    // janelas da cúpula
    g.fillStyle(0x88ddff, 0.5);
    g.fillCircle(-R * 0.12, -R * 0.22, R * 0.04);
    g.fillCircle(R * 0.12, -R * 0.22, R * 0.04);
  }

  private drawHangars(g: Phaser.GameObjects.Graphics, entry: StructEntry, occupants: ShipKind[], w: number): void {
    const R = entry.radius;
    const cap = entry.shipBays;
    const expandedBays = entry.expandedBays;
    const slotN = SHIP_RADIUS * 2.0;
    const slotEW = SHIP_RADIUS * 3.2;
    const slotEH = SHIP_RADIUS * 2.4;
    const gap = SHIP_RADIUS * 0.5;
    const y0 = R + slotEH * 0.6;

    let totalW = 0;
    for (let i = 0; i < cap; i++) {
      totalW += (i < expandedBays ? slotEW : slotN) + (i > 0 ? gap : 0);
    }
    let curX = -totalW / 2;

    for (let i = 0; i < cap; i++) {
      const isExp = i < expandedBays;
      const sw = isExp ? slotEW : slotN;
      const sh = isExp ? slotEH : slotN;
      const cx = curX + sw / 2;

      // vaga: só contorno, sem preenchimento
      g.lineStyle(Math.max(w * 0.5, 0.5), Palette.structure.hangar, 0.8);
      g.strokeRect(cx - sw / 2, y0 - sh / 2, sw, sh);

      // marca nas expandidas
      if (isExp) {
        g.lineStyle(Math.max(w * 0.3, 0.3), Palette.structure.hangar, 0.5);
        g.lineBetween(cx - sw / 2 + w, y0 - sh / 2 + sh * 0.28, cx + sw / 2 - w, y0 - sh / 2 + sh * 0.28);
      }

      // mini-nave na vaga
      const kind = occupants[i];
      if (kind) {
        const shipCol = entry.own ? Palette.structure.fleet : 0x8899aa;
        g.lineStyle(w * 0.75, shipCol, 0.9);
        const scale = isExp ? 0.9 : 0.7;
        const mini = shipVerts(kind).map(v => ({ x: cx + v.x * scale, y: y0 + v.y * scale }));
        g.strokePoints(mini, true, true);
      }

      curX += sw + gap;
    }
  }
}
