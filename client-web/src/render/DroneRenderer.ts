/**
 * DroneRenderer — drones de ração em voo (logistics.ts): quadricópteros
 * low poly — corpo octogonal, quatro braços com rotores e um contêiner
 * embaixo quando levam carga. Cor do dono (próprio / inimigo). Um mesh por
 * drone, criado quando ele aparece e descartado quando some.
 */

import type { Scene } from "@babylonjs/core/scene";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { toScene, toSceneAngle } from "./coords";
import { SHIP_LAYER_Z } from "./layers";

/** meia-envergadura do drone (mundo): pequeno, mas legível ao lado das naves */
const SPAN = 46;

interface Entry {
  root: TransformNode;
  body: Mesh;
  crate: Mesh;
}

/** Caixa (min/max) facetada, empilhada num VertexData. */
function box(pos: number[], idx: number[], x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
  const v = (x: number, y: number, z: number) => [x, y, z];
  const quads = [
    [v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)],
    [v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)],
    [v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1)],
    [v(x1, y1, z0), v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1)],
    [v(x0, y1, z0), v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1)],
    [v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0), v(x1, y0, z0)],
  ];
  for (const q of quads) {
    const base = pos.length / 3;
    for (const p of q) pos.push(...p);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

function meshOf(name: string, build: (pos: number[], idx: number[]) => void, scene: Scene): Mesh {
  const pos: number[] = [];
  const idx: number[] = [];
  build(pos, idx);
  const normals: number[] = [];
  VertexData.ComputeNormals(pos, idx, normals);
  const vd = new VertexData();
  vd.positions = pos;
  vd.indices = idx;
  vd.normals = normals;
  const m = new Mesh(name, scene);
  vd.applyToMesh(m);
  m.isPickable = false;
  return m;
}

export class DroneRenderer {
  private scene: Scene;
  private entries = new Map<string, Entry>();
  private ownMat: StandardMaterial;
  private enemyMat: StandardMaterial;
  private crateMat: StandardMaterial;

  constructor(scene: Scene) {
    this.scene = scene;
    const mat = (name: string, c: Color3, glow: number) => {
      const m = new StandardMaterial(name, scene);
      m.diffuseColor = c;
      m.emissiveColor = c.scale(glow);
      m.specularColor = Color3.Black();
      return m;
    };
    this.ownMat = mat("droneOwn", new Color3(0.45, 0.95, 0.6), 0.35);
    this.enemyMat = mat("droneEnemy", new Color3(1, 0.4, 0.35), 0.35);
    this.crateMat = mat("droneCrate", new Color3(0.85, 0.65, 0.3), 0.15);
  }

  /** Atualiza (cria se preciso) o drone `id` na posição de render (x, y). */
  update(id: string, x: number, y: number, angle: number, own: boolean, loaded: boolean): void {
    let e = this.entries.get(id);
    if (!e) {
      const root = new TransformNode(`drone_${id}`, this.scene);
      const body = meshOf(`drone_${id}_body`, (p, i) => {
        // corpo + quatro braços em X com os rotores nas pontas
        box(p, i, -0.28 * SPAN, 0.28 * SPAN, -0.28 * SPAN, 0.28 * SPAN, -0.16 * SPAN, 0.06 * SPAN);
        for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const x = 0.72 * SPAN * sx;
          const y = 0.72 * SPAN * sy;
          box(p, i, Math.min(0, x), Math.max(0, x), y * 0.1 - 0.05 * SPAN, y * 0.1 + 0.05 * SPAN, -0.1 * SPAN, -0.04 * SPAN);
          box(p, i, x - 0.24 * SPAN, x + 0.24 * SPAN, y - 0.24 * SPAN, y + 0.24 * SPAN, -0.14 * SPAN, -0.11 * SPAN);
        }
      }, this.scene);
      body.parent = root;
      const crate = meshOf(`drone_${id}_crate`, (p, i) => box(p, i, -0.22 * SPAN, 0.22 * SPAN, -0.22 * SPAN, 0.22 * SPAN, 0.06 * SPAN, 0.34 * SPAN), this.scene);
      crate.parent = root;
      crate.material = this.crateMat;
      e = { root, body, crate };
      this.entries.set(id, e);
    }
    e.body.material = own ? this.ownMat : this.enemyMat;
    e.crate.setEnabled(loaded);
    const p = toScene(x, y);
    e.root.position.set(p.x, p.y, SHIP_LAYER_Z - 4);
    e.root.rotation.z = toSceneAngle(angle);
  }

  /** Descarta os drones que não estão em `alive`. */
  retain(alive: ReadonlySet<string>): void {
    for (const [id, e] of this.entries) {
      if (alive.has(id)) continue;
      e.root.dispose();
      this.entries.delete(id);
    }
  }
}
