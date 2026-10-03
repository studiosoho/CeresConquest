import type { Room } from "colyseus.js";
import type { Engine } from "@babylonjs/core/Engines/engine";
import type { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { Vector3, Quaternion, Matrix } from "@babylonjs/core/Maths/math.vector";
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
  MSG_WEAPON,
  laserMount,
  MSG_TURRET,
  MSG_RESTART,
  normalizePos,
  BUILDER_ITEM_CAP,
  BUILDER_HOLD_TOTAL,
  holdRoom,
  RUIN_OWNER,
  WORM_HOLE_ID,
  WORM_HOLE_SEAL_MINES,
  REFINE_TIME,
  REPAIR_HP_PER_KIT,
  TRANSPORT_CARGO_CAP,
  REFINE_ORE,
  REFINE_KITS,
  MSG_DRONE_UPGRADE,
  MSG_TRANSFER,
  SHIP_ORE_HOLD,
  DRILL_BASE_RATE,
  stationUpgradeCost,
  droneStats,
  droneUpgradeCost,
  TURRET_COST,
  TURRET_MAX,
  turretWorldPos,
  MSG_FX,
  MSG_ALERT,
  type AlertEvent,
  MSG_UPGRADE,
  CERES_STATION_MAX_LEVEL,
  stationOreCap,
  MINE_BLAST_RADIUS,
  type FxEvent,
  SECTOR_SIZE,
  SHIP_PRODUCTION,
  DOCK_RANGE,
  ATTACK_ZONE_MARGIN,
  CERES_PLATFORM_PREFIX,
  ceresPlatforms,
  ceresPlatformPos,
  STRUCTURE_SPECS,
  CERES_RADIUS,
  SNAPSHOT_AGE_FIXED_GUESS,
  MISSILE_AMMO_MAX,
  MINE_AMMO_MAX,
  type WeaponKind,
  type ProduceCommand,
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
  attackModeInput,
  sectorAsteroids,
  syncLayer,
  wormBodyAt,
  type ShipState,
  type Body,
} from "@ceres/sim-core";
import { Palette } from "../render/Palette";
import { toScene, toSceneAngle } from "../render/coords";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { MASK_MAIN_ONLY, FP_CAMERA_MASK, EFFECTS_LAYER_Z, SHIP_LAYER_Z, ROCK_FRONT_REACH } from "../render/layers";
import { c3 } from "../render/lineUtils";
import { KeyInput, type KeyName } from "../input";
import { MeshFactory } from "../render/MeshFactory";
import { ShipRenderer } from "../render/ShipRenderer";
import { ExplosionRenderer, type ExplosionHandle } from "../render/ExplosionRenderer";
import { BeamRenderer } from "../render/BeamRenderer";
import { DroneRenderer } from "../render/DroneRenderer";
import { WormRenderer } from "../render/WormRenderer";
import { CockpitInterior, PANEL_SCREEN, type CargoDashboard, type RadarBlip } from "../render/CockpitInterior";
import { SoundEngine } from "../audio/SoundEngine";
import { SoundDirector } from "../audio/SoundDirector";
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
 * aprovado (ShipMeshGenerator.SHIP_DISPLAY_REF_ZOOM). Dentro de [ZOOM_MIN, ZOOM_MAX]
 * (ZOOM_MAX_DOCKED com a nave atracada).
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
/** atracada ou pousada, dá para chegar bem mais perto (ver o hangar de perto) */
const ZOOM_MAX_DOCKED = 0.75;
/** velocidade da câmera do espectador (px de tela por segundo ÷ zoom = u/s) */
const SPECTATOR_SPEED = 900;
/** espectador em primeira pessoa: giro de A/D (rad/s) */
const SPECTATOR_TURN_RATE = 1.8;
/** folga do casco atracado acima do chão da plataforma (cena, −z = para cima) */
const DOCK_HULL_LIFT = 6;
const ZOOM_WHEEL_STEP = 1.15;
const ZOOM_KEY_STEP = 1.03;
const ZOOM_SMOOTH = 0.15;

// ── explosões (MSG_FX) ──
/**
 * Tamanho das explosões (ExplosionRenderer), em fração de QUEM recebeu o dano:
 * o acerto engloba parte da nave ou do prédio; a destruição, o alvo todo e
 * mais. A mina estoura no raio de dano dela. O laser não explode: é um traço.
 */
const EXPLOSION_SHIP_HIT = 0.45;
const EXPLOSION_SHIP_DOWN = 0.95;
const EXPLOSION_STRUCT_HIT = 0.7;
const EXPLOSION_STRUCT_DOWN = 1.8;
const EXPLOSION_BAY_HIT = 45;
const EXPLOSION_BAY_DOWN = 75;
const EXPLOSION_BLAST = MINE_BLAST_RADIUS * 0.8;

// ── armamento ──
/** duração (s) do traço de um disparo de laser */
const LASER_FX_DURATION = 0.18;
/** SPACE segurado repete o disparo de míssil/laser neste intervalo (s); o
 *  servidor ainda impõe o cooldown de cada arma */
const FIRE_REPEAT = 0.1;
/** retícula da mira: tamanho e distância à frente sem alvo (mundo) */
const AIM_SIZE = 70;
const AIM_IDLE_DIST = 1800;
const WEAPON_KEYS: Array<["ONE" | "TWO" | "THREE", WeaponKind]> = [["ONE", "missile"], ["TWO", "laser"], ["THREE", "mine"]];

// ── câmera de cockpit (primeira pessoa) ──
/** viewport do cockpit em frações do canvas (y a partir de BAIXO, como o
 *  Viewport do Babylon) — a moldura DOM do HUD usa as mesmas frações */
const FP_VIEW = { left: 0.344, bottom: 0.02, width: 0.312, height: 0.27 };
/**
 * O cockpit MUDA COM A CAMADA DE VOO (shared/layers.ts). A nave voa no plano
 * da camada de naves, rente ao topo das rochas (layers.ts); o olho é deslocado
 * dali pela altitude aparente da nave (shipPresence.ts, a mesma que comanda
 * o tamanho — então a transição e o pouso interpolam juntos):
 *  - CRUZEIRO (altitude 1): o olho sobe FP_CRUISE_LIFT acima do campo e
 *    inclina FP_CRUISE_PITCH para baixo — vê as rochas passando lá embaixo;
 *  - SUPERFÍCIE e MODO ATAQUE (altitude 0): o olho desce FP_SURFACE_DROP, até o
 *    meio da altura das rochas, com o horizonte quase nivelado — elas passam
 *    ao lado, na altura dos olhos.
 *  - ATRACADA (dock 1): a nave está sobre a plataforma do asteroide, não entre
 *    as rochas — o olho fica no plano das naves, rente à plataforma, e a nave
 *    pousa de nariz para a estação, que aparece à frente no visor.
 * Cena: −Z é "para cima" (em direção à câmera principal).
 */
const FP_CRUISE_LIFT = 900;
const FP_SURFACE_DROP = 300;
/** pitch do olho (rad, positivo = para cima) em cruzeiro e na superfície */
const FP_CRUISE_PITCH = -0.3;
/** altura do olho da nave atracada acima do chão da plataforma */
const FP_DOCK_EYE_HEIGHT = 25;
const FP_SURFACE_PITCH = 0.05;
/**
 * MODO ATAQUE: a vista aponta para a estação em foco. O olho sobe
 * FP_ATTACK_EYE_HEIGHT acima do chão da plataforma dela (no meio das rochas
 * o prédio ficava escondido atrás da própria rocha) e a câmera mira o prédio
 * — em inclinação e em rumo, o que também absorve o atraso do nariz
 * travado enquanto a nave circula. Entra e sai suavizado (FP_ATTACK_BLEND_RATE /s).
 */
const FP_ATTACK_EYE_HEIGHT = 380;
/** altura (acima do chão) do ponto do prédio para onde a vista aponta */
const FP_ATTACK_AIM_LIFT = 35;
const FP_ATTACK_BLEND_RATE = 3;

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
const STAR_DEPTH_Z = 40_900; // atrás de Ceres e das lajes (ver Backdrop.ts)
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
  /** asteroide vazio em que a nave está pousada ("" = nenhum) */
  anchoredAsteroidId: string;
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
  /** mísseis e minas (o laser não gasta munição) */
  ammo: number;
  grenadeAmmo: number;
  /** arma selecionada e a mira do computador de tiro (shared/weapons.ts) */
  weapon: WeaponKind;
  aimOffset: number;
  aimTarget: string;
  aimLocked: boolean;
  /** modo ataque: estrutura atacada ("" = fora) e raio da parede macia da órbita */
  attackTarget: string;
  attackRadius: number;
  /** 2º canhão do laser (o 1º é aimOffset/aimLocked) */
  aimOffset2: number;
  aimLocked2: boolean;
  /** refinaria do builder: lotes na fila e progresso do atual */
  refineQueue: number;
  refineProgress: number;
  /** kits de construção a bordo (builder) */
  kits: number;
  /** rações a bordo (builder) */
  rations: number;
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

/** Projétil sincronizado do servidor: míssil ou mina. */
interface ServerProjectile extends WorldPos {
  kind: string;
  owner: string;
  vx: number;
  vy: number;
  traveled: number;
  /** mina parada e armada */
  armed: boolean;
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
  /** nível (a estação de Ceres evolui; as demais ficam em 1) */
  level: number;
  /** turretas prontas; obra em curso (lugar −1 = nenhuma), progresso e o builder */
  turrets: number;
  turretBuild: number;
  turretProgress: number;
  turretBuilder: string;
  /** um builder está consertando a estrutura ([G]) */
  repairing: boolean;
  /** kits guardados no buffer da estrutura */
  kitStore: number;
  /** central de rações: níveis das melhorias dos drones */
  droneLv: number;
  speedLv: number;
  cargoLv: number;
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
  /**
   * Vista de cockpit em TELA CHEIA (tecla V): a câmera de primeira pessoa
   * ocupa o canvas e a de cima vira o quadro pequeno do rodapé — as duas
   * trocam de viewport e de ordem de desenho, e o brilho acompanha a vista
   * cheia. Os controles são os mesmos (já são relativos ao nariz).
   */
  private cockpitFull = false;
  /** pitch corrente do olho do cockpit (rad) — posiciona a mira */
  private fpPitch = FP_SURFACE_PITCH;
  /** quanto o cockpit está no enquadramento do modo ataque (0..1) e de qual estrutura */
  private fpAttack = 0;
  private fpAttackId = "";
  /** presença mostrada de cada nave (tamanho e altitude suavizados — shipPresence.ts) */
  private presence = new Map<string, Presence>();
  /** explosões em curso: posição de MUNDO (a origem de render flutua), início e faíscas */
  private explosionRenderer!: ExplosionRenderer;
  /** fim de jogo: encerrado, tempo de sobrevivência, resumo (JSON) e modo espectador */
  private eliminated = false;
  /** estrutura em que o piloto espera A PÉ, sem nave ("" = está numa nave) */
  private myStation = "";
  private survival = 0;
  private summary = "";
  private spectating = false;
  /**
   * Espectador: o olho de primeira pessoa num suporte próprio (sem nave para
   * prendê-lo) — rumo, camada escolhida com [F] e a altitude suavizada.
   */
  private spectHeading = 0;
  private spectLayer: "cruise" | "surface" = "cruise";
  private spectAlt = 1;
  private spectRig: TransformNode | null = null;
  /** traço 3D do laser, para o cockpit */
  private beamRenderer!: BeamRenderer;
  /** drones de ração em voo (estado do servidor) e o seu render */
  private droneRenderer!: DroneRenderer;
  private serverDrones = new Map<string, WorldPos & { owner: string; angle: number; cargo: number }>();
  /** minhocas gigantes: gomos no mundo (0 = cabeça), cabeça erguida e boca */
  private serverWorms = new Map<string, { segs: WorldPos[]; breach: number; mouth: number }>();
  private wormRenderer!: WormRenderer;
  /** toca aberta das minhocas (id da plataforma de Ceres, "" = nenhuma) e minas já detonadas nela */
  private wormHole = "";
  private wormHoleSeal = 0;
  /** interior da cabine na câmera de cockpit (painel, radar, tela da vista de cima) */
  private cockpitInterior!: CockpitInterior;
  /** efeitos sonoros 8 bits (sfxr) e quem decide quando tocá-los */
  private sound!: SoundEngine;
  private soundDirector!: SoundDirector;
  /** explosões em curso: onde (mundo) e em quem — a nave atingida a leva junto */
  private explosions: Array<{ handle: ExplosionHandle; pos: WorldPos; on?: FxEvent["on"]; id?: string; radius: number }> = [];
  /** traços de laser em curso (MSG_FX "laser") */
  private lasers: Array<{ from: WorldPos; to: WorldPos; t0: number; src?: string; on?: FxEvent["on"]; id?: string }> = [];
  /** próximo instante (s) em que SPACE segurado repete o disparo */
  private nextFireAt = 0;
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
    // Ceres (esfera cheia) desce até ~39 700 e o fundo do Backdrop mora atrás
    // dela, até 42 000 local — ver Backdrop.ts
    this.camera.maxZ = 42_500;
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
    // alcance longo: Ceres (40 km) inteira no horizonte de qualquer ponto da
    // arena; as rochas continuam limitadas à grade 3×3 de setores. minZ 5
    // segura a precisão de profundidade com o far plane 24 000× mais longe
    this.fpCamera.minZ = 5;
    this.fpCamera.maxZ = 120_000;
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
    this.shipRenderer = new ShipRenderer(this.meshFactory, this.camera);
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
    this.explosionRenderer = new ExplosionRenderer(this.bScene, this.camera, this.glow);
    this.beamRenderer = new BeamRenderer(this.bScene);
    this.droneRenderer = new DroneRenderer(this.bScene);
    this.wormRenderer = new WormRenderer(this.bScene);
    this.cockpitInterior = new CockpitInterior(this.bScene, this.fpCamera, this.glow);
    // som: sintetizado agora; o áudio só liga no primeiro gesto (autoplay)
    this.sound = new SoundEngine();
    this.soundDirector = new SoundDirector(this.sound);
    const unlock = () => this.sound.unlock();
    window.addEventListener("keydown", unlock);
    window.addEventListener("pointerdown", unlock);
    // ajuste de ouvido no console: __sfx.play("missile")
    (window as unknown as { __sfx: SoundEngine }).__sfx = this.sound;
    this.hudRenderer = new HudRenderer();
    this.hudRenderer.initCockpitFrame(FP_VIEW);

    // zoom pela roda do mouse
    this.canvas.addEventListener(
      "wheel",
      (ev: WheelEvent) => {
        ev.preventDefault();
        const factor = ev.deltaY > 0 ? 1 / ZOOM_WHEEL_STEP : ZOOM_WHEEL_STEP;
        this.zoomTarget = clamp(this.zoomTarget * factor, ZOOM_MIN, this.zoomMax());
      },
      { passive: false },
    );

    // sincronização por diff a cada patch — evita depender da API de
    // callbacks do schema, que varia entre versões do colyseus.js
    this.room.onStateChange((state: any) => this.syncFromServer(state));
    // explosões: o servidor diz onde e o quê, na posição exata do acerto
    // alertas a este jogador (ex.: os tremores da toca das minhocas)
    this.room.onMessage(MSG_ALERT, (ev: AlertEvent) => {
      this.hudRenderer.showAlert(ev.text, ev.level);
      this.soundDirector.alarm();
    });
    this.room.onMessage(MSG_FX, (ev: FxEvent) => {
      this.soundDirector.fx(ev, this.localShip, this.myShipId);
      if (ev.kind === "laser") {
        this.lasers.push({
          from: { sx: ev.sx, sy: ev.sy, x: ev.x, y: ev.y },
          to: { sx: ev.tsx ?? ev.sx, sy: ev.tsy ?? ev.sy, x: ev.tx ?? ev.x, y: ev.ty ?? ev.y },
          t0: performance.now() / 1000,
          src: ev.src, on: ev.on, id: ev.id,
        });
        return;
      }
      this.spawnExplosion(ev);
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
        anchoredAsteroidId: s.anchoredAsteroidId ?? "",
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
        weapon: (s.weapon ?? "missile") as WeaponKind,
        aimOffset: s.aimOffset ?? 0,
        aimTarget: s.aimTarget ?? "",
        aimLocked: s.aimLocked ?? false,
        attackTarget: s.attackTarget ?? "",
        aimOffset2: s.aimOffset2 ?? 0,
        refineQueue: s.refineQueue ?? 0,
        kits: s.kits ?? 0,
        rations: s.rations ?? 0,
        refineProgress: s.refineProgress ?? 0,
        aimLocked2: s.aimLocked2 ?? false,
        attackRadius: s.attackRadius ?? 0,
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
      this.myStation = me.station ?? "";
      const was = this.eliminated;
      this.eliminated = !!me.eliminated;
      this.survival = me.survival ?? 0;
      this.summary = me.summary ?? "";
      if (this.eliminated && !was) this.onEliminated();
      if (!this.eliminated && was) {
        this.spectating = false;
        this.hudRenderer.hideEndScreen();
        this.hudRenderer.setSpectatorBanner(null);
      }
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
        hp: st.hp ?? 0, maxHp: st.maxHp ?? 0, level: st.level ?? 1,
        turrets: st.turrets ?? 0, turretBuild: st.turretBuild ?? -1,
        turretProgress: st.turretProgress ?? 0, turretBuilder: st.turretBuilder ?? "", repairing: st.repairing ?? false,
        droneLv: st.droneLv ?? 0, speedLv: st.speedLv ?? 0, cargoLv: st.cargoLv ?? 0,
        kitStore: st.kitStore ?? 0,
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
        traveled: p.traveled ?? 0,
        armed: p.armed ?? false,
      });
    });
    for (const id of [...this.serverProjectiles.keys()]) {
      if (!seenPr.has(id)) this.serverProjectiles.delete(id);
    }

    // drones de ração em voo
    const seenDr = new Set<string>();
    state.drones?.forEach((d: any, id: string) => {
      seenDr.add(id);
      this.serverDrones.set(id, { sx: d.sx, sy: d.sy, x: d.x, y: d.y, owner: d.owner, angle: d.angle, cargo: d.cargo });
    });
    for (const id of [...this.serverDrones.keys()]) if (!seenDr.has(id)) this.serverDrones.delete(id);

    this.wormHole = state.wormHole ?? "";
    this.wormHoleSeal = state.wormHoleSeal ?? 0;
    // minhocas gigantes: cabeça + offsets dos gomos
    const seenWm = new Set<string>();
    state.worms?.forEach((w: any, id: string) => {
      seenWm.add(id);
      const segs: WorldPos[] = [{ sx: w.sx, sy: w.sy, x: w.x, y: w.y }];
      const off: number[] = Array.from(w.segs ?? []);
      for (let k = 0; k + 1 < off.length; k += 2) {
        const p = { sx: w.sx, sy: w.sy, x: w.x + off[k], y: w.y + off[k + 1] };
        normalizePos(p);
        segs.push(p);
      }
      this.serverWorms.set(id, { segs, breach: w.breach ?? 0, mouth: w.mouth ?? 0 });
    });
    for (const id of [...this.serverWorms.keys()]) if (!seenWm.has(id)) this.serverWorms.delete(id);

    // som: o que mudou desde o último estado (disparos, minas, pouso...)
    this.soundDirector.sync({
      sessionId: this.room.sessionId,
      myShipId: this.myShipId,
      ships: this.serverShips,
      structures: this.serverStructures,
      projectiles: this.serverProjectiles,
    }, this.localShip, performance.now() / 1000);
  }

  /**
   * Mira da nave de ataque própria em voo (estilo Elite): a retícula marca
   * para onde a arma aponta — o nariz girado pelo desvio que o computador
   * de tiro do servidor está aplicando —, à distância do alvo; o alvo ganha
   * colchetes. No laser, a retícula CAMINHA até o alvo e fica vermelha ao
   * travar. A mina não tem mira: sai pelo nariz.
   */
  private drawWeaponAim(own: { x: number; y: number }, angle: number, me: ServerShip | undefined): void {
    if (!me || me.kind !== "attack" || me.anchored || me.landingPhase !== "" || me.weapon === "mine") return;
    let target: { x: number; y: number } | null = null;
    if (me.aimTarget) {
      const rv = this.remotes.get(me.aimTarget);
      const st = this.serverStructures.get(me.aimTarget);
      const dr = me.aimTarget.startsWith("drone:") ? this.serverDrones.get(me.aimTarget.slice(6)) : undefined;
      if (rv?.initialized) target = { x: rv.rx, y: rv.ry };
      else if (st) target = this.toRender(st);
      else if (dr) target = this.toRender(dr);
    }
    const d = target ? Math.hypot(target.x - own.x, target.y - own.y) : AIM_IDLE_DIST;
    for (const g of this.gunAims(me, own, angle, d)) this.effectsRenderer.drawAim(g.x, g.y, AIM_SIZE, g.locked);
    const locked = me.aimLocked || (me.weapon === "laser" && me.aimLocked2);
    if (target) this.effectsRenderer.drawTargetBrackets(target.x, target.y, AIM_SIZE * 2.6, locked);
  }

  /**
   * Para onde mira cada arma, a `d` u à frente: o míssil, uma mira pelo nariz
   * mais o desvio; o laser, DUAS — uma por canhão, cada uma da sua asa
   * (shared laserMount) e com o próprio desvio e travamento.
   */
  private gunAims(me: ServerShip, own: { x: number; y: number }, angle: number, d: number): Array<{ x: number; y: number; locked: boolean }> {
    const aim = (ox: number, oy: number, offset: number, locked: boolean) => {
      const a = angle + offset;
      return { x: own.x + ox + Math.cos(a) * d, y: own.y + oy + Math.sin(a) * d, locked };
    };
    if (me.weapon !== "laser") return [aim(0, 0, me.aimOffset, me.aimLocked)];
    return [[me.aimOffset, me.aimLocked], [me.aimOffset2, me.aimLocked2]].map(([o, l], i) => {
      const m = laserMount(angle, i);
      return aim(m.dx, m.dy, o as number, l as boolean);
    });
  }

  /**
   * MODO ATAQUE na predição: a mesma tradução que o servidor aplica
   * (sim-core attackModeInput — nariz travado na estação, A/D circulam).
   * Ao servidor vai sempre o comando CRU; ele traduz do lado de lá.
   */
  private attackTranslated(input: ShipInput): ShipInput {
    const me = this.serverShips.get(this.myShipId);
    const st = me?.attackTarget === WORM_HOLE_ID ? this.wormHoleSite() ?? undefined
      : me?.attackTarget ? this.serverStructures.get(me.attackTarget) : undefined;
    if (!me || !st || !this.localShip) return input;
    return attackModeInput(this.localShip, st, me.attackRadius, input);
  }

  /**
   * Explosão anunciada pelo servidor, em QUEM recebeu o dano (FxEvent.on):
   * o tamanho vem do alvo — parte da nave ou do prédio atingido; na vaga, a
   * nave guardada que o sorteio do dano escolheu.
   */
  private spawnExplosion(ev: FxEvent): void {
    const down = ev.kind === "shipDown" || ev.kind === "structureDown";
    let radius: number;
    if (ev.on === "ship" && ev.id) {
      const len = shipMeshData(this.serverShips.get(ev.id)?.kind ?? "attack").length;
      radius = len * (down ? EXPLOSION_SHIP_DOWN : EXPLOSION_SHIP_HIT);
    } else if (ev.on === "structure" && ev.id) {
      const st = this.serverStructures.get(ev.id);
      const r = st ? STRUCTURE_SPECS[st.stype].radius : 100;
      radius = r * (down ? EXPLOSION_STRUCT_DOWN : EXPLOSION_STRUCT_HIT);
    } else if (ev.on === "bay") {
      radius = down ? EXPLOSION_BAY_DOWN : EXPLOSION_BAY_HIT;
    } else {
      radius = ev.kind === "blast" ? EXPLOSION_BLAST : 60;
    }
    this.explosions.push({
      handle: this.explosionRenderer.spawn(radius),
      pos: { sx: ev.sx, sy: ev.sy, x: ev.x, y: ev.y },
      on: ev.on, id: ev.id, radius,
    });
  }

  /**
   * Reposiciona as explosões (origem flutuante; a nave atingida leva a dela
   * junto) e anima. A profundidade é a do alvo: a malha da nave, ou um
   * pouco acima do chão da plataforma — o fogo engloba a base do prédio.
   */
  private placeExplosions(own: { x: number; y: number }): void {
    for (const e of this.explosions) {
      let p = this.toRender(e.pos);
      let z = EFFECTS_LAYER_Z;
      let inflate = 1;
      if (e.on === "ship" && e.id) {
        const s = this.serverShips.get(e.id);
        if (s) {
          e.pos = { sx: s.sx, sy: s.sy, x: s.x, y: s.y };
          p = this.renderPosOf(e.id, own) ?? this.toRender(e.pos);
          inflate = this.shipRenderer.displayScale(e.id, s.kind);
        }
        z = this.shipRenderer.poseZ(e.id) ?? SHIP_LAYER_Z;
      } else if ((e.on === "structure" || e.on === "bay") && e.id) {
        const floor = this.structureRenderer.platformZ(e.id);
        if (floor !== null) z = floor - e.radius * 0.35;
      }
      const v = toScene(p.x, p.y);
      v.z = z;
      e.handle.place(v, inflate);
    }
    this.explosionRenderer.tick();
    this.explosions = this.explosions.filter((e) => !e.handle.done);
  }

  /**
   * Profundidade da malha de uma nave atracada/pousada: desce da camada de
   * voo até o chão da plataforma conforme `dock` (0..1, a mesma suavização
   * do encolhimento na vaga). Em voo, undefined (a camada de voo).
   */
  private dockedZ(s: ServerShip, dock: number): number | undefined {
    if (dock <= 0) return undefined;
    const floor = this.dockFloorZ(s);
    if (floor === null) return undefined;
    return SHIP_LAYER_Z + (floor - DOCK_HULL_LIFT - SHIP_LAYER_Z) * dock;
  }

  /** Profundidade de cena de uma nave (malha) ou estrutura (sobre o chão); senão `fallback`. */
  private depthOf(id: string, fallback: number): number {
    if (!id) return fallback;
    const z = this.shipRenderer.poseZ(id);
    if (z !== null) return z;
    const floor = this.structureRenderer.platformZ(id);
    return floor !== null ? floor - FP_ATTACK_AIM_LIFT : fallback;
  }

  /**
   * Retículos dos canhões do laser no cockpit em tela cheia: o ponto para
   * onde cada canhão mira (à distância e na altura do alvo) projetado pela
   * câmera do cockpit — sai do centro e anda até o alvo junto com a mira.
   * Míssil e mina: nenhum (só o crosshair central).
   */
  private cockpitGunReticles(me: ServerShip | undefined, own: { x: number; y: number }, angle: number) {
    if (!me || me.kind !== "attack" || me.weapon !== "laser" || me.anchored || me.landingPhase !== "") return null;
    let d = AIM_IDLE_DIST;
    let z = this.shipRenderer.poseZ(this.myShipId) ?? SHIP_LAYER_Z;
    if (me.aimTarget) {
      const rv = this.remotes.get(me.aimTarget);
      const st = this.serverStructures.get(me.aimTarget);
      const t = rv?.initialized ? { x: rv.rx, y: rv.ry } : st ? this.toRender(st) : null;
      if (t) {
        d = Math.hypot(t.x - own.x, t.y - own.y);
        z = this.depthOf(me.aimTarget, z);
      }
    }
    const w = this.engine.getRenderWidth();
    const h = this.engine.getRenderHeight();
    const vp = this.fpCamera.viewport.toGlobal(w, h);
    const vpm = this.fpCamera.getViewMatrix(true).multiply(this.fpCamera.getProjectionMatrix(true));
    return this.gunAims(me, own, angle, d).map((g) => {
      const p = toScene(g.x, g.y);
      p.z = z;
      const s = Vector3.Project(p, Matrix.IdentityReadOnly, vpm, vp);
      if (s.z < 0 || s.z > 1) return null; // atrás da câmera
      return { xPct: (s.x / w) * 100, yPct: (s.y / h) * 100, locked: g.locked };
    });
  }

  /**
   * Contatos do radar do painel: naves (frota própria / inimigas), estruturas
   * e tiros em volta, na moldura da nave — frente para cima.
   */
  private radarBlips(angle: number): RadarBlip[] {
    const me = this.localShip;
    if (!me) return [];
    const c = Math.cos(angle), s = Math.sin(angle);
    const out: RadarBlip[] = [];
    const add = (p: WorldPos, kind: RadarBlip["kind"]) => {
      const { dx, dy } = relVec(me, p);
      out.push({ fwd: dx * c + dy * s, right: -dx * s + dy * c, kind });
    };
    for (const [id, sh] of this.serverShips) {
      if (id === this.myShipId || sh.stored) continue;
      add(sh, sh.owner === this.room.sessionId ? "fleet" : "enemy");
    }
    for (const st of this.serverStructures.values()) add(st, st.owner === this.room.sessionId ? "ownStructure" : "enemyStructure");
    for (const p of this.serverProjectiles.values()) add(p, "shot");
    for (const d of this.serverDrones.values()) add(d, d.owner === this.room.sessionId ? "fleet" : "enemy");
    for (const w of this.serverWorms.values()) w.segs.forEach((s, i) => { if (i % 3 === 0) add(s, i === 0 ? "wormHead" : "worm"); });
    const hole = this.wormHoleSite();
    if (hole) add(hole, "wormHead");
    return out;
  }

  /**
   * z de cena da superfície do corpo (Ceres ou rocha) sob `p` — a esfera do
   * corpo vista de cima —, ou null no vácuo. É onde a minhoca se enterra.
   */
  private groundZ(p: WorldPos): number | null {
    const body = wormBodyAt(this.worldSeed, p);
    if (!body) return null;
    const zc = body.id === "ceres"
      ? this.planetRenderer.centerZ() ?? CERES_RADIUS - ROCK_FRONT_REACH
      : this.asteroidRenderer.centerZ(body.id) ?? body.radius * 1.07 - ROCK_FRONT_REACH;
    return zc - Math.sqrt(Math.max(0, body.radius * body.radius - body.d * body.d));
  }

  /** Centro da toca aberta das minhocas (a plataforma dela), ou null. */
  private wormHoleSite(): (WorldPos & { radius: number }) | null {
    if (!this.wormHole) return null;
    const pad = ceresPlatforms(this.worldSeed).find((p) => p.id === this.wormHole);
    return pad ? { ...ceresPlatformPos(this.worldSeed, pad), radius: pad.radius } : null;
  }

  /** Nave própria na zona da toca (a do [F] modo ataque sobre ela)? */
  private nearWormHole(): boolean {
    const site = this.wormHoleSite();
    return !!site && !!this.localShip && dist(this.localShip, site) <= site.radius + ATTACK_ZONE_MARGIN;
  }

  /** Teto do zoom agora: maior com a nave própria atracada numa vaga ou pousada. */
  private zoomMax(): number {
    const me = this.serverShips.get(this.myShipId);
    if (!me) return this.myStation ? ZOOM_MAX_DOCKED : ZOOM_MAX;
    return me.anchored || me.landingPhase === "landed" ? ZOOM_MAX_DOCKED : ZOOM_MAX;
  }

  /**
   * A PÉ numa estação (sem nave — pôs a mineradora para autominerar, ou
   * chegou de escape pod): a câmera fica na estação e o mundo segue. [T]/[Y]
   * escolhem e chamam um táxi de qualquer hangar (ao chegar, o piloto
   * embarca), [C] embarca numa nave guardada ali e, num QG, [3]–[6] fabricam.
   */
  private updateOnFoot(dt: number): void {
    const st = this.serverStructures.get(this.myStation);
    const l = this.localShip!;
    if (st) Object.assign(l, { sx: st.sx, sy: st.sy, x: st.x, y: st.y, vx: 0, vy: 0, av: 0 });
    this.taxiOpts = this.computeTaxiOptions();
    if (this.taxiOpts.length > 0) this.taxiSel %= this.taxiOpts.length;
    else this.taxiSel = 0;
    if (this.keys.justDown("T") && this.taxiOpts.length > 0) this.taxiSel = (this.taxiSel + 1) % this.taxiOpts.length;
    if (this.keys.justDown("Y") && this.taxiOpts.length > 0) this.room.send(MSG_TAXI, { shipId: this.taxiOpts[this.taxiSel].id });
    if (this.keys.justDown("C")) this.room.send(MSG_SWAP);
    if (st?.stype === "hq") {
      const make: Array<["THREE" | "FOUR" | "FIVE" | "SIX", ProduceCommand["kind"]]> = [
        ["THREE", "mining"], ["FOUR", "attack"], ["FIVE", "builder"], ["SIX", "transport"],
      ];
      for (const [key, kind] of make) if (this.keys.justDown(key)) this.room.send(MSG_PRODUCE, { kind });
    }
    if (this.keys.justDown("M")) this.minimapFull = !this.minimapFull;
    if (this.keys.justDown("N")) this.sound.toggleMute();
    if (this.keys.isDown("PLUS")) this.zoomTarget = Math.min(this.zoomTarget * ZOOM_KEY_STEP, this.zoomMax());
    if (this.keys.isDown("MINUS")) this.zoomTarget = Math.max(this.zoomTarget / ZOOM_KEY_STEP, ZOOM_MIN);
    this.zoom = lerp(this.zoom, this.zoomTarget, ZOOM_SMOOTH);
    this.updateOrtho();
    if (l.sx !== this.origin.sx || l.sy !== this.origin.sy) this.setOrigin(l.sx, l.sy);
    this.draw(dt, undefined, new SimWorld(this.worldSeed));
  }

  /** Fim de jogo: mostra a tela com o tempo e o que foi construído. */
  private onEliminated(): void {
    const label: Record<string, string> = {
      initialBase: "base inicial", hq: "QG", miningStation: "estação de mineração", rationCenter: "centro de rações",
      builder: "builder", mining: "nave de mineração", attack: "nave de ataque", transport: "nave de transporte",
    };
    const lines: string[] = [];
    try {
      const s = JSON.parse(this.summary || "{}") as { built?: Record<string, number>; produced?: Record<string, number>; turrets?: number; ruins?: number };
      for (const [k, n] of Object.entries(s.built ?? {})) lines.push(`${n}× ${label[k] ?? k} construída(s)`);
      for (const [k, n] of Object.entries(s.produced ?? {})) lines.push(`${n}× ${label[k] ?? k} fabricada(s)`);
      if (s.turrets) lines.push(`${s.turrets}× turreta(s)`);
      if (s.ruins) lines.push(`${s.ruins} estrutura(s) ficaram como ruínas`);
    } catch {
      /* resumo ilegível: só o tempo */
    }
    this.hudRenderer.showEndScreen({ survival: this.survival, lines },
      () => {
        this.spectating = true;
        this.hudRenderer.hideEndScreen();
        this.updateSpectatorBanner();
      },
      () => this.room.send(MSG_RESTART));
  }

  /** Faixa do espectador com a vista e a camada atuais. */
  private updateSpectatorBanner(): void {
    const view = this.cockpitFull ? "primeira pessoa" : "de cima";
    const layer = this.spectLayer === "cruise" ? "cruzeiro" : "superfície";
    this.hudRenderer.setSpectatorBanner(
      `ESPECTADOR · WASD/setas movem · [V] vista: ${view} · [F] camada: ${layer} · [R] recomeçar`);
  }

  /**
   * Modo espectador (ou atrás da tela de fim): sem nave, a câmera voa solta
   * — WASD/setas, mais rápida no zoom afastado — e o mundo segue sendo
   * desenhado. [V] alterna a vista de cima ↔ primeira pessoa (os viewports,
   * como na nave); [F] alterna a camada do olho (cruzeiro ↔ superfície). Na
   * primeira pessoa, W/S andam para a frente/trás e A/D viram. [R] recomeça.
   */
  private updateSpectator(dt: number): void {
    const l = this.localShip!;
    if (this.spectating) {
      const v = SPECTATOR_SPEED / this.zoom;
      const k = (a: KeyName, b: KeyName) => (this.keys.isDown(a) || this.keys.isDown(b) ? 1 : 0);
      if (this.cockpitFull) {
        // primeira pessoa: anda no rumo do olho e vira com A/D
        this.spectHeading += (k("D", "RIGHT") - k("A", "LEFT")) * SPECTATOR_TURN_RATE * dt;
        const f = (k("W", "UP") - k("S", "S")) * v * dt;
        l.x += Math.cos(this.spectHeading) * f;
        l.y += Math.sin(this.spectHeading) * f;
      } else {
        const mx = k("D", "RIGHT") - k("A", "LEFT");
        const my = k("S", "S") - k("W", "UP");
        l.x += mx * v * dt;
        l.y += my * v * dt;
        // o olho de primeira pessoa olha para onde a câmera anda
        if (mx || my) this.spectHeading = Math.atan2(my, mx);
      }
      normalizePos(l);
      if (this.keys.justDown("V")) {
        this.setCockpitFull(!this.cockpitFull);
        this.updateSpectatorBanner();
      }
      if (this.keys.justDown("F")) {
        this.spectLayer = this.spectLayer === "cruise" ? "surface" : "cruise";
        this.updateSpectatorBanner();
      }
      if (this.keys.justDown("R")) this.room.send(MSG_RESTART);
    }
    this.spectAlt += ((this.spectLayer === "cruise" ? 1 : 0) - this.spectAlt) * Math.min(1, dt * 3);
    l.vx = 0;
    l.vy = 0;
    if (this.keys.isDown("PLUS")) this.zoomTarget = Math.min(this.zoomTarget * ZOOM_KEY_STEP, ZOOM_MAX);
    if (this.keys.isDown("MINUS")) this.zoomTarget = Math.max(this.zoomTarget / ZOOM_KEY_STEP, ZOOM_MIN);
    this.zoom = lerp(this.zoom, this.zoomTarget, ZOOM_SMOOTH);
    this.updateOrtho();
    if (l.sx !== this.origin.sx || l.sy !== this.origin.sy) this.setOrigin(l.sx, l.sy);
    this.draw(dt, undefined, new SimWorld(this.worldSeed));
  }

  /** Posição de render de uma nave: a predita (a minha), a suavizada (remota) ou a do servidor. */
  private renderPosOf(shipId: string, own: { x: number; y: number }): { x: number; y: number } | null {
    if (shipId === this.myShipId) return own;
    const rv = this.remotes.get(shipId);
    if (rv?.initialized) return { x: rv.rx, y: rv.ry };
    const s = this.serverShips.get(shipId);
    return s ? this.toRender(s) : null;
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
    // onde o piloto está: a pé numa estação, ou atracado
    const here = this.myStation || this.serverShips.get(this.myShipId)?.hqId || "";
    for (const [id, s] of this.serverShips) {
      if (s.owner !== this.room.sessionId || !s.stored) continue;
      const src = this.serverStructures.get(s.hqId);
      if (!src || src.owner !== this.room.sessionId || s.hqId === here) continue;
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
    // pelo VIEWPORT da câmera, não pelo canvas: na vista de cockpit a
    // principal vira o quadro pequeno, e o enquadramento tem de manter px por
    // unidade = zoom e o formato do quadro (senão a vista de cima esticaria)
    const vp = this.camera.viewport;
    const halfW = (this.engine.getRenderWidth() * vp.width) / (2 * this.zoom);
    const halfH = (this.engine.getRenderHeight() * vp.height) / (2 * this.zoom);
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
    if (!mineServer) {
      // encerrado: o mundo segue (modo espectador, ou atrás da tela de fim)
      if (this.eliminated && this.localShip) this.updateSpectator(dt);
      else if (this.myStation && this.localShip) this.updateOnFoot(dt);
      return;
    }
    if (this.localShipId !== this.myShipId) this.initActiveShip(mineServer);
    if (!this.localShip) return;
    // a camada da nave própria segue a do servidor (quem troca de camada é o
    // servidor): sem isto a predição voava em cruzeiro atravessando a rocha
    // que a nave de verdade, na superfície, encontrava — e o blend puxava a
    // nave de volta de uma batida que a tela não mostrou
    syncLayer(this.localShip, mineServer, SNAPSHOT_AGE_FIXED_GUESS);

    // zoom por teclas +/- e suavização em direção ao alvo
    if (this.keys.isDown("PLUS")) {
      this.zoomTarget = Math.min(this.zoomTarget * ZOOM_KEY_STEP, this.zoomMax());
    }
    // ao decolar, o teto volta a 0.25x — o zoom recua suavemente até ele
    this.zoomTarget = Math.min(this.zoomTarget, this.zoomMax());
    if (this.keys.isDown("MINUS")) {
      this.zoomTarget = Math.max(this.zoomTarget / ZOOM_KEY_STEP, ZOOM_MIN);
    }
    this.zoom = lerp(this.zoom, this.zoomTarget, ZOOM_SMOOTH);
    this.updateOrtho();
    // [V] alterna a vista: de cima ↔ cockpit em tela cheia (vale pousada também)
    if (this.keys.justDown("V")) this.setCockpitFull(!this.cockpitFull);

    // construção, produção e ancoragem (autoritativas no servidor)
    const landingPhase = mineServer.landingPhase ?? "";
    const isLanding = landingPhase === "landing";
    const isLanded = landingPhase === "landed";

    if (this.keys.justDown("M")) {
      this.minimapFull = !this.minimapFull;
    }
    if (this.keys.justDown("N")) this.sound.toggleMute();
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
      // plataforma de Ceres: pousa-se nela como num asteroide vazio
      if (!this.inLandZone && this.nearCeresPad(DOCK_RANGE)) this.inLandZone = true;
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
      // [E] carga/descarga do transporte pousado (contexto no servidor);
      // no builder atracado, enche o porão de minério
      if ((mineServer.kind === "builder" ||
        ((mineServer.kind === "transport" || mineServer.kind === "mining") && mineServer.anchored))
        && this.keys.justDown("E")) {
        this.room.send(MSG_CARGO);
      }
      // builder atracado: troca minério e kits com o buffer da estrutura; [J]
      // rações (carrega na base/central, descarrega na estação/QG — o servidor decide)
      if (mineServer.kind === "builder" && mineServer.anchored) {
        const moves = [["O", "ore", "withdraw"], ["P", "ore", "deposit"], ["K", "kits", "withdraw"], ["L", "kits", "deposit"], ["J", "rations", "withdraw"]] as const;
        for (const [key, item, dir] of moves) if (this.keys.justDown(key)) this.room.send(MSG_TRANSFER, { item, dir });
      }
      // [1]/[2]/[3] builder atracado na central de rações: melhorias dos drones
      if (mineServer.kind === "builder" && mineServer.anchored &&
        this.serverStructures.get(mineServer.hqId)?.stype === "rationCenter") {
        const tracks = [["ONE", "drones"], ["TWO", "speed"], ["THREE", "cargo"]] as const;
        for (const [key, track] of tracks) if (this.keys.justDown(key)) this.room.send(MSG_DRONE_UPGRADE, { track });
      }
      // [B] builder atracado: constrói uma turreta (o servidor valida tudo)
      if (mineServer.kind === "builder" && mineServer.anchored && this.keys.justDown("B")) {
        this.room.send(MSG_TURRET);
      }
      // ARMAMENTO da nave de ataque em voo: [1] mísseis, [2] laser, [3] minas
      // (pousada, 1/2/3 continuam sendo os menus de construir/produzir).
      // SPACE dispara a arma selecionada; segurado, repete mísseis e laser
      if (mineServer.kind === "attack" && !mineServer.anchored) {
        for (const [key, weapon] of WEAPON_KEYS) {
          if (this.keys.justDown(key)) this.room.send(MSG_WEAPON, { weapon });
        }
        const now = performance.now() / 1000;
        const pressed = this.keys.justDown("SPACE");
        const repeat = mineServer.weapon !== "mine" && this.keys.isDown("SPACE") && now >= this.nextFireAt;
        if (pressed || repeat) {
          this.room.send(MSG_FIRE);
          this.nextFireAt = now + FIRE_REPEAT;
        }
      }
      // [U] evolui a estação de mineração de Ceres (o servidor valida tudo)
      if (this.keys.justDown("U")) {
        this.room.send(MSG_UPGRADE);
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
      // o builder refina o porão enquanto minera
      if (mineServer.kind === "builder" && this.keys.justDown("E")) this.room.send(MSG_CARGO);
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
    // no escape pod o servidor pilota: a nave própria só acompanha o estado dele
    const podRide = mineServer.kind === "pod";
    const frozen = anchored || isLanding || isLanded || podRide;

    // input → predição local (mesmo passo de física do servidor) → envio
    const input = frozen ? { thrust: false, turn: 0 as const, mine: false } : this.readInput();
    if (podRide) {
      const l = this.localShip;
      Object.assign(l, { sx: mineServer.sx, sy: mineServer.sy, x: mineServer.x, y: mineServer.y, vx: mineServer.vx, vy: mineServer.vy, angle: mineServer.angle, av: mineServer.av });
    } else if (frozen) {
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
      stepShipInWorld(this.localShip, this.attackTranslated(input), dt, 1, {
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
    this.soundDirector.setThrust(input.thrust ? 1 : 0);
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
   * Plataforma de Ceres mais próxima cuja borda está a até `maxEdge` da nave
   * própria (shared/ceres.ts — posições fixas, as mesmas do servidor).
   */
  private nearCeresPad(maxEdge: number): { pos: WorldPos; radius: number } | null {
    if (!this.localShip) return null;
    let best: { pos: WorldPos; radius: number } | null = null;
    let bestEdge = maxEdge;
    for (const p of ceresPlatforms(this.worldSeed)) {
      if (p.id === this.wormHole) continue; // a toca das minhocas não aceita pouso
      const pos = ceresPlatformPos(this.worldSeed, p);
      const edge = dist(this.localShip, pos) - p.radius;
      if (edge <= bestEdge) {
        bestEdge = edge;
        best = { pos, radius: p.radius };
      }
    }
    return best;
  }

  /**
   * z de cena do chão em que a nave própria está atracada (ou pousando): a
   * base do prédio da estrutura, ou a plataforma do asteroide vazio.
   */
  private dockFloorZ(s: ServerShip): number | null {
    if (s.hqId) return this.structureRenderer.platformZ(s.hqId);
    if (s.anchoredAsteroidId.startsWith(CERES_PLATFORM_PREFIX)) return this.planetRenderer.platformZ(s.anchoredAsteroidId);
    if (s.anchoredAsteroidId) return this.asteroidRenderer.platformZ(s.anchoredAsteroidId);
    return null;
  }

  /** O que o dashboard de carga do cockpit mostra para a nave `s`. */
  private cargoDashboard(s: ServerShip | undefined): CargoDashboard | null {
    if (!s) return null;
    const ore = s.cargoKind === "ore" ? s.cargoAmount : 0;
    const builder = s.kind === "builder";
    const transport = s.kind === "transport";
    return {
      kind: s.kind,
      ore,
      oreCap: builder ? BUILDER_ITEM_CAP : s.kind === "mining" ? SHIP_ORE_HOLD : transport ? TRANSPORT_CARGO_CAP : 0,
      rations: builder ? s.rations : s.cargoKind === "rations" ? s.cargoAmount : 0,
      rationsCap: builder ? BUILDER_ITEM_CAP : transport ? TRANSPORT_CARGO_CAP : 0,
      kits: builder ? s.kits : 0,
      kitsCap: builder ? BUILDER_ITEM_CAP : 0,
      holdCap: builder ? BUILDER_HOLD_TOTAL : 0,
      refineQueue: builder ? s.refineQueue : 0,
      refineProgress: s.refineProgress,
      refineTime: REFINE_TIME,
      refineOre: REFINE_ORE,
      refineKits: REFINE_KITS,
    };
  }

  /** Liga/desliga a vista de cockpit em tela cheia (ver `cockpitFull`). */
  private setCockpitFull(on: boolean): void {
    this.cockpitFull = on;
    const full = { x: 0, y: 0, w: 1, h: 1 };
    const inset = { x: FP_VIEW.left, y: FP_VIEW.bottom, w: FP_VIEW.width, h: FP_VIEW.height };
    // em tela cheia a vista de cima vai para a TELA do painel da cabine
    const panel = { x: PANEL_SCREEN.left, y: PANEL_SCREEN.bottom, w: PANEL_SCREEN.width, h: PANEL_SCREEN.height };
    const put = (cam: Camera, v: typeof full) => {
      cam.viewport.x = v.x;
      cam.viewport.y = v.y;
      cam.viewport.width = v.w;
      cam.viewport.height = v.h;
    };
    put(this.fpCamera, on ? full : inset);
    put(this.camera, on ? panel : full);
    // a moldura DOM é a do quadro pequeno; em tela cheia a moldura é a do painel
    this.hudRenderer.setCockpitFrameVisible(!on);
    // quem desenha por último fica por cima: o quadro pequeno vai depois
    this.bScene.activeCameras = on ? [this.fpCamera, this.camera] : [this.camera, this.fpCamera];
    this.setGlowCamera(on ? this.fpCamera : this.camera);
    this.updateOrtho();
    this.hudRenderer.setReticle(on);
    this.backdrop.setCockpitFull(on);
  }

  /**
   * Prende o brilho (GlowLayer) a outra câmera. O Babylon não expõe a troca:
   * a câmera mora nas opções da camada, na textura principal e no
   * renderizador de objetos — os três precisam apontar para a mesma, senão o
   * mapa de brilho é desenhado de um ponto de vista e composto em outro.
   */
  private setGlowCamera(cam: Camera): void {
    const g = this.glow as unknown as {
      _thinEffectLayer: { camera: Camera; _objectRenderer?: { activeCamera: Camera } };
      _effectLayerOptions?: { camera: Camera };
      _mainTexture?: { activeCamera: Camera };
    };
    g._thinEffectLayer.camera = cam;
    if (g._effectLayerOptions) g._effectLayerOptions.camera = cam;
    if (g._mainTexture) g._mainTexture.activeCamera = cam;
    if (g._thinEffectLayer._objectRenderer) g._thinEffectLayer._objectRenderer.activeCamera = cam;
  }

  /**
   * Rotação do olho do cockpit no quadro local da nave: visada (+Z da câmera)
   * → nariz (+X) e topo da câmera (+Y) → −Z (em direção à câmera principal),
   * com `pitch` (rad, positivo = para cima) em torno do eixo direito local.
   * Quaternion explícito: Quaternion.FromLookDirectionLH devolve a visada
   * INVERTIDA para este par (validado ao vivo — olhava pela cauda); o sinal do
   * pitch também foi validado ao vivo.
   */
  private fpRotation(pitch: number, yaw = 0): Quaternion {
    const base = new Quaternion(0.5, -0.5, 0.5, -0.5);
    // rumo em torno do "para cima" da câmera (+yaw vira para o lado −y da cabine)
    return base
      .multiply(Quaternion.RotationAxis(new Vector3(0, 1, 0), yaw))
      .multiply(Quaternion.RotationAxis(new Vector3(1, 0, 0), -pitch));
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
      kind: this.localShip!.kind, tint: COLOR_OWN, visible: !this.eliminated && !!mineAuth,
      scale: ownPresence?.scale,
      z: mineAuth ? this.dockedZ(mineAuth, ownPresence?.dock ?? 0) : undefined,
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
    // espectador: a nave eliminada pode seguir registrada (escondida) — a
    // câmera de primeira pessoa vai para o suporte do espectador, não para ela
    const cockpit = this.spectating ? null : this.shipRenderer.getCockpit(this.myShipId);
    if (cockpit) {
      if (this.fpCamera.parent !== cockpit.root) this.fpCamera.parent = cockpit.root;
      // altura e inclinação do olho pela altitude aparente (cruzeiro ↔ superfície)
      const alt = ownPresence?.altitude ?? 1;
      const dock = ownPresence?.dock ?? 0;
      let dz = -FP_CRUISE_LIFT * alt + FP_SURFACE_DROP * (1 - alt);
      // atracada: o olho desce até a altura REAL da plataforma — ela fica bem
      // abaixo do plano das naves, e dali o prédio passaria por baixo do visor
      const floor = mineAuth ? this.dockFloorZ(mineAuth) : null;
      if (floor !== null && dock > 0) {
        const dockDz = floor - FP_DOCK_EYE_HEIGHT - cockpit.root.position.z - cockpit.eye.z;
        dz += (dockDz - dz) * dock;
      }
      // modo ataque: olho acima da estação em foco e vista apontada para ela
      const atkId = mineAuth?.attackTarget ?? "";
      if (atkId) this.fpAttackId = atkId;
      this.fpAttack += ((atkId ? 1 : 0) - this.fpAttack) * Math.min(1, dt * FP_ATTACK_BLEND_RATE);
      const atkHole = this.fpAttackId === WORM_HOLE_ID;
      const atkSt = this.fpAttack <= 0.001 ? undefined
        : atkHole ? this.wormHoleSite() ?? undefined : this.serverStructures.get(this.fpAttackId);
      const atkFloor = !atkSt ? null
        : atkHole ? this.planetRenderer.platformZ(this.wormHole) : this.structureRenderer.platformZ(this.fpAttackId);
      let look: { yaw: number; pitch: number } | null = null;
      if (atkSt && atkFloor !== null) {
        const eyeZ = atkFloor - FP_ATTACK_EYE_HEIGHT;
        dz += (eyeZ - cockpit.root.position.z - cockpit.eye.z - dz) * this.fpAttack;
        // o prédio no quadro da cabine (x = nariz, y = lado, −z = para cima)
        const r = this.toRender(atkSt);
        const target = toScene(r.x, r.y);
        target.z = atkFloor - FP_ATTACK_AIM_LIFT;
        const local = Vector3.TransformCoordinates(target, cockpit.root.computeWorldMatrix(true).clone().invert());
        const lx = local.x - cockpit.eye.x;
        const ly = local.y - cockpit.eye.y;
        const lz = local.z - (cockpit.eye.z + dz);
        look = { yaw: -Math.atan2(ly, lx), pitch: Math.atan2(-lz, Math.hypot(lx, ly)) };
      }
      this.fpCamera.position.copyFromFloats(cockpit.eye.x, cockpit.eye.y, cockpit.eye.z + dz);
      this.fpPitch = FP_SURFACE_PITCH + (FP_CRUISE_PITCH - FP_SURFACE_PITCH) * alt;
      let yaw = 0;
      if (look) {
        this.fpPitch += (look.pitch - this.fpPitch) * this.fpAttack;
        yaw = look.yaw * this.fpAttack;
      }
      this.fpCamera.rotationQuaternion = this.fpRotation(this.fpPitch, yaw);
      // crosshair principal fixo no CENTRO da tela (setCockpitFull); no laser,
      // os retículos de cada canhão andam do centro até o alvo
      this.hudRenderer.setGunReticles(this.cockpitFull ? this.cockpitGunReticles(mineAuth, own, ownAngle) : null);
      // farol na mesma cabine, emitindo pelo nariz (direção +X já fixada)
      if (this.headlight.parent !== cockpit.root) this.headlight.parent = cockpit.root;
      this.headlight.position.copyFromFloats(cockpit.eye.x, cockpit.eye.y, cockpit.eye.z);
    } else if (this.spectating) {
      // ESPECTADOR: sem cabine, o olho mora num suporte no ponto da câmera,
      // virado para o rumo do espectador, na altura da camada escolhida ([F])
      this.spectRig ??= new TransformNode("spectRig", this.bScene);
      if (this.fpCamera.parent !== this.spectRig) this.fpCamera.parent = this.spectRig;
      this.spectRig.position.set(camPos.x, camPos.y, SHIP_LAYER_Z);
      this.spectRig.rotation.z = toSceneAngle(this.spectHeading);
      const alt = this.spectAlt;
      this.fpCamera.position.copyFromFloats(0, 0, -FP_CRUISE_LIFT * alt + FP_SURFACE_DROP * (1 - alt));
      this.fpPitch = FP_SURFACE_PITCH + (FP_CRUISE_PITCH - FP_SURFACE_PITCH) * alt;
      this.fpCamera.rotationQuaternion = this.fpRotation(this.fpPitch);
      this.hudRenderer.setGunReticles(null);
    }
    // interior da cabine: completo em tela cheia, estático no quadro pequeno
    {
      const vp = this.fpCamera.viewport;
      const aspect = (vp.width * this.engine.getRenderWidth()) / Math.max(1, vp.height * this.engine.getRenderHeight());
      this.cockpitInterior.layout(this.cockpitFull, aspect, !!cockpit || this.spectating);
      if (this.cockpitFull) {
        this.cockpitInterior.updateRadar(this.radarBlips(!cockpit && this.spectating ? this.spectHeading : ownAngle), tt);
        this.cockpitInterior.updateDashboard(this.cargoDashboard(mineAuth), tt);
      }
    }

    const zoom = this.zoom;

    // Ceres: posição e rotação via renderer
    if (this.ceres) {
      const cp = this.toRender(this.ceres);
      this.planetRenderer.tick(cp);
    }

    // início do frame de efeitos
    this.effectsRenderer.beginFrame();
    this.beamRenderer.begin();

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
        scale: pres.scale,
        z: this.dockedZ(server, pres.dock),
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
      const attach = !st.asteroidId ? null
        : st.asteroidId.startsWith(CERES_PLATFORM_PREFIX) ? this.planetRenderer.getBuildFace(st.asteroidId)
        : this.asteroidRenderer.getBuildFace(st.asteroidId);
      this.structureRenderer.upsert({
        id, stype: st.stype,
        shipBays: st.shipBays, expandedBays: st.expandedBays,
        own: st.owner === this.room.sessionId,
        ruin: st.owner === RUIN_OWNER,
        angle: st.angle,
        level: st.level,
        // anexos da estação evoluída se espalham pela plataforma de Ceres
        annexArea: st.asteroidId.startsWith(CERES_PLATFORM_PREFIX)
          ? ceresPlatforms(this.worldSeed).find((p) => p.id === st.asteroidId)?.radius ?? 0
          : 0,
        turrets: st.turrets,
        turretBuild: st.turretBuild,
        turretProgress: st.turretProgress,
      }, occupants, attach);
      // obra de turreta: robôs indo e voltando entre o builder e o lugar dela
      if (st.turretBuild >= 0 && st.turretBuilder) {
        const b = this.renderPosOf(st.turretBuilder, this.toRender(this.localShip!));
        if (b) {
          const t = this.toRender(turretWorldPos({ ...st, type: st.stype }, st.turretBuild));
          this.effectsRenderer.drawBuildRobots(b.x, b.y, t.x, t.y, tt);
        }
      }
      // barra de HP: sempre na inimiga; na própria, só quando avariada
      const own = st.owner === this.room.sessionId;
      // ruína: sem energia, sem barra de vida
      if (st.maxHp > 0 && st.owner !== RUIN_OWNER && (!own || st.hp < st.maxHp)) {
        const R = STRUCTURE_SPECS[st.stype].radius;
        const p = this.toRender(st);
        // acima do prédio na tela (y do jogo cresce para baixo)
        this.effectsRenderer.drawHpBar(p.x, p.y - (R + 60), 2.4 * R, st.hp / st.maxHp, own);
      }
    }

    const anchored = authoritative?.anchored ?? this.localShip!.anchored;

    // vaga da nave própria atracada: lâmpadas verdes girando em volta (o [C]
    // troca para a nave da próxima vaga, e o destaque vai junto)
    const dockedIn = authoritative?.anchored && authoritative.hqId ? authoritative.hqId : "";
    this.structureRenderer.highlightBay(dockedIn, dockedIn ? authoritative!.bay : -1, tt);

    // feixe de mineração
    // Todo: alterar para shooting da nave de ataque
    if (authoritative?.mining) {
      const target = frameSim.nearestAsteroid(this.localShip!);
      if (target) {
        const t = this.toRender(target);
        this.effectsRenderer.drawMiningBeam(own.x, own.y, t.x, t.y, tt);
      }
    }

    // drones de ração
    for (const [id, d] of this.serverDrones) {
      const p = this.toRender(d);
      this.droneRenderer.update(id, p.x, p.y, d.angle, d.owner === this.room.sessionId, d.cargo > 0);
    }
    this.droneRenderer.retain(new Set(this.serverDrones.keys()));

    // minhocas gigantes: o chão sob cada gomo (superfície do corpo, ou vácuo)
    for (const [id, w] of this.serverWorms) {
      this.wormRenderer.update(id, {
        pts: w.segs.map((s) => this.toRender(s)),
        ground: w.segs.map((s) => this.groundZ(s)),
        breach: w.breach,
        mouth: w.mouth,
      });
    }
    this.wormRenderer.retain(new Set(this.serverWorms.keys()));
    const holeSite = this.wormHoleSite();
    this.wormRenderer.setHole(holeSite ? {
      ...this.toRender(holeSite),
      z: this.planetRenderer.platformZ(this.wormHole) ?? SHIP_LAYER_Z,
      seal: this.wormHoleSeal,
    } : null);

    // projéteis
    for (const proj of this.serverProjectiles.values()) {
      const pp = this.toRender(proj);
      if (proj.kind === "mine") this.effectsRenderer.drawMine(pp.x, pp.y, proj.armed, tt);
      else this.effectsRenderer.drawMissile(pp.x, pp.y, proj.vx, proj.vy, proj.traveled);
    }
    // traços do laser (só existem com a mira travada: o servidor só
    // dispara travado)
    this.lasers = this.lasers.filter((l) => tt - l.t0 < LASER_FX_DURATION);
    for (const l of this.lasers) {
      const a = this.toRender(l.from);
      const b = this.toRender(l.to);
      const fade = (tt - l.t0) / LASER_FX_DURATION;
      this.effectsRenderer.drawLaser(a.x, a.y, b.x, b.y, fade);
      // o mesmo feixe em 3D, cada ponta na sua altura — visível no cockpit
      const from = toScene(a.x, a.y);
      from.z = this.depthOf(l.src ?? "", SHIP_LAYER_Z);
      const to = toScene(b.x, b.y);
      to.z = this.depthOf(l.id ?? "", SHIP_LAYER_Z);
      this.beamRenderer.beam(from, to, fade);
    }
    this.drawWeaponAim(own, ownAngle, mineAuth);

    this.placeExplosions(own);

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
      } else {
        // perto de uma plataforma de Ceres: o aro de pouso dela
        const pad = this.nearCeresPad(DOCK_RANGE * 2);
        if (pad) {
          const pp = this.toRender(pad.pos);
          this.effectsRenderer.drawLandZone(pp.x, pp.y, pad.radius + DOCK_RANGE, tt);
        }
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
    this.beamRenderer.end();

    // ── coleta de dados para HUD ──
    // não há carteira: o minério mostrado é o do porão da nave ativa
    const ore = mineAuth?.cargoKind === "ore" ? Math.floor(mineAuth.cargoAmount) : 0;
    const activeKind = this.serverShips.get(this.myShipId)?.kind ?? "builder";
    const kindLabel: Record<ShipKind, string> = { builder: "builder", mining: "mineração", attack: "ataque", transport: "transporte", pod: "escape pod" };

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
    const need = !hasHq ? " — needs HQ" : !anchored && !this.myStation ? " — land [F]" : "";
    const hint3 = `[3] ${p3.label} (${p3.cost})${need}`;
    const hint4 = `[4] ${p4.label} (${p4.cost})${need}`;
    const hint5 = `[5] ${p5.label} (${p5.cost})${need}`;
    const hint6 = `[6] ${p6.label} (${p6.cost})${need}`;
    // a pé numa estação (sem nave): pede táxi, embarca ([C]), fabrica no QG
    const onFoot = !mineAuth && this.myStation ? this.serverStructures.get(this.myStation) : undefined;
    const anchoredInHq = (anchored && (() => {
      const hqId = mineAuth?.hqId ?? "";
      const st = this.serverStructures.get(hqId);
      return !!st && st.stype === "hq";
    })()) || onFoot?.stype === "hq";
    // camada de voo da nave própria (a da predição, que segue o servidor)
    const lay = this.localShip!;
    const layerTag = onFoot || anchored || (mineAuth?.landingPhase ?? "") !== "" ? ""
      : lay.layerTo === "cruise" ? "  ▲ CLIMBING"
      : lay.layerTo ? "  ▼ DESCENDING"
      : lay.layer === "attack" && mineAuth?.attackTarget === WORM_HOLE_ID
        ? `  ✖ WORM HOLE · sealed ${this.wormHoleSeal}/${WORM_HOLE_SEAL_MINES} · [3] mines into the hole, then [1] missiles on the mines`
      : lay.layer === "attack" ? "  ✖ STATION ATTACK · A/D circle · W/S approach/retreat"
      : lay.layer === "surface" ? "  ▼ SURFACE"
      : "  ▲ CRUISE";
    // builder em obra de turreta: travado na vaga, sem decolar
    const lockedByTurret = [...this.serverStructures.values()].some((st) => !!this.myShipId && st.turretBuilder === this.myShipId);
    const anchorTag = anchored ? (lockedByTurret ? "  ⚓ LANDED · 🔒 building" : "  ⚓ LANDED · [F] take off") : layerTag;
    const canAnchor = !anchored && this.inLandZone;
    const anchorHint = onFoot ? "" : canAnchor
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
          : activeKind === "attack" && this.nearWormHole() ? "  » [F] attack worm hole"
          : activeKind === "attack" && this.nearEnemyStation() ? "  » [F] attack station"
          : "  » [F] descend"
        : "";
    const hereStored = onFoot ? [...this.serverShips.values()].filter((sh) => sh.stored && sh.hqId === this.myStation).length : 0;
    const swapHint = onFoot
      ? `  ⚓ ON FOOT at ${onFoot.stype === "hq" ? "HQ" : "station"} (no ship)${hereStored > 0 ? `  » [C] board (${hereStored} here)` : ""}`
      : anchored && !this.isFlying && hangarTotal > 0 ? `  » [C] switch (hangar: ${hangarTotal})` : "";
    const canAuto = activeKind === "mining" && anchored && !this.isFlying && nearOwnStation;
    // transporte atracado: [G] entrega automática em laço (estação → base, base → central)
    const dockedAt = anchored ? this.serverStructures.get(mineAuth?.hqId ?? "") : undefined;
    const ownHas = (type: StructureType) => [...this.serverStructures.values()].some((x) => x.owner === this.room.sessionId && x.stype === type);
    const autoRoute = activeKind !== "transport" || !dockedAt || dockedAt.owner !== this.room.sessionId ? ""
      : dockedAt.stype === "miningStation" && ownHas("initialBase") ? "  » [G] auto-deliver ore → base"
      : dockedAt.stype === "initialBase" && ownHas("rationCenter") ? "  » [G] auto-deliver food → food center"
      : "";
    const autoHint = canAuto ? "  » [G] auto-mine in this station" : autoRoute;
    const anchoredStationStruct = anchored ? (() => {
      const st = this.serverStructures.get(mineAuth?.hqId ?? "");
      return (st && st.stype === "miningStation") ? st : null;
    })() : null;
    const builderMining = anchoredStationStruct && (mineAuth?.mining ?? false);
    const stationBufferHint =
      anchoredStationStruct && anchoredStationStruct.owner === this.room.sessionId && activeKind === "builder"
        ? (builderMining ? "  » [ESP] stop mining" : "  » [ESP] start mining")
        : "";
    const anchoredStruct = anchored ? this.serverStructures.get(mineAuth?.hqId ?? "") ?? null : null;
    let storeHint = "";
    if (anchoredStruct?.owner === RUIN_OWNER) {
      storeHint = `  ·  ⚠ RUINS — no power · ${Math.floor(anchoredStruct.oreStore)} ore · ${anchoredStruct.kitStore} kits · food: ${Math.floor(anchoredStruct.rationStore)}`;
    } else if (anchoredStruct) {
      if (anchoredStruct.stype === "miningStation") {
        storeHint = `  ·  Buffer: ${Math.floor(anchoredStruct.oreStore)}/${stationOreCap(anchoredStruct.level)} ore · ${anchoredStruct.kitStore} kits · food: ${Math.floor(anchoredStruct.rationStore)}` +
          `  ·  drill Lv.${anchoredStruct.level} (${DRILL_BASE_RATE * anchoredStruct.level}/s)`;
        if (anchoredStruct.rationStore < 10) storeHint += "  ⚠ no food — machines stopped";
        // evolução (toda estação de mineração; o builder atracado paga em kits)
        const up = stationUpgradeCost(anchoredStruct.level);
        if (activeKind === "builder" && up !== null && anchoredStruct.level < CERES_STATION_MAX_LEVEL) {
          storeHint += `  » [U] upgrade to Lv.${anchoredStruct.level + 1} (${up} kits)`;
        }
      } else if (anchoredStruct.stype === "initialBase") {
        storeHint = `  ·  Base — ${Math.floor(anchoredStruct.oreStore)} ore · ${anchoredStruct.kitStore} kits · food: ${Math.floor(anchoredStruct.rationStore)} (from Earth)`;
      } else if (anchoredStruct.stype === "hq") {
        storeHint = `  ·  HQ — ${Math.floor(anchoredStruct.oreStore)} ore · ${anchoredStruct.kitStore} kits · food: ${Math.floor(anchoredStruct.rationStore)}`;
        if (anchoredStruct.rationStore < 10) storeHint += "  ⚠ no food — no ship production";
      } else if (anchoredStruct.stype === "rationCenter") {
        const lv = { drones: anchoredStruct.droneLv, speed: anchoredStruct.speedLv, cargo: anchoredStruct.cargoLv };
        const ds = droneStats(lv);
        storeHint = `  ·  Food center — store: ${Math.floor(anchoredStruct.rationStore)} · drones ${ds.count} · ×${ds.speed / 900} speed · ${ds.cargo}/trip`;
        if (activeKind === "builder") {
          const up = (key: string, label: string, level: number) => {
            const c = droneUpgradeCost(level);
            return c === null ? `  · ${label} max` : `  » [${key}] ${label} (${c} kits)`;
          };
          storeHint += up("1", "+drone", lv.drones) + up("2", "speed", lv.speed) + up("3", "cargo", lv.cargo);
        }
      }
    }
    let ammoHint = "";
    if (activeKind === "attack") {
      const ammo = mineAuth?.ammo ?? 0;
      const mines = mineAuth?.grenadeAmmo ?? 0;
      const w = mineAuth?.weapon ?? "missile";
      const sel = (k: WeaponKind, label: string) => (w === k ? `▸${label}` : label);
      const locks = (mineAuth?.aimLocked ? 1 : 0) + (mineAuth?.aimLocked2 ? 1 : 0);
      const lock = w === "laser" ? (locks > 0 ? ` LOCK ${locks}/2` : mineAuth?.aimTarget ? " …" : "") : "";
      ammoHint = `  ·  ${sel("missile", `[1] MSL ${ammo}/${MISSILE_AMMO_MAX}`)}  ${sel("laser", "[2] LASER")}${lock}  ${sel("mine", `[3] MINE ${mines}/${MINE_AMMO_MAX}`)}`;
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
    if (activeKind === "mining") {
      cargoHint = `  ·  Hold: ${ore}/${SHIP_ORE_HOLD} ore`;
      if (anchored && ore > 0) cargoHint += "  » [E] unload ore here";
    }
    if (activeKind === "pod") {
      const dest = this.serverStructures.get(mineAuth?.taxiTo ?? "");
      const km = dest && mineAuth ? (dist(mineAuth, dest) / 1000).toFixed(1) : "?";
      cargoHint = `  ·  ⚠ ESCAPE POD → ${dest?.stype === "hq" ? "QG" : "hangar com builder"} (${km} km) — piloto automático`;
    }
    if (activeKind === "builder" && !onFoot) {
      const hold = mineAuth?.kits ?? 0;
      const food = mineAuth?.rations ?? 0;
      cargoHint = `  ·  Hold: ${ore} ore · ${hold} kits · ${food} food — ${ore + hold + food}/${BUILDER_HOLD_TOTAL} (max ${BUILDER_ITEM_CAP} each)`;
      const queue = mineAuth?.refineQueue ?? 0;
      if (queue > 0) cargoHint += `  ·  ⚙ refining ${Math.floor((mineAuth?.refineProgress ?? 0) * 100)}% (${queue} batch${queue > 1 ? "es" : ""})`;
      if (ore >= REFINE_ORE && mineAuth && holdRoom(mineAuth, "kits") >= (queue + 1) * REFINE_KITS) cargoHint += `  » [E] refine ${REFINE_ORE} ore → ${REFINE_KITS} kits`;
      const job = [...this.serverStructures.values()].find((st) => !!this.myShipId && st.turretBuilder === this.myShipId);
      if (job) {
        cargoHint += `  ·  ⚙ Building turret ${Math.floor(job.turretProgress * 100)}% — locked here ([C] switch / call a taxi)`;
      } else if (anchoredStruct && anchoredStruct.owner === this.room.sessionId) {
        const buffers = anchoredStruct.stype === "initialBase" || anchoredStruct.stype === "hq" || anchoredStruct.stype === "miningStation";
        if (buffers) cargoHint += "  · [O]/[P] ore · [K]/[L] kits";
        const stype = anchoredStruct.stype;
        // [J]: na central, descarrega quem chega com rações e carrega quem chega sem
        const unloadsHere = stype === "miningStation" || stype === "hq" || (stype === "rationCenter" && food > 0);
        if (unloadsHere && food > 0) cargoHint += "  · [J] unload food";
        else if ((stype === "initialBase" || stype === "rationCenter") && anchoredStruct.rationStore >= 1 && mineAuth && holdRoom(mineAuth, "rations") > 0) cargoHint += "  · [J] load food";
        // [G] conserto automático (kits do porão, depois do buffer)
        if (anchoredStruct.repairing) {
          cargoHint += `  ·  🔧 repairing ${Math.floor((anchoredStruct.hp / Math.max(1, anchoredStruct.maxHp)) * 100)}% — [G] stop`;
        } else if (anchoredStruct.hp < anchoredStruct.maxHp) {
          const kitsHere = hold + anchoredStruct.kitStore;
          const need = Math.ceil((anchoredStruct.maxHp - anchoredStruct.hp) / REPAIR_HP_PER_KIT);
          cargoHint += `  ${kitsHere >= 1 ? "»" : "·"} [G] repair (${need} kits)`;
        }
        if (anchoredStruct.turretBuild >= 0) cargoHint += "  ·  turret under construction";
        else if (anchoredStruct.turrets < TURRET_MAX) {
          const kitsHere = hold + anchoredStruct.kitStore;
          cargoHint += `  ${kitsHere >= TURRET_COST ? "»" : "·"} [B] turret ${anchoredStruct.turrets}/${TURRET_MAX} (${TURRET_COST} kits)`;
        } else cargoHint += `  ·  turrets ${TURRET_MAX}/${TURRET_MAX}`;
      } else if (anchoredStruct?.owner === RUIN_OWNER) {
        // RUÍNA: aqui só se recupera a estrutura ([G], kits do porão)
        if (anchoredStruct.repairing) {
          cargoHint += `  ·  🔧 restoring ${Math.floor((anchoredStruct.hp / Math.max(1, anchoredStruct.maxHp)) * 100)}% — [G] stop`;
        } else {
          const need = Math.ceil(Math.max(0, anchoredStruct.maxHp - anchoredStruct.hp) / REPAIR_HP_PER_KIT);
          cargoHint += `  » [G] restore this station (${need} kits from the hold)`;
        }
      }
    }
    let taxiLine = "";
    if (((anchored && nearOwnStation) || onFoot) && this.taxiOpts.length > 0) {
      const o = this.taxiOpts[this.taxiSel];
      const km = (o.srcDist / 1000).toFixed(1);
      taxiLine =
        `\nTaxi ▸ ${kindLabel[o.kind]} (${o.srcType === "hq" ? "HQ" : "hangar"} at ${km}k)  ` +
        `·  [T] change selection (${this.taxiSel + 1}/${this.taxiOpts.length})  ·  [Y] call (2× speed)`;
    }

    // naves são pagas com o minério do buffer do QG em que se está
    const prodHq = onFoot?.stype === "hq" ? onFoot : anchoredStruct?.stype === "hq" ? anchoredStruct : undefined;
    const hqOre = Math.floor(prodHq?.oreStore ?? 0);
    const prodLine = anchoredInHq
      ? `\n${mark(hqOre >= p3.cost)}${hint3}   ${mark(hqOre >= p4.cost)}${hint4}   ${mark(hqOre >= p5.cost)}${hint5}   ${mark(hqOre >= p6.cost)}${hint6}`
      : "";
    const landHint = canAnchor && !onFoot ? " · [F] land" : "";

    const shipData: HudShipData = {
      kind: activeKind,
      hp: mineAuth?.hp ?? 100,
      ammo: mineAuth?.ammo ?? 0,
      grenadeAmmo: mineAuth?.grenadeAmmo ?? 0,
      ammoMax: MISSILE_AMMO_MAX,
      grenadeMax: MINE_AMMO_MAX,
      cargoKind: mineAuth?.cargoKind ?? "",
      cargoAmount: mineAuth?.cargoAmount ?? 0,
      mining: mineAuth?.mining ?? false,
      anchored: anchored ?? false,
      landingPhase: mineAuth?.landingPhase ?? "",
      landingProgress: mineAuth?.landingProgress ?? 0,
    };
    const ctxData: HudContextData = {
      ore,
      kits: mineAuth?.kits ?? 0,
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
      landedOnCeres: (mineAuth?.anchoredAsteroidId ?? "").startsWith(CERES_PLATFORM_PREFIX),
    };
    this.hudRenderer.drawStatus(shipData, ctxData);

    // minimapa
    const minimapData: MinimapData = {
      own,
      angle: this.localShip!.angle,
      remotes: [...this.remotes.values()],
      worms: [...this.serverWorms.values()].flatMap((w) => w.segs.filter((_, i) => i % 3 === 0).map((s) => {
        const p = this.toRender(s);
        return { rx: p.x, ry: p.y };
      })),
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
