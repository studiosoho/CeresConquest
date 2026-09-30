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
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { SUN_SCREEN } from "./Lighting";
import { Palette } from "./Palette";
import { c3 } from "./lineUtils";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ceresPlatforms } from "@ceres/shared";
import { generateCeresMesh } from "./CeresMeshGenerator";
import type { AsteroidBuildFace } from "./AsteroidMeshGenerator";
import { toScene } from "./coords";
import { ROCK_FRONT_REACH } from "./layers";

/**
 * Ambiente do regolito: o lado de sombra fica cinza-escuro NEUTRO, não preto.
 * Ceres fica fora do preenchimento e do rim do rig (CERES_EXCLUDED_LIGHTS):
 * o preenchimento é azul e o rim esverdeado, e nela os dois pintavam o lado
 * de sombra de azul saturado — Ceres é cinza de regolito, só a chave a molda.
 */
const CERES_AMBIENT = new Color3(0.4, 0.4, 0.41);
const CERES_EXCLUDED_LIGHTS = ["fillLight", "rimLight", "keyLight"];
/**
 * Ceres tem LUZ PRÓPRIA: uma direcional vinda do sol. A chave do rig é
 * pontual, colada ao enquadramento e com alcance de ~18 000 u — boa para
 * rochas de 200–2000 u, mas numa esfera de 40 000 u a borda fica ~20 000 u
 * mais funda e caía no escuro. Direcional não atenua: é o sol distante de
 * verdade, e dá a Ceres um terminador de planeta, igual nas duas câmeras.
 * Direção: do ponto do sol na tela (SUN_SCREEN, um pouco à frente da cena)
 * para o centro.
 */
const CERES_SUN_DIR = new Vector3(-SUN_SCREEN.x, -SUN_SCREEN.y, 0.32).normalize();
const CERES_SUN_INTENSITY = 1.35;

export class PlanetRenderer {
  private scene: Scene;
  private glow: GlowLayer;
  private root: TransformNode | null = null;
  private body: Mesh | null = null;
  private material: StandardMaterial | null = null;
  private sun: DirectionalLight | null = null;
  /** z de cena de cada plataforma, por id (para o olho do cockpit pousado) */
  private platformLocalZ = new Map<string, number>();
  /** centro XY (cena, no quadro do root) e raio de cada plataforma */
  private platformXY = new Map<string, { x: number; y: number; radius: number }>();

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
    const sun = new DirectionalLight("ceresSun", CERES_SUN_DIR.clone(), this.scene);
    sun.diffuse = c3(Palette.light.key);
    sun.specular = Color3.Black();
    sun.intensity = CERES_SUN_INTENSITY;
    sun.includedOnlyMeshes = [body];
    this.sun = sun;

    this.body = body;
    this.material = mat;
    for (const p of data.platforms) this.platformLocalZ.set(p.id, p.z);
    for (const p of ceresPlatforms(worldSeed)) this.platformXY.set(p.id, { x: p.dx, y: -p.dy, radius: p.radius });
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

  /**
   * Face de construção de uma plataforma, no formato das rochas
   * (AsteroidRenderer.getBuildFace) mais a ÂNCORA: a estrutura fica no centro
   * da plataforma, não no do planeta. A mesa é horizontal (normal para a
   * câmera), e Ceres não gira — a estrutura parentada fica parada no mundo.
   */
  getBuildFace(id: string): { root: TransformNode; face: AsteroidBuildFace; anchor: { x: number; y: number } } | null {
    const z = this.platformLocalZ.get(id);
    const xy = this.platformXY.get(id);
    if (z === undefined || !xy || !this.root) return null;
    return {
      root: this.root,
      face: {
        center: new Vector3(xy.x, xy.y, z),
        normal: new Vector3(0, 0, -1),
        tangent: new Vector3(1, 0, 0),
        bitangent: new Vector3(0, -1, 0), // n × t, como nas rochas
        width: xy.radius * 2,
        height: xy.radius * 2,
      },
      anchor: { x: xy.x, y: xy.y },
    };
  }

  destroy(): void {
    if (this.body) {
      this.glow.removeExcludedMesh(this.body);
      this.body.dispose();
    }
    this.material?.dispose();
    this.sun?.dispose();
    this.sun = null;
    this.root?.dispose();
    this.root = null;
    this.body = null;
    this.material = null;
    this.platformLocalZ.clear();
    this.platformXY.clear();
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
