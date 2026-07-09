import Phaser from "phaser";
import { Client, type Room } from "colyseus.js";
import {
  DEFAULT_PORT,
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
import { asteroidSpin } from "../shapes";
import { Palette } from "../render/Palette";
import { TextureCache } from "../render/TextureCache";
import { ShipRenderer } from "../render/ShipRenderer";
import { AsteroidRenderer } from "../render/AsteroidRenderer";
import { PlanetRenderer } from "../render/PlanetRenderer";
import { StructureRenderer } from "../render/StructureRenderer";
import { EffectsRenderer } from "../render/EffectsRenderer";
import { HudRenderer } from "../render/HudRenderer";
import type { HudShipData, HudContextData, MinimapData } from "../render/HudRenderer";

const COLOR_OWN = 0xffffff;
const COLOR_FLEET_OWN = Palette.structure.fleet;
const COLOR_STAR_BRIGHT = Palette.ui.starBright;
const COLOR_STAR_DIM = Palette.ui.starDim;

/**
 * Largura das linhas do wireframe, em PIXELS DE TELA (constante em qualquer
 * zoom). As linhas são desenhadas em espaço de mundo, então a largura real é
 * compensada pelo zoom — senão sumiriam quando afastado.
 */
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

/** rotação máxima dos asteroides (rad/s) — leve. */
const MAX_ASTEROID_SPIN = 0.12;

/**
 * Número de estrelas de fundo geradas por setor. Poucas e discretas:
 * o céu do arcade era essencialmente preto.
 */
const STARS_PER_SECTOR = 90;

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

export class GameScene extends Phaser.Scene {
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

  private ownGfx!: Phaser.GameObjects.Graphics;
  private remotes = new Map<string, RemoteView>();
  private serverStructures = new Map<string, ServerStructure>();
  private serverProjectiles = new Map<string, ServerProjectile>();
  private passthrough = new Set<string>();
  /** sistema de render */
  private texCache!: TextureCache;
  private shipRenderer!: ShipRenderer;
  private asteroidRenderer!: AsteroidRenderer;
  private planetRenderer!: PlanetRenderer;
  private structureRenderer!: StructureRenderer;
  private effectsRenderer!: EffectsRenderer;
  private hudRenderer!: HudRenderer;

  /** câmera de UI (sem zoom/scroll) e camadas separadas mundo × interface */
  private uiCam!: Phaser.Cameras.Scene2D.Camera;
  private worldLayer!: Phaser.GameObjects.Container;
  private uiLayer!: Phaser.GameObjects.Container;
  private starGfx!: Phaser.GameObjects.Graphics;
  /** Ceres: posição derivada da semente (nada trafega pela rede) */
  private ceres: WorldPos | null = null;
  /** cache das posições (espaço de render) dos asteroides 3×3 — para o minimapa */
  private zoomTarget = INITIAL_ZOOM;
  private lastStrokeZoom = 0;
  private minimapFull = false;
  private inLandZone = false;
  private isFlying = false;

  private keys!: Record<
    | "W" | "A" | "S" | "D" | "UP" | "LEFT" | "RIGHT" | "SPACE" | "PLUS" | "MINUS"
    | "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE" | "SIX" | "E" | "F" | "C" | "G" | "T" | "Y" | "N" | "M",
    Phaser.Input.Keyboard.Key
  >;
  private sendAccum = 0;

  constructor() {
    super("game");
  }

  async create() {
    this.keys = this.input.keyboard!.addKeys(
      "W,A,S,D,UP,LEFT,RIGHT,SPACE,PLUS,MINUS,ONE,TWO,THREE,FOUR,FIVE,SIX,E,F,C,G,T,Y,N,M",
    ) as GameScene["keys"];

    // camadas: a câmera principal (com zoom) só vê o mundo;
    // a câmera de UI (fixa) só vê HUD e minimapa
    this.worldLayer = this.add.container(0, 0);
    this.uiLayer = this.add.container(0, 0);

    this.starGfx = this.add.graphics();
    this.worldLayer.add(this.starGfx);
    this.worldLayer.sendToBack(this.starGfx);

    // sistema de render
    this.texCache = new TextureCache(this);
    this.shipRenderer = new ShipRenderer(this, this.texCache, this.worldLayer);
    this.asteroidRenderer = new AsteroidRenderer(this, this.worldLayer);
    this.planetRenderer = new PlanetRenderer(this, this.worldLayer);
    this.structureRenderer = new StructureRenderer(this, this.worldLayer);
    this.effectsRenderer = new EffectsRenderer(this, this.worldLayer);
    this.hudRenderer = new HudRenderer(this, this.uiLayer);
    this.ownGfx = this.add.graphics(); // placeholder invísível
    this.ownGfx.setVisible(false);

    this.uiCam = this.cameras.add(0, 0, this.scale.width, this.scale.height);
    this.uiCam.ignore(this.worldLayer);
    this.cameras.main.ignore(this.uiLayer);
    this.cameras.main.setZoom(INITIAL_ZOOM);

    // zoom pela roda do mouse
    this.input.on(
      "wheel",
      (_p: unknown, _over: unknown, _dx: number, dy: number) => {
        const factor = dy > 0 ? 1 / ZOOM_WHEEL_STEP : ZOOM_WHEEL_STEP;
        this.zoomTarget = Phaser.Math.Clamp(this.zoomTarget * factor, ZOOM_MIN, ZOOM_MAX);
      },
    );

    const endpoint = `ws://${location.hostname}:${DEFAULT_PORT}`;
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

  // ── loop ────────────────────────────────────────────────────────────

  update(_time: number, deltaMs: number) {
    // (re)inicializa a predição quando a nave ativa aparece ou muda (troca)
    const mineServer = this.myShipId ? this.serverShips.get(this.myShipId) : undefined;
    if (!mineServer) return;
    if (this.localShipId !== this.myShipId) this.initActiveShip(mineServer);
    if (!this.localShip) return;
    const dt = Math.min(deltaMs / 1000, 0.1);

    // zoom por teclas +/- e suavização em direção ao alvo
    if (this.keys.PLUS.isDown) {
      this.zoomTarget = Math.min(this.zoomTarget * ZOOM_KEY_STEP, ZOOM_MAX);
    }
    if (this.keys.MINUS.isDown) {
      this.zoomTarget = Math.max(this.zoomTarget / ZOOM_KEY_STEP, ZOOM_MIN);
    }
    const cam = this.cameras.main;
    cam.setZoom(Phaser.Math.Linear(cam.zoom, this.zoomTarget, ZOOM_SMOOTH));
    // mantém a câmera de UI cobrindo a tela (modo RESIZE)
    this.uiCam.setSize(this.scale.width, this.scale.height);

    // largura de linha constante em tela → redesenha ao mudar o zoom
    if (Math.abs(cam.zoom - this.lastStrokeZoom) > this.lastStrokeZoom * 0.08 + 1e-4) {
      this.lastStrokeZoom = cam.zoom;
      this.redrawStrokes();
    }

    // construção, produção e ancoragem (autoritativas no servidor)
    const landingPhase = mineServer.landingPhase ?? "";
    const isLanding = landingPhase === "landing";
    const isLanded = landingPhase === "landed";

    if (Phaser.Input.Keyboard.JustDown(this.keys.N)) {
      this.minimapFull = !this.minimapFull;
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.M)) {
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
      // [F]: uma ÚNICA leitura de JustDown — a função CONSOME o flag ao
      // retornar true, então chamá-la duas vezes no mesmo frame (uma por
      // condição) faz a segunda sempre ver "false", mesmo com a tecla
      // pressionada. Ancorar/pousar são mutuamente exclusivos, então um
      // só if/else resolve com uma leitura.
      if (Phaser.Input.Keyboard.JustDown(this.keys.F)) {
        this.room.send(MSG_ANCHOR);
      }
      // SPACE: coleta buffer da estação quando builder ancorado
      const anchoredStation = mineServer.anchored && (() => {
        const st = this.serverStructures.get(mineServer.hqId ?? "");
        return !!st && st.stype === "miningStation";
      })();
      if (anchoredStation && Phaser.Input.Keyboard.JustDown(this.keys.SPACE)) {
        this.room.send(MSG_LAND_ACTION, { action: "stationmine" });
      }
      // [3]/[4]/[5] produzir: só ancorado no QG
      const hqId = mineServer.hqId ?? "";
      const hqStruct = this.serverStructures.get(hqId);
      const isInHq = mineServer.anchored && !!hqStruct && hqStruct.stype === "hq";
      if (isInHq) {
        if (Phaser.Input.Keyboard.JustDown(this.keys.THREE)) {
          this.room.send(MSG_PRODUCE, { kind: "mining" });
        }
        if (Phaser.Input.Keyboard.JustDown(this.keys.FOUR)) {
          this.room.send(MSG_PRODUCE, { kind: "attack" });
        }
        if (Phaser.Input.Keyboard.JustDown(this.keys.FIVE)) {
          this.room.send(MSG_PRODUCE, { kind: "builder" });
        }
        if (Phaser.Input.Keyboard.JustDown(this.keys.SIX)) {
          this.room.send(MSG_PRODUCE, { kind: "transport" });
        }
      }
      // [E] carga/descarga do transporte pousado (contexto no servidor)
      if (mineServer.kind === "transport" && mineServer.anchored
          && Phaser.Input.Keyboard.JustDown(this.keys.E)) {
        this.room.send(MSG_CARGO);
      }
      // disparo da nave de ataque: SPACE = perfurante, G = granada
      if (mineServer.kind === "attack") {
        if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE)) {
          this.room.send(MSG_FIRE, { kind: "bullet" });
        }
        if (Phaser.Input.Keyboard.JustDown(this.keys.G)) {
          this.room.send(MSG_FIRE, { kind: "grenade" });
        }
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.C)) {
        this.room.send(MSG_SWAP);
      }
      if (mineServer.kind !== "attack" && Phaser.Input.Keyboard.JustDown(this.keys.G)) {
        this.room.send(MSG_AUTOMINE);
      }
      // táxi: [T] cicla a nave escolhida, [Y] chama a selecionada
      this.taxiOpts = this.computeTaxiOptions();
      if (this.taxiOpts.length > 0) this.taxiSel %= this.taxiOpts.length;
      else this.taxiSel = 0;
      if (Phaser.Input.Keyboard.JustDown(this.keys.T) && this.taxiOpts.length > 0) {
        this.taxiSel = (this.taxiSel + 1) % this.taxiOpts.length;
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.Y) && this.taxiOpts.length > 0) {
        this.room.send(MSG_TAXI, { shipId: this.taxiOpts[this.taxiSel].id });
      }
    }

    // menu pós-pouso: SPACE=minerar, 1=construir estação, 2=construir QG, F=decolar
    if (isLanded) {
      if (Phaser.Input.Keyboard.JustDown(this.keys.SPACE)) {
        this.room.send(MSG_LAND_ACTION, { action: "mine" });
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.ONE)) {
        this.room.send(MSG_LAND_ACTION, { action: "build" });
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.TWO)) {
        this.room.send(MSG_LAND_ACTION, { action: "buildhq" });
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.THREE)) {
        this.room.send(MSG_LAND_ACTION, { action: "buildration" });
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.F)) {
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
    const turn = (k.A.isDown || k.LEFT.isDown ? -1 : 0) + (k.D.isDown || k.RIGHT.isDown ? 1 : 0);
    return {
      thrust: k.W.isDown || k.UP.isDown,
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
    local.angle += Phaser.Math.Angle.Wrap(server.angle - local.angle) * OWN_BLEND;
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
    for (const view of this.remotes.values()) view.initialized = false;
  }

  /** (Re)inicializa a predição para a nave ativa (spawn ou troca no hangar). */
  private initActiveShip(server: ServerShip) {
    this.localShip = makeShip(server, server.owner, server.kind);
    this.localShip.angle = server.angle;
    this.localShip.anchored = server.anchored;
    this.localShipId = this.myShipId;
    this.setOrigin(server.sx, server.sy);
    // cria/atualiza o sprite da nave própria via ShipRenderer
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
    this.rebuildStars();
  }

  private rebuildStars() {
    this.starGfx.clear();
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const sx = this.origin.sx + ox;
        const sy = this.origin.sy + oy;
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
          // pontos de fósforo: poucos brilhantes, o resto bem apagado
          const bright = rng() > 0.85;
          const size = bright ? 2 : 1;
          const alpha = bright ? 0.9 : 0.25 + rng() * 0.2;
          this.starGfx.fillStyle(bright ? COLOR_STAR_BRIGHT : COLOR_STAR_DIM, alpha);
          this.starGfx.fillRect(x - size / 2, y - size / 2, size, size);
        }
      }
    }
  }

  /** Tint de uma nave conforme o dono: própria pilotada, minha frota, ou alheia. */
  private shipTint(server: ServerShip, id: string): number {
    if (id === this.myShipId) return COLOR_OWN;
    if (server.owner === this.room.sessionId) return COLOR_FLEET_OWN;
    return 0x7f8ea3; // remoto
  }

  /** Velocidade angular do asteroide hospedeiro de uma estrutura (rad/s). */
  private asteroidSpinById(st: ServerStructure): number {
    if (!st.asteroidId) return 0;
    for (const a of sectorAsteroids(this.worldSeed, st.sx, st.sy)) {
      if (a.id === st.asteroidId) return asteroidSpin(a.shapeSeed) * MAX_ASTEROID_SPIN;
    }
    return 0;
  }

  private redrawStrokes() {
    const sw = Phaser.Math.Clamp(4 / this.cameras.main.zoom, 0.5, 80);
    this.structureRenderer.setStrokeWidth(sw);
    this.structureRenderer.invalidateAll();
    this.rebuildAsteroids();
  }

  private draw(_dt: number, authoritative: ServerShip | undefined, frameSim: SimWorld) {
    const own = this.toRender(this.localShip!);
    const mineAuth = this.serverShips.get(this.myShipId);
    const lPhaseRender = mineAuth?.landingPhase ?? "";
    const lSpin = mineAuth?.landingAsteroidSpin ?? 0;
    const ownAngle = (lPhaseRender === "landed" || lPhaseRender === "landing" || lPhaseRender === "liftoff")
      ? this.localShip!.angle + lSpin * (this.time.now / 1000)
      : this.localShip!.angle;
    // nave própria: atualiza sprite via ShipRenderer
    this.shipRenderer.update(this.myShipId, {
      x: own.x, y: own.y, angle: ownAngle,
      kind: this.localShip!.kind, tint: COLOR_OWN, visible: true,
    });
    this.cameras.main.centerOn(own.x, own.y);

    const sw = this.scale.width;
    const sh = this.scale.height;

    const tt = this.time.now / 1000;
    const zoom = this.cameras.main.zoom;

    // asteroides: rotação via renderer
    this.asteroidRenderer.tick(tt);

    // Ceres: posição e rotação via renderer
    if (this.ceres) {
      const cp = this.toRender(this.ceres);
      this.planetRenderer.tick(cp, tt);
    }

    // início do frame de efeitos
    this.effectsRenderer.beginFrame();

    // jato da nave própria
    this.effectsRenderer.drawJet(own.x, own.y, this.localShip!.angle, Math.hypot(this.localShip!.vx, this.localShip!.vy), tt);

    // naves remotas: interpolação + atualiza sprites via ShipRenderer
    for (const [id, server] of this.serverShips) {
      if (id === this.myShipId || server.stored) {
        // nave própria e naves guardadas: esconde sem criar sprite
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
        view.angle += Phaser.Math.Angle.Wrap(server.angle - view.angle) * REMOTE_BLEND;
      }
      this.shipRenderer.update(id, {
        x: view.rx, y: view.ry, angle: view.angle,
        kind: view.kind, tint: view.tint, visible: true,
      });
      this.effectsRenderer.drawJet(view.rx, view.ry, view.angle, Math.hypot(server.vx, server.vy), tt);
    }

    // estruturas: via StructureRenderer
    for (const [id, st] of this.serverStructures) {
      const p = this.toRender(st);
      const spin = this.asteroidSpinById(st);
      const occupants: ShipKind[] = [];
      for (const [sid_, s] of [...this.serverShips].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        void sid_;
        if (s.stored && s.hqId === id) occupants.push(s.kind);
      }
      this.structureRenderer.upsert({
        id, stype: st.stype, owner: st.owner, angle: st.angle,
        shipBays: st.shipBays, expandedBays: st.expandedBays,
        own: st.owner === this.room.sessionId, spin,
        x: p.x, y: p.y,
      }, occupants);
      this.structureRenderer.tick(id, p.x, p.y, st.angle, tt);
    }

    const anchored = authoritative?.anchored ?? this.localShip!.anchored;

    // feixe de mineração
    if (authoritative?.mining) {
      const target = frameSim.nearestAsteroid(this.localShip!);
      if (target) {
        const t = this.toRender(target);
        this.effectsRenderer.drawMiningBeam(own.x, own.y, t.x, t.y, zoom, tt);
      }
    }

    // projéteis
    for (const proj of this.serverProjectiles.values()) {
      const pp = this.toRender(proj);
      if (proj.kind === "bullet") {
        this.effectsRenderer.drawBullet(pp.x, pp.y, zoom);
      } else {
        this.effectsRenderer.drawGrenade(pp.x, pp.y, zoom, tt);
      }
    }

    // fronteira do mapa
    if (this.mapCenter && this.mapRadius > 0) {
      const c = this.toRender(this.mapCenter);
      this.effectsRenderer.drawBoundary(c.x, c.y, this.mapRadius, zoom);
    }

    // zona de pouso
    if (!anchored && lPhaseRender === "") {
      const landZoneAst = frameSim.nearestAsteroid(this.localShip!, DOCK_RANGE * 2);
      if (landZoneAst) {
        const zoneRadius = landZoneAst.radius + DOCK_RANGE;
        const ap = this.toRender(landZoneAst);
        this.effectsRenderer.drawLandZone(ap.x, ap.y, zoneRadius, zoom, tt);
      }
    }

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
    this.hudRenderer.drawStatus(shipData, ctxData, sw);

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
    this.hudRenderer.drawMinimap(minimapData, sw, sh);
  }
}