/**
 * WormRenderer — as MINHOCAS GIGANTES de Ceres (shared/worms.ts), low poly
 * como o resto do jogo e com o desenho das minhocas de Duna: corpo de gomos
 * anelados cor de areia, com um friso escuro em cada um, e a cabeça com a
 * BOCA DE TRÊS PÉTALAS que se abrem mostrando a goela incandescente e o anel
 * de dentes.
 *
 * PROFUNDIDADE. A minhoca viaja na camada Z do CENTRO dos asteroides: entra
 * na rocha pela LATERAL e a atravessa pelo miolo (a rocha a esconde); no
 * vácuo segue nessa mesma profundidade (WORM_TRAVEL_Z). Em Ceres (esfera de
 * 40 km) ela vai enterrada logo abaixo da superfície. Cada gomo recebe a
 * profundidade de onde está (`depth`) e a superfície da rocha sobre ele
 * (`top`); a profundidade é SUAVIZADA ao longo da corrente — a entrada e a
 * saída pela lateral viram rampas. Perto da presa a cabeça sobe à
 * superfície (`breach`) e a boca abre (`mouth`).
 *
 * CRUZEIRO. Atrás das naves de ataque ela sobe do fundo até a camada de
 * cruzeiro (`lift` por gomo, 0..1, vindo do servidor — o corpo refaz a
 * rampa diagonal da cabeça). Na vista de cima, a camada das naves; no
 * COCKPIT, como as naves em cruzeiro, sobe mais `fpLift` — fica na linha
 * do horizonte de quem voa em cruzeiro (ajuste por câmera, como no
 * ShipRenderer).
 *
 * Os gomos de todas as minhocas são thin instances de um único mesh; a
 * cabeça é um conjunto de meshes por minhoca.
 *
 * A TOCA (o buraco de saída numa plataforma de Ceres) é um poço escuro com
 * brasa no fundo e um anel de blocos de rocha na borda; cada mina detonada
 * nela joga um monte de entulho dentro (setHole, `seal`).
 */

import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Observer } from "@babylonjs/core/Misc/observable";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { WORM_HOLE_RADIUS, WORM_HOLE_SEAL_MINES, WORM_SPACING, wormRadiusAt } from "@ceres/shared";

/** comprimento de cada gomo em relação ao espaçamento (sobrepõe os vizinhos) */
const SEG_LENGTH = 1.3;
/** passadas da suavização da altura ao longo da corrente */
const SMOOTH_PASSES = 5;

const SAND = new Color3(0.72, 0.56, 0.36);
const SAND_DARK = new Color3(0.45, 0.33, 0.2);
const SAND_LIGHT = new Color3(0.82, 0.68, 0.48);

/** O que a cena entrega por minhoca, por quadro. */
export interface WormView {
  /** posição de render (jogo) de cada gomo, 0 = cabeça */
  pts: ReadonlyArray<{ x: number; y: number }>;
  /** z de cena onde cada gomo viaja (centro da rocha, sob a superfície de Ceres ou a camada do vácuo) */
  depth: ReadonlyArray<number>;
  /** z de cena da superfície do corpo sobre cada gomo (null no vácuo) — para onde a cabeça sobe */
  top: ReadonlyArray<number | null>;
  /** 0..1 — cabeça erguida do chão; boca aberta */
  breach: number;
  mouth: number;
  /** altura de cada gomo: 0 = fundo (`depth`) .. 1 = camada de cruzeiro (`cruiseZ`) */
  lift: ReadonlyArray<number>;
  cruiseZ: number;
  /** no cockpit, quanto o gomo em cruzeiro sobe a mais (× `lift`) */
  fpLift: number;
}

interface Head {
  root: TransformNode;
  pivots: TransformNode[];
}

interface Geo {
  pos: number[];
  col: number[];
  idx: number[];
}

/** Triângulo com cor própria (vértices não compartilhados: facetado). */
function tri(g: Geo, a: Vector3, b: Vector3, c: Vector3, color: Color3): void {
  const base = g.pos.length / 3;
  for (const p of [a, b, c]) {
    g.pos.push(p.x, p.y, p.z);
    g.col.push(color.r, color.g, color.b, 1);
  }
  g.idx.push(base, base + 1, base + 2);
}

function quad(g: Geo, a: Vector3, b: Vector3, c: Vector3, d: Vector3, color: Color3): void {
  tri(g, a, b, c, color);
  tri(g, a, c, d, color);
}

function toMesh(name: string, g: Geo, scene: Scene): Mesh {
  const normals: number[] = [];
  VertexData.ComputeNormals(g.pos, g.idx, normals);
  const vd = new VertexData();
  vd.positions = g.pos;
  vd.colors = g.col;
  vd.indices = g.idx;
  vd.normals = normals;
  const m = new Mesh(name, scene);
  vd.applyToMesh(m);
  m.isPickable = false;
  return m;
}

/** ponto do anel de raio `r` em x, no ângulo `a` em volta do eixo X */
const ring = (x: number, r: number, a: number) => new Vector3(x, Math.cos(a) * r, Math.sin(a) * r);

/** Tubo octogonal ao longo de X por anéis (x, raio, cor da faixa até o próximo). */
function tube(g: Geo, rings: ReadonlyArray<[number, number, Color3]>, sides = 8, capStart = true, capEnd = true): void {
  for (let k = 0; k + 1 < rings.length; k++) {
    const [x0, r0, c] = rings[k];
    const [x1, r1] = rings[k + 1];
    for (let s = 0; s < sides; s++) {
      const a0 = (s / sides) * Math.PI * 2, a1 = ((s + 1) / sides) * Math.PI * 2;
      // facetas alternando um tom: o corpo lê anelado e facetado
      quad(g, ring(x0, r0, a0), ring(x1, r1, a0), ring(x1, r1, a1), ring(x0, r0, a1), s % 2 ? c : c.scale(0.92));
    }
  }
  const cap = (x: number, r: number, c: Color3) => {
    for (let s = 0; s < sides; s++) {
      const a0 = (s / sides) * Math.PI * 2, a1 = ((s + 1) / sides) * Math.PI * 2;
      tri(g, new Vector3(x, 0, 0), ring(x, r, a1), ring(x, r, a0), c);
    }
  };
  if (capStart) cap(rings[0][0], rings[0][1], rings[0][2]);
  if (capEnd) { const l = rings[rings.length - 1]; cap(l[0], l[1], l[2]); }
}

export class WormRenderer {
  private scene: Scene;
  private seg: Mesh;
  private bodyMat: StandardMaterial;
  private mawMat: StandardMaterial;
  private teethMat: StandardMaterial;
  private heads = new Map<string, Head>();
  private views = new Map<string, WormView>();
  private matrices = new Float32Array(0);
  /** por gomo desenhado: o z da vista de cima e quanto sobe a mais no cockpit */
  private baseZ = new Float32Array(0);
  private fpOff = new Float32Array(0);
  /** cabeças: o z da vista de cima e o a mais do cockpit */
  private headZ = new Map<string, { z: number; off: number }>();
  private mainCamera: Camera;
  private observer: Observer<Camera> | null;
  private hole: { root: TransformNode; rubble: Mesh[] } | null = null;
  private pitGlowMat: StandardMaterial;
  /** poço e entulho: sem o emissivo do corpo — o fundo tem que ler escuro */
  private pitMat: StandardMaterial;

  /** `mainCamera` = a vista de cima; nas outras (cockpit) o cruzeiro sobe `fpLift` */
  constructor(scene: Scene, mainCamera: Camera) {
    this.scene = scene;
    this.mainCamera = mainCamera;
    this.observer = scene.onBeforeCameraRenderObservable.add((cam) => this.applyCamera(cam));
    this.bodyMat = new StandardMaterial("wormBody", scene);
    this.bodyMat.diffuseColor = Color3.White(); // a cor vem dos vértices
    this.bodyMat.specularColor = Color3.Black();
    this.bodyMat.emissiveColor = new Color3(0.08, 0.06, 0.04);
    this.bodyMat.backFaceCulling = false;
    this.mawMat = new StandardMaterial("wormMaw", scene);
    this.mawMat.disableLighting = true;
    this.mawMat.emissiveColor = new Color3(0.85, 0.22, 0.06);
    this.mawMat.backFaceCulling = false;
    this.teethMat = new StandardMaterial("wormTeeth", scene);
    this.teethMat.diffuseColor = new Color3(0.95, 0.9, 0.78);
    this.teethMat.emissiveColor = new Color3(0.35, 0.32, 0.26);
    this.teethMat.specularColor = Color3.Black();
    this.pitGlowMat = new StandardMaterial("wormPitGlow", scene);
    this.pitGlowMat.disableLighting = true;
    this.pitGlowMat.emissiveColor = new Color3(0.22, 0.04, 0.01);
    this.pitGlowMat.backFaceCulling = false;
    this.pitMat = new StandardMaterial("wormPit", scene);
    this.pitMat.diffuseColor = Color3.White();
    this.pitMat.specularColor = Color3.Black();
    this.pitMat.backFaceCulling = false;

    // GOMO: comprimento 1 ao longo de X (−0.5..0.5), raio 1, friso escuro na frente
    const g: Geo = { pos: [], col: [], idx: [] };
    tube(g, [
      [-0.5, 0.86, SAND],
      [-0.38, 1.0, SAND],
      [0.22, 1.0, SAND_DARK],
      [0.3, 1.1, SAND_DARK],
      [0.42, 1.1, SAND_LIGHT],
      [0.5, 0.95, SAND_LIGHT],
    ]);
    this.seg = toMesh("wormSeg", g, scene);
    this.seg.material = this.bodyMat;
    this.seg.alwaysSelectAsActiveMesh = true;
    this.seg.thinInstanceSetBuffer("matrix", this.matrices, 16, false);
  }

  /** Atualiza (cria se preciso) a minhoca `id` para este quadro. */
  update(id: string, view: WormView): void {
    this.views.set(id, view);
    if (!this.heads.has(id)) this.heads.set(id, this.makeHead(id));
  }

  /** Descarta as que não estão em `alive` e monta os gomos de todas. */
  retain(alive: ReadonlySet<string>): void {
    for (const [id, h] of this.heads) {
      if (alive.has(id)) continue;
      h.root.dispose();
      this.heads.delete(id);
    }
    for (const id of [...this.views.keys()]) if (!alive.has(id)) this.views.delete(id);
    for (const id of [...this.headZ.keys()]) if (!alive.has(id)) this.headZ.delete(id);
    this.draw();
  }

  private draw(): void {
    let count = 0;
    for (const v of this.views.values()) count += Math.max(0, v.pts.length - 1);
    if (this.matrices.length !== count * 16) {
      this.matrices = new Float32Array(count * 16);
      this.baseZ = new Float32Array(count);
      this.fpOff = new Float32Array(count);
      this.seg.thinInstanceSetBuffer("matrix", this.matrices, 16, false);
    }
    let k = 0;
    for (const [id, v] of this.views) {
      const p = this.scenePoints(v);
      for (let i = 1; i < p.length; i++) {
        const r = wormRadiusAt(i);
        this.baseZ[k] = p[i].z;
        this.fpOff[k] = v.fpLift * (v.lift[i] ?? 0);
        this.writeMatrix(k++, p[i], this.tangent(p, i), WORM_SPACING * SEG_LENGTH, r);
      }
      const head = this.heads.get(id);
      if (head && p.length > 1) this.placeHead(head, p[0], this.tangent(p, 0), wormRadiusAt(0), v.mouth);
      this.headZ.set(id, { z: p[0].z, off: v.fpLift * (v.lift[0] ?? 0) });
    }
    this.seg.setEnabled(count > 0);
    if (count > 0) this.seg.thinInstanceBufferUpdated("matrix");
  }

  /** Pontos de cena dos gomos, com a altura suavizada (ver ALTURA no topo). */
  private scenePoints(v: WormView): Vector3[] {
    const n = v.pts.length;
    let z = v.depth.slice();
    for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
      const s = z.slice();
      for (let i = 1; i + 1 < n; i++) s[i] = 0.25 * z[i - 1] + 0.5 * z[i] + 0.25 * z[i + 1];
      z = s;
    }
    // perto da presa, a cabeça (e o pescoço) sobe à superfície da rocha
    for (let i = 0; i < Math.min(3, n); i++) {
      const up = (v.top[i] ?? z[i]) - 1.3 * wormRadiusAt(i);
      z[i] += (Math.min(z[i], up) - z[i]) * v.breach * (1 - i / 3);
    }
    // subindo ao cruzeiro: do fundo à camada das naves, gomo a gomo (a rampa)
    for (let i = 0; i < n; i++) z[i] += (v.cruiseZ - z[i]) * (v.lift[i] ?? 0);
    return v.pts.map((p, i) => new Vector3(p.x, -p.y, z[i]));
  }

  /**
   * Por passe de câmera: na vista de cima o z de cena; no cockpit, quem está
   * no cruzeiro sobe `fpOff` a mais (só reescreve quando há altura).
   */
  private applyCamera(cam: Camera): void {
    const main = cam === this.mainCamera;
    let any = false;
    for (let k = 0; k < this.fpOff.length; k++) {
      if (this.fpOff[k] === 0) continue;
      any = true;
      this.matrices[k * 16 + 14] = this.baseZ[k] - (main ? 0 : this.fpOff[k]);
    }
    if (any) this.seg.thinInstanceBufferUpdated("matrix");
    for (const [id, h] of this.headZ) {
      const head = this.heads.get(id);
      if (head && h.off !== 0) head.root.position.z = h.z - (main ? 0 : h.off);
    }
  }

  /** Direção do corpo no gomo `i` (para a frente, rumo à cabeça). */
  private tangent(p: Vector3[], i: number): Vector3 {
    const a = p[Math.max(0, i - 1)];
    const b = p[Math.min(p.length - 1, i + 1)];
    const t = a.subtract(b);
    return t.lengthSquared() > 1e-6 ? t.normalize() : new Vector3(1, 0, 0);
  }

  /** Base ortonormal com X = `fwd` e Y no plano do jogo quanto possível. */
  private basis(fwd: Vector3): [Vector3, Vector3, Vector3] {
    const up = new Vector3(0, 0, -1);
    let y = Vector3.Cross(up, fwd);
    if (y.lengthSquared() < 1e-6) y = new Vector3(0, 1, 0);
    y.normalize();
    const z = Vector3.Cross(fwd, y).normalize();
    return [fwd, y, z];
  }

  private writeMatrix(k: number, pos: Vector3, fwd: Vector3, len: number, r: number): void {
    const [x, y, z] = this.basis(fwd);
    const m = this.matrices;
    const o = k * 16;
    m[o] = x.x * len; m[o + 1] = x.y * len; m[o + 2] = x.z * len; m[o + 3] = 0;
    m[o + 4] = y.x * r; m[o + 5] = y.y * r; m[o + 6] = y.z * r; m[o + 7] = 0;
    m[o + 8] = z.x * r; m[o + 9] = z.y * r; m[o + 10] = z.z * r; m[o + 11] = 0;
    m[o + 12] = pos.x; m[o + 13] = pos.y; m[o + 14] = pos.z; m[o + 15] = 1;
  }

  private placeHead(h: Head, pos: Vector3, fwd: Vector3, r: number, mouth: number): void {
    const [x, y, z] = this.basis(fwd);
    const rot = Matrix.FromValues(x.x, x.y, x.z, 0, y.x, y.y, y.z, 0, z.x, z.y, z.z, 0, 0, 0, 0, 1);
    h.root.rotationQuaternion ??= new Quaternion();
    Quaternion.FromRotationMatrixToRef(rot, h.root.rotationQuaternion);
    h.root.position.copyFrom(pos);
    h.root.scaling.setAll(r);
    // pétalas: giram para fora em volta da dobradiça (ver makeHead)
    h.pivots.forEach((p, k) => {
      const am = (k / 3) * Math.PI * 2 + Math.PI / 2;
      const axis = new Vector3(0, -Math.sin(am), Math.cos(am));
      p.rotationQuaternion = Quaternion.RotationAxis(axis, mouth * 1.15);
    });
  }

  /**
   * Cabeça (unidade = raio do corpo): pescoço com friso, goela incandescente,
   * anel de dentes e três pétalas que, fechadas, formam o bico cônico.
   */
  private makeHead(id: string): Head {
    const root = new TransformNode(`worm_${id}`, this.scene);
    const neck: Geo = { pos: [], col: [], idx: [] };
    tube(neck, [
      [-0.55, 1.0, SAND],
      [-0.1, 1.06, SAND_DARK],
      [0.0, 1.12, SAND_DARK],
      [0.15, 1.04, SAND_DARK],
    ], 9, true, false);
    const neckMesh = toMesh(`worm_${id}_neck`, neck, this.scene);
    neckMesh.material = this.bodyMat;
    neckMesh.parent = root;

    // goela: disco no fundo da boca
    const maw: Geo = { pos: [], col: [], idx: [] };
    for (let s = 0; s < 9; s++) {
      const a0 = (s / 9) * Math.PI * 2, a1 = ((s + 1) / 9) * Math.PI * 2;
      tri(maw, new Vector3(0.02, 0, 0), ring(0.12, 1.0, a0), ring(0.12, 1.0, a1), Color3.White());
    }
    const mawMesh = toMesh(`worm_${id}_maw`, maw, this.scene);
    mawMesh.material = this.mawMat;
    mawMesh.parent = root;

    // dentes: anel de espinhos apontando para dentro e para a frente
    const teeth: Geo = { pos: [], col: [], idx: [] };
    const nT = 15;
    for (let t = 0; t < nT; t++) {
      const a = (t / nT) * Math.PI * 2;
      const w = 0.12;
      const b0 = ring(0.13, 0.95, a - w), b1 = ring(0.13, 0.95, a + w), b2 = ring(0.06, 0.88, a);
      const tip = ring(0.42, 0.55, a);
      tri(teeth, b0, b1, tip, Color3.White());
      tri(teeth, b1, b2, tip, Color3.White());
      tri(teeth, b2, b0, tip, Color3.White());
    }
    const teethMesh = toMesh(`worm_${id}_teeth`, teeth, this.scene);
    teethMesh.material = this.teethMat;
    teethMesh.parent = root;

    // pétalas: cada uma presa na borda da boca (pivô), fechadas em bico
    const pivots: TransformNode[] = [];
    for (let k = 0; k < 3; k++) {
      const am = (k / 3) * Math.PI * 2 + Math.PI / 2;
      const hinge = ring(0.15, 1.04, am);
      const pivot = new TransformNode(`worm_${id}_pivot${k}`, this.scene);
      pivot.parent = root;
      pivot.position.copyFrom(hinge);
      const g: Geo = { pos: [], col: [], idx: [] };
      const rel = (v: Vector3) => v.subtract(hinge);
      const tip = rel(new Vector3(1.0, 0, 0));
      const steps = 4;
      const span = (Math.PI * 2) / 3;
      for (let s = 0; s < steps; s++) {
        const a0 = am - span / 2 + (span * s) / steps;
        const a1 = am - span / 2 + (span * (s + 1)) / steps;
        // dois andares: base larga e o meio já curvando para o bico
        const b0 = rel(ring(0.15, 1.04, a0)), b1 = rel(ring(0.15, 1.04, a1));
        const m0 = rel(ring(0.6, 0.62, a0)), m1 = rel(ring(0.6, 0.62, a1));
        const c = s % 2 ? SAND : SAND_LIGHT;
        quad(g, b0, b1, m1, m0, c);
        tri(g, m0, m1, tip, c.scale(0.9));
      }
      const petal = toMesh(`worm_${id}_petal${k}`, g, this.scene);
      petal.material = this.bodyMat;
      petal.parent = pivot;
      pivots.push(pivot);
    }
    return { root, pivots };
  }

  /**
   * Toca aberta em (x, y) de render, no chão `z` da plataforma, com `seal`
   * minas já detonadas (o entulho); null esconde.
   */
  setHole(v: { x: number; y: number; z: number; seal: number } | null): void {
    if (!v) {
      this.hole?.root.setEnabled(false);
      return;
    }
    this.hole ??= this.makeHole();
    this.hole.root.setEnabled(true);
    this.hole.root.position.set(v.x, -v.y, v.z - 3);
    this.hole.rubble.forEach((m, k) => m.setEnabled(v.seal > k));
  }

  /** Poço, brasa, anel de blocos e um monte de entulho por mina (em cena; −z = para cima). */
  private makeHole(): { root: TransformNode; rubble: Mesh[] } {
    const R = WORM_HOLE_RADIUS;
    const root = new TransformNode("wormHole", this.scene);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const at = (a: number, r: number, z: number) => new Vector3(Math.cos(a) * r, Math.sin(a) * r, z);
    // bloco de rocha: tronco de pirâmide facetado
    const rock = (g: Geo, cx: number, cy: number, size: number, height: number, c: Color3) => {
      const n = 5;
      const spin = rnd() * Math.PI;
      const base: Vector3[] = [], top: Vector3[] = [];
      for (let k = 0; k < n; k++) {
        const a = spin + (k / n) * Math.PI * 2;
        const r = size * (0.75 + 0.35 * rnd());
        base.push(new Vector3(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0));
        top.push(new Vector3(cx + Math.cos(a) * r * 0.55, cy + Math.sin(a) * r * 0.55, -height));
      }
      const peak = new Vector3(cx, cy, -height * 1.15);
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n;
        quad(g, base[k], base[k2], top[k2], top[k], k % 2 ? c : c.scale(0.8));
        tri(g, top[k], top[k2], peak, c.scale(1.1));
      }
    };

    const pit: Geo = { pos: [], col: [], idx: [] };
    const sides = 14;
    for (let s = 0; s < sides; s++) {
      const a0 = (s / sides) * Math.PI * 2, a1 = ((s + 1) / sides) * Math.PI * 2;
      // o poço é PINTADO rente ao chão (abaixo da superfície, Ceres o
      // esconderia): borda escurecendo até o fundo quase preto
      quad(pit, at(a0, R, -1), at(a1, R, -1), at(a1, R * 0.6, -2), at(a0, R * 0.6, -2), SAND_DARK.scale(0.3));
      quad(pit, at(a0, R * 0.6, -2), at(a1, R * 0.6, -2), at(a1, R * 0.3, -3), at(a0, R * 0.3, -3), new Color3(0.06, 0.04, 0.03));
      tri(pit, new Vector3(0, 0, -3), at(a1, R * 0.3, -3), at(a0, R * 0.3, -3), new Color3(0.02, 0.015, 0.012));
    }
    // anel de blocos na borda
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2 + rnd() * 0.2;
      const r = R * (1.02 + rnd() * 0.12);
      rock(pit, Math.cos(a) * r, Math.sin(a) * r, R * (0.12 + rnd() * 0.07), R * (0.08 + rnd() * 0.12), SAND_DARK);
    }
    const pitMesh = toMesh("wormHole_pit", pit, this.scene);
    pitMesh.material = this.pitMat;
    pitMesh.parent = root;

    // brasa no fundo
    const glow: Geo = { pos: [], col: [], idx: [] };
    for (let s = 0; s < sides; s++) {
      const a0 = (s / sides) * Math.PI * 2, a1 = ((s + 1) / sides) * Math.PI * 2;
      tri(glow, new Vector3(0, 0, -4), at(a1, R * 0.16, -4), at(a0, R * 0.16, -4), Color3.White());
    }
    const glowMesh = toMesh("wormHole_glow", glow, this.scene);
    glowMesh.material = this.pitGlowMat;
    glowMesh.parent = root;

    // entulho: um monte por mina detonada, até tapar
    const rubble: Mesh[] = [];
    for (let k = 0; k < WORM_HOLE_SEAL_MINES; k++) {
      const g: Geo = { pos: [], col: [], idx: [] };
      for (let b = 0; b < 5; b++) {
        const a = rnd() * Math.PI * 2;
        const r = R * 0.6 * Math.sqrt(rnd());
        rock(g, Math.cos(a) * r, Math.sin(a) * r, R * (0.13 + rnd() * 0.1), R * (0.06 + rnd() * 0.08), SAND.scale(0.75));
      }
      const m = toMesh(`wormHole_rubble${k}`, g, this.scene);
      m.material = this.pitMat;
      m.parent = root;
      m.position.z = -5 - k * 10; // cada monte assenta um pouco mais alto
      rubble.push(m);
    }
    return { root, rubble };
  }

  dispose(): void {
    if (this.observer) this.scene.onBeforeCameraRenderObservable.remove(this.observer);
    this.observer = null;
    this.hole?.root.dispose();
    this.pitGlowMat.dispose();
    this.pitMat.dispose();
    for (const h of this.heads.values()) h.root.dispose();
    this.heads.clear();
    this.seg.dispose();
    this.bodyMat.dispose();
    this.mawMat.dispose();
    this.teethMat.dispose();
  }
}
