/**
 * AsteroidRenderer — asteroides como malhas 3D SÓLIDAS (AsteroidMeshGenerator)
 * com flat shading facetado, mais duas linhas GreasedLine com glow por rocha:
 * o contorno da silhueta (identidade retrô) e o retângulo da plataforma de
 * construção integrada à geometria.
 *
 * A rocha inteira vive em z > 0 (atrás do plano de jogo): naves, estruturas e
 * efeitos continuam em z ≤ 0 e são desenhados por cima sem mudança de layer.
 * A iluminação vem de uma HemisphericLight própria — só afeta materiais
 * standard (as GreasedLine do resto do jogo têm shader próprio, imunes a luz).
 *
 * rebuild() reusa as entradas cujos ids persistem entre grids 3×3 (ao cruzar
 * um setor, 6 dos 9 setores são os mesmos — só reposiciona, sem regenerar).
 */

import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { CreateGreasedLine } from "@babylonjs/core/Meshes/Builders/greasedLineBuilder";
import type { GreasedLineBaseMesh } from "@babylonjs/core/Meshes/GreasedLine/greasedLineBaseMesh";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { asteroidSpinRate, mulberry32 } from "@ceres/shared";
import type { WorldPos } from "@ceres/shared";
import { ROCK_FRONT_REACH } from "./layers";
import { generateAsteroidMesh, type AsteroidBuildFace } from "./AsteroidMeshGenerator";
import { Palette } from "./Palette";
import { c3, disposeLineBundle } from "./lineUtils";
import { toScene, toSceneAngle } from "./coords";

/** Dados de um asteroide para o renderer. */
export interface AsteroidRenderData extends WorldPos {
  /** id estável (`sx:sy:i`) — nomeia a malha da instância */
  id: string;
  shapeSeed: number;
  radius: number;
  asteroidClass: "small" | "medium" | "large";
}

// const OUTLINE_PX = 2;
// const PAD_PX = 1.6;
// /** atenuação da cor da plataforma (linha secundária, como as crateras eram) */
// const PAD_DIM = 0.8;
// /** afastamento da linha da plataforma ao longo da normal (evita z-fight) */
// const PAD_LIFT = 3;
/** wireframe das facetas: branco atenuado, fino, SEM glow (hierarquia visual:
 * silhueta e plataforma são as linhas brilhantes; as arestas são textura) */
const WIRE_PX = 1.1;
const WIRE_DIM = 0.19;

/** sal da RNG do tombamento — sequência independente da forma e do spin Z */
const TUMBLE_SEED_XOR = 0x7c3a9e51;
/** velocidade angular máxima em X/Y (rad/s) — mesma ordem do spin Z (0.12) */
const TUMBLE_RATE_MAX = 0.11;
/** taxa do decaimento exponencial dos ângulos X/Y ao travar (≈1 s até ~0) */
const LOCK_DECAY = 3;

/** Tombamento contínuo em X/Y: velocidades por seed + ângulos integrados. */
interface Tumble {
  rateX: number;
  rateY: number;
  angleX: number;
  angleY: number;
}

interface AsteroidEntry {
  root: TransformNode;
  solid: Mesh;
  // outline: GreasedLineBaseMesh;
  // pad: GreasedLineBaseMesh;
  wire: GreasedLineBaseMesh;
  buildFace: AsteroidBuildFace;
  spin: number;
  tumble: Tumble;
  /** primeira atualização: se já nascer travado, começa plano (sem pop) */
  fresh: boolean;
}

export class AsteroidRenderer {
  /** posições de render para o minimapa */
  readonly nearbyPositions: Array<{ rx: number; ry: number; asteroidClass: string }> = [];

  private scene: Scene;
  private glow: GlowLayer;
  private entries = new Map<string, AsteroidEntry>();
  private rockMat: StandardMaterial;
  private light: HemisphericLight;

  constructor(scene: Scene, glow: GlowLayer) {
    this.scene = scene;
    this.glow = glow;

    // luz de leitura das facetas: levemente lateral para o shading variar
    // com o spin; groundColor escuro mantém o dorso quase preto (fundo CRT)
    this.light = new HemisphericLight("asteroidLight", new Vector3(-0.35, 0.45, -0.85).normalize(), scene);
    this.light.diffuse = new Color3(0.9, 0.95, 1);
    this.light.groundColor = new Color3(0.05, 0.06, 0.08);
    this.light.specular = Color3.Black();

    // material único compartilhado por todas as rochas (sem tint por dono)
    this.rockMat = new StandardMaterial("asteroidRock", scene);
    this.rockMat.diffuseColor = c3(Palette.asteroid.fill);
    this.rockMat.specularColor = Color3.Black();
    // normais calculadas no gerador apontam para fora; sem culling não há
    // como errar o winding — as faces do dorso perdem no teste de profundidade
    this.rockMat.backFaceCulling = false;
  }

  /** Reconstrói/reusa as malhas para o grid 3×3 de setores. */
  rebuild(asteroids: AsteroidRenderData[], toRender: (p: WorldPos) => { x: number; y: number }): void {
    const next = new Map<string, AsteroidEntry>();
    this.nearbyPositions.length = 0;

    for (const a of asteroids) {
      const pos = toRender(a);
      let entry = this.entries.get(a.id);
      if (entry) {
        // mesmo asteroide, possivelmente nova origem flutuante: só reposiciona
        this.entries.delete(a.id);
        const p = toScene(pos.x, pos.y);
        entry.root.position.x = p.x;
        entry.root.position.y = p.y;
      } else {
        entry = this.buildEntry(a, pos);
      }
      next.set(a.id, entry);
      this.nearbyPositions.push({ rx: pos.x, ry: pos.y, asteroidClass: a.asteroidClass });
    }

    for (const e of this.entries.values()) this.disposeEntry(e);
    this.entries = next;
  }

  /**
   * Rotação nos 3 eixos a cada frame (tt = tempo absoluto em segundos, dt =
   * passo do frame):
   * - Z: spin contínuo, SINCRONIZADO com o servidor (naves pousadas e
   *   estruturas giram junto) — ângulo absoluto, intocável;
   * - X/Y: velocidade angular contínua por seed, INTEGRADA por frame. Rochas
   *   em `locked` (com estrutura, pouso em andamento/pousado, ou alvo da
   *   zona de pouso) têm os ângulos X/Y decaídos suavemente a zero — o
   *   tombamento fora do plano dessincronizaria o pouso servidor-síncrono e
   *   viraria a plataforma (com as estruturas parentadas) para o lado oculto.
   *   Ao liberar, o tombo retoma de onde o decaimento deixou, sem pop.
   * O Euler do Babylon compõe Y·X·Z (Z primeiro): o spin do plano do jogo
   * roda primeiro e o tombo inclina o conjunto por cima, em eixos do mundo —
   * a projeção XY continua girando rigidamente com o servidor.
   */
  tick(tt: number, dt: number, locked: ReadonlySet<string>): void {
    for (const [id, e] of this.entries) {
      const t = e.tumble;
      if (locked.has(id)) {
        if (e.fresh) {
          t.angleX = 0;
          t.angleY = 0;
        } else {
          // decai o ângulo EQUIVALENTE (-π..π]: volta ao plano pelo caminho
          // curto, sem desenrolar revoluções acumuladas
          const k = Math.min(1, dt * LOCK_DECAY);
          t.angleX = wrapAngle(t.angleX) * (1 - k);
          t.angleY = wrapAngle(t.angleY) * (1 - k);
        }
      } else {
        t.angleX += t.rateX * dt;
        t.angleY += t.rateY * dt;
      }
      e.fresh = false;
      const r = e.root.rotation;
      r.x = t.angleX;
      r.y = t.angleY;
      r.z = toSceneAngle(e.spin * tt);
    }
  }

  /**
   * Plataforma de construção de um asteroide em cena (quadro local + root).
   * Anexar qualquer nó é `node.parent = root` + transformar pelo buildFace —
   * o spin do asteroide passa a valer de graça para o nó anexado.
   */
  getBuildFace(id: string): { root: TransformNode; face: AsteroidBuildFace } | null {
    const entry = this.entries.get(id);
    return entry ? { root: entry.root, face: entry.buildFace } : null;
  }

  destroy(): void {
    for (const e of this.entries.values()) this.disposeEntry(e);
    this.entries.clear();
    this.nearbyPositions.length = 0;
    this.rockMat.dispose();
    this.light.dispose();
  }

  private buildEntry(a: AsteroidRenderData, pos: { x: number; y: number }): AsteroidEntry {
    const data = generateAsteroidMesh(a.shapeSeed, a.radius, a.asteroidClass);

    const root = new TransformNode(`ast_${a.id}`, this.scene);
    const scenePos = toScene(pos.x, pos.y);
    root.position.x = scenePos.x;
    root.position.y = scenePos.y;

    // corpo sólido facetado
    const solid = new Mesh(`ast_${a.id}_rock`, this.scene);
    const vd = new VertexData();
    vd.positions = flatten3(data.vertices);
    vd.normals = flatten3(data.normals);
    vd.indices = data.triangles;
    vd.applyToMesh(solid);
    solid.material = this.rockMat;
    solid.isPickable = false;
    solid.parent = root;

    // contorno da silhueta — a linha fosforescente de sempre; a projeção XY
    // gira rigidamente com o root, então uma construção única basta
    // const outline = this.makeLine(
    //   `ast_${a.id}_outline`,
    //   [closeLoop(data.silhouette.map((p) => new Vector3(p.x, p.y, 0)))],
    //   OUTLINE_PX,
    //   c3(Palette.asteroid.line),
    // );
    // outline.parent = root;

    // retângulo da plataforma, sobre o plano da face (erguido pela normal)
    const f = data.buildFace;
    // const lift = f.normal.scale(PAD_LIFT);
    // const ex = f.tangent.scale(f.width / 2);
    // const ey = f.bitangent.scale(f.height / 2);
    // const corners = [
    //   f.center.add(ex).add(ey), f.center.subtract(ex).add(ey),
    //   f.center.subtract(ex).subtract(ey), f.center.add(ex).subtract(ey),
    // ].map((p) => p.add(lift));
    // const pad = this.makeLine(
    //   `ast_${a.id}_pad`,
    //   [closeLoop(corners)],
    //   PAD_PX,
    //   c3(Palette.asteroid.pad).scale(PAD_DIM),
    // );
    // pad.parent = root;

    // wireframe das facetas: as arestas vêm erguidas da superfície pelo
    // gerador — as do dorso perdem no teste de profundidade contra o corpo
    const wire = this.makeLine(
      `ast_${a.id}_wire`,
      data.wireEdges,
      WIRE_PX,
      c3(Palette.wire).scale(WIRE_DIM),
      false,
    );
    wire.parent = root;

    // recuo do orçamento de profundidade: sob QUALQUER rotação, nenhum ponto
    // da rocha avança além de −ROCK_FRONT_REACH (ver layers.ts)
    root.position.z = data.boundingRadius - ROCK_FRONT_REACH;

    // velocidades angulares por seed (sinal e módulo por eixo); ângulos
    // iniciais espalhados — cada rocha entra em cena numa pose própria
    const trng = mulberry32((a.shapeSeed ^ TUMBLE_SEED_XOR) >>> 0);
    const rate = () => (trng() * 2 - 1) * TUMBLE_RATE_MAX;
    const tumble: Tumble = {
      rateX: rate(),
      rateY: rate(),
      angleX: trng() * Math.PI * 2,
      angleY: trng() * Math.PI * 2,
    };

    return {
      root, solid, /*outline, pad,*/ wire, buildFace: f,
      spin: asteroidSpinRate(a.shapeSeed), tumble, fresh: true,
    };
  }

  /** GreasedLine em coordenadas LOCAIS DE CENA (não passa por lineUtils/coords). */
  private makeLine(
    name: string,
    points: Vector3[][],
    widthPx: number,
    color: Color3,
    glow = true,
  ): GreasedLineBaseMesh {
    const mesh = CreateGreasedLine(
      name,
      { points },
      { width: widthPx, sizeAttenuation: true, color },
      this.scene,
    ) as GreasedLineBaseMesh;
    if (glow) this.glow.referenceMeshToUseItsOwnMaterial(mesh);
    return mesh;
  }

  private disposeEntry(e: AsteroidEntry): void {
    // disposeLineBundle(e.outline, this.glow);
    //disposeLineBundle(e.pad, this.glow);
    disposeLineBundle(e.wire); // nunca entrou no glow
    e.solid.dispose(false, false); // material é compartilhado — não descartar
    // doNotRecurse: ESTRUTURAS são parentadas a este root pelo
    // StructureRenderer — elas sobrevivem à troca de grid e se reassentam
    // no root novo no upsert do frame seguinte
    e.root.dispose(true);
  }
}

const flatten3 = (vs: Vector3[]): number[] => {
  const out = new Array<number>(vs.length * 3);
  for (let i = 0; i < vs.length; i++) {
    out[i * 3] = vs[i].x;
    out[i * 3 + 1] = vs[i].y;
    out[i * 3 + 2] = vs[i].z;
  }
  return out;
};

/** normaliza um ângulo para (-π, π] */
const wrapAngle = (a: number): number => {
  const w = (a + Math.PI) % (Math.PI * 2);
  return (w < 0 ? w + Math.PI * 2 : w) - Math.PI;
};
