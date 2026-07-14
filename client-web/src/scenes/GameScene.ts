import { Client, type Room } from "colyseus.js";
import type { Engine } from "@babylonjs/core/Engines/engine";
import type { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { PointsCloudSystem } from "@babylonjs/core/Particles/pointsCloudSystem";
import type { CloudPoint } from "@babylonjs/core/Particles/cloudPoint";
import {
  SERVER_LOCATION,
  MSG_INPUT,
  MSG_PRODUCE,
  MSG_ANCHOR,
  MSG_SWAP,
  MSG_AUTOMINE,
  MSG_TAXI,
  MSG_LAND_ACTION,
  MSG_EXPAND,
  MSG_CARGO,
  MSG_FIRE,
  SECTOR_SIZE,
  SHIP_PRODUCTION,
  DOCK_RANGE,
  STATION_ORE_STORE,
  CERES_RADIUS,
  BULLET_AMMO_MAX,
  GRENADE_AMMO_MAX,
  ceresPosition,
  relVec,
  dist,
  type ShipInput,
  type StructureType,
  type ShipKind,
  type WorldPos,
} from "@ceres/shared";
import {
  SimWorld,
  makeShip,
  stepShip,
  collideShip,
  collideCeres,
  clampToBoundary,
  sectorAsteroids,
  type ShipState,
} from "@ceres/sim-core";
import { Palette } from "../render/Palette";
import { toScene } from "../render/coords";
import { c3 } from "../render/lineUtils";
import { KeyInput } from "../input";
import { MeshFactory } from "../render/MeshFactory";
import { ShipRenderer } from "../render/ShipRenderer";
import { AsteroidRenderer } from "../render/AsteroidRenderer";
import { PlanetRenderer } from "../render/PlanetRenderer";
import { StructureRenderer } from "../render/StructureRenderer";
import { EffectsRenderer } from "../render/EffectsRenderer";
import { HudRenderer } from "../render/HudRenderer";
import type { HudShipData, HudContextData, MinimapData } from "../render/HudRenderer";

const COLOR_OWN = 0xffffff;
const COLOR_FLEET_OWN = Palette.structure.fleet;

/** Zoom inicial: os asteroides agora são grandes; parte-se afastado para ver a escala. */
const INITIAL_ZOOM = 0.3;

const INPUT_SEND_HZ = 30;
/** fator de correção por frame em direção ao estado autoritativo */
const OWN_BLEND = 0.1;
const REMOTE_BLEND = 0.3;

// ── zoom ──
const ZOOM_MIN = 0.08;
const ZOOM_MAX = 3;
const ZOOM_WHEEL_STEP = 1.15;
const ZOOM_KEY_STEP = 1.03;
const ZOOM_SMOOTH = 0.15;

/**
 * Número de estrelas de fundo geradas por setor. Poucas e discretas:
 * o céu do arcade era essencialmente preto.
 */
const STARS_PER_SECTOR = 90;
/** tamanho do ponto em PIXELS DE TELA (PointsCloudSystem não escala com zoom) */
const STAR_POINT_PX = 2;
/** Z das estrelas: bem atrás de tudo (câmera olha de Z negativo para +Z). */
const STAR_DEPTH_Z = 200;

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
  mining: boolean;
  owner: string;
  kind: ShipKind;
  anchored: boolean;
  stored: boolean;
  hqId: string;
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
  private glow: GlowLayer;

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
  private passthrough = new Set<string>();
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
    // far plane cobre o dorso dos asteroides 3D em tombamento: root recuado
    // em z = raioEnvolvente − 300, dorso ≤ 2·(1.07·2000) − 300 ≈ 3980 →
    // ~4980 a partir da câmera (em z = −1000)
    this.camera.maxZ = 5000;
    this.updateOrtho();

    this.glow = new GlowLayer("glow", scene);
    this.glow.intensity = 1.4;

    this.keys = new KeyInput();
  }

  async create() {
    // sistema de render
    this.meshFactory = new MeshFactory(this.bScene, this.glow);
    this.shipRenderer = new ShipRenderer(this.meshFactory);
    this.asteroidRenderer = new AsteroidRenderer(this.bScene, this.glow);
    this.planetRenderer = new PlanetRenderer(this.bScene, this.glow);
    this.structureRenderer = new StructureRenderer(this.bScene, this.glow);
    this.effectsRenderer = new EffectsRenderer(this.bScene, this.glow);
    this.hudRenderer = new HudRenderer();

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

    // Render (e qualquer PaaS equivalente) só expõe a porta 443 publicamente;
    // a porta interna do servidor (DEFAULT_PORT) nunca entra na URL pública.
    const endpoint = `https://${SERVER_LOCATION}`;
    const client = new Client(endpoint);
    try {
      this.room = await client.joinOrCreate("match");
    } catch (err) {
      console.error(`Falha ao conectar em ${endpoint}`, err);
      return;
    }

    // sincronização por diff a cada patch — evita depender da API de
    // callbacks do schema, que varia entre versões do colyseus.js
    this.room.onStateChange((state: any) => this.syncFromServer(state));
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
        mining: s.mining,
        owner: s.owner, kind: s.kind, anchored: s.anchored,
        stored: s.stored, hqId: s.hqId,
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
      });
    });
    for (const id of [...this.serverShips.keys()]) {
      if (!seen.has(id)) {
        this.serverShips.delete(id);
        this.shipRenderer?.remove(id);
        this.remotes.delete(id);
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

  /** Bounds da câmera ortográfica a partir do canvas e do zoom. */
  private updateOrtho(): void {
    const halfW = this.engine.getRenderWidth() / (2 * this.zoom);
    const halfH = this.engine.getRenderHeight() / (2 * this.zoom);
    this.camera.orthoLeft = -halfW;
    this.camera.orthoRight = halfW;
    this.camera.orthoTop = halfH;
    this.camera.orthoBottom = -halfH;
  }

  // ── loop ────────────────────────────────────────────────────────────

  /** Um passo de jogo; dt em SEGUNDOS (main.ts chama por frame). */
  update(dt: number) {
    // (re)inicializa a predição quando a nave ativa aparece ou muda (troca)
    const mineServer = this.myShipId ? this.serverShips.get(this.myShipId) : undefined;
    if (!mineServer) return;
    if (this.localShipId !== this.myShipId) this.initActiveShip(mineServer);
    if (!this.localShip) return;

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

    if (this.keys.justDown("N")) {
      this.minimapFull = !this.minimapFull;
    }
    if (this.keys.justDown("M")) {
      this.room.send(MSG_EXPAND);
    }

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
        this.room.send(MSG_LAND_ACTION, { action: "build" });
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

    // input → predição local (mesmo stepShip + colisão do servidor) → envio
    const input = frozen ? { thrust: false, turn: 0 as const, mine: false } : this.readInput();
    if (frozen) {
      this.localShip.vx = 0;
      this.localShip.vy = 0;
    } else {
      stepShip(this.localShip, input, dt);
      collideShip(this.localShip, this.worldSeed, this.passthrough);
      if (this.ceres) collideCeres(this.localShip, this.ceres, CERES_RADIUS);
      if (this.mapCenter && this.mapRadius > 0) {
        clampToBoundary(this.localShip, this.mapCenter, this.mapRadius);
      }
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
    return {
      thrust: k.isDown("W") || k.isDown("UP"),
      turn: turn as ShipInput["turn"],
      mine: false,
    };
  }

  private blendTowards(local: ShipState, server: ServerShip) {
    const { dx, dy } = relVec(local, server);
    local.x += dx * OWN_BLEND;
    local.y += dy * OWN_BLEND;
    local.vx += (server.vx - local.vx) * OWN_BLEND;
    local.vy += (server.vy - local.vy) * OWN_BLEND;
    local.angle += wrapAngle(server.angle - local.angle) * OWN_BLEND;
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
   * Reconstrói o campo de estrelas do grid 3×3 (mesma regra determinística
   * por setor do Phaser original). Assíncrono (PointsCloudSystem.buildMeshAsync);
   * um token descarta builds obsoletos se o setor mudar de novo antes de terminar.
   */
  private rebuildStars(): void {
    const token = ++this.starBuildToken;
    const origin = this.origin;
    const brightC = c3(Palette.ui.starBright);
    const dimC = c3(Palette.ui.starDim);

    interface StarSeed { x: number; y: number; bright: boolean; alpha: number }
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
          const x = bx + rng() * SECTOR_SIZE;
          const y = by + rng() * SECTOR_SIZE;
          const bright = rng() > 0.85;
          const alpha = bright ? 0.9 : 0.25 + rng() * 0.2;
          seeds.push({ x, y, bright, alpha });
        }
      }
    }

    // pré-multiplica o alpha na cor (fundo é preto puro) — evita blending
    const pcs = new PointsCloudSystem("stars", STAR_POINT_PX, this.bScene, { updatable: false });
    pcs.addPoints(seeds.length, (particle: CloudPoint, i?: number) => {
      const s = seeds[i!];
      const p = toScene(s.x, s.y);
      particle.position.set(p.x, p.y, STAR_DEPTH_Z);
      const c = s.bright ? brightC : dimC;
      particle.color = new Color4(c.r * s.alpha, c.g * s.alpha, c.b * s.alpha, 1);
    });
    void pcs.buildMeshAsync().then((mesh) => {
      if (token !== this.starBuildToken) {
        pcs.dispose();
        return;
      }
      this.starPcs?.dispose();
      this.starPcs = pcs;
      mesh.isPickable = false;
    });
  }

  /** Tint de uma nave conforme o dono: própria pilotada, minha frota, ou alheia. */
  private shipTint(server: ServerShip, id: string): number {
    if (id === this.myShipId) return COLOR_OWN;
    if (server.owner === this.room.sessionId) return COLOR_FLEET_OWN;
    return 0x7f8ea3; // remoto
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
    // nave própria: atualiza malha via ShipRenderer
    this.shipRenderer.update(this.myShipId, {
      x: own.x, y: own.y, angle: ownAngle,
      kind: this.localShip!.kind, tint: COLOR_OWN, visible: true,
    });
    // câmera segue a nave (substitui cameras.main.centerOn)
    const camPos = toScene(own.x, own.y);
    this.camera.position.x = camPos.x;
    this.camera.position.y = camPos.y;

    const zoom = this.zoom;

    // Ceres: posição e rotação via renderer
    if (this.ceres) {
      const cp = this.toRender(this.ceres);
      this.planetRenderer.tick(cp, tt);
    }

    // início do frame de efeitos
    this.effectsRenderer.beginFrame();

    // jato da nave própria
    this.effectsRenderer.drawJet(own.x, own.y, this.localShip!.angle, Math.hypot(this.localShip!.vx, this.localShip!.vy), tt);

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
      this.shipRenderer.update(id, {
        x: view.rx, y: view.ry, angle: view.angle,
        kind: view.kind, tint: view.tint, visible: true,
      });
      this.effectsRenderer.drawJet(view.rx, view.ry, view.angle, Math.hypot(server.vx, server.vy), tt);
    }

    // estruturas: assentadas na plataforma do asteroide hospedeiro — o
    // parent do Babylon dá posição/inclinação/spin; sem transform por frame
    for (const [id, st] of this.serverStructures) {
      const occupants: ShipKind[] = [];
      for (const [sid_, s] of [...this.serverShips].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        void sid_;
        if (s.stored && s.hqId === id) occupants.push(s.kind);
      }
      const attach = st.asteroidId ? this.asteroidRenderer.getBuildFace(st.asteroidId) : null;
      this.structureRenderer.upsert({
        id, stype: st.stype,
        shipBays: st.shipBays, expandedBays: st.expandedBays,
        own: st.owner === this.room.sessionId,
      }, occupants, attach);
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
    this.asteroidRenderer.tick(tt, dt, lockedAsteroids);

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
        (s) => s.hqId === [...this.serverStructures.entries()].find(([, v]) => v === nearOwnStruct)?.[0]
          && s.stored,
      ).length
      : 0;
    const nearStructFree = nearOwnStruct ? Math.max(0, nearOwnStruct.shipBays - nearStructOccupied) : 0;
    const hangarTotal = [...this.serverShips.values()].filter(s => s.stored && s.owner === this.room.sessionId).length;

    const p3 = SHIP_PRODUCTION.mining;
    const p4 = SHIP_PRODUCTION.attack;
    const p5 = SHIP_PRODUCTION.builder;
    const p6 = SHIP_PRODUCTION.transport;
    const mark = (ok: boolean) => (ok ? "» " : "  ");
    const need = !hasHq ? " — precisa de QG" : !anchored ? " — ancore [F]" : "";
    const hint3 = `[3] ${p3.label} (${p3.cost})${need}`;
    const hint4 = `[4] ${p4.label} (${p4.cost})${need}`;
    const hint5 = `[5] ${p5.label} (${p5.cost})${need}`;
    const hint6 = `[6] ${p6.label} (${p6.cost})${need}`;
    const anchoredInHq = anchored && (() => {
      const hqId = mineAuth?.hqId ?? "";
      const st = this.serverStructures.get(hqId);
      return !!st && st.stype === "hq";
    })();
    const anchorTag = anchored ? "  ⚓ ANCORADO" : "";
    const canAnchor = !anchored && this.inLandZone;
    const anchorHint = canAnchor
      ? nearOwnStruct !== null
        ? nearStructFree > 0
          ? `  » [F] pousar (${nearStructFree} vaga${nearStructFree !== 1 ? "s" : ""} livre${nearStructFree !== 1 ? "s" : ""})`
          : "  ⚓ hangar cheio"
        : "  » [F] pousar"
      : "";
    const swapHint = anchored && !this.isFlying && hangarTotal > 0 ? `  » [C] trocar (hangar: ${hangarTotal})` : "";
    const canAuto = activeKind === "mining" && anchored && !this.isFlying && nearOwnStation;
    const autoHint = canAuto ? "  » [G] auto-minerar na estação" : "";
    const anchoredStationStruct = anchored ? (() => {
      const st = this.serverStructures.get(mineAuth?.hqId ?? "");
      return (st && st.stype === "miningStation") ? st : null;
    })() : null;
    const builderMining = anchoredStationStruct && (mineAuth?.mining ?? false);
    const stationBufferHint =
      anchoredStationStruct && activeKind === "builder"
        ? (builderMining ? "  » [ESP] parar mineração" : "  » [ESP] minerar")
        : "";
    const anchoredStruct = anchored ? this.serverStructures.get(mineAuth?.hqId ?? "") ?? null : null;
    let storeHint = "";
    if (anchoredStruct) {
      if (anchoredStruct.stype === "miningStation") {
        storeHint = `  ·  Estoque: ${Math.floor(anchoredStruct.oreStore)}/${STATION_ORE_STORE} minério · rações: ${Math.floor(anchoredStruct.rationStore)}`;
      } else if (anchoredStruct.stype === "initialBase") {
        storeHint = `  ·  Base — rações: ${Math.floor(anchoredStruct.rationStore)} (da Terra)`;
      } else if (anchoredStruct.stype === "hq") {
        storeHint = `  ·  QG — rações: ${Math.floor(anchoredStruct.rationStore)}`;
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
      cargoHint = ck === "" ? "  ·  Porão: vazio" : `  ·  Porão: ${ca} ${ck === "ore" ? "minério" : "rações"}`;
      if (anchoredStruct) {
        const st = anchoredStruct.stype;
        if (ck === "rations" || (ck === "ore" && st === "initialBase")) cargoHint += "  » [E] descarregar";
        else if (ck === "" && st === "miningStation" && anchoredStruct.oreStore > 0) cargoHint += "  » [E] carregar minério";
        else if (ck === "" && st === "initialBase" && anchoredStruct.rationStore > 0) cargoHint += "  » [E] carregar rações";
      }
    }
    let taxiLine = "";
    if (anchored && nearOwnStation && this.taxiOpts.length > 0) {
      const o = this.taxiOpts[this.taxiSel];
      const km = (o.srcDist / 1000).toFixed(1);
      taxiLine =
        `\nTáxi ▸ ${kindLabel[o.kind]} (QG a ${km}k)  ` +
        `·  [T] trocar seleção (${this.taxiSel + 1}/${this.taxiOpts.length})  ·  [Y] chamar (2× vel.)`;
    }

    const prodLine = anchoredInHq
      ? `\n${mark(ore >= p3.cost)}${hint3}   ${mark(ore >= p4.cost)}${hint4}   ${mark(ore >= p5.cost)}${hint5}   ${mark(ore >= p6.cost)}${hint6}`
      : "";
    const landHint = canAnchor ? " · [F] pousar" : "";

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
