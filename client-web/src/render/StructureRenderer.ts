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
 * ONDE fica cada vaga não é decisão do render: vem de shared/bays.ts, a mesma
 * conta com que o servidor pousa a nave na vaga. O prédio assenta sobre o
 * centro do asteroide, virado para `angle` da estrutura, e cada placa vai para
 * o ponto da plataforma cuja projeção no plano do jogo é o centro exato da
 * vaga (o asteroide com estrutura não gira no plano — ver AsteroidRenderer).
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
import { STRUCTURE_SPECS, CERES_STATION_ANNEXES_PER_LEVEL, bayLayout, bayFrameAngle } from "@ceres/shared";
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
  /** direção da frente da estrutura (rad, do jogo) — orienta prédio e vagas */
  angle: number;
  /** nível (estação de Ceres): cada nível acima do 1 acrescenta anexos */
  level?: number;
  /** raio da área em que os anexos se espalham (a plataforma de Ceres); 0 = sem anexos */
  annexArea?: number;
}

/** Plataforma hospedeira: root do asteroide + quadro da face. */
export interface StructureAttach {
  root: TransformNode;
  face: AsteroidBuildFace;
  /**
   * XY (cena, no quadro do root) do CENTRO da estrutura. Ausente = a origem do
   * root: no asteroide a estrutura fica no centro dele; numa plataforma de
   * Ceres, no centro da plataforma, longe do centro do planeta.
   */
  anchor?: { x: number; y: number };
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
/** anexos da estação evoluída: formas que se alternam, escala e altura dos dutos */
const ANNEX_TYPES: StructureType[] = ["hq", "rationCenter", "miningStation", "initialBase"];
/**
 * Escala dos anexos: LARGA no plano (a plataforma tem ~2000 u de raio e o
 * prédio, ~100 — em 0.75 eles liam como pontos e só os dutos apareciam) e
 * com a altura original, para não crescerem em direção à camada das naves.
 */
const ANNEX_SCALE = 1.8;
const ANNEX_Z_SCALE = 1;
const CONDUIT_Z = 2;

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
  angle: number;
  /** quadro da plataforma em que o prédio assentou (para achar as vagas nela) */
  face: AsteroidBuildFace | null;
  /** centro da estrutura no quadro do root hospedeiro (ver StructureAttach.anchor) */
  anchor: { x: number; y: number };
  /** anexos da estação evoluída (ver rebuildAnnexes) e o nível em que foram montados */
  annexNode: TransformNode | null;
  annexMeshes: Mesh[];
  annexLines: GreasedLineBaseMesh[];
  annexLevel: number;
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
  upsert(data: StructureRenderData, occupants: ReadonlyArray<ShipKind | null>, attach: StructureAttach | null): void {
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
        entry.lastSig = "!"; // as vagas dependem da plataforma: refaz
      }
      entry.root.setEnabled(true);
    }

    const level = data.level ?? 1;
    if (level !== entry.annexLevel) {
      entry.annexLevel = level;
      this.rebuildAnnexes(entry, level, data.annexArea ?? 0);
    }

    const sig = occupants.map((k) => k ?? "").join(",");
    if (sig !== entry.lastSig) {
      entry.lastSig = sig;
      this.rebuildBays(entry, occupants);
    }
  }

  /**
   * Altura de cena (z de mundo) da BASE do prédio — o chão da plataforma onde
   * as vagas ficam. null se a estrutura não está assentada (fora do grid).
   */
  platformZ(id: string): number | null {
    const entry = this.entries.get(id);
    if (!entry || !entry.attachedTo) return null;
    return entry.root.getAbsolutePosition().z;
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
      angle: data.angle, face: null, anchor: { x: 0, y: 0 },
      annexNode: null, annexMeshes: [], annexLines: [], annexLevel: 1,
    };
  }

  /**
   * Assenta o prédio na plataforma: sobre o CENTRO do asteroide — o ponto do
   * plano da plataforma cuja projeção no plano do jogo é a origem da rocha,
   * onde o servidor põe a estrutura — e virado para a frente dela. A base
   * {t, b, n} tem n = normal da plataforma e t = o eixo +x do quadro das vagas
   * (shared/bays.ts) projetado nela, então a fileira de vagas cai à frente do
   * prédio, do lado das aberturas (−Y local).
   */
  private placeOnFace(entry: StructEntry, attach: StructureAttach): void {
    const face = attach.face;
    const n = face.normal;
    const phi = bayFrameAngle(entry.angle);
    // eixo +x do quadro das vagas, do jogo para a cena (y negado)
    const dir = new Vector3(Math.cos(phi), -Math.sin(phi), 0);
    const t = dir.subtract(n.scale(Vector3.Dot(dir, n))).normalize();
    // base ortonormal {t, b, n} com det +1 (b = n×t) → rotação própria
    const b = Vector3.Cross(n, t).normalize();
    // ponto do plano da plataforma sobre o centro da estrutura (âncora)
    const a = attach.anchor ?? { x: 0, y: 0 };
    const origin = new Vector3(a.x, a.y, (Vector3.Dot(face.center, n) - n.x * a.x - n.y * a.y) / n.z);
    entry.face = face;
    entry.anchor = a;
    entry.root.position = origin.add(n.scale(0.5));
    const m = Matrix.FromValues(
      t.x, t.y, t.z, 0,
      b.x, b.y, b.z, 0,
      n.x, n.y, n.z, 0,
      0, 0, 0, 1,
    );
    entry.root.rotationQuaternion = Quaternion.FromRotationMatrix(m);
    // headroom: em pose plana (rocha travada — sempre o caso com estrutura),
    // o topo do prédio não pode cruzar a camada de voo. A malha do asteroide
    // é centrada e o root dele é recuado, então a altura de mundo da base do
    // prédio é rootZ + origin.z
    const worldFaceZ = attach.root.position.z + origin.z;
    const headroom = worldFaceZ - (SHIP_LAYER_Z + 20);
    const squash = Math.min(1, Math.max(MIN_SQUASH, headroom / entry.height));
    entry.root.scaling.z = squash;
  }

  /**
   * Centro de uma vaga no quadro LOCAL do prédio. O quadro local é a
   * plataforma, inclinada até MAX_TILT: pôr a placa em (x, y) do quadro das
   * vagas a deixaria até ~2% fora do lugar quando projetada no plano do jogo.
   * Resolve-se então o ponto (u, v) cuja projeção é o centro EXATO da vaga no
   * mundo — o ponto onde o servidor pousa a nave —, na altura `z` local em
   * que a placa é vista de cima (o contorno): na plataforma inclinada, até a
   * altura da placa desloca a projeção.
   */
  private bayCenterLocal(entry: StructEntry, lx: number, ly: number, z: number): { u: number; v: number } {
    const face = entry.face;
    const rot = entry.root.rotationQuaternion;
    if (!face || !rot) return { u: lx, v: ly };
    // alvo no plano do jogo, relativo ao centro da rocha, em coordenadas de cena
    const phi = bayFrameAngle(entry.angle);
    const gx = Math.cos(phi) * lx - Math.sin(phi) * ly;
    const gy = Math.sin(phi) * lx + Math.cos(phi) * ly;
    // eixos locais do prédio, na cena da rocha (o z local vem achatado)
    const m = new Matrix();
    rot.toRotationMatrix(m);
    const ax = Vector3.TransformNormal(new Vector3(1, 0, 0), m);
    const ay = Vector3.TransformNormal(new Vector3(0, 1, 0), m);
    const az = Vector3.TransformNormal(new Vector3(0, 0, z * entry.root.scaling.z), m);
    const tx = entry.anchor.x + gx - entry.root.position.x - az.x;
    const ty = entry.anchor.y - gy - entry.root.position.y - az.y;
    // [ax.xy ay.xy]·(u, v) = alvo — a plataforma inclina no máximo MAX_TILT,
    // então o determinante fica longe de zero
    const det = ax.x * ay.y - ay.x * ax.y;
    return { u: (tx * ay.y - ay.x * ty) / det, v: (ax.x * ty - tx * ax.y) / det };
  }

  // ── vagas de hangar (placas 3D, reconstruídas quando a ocupação muda) ──

  /** `occupants[i]`: classe da nave GUARDADA na vaga i (null = vaga sem nave guardada). */
  private rebuildBays(entry: StructEntry, occupants: ReadonlyArray<ShipKind | null>): void {
    for (const m of entry.bayLines) disposeLineBundle(m, this.glow);
    for (const m of entry.bayMeshes) m.dispose(false, false);
    entry.bayLines = [];
    entry.bayMeshes = [];
    entry.bayNode?.dispose();
    entry.bayNode = null;

    const slots = bayLayout({ type: entry.type, shipBays: entry.shipBays, expandedBays: entry.expandedBays });
    if (slots.length === 0) return;

    const bayNode = new TransformNode(`${entry.root.name}_bays`, this.scene);
    bayNode.parent = entry.root;
    entry.bayNode = bayNode;

    const slabVerts: Vector3[] = [];
    const slabNormals: Vector3[] = [];
    const slabTris: number[] = [];
    const lineParts: Array<{ pts: Vector3[]; color: Color3 }> = [];
    const outlineColor = c3(Palette.structure.hangar);
    const bracketColor = c3(EXPANDED_COLOR);
    const shipColor = c3(entry.own ? Palette.structure.fleet : 0x8899aa);
    const zTop = SLAB_H + SLAB_LINE_LIFT;

    slots.forEach((slot, i) => {
      const { u: cx, v: cy } = this.bayCenterLocal(entry, slot.x, slot.y, zTop);
      const sw = slot.w;
      const sh = slot.h;

      this.pushSlab(slabVerts, slabNormals, slabTris, cx, cy, sw, sh);
      lineParts.push({ pts: rectLoop(cx, cy, sw * 0.92, sh * 0.86, zTop), color: outlineColor });

      // número da vaga no canto superior esquerdo da placa
      const digitH = sh * 0.28;
      lineParts.push(...digitLines(i + 1, cx - sw * 0.4, cy + sh * 0.12, digitH, zTop)
        .map((pts) => ({ pts, color: outlineColor })));

      if (slot.expanded) {
        // cantoneiras âmbar (vaga expandida, como no protótipo)
        for (const pts of cornerBrackets(cx, cy, sw * 0.92, sh * 0.86, zTop)) {
          lineParts.push({ pts, color: bracketColor });
        }
      }

      const kind = occupants[i];
      if (kind) {
        const scale = slot.expanded ? 0.9 : 0.7;
        // shapeVerts em coordenadas do jogo (y para baixo) → y local negado
        const mini = shipVerts(kind).map((v) => new Vector3(cx + v.x * scale, cy - v.y * scale, zTop));
        lineParts.push({ pts: [...mini, mini[0]], color: shipColor });
      }
    });

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

  // ── anexos da estação evoluída (Ceres) ──────────────────────────────

  /**
   * A estação de Ceres OCUPA a plataforma conforme evolui: cada nível acima
   * do 1 acrescenta CERES_STATION_ANNEXES_PER_LEVEL prédios menores (formas
   * das outras estruturas, em escala), em anéis cada vez mais afastados,
   * sempre atrás e dos lados do prédio principal — a frente é das vagas —,
   * virados para ele e ligados a ele por dutos na cor do dono.
   *
   * Tudo num quadro só: os vértices de todos os anexos são transformados
   * para o quadro do prédio e viram UMA malha de corpo, uma de aberturas, uma
   * de arestas e uma de destaques — quatro chamadas de desenho por estação,
   * qualquer que seja o nível.
   */
  private rebuildAnnexes(entry: StructEntry, level: number, area: number): void {
    for (const m of entry.annexLines) disposeLineBundle(m, this.glow);
    for (const m of entry.annexMeshes) m.dispose(false, false);
    entry.annexLines = [];
    entry.annexMeshes = [];
    entry.annexNode?.dispose();
    entry.annexNode = null;
    const count = Math.max(0, level - 1) * CERES_STATION_ANNEXES_PER_LEVEL;
    if (count === 0 || area <= 0) return;

    const node = new TransformNode(`${entry.root.name}_annexes`, this.scene);
    node.parent = entry.root;
    entry.annexNode = node;

    const body = { v: [] as Vector3[], n: [] as Vector3[], t: [] as number[] };
    const voids = { v: [] as Vector3[], n: [] as Vector3[], t: [] as number[] };
    const wires: Vector3[][] = [];
    const accents: Vector3[][] = [];
    for (let k = 0; k < count; k++) {
      const ring = Math.floor(k / 2);
      const side = k % 2 === 0 ? -1 : 1;
      // ângulo a partir de +Y local (as COSTAS do prédio; a frente, −Y, é das vagas)
      const a = side * (0.7 + ring * 0.42);
      const d = area * (0.24 + 0.17 * ring);
      const cx = Math.sin(a) * d;
      const cy = Math.cos(a) * d;
      // virado para o prédio principal: a frente (−Y) do anexo aponta para a origem
      const yaw = Math.atan2(-cx, cy);
      const type = ANNEX_TYPES[k % ANNEX_TYPES.length];
      const gen = generateStructureMesh(type);
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const place = (p: Vector3) => new Vector3(cx + (c * p.x - s * p.y) * ANNEX_SCALE, cy + (s * p.x + c * p.y) * ANNEX_SCALE, p.z * ANNEX_Z_SCALE);
      const turn = (q: Vector3) => new Vector3(c * q.x - s * q.y, s * q.x + c * q.y, q.z);
      const add = (dst: typeof body, verts: Vector3[], norms: Vector3[] | null, tris: number[]) => {
        const base = dst.v.length;
        verts.forEach((p, i) => {
          dst.v.push(place(p));
          dst.n.push(norms ? turn(norms[i]) : new Vector3(0, 0, 1));
        });
        for (const t of tris) dst.t.push(base + t);
      };
      add(body, gen.vertices, gen.normals, gen.triangles);
      if (gen.voidTriangles.length > 0) add(voids, gen.voidVertices, null, gen.voidTriangles);
      for (const w of gen.wires) wires.push(w.map(place));
      for (const w of gen.accents) accents.push(w.map(place));
      // duto: da borda do prédio principal à borda do anexo, rente ao chão
      const len = Math.hypot(cx, cy);
      const ux = cx / len, uy = cy / len;
      const r0 = entry.radius;
      const r1 = len - STRUCTURE_SPECS[type].radius * ANNEX_SCALE;
      if (r1 > r0) accents.push([new Vector3(ux * r0, uy * r0, CONDUIT_Z), new Vector3(ux * r1, uy * r1, CONDUIT_Z)]);
    }

    const solid = this.makeSolid(`${node.name}_body`, body.v, body.n, body.t, this.structMat);
    solid.parent = node;
    entry.annexMeshes.push(solid);
    if (voids.t.length > 0) {
      const hole = this.makeSolid(`${node.name}_voids`, voids.v, voids.n, voids.t, this.voidMat);
      hole.parent = node;
      entry.annexMeshes.push(hole);
    }
    const wire = this.makeLine(`${node.name}_wire`, wires, WIRE_PX, c3(Palette.wire).scale(WIRE_DIM), false);
    wire.parent = node;
    entry.annexLines.push(wire);
    const accentColor = c3(entry.own ? Palette.structure.own : Palette.structure.other);
    const acc = this.makeLine(`${node.name}_accents`, accents, ACCENT_PX, accentColor, true);
    acc.parent = node;
    entry.annexLines.push(acc);
  }

  private disposeEntry(entry: StructEntry): void {
    for (const m of entry.annexLines) disposeLineBundle(m, this.glow);
    for (const m of entry.annexMeshes) m.dispose(false, false);
    entry.annexNode?.dispose();
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
