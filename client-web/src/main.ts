import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Client } from "colyseus.js";
import { SERVER_LOCATION_PROD } from "@ceres/shared";
import { GameScene } from "./scenes/GameScene";
import { Lobby } from "./lobby/Lobby";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;

// preserveDrawingBuffer: permite capturar o canvas para depuração durante a
// migração (candidato a desligar no marco 6 se pesar)
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
// sincroniza o drawing buffer com o tamanho CSS do canvas (o construtor não faz)
engine.resize();

const scene = new Scene(engine);
scene.clearColor = new Color4(0, 0, 0, 1);

// A GameScene só existe depois que o jogador entra numa sala. O render loop
// NÃO pode rodar antes disso: sem câmera, scene.render() lança "No camera
// defined" e o _renderLoop do Babylon morre (ele só re-agenda o próximo
// frame DEPOIS do callback, então uma exceção mata o loop de vez). Por isso
// o loop é iniciado dentro de boot(), após create(). Durante o lobby o
// canvas fica preto atrás do overlay DOM — sem render de Babylon.
let gameScene: GameScene | null = null;

window.addEventListener("resize", () => engine.resize());

// handle de debug (inspeção via console/tools); step() permite rodar frames
// sob demanda quando rAF não dispara (página oculta)
const debug = {
  engine,
  scene,
  gameScene: null as GameScene | null,
  step: (dtMs = 16.7) => {
    gameScene?.update(dtMs / 1000);
    scene.render();
  },
};
(window as unknown as { __game: typeof debug }).__game = debug;

// Render (e qualquer PaaS equivalente) só expõe a porta 443 publicamente; o
// Client resolve o protocolo (wss/https) a partir da URL. O lobby usa este
// mesmo Client para listar e para entrar na sala de jogo.
// Override de dev: `?server=ws://localhost:2567` ou localStorage
// "ceres.server" apontam para um servidor local sem tocar no valor de prod.
const endpoint =
  new URLSearchParams(location.search).get("server") ||
  localStorage.getItem("ceres.server") ||
  SERVER_LOCATION_PROD;
const client = new Client(endpoint);

async function boot(): Promise<void> {
  const lobby = new Lobby(client);
  const { room } = await lobby.waitForEnter();
  gameScene = new GameScene(engine, scene, canvas);
  debug.gameScene = gameScene;
  await gameScene.create(room);
  // agora há cena + câmeras: seguro iniciar o render loop
  engine.runRenderLoop(() => {
    const dt = Math.min(engine.getDeltaTime() / 1000, 0.1);
    gameScene?.update(dt);
    scene.render();
  });
}

void boot();
