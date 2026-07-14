/**
 * Protótipo de validação — marco 1 da migração para Babylon.js
 * (docs/BABYLON-MIGRATION.md). Valida as três coisas que mais custam se
 * descobertas erradas depois:
 *
 *   1. Y-flip via coords.ts — eixos do jogo desenhados na cena: +Y do jogo
 *      deve apontar para BAIXO na tela e o triângulo girar em sentido HORÁRIO
 *      (mesmo comportamento do Phaser).
 *   2. Câmera ortográfica com zoom por scroll — bounds recalculados por frame,
 *      unproject do ponteiro por aritmética linear (sem scene.pick).
 *   3. GreasedLine + GlowLayer — wireframe neon com halo real; tecla T alterna
 *      entre sizeAttenuation (largura em px de tela) e o fallback de largura
 *      em unidades de mundo compensada por 1/zoom (pegadinha conhecida do plano).
 *
 * Página própria (proto.html) — o jogo Phaser em index.html segue intacto.
 */
import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { CreateGreasedLine } from "@babylonjs/core/Meshes/Builders/greasedLineBuilder";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import type { GreasedLineBaseMesh } from "@babylonjs/core/Meshes/GreasedLine/greasedLineBaseMesh";

import { SHIP_VERTS } from "../shapes";
import { Palette } from "../render/Palette";
import { toScene, toSceneAngle, toGame } from "../render/coords";

// ── zoom (mesmas constantes do GameScene) ──
const ZOOM_MIN = 0.08;
const ZOOM_MAX = 3;
const ZOOM_WHEEL_STEP = 1.15;
const ZOOM_SMOOTH = 0.15;
const INITIAL_ZOOM = 1;

/** escala do triângulo sobre SHIP_VERTS (R=20) — só apresentação do protótipo */
const SHIP_SCALE = 5;
/** velocidade angular do triângulo, rad/s, no espaço do jogo (horário na tela) */
const SPIN_SPEED = 0.6;
const AXIS_LEN = 260;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const c3 = (hex: number) =>
  new Color3(((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255);

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
// preserveDrawingBuffer: permite capturar o canvas (toDataURL) para depuração
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
// sincroniza o drawing buffer com o tamanho CSS do canvas (o construtor não faz)
engine.resize();
const scene = new Scene(engine);
scene.clearColor = new Color4(0, 0, 0, 1);

// câmera ortográfica: posição segue a nave (aqui fixa na origem), enquadramento
// vem dos bounds recalculados por frame a partir do canvas e do zoom
const camera = new FreeCamera("cam", new Vector3(0, 0, -1000), scene);
camera.setTarget(Vector3.Zero());
camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
camera.minZ = 0.1;
camera.maxZ = 2000;

const glow = new GlowLayer("glow", scene);
glow.intensity = 1.4;

// ── linhas ──

interface ProtoLine {
  mesh: GreasedLineBaseMesh;
  /** largura de referência em px de tela (modo sizeAttenuation) */
  basePx: number;
}
const lines: ProtoLine[] = [];

function makeLine(name: string, gamePts: Array<{ x: number; y: number }>, colorHex: number, basePx: number): GreasedLineBaseMesh {
  const mesh = CreateGreasedLine(
    name,
    { points: gamePts.map((p) => toScene(p.x, p.y)) },
    { color: c3(colorHex), width: basePx, sizeAttenuation: true },
    scene,
  ) as GreasedLineBaseMesh;
  // padrão documentado para GreasedLine brilhar: o glow renderiza o mesh com o
  // próprio material em vez de depender de emissive do material base
  glow.referenceMeshToUseItsOwnMaterial(mesh);
  lines.push({ mesh, basePx });
  return mesh;
}

// triângulo da nave (scout), loop fechado, girando no sentido do jogo
const shipPts = [...SHIP_VERTS, SHIP_VERTS[0]].map((p) => ({
  x: p.x * SHIP_SCALE,
  y: p.y * SHIP_SCALE,
}));
const ship = makeLine("ship", shipPts, Palette.structure.own, 4);

// eixos do jogo: +X (dourado, direita) e +Y (vermelho, deve apontar para BAIXO)
makeLine("axisX", [{ x: 0, y: 0 }, { x: AXIS_LEN, y: 0 }], Palette.ceres.body, 3);
makeLine("axisXHead", [
  { x: AXIS_LEN - 26, y: -13 },
  { x: AXIS_LEN, y: 0 },
  { x: AXIS_LEN - 26, y: 13 },
], Palette.ceres.body, 3);
makeLine("axisY", [{ x: 0, y: 0 }, { x: 0, y: AXIS_LEN }], Palette.fx.boundary, 3);
makeLine("axisYHead", [
  { x: -13, y: AXIS_LEN - 26 },
  { x: 0, y: AXIS_LEN },
  { x: 13, y: AXIS_LEN - 26 },
], Palette.fx.boundary, 3);

// ── zoom / câmera ──

let zoom = INITIAL_ZOOM;
let zoomTarget = INITIAL_ZOOM;

canvas.addEventListener(
  "wheel",
  (ev) => {
    ev.preventDefault();
    const factor = ev.deltaY > 0 ? 1 / ZOOM_WHEEL_STEP : ZOOM_WHEEL_STEP;
    zoomTarget = clamp(zoomTarget * factor, ZOOM_MIN, ZOOM_MAX);
  },
  { passive: false },
);

function updateOrtho(): void {
  const halfW = engine.getRenderWidth() / (2 * zoom);
  const halfH = engine.getRenderHeight() / (2 * zoom);
  camera.orthoLeft = -halfW;
  camera.orthoRight = halfW;
  camera.orthoTop = halfH;
  camera.orthoBottom = -halfH;
}

/** unproject do ponteiro: aritmética linear com os bounds ortho, sem scene.pick */
function screenToGame(px: number, py: number): { x: number; y: number } {
  const sceneX = camera.position.x + (px - engine.getRenderWidth() / 2) / zoom;
  const sceneY = camera.position.y - (py - engine.getRenderHeight() / 2) / zoom;
  return toGame(sceneX, sceneY);
}

// ── largura de linha: sizeAttenuation × fallback 1/zoom (tecla T) ──

let sizeAttenuationMode = true;

function applyWidthMode(): void {
  for (const l of lines) {
    const glm = l.mesh.greasedLineMaterial;
    if (!glm) continue;
    glm.sizeAttenuation = sizeAttenuationMode;
    glm.width = sizeAttenuationMode ? l.basePx : clamp(l.basePx / zoom, 0.5, 80);
  }
}

window.addEventListener("keydown", (ev) => {
  if (ev.key.toLowerCase() === "t") {
    sizeAttenuationMode = !sizeAttenuationMode;
    applyWidthMode();
  }
});

// ── HUD de diagnóstico (overlay DOM, mesmo caminho do futuro HudRenderer) ──

const hud = document.createElement("div");
hud.style.cssText =
  "position:fixed;top:10px;left:10px;color:#d8e8f8;font:12px/1.6 monospace;" +
  "white-space:pre;pointer-events:none;text-shadow:0 0 4px #000;z-index:10";
document.body.appendChild(hud);

let pointerX = 0;
let pointerY = 0;
canvas.addEventListener("pointermove", (ev) => {
  pointerX = ev.clientX;
  pointerY = ev.clientY;
});

function updateHud(): void {
  const p = screenToGame(pointerX, pointerY);
  hud.textContent =
    `BABYLON PROTO — marco 1 (boot + ortho + coords + GreasedLine + glow)\n` +
    `zoom ${zoom.toFixed(2)} (alvo ${zoomTarget.toFixed(2)})  fps ${engine.getFps().toFixed(0)}\n` +
    `ponteiro no jogo: (${p.x.toFixed(0)}, ${p.y.toFixed(0)})\n` +
    `largura [T]: ${sizeAttenuationMode ? "sizeAttenuation (px de tela)" : "mundo ÷ zoom (fallback do plano)"}\n` +
    `esperado: eixo VERMELHO (+Y jogo) p/ BAIXO; triângulo girando HORÁRIO;\n` +
    `          halo neon nas linhas; scroll = zoom, largura estável em px`;
}

// ── loop ──

let gameAngle = 0;
let last = performance.now();

function tick(): void {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  zoom += (zoomTarget - zoom) * ZOOM_SMOOTH;
  updateOrtho();

  // ângulo cresce no espaço do jogo (Y-down = horário na tela); a negação
  // fica toda em toSceneAngle — se girar anti-horário, o flip está errado
  gameAngle += SPIN_SPEED * dt;
  ship.rotation.z = toSceneAngle(gameAngle);

  if (!sizeAttenuationMode) applyWidthMode();

  updateHud();
  scene.render();
}

engine.runRenderLoop(tick);

window.addEventListener("resize", () => engine.resize());

// handle de debug no lugar do jogo Phaser (ver plano: window.__game);
// tick exposto permite renderizar sob demanda quando rAF não dispara (página oculta)
(window as unknown as { __game: { engine: Engine; scene: Scene; tick: () => void } }).__game = {
  engine,
  scene,
  tick,
};
