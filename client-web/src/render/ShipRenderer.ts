/**
 * ShipRenderer — gerencia as malhas de naves via MeshFactory.
 * Sem nenhum desenho próprio, sem lógica de jogo.
 * GameScene chama create() e update() — só isso (mesma API da era Phaser;
 * posições/ângulos chegam em coordenadas do JOGO e a conversão para cena
 * fica toda em render/coords.ts).
 */

import type { ShipKind } from "@ceres/shared";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MeshFactory, type ShipMeshInstance } from "./MeshFactory";
import { shipMeshData } from "./ShipMeshGenerator";
import { toScene, toSceneAngle } from "./coords";
import { SHIP_LAYER_Z, SHIP_TOP_LAYER_Z, MASK_MAIN_ONLY } from "./layers";

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
  private entries = new Map<string, MeshEntry>();
  /** id da nave destacada (própria) — reaplicado quando a malha é recriada */
  private topId: string | null = null;

  constructor(factory: MeshFactory) {
    this.factory = factory;
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
   */
  getCockpit(id: string): { root: TransformNode; eye: { x: number; y: number; z: number } } | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    return { root: entry.instance.root, eye: shipMeshData(entry.kind).eye };
  }

  private applyTop(instance: ShipMeshInstance): void {
    instance.setDepthBias(SHIP_TOP_LAYER_Z);
    // some da câmera de cockpit: as próprias linhas coladas no olho só sujam
    instance.setLayerMask(MASK_MAIN_ONLY);
  }

  /** Destrói todas as malhas. */
  destroy(): void {
    for (const { instance } of this.entries.values()) instance.dispose();
    this.entries.clear();
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
