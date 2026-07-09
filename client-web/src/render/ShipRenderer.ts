/**
 * ShipRenderer — gerencia sprites de naves usando texturas do TextureCache.
 * Sem nenhum Graphics, sem nenhum desenho, sem lógica de jogo.
 * GameScene chama create() e update() — só isso.
 */

import Phaser from "phaser";
import { SHIP_RADIUS } from "@ceres/shared";
import type { ShipKind } from "@ceres/shared";
import { TextureCache } from "./TextureCache";

/** Dados mínimos que o renderer precisa de uma nave. */
export interface ShipRenderData {
  x: number;
  y: number;
  angle: number;
  kind: ShipKind;
  /** tint a aplicar no sprite (cor de time/dono) */
  tint: number;
  visible: boolean;
}

interface SpriteEntry {
  sprite: Phaser.GameObjects.Sprite;
  kind: ShipKind;
}

/** Escala do sprite: o canvas de textura tem SHIP_RADIUS*4 + margem de lado. */
const SHIP_TEX_SIZE = SHIP_RADIUS * 4 + SHIP_RADIUS * 4;
void SHIP_TEX_SIZE; // referência de escala — TextureCache define o tamanho real
/** O sprite deve aparecer com tamanho 1:1 no espaço de mundo. */
const SPRITE_SCALE = 1;

export class ShipRenderer {
  private scene: Phaser.Scene;
  private cache: TextureCache;
  private container: Phaser.GameObjects.Container;
  private sprites = new Map<string, SpriteEntry>();

  constructor(scene: Phaser.Scene, cache: TextureCache, container: Phaser.GameObjects.Container) {
    this.scene = scene;
    this.cache = cache;
    this.container = container;
  }

  /**
   * Cria (ou recria se o kind mudou) o sprite para a nave com o id dado.
   * Deve ser chamado quando a nave aparece ou troca de classe.
   */
  create(id: string, data: ShipRenderData): void {
    const existing = this.sprites.get(id);
    if (existing && existing.kind === data.kind) {
      // já existe com o kind correto — só atualiza visual
      this.applyData(existing.sprite, data);
      return;
    }
    existing?.sprite.destroy();

    const key = this.cache.getShipKey(data.kind);
    const sprite = this.scene.add.sprite(data.x, data.y, key);
    sprite.setScale(SPRITE_SCALE);
    sprite.setOrigin(0.5, 0.5);
    this.applyData(sprite, data);
    this.container.add(sprite);

    this.sprites.set(id, { sprite, kind: data.kind });
  }

  /**
   * Atualiza posição, rotação, tint e visibilidade do sprite.
   * Recria o sprite se o kind mudou (troca de nave no hangar).
   */
  update(id: string, data: ShipRenderData): void {
    const entry = this.sprites.get(id);
    if (!entry) {
      this.create(id, data);
      return;
    }
    if (entry.kind !== data.kind) {
      this.create(id, data);
      return;
    }
    this.applyData(entry.sprite, data);
  }

  /** Remove o sprite de uma nave que saiu do mundo. */
  remove(id: string): void {
    const entry = this.sprites.get(id);
    if (entry) {
      entry.sprite.destroy();
      this.sprites.delete(id);
    }
  }

  /** Traz o sprite de uma nave para o topo da camada. */
  bringToTop(id: string): void {
    const entry = this.sprites.get(id);
    if (entry) this.container.bringToTop(entry.sprite);
  }

  /** Destrói todos os sprites. */
  destroy(): void {
    for (const { sprite } of this.sprites.values()) sprite.destroy();
    this.sprites.clear();
  }

  private applyData(sprite: Phaser.GameObjects.Sprite, data: ShipRenderData): void {
    sprite.setPosition(data.x, data.y);
    sprite.setRotation(data.angle);
    sprite.setTint(data.tint);
    sprite.setVisible(data.visible);
  }
}
