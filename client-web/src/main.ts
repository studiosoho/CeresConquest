import Phaser from "phaser";
import { GameScene } from "./scenes/GameScene";

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: document.body,
  backgroundColor: "#000000",
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: window.innerWidth || 1280,
    height: window.innerHeight || 720,
  },
  scene: [GameScene],
});

// handle de debug (inspeção via console/tools)
(window as unknown as { __game: Phaser.Game }).__game = game;
