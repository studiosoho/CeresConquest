/**
 * ShipRenderer — gerencia as malhas de naves via MeshFactory e aplica o
 * TAMANHO MÍNIMO EM TELA. Sem lógica de jogo.
 * GameScene chama create() e update() — só isso (mesma API da era Phaser;
 * posições/ângulos chegam em coordenadas do JOGO e a conversão para cena
 * fica toda em render/coords.ts).
 *
 * ── PISO DE TELA ──────────────────────────────────────────────────────
 * A escala do mundo é honesta e impiedosa: rochas de 200–2000 u de raio,
 * naves de ~40 u de comprimento. Na zoom de RTS (0.12) a nave tem ~5 px, e
 * nenhuma luz talha plano em 5 px — foi o "ponto branco achado só pelo anel
 * tracejado" de três vereditos. Crescer o casco no MUNDO mentiria sobre a
 * colisão (o círculo de SHIP_RADIUS é de outro território). A prática de RTS
 * é um piso em ESPAÇO DE TELA: a malha escala para nunca ficar abaixo de N px
 * de comprimento, e a física não sabe disso.
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
 * que qualquer asteroide, só não some.
 * Em zoom de perto (≥ ~1.1) o piso não atua e a nave é do tamanho de mundo.
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
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Observer } from "@babylonjs/core/Misc/observable";
import { MeshFactory, type ShipMeshInstance } from "./MeshFactory";
import { shipMeshData, shipFloorPx } from "./ShipMeshGenerator";
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
}

interface MeshEntry {
  instance: ShipMeshInstance;
  kind: ShipKind;
  visible: boolean;
}

export class ShipRenderer {
  private factory: MeshFactory;
  private camera: Camera;
  private entries = new Map<string, MeshEntry>();
  /** id da nave destacada (própria) — reaplicado quando a malha é recriada */
  private topId: string | null = null;
  private observer: Observer<Camera> | null;
  /** escala de tela corrente por classe (recalculada a cada passe da principal) */
  private scaleByKind = {} as Record<ShipKind, number>;
  /** última versão das chaves de A/B aplicada (shipAB.ts) */
  private abVersion = 0;

  /** `camera` = a câmera PRINCIPAL ortográfica (a de cockpit fica em escala 1) */
  constructor(factory: MeshFactory, camera: Camera) {
    this.factory = factory;
    this.camera = camera;
    for (const k of KINDS) this.scaleByKind[k] = 1;
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
    const entry: MeshEntry = { instance, kind: data.kind, visible: true };
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
   * Escala de tela corrente da classe na câmera principal (1 = mundo). Fica
   * exposta para quem desenha preso ao casco (jato, feixe) poder acompanhar
   * a malha inflada em vez de sumir debaixo dela.
   */
  screenScale(kind: ShipKind): number {
    return this.scaleByKind[kind];
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
  }

  /**
   * Piso de tela por passe de câmera. Px por unidade sai do próprio frustum
   * ortográfico (altura do alvo ÷ altura do volume) — é o zoom efetivo, sem
   * GameScene ter de repassá-lo. `getRenderHeight(true)`: neste ponto o alvo
   * ligado é o RTT do pipeline, e o que interessa é a tela.
   */
  private applyScreenScale(cam: Camera): void {
    if (cam === this.camera) {
      if (ShipAB.version !== this.abVersion) {
        this.abVersion = ShipAB.version;
        for (const e of this.entries.values()) e.instance.setPartsVisible(ShipAB.hull, ShipAB.livery);
      }
      const top = cam.orthoTop, bottom = cam.orthoBottom;
      const span = top != null && bottom != null ? top - bottom : 0;
      const ppu = span > 0 ? (cam.getEngine().getRenderHeight(true) * cam.viewport.height) / span : 0;
      for (const k of KINDS) {
        const floorPx = shipFloorPx(k);
        const px = shipMeshData(k).length * ppu;
        this.scaleByKind[k] = px > 0 ? Math.max(1, floorPx / px) : 1;
      }
      for (const e of this.entries.values()) e.instance.setScreenScale(this.scaleByKind[e.kind]);
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
    if (entry.visible !== data.visible) {
      entry.visible = data.visible;
      instance.setVisible(data.visible);
    }
  }
}
