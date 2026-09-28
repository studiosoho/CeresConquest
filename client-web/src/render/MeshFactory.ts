/**
 * MeshFactory — constrói instâncias de nave a partir da geometria POR CLASSE
 * do ShipMeshGenerator: casco e divisa do dono, ambos iluminados pelo rig.
 *
 * TUDO INSTANCIADO, NADA POR NAVE. As duas camadas são malhas-fonte por
 * classe (invisíveis) e cada nave é um InstancedMesh de cada uma. O Babylon
 * agrupa as instâncias ativas de uma fonte num único draw — o custo em draws
 * é ≤ 2 camadas × 4 classes por câmera, com 1 ou 100 naves.
 *
 * NADA DAS NAVES NO GLOWLAYER. Medido por A/B (R3, 31 naves, frame 12,18 ms):
 * a camada de luzes (navegação, janelas, pluma) custava 0,86 ms e a presença
 * dela no GlowLayer mais 0,98 ms — ~1,84 ms por pontinhos de 1–2 px que o
 * cego ainda leu como interface — contra 0,19 ms do casco inteiro. A camada
 * saiu (R4). O EffectLayer desenha TODA malha ativa no mapa dele, emissiva ou
 * não, então casco e divisa são EXCLUÍDOS explicitamente (escreveriam preto
 * pagando draw). As exclusões são por malha-FONTE (o EffectLayer testa
 * `subMesh.getRenderingMesh()`), valem para todas as naves da classe.
 * O ponto quente do motor mora na cabeça do rastro (ShipTrails, aditivo).
 *
 * HIERARQUIA POR NAVE: `root` (pose de jogo: posição, guinada, camada Z —
 * NUNCA escalado, porque a câmera de cockpit e o farol são filhos dele e uma
 * escala no pai deformaria a matriz de vista) → `visual` (escala de TELA,
 * ver ShipRenderer) → casco, divisa.
 *
 * Sem conhecer entidades, multiplayer ou lógica de jogo.
 */

import type { Scene } from "@babylonjs/core/scene";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
// efeito colateral: registra createInstance/registerInstancedBuffer no Mesh
import "@babylonjs/core/Meshes/instancedMesh";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { ShipKind } from "@ceres/shared";
import { shipMeshData, type SolidData } from "./ShipMeshGenerator";
import { Palette } from "./Palette";

/**
 * IDENTIDADE DO DONO (R5): a fita-contorno saiu — o cego a leu como "contorno
 * de sprite, adesivo colado", porque é igual em volta toda e não depende da
 * luz. O dono agora é a DIVISA pintada no dorso (ver `chevron` no gerador):
 * material ILUMINADO, albedo = Palette.ship.livery × cor do dono. Acende na
 * água da chave e apaga na de sombra junto com o casco — é pintura, não
 * interface. Branca e clara na nave própria, verde na frota, cinza-azulada
 * (quase o casco) nas alheias.
 */
const c3 = (hex: number) =>
  new Color3(((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255);

/** Uma nave em cena: pose, escala de tela e cor de dono. */
export class ShipMeshInstance {
  /** nó de pose (posição/guinada/camada) — pai do cockpit, nunca escalado */
  readonly root: TransformNode;
  private lastTint = -1;
  private lastScale = 1;
  private readonly liveryColor = new Color4(1, 1, 1, 1);

  constructor(
    root: TransformNode,
    private visual: TransformNode,
    private hull: InstancedMesh,
    private livery: InstancedMesh,
    /** ventre da classe (+Z de cena), ver `setScreenScale` */
    private belly: number,
  ) {
    this.root = root;
    livery.instancedBuffers[VertexBuffer.ColorInstanceKind] = this.liveryColor;
  }

  /** Cor do dono: só na divisa. O casco é neutro para todos (ver gerador). */
  setTint(tint: number): void {
    if (tint === this.lastTint) return;
    this.lastTint = tint;
    const t = c3(tint);
    this.liveryColor.set(t.r, t.g, t.b, 1);
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
    this.hull.layerMask = mask;
    this.livery.layerMask = mask;
  }

  /**
   * Escala uniforme da parte VISUAL (1 = tamanho de mundo). O ventre é
   * mantido no z em que estaria em escala 1: a nave inflada cresce PARA A
   * CÂMERA, e nenhum ponto dela entra na faixa das rochas (−ROCK_FRONT_REACH,
   * layers.ts) — senão a borda de baixo do casco seria cortada pela rocha
   * sobre a qual ela voa.
   */
  setScreenScale(s: number): void {
    if (s === this.lastScale) return;
    this.lastScale = s;
    this.visual.scaling.setAll(s);
    this.visual.position.z = -this.belly * (s - 1);
  }

  /** Visibilidade por camada (chaves de A/B de custo — ver shipAB.ts). */
  setPartsVisible(hull: boolean, livery: boolean): void {
    this.hull.isVisible = hull;
    this.livery.isVisible = livery;
  }

  dispose(): void {
    // só instâncias e nós: fontes e materiais são da classe e ficam
    this.root.dispose(false, false);
  }
}

interface KindSources {
  hull: Mesh;
  livery: Mesh;
  belly: number;
}

export class MeshFactory {
  private scene: Scene;
  private glow: GlowLayer;
  private sources = new Map<ShipKind, KindSources>();
  private mats: { hull: StandardMaterial; livery: StandardMaterial } | null = null;
  private nextId = 0;

  constructor(scene: Scene, glow: GlowLayer) {
    this.scene = scene;
    this.glow = glow;
  }

  /** Cria uma instância de nave (instâncias das fontes da classe). */
  createShip(kind: ShipKind, tint: number): ShipMeshInstance {
    const src = this.sourcesFor(kind);
    const id = this.nextId++;

    const root = new TransformNode(`ship_${kind}_${id}`, this.scene);
    const visual = new TransformNode(`ship_${kind}_${id}_vis`, this.scene);
    visual.parent = root;

    const inst = (m: Mesh, part: string): InstancedMesh => {
      const i = m.createInstance(`ship_${kind}_${id}_${part}`);
      i.parent = visual;
      i.isPickable = false;
      return i;
    };
    const instance = new ShipMeshInstance(root, visual, inst(src.hull, "hull"), inst(src.livery, "livery"), src.belly);
    instance.setTint(tint);
    return instance;
  }

  /** Fontes da classe — construídas uma vez. */
  private sourcesFor(kind: ShipKind): KindSources {
    let src = this.sources.get(kind);
    if (src) return src;
    const data = shipMeshData(kind);
    const mats = this.materials();

    const hull = solidMesh(`shipSrc_${kind}_hull`, data.hull, this.scene);
    hull.material = mats.hull;
    this.glow.addExcludedMesh(hull);
    // O farol da nave própria (SpotLight de GameScene, parenteado à cabine)
    // fica FORA dos cascos: ele existe para a vista do cockpit enxergar as
    // rochas; nos cascos ele lavava de azul-branco a proa da própria nave
    // inflada e qualquer nave até 2000 u à frente. Por nome porque a luz é de
    // GameScene; ausente, não faz nada.
    this.scene.getLightByName("headlight")?.excludedMeshes.push(hull);

    const livery = solidMesh(`shipSrc_${kind}_livery`, data.livery, this.scene);
    livery.material = mats.livery;
    // cor de dono por instância: o shader padrão multiplica `instanceColor`
    // na cor de vértice (vertexColorMixing) — um material só para todas
    livery.registerInstancedBuffer(VertexBuffer.ColorInstanceKind, 4);
    livery.instancedBuffers[VertexBuffer.ColorInstanceKind] = new Color4(1, 1, 1, 1);
    this.glow.addExcludedMesh(livery);
    this.scene.getLightByName("headlight")?.excludedMeshes.push(livery);

    src = { hull, livery, belly: data.belly };
    this.sources.set(kind, src);
    return src;
  }

  private materials(): { hull: StandardMaterial; livery: StandardMaterial } {
    if (this.mats) return this.mats;

    // CASCO: o difuso É o albedo de referência e a cor de vértice é a razão
    // de cada peça sobre ele. Não é detalhe: o shader padrão faz
    // `clamp(luz · difuso, 0, 1) · corDeVértice`; com o albedo na cor de
    // vértice e difuso branco, a luz saturava em 1 e as águas acesa e de topo
    // saíam IGUAIS (o casco "chapado" da R1). Sem especular (o rig não tem, e
    // lampejo em faceta chapada denuncia polígono), sem culling (a conversão
    // de quadro espelha Z; as normais já apontam para fora).
    const hull = new StandardMaterial("shipHullMat", this.scene);
    hull.diffuseColor = c3(Palette.ship.hull);
    hull.specularColor = Color3.Black();
    hull.emissiveColor = Color3.Black();
    hull.backFaceCulling = false;
    // TOM DO AMBIENTE (R5: "o cinza é neutro contra um fundo azul-petróleo"):
    // piso aditivo pequeno e FRIO, pelo canal de ambiente (a cena liga
    // `ambientColor` branco em Lighting.ts; só quem pede piso recebe). Tinge
    // a água de sombra de petróleo sem levantá-la até o valor do céu — a
    // separação do fundo é trabalho do flanco realçado (EDGE_BOOST), não daqui.
    hull.ambientColor = c3(Palette.ship.ambient);

    // DIVISA: tinta iluminada; difuso = albedo da tinta, cor de vértice
    // branca × cor do dono por instância (mesma álgebra do casco)
    const livery = new StandardMaterial("shipLiveryMat", this.scene);
    livery.diffuseColor = c3(Palette.ship.livery);
    livery.specularColor = Color3.Black();
    livery.emissiveColor = Color3.Black();
    livery.ambientColor = c3(Palette.ship.ambient);
    livery.backFaceCulling = false;

    this.mats = { hull, livery };
    return this.mats;
  }
}

/** Malha-fonte invisível (só as instâncias desenham) a partir de SolidData. */
function solidMesh(name: string, s: SolidData, scene: Scene): Mesh {
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = s.positions;
  vd.normals = s.normals;
  vd.colors = s.colors;
  vd.indices = s.indices;
  vd.applyToMesh(mesh);
  mesh.isVisible = false;
  mesh.isPickable = false;
  return mesh;
}
