/**
 * PlanetRenderer — Ceres como corpo SÓLIDO low poly (CeresMeshGenerator):
 * relevo craterado cinza, facetado como as rochas e iluminado pelo mesmo rig,
 * com as plataformas de construção escavadas como mesas planas. Construída
 * uma vez; por quadro só acompanha a origem flutuante — Ceres é ESTÁTICA
 * (não gira), porque as plataformas são pontos fixos do mapa onde as naves
 * pousam (shared/ceres.ts).
 */

import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { generateCeresMesh } from "./CeresMeshGenerator";
import { toScene } from "./coords";
import { ROCK_FRONT_REACH } from "./layers";

/**
 * Ambiente do regolito: o lado de sombra fica cinza-escuro NEUTRO, não preto.
 * Ceres fica fora do preenchimento e do rim do rig (CERES_EXCLUDED_LIGHTS):
 * o preenchimento é azul e o rim esverdeado, e nela os dois pintavam o lado
 * de sombra de azul saturado — Ceres é cinza de regolito, só a chave a molda.
 */
const CERES_AMBIENT = new Color3(0.4, 0.4, 0.41);
const CERES_EXCLUDED_LIGHTS = ["fillLight", "rimLight"];

export class PlanetRenderer {
  private scene: Scene;
  private glow: GlowLayer;
  private root: TransformNode | null = null;
  private body: Mesh | null = null;
  private material: StandardMaterial | null = null;
  /** z de cena de cada plataforma, por id (para o olho do cockpit pousado) */
  private platformLocalZ = new Map<string, number>();

  constructor(scene: Scene, glow: GlowLayer) {
    this.scene = scene;
    this.glow = glow;
  }

  /** Constrói Ceres a partir da semente do mundo. Chamar uma vez. */
  init(worldSeed: number): void {
    if (this.root) return;
    const data = generateCeresMesh(worldSeed);

    this.root = new TransformNode("ceres", this.scene);
    // a frente (o ponto mais perto da câmera) fica rente ao limite das rochas:
    // naves e efeitos, em z ≤ −318, sempre por cima (ver layers.ts)
    this.root.position.z = -ROCK_FRONT_REACH - data.minZ;

    const body = new Mesh("ceres_body", this.scene);
    const vd = new VertexData();
    vd.positions = flatten3(data.vertices);
    vd.normals = flatten3(data.normals);
    vd.colors = data.colors;
    vd.indices = data.triangles;
    vd.applyToMesh(body);
    body.isPickable = false;
    body.parent = this.root;

    const mat = new StandardMaterial("ceres_regolith", this.scene);
    mat.diffuseColor = Color3.White(); // a cor vem das facetas (cor de vértice)
    mat.ambientColor = CERES_AMBIENT;
    // sem brilho especular: em faceta chapada ele só denuncia o polígono
    mat.specularColor = Color3.Black();
    mat.backFaceCulling = false;
    body.material = mat;
    // nada que brilhe fica atrás de Ceres: fora do mapa de glow (ver o
    // mesmo raciocínio nas rochas, AsteroidRenderer)
    this.glow.addExcludedMesh(body);
    for (const name of CERES_EXCLUDED_LIGHTS) this.scene.getLightByName(name)?.excludedMeshes.push(body);

    this.body = body;
    this.material = mat;
    for (const p of data.platforms) this.platformLocalZ.set(p.id, p.z);
  }

  /** Posiciona Ceres (pos em coordenadas de render do jogo). Estática: sem giro. */
  tick(pos: { x: number; y: number }): void {
    if (!this.root) return;
    const p = toScene(pos.x, pos.y);
    this.root.position.x = p.x;
    this.root.position.y = p.y;
  }

  /** z de cena (mundo) do chão de uma plataforma de Ceres, ou null. */
  platformZ(id: string): number | null {
    const z = this.platformLocalZ.get(id);
    return z === undefined || !this.root ? null : this.root.position.z + z;
  }

  destroy(): void {
    if (this.body) {
      this.glow.removeExcludedMesh(this.body);
      this.body.dispose();
    }
    this.material?.dispose();
    this.root?.dispose();
    this.root = null;
    this.body = null;
    this.material = null;
    this.platformLocalZ.clear();
  }
}

function flatten3(vs: { x: number; y: number; z: number }[]): number[] {
  const out = new Array<number>(vs.length * 3);
  for (let i = 0; i < vs.length; i++) {
    out[i * 3] = vs[i].x;
    out[i * 3 + 1] = vs[i].y;
    out[i * 3 + 2] = vs[i].z;
  }
  return out;
}
