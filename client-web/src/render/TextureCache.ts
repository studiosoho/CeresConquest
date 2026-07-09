/**
 * TextureCache — único lugar que chama graphics.generateTexture().
 * Cada textura é gerada uma única vez e reutilizada por chave.
 * Sem conhecer entidades, multiplayer ou lógica de jogo.
 */

import Phaser from "phaser";
import { SHIP_RADIUS } from "@ceres/shared";
import type { ShipKind } from "@ceres/shared";
import {
  drawBuilderShip,
  drawMiningShip,
  drawAttackShip,
  drawTransportShip,
} from "./ProceduralGraphics";

/** Margem ao redor do desenho para o glow não ser cortado. */
const MARGIN = SHIP_RADIUS * 2;
/** Tamanho do canvas de textura de nave (quadrado). */
const SHIP_TEX_SIZE = SHIP_RADIUS * 4 + MARGIN * 2;

const DRAW_FN: Record<ShipKind, (g: Phaser.GameObjects.Graphics) => void> = {
  builder:   drawBuilderShip,
  mining:    drawMiningShip,
  attack:    drawAttackShip,
  transport: drawTransportShip,
};

export class TextureCache {
  private scene: Phaser.Scene;
  private generated = new Set<string>();
  private rts: Phaser.GameObjects.RenderTexture[] = [];

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /**
   * Retorna a chave de textura para a nave.
   * Gera a textura na primeira chamada; nas seguintes retorna imediatamente.
   */
  getShipKey(kind: ShipKind): string {
    const key = `ship_${kind}`;
    if (this.generated.has(key)) return key;

    const size = SHIP_TEX_SIZE;
    const cx = size / 2;
    const cy = size / 2;

    // RenderTexture.draw(obj, x, y) desenha obj com offset (x,y) dentro do RT,
    // ignorando a posição do objeto — passamos cx,cy para centralizar o desenho
    const rt = this.scene.add.renderTexture(0, 0, size, size);
    const g = this.scene.add.graphics();
    DRAW_FN[kind](g);
    rt.draw(g, cx, cy);
    rt.saveTexture(key);
    g.destroy();
    rt.setVisible(false);
    this.rts.push(rt); // mantém o RT vivo — destroy() invalida a textura

    this.generated.add(key);
    return key;
  }

  /** Pré-aquece todas as texturas de naves de uma vez. */
  warmShips(): void {
    const kinds: ShipKind[] = ["builder", "mining", "attack", "transport"];
    for (const k of kinds) this.getShipKey(k);
  }

  /** Destrói todas as texturas geradas (chamar ao destruir a cena). */
  destroy(): void {
    for (const key of this.generated) {
      if (this.scene.textures.exists(key)) {
        this.scene.textures.remove(key);
      }
    }
    this.generated.clear();
    for (const rt of this.rts) rt.destroy();
    this.rts = [];
  }
}
