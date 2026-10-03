/**
 * ExplosionRenderer — explosões com VOLUME, no idioma low poly das rochas:
 * malhas facetadas (flat shading), iluminadas pelo rig da cena e com brilho
 * próprio (emissivo → GlowLayer). Cada explosão dura EXPLOSION_DURATION e é
 * montada de cinco partes:
 *  - NÚCLEO: clarão branco-amarelo que abre rápido e se fecha;
 *  - BOLA DE FOGO: icosfera irregular que cresce e esfria de amarelo a
 *    laranja, vermelho e fumaça, sumindo no fim;
 *  - FUMAÇA: lóbulos cinzentos que sobem (em direção à câmera) e se dissipam;
 *  - DESTROÇOS: tetraedros girando para fora, em brasa no começo;
 *  - ONDA DE CHOQUE: anel achatado no plano do jogo que abre e some.
 *
 * O raio vem de QUEM recebeu o dano (GameScene): a explosão engloba parte do
 * prédio ou da nave atingida. Na câmera principal as naves são infladas
 * (ShipRenderer.screenScale); a explosão presa a uma nave infla junto só
 * nela — no cockpit fica do tamanho da nave de verdade.
 */

import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import type { Observer } from "@babylonjs/core/Misc/observable";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { icosphere } from "./AsteroidMeshGenerator";

/** duração de toda explosão (s) — lenta de propósito */
export const EXPLOSION_DURATION = 1.5;

const SMOKE_PUFFS = 4;
const DEBRIS = 9;

/** Rampa de cor da bola de fogo: [t, r, g, b] */
const FIRE_RAMP: Array<[number, number, number, number]> = [
  [0, 1, 0.92, 0.55],
  [0.15, 1, 0.62, 0.16],
  [0.45, 0.85, 0.24, 0.06],
  [0.75, 0.32, 0.12, 0.08],
  [1, 0.18, 0.17, 0.17],
];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOut = (x: number) => 1 - (1 - clamp01(x)) ** 3;
const smooth = (a: number, b: number, x: number) => {
  const u = clamp01((x - a) / (b - a));
  return u * u * (3 - 2 * u);
};

function ramp(t: number): Color3 {
  for (let i = 1; i < FIRE_RAMP.length; i++) {
    const [t1, r1, g1, b1] = FIRE_RAMP[i];
    if (t <= t1) {
      const [t0, r0, g0, b0] = FIRE_RAMP[i - 1];
      const u = (t - t0) / (t1 - t0);
      return new Color3(r0 + (r1 - r0) * u, g0 + (g1 - g0) * u, b0 + (b1 - b0) * u);
    }
  }
  const [, r, g, b] = FIRE_RAMP[FIRE_RAMP.length - 1];
  return new Color3(r, g, b);
}

/** Geometria facetada (vértices desagrupados por face → flat shading). */
interface Geo { positions: number[]; normals: number[]; indices: number[] }

function flatGeo(points: Vector3[], faces: number[]): Geo {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let f = 0; f < faces.length; f += 3) {
    for (let k = 0; k < 3; k++) {
      const p = points[faces[f + k]];
      positions.push(p.x, p.y, p.z);
      indices.push(f + k);
    }
  }
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  return { positions, normals, indices };
}

/** Icosfera de raio 1 com relevo sorteado (lóbulos irregulares). */
function lumpyBall(subdiv: number, roughness: number, rng: () => number): Geo {
  const ico = icosphere(subdiv);
  const pts = ico.dirs.map((d) => d.scale(1 + (rng() * 2 - 1) * roughness));
  // as faces externas precisam apontar para fora
  const faces = ico.faces.slice();
  for (let f = 0; f < faces.length; f += 3) {
    const a = pts[faces[f]], b = pts[faces[f + 1]], c = pts[faces[f + 2]];
    const n = Vector3.Cross(b.subtract(a), c.subtract(a));
    if (Vector3.Dot(n, a.add(b).add(c)) < 0) [faces[f + 1], faces[f + 2]] = [faces[f + 2], faces[f + 1]];
  }
  return flatGeo(pts, faces);
}

function tetraGeo(): Geo {
  const s = 1 / Math.sqrt(3);
  const p = [new Vector3(s, s, s), new Vector3(s, -s, -s), new Vector3(-s, s, -s), new Vector3(-s, -s, s)];
  return flatGeo(p, [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2]);
}

/** Anel achatado (raio 1, largura `w`) no plano XY — a onda de choque. */
function ringGeo(segments: number, w: number): Geo {
  const pts: Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new Vector3(Math.cos(a), Math.sin(a), 0), new Vector3(Math.cos(a) * (1 - w), Math.sin(a) * (1 - w), 0));
  }
  const faces: number[] = [];
  for (let i = 0; i < segments; i++) {
    const o0 = i * 2, i0 = o0 + 1, o1 = ((i + 1) % segments) * 2, i1 = o1 + 1;
    faces.push(o0, o1, i0, i0, o1, i1);
  }
  return flatGeo(pts, faces);
}

function meshFrom(name: string, g: Geo, scene: Scene): Mesh {
  const m = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = g.positions;
  vd.normals = g.normals;
  vd.indices = g.indices;
  vd.applyToMesh(m);
  m.isPickable = false;
  return m;
}

/** Mulberry32 local: cada explosão tem forma própria, sem depender do Math.random global. */
function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Live {
  root: TransformNode;
  t0: number;
  radius: number;
  /** escala extra só na câmera principal (nave inflada) */
  inflate: number;
  core: Mesh;
  fire: Mesh;
  ring: Mesh;
  /** escala do anel neste quadro, antes de inflar (ele não é filho do root) */
  ringS: number;
  smoke: Array<{ mesh: Mesh; dir: Vector3; size: number }>;
  debris: Array<{ mesh: Mesh; dir: Vector3; spin: Vector3; size: number }>;
  mats: { core: StandardMaterial; fire: StandardMaterial; smoke: StandardMaterial; debris: StandardMaterial; ring: StandardMaterial };
  done: boolean;
}

/** Alça de uma explosão: a cena reposiciona a cada quadro (origem flutuante, alvo que se move). */
export interface ExplosionHandle {
  readonly done: boolean;
  /** centro em coordenadas de cena (x, y já convertidos por toScene) e o fator de inflar */
  place(pos: Vector3, inflate: number): void;
}

export class ExplosionRenderer {
  private scene: Scene;
  private main: Camera;
  private glow: GlowLayer;
  private live: Live[] = [];
  private templates: { fire: Geo[]; smoke: Geo[]; core: Geo; debris: Geo; ring: Geo };
  private seq = 0;
  private observer: Observer<Camera> | null;

  constructor(scene: Scene, mainCamera: Camera, glow: GlowLayer) {
    this.scene = scene;
    this.main = mainCamera;
    this.glow = glow;
    const rng = rngOf(0xb00b5);
    // algumas formas sorteadas uma vez; cada explosão escolhe e gira a sua
    this.templates = {
      fire: [0, 1, 2].map(() => lumpyBall(2, 0.22, rng)),
      smoke: [0, 1, 2].map(() => lumpyBall(1, 0.3, rng)),
      core: lumpyBall(1, 0.12, rng),
      debris: tetraGeo(),
      ring: ringGeo(18, 0.22),
    };
    // a explosão presa a uma nave infla com ela — só na câmera principal
    this.observer = scene.onBeforeCameraRenderObservable.add((cam) => {
      const main = cam === this.main;
      for (const e of this.live) {
        const k = main ? e.inflate : 1;
        e.root.scaling.setAll(k);
        e.ring.scaling.setAll(e.ringS * k);
      }
    });
  }

  /** Começa uma explosão de raio final `radius` (mundo). */
  spawn(radius: number): ExplosionHandle {
    const id = this.seq++;
    const rng = rngOf(0x9e3779b9 ^ (id * 2654435761));
    const root = new TransformNode(`explosion_${id}`, this.scene);
    root.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);

    const mat = (name: string, diffuse: Color3, emissive: Color3): StandardMaterial => {
      const m = new StandardMaterial(`explosion_${id}_${name}`, this.scene);
      m.diffuseColor = diffuse;
      m.emissiveColor = emissive;
      m.specularColor = Color3.Black();
      m.backFaceCulling = false;
      return m;
    };
    const mats = {
      core: mat("core", new Color3(1, 1, 0.8), new Color3(1, 0.95, 0.75)),
      fire: mat("fire", ramp(0), ramp(0)),
      smoke: mat("smoke", new Color3(0.3, 0.29, 0.28), Color3.Black()),
      debris: mat("debris", new Color3(0.35, 0.33, 0.3), new Color3(1, 0.5, 0.15)),
      ring: mat("ring", new Color3(1, 0.7, 0.3), new Color3(1, 0.6, 0.25)),
    };
    mats.core.disableLighting = true;
    mats.ring.disableLighting = true;

    const pick = <T>(xs: T[]) => xs[Math.floor(rng() * xs.length) % xs.length];
    const core = meshFrom(`${root.name}_core`, this.templates.core, this.scene);
    const fire = meshFrom(`${root.name}_fire`, pick(this.templates.fire), this.scene);
    const ring = meshFrom(`${root.name}_ring`, this.templates.ring, this.scene);
    core.material = mats.core;
    fire.material = mats.fire;
    ring.material = mats.ring;
    for (const m of [core, fire, ring]) m.parent = root;
    // só o núcleo e o anel brilham: no fogo, na fumaça e nos destroços o glow
    // borrava as facetas e a explosão virava uma bola lisa
    this.glow.addExcludedMesh(fire);
    // o anel fica no plano do JOGO (XY da cena), não no quadro girado do root
    ring.parent = null;

    const smoke: Live["smoke"] = [];
    for (let i = 0; i < SMOKE_PUFFS; i++) {
      const m = meshFrom(`${root.name}_smoke${i}`, pick(this.templates.smoke), this.scene);
      m.material = mats.smoke;
      m.parent = root;
      this.glow.addExcludedMesh(m);
      const a = rng() * Math.PI * 2;
      const dir = new Vector3(Math.cos(a), Math.sin(a), 0.4 + rng() * 0.8).normalize();
      smoke.push({ mesh: m, dir, size: 0.35 + rng() * 0.25 });
    }
    const debris: Live["debris"] = [];
    for (let i = 0; i < DEBRIS; i++) {
      const m = meshFrom(`${root.name}_debris${i}`, this.templates.debris, this.scene);
      m.material = mats.debris;
      m.parent = root;
      this.glow.addExcludedMesh(m);
      const a = rng() * Math.PI * 2;
      const dir = new Vector3(Math.cos(a), Math.sin(a), (rng() * 2 - 1) * 0.6).normalize().scale(0.8 + rng() * 0.7);
      debris.push({ mesh: m, dir, spin: new Vector3(rng() * 8 - 4, rng() * 8 - 4, rng() * 8 - 4), size: 0.06 + rng() * 0.07 });
    }

    const e: Live = {
      root, t0: performance.now() / 1000, radius, inflate: 1,
      core, fire, ring, ringS: 0, smoke, debris, mats, done: false,
    };
    this.live.push(e);
    this.animate(e, 0);
    return {
      get done() { return e.done; },
      place: (pos: Vector3, inflate: number) => {
        e.root.position.copyFrom(pos);
        e.ring.position.copyFrom(pos);
        e.inflate = inflate;
      },
    };
  }

  /** Anima todas e descarta as que terminaram. Chamar uma vez por quadro. */
  tick(): void {
    const now = performance.now() / 1000;
    for (const e of this.live) {
      const t = (now - e.t0) / EXPLOSION_DURATION;
      if (t >= 1) this.dispose(e);
      else this.animate(e, t);
    }
    this.live = this.live.filter((e) => !e.done);
  }

  private animate(e: Live, t: number): void {
    const R = e.radius;
    // NÚCLEO: abre em 0,1 da vida e se fecha até 0,45
    const coreS = R * 0.55 * easeOut(t / 0.1) * (1 - smooth(0.12, 0.45, t));
    e.core.setEnabled(coreS > 0.5);
    e.core.scaling.setAll(Math.max(0.001, coreS));
    e.mats.core.alpha = 1 - smooth(0.25, 0.45, t);

    // BOLA DE FOGO: cresce desacelerando, esfria pela rampa, some no fim
    const fireS = R * (0.3 + 0.7 * easeOut(t * 1.4));
    e.fire.scaling.setAll(fireS);
    e.fire.rotation.z = t * 0.6;
    const c = ramp(t);
    const glow = 1 - smooth(0.2, 0.8, t);
    e.mats.fire.diffuseColor = c;
    // emissivo contido: a luz da cena desenha as facetas, o emissivo só aquece
    e.mats.fire.emissiveColor = c.scale(0.15 + 0.4 * glow);
    e.mats.fire.alpha = 1 - smooth(0.55, 1, t);

    // FUMAÇA: entra depois do clarão, sobe e se dissipa
    const sm = smooth(0.12, 0.4, t);
    for (const p of e.smoke) {
      const s = R * p.size * (0.4 + 1.1 * easeOut(t)) * sm;
      p.mesh.setEnabled(s > 0.5);
      p.mesh.scaling.setAll(Math.max(0.001, s));
      p.mesh.position.copyFrom(p.dir.scale(R * (0.25 + 0.75 * easeOut(t))));
    }
    e.mats.smoke.alpha = 0.85 * (1 - smooth(0.6, 1, t));

    // DESTROÇOS: voam para fora girando, em brasa no começo
    const fly = R * 1.5 * easeOut(t * 1.2);
    for (const d of e.debris) {
      d.mesh.position.copyFrom(d.dir.scale(fly));
      d.mesh.rotation.copyFrom(d.spin.scale(t * EXPLOSION_DURATION));
      d.mesh.scaling.setAll(R * d.size * (1 - smooth(0.75, 1, t)) + 0.001);
    }
    e.mats.debris.emissiveColor = new Color3(1, 0.5, 0.15).scale(1 - smooth(0.1, 0.5, t));

    // ONDA DE CHOQUE: abre rápido no plano do jogo e some em 0,6 da vida
    const ringS = R * (0.25 + 1.35 * easeOut(t / 0.6));
    e.ringS = ringS;
    e.ring.scaling.setAll(ringS);
    e.ring.setEnabled(t < 0.6);
    e.mats.ring.alpha = 0.9 * (1 - smooth(0.05, 0.6, t));
  }

  private dispose(e: Live): void {
    if (e.done) return;
    e.done = true;
    for (const p of e.smoke) { this.glow.removeExcludedMesh(p.mesh); p.mesh.dispose(); }
    for (const d of e.debris) { this.glow.removeExcludedMesh(d.mesh); d.mesh.dispose(); }
    this.glow.removeExcludedMesh(e.fire);
    e.core.dispose();
    e.fire.dispose();
    e.ring.dispose();
    for (const m of Object.values(e.mats)) m.dispose();
    e.root.dispose();
  }

  destroy(): void {
    for (const e of this.live) this.dispose(e);
    this.live = [];
    if (this.observer) this.scene.onBeforeCameraRenderObservable.remove(this.observer);
    this.observer = null;
  }
}
