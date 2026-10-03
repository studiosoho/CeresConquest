/**
 * BeamRenderer — traço do laser em 3D, para a câmera de COCKPIT.
 *
 * Na vista de cima o traço é uma linha (EffectsRenderer.drawLaser) no plano
 * dos efeitos; de lado, na perspectiva do cockpit, aquela linha de 2 u some.
 * Aqui cada feixe é um prisma fino e luminoso entre dois pontos 3D (o canhão
 * e o alvo, cada um na sua altura), só na máscara do cockpit.
 *
 * Pool por quadro, como o LinePool: begin(), beam() por feixe, end().
 */

import type { Scene } from "@babylonjs/core/scene";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Palette } from "./Palette";
import { c3 } from "./lineUtils";
import { MASK_FP_ONLY } from "./layers";

/** espessura do feixe no ALVO (u): legível a milhares de u no cockpit */
const BEAM_WIDTH = 14;
/**
 * Na boca do canhão o feixe é bem mais fino (fração de BEAM_WIDTH) e começa
 * BEAM_MUZZLE u à frente: o canhão fica colado ao olho do cockpit, e um prisma
 * reto de 14 u ali enchia a tela de branco.
 */
const BEAM_START_FRACTION = 0.08;
const BEAM_MUZZLE = 40;

/** Tronco de pirâmide ao longo de +X (0..1): seção 1×1 no fim, afinada no começo. */
function unitBeam(): VertexData {
  const a = 0.5 * BEAM_START_FRACTION;
  const p = [
    [0, -a, -a], [1, -0.5, -0.5], [1, 0.5, -0.5], [0, a, -a],
    [0, -a, a], [1, -0.5, 0.5], [1, 0.5, 0.5], [0, a, a],
  ];
  const quads = [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [3, 2, 6, 7], [1, 5, 6, 2], [0, 3, 7, 4]];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const q of quads) {
    const base = positions.length / 3;
    for (const i of q) positions.push(...p[i]);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = normals;
  return vd;
}

export class BeamRenderer {
  private scene: Scene;
  private pool: Array<{ mesh: Mesh; mat: StandardMaterial }> = [];
  private used = 0;
  private geo = unitBeam();
  private q = new Quaternion();

  constructor(scene: Scene) {
    this.scene = scene;
  }

  begin(): void {
    this.used = 0;
  }

  /** Um feixe de `from` a `to` (cena), sumindo conforme `fade` (0 = aceso, 1 = apagado). */
  beam(from: Vector3, to: Vector3, fade: number): void {
    const full = to.subtract(from);
    const fullLen = full.length();
    if (fullLen < BEAM_MUZZLE * 2) return;
    const start = from.add(full.scale(BEAM_MUZZLE / fullLen));
    const d = to.subtract(start);
    const len = d.length();
    let slot = this.pool[this.used];
    if (!slot) {
      const mesh = new Mesh(`laserBeam_${this.pool.length}`, this.scene);
      this.geo.applyToMesh(mesh);
      mesh.isPickable = false;
      mesh.layerMask = MASK_FP_ONLY;
      const mat = new StandardMaterial(`laserBeam_${this.pool.length}`, this.scene);
      mat.disableLighting = true;
      mat.emissiveColor = c3(Palette.fx.laser);
      mat.backFaceCulling = false;
      mesh.material = mat;
      mesh.rotationQuaternion = new Quaternion();
      slot = { mesh, mat };
      this.pool.push(slot);
    }
    this.used++;
    const { mesh, mat } = slot;
    mesh.setEnabled(true);
    mesh.position.copyFrom(start);
    Quaternion.FromUnitVectorsToRef(Vector3.Right(), d.scale(1 / len), this.q);
    mesh.rotationQuaternion!.copyFrom(this.q);
    // afina e apaga junto
    const w = BEAM_WIDTH * (1 - 0.6 * fade);
    mesh.scaling.set(len, w, w);
    mat.alpha = 1 - fade;
  }

  end(): void {
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].mesh.setEnabled(false);
  }
}
