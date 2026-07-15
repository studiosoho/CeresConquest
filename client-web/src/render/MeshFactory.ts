/**
 * MeshFactory — constrói instâncias de malha por classe de nave. A geometria
 * vem do ShipMeshGenerator: módulos 3D comuns (capturados do protótipo de
 * arte do visualizador) montados por classe e reduzidos às ARESTAS DE
 * FEIÇÃO, já no espaço de cena. Cada nave é UMA GreasedLine com todos os
 * segmentos (largura constante em px de tela) e material próprio com a cor
 * do dono — 1 malha, 1 material, 1 draw call e 1 referência de glow por
 * nave. Os pontos ficam cacheados por classe (Vector3 compartilhados;
 * o CreateGreasedLine copia para os buffers da malha).
 *
 * Sem conhecer entidades, multiplayer ou lógica de jogo.
 */

import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { CreateGreasedLine } from "@babylonjs/core/Meshes/Builders/greasedLineBuilder";
import type { GreasedLineBaseMesh } from "@babylonjs/core/Meshes/GreasedLine/greasedLineBaseMesh";
import type { ShipKind } from "@ceres/shared";
import { shipMeshData } from "./ShipMeshGenerator";

/** largura das arestas em PIXELS DE TELA (sizeAttenuation) */
const EDGE_PX = 1.5;

const c3 = (hex: number) =>
  new Color3(((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255);

/** Uma nave instanciada em cena: uma malha única — transform, cor e glow. */
export class ShipMeshInstance {
  /** nó raiz para transform — a própria malha */
  readonly root: TransformNode;
  private lastTint = -1;

  constructor(
    private mesh: GreasedLineBaseMesh,
    //private glow: GlowLayer,
  ) {
    this.root = mesh;
  }

  setTint(tint: number): void {
    if (tint === this.lastTint) return;
    this.lastTint = tint;
    this.mesh.greasedLineMaterial!.color = c3(tint);
  }

  setVisible(visible: boolean): void {
    this.root.setEnabled(visible);
  }

  /** Desloca a instância em Z (mais perto da câmera = por cima). */
  setDepthBias(z: number): void {
    this.root.position.z = z;
  }

  /** Máscara de camada (visibilidade por câmera — ver render/layers.ts). */
  setLayerMask(mask: number): void {
    this.mesh.layerMask = mask;
  }

  dispose(): void {
    // disciplina de dispose: glow, malha E material — senão vaza GPU
    //this.glow.unReferenceMeshFromUsingItsOwnMaterial(this.mesh);
    this.mesh.dispose(false, true);
  }
}

export class MeshFactory {
  private scene: Scene;
  private glow: GlowLayer;
  private pointCache = new Map<ShipKind, Vector3[][]>();
  private nextId = 0;

  constructor(scene: Scene, glow: GlowLayer) {
    this.scene = scene;
    this.glow = glow;
  }

  /** Cria uma instância de nave: malha única com material próprio (tint). */
  createShip(kind: ShipKind, tint: number): ShipMeshInstance {
    const mesh = CreateGreasedLine(
      `ship_${kind}_${this.nextId++}`,
      { points: this.shipPoints(kind) },
      { width: EDGE_PX, sizeAttenuation: true },
      this.scene,
    ) as GreasedLineBaseMesh;
    this.glow.referenceMeshToUseItsOwnMaterial(mesh);

    const instance = new ShipMeshInstance(mesh/*, this.glow*/);
    instance.setTint(tint);
    return instance;
  }

  /** Segmentos de aresta por classe como polilinhas — computados uma vez. */
  private shipPoints(kind: ShipKind): Vector3[][] {
    let pts = this.pointCache.get(kind);
    if (!pts) {
      const { segments } = shipMeshData(kind);
      pts = [];
      for (let i = 0; i < segments.length; i += 6) {
        pts.push([
          new Vector3(segments[i], segments[i + 1], segments[i + 2]),
          new Vector3(segments[i + 3], segments[i + 4], segments[i + 5]),
        ]);
      }
      this.pointCache.set(kind, pts);
    }
    return pts;
  }
}
