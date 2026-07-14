import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { GameScene } from "./scenes/GameScene";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

// preserveDrawingBuffer: permite capturar o canvas para depuração durante a
// migração (candidato a desligar no marco 6 se pesar)
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
// sincroniza o drawing buffer com o tamanho CSS do canvas (o construtor não faz)
engine.resize();

const scene = new Scene(engine);
scene.clearColor = new Color4(0, 0, 0, 1);

const gameScene = new GameScene(engine, scene, canvas);
void gameScene.create();

engine.runRenderLoop(() => {
  const dt = Math.min(engine.getDeltaTime() / 1000, 0.1);
  gameScene.update(dt);
  scene.render();
});

window.addEventListener("resize", () => engine.resize());

// handle de debug (inspeção via console/tools); step() permite rodar frames
// sob demanda quando rAF não dispara (página oculta)
(window as unknown as {
  __game: { engine: Engine; scene: Scene; gameScene: GameScene; step: (dtMs?: number) => void };
}).__game = {
  engine,
  scene,
  gameScene,
  step: (dtMs = 16.7) => {
    gameScene.update(dtMs / 1000);
    scene.render();
  },
};
