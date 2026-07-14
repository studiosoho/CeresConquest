/**
 * ShipRenderer — gerencia as malhas de naves via MeshFactory.
 * Sem nenhum desenho próprio, sem lógica de jogo.
 * GameScene chama create() e update() — só isso (mesma API da era Phaser;
 * posições/ângulos chegam em coordenadas do JOGO e a conversão para cena
 * fica toda em render/coords.ts).
 */

import type { ShipKind } from "@ceres/shared";
import { MeshFactory, type ShipMeshInstance } from "./MeshFactory";
import { toScene, toSceneAngle } from "./coords";
import { SHIP_LAYER_Z, SHIP_TOP_LAYER_Z } from "./layers";

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
    this.entries.get(id)?.instance.setDepthBias(SHIP_TOP_LAYER_Z);
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
