/**
 * StructureRenderer — estruturas como ARQUITETURA 3D (StructureMeshGenerator)
 * assentada na plataforma de construção do asteroide hospedeiro: o nó raiz é
 * PARENTADO ao root do asteroide (AsteroidRenderer.getBuildFace) e orientado
 * pelo quadro da plataforma — posição, inclinação e spin vêm de graça da
 * hierarquia do Babylon; este renderer não faz transform por frame.
 *
 * Por estrutura: sólido facetado (material compartilhado) + aberturas pretas
 * (material sem luz) + wireframe branco de painéis (sem glow) + linhas de
 * destaque com glow na cor do dono (aberturas, antenas). As VAGAS de hangar
 * viram placas 3D finas enfileiradas à frente (−Y local): número em dígitos
 * de 7 segmentos, cantoneiras amarelas nas expandidas e silhueta da nave
 * guardada quando ocupada — reconstruídas só quando a ocupação muda.
 *
 * A altura do prédio é comprimida (scaling.z) quando a plataforma fica perto
 * do plano de jogo: prédios nunca cruzam z=0, então naves/efeitos continuam
 * desenhados por cima sem mudança de layer.
 */

import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { CreateGreasedLine } from "@babylonjs/core/Meshes/Builders/greasedLineBuilder";
import type { GreasedLineBaseMesh } from "@babylonjs/core/Meshes/GreasedLine/greasedLineBaseMesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3, Quaternion, Matrix } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { SHIP_RADIUS, STRUCTURE_SPECS } from "@ceres/shared";
import type { StructureType, ShipKind } from "@ceres/shared";
import { shipVerts } from "../shapes";
import { Palette } from "./Palette";
import { SHIP_LAYER_Z } from "./layers";
import { c3, disposeLineBundle } from "./lineUtils";
import { generateStructureMesh } from "./StructureMeshGenerator";
import type { AsteroidBuildFace } from "./AsteroidMeshGenerator";

/** Dados mínimos de uma estrutura (posição/spin vêm do parent do asteroide). */
export interface StructureRenderData {
  id: string;
  stype: StructureType;
  own: boolean;
  shipBays: number;
  expandedBays: number;
}

/** Plataforma hospedeira: root do asteroide + quadro da face. */
export interface StructureAttach {
  root: TransformNode;
  face: AsteroidBuildFace;
}

const WIRE_PX = 1.1;
const WIRE_DIM = 0.45;
const ACCENT_PX = 1.8;
const BAY_PX = 1.3;

/** placas de vaga: espessura e folga da linha sobre a placa */
const SLAB_H = 3;
const SLAB_LINE_LIFT = 1;
/** cantoneiras das vagas expandidas (âmbar, como no protótipo) */
const EXPANDED_COLOR = 0xffcc44;
/** compressão mínima de altura em plataformas rasas */
const MIN_SQUASH = 0.4;

interface StructEntry {
  root: TransformNode;
  meshes: Mesh[];
  lines: GreasedLineBaseMesh[];
  bayNode: TransformNode | null;
  bayMeshes: Mesh[];
  bayLines: GreasedLineBaseMesh[];
  attachedTo: TransformNode | null;
  lastSig: string;
  own: boolean;
  type: StructureType;
  radius: number;
  height: number;
  shipBays: number;
  expandedBays: number;
}

export class StructureRenderer {
  private scene: Scene;
  private glow: GlowLayer;
  private entries = new Map<string, StructEntry>();
  private structMat: StandardMaterial;
  private voidMat: StandardMaterial;

  constructor(scene: Scene, glow: GlowLayer) {
    this.scene = scene;
    this.glow = glow;

    // corpo dos prédios: um tom acima da rocha, iluminado pela mesma
    // HemisphericLight criada pelo AsteroidRenderer
    this.structMat = new StandardMaterial("structBody", scene);
    this.structMat.diffuseColor = c3(Palette.structure.fill);
    this.structMat.specularColor = Color3.Black();
    this.structMat.backFaceCulling = false;

    // aberturas (hangar/porta): preto absoluto, imune à luz
    this.voidMat = new StandardMaterial("structVoid", scene);
    this.voidMat.disableLighting = true;
    this.voidMat.emissiveColor = Color3.Black();
    this.voidMat.backFaceCulling = false;
  }

  /** Cria/atualiza a estrutura e a assenta na plataforma do asteroide. */
  upsert(data: StructureRenderData, occupants: ShipKind[], attach: StructureAttach | null): void {
    let entry = this.entries.get(data.id);
    if (!entry) {
      entry = this.createEntry(data);
      this.entries.set(data.id, entry);
    }

    if (!attach) {
      // asteroide fora do grid 3×3 atual — nada para assentar (e nada
      // visível); solta o parent para não referenciar um root descartado
      entry.root.setEnabled(false);
      if (entry.attachedTo) {
        entry.root.parent = null;
        entry.attachedTo = null;
      }
    } else {
      if (entry.attachedTo !== attach.root) {
        entry.attachedTo = attach.root;
        entry.root.parent = attach.root;
        this.placeOnFace(entry, attach);
      }
      entry.root.setEnabled(true);
    }

    const sig = occupants.join(",");
    if (sig !== entry.lastSig) {
      entry.lastSig = sig;
      this.rebuildBays(entry, occupants);
    }
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.disposeEntry(entry);
    this.entries.delete(id);
  }

  destroy(): void {
    for (const entry of this.entries.values()) this.disposeEntry(entry);
    this.entries.clear();
    this.structMat.dispose();
    this.voidMat.dispose();
  }

  // ── criação ──────────────────────────────────────────────────────────

  private createEntry(data: StructureRenderData): StructEntry {
    const gen = generateStructureMesh(data.stype);
    const accentColor = c3(data.own ? Palette.structure.own : Palette.structure.other);
    const root = new TransformNode(`struct_${data.id}`, this.scene);

    const meshes: Mesh[] = [];
    const solid = this.makeSolid(`struct_${data.id}_body`, gen.vertices, gen.normals, gen.triangles, this.structMat);
    solid.parent = root;
    meshes.push(solid);

    if (gen.voidTriangles.length > 0) {
      // normais irrelevantes (material sem luz) — preenche com +Z
      const voidNormals = gen.voidVertices.map(() => new Vector3(0, 0, 1));
      const voids = this.makeSolid(`struct_${data.id}_voids`, gen.voidVertices, voidNormals, gen.voidTriangles, this.voidMat);
      voids.parent = root;
      meshes.push(voids);
    }

    const lines: GreasedLineBaseMesh[] = [];
    const wire = this.makeLine(`struct_${data.id}_wire`, gen.wires, WIRE_PX, c3(Palette.wire).scale(WIRE_DIM), false);
    wire.parent = root;
    lines.push(wire);

    const accents = this.makeLine(`struct_${data.id}_accents`, gen.accents, ACCENT_PX, accentColor, true);
    accents.parent = root;
    lines.push(accents);

    return {
      root, meshes, lines,
      bayNode: null, bayMeshes: [], bayLines: [],
      attachedTo: null, lastSig: "\0",
      own: data.own, type: data.stype,
      radius: STRUCTURE_SPECS[data.stype].radius,
      height: gen.height,
      shipBays: data.shipBays, expandedBays: data.expandedBays,
    };
  }

  /** Posição/orientação/altura a partir do quadro da plataforma. */
  private placeOnFace(entry: StructEntry, attach: StructureAttach): void {
    const face = attach.face;
    const t = face.tangent;
    const b = face.bitangent;
    const n = face.normal;
    entry.root.position = face.center.add(n.scale(0.5));
    // base ortonormal {t, b, n} com det +1 (b = n×t) → rotação própria
    const m = Matrix.FromValues(
      t.x, t.y, t.z, 0,
      b.x, b.y, b.z, 0,
      n.x, n.y, n.z, 0,
      0, 0, 0, 1,
    );
    entry.root.rotationQuaternion = Quaternion.FromRotationMatrix(m);
    // headroom: em pose plana (rocha travada — sempre o caso com estrutura),
    // o topo do prédio não pode cruzar a camada de voo. A malha do asteroide
    // é centrada e o root dele é recuado, então a altura de mundo da face é
    // rootZ + center.z
    const worldFaceZ = attach.root.position.z + face.center.z;
    const headroom = worldFaceZ - (SHIP_LAYER_Z + 20);
    const squash = Math.min(1, Math.max(MIN_SQUASH, headroom / entry.height));
    entry.root.scaling.z = squash;
  }

  // ── vagas de hangar (placas 3D, reconstruídas quando a ocupação muda) ──

  private rebuildBays(entry: StructEntry, occupants: ShipKind[]): void {
    for (const m of entry.bayLines) disposeLineBundle(m, this.glow);
    for (const m of entry.bayMeshes) m.dispose(false, false);
    entry.bayLines = [];
    entry.bayMeshes = [];
    entry.bayNode?.dispose();
    entry.bayNode = null;

    const cap = entry.shipBays;
    if (cap <= 0) return;

    const bayNode = new TransformNode(`${entry.root.name}_bays`, this.scene);
    bayNode.parent = entry.root;
    entry.bayNode = bayNode;

    const R = entry.radius;
    const expandedBays = entry.expandedBays;
    const slotN = SHIP_RADIUS * 2.0;
    const slotEW = SHIP_RADIUS * 3.2;
    const slotEH = SHIP_RADIUS * 2.4;
    const gap = SHIP_RADIUS * 0.5;
    // fileira à FRENTE do prédio (−Y local, o lado das aberturas)
    const y0 = -(R + slotEH * 0.6);

    let totalW = 0;
    for (let i = 0; i < cap; i++) {
      totalW += (i < expandedBays ? slotEW : slotN) + (i > 0 ? gap : 0);
    }
    let curX = -totalW / 2;

    const slabVerts: Vector3[] = [];
    const slabNormals: Vector3[] = [];
    const slabTris: number[] = [];
    const lineParts: Array<{ pts: Vector3[]; color: Color3 }> = [];
    const outlineColor = c3(Palette.structure.hangar);
    const bracketColor = c3(EXPANDED_COLOR);
    const shipColor = c3(entry.own ? Palette.structure.fleet : 0x8899aa);
    const zTop = SLAB_H + SLAB_LINE_LIFT;

    for (let i = 0; i < cap; i++) {
      const isExp = i < expandedBays;
      const sw = isExp ? slotEW : slotN;
      const sh = isExp ? slotEH : slotN;
      const cx = curX + sw / 2;

      this.pushSlab(slabVerts, slabNormals, slabTris, cx, y0, sw, sh);
      lineParts.push({ pts: rectLoop(cx, y0, sw * 0.92, sh * 0.86, zTop), color: outlineColor });

      // número da vaga no canto superior esquerdo da placa
      const digitH = sh * 0.28;
      lineParts.push(...digitLines(i + 1, cx - sw * 0.4, y0 + sh * 0.12, digitH, zTop)
        .map((pts) => ({ pts, color: outlineColor })));

      if (isExp) {
        // cantoneiras âmbar (vaga expandida, como no protótipo)
        for (const pts of cornerBrackets(cx, y0, sw * 0.92, sh * 0.86, zTop)) {
          lineParts.push({ pts, color: bracketColor });
        }
      }

      const kind = occupants[i];
      if (kind) {
        const scale = isExp ? 0.9 : 0.7;
        // shapeVerts em coordenadas do jogo (y para baixo) → y local negado
        const mini = shipVerts(kind).map((v) => new Vector3(cx + v.x * scale, y0 - v.y * scale, zTop));
        lineParts.push({ pts: [...mini, mini[0]], color: shipColor });
      }

      curX += sw + gap;
    }

    const slabs = this.makeSolid(`${entry.root.name}_slabs`, slabVerts, slabNormals, slabTris, this.structMat);
    slabs.parent = bayNode;
    entry.bayMeshes.push(slabs);

    const bundle = this.makeBundle(`${entry.root.name}_baylines`, lineParts, BAY_PX);
    bundle.parent = bayNode;
    entry.bayLines.push(bundle);
  }

  /** Placa fina: tampo + saias laterais. */
  private pushSlab(
    verts: Vector3[], normals: Vector3[], tris: number[],
    cx: number, cy: number, w: number, h: number,
  ): void {
    const x0 = cx - w / 2, x1 = cx + w / 2;
    const y0 = cy - h / 2, y1 = cy + h / 2;
    const quad = (p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, n: Vector3) => {
      const base = verts.length;
      verts.push(p0, p1, p2, p3);
      for (let k = 0; k < 4; k++) normals.push(n.clone());
      tris.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
    quad(v(x0, y0, SLAB_H), v(x1, y0, SLAB_H), v(x1, y1, SLAB_H), v(x0, y1, SLAB_H), v(0, 0, 1));
    quad(v(x0, y0, 0), v(x1, y0, 0), v(x1, y0, SLAB_H), v(x0, y0, SLAB_H), v(0, -1, 0));
    quad(v(x1, y0, 0), v(x1, y1, 0), v(x1, y1, SLAB_H), v(x1, y0, SLAB_H), v(1, 0, 0));
    quad(v(x1, y1, 0), v(x0, y1, 0), v(x0, y1, SLAB_H), v(x1, y1, SLAB_H), v(0, 1, 0));
    quad(v(x0, y1, 0), v(x0, y0, 0), v(x0, y0, SLAB_H), v(x0, y1, SLAB_H), v(-1, 0, 0));
  }

  // ── infraestrutura de malha ──────────────────────────────────────────

  private makeSolid(
    name: string,
    vertices: Vector3[], normals: Vector3[], triangles: number[],
    mat: StandardMaterial,
  ): Mesh {
    const mesh = new Mesh(name, this.scene);
    const vd = new VertexData();
    vd.positions = flatten3(vertices);
    vd.normals = flatten3(normals);
    vd.indices = triangles;
    vd.applyToMesh(mesh);
    mesh.material = mat;
    mesh.isPickable = false;
    return mesh;
  }

  private makeLine(name: string, points: Vector3[][], widthPx: number, color: Color3, glow: boolean): GreasedLineBaseMesh {
    const mesh = CreateGreasedLine(
      name,
      { points },
      { width: widthPx, sizeAttenuation: true, color },
      this.scene,
    ) as GreasedLineBaseMesh;
    if (glow) this.glow.referenceMeshToUseItsOwnMaterial(mesh);
    return mesh;
  }

  /** Várias polilinhas coloridas numa única malha (cor por ponto). */
  private makeBundle(name: string, parts: Array<{ pts: Vector3[]; color: Color3 }>, widthPx: number): GreasedLineBaseMesh {
    const points: Vector3[][] = [];
    const colors: Color3[] = [];
    for (const part of parts) {
      points.push(part.pts);
      for (let i = 0; i < part.pts.length; i++) colors.push(part.color);
    }
    const mesh = CreateGreasedLine(
      name,
      { points },
      { width: widthPx, sizeAttenuation: true, useColors: true, colors },
      this.scene,
    ) as GreasedLineBaseMesh;
    this.glow.referenceMeshToUseItsOwnMaterial(mesh);
    return mesh;
  }

  private disposeEntry(entry: StructEntry): void {
    for (const m of entry.lines) disposeLineBundle(m, this.glow);
    for (const m of entry.bayLines) disposeLineBundle(m, this.glow);
    for (const m of entry.meshes) m.dispose(false, false); // materiais compartilhados
    for (const m of entry.bayMeshes) m.dispose(false, false);
    entry.bayNode?.dispose();
    entry.root.dispose();
  }
}

// ── helpers geométricos das vagas ──────────────────────────────────────────

const flatten3 = (vs: Vector3[]): number[] => {
  const out = new Array<number>(vs.length * 3);
  for (let i = 0; i < vs.length; i++) {
    out[i * 3] = vs[i].x;
    out[i * 3 + 1] = vs[i].y;
    out[i * 3 + 2] = vs[i].z;
  }
  return out;
};

function rectLoop(cx: number, cy: number, w: number, h: number, z: number): Vector3[] {
  const x0 = cx - w / 2, x1 = cx + w / 2;
  const y0 = cy - h / 2, y1 = cy + h / 2;
  return [
    new Vector3(x0, y0, z), new Vector3(x1, y0, z), new Vector3(x1, y1, z),
    new Vector3(x0, y1, z), new Vector3(x0, y0, z),
  ];
}

/** Quatro cantoneiras em "L" nos cantos de um retângulo. */
function cornerBrackets(cx: number, cy: number, w: number, h: number, z: number): Vector3[][] {
  const arm = Math.min(w, h) * 0.22;
  const out: Vector3[][] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const px = cx + (sx * w) / 2;
      const py = cy + (sy * h) / 2;
      out.push([
        new Vector3(px - sx * arm, py, z),
        new Vector3(px, py, z),
        new Vector3(px, py - sy * arm, z),
      ]);
    }
  }
  return out;
}

/** segmentos ligados de um dígito de 7 segmentos (A..G) */
const SEG_MAP: Record<number, string> = {
  0: "ABCDEF", 1: "BC", 2: "ABGED", 3: "ABGCD", 4: "FGBC",
  5: "AFGCD", 6: "AFGEDC", 7: "ABC", 8: "ABCDEFG", 9: "ABCDFG",
};

/**
 * Número (1–2 dígitos) como linhas de 7 segmentos, canto inferior-esquerdo
 * em (x, y), altura `h`, no plano z.
 */
function digitLines(value: number, x: number, y: number, h: number, z: number): Vector3[][] {
  const w = h * 0.55;
  const gap = w * 0.35;
  const digits = value.toString().split("").map(Number);
  const out: Vector3[][] = [];
  let dx = x;
  for (const d of digits) {
    const segs = SEG_MAP[d];
    const p = (px: number, py: number) => new Vector3(dx + px * w, y + py * h, z);
    const segPts: Record<string, [Vector3, Vector3]> = {
      A: [p(0, 1), p(1, 1)],
      B: [p(1, 1), p(1, 0.5)],
      C: [p(1, 0.5), p(1, 0)],
      D: [p(0, 0), p(1, 0)],
      E: [p(0, 0.5), p(0, 0)],
      F: [p(0, 1), p(0, 0.5)],
      G: [p(0, 0.5), p(1, 0.5)],
    };
    for (const s of segs) out.push(segPts[s]);
    dx += w + gap;
  }
  return out;
}
