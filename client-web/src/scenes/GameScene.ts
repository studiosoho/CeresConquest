import type { Room } from "colyseus.js";
import type { Engine } from "@babylonjs/core/Engines/engine";
import type { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { PointsCloudSystem } from "@babylonjs/core/Particles/pointsCloudSystem";
import type { CloudPoint } from "@babylonjs/core/Particles/cloudPoint";
import { DefaultRenderingPipeline } from "@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline";
import { ImageProcessingPostProcess } from "@babylonjs/core/PostProcesses/imageProcessingPostProcess";
import { ImageProcessingConfiguration } from "@babylonjs/core/Materials/imageProcessingConfiguration";
import { Constants } from "@babylonjs/core/Engines/constants";
import {
  MSG_INPUT,
  MSG_PRODUCE,
  MSG_ANCHOR,
  MSG_SWAP,
  MSG_AUTOMINE,
  MSG_TAXI,
  MSG_LAND_ACTION,
  // MSG_EXPAND,
  MSG_CARGO,
  MSG_FIRE,
  MSG_FX,
  GRENADE_BLAST_RADIUS,
  type FxEvent,
  type FxKind,
  SECTOR_SIZE,
  SHIP_PRODUCTION,
  DOCK_RANGE,
  ATTACK_ZONE_MARGIN,
  STRUCTURE_SPECS,
  STATION_ORE_STORE,
  CERES_RADIUS,
  SNAPSHOT_AGE_FIXED_GUESS,
  BULLET_AMMO_MAX,
  GRENADE_AMMO_MAX,
  ceresPosition,
  relVec,
  dist,
  type ShipInput,
  type StructureType,
  type ShipKind,
  type ShipLayer,
  type WorldPos,
} from "@ceres/shared";
import {
  SimWorld,
  makeShip,
  stepShip,
  stepShipInWorld,
  freezeShip,
  sectorAsteroids,
  syncLayer,
  type ShipState,
  type Body,
} from "@ceres/sim-core";
import { Palette } from "../render/Palette";
import { toScene } from "../render/coords";
import { MASK_MAIN_ONLY, FP_CAMERA_MASK } from "../render/layers";
import { c3 } from "../render/lineUtils";
import { KeyInput } from "../input";
import { MeshFactory } from "../render/MeshFactory";
import { ShipRenderer } from "../render/ShipRenderer";
import { EXPLOSION_SPARKS } from "../render/EffectsRenderer";
import { shipMeshData } from "../render/ShipMeshGenerator";
import { dockScale, easePresence, presenceTarget, type Presence, type PresenceShip } from "../render/shipPresence";
import { AsteroidRenderer } from "../render/AsteroidRenderer";
import { PlanetRenderer } from "../render/PlanetRenderer";
import { StructureRenderer } from "../render/StructureRenderer";
import { EffectsRenderer } from "../render/EffectsRenderer";
import { HudRenderer } from "../render/HudRenderer";
import type { HudShipData, HudContextData, MinimapData } from "../render/HudRenderer";
import { Backdrop } from "../render/Backdrop";
import { SpaceLightRig } from "../render/Lighting";

const COLOR_OWN = 0xffffff;
const COLOR_FLEET_OWN = Palette.structure.fleet;

/**
 * Zoom inicial: o quadro de julgamento (0.12), em que as naves têm o tamanho
 * aprovado (ShipMeshGenerator.SHIP_DISPLAY_REF_ZOOM). Dentro de [ZOOM_MIN, ZOOM_MAX].
 */
const INITIAL_ZOOM = 0.12;

const INPUT_SEND_HZ = 30;
/** fator de correção por frame em direção ao estado autoritativo */
const OWN_BLEND = 0.1;
const REMOTE_BLEND = 0.3;

// ── zoom ──
/** faixa de zoom do jogo (px por unidade de mundo) */
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 0.25;
const ZOOM_WHEEL_STEP = 1.15;
const ZOOM_KEY_STEP = 1.03;
const ZOOM_SMOOTH = 0.15;

// ── explosões (MSG_FX) ──
/**
 * Raio final (unidades de mundo) e duração (s) de cada explosão. Dimensionadas
 * contra a nave EXIBIDA (~370 u de comprimento no builder, ver ShipRenderer),
 * não a de mundo: o acerto tem metade da nave; a granada, o raio de dano de
 * verdade; a nave destruída, pouco mais que ela; a estrutura, o prédio todo.
 */
const EXPLOSION_STYLE: Record<FxKind, { radius: number; duration: number }> = {
  hit: { radius: 160, duration: 0.35 },
  blast: { radius: GRENADE_BLAST_RADIUS, duration: 0.55 },
  shipDown: { radius: 480, duration: 0.9 },
  structureDown: { radius: 1000, duration: 1.3 },
};

// ── câmera de cockpit (primeira pessoa) ──
/** viewport do cockpit em frações do canvas (y a partir de BAIXO, como o
 *  Viewport do Babylon) — a moldura DOM do HUD usa as mesmas frações */
const FP_VIEW = { left: 0.344, bottom: 0.02, width: 0.312, height: 0.27 };
/**
 * O cockpit MUDA COM A CAMADA DE VOO (shared/layers.ts). A nave voa no plano
 * da camada de naves, rente ao topo das rochas (layers.ts); o olho é deslocado
 * dali pela altitude aparente da nave (shipPresence.ts, a mesma que comanda
 * sombra e tamanho — então a transição e o pouso interpolam juntos):
 *  - CRUZEIRO (altitude 1): o olho sobe FP_CRUISE_LIFT acima do campo e
 *    inclina FP_CRUISE_PITCH para baixo — vê as rochas passando lá embaixo;
 *  - SUPERFÍCIE e MODO ATAQUE (altitude 0): o olho desce FP_SURFACE_DROP, até o
 *    meio da altura das rochas, com o horizonte quase nivelado — elas passam
 *    ao lado, na altura dos olhos.
 * Cena: −Z é "para cima" (em direção à câmera principal).
 */
const FP_CRUISE_LIFT = 900;
const FP_SURFACE_DROP = 300;
/** pitch do olho (rad, positivo = para cima) em cruzeiro e na superfície */
const FP_CRUISE_PITCH = -0.3;
const FP_SURFACE_PITCH = 0.05;

// ── farol (spotlight) da nave própria ──
/** meia-abertura do cone (rad) */
const HEADLIGHT_ANGLE = 0.99;
/** decaimento angular do cone (maior = borda mais dura) */
const HEADLIGHT_EXPONENT = 6;
/** compensa o albedo da rocha, que subiu ~3× na passada de iluminação: no
 *  valor antigo (5.0) o farol estourava a rocha próxima em branco chapado */
const HEADLIGHT_INTENSITY = 2.2;
/** alcance em unidades de mundo (asteroides grandes ficam a ~2000) */
const HEADLIGHT_RANGE = 2000;
/** inclinação do cone para cima (rad): −Z local = "cima" na vista do
 *  cockpit, aponta um pouco acima do centro dos asteroides à frente */
const HEADLIGHT_PITCH = 0.22;

/**
 * Máscara do cone (cookie/gobo do spotlight): gradiente radial branco→preto
 * numa DynamicTexture — sem asset externo. Preto nas bordas = luz cortada,
 * dando ao cone um recorte suave em vez de um disco duro.
 */
function makeConeMask(scene: Scene): DynamicTexture {
  const size = 256;
  const tex = new DynamicTexture("headlightMask", size, scene, false);
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  const r = size / 2;
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(0.55, "#cfe4ff");
  grad.addColorStop(1, "#000000");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fill();
  tex.update();
  return tex;
}

/**
 * Estrelas em GL points, agora só as de PRIMEIRA GRANDEZA. A camada fraca
 * saiu: espalhar centenas de pontinhos de ~2 px em alfa médio nunca lê como
 * céu, lê como ruído — foi exatamente o veredito de fora ("quadradinhos de
 * 2 px espalhados sem densidade nem variação de brilho"). Densidade,
 * aglomerado e variação de brilho passaram a ser PINTADOS na textura do céu,
 * onde dá para desenhá-los de verdade (Backdrop.paintSky).
 *
 * O que sobra aqui tem uma função que a pintura não cumpre: paralaxe. Estas
 * poucas estrelas são ancoradas no MUNDO e deslizam quando a nave voa,
 * enquanto o céu pintado fica parado — e é essa diferença que separa "muito
 * longe" de "infinitamente longe". São brilhantes o bastante para passar do
 * limiar do bloom, que é o que arredonda o quadrado do gl_POINT em ponto de
 * luz.
 *
 * ADITIVAS: com um céu opaco atrás, um ponto opaco de valor 0.7 sobre névoa
 * de 0.4 seria um disco chapado; somando, ele acende o céu no lugar dele e
 * desaparece sozinho onde o fundo já é claro (a lavagem perto do sol).
 */
const STARS_PER_SECTOR = 16;
/** tamanho do ponto em PIXELS DE TELA (PointsCloudSystem não escala com zoom) */
const STAR_POINT_PX = 2.8;
/**
 * Z das estrelas: entre o dorso da camada de detrito mais funda (4400 em
 * mundo) e o céu (4800), para que TODA massa sólida da cena as oculte. No z
 * antigo (200) elas ficavam à FRENTE dos detritos e piscavam por cima das
 * silhuetas gigantes, denunciando o fundo como transparente.
 */
const STAR_DEPTH_Z = 4500;
/** temperaturas (branco, quente, frio) — o que impede o campo de virar grade */
const STAR_TEMPS = [Palette.ui.starBright, 0xffe9c8, 0xc8dcff];

// ── substitutos locais de Phaser.Math ──
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** normaliza um ângulo para (-π, π] (Phaser.Math.Angle.Wrap) */
const wrapAngle = (a: number) => {
  const w = (a + Math.PI) % (Math.PI * 2);
  return (w < 0 ? w + Math.PI * 2 : w) - Math.PI;
};

interface RemoteView {
  /** posição de render suavizada (no espaço relativo à origem) */
  rx: number;
  ry: number;
  angle: number;
  initialized: boolean;
  kind: ShipKind;
  tint: number;
}

/** Snapshot plano de uma nave vindo do schema Colyseus. */
interface ServerShip extends WorldPos {
  vx: number;
  vy: number;
  angle: number;
  /** velocidade angular — entra no contato (atrito age na casca, com ω×r) */
  av: number;
  mining: boolean;
  owner: string;
  kind: ShipKind;
  anchored: boolean;
  stored: boolean;
  hqId: string;
  /** aranha mineradora: movida pela estação, fora da física */
  autoMining: boolean;
  /** estrutura de destino em taxiamento ("" = não taxia) — fora dos contatos */
  taxiTo: string;
  landingPhase: string;
  landingProgress: number;
  landingTargetX: number;
  landingTargetY: number;
  landingOriginX: number;
  landingOriginY: number;
  landingAsteroidSpin: number;
  /** porão de carga (transporte) */
  cargoKind: string;
  cargoAmount: number;
  hp: number;
  ammo: number;
  grenadeAmmo: number;
  /** vaga ocupada na estrutura `hqId` (guardada ou pousada); −1 = nenhuma */
  bay: number;
  /**
   * Camada de voo e destino da transição em curso ("" = parada) —
   * shared/layers.ts. Entram na predição: o fantasma de outra nave só colide
   * com a própria se estiverem na mesma camada.
   */
  layer: ShipLayer;
  layerTo: ShipLayer | "";
  /** progresso da transição em curso, 0..1 */
  layerProgress: number;
}

/** Projétil sincronizado do servidor. */
interface ServerProjectile extends WorldPos {
  kind: string;
  owner: string;
  vx: number;
  vy: number;
}

/** Snapshot plano de uma estrutura vinda do schema. */
interface ServerStructure extends WorldPos {
  stype: StructureType;
  owner: string;
  angle: number;
  asteroidId: string;
  shipBays: number;
  expandedBays: number;
  /** minério local (estação) e rações em estoque — logística física */
  oreStore: number;
  rationStore: number;
  /** pontos de vida e o máximo do tipo */
  hp: number;
  maxHp: number;
}

/**
 * GameScene — classe comum (ex-Phaser.Scene): rede, predição, input e
 * orquestração dos renderers. main.ts chama update(dt) por frame.
 */
export class GameScene {
  private engine: Engine;
  private bScene: Scene;
  private canvas: HTMLCanvasElement;
  private camera: FreeCamera;
  /** câmera de cockpit (primeira pessoa) — viewport no rodapé central */
  private fpCamera: FreeCamera;
  /** farol da nave própria — cone que ilumina asteroides/estruturas à frente */
  private headlight!: SpotLight;
  private glow: GlowLayer;
  /** céu procedural + sol + camadas de detritos gigantes (ver Backdrop.ts) */
  private backdrop!: Backdrop;
  /** chave (pontual, posicionada) + rim + preenchimento — ver Lighting.ts */
  private lights!: SpaceLightRig;
  /** bloom + tonemapping + vinheta, SÓ na câmera principal */
  private pipeline!: DefaultRenderingPipeline;

  private room!: Room;
  private worldSeed = 0;
  /** true quando a nave ativa foi inicializada (usado por ferramentas externas) */
  ready = false;

  /** nave própria (ativa), predita localmente com o mesmo sim-core do servidor */
  private localShip: ShipState | null = null;
  /** id da nave ativa segundo o servidor, e a que a predição representa */
  private myShipId = "";
  private localShipId = "";
  private myOre = 0;
  /** seleção atual de táxi (índice na lista de opções) */
  private taxiSel = 0;
  private taxiOpts: Array<{ id: string; kind: ShipKind; srcType: StructureType; srcDist: number }> = [];
  private serverShips = new Map<string, ServerShip>();

  /** origem flutuante: setor de referência do espaço de render */
  private origin = { sx: 0, sy: 0 };

  /** fronteira do mapa (arena) recebida do servidor */
  private mapCenter: WorldPos | null = null;
  private mapRadius = 0;

  private remotes = new Map<string, RemoteView>();
  private serverStructures = new Map<string, ServerStructure>();
  private serverProjectiles = new Map<string, ServerProjectile>();
  /** presença mostrada de cada nave (tamanho e altitude suavizados — shipPresence.ts) */
  private presence = new Map<string, Presence>();
  /** explosões em curso: posição de MUNDO (a origem de render flutua), início e faíscas */
  private explosions: Array<{ pos: WorldPos; kind: FxKind; t0: number; angles: number[] }> = [];
  private passthrough = new Set<string>();
  /**
   * Asteroides ocupados agrupados pelo DONO da estrutura — o mesmo ambiente do
   * servidor (SimWorld.passthroughByOwner): na superfície, cada nave atravessa
   * só os das estações do próprio dono; os de estação inimiga são sólidos.
   */
  private passthroughByOwner = new Map<string, Set<string>>();
  /** sistema de render */
  private meshFactory!: MeshFactory;
  private shipRenderer!: ShipRenderer;
  private asteroidRenderer!: AsteroidRenderer;
  private planetRenderer!: PlanetRenderer;
  private structureRenderer!: StructureRenderer;
  private effectsRenderer!: EffectsRenderer;
  private hudRenderer!: HudRenderer;

  /** malha de estrelas do grid 3×3 atual (reconstruída ao trocar de setor) */
  private starPcs: PointsCloudSystem | null = null;
  /** material aditivo — criado uma vez e reusado a cada reconstrução (senão
   *  cada travessia de setor vazaria um material) */
  private starMat: StandardMaterial | null = null;
  /** invalida uma reconstrução de estrelas em voo se outra começar antes */
  private starBuildToken = 0;

  /** Ceres: posição derivada da semente (nada trafega pela rede) */
  private ceres: WorldPos | null = null;
  private zoom = INITIAL_ZOOM;
  private zoomTarget = INITIAL_ZOOM;
  private minimapFull = false;
  private inLandZone = false;
  private isFlying = false;

  private keys: KeyInput;
  private sendAccum = 0;

  constructor(engine: Engine, scene: Scene, canvas: HTMLCanvasElement) {
    this.engine = engine;
    this.bScene = scene;
    this.canvas = canvas;

    // câmera ortográfica: posição = nave própria; enquadramento via bounds
    // recalculados por frame (updateOrtho) a partir do canvas e do zoom
    this.camera = new FreeCamera("cam", new Vector3(0, 0, -1000), scene);
    this.camera.setTarget(Vector3.Zero());
    this.camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    this.camera.minZ = 0.1;
    // far plane cobre o dorso dos asteroides 3D em tombamento (root recuado
    // em z = raioEnvolvente − 300, dorso ≤ 2·(1.07·2000) − 300 ≈ 3980) E os
    // planos de fundo do Backdrop, que vão até z = 4800 (céu) → 5800 a partir
    // da câmera. Em ortográfica a profundidade é linear: alargar o far plane
    // não custa precisão nenhuma.
    this.camera.maxZ = 6200;
    this.updateOrtho();

    // glow amarrado à câmera principal: sem isso o composite de tela cheia
    // do EffectLayer também seria aplicado dentro do viewport do cockpit.
    // Intensidade um degrau abaixo do que era: o bloom do pipeline agora
    // soma um halo largo por cima, e 1.4 + bloom lavava as linhas.
    this.glow = new GlowLayer("glow", scene, { camera: this.camera });
    this.glow.intensity = 1.15;

    // câmera de cockpit (primeira pessoa): perspectiva, presa à cabine da
    // nave própria (parent atribuído por frame em draw()), olhando pelo
    // nariz (+X local) com horizonte nivelado no plano de jogo (up = −Z,
    // em direção à câmera principal) — "ângulo z = 0"
    this.fpCamera = new FreeCamera("fpCam", Vector3.Zero(), scene);
    this.fpCamera.minZ = 2;
    this.fpCamera.maxZ = 5000;
    // rotação no quadro local da nave (ver fpRotation); a altura e o pitch
    // do olho seguem a camada de voo a cada quadro, em draw()
    this.fpCamera.rotationQuaternion = this.fpRotation(FP_SURFACE_PITCH);
    this.fpCamera.layerMask = FP_CAMERA_MASK;
    // recorte retangular no rodapé central do canvas (moldura vem do HUD)
    this.fpCamera.viewport.x = FP_VIEW.left;
    this.fpCamera.viewport.y = FP_VIEW.bottom;
    this.fpCamera.viewport.width = FP_VIEW.width;
    this.fpCamera.viewport.height = FP_VIEW.height;
    // multi-câmera: a principal desenha a tela toda, o cockpit por cima
    scene.activeCameras = [this.camera, this.fpCamera];

    // rig de luz: precisa da câmera porque a chave é uma PONTUAL colada ao
    // enquadramento (ver Lighting.ts) — é o que faz o terminador variar de
    // rocha para rocha em vez de cair no mesmo lugar em todas elas
    this.lights = new SpaceLightRig(scene, this.camera);

    // fundo da cena: céu procedural + sol + camadas de detritos, tudo preso à
    // câmera principal e mascarado MASK_MAIN_ONLY (ver Backdrop.ts). Criado
    // depois do glow porque precisa se EXCLUIR dele — são superfícies
    // emissivas de tela cheia e entrariam inteiras no mapa de glow.
    this.backdrop = new Backdrop(scene, this.camera, this.glow);
    // pano de fundo do cockpit: sem ele o viewport deixaria vazar a imagem da
    // câmera principal onde o cockpit não desenha nada (a cor de fundo da cena
    // só é limpa antes da PRIMEIRA câmera).
    this.backdrop.attachCockpit(scene, this.fpCamera, this.glow);
    this.updateOrtho(); // agora com o backdrop no lugar, dimensiona o céu

    // farol da nave própria: cone de luz saindo pelo nariz (+X local) que
    // ilumina os materiais STANDARD à frente (asteroides/estruturas) — o
    // wireframe emissivo das naves não responde a luz. `projectionTexture`
    // é a MÁSCARA (cookie/gobo) que molda o cone: um gradiente radial suave
    // gerado em runtime (sem asset externo). Uma única luz na nave própria:
    // com o rig chave/rim/preenchimento de Lighting.ts, asteroides e
    // estruturas ficam em 4 luzes — EXATAMENTE o `maxSimultaneousLights`
    // padrão do StandardMaterial. Não sobra vaga. O parent é atribuído por
    // frame em draw() (mesma cabine que a câmera de cockpit).
    this.headlight = new SpotLight(
      "headlight",
      new Vector3(0, 0, 0),
      // nariz (+X) inclinado um pouco para cima (−Z local): mira acima do
      // centro dos asteroides à frente, não o dorso na base da vista
      new Vector3(Math.cos(HEADLIGHT_PITCH), 0, -Math.sin(HEADLIGHT_PITCH)),
      HEADLIGHT_ANGLE,
      HEADLIGHT_EXPONENT,
      scene,
    );
    this.headlight.intensity = HEADLIGHT_INTENSITY;
    this.headlight.range = HEADLIGHT_RANGE;
    // lâmpada FRIA de propósito: é a única fonte artificial do quadro e só
    // se distingue do sol âmbar por temperatura
    this.headlight.diffuse = c3(Palette.light.headlight);
    this.headlight.specular = Color3.Black();
    this.headlight.projectionTexture = makeConeMask(scene);
    this.headlight.projectionTextureUpDirection = new Vector3(0, 0, -1);

    // ── pós-processo ──────────────────────────────────────────────────────
    // SÓ na câmera principal: o array de câmeras é o que impede o bloom e a
    // vinheta de vazarem para o recorte do cockpit (o mesmo motivo pelo qual
    // o GlowLayer nasce com `{ camera }`). O cockpit sai daqui cru — é o
    // comportamento desejado, e a divergência é pequena porque o tonemapping
    // escolhido quase não mexe nos tons médios.
    //
    // hdr = true NÃO é opcional: o DefaultRenderingPipeline só encadeia o
    // ImageProcessingPostProcess quando é HDR; com hdr = false ele devolve o
    // processamento para o shader dos materiais e o pipeline fica só com o
    // bloom. Além disso o alvo meio-flutuante é o que segura o gradiente do
    // céu sem banding ao atravessar tonemapping + bloom.
    this.pipeline = new DefaultRenderingPipeline("space", true, scene, [this.camera]);
    // MSAA no alvo do pipeline: sem isto o RTT perde o antialias que o canvas
    // tinha, e justamente as arestas de faceta e as GreasedLine finas — o
    // desenho todo desta estética — voltam serrilhadas.
    //
    // ORÇAMENTO (rodada 4): 4× → 2×. O frame estava em 17,05 ms a 1280×800 e o
    // requisito é ≤ 16,7. Este é o item mais caro por unidade de qualidade
    // percebida do pipeline: o alvo é meio-flutuante (RGBA16F), então cada
    // amostra custa 8 bytes por pixel de armazenamento MAIS o resolve, e numa
    // integrada o gargalo é largura de banda. De 4× para 2× economiza metade
    // disso. A perda visual é pequena AQUI porque a estética é de faceta
    // chapada com aresta de alto contraste, que é o caso em que 2 amostras já
    // resolvem quase tudo; o que sofre é a GreasedLine fina em diagonal.
    this.pipeline.samples = 2;
    this.pipeline.fxaaEnabled = false;

    // bloom por LIMIAR: só o núcleo do sol, as estrelas de primeira grandeza
    // e as linhas fosforescentes passam de 0.80. A faceta mais clara do quadro
    // (rocha grande ao lado do sol) sai em 205/255 no espaço do material, o
    // que dá ~0.60 no alvo linear do pipeline — abaixo do limiar. A hierarquia
    // depende dessa folga, e ela foi reconferida com os valores da rodada 3.
    this.pipeline.bloomEnabled = true;
    this.pipeline.bloomThreshold = 0.80;
    this.pipeline.bloomWeight = 0.45;
    this.pipeline.bloomKernel = 48;
    this.pipeline.bloomScale = 0.5;

    this.pipeline.imageProcessingEnabled = true;
    // `imageProcessing` SÓ é instanciado quando o pipeline conseguiu de fato
    // ser HDR (o construtor rebaixa `hdr` sozinho se a GPU não renderiza em
    // meio-flutuante). Sem esta guarda, uma placa fraca derrubaria o
    // construtor inteiro da cena e o jogo abriria em tela preta.
    const ip = this.pipeline.imageProcessing as typeof this.pipeline.imageProcessing | undefined;
    if (ip) {
      ip.toneMappingEnabled = true;
      // KHR PBR Neutral e não ACES: o ACES derruba os tons médios ~20 % e
      // desmontaria a escada de valores montada na Palette; o neutro é
      // identidade até ~0.8 e só comprime o topo, que é o "tonemapping em
      // pontos quentes" que se quer aqui.
      ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL;
      ip.exposure = 1.0;
      ip.contrast = 1.06;
      // Vinheta MULTIPLICATIVA por cima de tudo (inclusive naves) — a pintada
      // no céu fecha o fundo, esta fecha o quadro.
      //
      // REAFERIDA NA RODADA 3, por medição e não por gosto: com peso 1.5, fov
      // 0.85 e cor PRETA, o canto inferior direito do quadro saía em (0,5,10),
      // e o terço esquerdo — onde vivem as lajes de fundo — perdia ~⅔ do
      // valor. Boa parte do "as lajes recebem só névoa e zero chave" era isto:
      // a chave chegava e a vinheta a removia depois.
      //
      // A cor deixou de ser preta. No modo multiplicativo o shader faz
      // `resultado *= mix(vignetteColor, branco, termo)`, então uma cor
      // MARINHO fecha o quadro empurrando o canto para o azul do céu em vez de
      // para o zero. Fechamento igual, canto vivo — que é como o adversário
      // trata as bordas dele.
      //
      // RODADA 4 — afrouxada de novo, e de novo por medição. Com peso 1.15 o
      // terço direito do céu saiu em (3,21,46) e o canto em (0,10,22): perto
      // de 40 % da tela era um vazio quase preto, e isso é metade do
      // "colapso monocromático" apontado — não existe divisão de temperatura
      // num campo sem valor nenhum. Peso 0.80 com a cor marinho mais clara
      // ainda fecha o quadro, e agora o canto conserva matiz.
      ip.vignetteEnabled = true;
      ip.vignetteWeight = 0.80;
      ip.vignetteStretch = 0;
      ip.vignetteCameraFov = 1.15;
      ip.vignetteBlendMode = ImageProcessingConfiguration.VIGNETTEMODE_MULTIPLY;
      ip.vignetteColor = new Color4(0.44, 0.54, 0.70, 0);

      // ── FECHO DE ESPAÇO DE COR DA CÂMERA DE COCKPIT ───────────────────
      // Foi este o retângulo preto da rodada 1, e o mecanismo não é óbvio:
      // quando o pipeline anexa seu ImageProcessingPostProcess, ele liga
      // `applyByPostProcess` na configuração COMPARTILHADA da cena, e a partir
      // daí TODO StandardMaterial passa a emitir `pow(cor, 2.2)` — linear —
      // contando que um pós-processo desfaça no fim (`imageProcessingCompatibility`
      // no shader default). A câmera principal tem quem desfaça. A fpCamera
      // não tinha ninguém: a saída dela ficava elevada a 2.2 e todo o viewport
      // afundava para perto de zero. Um valor 0.30 virava 0.07; 0.11 virava
      // 0.008. Daí "borda dura, sem conteúdo".
      //
      // A correção é dar à fpCamera o mesmo fecho, com CONFIGURAÇÃO PRÓPRIA:
      // as propriedades de vinheta/tonemapping são proxies para o objeto de
      // configuração, então usar o da cena arrastaria a vinheta de tela cheia
      // para dentro do recorte. Com instância separada, o cockpit recebe só a
      // conversão de volta e o mesmo tonemapping — e nenhum bloom, nenhuma
      // vinheta, que é a exigência do enunciado.
      const fpCfg = new ImageProcessingConfiguration();
      fpCfg.toneMappingEnabled = true;
      fpCfg.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_KHR_PBR_NEUTRAL;
      fpCfg.exposure = 1.0;
      fpCfg.contrast = 1.06;
      fpCfg.vignetteEnabled = false;
      const fpIp = new ImageProcessingPostProcess(
        "fpImageProcessing", 1.0, this.fpCamera,
        undefined, undefined, undefined, undefined, fpCfg,
      );
      // a entrada JÁ está em linear (o material converteu): sem isto o
      // pós-processo linearizaria de novo e o cockpit ficaria escuro do mesmo
      // jeito, só que por outro caminho
      fpIp.fromLinearSpace = true;
    }

    this.keys = new KeyInput();
  }

  /**
   * Inicializa os renderers e assume a Room de "match" já juntada pelo lobby
   * (o main.ts entrega). A conexão/matchmaking vive no lobby, não aqui.
   */
  async create(room: Room) {
    this.room = room;
    // sistema de render
    this.meshFactory = new MeshFactory(this.bScene, this.glow);
    // a câmera principal entra pelo piso de tamanho em tela das naves (ver
    // ShipRenderer): só ela vê o casco inflado, o cockpit vê o tamanho real
    this.shipRenderer = new ShipRenderer(this.meshFactory, this.camera, this.glow);
    // a câmera entra porque a névoa das rochas tem cor LOCAL: o renderer
    // projeta cada rocha em coordenada de tela para amostrar o céu no ponto
    // em que ela está (ver AsteroidRenderer/Aerial)
    this.asteroidRenderer = new AsteroidRenderer(this.bScene, this.glow, this.camera);
    // primeiro enquadramento: updateOrtho já rodou duas vezes no construtor,
    // antes de este renderer existir
    this.asteroidRenderer.setFrame(this.camera.orthoRight ?? 1, this.camera.orthoTop ?? 1);
    this.planetRenderer = new PlanetRenderer(this.bScene, this.glow);
    this.structureRenderer = new StructureRenderer(this.bScene, this.glow);
    this.effectsRenderer = new EffectsRenderer(this.bScene, this.glow);
    this.hudRenderer = new HudRenderer();
    this.hudRenderer.initCockpitFrame(FP_VIEW);

    // zoom pela roda do mouse
    this.canvas.addEventListener(
      "wheel",
      (ev: WheelEvent) => {
        ev.preventDefault();
        const factor = ev.deltaY > 0 ? 1 / ZOOM_WHEEL_STEP : ZOOM_WHEEL_STEP;
        this.zoomTarget = clamp(this.zoomTarget * factor, ZOOM_MIN, ZOOM_MAX);
      },
      { passive: false },
    );

    // sincronização por diff a cada patch — evita depender da API de
    // callbacks do schema, que varia entre versões do colyseus.js
    this.room.onStateChange((state: any) => this.syncFromServer(state));
    // explosões: o servidor diz onde e o quê, na posição exata do acerto
    this.room.onMessage(MSG_FX, (ev: FxEvent) => {
      const angles: number[] = [];
      const spin = Math.random() * Math.PI * 2;
      for (let i = 0; i < EXPLOSION_SPARKS; i++) {
        angles.push(spin + (i / EXPLOSION_SPARKS) * Math.PI * 2 + (Math.random() - 0.5) * 0.6);
      }
      this.explosions.push({
        pos: { sx: ev.sx, sy: ev.sy, x: ev.x, y: ev.y },
        kind: ev.kind, t0: performance.now() / 1000, angles,
      });
    });
  }

  // ── rede ────────────────────────────────────────────────────────────

  private syncFromServer(state: any) {
    this.worldSeed = state.worldSeed >>> 0;
    // Ceres: derivada da semente (uma vez), desenhada quando conhecida
    if (!this.ceres && this.worldSeed !== 0) {
      this.ceres = ceresPosition(this.worldSeed);
      this.planetRenderer?.init(this.worldSeed);
    }
    this.mapRadius = state.mapRadius;
    this.mapCenter = {
      sx: state.mapCenterSx,
      sy: state.mapCenterSy,
      x: SECTOR_SIZE / 2,
      y: SECTOR_SIZE / 2,
    };

    const seen = new Set<string>();
    state.ships.forEach((s: any, id: string) => {
      seen.add(id);
      this.serverShips.set(id, {
        sx: s.sx, sy: s.sy, x: s.x, y: s.y,
        vx: s.vx, vy: s.vy, angle: s.angle,
        av: s.av ?? 0,
        mining: s.mining,
        owner: s.owner, kind: s.kind, anchored: s.anchored,
        stored: s.stored, hqId: s.hqId,
        autoMining: s.autoMining ?? false,
        taxiTo: s.taxiTo ?? "",
        landingPhase: s.landingPhase ?? "",
        landingProgress: s.landingProgress ?? 0,
        landingTargetX: s.landingTargetX ?? 0,
        landingTargetY: s.landingTargetY ?? 0,
        landingOriginX: s.landingOriginX ?? 0,
        landingOriginY: s.landingOriginY ?? 0,
        landingAsteroidSpin: s.landingAsteroidSpin ?? 0,
        cargoKind: s.cargoKind ?? "",
        cargoAmount: s.cargoAmount ?? 0,
        hp: s.hp ?? 100,
        ammo: s.ammo ?? 0,
        grenadeAmmo: s.grenadeAmmo ?? 0,
        bay: s.bay ?? -1,
        layer: (s.layer ?? "cruise") as ShipLayer,
        layerTo: (s.layerTo ?? "") as ShipLayer | "",
        layerProgress: s.layerProgress ?? 0,
      });
    });
    for (const id of [...this.serverShips.keys()]) {
      if (!seen.has(id)) {
        this.serverShips.delete(id);
        this.shipRenderer?.remove(id);
        this.remotes.delete(id);
        this.presence.delete(id);
      }
    }

    // meu jogador: minério e nave ativa
    const me = state.players?.get(this.room.sessionId);
    if (me) {
      this.myShipId = me.activeShip;
      this.myOre = me.ore;
    }

    // estruturas (estáticas): upsert + remoção
    const seenSt = new Set<string>();
    state.structures.forEach((st: any, id: string) => {
      seenSt.add(id);
      this.serverStructures.set(id, {
        stype: st.stype, owner: st.owner, sx: st.sx, sy: st.sy, x: st.x, y: st.y,
        angle: st.angle, asteroidId: st.asteroidId,
        shipBays: st.shipBays, expandedBays: st.expandedBays ?? 0,
        oreStore: st.oreStore ?? 0, rationStore: st.rationStore ?? 0,
        hp: st.hp ?? 0, maxHp: st.maxHp ?? 0,
      });
    });
    for (const id of [...this.serverStructures.keys()]) {
      if (!seenSt.has(id)) {
        this.serverStructures.delete(id);
        this.structureRenderer?.remove(id);
      }
    }

    // asteroides ocupados → atravessáveis (mesma regra da colisão do servidor)
    this.passthrough = new Set(
      [...this.serverStructures.values()].map((st) => st.asteroidId).filter(Boolean),
    );
    this.passthroughByOwner = new Map();
    for (const st of this.serverStructures.values()) {
      if (!st.asteroidId) continue;
      let set = this.passthroughByOwner.get(st.owner);
      if (!set) this.passthroughByOwner.set(st.owner, (set = new Set()));
      set.add(st.asteroidId);
    }

    // a (re)inicialização da predição acontece em update(), conforme a nave
    // ativa (myShipId) aparecer ou mudar (troca no hangar)

    // projéteis
    const seenPr = new Set<string>();
    state.projectiles?.forEach((p: any, id: string) => {
      seenPr.add(id);
      this.serverProjectiles.set(id, {
        kind: p.kind, owner: p.owner,
        sx: p.sx, sy: p.sy, x: p.x, y: p.y,
        vx: p.vx, vy: p.vy,
      });
    });
    for (const id of [...this.serverProjectiles.keys()]) {
      if (!seenPr.has(id)) this.serverProjectiles.delete(id);
    }
  }

  private sendInput(input: ShipInput) {
    this.room.send(MSG_INPUT, input);
  }

  /** Naves próprias guardadas em QGs — candidatas a táxi (destino: estação). */
  /**
   * A nave própria está na zona de ataque de alguma estação inimiga (raio do
   * asteroide + ATTACK_ZONE_MARGIN)? É a zona em que o [F] a põe em modo
   * ataque no servidor — aqui só decide a dica do HUD.
   */
  private nearEnemyStation(): boolean {
    const me = this.localShip;
    if (!me) return false;
    for (const st of this.serverStructures.values()) {
      if (st.owner === this.room.sessionId) continue;
      const rock = sectorAsteroids(this.worldSeed, st.sx, st.sy).find((a) => a.id === st.asteroidId);
      if (rock && dist(me, st) <= rock.radius + ATTACK_ZONE_MARGIN) return true;
    }
    return false;
  }

  private computeTaxiOptions() {
    const opts: GameScene["taxiOpts"] = [];
    for (const [id, s] of this.serverShips) {
      if (s.owner !== this.room.sessionId || !s.stored) continue;
      const src = this.serverStructures.get(s.hqId);
      if (!src || src.stype !== "hq") continue;
      opts.push({ id, kind: s.kind, srcType: src.stype, srcDist: dist(this.localShip!, src) });
    }
    opts.sort((a, b) => a.srcDist - b.srcDist);
    return opts;
  }

  // ── câmera ──────────────────────────────────────────────────────────

  /**
   * Bounds da câmera ortográfica a partir do canvas e do zoom. O fundo é
   * reencaixado aqui e não em draw(): o zoom é suavizado por lerp e mudaria
   * a cada frame de qualquer jeito, e assim o céu nunca fica um frame
   * atrasado em relação ao retângulo visível (o que apareceria como uma
   * faixa preta na borda ao dar zoom out rápido).
   */
  private updateOrtho(): void {
    const halfW = this.engine.getRenderWidth() / (2 * this.zoom);
    const halfH = this.engine.getRenderHeight() / (2 * this.zoom);
    this.camera.orthoLeft = -halfW;
    this.camera.orthoRight = halfW;
    this.camera.orthoTop = halfH;
    this.camera.orthoBottom = -halfH;
    // chamados uma vez no construtor ANTES de existirem
    this.backdrop?.resize(halfW, halfH);
    // enquadramento corrente para a projeção de tela das rochas (a névoa
    // delas é amostrada do céu no ponto em que cada uma está)
    this.asteroidRenderer?.setFrame(halfW, halfH);
    // a chave é uma pontual colada ao enquadramento: reposicionar aqui é o que
    // mantém o disco solar e a fonte de luz no MESMO ponto da tela em qualquer
    // zoom (sob ortográfica a posição de tela é a própria coordenada XY)
    this.lights?.resize(halfW, halfH);
  }

  // ── loop ────────────────────────────────────────────────────────────

  /** Um passo de jogo; dt em SEGUNDOS (main.ts chama por frame). */
  update(dt: number) {
    // (re)inicializa a predição quando a nave ativa aparece ou muda (troca)
    const mineServer = this.myShipId ? this.serverShips.get(this.myShipId) : undefined;
    if (!mineServer) return;
    if (this.localShipId !== this.myShipId) this.initActiveShip(mineServer);
    if (!this.localShip) return;
    // a camada da nave própria segue a do servidor (quem troca de camada é o
    // servidor): sem isto a predição voava em cruzeiro atravessando a rocha
    // que a nave de verdade, na superfície, encontrava — e o blend puxava a
    // nave de volta de uma batida que a tela não mostrou
    syncLayer(this.localShip, mineServer, SNAPSHOT_AGE_FIXED_GUESS);

    // zoom por teclas +/- e suavização em direção ao alvo
    if (this.keys.isDown("PLUS")) {
      this.zoomTarget = Math.min(this.zoomTarget * ZOOM_KEY_STEP, ZOOM_MAX);
    }
    if (this.keys.isDown("MINUS")) {
      this.zoomTarget = Math.max(this.zoomTarget / ZOOM_KEY_STEP, ZOOM_MIN);
    }
    this.zoom = lerp(this.zoom, this.zoomTarget, ZOOM_SMOOTH);
    this.updateOrtho();

    // construção, produção e ancoragem (autoritativas no servidor)
    const landingPhase = mineServer.landingPhase ?? "";
    const isLanding = landingPhase === "landing";
    const isLanded = landingPhase === "landed";

    if (this.keys.justDown("M")) {
      this.minimapFull = !this.minimapFull;
    }
    // deprecated: será movido para configuração da sala
    // if (this.keys.justDown("M")) {
    //   this.room.send(MSG_EXPAND);
    // }

    // SimWorld único por frame — reutilizado no input, draw e zona de pouso
    const frameSim = new SimWorld(this.worldSeed);

    // calcula zona de pouso e estado de voo uma vez por frame
    this.isFlying = !mineServer.anchored && landingPhase === "";
    if (this.isFlying) {
      const nearAst = frameSim.nearestAsteroid(this.localShip!, DOCK_RANGE * 2);
      if (nearAst) {
        const { dx, dy } = relVec(this.localShip!, nearAst);
        const edgeDist = Math.hypot(dx, dy) - nearAst.radius;
        this.inLandZone = edgeDist <= DOCK_RANGE;
      } else {
        this.inLandZone = false;
      }
    } else {
      this.inLandZone = false;
    }

    // durante pouso/decolagem: bloqueia comandos de jogo
    if (!isLanding && !isLanded) {
      // [F]: uma ÚNICA leitura de justDown — a função CONSOME o flag ao
      // retornar true, então chamá-la duas vezes no mesmo frame (uma por
      // condição) faz a segunda sempre ver "false", mesmo com a tecla
      // pressionada. Ancorar/pousar são mutuamente exclusivos, então um
      // só if/else resolve com uma leitura.
      if (this.keys.justDown("F")) {
        this.room.send(MSG_ANCHOR);
      }
      // SPACE: coleta buffer da estação quando builder ancorado
      const anchoredStation = mineServer.anchored && (() => {
        const st = this.serverStructures.get(mineServer.hqId ?? "");
        return !!st && st.stype === "miningStation";
      })();
      if (anchoredStation && this.keys.justDown("SPACE")) {
        this.room.send(MSG_LAND_ACTION, { action: "stationmine" });
      }
      // [3]/[4]/[5] produzir: só ancorado no QG
      const hqId = mineServer.hqId ?? "";
      const hqStruct = this.serverStructures.get(hqId);
      const isInHq = mineServer.anchored && !!hqStruct && hqStruct.stype === "hq";
      if (isInHq) {
        if (this.keys.justDown("THREE")) {
          this.room.send(MSG_PRODUCE, { kind: "mining" });
        }
        if (this.keys.justDown("FOUR")) {
          this.room.send(MSG_PRODUCE, { kind: "attack" });
        }
        if (this.keys.justDown("FIVE")) {
          this.room.send(MSG_PRODUCE, { kind: "builder" });
        }
        if (this.keys.justDown("SIX")) {
          this.room.send(MSG_PRODUCE, { kind: "transport" });
        }
      }
      // [E] carga/descarga do transporte pousado (contexto no servidor)
      if (mineServer.kind === "transport" && mineServer.anchored
        && this.keys.justDown("E")) {
        this.room.send(MSG_CARGO);
      }
      // disparo da nave de ataque: SPACE = perfurante, G = granada
      if (mineServer.kind === "attack") {
        if (this.keys.justDown("SPACE")) {
          this.room.send(MSG_FIRE, { kind: "bullet" });
        }
        if (this.keys.justDown("G")) {
          this.room.send(MSG_FIRE, { kind: "grenade" });
        }
      }
      if (this.keys.justDown("C")) {
        this.room.send(MSG_SWAP);
      }
      if (mineServer.kind !== "attack" && this.keys.justDown("G")) {
        this.room.send(MSG_AUTOMINE);
      }
      // táxi: [T] cicla a nave escolhida, [Y] chama a selecionada
      this.taxiOpts = this.computeTaxiOptions();
      if (this.taxiOpts.length > 0) this.taxiSel %= this.taxiOpts.length;
      else this.taxiSel = 0;
      if (this.keys.justDown("T") && this.taxiOpts.length > 0) {
        this.taxiSel = (this.taxiSel + 1) % this.taxiOpts.length;
      }
      if (this.keys.justDown("Y") && this.taxiOpts.length > 0) {
        this.room.send(MSG_TAXI, { shipId: this.taxiOpts[this.taxiSel].id });
      }
    }

    // menu pós-pouso: SPACE=minerar, 1=construir estação, 2=construir QG, F=decolar
    if (isLanded) {
      if (this.keys.justDown("SPACE")) {
        this.room.send(MSG_LAND_ACTION, { action: "mine" });
      }
      if (this.keys.justDown("ONE")) {
        this.room.send(MSG_LAND_ACTION, { action: "buildmine" });
      }
      if (this.keys.justDown("TWO")) {
        this.room.send(MSG_LAND_ACTION, { action: "buildhq" });
      }
      if (this.keys.justDown("THREE")) {
        this.room.send(MSG_LAND_ACTION, { action: "buildration" });
      }
      if (this.keys.justDown("F")) {
        this.room.send(MSG_LAND_ACTION, { action: "liftoff" });
      }
    }

    const anchored = mineServer.anchored;
    // em pouso/pousado/decolando: sala controla a posição — congela a predição
    const frozen = anchored || isLanding || isLanded;

    // input → predição local (mesmo passo de física do servidor) → envio
    const input = frozen ? { thrust: false, turn: 0 as const, mine: false } : this.readInput();
    if (frozen) {
      // mesmo congelamento do servidor (SimWorld.tick): zera também a
      // velocidade ANGULAR, senão a nave retoma o giro que tinha ao atracar
      freezeShip(this.localShip);
    } else {
      // Cascos com que a predição PRECISA colidir. O servidor resolve os pares
      // nave × nave dentro do sub-passo (SimWorld.tick) e o cliente não
      // resolvia nenhum: uma única colisão não predita divergia 624 u de
      // posição e 4633 u/s de velocidade em 0,2 s, e o blend de 0,1 por frame
      // levava quase um segundo maquiando isso — o jogador via a própria nave
      // ser puxada de volta por uma batida que a tela não mostrou.
      //
      // Os critérios são os MESMOS do servidor, um a um: fora do mundo
      // (stored), congelada na estrutura (anchored), em pouso/decolagem
      // (landingPhase), aranha (autoMining) e em TAXIAMENTO (taxiTo — corredor
      // de trânsito, por isso o campo passou a ser sincronizado) ficam fora dos
      // contatos. A poda por distância (5000 u) cobre o pior quadro: com o
      // teto de pendência SIM_MAX_DT = 0,25 s, a 6000 u/s cada casco anda até
      // 1500 u num quadro, 3000 u os dois de frente.
      //
      // Estes objetos são o ESTADO AUTORITATIVO, e vão daqui sem cópia de
      // propósito: quem garante que a predição não escreve neles é o sim-core
      // (FlightEnv.contacts é `readonly Readonly<Body>[]`, e o par nave × nave é
      // resolvido contra um FANTASMA, cópia local — flight.ts, `ghostsFor`).
      //
      // O fantasma só enfrenta a nave predita no MESMO instante se souber a
      // IDADE do snapshot: ele descreve o servidor de uma latência atrás. Com
      // idade zero ele renascia no passado a cada patch (razão de Δv
      // 0,65–2,60 a 50–75 ms). Por isso vão também os ids (a predição reconhece
      // a mesma nave entre snapshots e não refaz um choque que já resolveu) e a
      // idade. A idade aqui é um CHUTE FIXO de 50 ms (SNAPSHOT_AGE_FIXED_GUESS),
      // não medida: o estado da sala não traz relógio do servidor e não há
      // ping. Vale perto de 50 ms e quebra longe disso — em LAN o fantasma nasce
      // adiantado e choques rentes somem; de 100 ms para cima o choque se
      // repete (ver a constante). Medir exige carimbo de tempo no estado.
      const contacts: Body[] = [];
      const contactIds: string[] = [];
      for (const [id, s] of this.serverShips) {
        if (id === this.myShipId) continue;
        if (s.stored || s.anchored || s.autoMining || s.taxiTo || s.landingPhase !== "") continue;
        if (dist(this.localShip, s) > 5000) continue;
        contacts.push(s);
        contactIds.push(id);
      }
      // MESMO ponto de entrada do servidor (SimWorld.tick): colisão intercalada
      // nos sub-passos. Integrar o dt inteiro e colidir uma vez no fim faria o
      // cliente (60 Hz) e o servidor (20 Hz) discordarem sobre o que bateu.
      stepShipInWorld(this.localShip, input, dt, 1, {
        seed: this.worldSeed,
        passthroughByOwner: this.passthroughByOwner,
        ceres: this.ceres,
        ceresRadius: CERES_RADIUS,
        boundaryCenter: this.mapCenter,
        boundaryRadius: this.mapRadius,
        contacts,
        contactIds,
        contactsAge: SNAPSHOT_AGE_FIXED_GUESS,
      });
    }
    this.sendAccum += dt;
    if (this.sendAccum >= 1 / INPUT_SEND_HZ) {
      this.sendAccum = 0;
      this.sendInput(input);
    }

    // correção suave em direção ao estado autoritativo
    const authoritative = this.serverShips.get(this.myShipId);
    if (authoritative) this.blendTowards(this.localShip, authoritative);

    // origem flutuante acompanha o setor da nave própria
    if (this.localShip.sx !== this.origin.sx || this.localShip.sy !== this.origin.sy) {
      this.setOrigin(this.localShip.sx, this.localShip.sy);
    }

    this.draw(dt, authoritative, frameSim);
  }

  private readInput(): ShipInput {
    const k = this.keys;
    const turn = (k.isDown("A") || k.isDown("LEFT") ? -1 : 0) + (k.isDown("D") || k.isDown("RIGHT") ? 1 : 0);
    // RCS de translação: Q/E de lado, S de ré. E também é carga/descarga, mas
    // só de transporte ANCORADO — estado em que o voo está congelado e este
    // readInput sequer é chamado, então os dois usos nunca se cruzam.
    const strafe = (k.isDown("Q") ? -1 : 0) + (k.isDown("E") ? 1 : 0);
    return {
      thrust: k.isDown("W") || k.isDown("UP"),
      turn: turn as ShipInput["turn"],
      mine: false,
      strafe: strafe as ShipInput["strafe"],
      retro: k.isDown("S"),
      // X SEGURADO = flight assist off. É estado de NÍVEL, não de borda, de
      // propósito: o input viaja a 30 Hz e um toggle por borda dessincronizaria
      // com um pacote perdido, enquanto um nível se corrige sozinho no
      // seguinte. Solta a tecla, o auxílio volta — padrão é ligado.
      assistOff: k.isDown("X"),
    };
  }

  private blendTowards(local: ShipState, server: ServerShip) {
    const { dx, dy } = relVec(local, server);
    local.x += dx * OWN_BLEND;
    local.y += dy * OWN_BLEND;
    local.vx += (server.vx - local.vx) * OWN_BLEND;
    local.vy += (server.vy - local.vy) * OWN_BLEND;
    local.angle += wrapAngle(server.angle - local.angle) * OWN_BLEND;
    // e `av` JUNTO, pelo mesmo motivo que `angle`: reconciliar a atitude sem
    // reconciliar a velocidade angular é reconciliar a posição sem a
    // velocidade. Com `assistOff` nada traz `av` de volta sozinho (é o
    // interruptor que faz o momento angular ser conservado de verdade), então o
    // erro de rumo virava PERMANENTE: 25,78° para Δav = 3 e 68,75° para Δav = 8;
    // com o auxílio ligado ainda picava em 13,1° e 48,5° antes de o RCS matar os
    // dois giros por acaso. O campo já era sincronizado — a banda estava sendo
    // paga e ninguém lia o valor.
    local.av += (server.av - local.av) * OWN_BLEND;
    // renormaliza a posição local (o blend pode sair do setor)
    stepShip(local, { thrust: false, turn: 0, mine: false }, 0);
  }

  // ── render ──────────────────────────────────────────────────────────

  /** posição de render relativa à origem flutuante */
  private toRender(p: WorldPos): { x: number; y: number } {
    return {
      x: (p.sx - this.origin.sx) * SECTOR_SIZE + p.x,
      y: (p.sy - this.origin.sy) * SECTOR_SIZE + p.y,
    };
  }

  private setOrigin(sx: number, sy: number) {
    this.origin = { sx, sy };
    this.rebuildAsteroids();
    this.rebuildStars();
    for (const view of this.remotes.values()) view.initialized = false;
  }

  /** (Re)inicializa a predição para a nave ativa (spawn ou troca no hangar). */
  private initActiveShip(server: ServerShip) {
    this.localShip = makeShip(server, server.owner, server.kind);
    this.localShip.angle = server.angle;
    this.localShip.anchored = server.anchored;
    this.localShip.layer = server.layer;
    this.localShip.layerTo = server.layerTo;
    this.localShip.layerProgress = server.layerProgress;
    this.localShipId = this.myShipId;
    this.setOrigin(server.sx, server.sy);
    // cria/atualiza a malha da nave própria via ShipRenderer
    this.shipRenderer.create(this.myShipId, {
      x: 0, y: 0, angle: server.angle,
      kind: server.kind, tint: COLOR_OWN, visible: true,
    });
    this.shipRenderer.bringToTop(this.myShipId);
    this.ready = true;
  }

  private rebuildAsteroids() {
    const asteroids: import("../render/AsteroidRenderer").AsteroidRenderData[] = [];
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        for (const a of sectorAsteroids(this.worldSeed, this.origin.sx + ox, this.origin.sy + oy)) {
          asteroids.push(a);
        }
      }
    }
    this.asteroidRenderer.rebuild(asteroids, (p) => this.toRender(p));
  }

  /**
   * Material aditivo das estrelas. Replica o que o PointsCloudSystem monta
   * sozinho (emissivo branco + `disableLighting`, com a cor por partícula
   * entrando como cor de vértice) e acrescenta o blending. Profundidade
   * TESTADA mas não escrita — rochas e detritos ocultam a estrela, a estrela
   * não oculta ninguém.
   */
  private starMaterial(): StandardMaterial {
    const mat = new StandardMaterial("starMat", this.bScene);
    mat.emissiveColor = Color3.White();
    mat.disableLighting = true;
    mat.pointsCloud = true;
    mat.pointSize = STAR_POINT_PX;
    mat.alpha = 0.9999; // < 1 é o gatilho do caminho de blending
    mat.alphaMode = Constants.ALPHA_ADD;
    mat.disableDepthWrite = true;
    return mat;
  }

  /**
   * Reconstrói o campo de estrelas do grid 3×3 (mesma regra determinística por
   * setor do Phaser original) — ver a nota em STARS_PER_SECTOR sobre por que
   * sobraram só as brilhantes. Assíncrono (PointsCloudSystem.buildMeshAsync);
   * um token descarta builds obsoletos se o setor mudar antes de terminar.
   */
  private rebuildStars(): void {
    const token = ++this.starBuildToken;
    const origin = this.origin;

    interface StarSeed { x: number; y: number; color: Color3; level: number }
    const seeds: StarSeed[] = [];
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const sx = origin.sx + ox;
        const sy = origin.sy + oy;
        let seed = ((sx * 0x9e3779b9) ^ (sy * 0x6c62272e)) >>> 0;
        const rng = () => {
          seed = (seed ^ (seed << 13)) >>> 0;
          seed = (seed ^ (seed >> 17)) >>> 0;
          seed = (seed ^ (seed << 5)) >>> 0;
          return seed / 0x100000000;
        };
        const bx = ox * SECTOR_SIZE;
        const by = oy * SECTOR_SIZE;
        for (let i = 0; i < STARS_PER_SECTOR; i++) {
          seeds.push({
            x: bx + rng() * SECTOR_SIZE,
            y: by + rng() * SECTOR_SIZE,
            color: c3(STAR_TEMPS[(rng() * STAR_TEMPS.length) | 0]),
            level: 0.70 + rng() * 0.30,
          });
        }
      }
    }

    if (!this.starMat) this.starMat = this.starMaterial();
    // o pointSize do construtor só serve ao material PADRÃO do PCS; como
    // passamos o nosso em buildMeshAsync, quem manda é `mat.pointSize`
    const pcs = new PointsCloudSystem("stars", STAR_POINT_PX, this.bScene, { updatable: false });
    pcs.addPoints(seeds.length, (particle: CloudPoint, i?: number) => {
      const s = seeds[i!];
      const p = toScene(s.x, s.y);
      particle.position.set(p.x, p.y, STAR_DEPTH_Z);
      // o alpha entra pré-multiplicado na cor: sob ALPHA_ADD é o RGB que
      // define quanto a estrela soma ao céu
      particle.color = new Color4(s.color.r * s.level, s.color.g * s.level, s.color.b * s.level, 1);
    });
    void pcs.buildMeshAsync(this.starMat).then((mesh) => {
      if (token !== this.starBuildToken) {
        pcs.dispose();
        return;
      }
      this.starPcs?.dispose();
      this.starPcs = pcs;
      mesh.isPickable = false;
      // estrelas moram num plano (z fixo): de lado, no cockpit, virariam
      // um risco de pontos — só a câmera principal as vê
      mesh.layerMask = MASK_MAIN_ONLY;
    });
  }

  /** Tint de uma nave conforme o dono: própria pilotada, minha frota, ou alheia. */
  private shipTint(server: ServerShip, id: string): number {
    if (id === this.myShipId) return COLOR_OWN;
    if (server.owner === this.room.sessionId) return COLOR_FLEET_OWN;
    return 0x7f8ea3; // remoto
  }

  /**
   * Rotação do olho do cockpit no quadro local da nave: visada (+Z da câmera)
   * → nariz (+X) e topo da câmera (+Y) → −Z (em direção à câmera principal),
   * com `pitch` (rad, positivo = para cima) em torno do eixo direito local.
   * Quaternion explícito: Quaternion.FromLookDirectionLH devolve a visada
   * INVERTIDA para este par (validado ao vivo — olhava pela cauda); o sinal do
   * pitch também foi validado ao vivo.
   */
  private fpRotation(pitch: number): Quaternion {
    const base = new Quaternion(0.5, -0.5, 0.5, -0.5);
    return base.multiply(Quaternion.RotationAxis(new Vector3(1, 0, 0), -pitch));
  }

  /**
   * Presença de uma nave neste quadro: tamanho e altitude aparentes pela
   * camada, pelo pouso e pela vaga (shipPresence.ts), suavizados.
   */
  private presenceOf(id: string, s: PresenceShip & { kind: ShipKind }, dt: number): Presence {
    const host = s.hqId ? this.serverStructures.get(s.hqId) : undefined;
    const docked = dockScale(
      s,
      shipMeshData(s.kind).length,
      host ? { type: host.stype, shipBays: host.shipBays, expandedBays: host.expandedBays } : undefined,
    );
    const target = presenceTarget(s, this.shipRenderer.screenScale(s.kind), docked);
    const shown = easePresence(this.presence.get(id), target, dt);
    this.presence.set(id, shown);
    return shown;
  }

  private draw(dt: number, authoritative: ServerShip | undefined, frameSim: SimWorld) {
    const own = this.toRender(this.localShip!);
    const mineAuth = this.serverShips.get(this.myShipId);
    const lPhaseRender = mineAuth?.landingPhase ?? "";
    const lSpin = mineAuth?.landingAsteroidSpin ?? 0;
    const tt = performance.now() / 1000;
    const ownAngle = (lPhaseRender === "landed" || lPhaseRender === "landing" || lPhaseRender === "liftoff")
      ? this.localShip!.angle + lSpin * tt
      : this.localShip!.angle;
    // nave própria: atualiza malha via ShipRenderer. A camada vem da PREDIÇÃO
    // (que segue o servidor, syncLayer); pouso e vaga, do servidor
    const ownPresence = mineAuth
      ? this.presenceOf(this.myShipId, {
        ...mineAuth,
        layer: this.localShip!.layer, layerTo: this.localShip!.layerTo, layerProgress: this.localShip!.layerProgress,
      }, dt)
      : undefined;
    this.shipRenderer.update(this.myShipId, {
      x: own.x, y: own.y, angle: ownAngle,
      kind: this.localShip!.kind, tint: COLOR_OWN, visible: true,
      scale: ownPresence?.scale, altitude: ownPresence?.altitude,
    });
    // câmera segue a nave (substitui cameras.main.centerOn)
    const camPos = toScene(own.x, own.y);
    this.camera.position.x = camPos.x;
    this.camera.position.y = camPos.y;

    // fundo: preso à câmera, só as massas distantes tombam devagar
    this.backdrop.tick(tt);

    // cockpit: prende a câmera de primeira pessoa à cabine da nave própria
    // (o root muda quando a malha é recriada na troca de classe; o olho
    // muda com a classe — reatribuir por frame é barato e cobre os dois)
    const cockpit = this.shipRenderer.getCockpit(this.myShipId);
    if (cockpit) {
      if (this.fpCamera.parent !== cockpit.root) this.fpCamera.parent = cockpit.root;
      // altura e inclinação do olho pela altitude aparente (cruzeiro ↔ superfície)
      const alt = ownPresence?.altitude ?? 1;
      const dz = -FP_CRUISE_LIFT * alt + FP_SURFACE_DROP * (1 - alt);
      this.fpCamera.position.copyFromFloats(cockpit.eye.x, cockpit.eye.y, cockpit.eye.z + dz);
      this.fpCamera.rotationQuaternion = this.fpRotation(FP_SURFACE_PITCH + (FP_CRUISE_PITCH - FP_SURFACE_PITCH) * alt);
      // farol na mesma cabine, emitindo pelo nariz (direção +X já fixada)
      if (this.headlight.parent !== cockpit.root) this.headlight.parent = cockpit.root;
      this.headlight.position.copyFromFloats(cockpit.eye.x, cockpit.eye.y, cockpit.eye.z);
    }

    const zoom = this.zoom;

    // Ceres: posição e rotação via renderer
    if (this.ceres) {
      const cp = this.toRender(this.ceres);
      this.planetRenderer.tick(cp, tt);
    }

    // início do frame de efeitos
    this.effectsRenderer.beginFrame();

    // rastro da nave própria: nasce na popa do casco AMPLIADO (escala de tela
    // da classe) e segue o ângulo RENDERIZADO (o giro de pouso incluso)
    const ownKind = this.localShip!.kind;
    this.effectsRenderer.drawJet(own.x, own.y, ownAngle, Math.hypot(this.localShip!.vx, this.localShip!.vy), tt,
      this.myShipId, ownKind, this.shipRenderer.displayScale(this.myShipId, ownKind));
    if (ownPresence?.attack) {
      this.effectsRenderer.drawAttackRing(own.x, own.y, 0.75 * shipMeshData(ownKind).length * ownPresence.scale, tt);
    }

    // naves remotas: interpolação + atualiza malhas via ShipRenderer
    for (const [id, server] of this.serverShips) {
      if (id === this.myShipId || server.stored) {
        // nave própria e naves guardadas: esconde sem criar malha
        if (id !== this.myShipId) {
          this.shipRenderer.update(id, {
            x: 0, y: 0, angle: 0,
            kind: server.kind, tint: COLOR_OWN, visible: false,
          });
        }
        this.remotes.delete(id);
        continue;
      }
      let view = this.remotes.get(id);
      if (!view) {
        const tint = this.shipTint(server, id);
        view = { rx: 0, ry: 0, angle: 0, initialized: false, kind: server.kind, tint };
        this.remotes.set(id, view);
      }
      const target = this.toRender(server);
      if (!view.initialized) {
        view.rx = target.x;
        view.ry = target.y;
        view.angle = server.angle;
        view.initialized = true;
      } else {
        view.rx += (target.x - view.rx) * REMOTE_BLEND;
        view.ry += (target.y - view.ry) * REMOTE_BLEND;
        view.angle += wrapAngle(server.angle - view.angle) * REMOTE_BLEND;
      }
      const pres = this.presenceOf(id, server, dt);
      this.shipRenderer.update(id, {
        x: view.rx, y: view.ry, angle: view.angle,
        kind: view.kind, tint: view.tint, visible: true,
        scale: pres.scale, altitude: pres.altitude,
      });
      this.effectsRenderer.drawJet(view.rx, view.ry, view.angle, Math.hypot(server.vx, server.vy), tt,
        id, view.kind, this.shipRenderer.displayScale(id, view.kind));
      if (pres.attack) {
        this.effectsRenderer.drawAttackRing(view.rx, view.ry, 0.75 * shipMeshData(view.kind).length * pres.scale, tt);
      }
    }

    // estruturas: assentadas na plataforma do asteroide hospedeiro — o
    // parent do Babylon dá posição/inclinação/spin; sem transform por frame
    for (const [id, st] of this.serverStructures) {
      // silhueta na placa: só a nave GUARDADA, na vaga que ela ocupa — a
      // pousada é desenhada de verdade, em cima da placa
      const occupants: Array<ShipKind | null> = new Array(st.shipBays).fill(null);
      for (const s of this.serverShips.values()) {
        if (s.stored && s.hqId === id && s.bay >= 0 && s.bay < occupants.length) occupants[s.bay] = s.kind;
      }
      const attach = st.asteroidId ? this.asteroidRenderer.getBuildFace(st.asteroidId) : null;
      this.structureRenderer.upsert({
        id, stype: st.stype,
        shipBays: st.shipBays, expandedBays: st.expandedBays,
        own: st.owner === this.room.sessionId,
        angle: st.angle,
      }, occupants, attach);
      // barra de HP: sempre na inimiga; na própria, só quando avariada
      const own = st.owner === this.room.sessionId;
      if (st.maxHp > 0 && (!own || st.hp < st.maxHp)) {
        const R = STRUCTURE_SPECS[st.stype].radius;
        const p = this.toRender(st);
        // acima do prédio na tela (y do jogo cresce para baixo)
        this.effectsRenderer.drawHpBar(p.x, p.y - (R + 60), 2.4 * R, st.hp / st.maxHp, own);
      }
    }

    const anchored = authoritative?.anchored ?? this.localShip!.anchored;

    // feixe de mineração
    // Todo: alterar para shooting da nave de ataque
    if (authoritative?.mining) {
      const target = frameSim.nearestAsteroid(this.localShip!);
      if (target) {
        const t = this.toRender(target);
        this.effectsRenderer.drawMiningBeam(own.x, own.y, t.x, t.y, tt);
      }
    }

    // projéteis
    for (const proj of this.serverProjectiles.values()) {
      const pp = this.toRender(proj);
      if (proj.kind === "bullet") {
        this.effectsRenderer.drawBullet(pp.x, pp.y);
      } else {
        this.effectsRenderer.drawGrenade(pp.x, pp.y, tt);
      }
    }

    // explosões em curso
    this.explosions = this.explosions.filter((e) => tt - e.t0 < EXPLOSION_STYLE[e.kind].duration);
    for (const e of this.explosions) {
      const style = EXPLOSION_STYLE[e.kind];
      const p = this.toRender(e.pos);
      this.effectsRenderer.drawExplosion(p.x, p.y, style.radius, (tt - e.t0) / style.duration, e.angles);
    }

    // fronteira do mapa
    if (this.mapCenter && this.mapRadius > 0) {
      const c = this.toRender(this.mapCenter);
      this.effectsRenderer.drawBoundary(c.x, c.y, this.mapRadius);
    }

    // zona de pouso (o asteroide-alvo também trava o tombamento — abaixo)
    let landZoneAst: ReturnType<SimWorld["nearestAsteroid"]> = null;
    if (!anchored && lPhaseRender === "") {
      landZoneAst = frameSim.nearestAsteroid(this.localShip!, DOCK_RANGE * 2);
      if (landZoneAst) {
        const zoneRadius = landZoneAst.radius + DOCK_RANGE;
        const ap = this.toRender(landZoneAst);
        this.effectsRenderer.drawLandZone(ap.x, ap.y, zoneRadius, tt);
      }
    }

    // asteroides: tombamento 3D contínuo + spin Z servidor-síncrono.
    // Rochas ENGAJADAS travam X/Y de volta ao plano do jogo: hospedeiras de
    // estrutura (passthrough), alvo de pouso em andamento/pousado de
    // QUALQUER nave, e o alvo da zona de pouso da nave própria
    const lockedAsteroids = new Set(this.passthrough);
    for (const s of this.serverShips.values()) {
      if (!s.stored && (s.landingPhase ?? "") !== "") {
        const ast = frameSim.nearestAsteroid(s, DOCK_RANGE * 4);
        if (ast) lockedAsteroids.add(ast.id);
      }
    }
    if (landZoneAst) lockedAsteroids.add(landZoneAst.id);
    // O ALVO TAMBÉM É TRATADO PELA LUZ, e não só pelo círculo tracejado do
    // HUD: a rocha em foco entra no degrau mais PRÓXIMO da escada de
    // profundidade (névoa quase zero, cor local cheia, sombra funda). O
    // veredito era que "a arte não hierarquiza o alvo, o HUD faz o trabalho da
    // luz" — é barato porque `setFocus` só reescreve as duas rochas que
    // trocaram de estado, e não roda nada quando o alvo não muda.
    this.asteroidRenderer.setFocus(landZoneAst ? landZoneAst.id : null);
    // rocha que hospeda estrutura não gira no plano: as vagas ficam no ponto
    // fixo onde o servidor pousa as naves (shared/bays.ts)
    this.asteroidRenderer.tick(tt, dt, lockedAsteroids, this.passthrough);

    this.effectsRenderer.endFrame();

    // ── coleta de dados para HUD ──
    const ore = Math.floor(this.myOre);
    const activeKind = this.serverShips.get(this.myShipId)?.kind ?? "builder";
    const kindLabel: Record<ShipKind, string> = { builder: "builder", mining: "mineração", attack: "ataque", transport: "transporte" };

    let hasHq = false;
    let nearOwnStation = false;
    let nearOwnStruct: ServerStructure | null = null;
    for (const st of this.serverStructures.values()) {
      if (st.owner !== this.room.sessionId) continue;
      if (st.stype === "hq") hasHq = true;
      if ((st.stype === "miningStation" || st.stype === "initialBase") && dist(this.localShip!, st) <= DOCK_RANGE) nearOwnStation = true;
      if (dist(this.localShip!, st) <= DOCK_RANGE) {
        if (!nearOwnStruct || dist(this.localShip!, st) < dist(this.localShip!, nearOwnStruct)) {
          nearOwnStruct = st;
        }
      }
    }
    const nearStructOccupied = nearOwnStruct
      ? [...this.serverShips.values()].filter(
        // ocupa a vaga quem está guardado nela, pousado sobre ela ou a caminho
        (s) => s.hqId === [...this.serverStructures.entries()].find(([, v]) => v === nearOwnStruct)?.[0]
          && s.bay >= 0 && (s.stored || s.anchored || s.landingPhase === "landing"),
      ).length
      : 0;
    const nearStructFree = nearOwnStruct ? Math.max(0, nearOwnStruct.shipBays - nearStructOccupied) : 0;
    const hangarTotal = [...this.serverShips.values()].filter(s => s.stored && s.owner === this.room.sessionId).length;

    const p3 = SHIP_PRODUCTION.mining;
    const p4 = SHIP_PRODUCTION.attack;
    const p5 = SHIP_PRODUCTION.builder;
    const p6 = SHIP_PRODUCTION.transport;
    const mark = (ok: boolean) => (ok ? "» " : "  ");
    const need = !hasHq ? " — needs HQ" : !anchored ? " — land [F]" : "";
    const hint3 = `[3] ${p3.label} (${p3.cost})${need}`;
    const hint4 = `[4] ${p4.label} (${p4.cost})${need}`;
    const hint5 = `[5] ${p5.label} (${p5.cost})${need}`;
    const hint6 = `[6] ${p6.label} (${p6.cost})${need}`;
    const anchoredInHq = anchored && (() => {
      const hqId = mineAuth?.hqId ?? "";
      const st = this.serverStructures.get(hqId);
      return !!st && st.stype === "hq";
    })();
    // camada de voo da nave própria (a da predição, que segue o servidor)
    const lay = this.localShip!;
    const layerTag = anchored || (mineAuth?.landingPhase ?? "") !== "" ? ""
      : lay.layerTo === "cruise" ? "  ▲ CLIMBING"
      : lay.layerTo ? "  ▼ DESCENDING"
      : lay.layer === "attack" ? "  ✖ STATION ATTACK"
      : lay.layer === "surface" ? "  ▼ SURFACE"
      : "  ▲ CRUISE";
    const anchorTag = anchored ? "  ⚓ LANDED · [F] take off" : layerTag;
    const canAnchor = !anchored && this.inLandZone;
    const anchorHint = canAnchor
      ? nearOwnStruct !== null
        ? nearStructFree > 0
          ? `  » [F] land (${nearStructFree} free slot${nearStructFree !== 1 ? "s" : ""})`
          : "  ⚓ hangar full"
        : "  » [F] land"
      // longe de pouso, o mesmo [F] troca de camada de voo (o servidor recusa
      // descer sobre rocha sólida ou sobre Ceres)
      : this.isFlying && !(mineAuth?.layerTo)
        ? mineAuth?.layer === "attack" ? "  » [F] leave attack"
          : mineAuth?.layer === "surface" ? "  » [F] climb to cruise"
          : activeKind === "attack" && this.nearEnemyStation() ? "  » [F] attack station"
          : "  » [F] descend"
        : "";
    const swapHint = anchored && !this.isFlying && hangarTotal > 0 ? `  » [C] switch (hangar: ${hangarTotal})` : "";
    const canAuto = activeKind === "mining" && anchored && !this.isFlying && nearOwnStation;
    const autoHint = canAuto ? "  » [G] auto-mine in this station" : "";
    const anchoredStationStruct = anchored ? (() => {
      const st = this.serverStructures.get(mineAuth?.hqId ?? "");
      return (st && st.stype === "miningStation") ? st : null;
    })() : null;
    const builderMining = anchoredStationStruct && (mineAuth?.mining ?? false);
    const stationBufferHint =
      anchoredStationStruct && activeKind === "builder"
        ? (builderMining ? "  » [ESP] stop mining" : "  » [ESP] start mining")
        : "";
    const anchoredStruct = anchored ? this.serverStructures.get(mineAuth?.hqId ?? "") ?? null : null;
    let storeHint = "";
    if (anchoredStruct) {
      if (anchoredStruct.stype === "miningStation") {
        storeHint = `  ·  Buffer: ${Math.floor(anchoredStruct.oreStore)}/${STATION_ORE_STORE} ores · food: ${Math.floor(anchoredStruct.rationStore)}`;
      } else if (anchoredStruct.stype === "initialBase") {
        storeHint = `  ·  Base — food: ${Math.floor(anchoredStruct.rationStore)} (from Earth)`;
      } else if (anchoredStruct.stype === "hq") {
        storeHint = `  ·  HQ — food: ${Math.floor(anchoredStruct.rationStore)}`;
      }
    }
    let ammoHint = "";
    if (activeKind === "attack") {
      const ammo = mineAuth?.ammo ?? 0;
      const gren = mineAuth?.grenadeAmmo ?? 0;
      ammoHint = `  ·  ● ${ammo}/${BULLET_AMMO_MAX} perf.  ○ ${gren}/${GRENADE_AMMO_MAX} gran.`;
    }
    let cargoHint = "";
    if (activeKind === "transport") {
      const ck = mineAuth?.cargoKind ?? "";
      const ca = Math.floor(mineAuth?.cargoAmount ?? 0);
      cargoHint = ck === "" ? "  ·  Container: empty" : `  ·  Buffer: ${ca} ${ck === "ore" ? "minério" : "rações"}`;
      if (anchoredStruct) {
        const st = anchoredStruct.stype;
        if (ck === "rations" || (ck === "ore" && st === "initialBase")) cargoHint += "  » [E] unload";
        else if (ck === "" && st === "miningStation" && anchoredStruct.oreStore > 0) cargoHint += "  » [E] load ores";
        else if (ck === "" && st === "initialBase" && anchoredStruct.rationStore > 0) cargoHint += "  » [E] load food";
      }
    }
    let taxiLine = "";
    if (anchored && nearOwnStation && this.taxiOpts.length > 0) {
      const o = this.taxiOpts[this.taxiSel];
      const km = (o.srcDist / 1000).toFixed(1);
      taxiLine =
        `\nTaxi ▸ ${kindLabel[o.kind]} (HQ at ${km}k)  ` +
        `·  [T] change selection (${this.taxiSel + 1}/${this.taxiOpts.length})  ·  [Y] call (2× speed)`;
    }

    const prodLine = anchoredInHq
      ? `\n${mark(ore >= p3.cost)}${hint3}   ${mark(ore >= p4.cost)}${hint4}   ${mark(ore >= p5.cost)}${hint5}   ${mark(ore >= p6.cost)}${hint6}`
      : "";
    const landHint = canAnchor ? " · [F] land" : "";

    const shipData: HudShipData = {
      kind: activeKind,
      hp: mineAuth?.hp ?? 100,
      ammo: mineAuth?.ammo ?? 0,
      grenadeAmmo: mineAuth?.grenadeAmmo ?? 0,
      ammoMax: BULLET_AMMO_MAX,
      grenadeMax: GRENADE_AMMO_MAX,
      cargoKind: mineAuth?.cargoKind ?? "",
      cargoAmount: mineAuth?.cargoAmount ?? 0,
      mining: mineAuth?.mining ?? false,
      anchored: anchored ?? false,
      landingPhase: mineAuth?.landingPhase ?? "",
      landingProgress: mineAuth?.landingProgress ?? 0,
    };
    const ctxData: HudContextData = {
      ore,
      zoom,
      isFlying: this.isFlying,
      inLandZone: this.inLandZone,
      canAnchor,
      anchorHint,
      swapHint,
      autoHint,
      stationBufferHint,
      storeHint,
      cargoHint,
      ammoHint,
      taxiLine,
      prodLine,
      anchorTag,
      landHint,
    };
    this.hudRenderer.drawStatus(shipData, ctxData);

    // minimapa
    const minimapData: MinimapData = {
      own,
      angle: this.localShip!.angle,
      remotes: [...this.remotes.values()],
      asteroids: this.asteroidRenderer.nearbyPositions,
      ceres: this.ceres,
      mapCenter: this.mapCenter,
      mapRadius: this.mapRadius,
      minimapFull: this.minimapFull,
      toRender: (p) => this.toRender(p),
    };
    this.hudRenderer.drawMinimap(minimapData);
  }
}
