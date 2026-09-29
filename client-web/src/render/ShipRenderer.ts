/**
 * ShipRenderer — gerencia as malhas de naves via MeshFactory e aplica a
 * ESCALA DE EXIBIÇÃO. Sem lógica de jogo.
 * GameScene chama create() e update() — só isso (mesma API da era Phaser;
 * posições/ângulos chegam em coordenadas do JOGO e a conversão para cena
 * fica toda em render/coords.ts).
 *
 * ── ESCALA DE EXIBIÇÃO ────────────────────────────────────────────────
 * A escala do mundo é honesta e impiedosa: rochas de 200–2000 u de raio,
 * naves de ~40 u de comprimento. Na zoom de RTS (0.12) a nave tem ~5 px, e
 * nenhuma luz talha plano em 5 px — foi o "ponto branco achado só pelo anel
 * tracejado" de três vereditos. Crescer o casco no MUNDO mentiria sobre a
 * colisão (o círculo de SHIP_RADIUS é de outro território). Então só a MALHA
 * é inflada, por um fator FIXO por classe, e a física não sabe disso.
 *
 * O fator é fixo — não um piso em pixels — para que a nave ACOMPANHE O ZOOM,
 * como o resto do mundo: aproximar aumenta a nave na mesma proporção que as
 * rochas, e a razão nave/rocha fica constante. (Até aqui era um piso de tela:
 * na faixa de zoom do jogo ele sempre atuava, e a nave tinha o mesmo tamanho
 * em pixels em qualquer zoom.) O fator é o que dá N px de comprimento no zoom
 * de referência SHIP_DISPLAY_REF_ZOOM = 0.12, o quadro de julgamento — ali a
 * nave é exatamente a que foi aprovada; na faixa 0.10–0.25, de 0,83× a 2,1×.
 *
 * N = MIN_SHIP_PX = 44 px (ShipMeshGenerator) para a massa de referência (construtora), vezes
 * ∛massa por classe (massa ∝ volume, comprimento ∝ ∛volume): caça 41,
 * construtora 44, mineradora 49, cargueiro 60 px. Por que 44: o casco de
 * cumeeira/teto chato precisa de TRÊS planos distinguíveis na largura (água
 * acesa, teto ou cumeeira, água do rebote); a largura em planta é ~0,4 do
 * comprimento, então 44 px dão ~18 px de boca e ~6 px por plano — o mínimo em
 * que uma diferença de valor entre facetas sobrevive ao MSAA 2× e ao bloom. A
 * 36 px (medido na sonda offline) o teto da construtora caía para ~5 px e as
 * naves liam como pílulas contornadas. E fica abaixo da menor rocha no quadro
 * de julgamento (raio 200 u → 48 px de diâmetro a 0.12): a nave ainda é MENOR
 * que qualquer asteroide, só não some — e, com o fator fixo, isso vale em
 * qualquer zoom.
 *
 * POR CÂMERA: a escala é aplicada em `onBeforeCameraRenderObservable`, que o
 * Babylon dispara ANTES de avaliar as malhas ativas de cada câmera (o id de
 * render muda por câmera, então as matrizes de mundo são recalculadas). A
 * principal ortográfica vê a nave inflada; a de cockpit vê as outras naves
 * no tamanho REAL — uma nave a 300 u não pode ocupar metade do retrovisor.
 * O GlowLayer renderiza dentro do passe da principal, com a escala dela.
 */

import type { ShipKind } from "@ceres/shared";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { CreateDisc } from "@babylonjs/core/Meshes/Builders/discBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Observer } from "@babylonjs/core/Misc/observable";
import { MeshFactory, type ShipMeshInstance } from "./MeshFactory";
import { shipMeshData, shipFloorPx, SHIP_DISPLAY_REF_ZOOM } from "./ShipMeshGenerator";
import { toScene, toSceneAngle } from "./coords";
import { SHIP_LAYER_Z, SHIP_TOP_LAYER_Z, MASK_MAIN_ONLY } from "./layers";
import { ShipAB } from "./shipAB";

const KINDS: readonly ShipKind[] = ["builder", "mining", "attack", "transport"];

/** Dados mínimos que o renderer precisa de uma nave. */
export interface ShipRenderData {
  x: number;
  y: number;
  angle: number;
  kind: ShipKind;
  /** tint a aplicar na malha (cor de time/dono) */
  tint: number;
  visible: boolean;
  /**
   * Escala de exibição desta nave na câmera principal (ver shipPresence.ts:
   * menor na superfície, do tamanho da vaga pousada). Ausente = a da classe.
   */
  scale?: number;
  /** altitude aparente, 0..1: 1 = cruzeiro, com sombra; 0 = sem sombra */
  altitude?: number;
}

/** Opacidade da sombra de uma nave em cruzeiro. */
const SHADOW_ALPHA = 0.42;
/** Raio da sombra, em comprimentos do casco exibido. */
const SHADOW_RADIUS = 0.42;
/**
 * Deslocamento da sombra em altitude cheia, em comprimentos do casco exibido,
 * para baixo e à direita da tela (a luz-chave fica no alto, à esquerda): é o
 * afastamento entre nave e sombra que lê como altura.
 */
const SHADOW_OFFSET = 0.55;
/** Sombra atrás do casco e à frente das rochas (ver layers.ts). */
const SHADOW_Z = SHIP_LAYER_Z + 3;

interface MeshEntry {
  instance: ShipMeshInstance;
  kind: ShipKind;
  visible: boolean;
  /** escala de exibição desta nave (ver ShipRenderData.scale) */
  scale: number | undefined;
  altitude: number;
}

export class ShipRenderer {
  private factory: MeshFactory;
  private camera: Camera;
  private entries = new Map<string, MeshEntry>();
  /** id da nave destacada (própria) — reaplicado quando a malha é recriada */
  private topId: string | null = null;
  private observer: Observer<Camera> | null;
  /** escala de exibição por classe na câmera principal (fixa: acompanha o zoom) */
  private scaleByKind = {} as Record<ShipKind, number>;
  /** última versão das chaves de A/B aplicada (shipAB.ts) */
  private abVersion = 0;
  /** sombras de todas as naves: um disco, uma thin instance por nave no ar */
  private shadow: Mesh;
  private shadowMatrices = new Float32Array(16 * 64);

  /** `camera` = a câmera PRINCIPAL ortográfica (a de cockpit fica em escala 1) */
  constructor(factory: MeshFactory, camera: Camera, glow: GlowLayer) {
    this.factory = factory;
    this.camera = camera;
    const scene = camera.getScene();
    this.shadow = CreateDisc("shipShadows", { radius: 1, tessellation: 28 }, scene);
    const mat = new StandardMaterial("shipShadowMat", scene);
    mat.disableLighting = true;
    mat.emissiveColor = Color3.Black();
    mat.alpha = SHADOW_ALPHA;
    mat.backFaceCulling = false;
    this.shadow.material = mat;
    this.shadow.isPickable = false;
    this.shadow.layerMask = MASK_MAIN_ONLY;
    this.shadow.alwaysSelectAsActiveMesh = true;
    glow.addExcludedMesh(this.shadow);
    this.shadow.thinInstanceSetBuffer("matrix", this.shadowMatrices, 16, false);
    this.shadow.thinInstanceCount = 0;
    // px por unidade é o próprio zoom (o frustum ortográfico é tela ÷ zoom)
    for (const k of KINDS) {
      this.scaleByKind[k] = Math.max(1, shipFloorPx(k) / (shipMeshData(k).length * SHIP_DISPLAY_REF_ZOOM));
    }
    this.observer = camera.getScene().onBeforeCameraRenderObservable.add((cam) => this.applyScreenScale(cam));
  }

  /**
   * Cria (ou recria se o kind mudou) a malha para a nave com o id dado.
   * Deve ser chamado quando a nave aparece ou troca de classe.
   */
  create(id: string, data: ShipRenderData): void {
    const existing = this.entries.get(id);
    if (existing && existing.kind === data.kind) {
      this.applyData(existing, data);
      return;
    }
    existing?.instance.dispose();

    const instance = this.factory.createShip(data.kind, data.tint);
    // camada de voo: à frente do pior avanço de uma rocha em balanço
    instance.setDepthBias(SHIP_LAYER_Z);
    const entry: MeshEntry = { instance, kind: data.kind, visible: true, scale: undefined, altitude: 0 };
    this.entries.set(id, entry);
    // troca de classe recria a malha — o destaque de nave própria persiste
    if (id === this.topId) this.applyTop(instance);
    instance.setPartsVisible(ShipAB.hull, ShipAB.livery);
    this.applyData(entry, data);
  }

  /**
   * Atualiza posição, rotação, tint e visibilidade da malha.
   * Recria a malha se o kind mudou (troca de nave no hangar).
   */
  update(id: string, data: ShipRenderData): void {
    const entry = this.entries.get(id);
    if (!entry || entry.kind !== data.kind) {
      this.create(id, data);
      return;
    }
    this.applyData(entry, data);
  }

  /** Remove a malha de uma nave que saiu do mundo. */
  remove(id: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.instance.dispose();
      this.entries.delete(id);
    }
  }

  /** Destaca a nave (própria) por cima das demais. */
  bringToTop(id: string): void {
    this.topId = id;
    const instance = this.entries.get(id)?.instance;
    if (instance) this.applyTop(instance);
  }

  /**
   * Ponto de vista do cockpit da nave: nó raiz (para parentar a câmera de
   * primeira pessoa) + posição do olho no quadro local, conforme a classe.
   * O root é o nó de POSE, nunca escalado — o olho é sempre o de mundo.
   */
  getCockpit(id: string): { root: TransformNode; eye: { x: number; y: number; z: number } } | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    return { root: entry.instance.root, eye: shipMeshData(entry.kind).eye };
  }

  /**
   * Escala de exibição da classe na câmera principal (1 = mundo). Fica
   * exposta para quem desenha preso ao casco (jato, feixe) poder acompanhar
   * a malha inflada em vez de sumir debaixo dela.
   */
  screenScale(kind: ShipKind): number {
    return this.scaleByKind[kind];
  }

  /** Escala de exibição corrente DESTA nave (a da classe, se não houver uma própria). */
  displayScale(id: string, kind: ShipKind): number {
    return this.entries.get(id)?.scale ?? this.scaleByKind[kind];
  }

  private applyTop(instance: ShipMeshInstance): void {
    instance.setDepthBias(SHIP_TOP_LAYER_Z);
    // some da câmera de cockpit: o próprio casco colado no olho só suja
    instance.setLayerMask(MASK_MAIN_ONLY);
  }

  /** Destrói todas as malhas. */
  destroy(): void {
    if (this.observer) {
      this.camera.getScene().onBeforeCameraRenderObservable.remove(this.observer);
      this.observer = null;
    }
    for (const { instance } of this.entries.values()) instance.dispose();
    this.entries.clear();
    this.shadow.material?.dispose();
    this.shadow.dispose();
  }

  /**
   * Escala por passe de câmera: a principal vê a malha inflada pelo fator
   * fixo da classe; a de cockpit, no tamanho de mundo.
   */
  private applyScreenScale(cam: Camera): void {
    if (cam === this.camera) {
      if (ShipAB.version !== this.abVersion) {
        this.abVersion = ShipAB.version;
        for (const e of this.entries.values()) e.instance.setPartsVisible(ShipAB.hull, ShipAB.livery);
      }
      for (const e of this.entries.values()) e.instance.setScreenScale(e.scale ?? this.scaleByKind[e.kind]);
      this.updateShadows();
    } else if (ShipAB.perCameraScale) {
      for (const e of this.entries.values()) e.instance.setScreenScale(1);
    }
  }

  private applyData(entry: MeshEntry, data: ShipRenderData): void {
    const { instance } = entry;
    const p = toScene(data.x, data.y);
    instance.root.position.x = p.x;
    instance.root.position.y = p.y;
    instance.root.rotation.z = toSceneAngle(data.angle);
    instance.setTint(data.tint);
    entry.scale = data.scale;
    entry.altitude = data.altitude ?? 0;
    if (entry.visible !== data.visible) {
      entry.visible = data.visible;
      instance.setVisible(data.visible);
    }
  }

  /**
   * Uma sombra por nave visível com altitude: disco escuro sob o casco,
   * deslocado para baixo e à direita tanto mais quanto mais alto ela voa, e
   * encolhendo junto na descida — some quando ela chega à superfície.
   */
  private updateShadows(): void {
    let n = 0;
    let grew = false;
    for (const e of this.entries.values()) {
      if (!e.visible || e.altitude <= 0.01) continue;
      if ((n + 1) * 16 > this.shadowMatrices.length) {
        const grown = new Float32Array(this.shadowMatrices.length * 2);
        grown.set(this.shadowMatrices);
        this.shadowMatrices = grown;
        grew = true;
      }
      const len = shipMeshData(e.kind).length * (e.scale ?? this.scaleByKind[e.kind]);
      const r = SHADOW_RADIUS * len * (0.6 + 0.4 * e.altitude);
      const off = SHADOW_OFFSET * len * e.altitude;
      const p = e.instance.root.position;
      const m = this.shadowMatrices;
      const o = n * 16;
      m.fill(0, o, o + 16);
      m[o] = r;
      m[o + 5] = r;
      m[o + 10] = 1;
      // para baixo e à direita da tela: +x e −y de cena
      m[o + 12] = p.x + off;
      m[o + 13] = p.y - off;
      m[o + 14] = SHADOW_Z;
      m[o + 15] = 1;
      n++;
    }
    // o buffer só é recriado quando cresce; no mais, atualizado no lugar
    if (grew) this.shadow.thinInstanceSetBuffer("matrix", this.shadowMatrices, 16, false);
    else this.shadow.thinInstanceBufferUpdated("matrix");
    this.shadow.thinInstanceCount = n;
  }
}
