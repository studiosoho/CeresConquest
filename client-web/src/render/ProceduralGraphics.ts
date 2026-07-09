/**
 * ProceduralGraphics — desenha naves em wireframe vetorial puro (estilo
 * Asteroids/Atari) usando apenas Phaser.Graphics: contorno + poucas linhas
 * internas, sem preenchimento. Cada traço tem duas passadas — um halo largo
 * de baixa opacidade e um núcleo fino — simulando o brilho de fósforo dos
 * monitores vetoriais.
 * Sem conhecer Scene, entidades, multiplayer ou lógica de jogo.
 * Cada função recebe um Graphics já posicionado em (0,0) e desenha em
 * coordenadas locais. O tamanho base é SHIP_RADIUS importado do shared.
 * As naves são desenhadas em branco puro — o tint do sprite dá a cor final.
 */

import Phaser from "phaser";
import { SHIP_RADIUS } from "@ceres/shared";
import { shipVerts } from "../shapes";
import { Palette } from "./Palette";

const R = SHIP_RADIUS;
const LINE = Palette.ship.line;
/** núcleo do traço (unidades de mundo — a textura é 1:1) */
const CORE_W = R * 0.12;
/** halo de fósforo ao redor do traço */
const HALO_W = R * 0.36;

type Pt = { x: number; y: number };

// ── Utilitários internos ──────────────────────────────────────────────

/** Traço vetorial com halo: passada larga translúcida + núcleo fino. */
function wire(g: Phaser.GameObjects.Graphics, pts: Pt[], closed = true, alpha = 1) {
  g.lineStyle(HALO_W, LINE, 0.14 * alpha);
  g.strokePoints(pts, closed, closed);
  g.lineStyle(CORE_W, LINE, alpha);
  g.strokePoints(pts, closed, closed);
}

/** Linha interna simples (detalhe), sem halo — mais fina que o contorno. */
function detail(g: Phaser.GameObjects.Graphics, x1: number, y1: number, x2: number, y2: number, alpha = 0.8) {
  g.lineStyle(CORE_W * 0.8, LINE, alpha);
  g.lineBetween(x1, y1, x2, y2);
}

// ── Builder ───────────────────────────────────────────────────────────

/**
 * Builder: silhueta oval rechonchuda em contorno, com "V" de cabine na
 * frente e dois traços de motor atrás.
 */
export function drawBuilderShip(g: Phaser.GameObjects.Graphics): void {
  wire(g, shipVerts("builder"));

  // cabine: chevron apontando para a frente
  detail(g, R * 0.3, -R * 0.32, R * 0.62, 0);
  detail(g, R * 0.3, R * 0.32, R * 0.62, 0);

  // motores: dois traços curtos na traseira
  detail(g, -R * 0.9, -R * 0.22, -R * 0.62, -R * 0.3, 0.6);
  detail(g, -R * 0.9, R * 0.22, -R * 0.62, R * 0.3, 0.6);
}

// ── Mining ────────────────────────────────────────────────────────────

/**
 * Mineradora: casco atarracado em contorno, broca frontal em espinha
 * com dentes e um painel interno.
 */
export function drawMiningShip(g: Phaser.GameObjects.Graphics): void {
  wire(g, shipVerts("mining"));

  // broca: espinha central saindo do nariz
  detail(g, R * 0.8, 0, R * 1.35, 0);
  // dentes da broca
  for (let i = 0; i < 3; i++) {
    const bx = R * (0.9 + i * 0.14);
    const th = R * (0.14 - i * 0.035);
    detail(g, bx, -th, bx, th, 0.7);
  }

  // painel interno (compartimento de carga)
  detail(g, -R * 0.45, -R * 0.3, -R * 0.45, R * 0.3, 0.5);
  detail(g, -R * 0.05, -R * 0.35, -R * 0.05, R * 0.35, 0.5);
}

// ── Attack ────────────────────────────────────────────────────────────

/**
 * Nave de ataque: silhueta de asas em contorno, espinha central
 * (como a nave clássica do Asteroids) e canhões laterais.
 */
export function drawAttackShip(g: Phaser.GameObjects.Graphics): void {
  wire(g, shipVerts("attack"));

  // espinha central do nariz à cauda
  detail(g, R * 1.15, 0, -R * 0.45, 0, 0.6);

  // canhões laterais: dois traços paralelos à frente
  detail(g, R * 0.2, -R * 0.3, R * 0.85, -R * 0.3, 0.75);
  detail(g, R * 0.2, R * 0.3, R * 0.85, R * 0.3, 0.75);
}

// ── Transport ─────────────────────────────────────────────────────────

/**
 * Transporte: contêiner longo em contorno com divisórias de carga
 * e traço de cabine na frente.
 */
export function drawTransportShip(g: Phaser.GameObjects.Graphics): void {
  wire(g, shipVerts("transport"));

  // divisórias dos compartimentos de carga
  detail(g, R * 0.35, -R * 0.6, R * 0.35, R * 0.6, 0.6);
  detail(g, -R * 0.2, -R * 0.6, -R * 0.2, R * 0.6, 0.6);
  detail(g, -R * 0.6, -R * 0.6, -R * 0.6, R * 0.6, 0.6);

  // cabine: chevron frontal
  detail(g, R * 0.5, -R * 0.24, R * 0.85, 0);
  detail(g, R * 0.5, R * 0.24, R * 0.85, 0);
}
