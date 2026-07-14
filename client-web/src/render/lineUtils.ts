/**
 * lineUtils — helpers para construir UMA malha GreasedLine a partir de várias
 * polilinhas coloridas ("bundle"). Cor por PONTO (useColors) permite juntar
 * contorno brilhante + detalhes apagados num único draw call por entidade —
 * importante para os ~90–160 asteroides do grid 3×3.
 *
 * Pontos em coordenadas do JOGO (Y para baixo); a conversão para cena
 * acontece aqui na borda, via coords.ts.
 */

import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { CreateGreasedLine } from "@babylonjs/core/Meshes/Builders/greasedLineBuilder";
import type { GreasedLineBaseMesh } from "@babylonjs/core/Meshes/GreasedLine/greasedLineBaseMesh";
import { toScene } from "./coords";

export type Pt = { x: number; y: number };

/** Uma polilinha do bundle, com cor própria. */
export interface LinePart {
  pts: Pt[];
  /** fecha o loop repetindo o primeiro ponto */
  closed?: boolean;
  /** cor hex (0xrrggbb) */
  color: number;
  /** atenuação da cor (substitui o alpha dos traços do Phaser) */
  dim?: number;
}

export interface BundleOptions {
  /** largura base da linha */
  baseWidth: number;
  /** true: largura em px de tela; false: unidades de mundo */
  sizeAttenuation: boolean;
  /** registra a malha no glow (halo neon) */
  glow?: GlowLayer;
}

export const c3 = (hex: number) =>
  new Color3(((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255);

/** Aproximação poligonal de um círculo (coordenadas do jogo). */
export function circlePts(cx: number, cy: number, r: number, segments = 20): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}

/** Retângulo (contorno) em coordenadas do jogo. */
export function rectPts(x: number, y: number, w: number, h: number): Pt[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

/** Constrói uma malha única com todas as polilinhas do bundle. */
export function createLineBundle(
  name: string,
  scene: Scene,
  parts: LinePart[],
  opts: BundleOptions,
): GreasedLineBaseMesh {
  const points: Vector3[][] = [];
  const colors: Color3[] = [];
  for (const part of parts) {
    const loop = part.closed ? [...part.pts, part.pts[0]] : part.pts;
    points.push(loop.map((p) => toScene(p.x, p.y)));
    const color = part.dim !== undefined ? c3(part.color).scale(part.dim) : c3(part.color);
    for (let i = 0; i < loop.length; i++) colors.push(color);
  }

  const mesh = CreateGreasedLine(
    name,
    { points },
    {
      width: opts.baseWidth,
      sizeAttenuation: opts.sizeAttenuation,
      useColors: true,
      colors,
    },
    scene,
  ) as GreasedLineBaseMesh;
  opts.glow?.referenceMeshToUseItsOwnMaterial(mesh);
  return mesh;
}

/** Dispose disciplinado: tira do glow e libera malha + material + textura de cores. */
export function disposeLineBundle(mesh: GreasedLineBaseMesh, glow?: GlowLayer): void {
  glow?.unReferenceMeshFromUsingItsOwnMaterial(mesh);
  mesh.dispose(false, true);
}
