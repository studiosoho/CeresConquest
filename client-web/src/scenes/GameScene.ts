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
  SECTOR_SIZE,
  SHIP_RADIUS,
  SHIP_MAX_SPEED,
  STRUCTURE_SPECS,
  SHIP_PRODUCTION,
  DOCK_RANGE,
  ASTEROID_CLASSES,
  STATION_MINE_BUFFER,
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
  clampToBoundary,
  sectorAsteroids,
  type ShipState,
} from "@ceres/sim-core";
import { shipVerts, asteroidVerts, structureVerts, asteroidSpin } from "../shapes";

const COLOR_OWN = 0xffffff;
const COLOR_REMOTE = 0x7f8ea3;
const COLOR_BEAM = 0x9fd4ff;
const COLOR_BOUNDARY = 0xcc5544;
const COLOR_STRUCT_OWN = 0x5fd0a8;
const COLOR_STRUCT_OTHER = 0xc8985a;
/** naves da minha frota (produzidas, autônomas) */
const COLOR_FLEET_OWN = 0x8fe36a;
/** vagas de hangar desenhadas junto às bases */
const COLOR_HANGAR = 0x3d4f63;
/** jatos de propulsão pixelados (azul → roxo) */
const COLOR_JET_BLUE = 0x5b8cff;
const COLOR_JET_PURPLE = 0x9a5bff;
/** estrelas da Via Láctea (fundo) */
const COLOR_STAR_BRIGHT = 0xffffff;
const COLOR_STAR_DIM = 0x8899bb;

/**
 * Largura das linhas do wireframe, em PIXELS DE TELA (constante em qualquer
 * zoom). As linhas são desenhadas em espaço de mundo, então a largura real é
 * compensada pelo zoom — senão sumiriam quando afastado.
 */
const SCREEN_LINE_WIDTH = 4;
const SCREEN_BEAM_WIDTH = 3;

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

// ── minimapa ──
const MINIMAP_SIZE = 220;
const MINIMAP_MARGIN = 12;
/** alcance do minimapa: unidades do centro até a borda */
const MINIMAP_RANGE = 15_000;
/** rotação máxima dos asteroides (rad/s) — leve. */
const MAX_ASTEROID_SPIN = 0.12;
const COLOR_MINIMAP_BG = 0x000000;
const COLOR_MINIMAP_BORDER = 0x3d4b5c;
const COLOR_MINIMAP_GRID = 0x22303f;

/** Número de estrelas de fundo geradas por setor. */
const STARS_PER_SECTOR = 300;

// ── paralax ──
/** Fator de movimento da camada de nebulosas (0=fixa, 1=junto com o mundo). */
const PARALLAX_NEBULA = 0.04;
/** Fator de movimento da camada de estrelas densas da Via Láctea. */
const PARALLAX_MILKY = 0.12;
/** Tamanho do canvas de fundo (tiles que cobrem a tela com margem). */
const BG_SIZE = 3000;

interface RemoteView {
  gfx: Phaser.GameObjects.Graphics;
  /** posição de render suavizada (no espaço relativo à origem) */
  rx: number;
  ry: number;
  angle: number;
  initialized: boolean;
  kind: ShipKind;
  color: number;
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
}

/** Snapshot plano de uma estrutura vinda do schema. */
interface ServerStructure extends WorldPos {
  stype: StructureType;
  owner: string;
  angle: number;
  asteroidId: string;
  shipBays: number;
  expandedBays: number;
  mineBuffer: number;
}

interface StructView {
  gfx: Phaser.GameObjects.Graphics;
  type: StructureType;
  radius: number;
  shipBays: number;
  expandedBays: number;
  own: boolean;
  /** velocidade angular do asteroide hospedeiro (gira em grupo com ele) */
  spin: number;
  /** assinatura do último desenho (ocupação do hangar) — redesenha se mudar */
  lastSig: string;
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
  private beamGfx!: Phaser.GameObjects.Graphics;
  private boundaryGfx!: Phaser.GameObjects.Graphics;
  private jetGfx!: Phaser.GameObjects.Graphics;
  /** área circular de pouso (amarelo piscante) ao redor do asteroide mais próximo */
  private landZoneGfx!: Phaser.GameObjects.Graphics;
  private remotes = new Map<string, RemoteView>();
  private asteroidGfx: Array<{ gfx: Phaser.GameObjects.Graphics; spin: number }> = [];
  private serverStructures = new Map<string, ServerStructure>();
  private structViews = new Map<string, StructView>();
  /** asteroides ocupados por estruturas → sem colisão (igual ao servidor) */
  private passthrough = new Set<string>();
  private hud!: Phaser.GameObjects.Text;

  /** câmera de UI (sem zoom/scroll) e camadas separadas mundo × interface */
  private uiCam!: Phaser.Cameras.Scene2D.Camera;
  private worldLayer!: Phaser.GameObjects.Container;
  private uiLayer!: Phaser.GameObjects.Container;
  private minimapGfx!: Phaser.GameObjects.Graphics;
  private starGfx!: Phaser.GameObjects.Graphics;
  /** camadas de paralax (nebulosas e Via Láctea densa) — espaço de tela */
  private bgNebula!: Phaser.GameObjects.RenderTexture;
  private bgMilky!: Phaser.GameObjects.RenderTexture;
  /** posição do mundo na última vez que o paralax foi calculado (px de render) */
  private bgLastX = 0;
  private bgLastY = 0;
  /** cache das posições (espaço de render) dos asteroides 3×3 — para o minimapa */
  private nearbyAsteroids: Array<{ rx: number; ry: number; asteroidClass: string }> = [];
  private zoomTarget = INITIAL_ZOOM;
  /** zoom no qual as linhas foram desenhadas por último (para redesenhar) */
  private lastStrokeZoom = 0;
  /** true = minimapa mostra o mapa inteiro (tecla N) */
  private minimapFull = false;
  /** true quando a nave está dentro da zona de pouso do asteroide mais próximo */
  private inLandZone = false;
  /** true quando a nave está em voo livre (não ancorada, não pousando) */
  private isFlying = false;

  private keys!: Record<
    | "W" | "A" | "S" | "D" | "UP" | "LEFT" | "RIGHT" | "SPACE" | "PLUS" | "MINUS"
    | "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE" | "F" | "C" | "G" | "T" | "Y" | "N" | "M",
    Phaser.Input.Keyboard.Key
  >;
  private sendAccum = 0;
  private lastInput: ShipInput = { thrust: false, turn: 0, mine: false };

  constructor() {
    super("game");
  }

  async create() {
    this.keys = this.input.keyboard!.addKeys(
      "W,A,S,D,UP,LEFT,RIGHT,SPACE,PLUS,MINUS,ONE,TWO,THREE,FOUR,FIVE,F,C,G,T,Y,N,M",
    ) as GameScene["keys"];

    // camadas: a câmera principal (com zoom) só vê o mundo;
    // a câmera de UI (fixa) só vê HUD e minimapa
    this.worldLayer = this.add.container(0, 0);
    this.uiLayer = this.add.container(0, 0);

    this.beamGfx = this.add.graphics();
    this.boundaryGfx = this.add.graphics();
    this.jetGfx = this.add.graphics();
    this.landZoneGfx = this.add.graphics();
    this.starGfx = this.add.graphics();
    this.worldLayer.add(this.starGfx);
    this.worldLayer.add(this.beamGfx);
    this.worldLayer.add(this.boundaryGfx);
    this.worldLayer.add(this.jetGfx);
    this.worldLayer.add(this.landZoneGfx);
    this.worldLayer.sendToBack(this.starGfx);

    // camadas de paralax: nebulosas (mais lentas) e Via Láctea densa
    // ficam na uiLayer (espaço de tela, sem zoom) e são reposicionadas por frame
    this.bgNebula = this.add.renderTexture(0, 0, BG_SIZE, BG_SIZE);
    this.bgMilky  = this.add.renderTexture(0, 0, BG_SIZE, BG_SIZE);
    this.buildNebulaLayer(this.bgNebula);
    this.buildMilkyLayer(this.bgMilky);
    this.bgNebula.setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(-20);
    this.bgMilky.setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(-19);
    this.uiLayer.add([this.bgNebula, this.bgMilky]);
    this.ownGfx = this.makeShipGfx(COLOR_OWN, "builder");
    this.ownGfx.setVisible(false);

    this.hud = this.add.text(12, 10, "Conectando…", {
      fontFamily: "monospace",
      fontSize: "16px",
      color: "#c8d6e5",
    });
    this.minimapGfx = this.add.graphics();
    this.uiLayer.add([this.hud, this.minimapGfx]);

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
      this.hud.setText(`Falha ao conectar em ${endpoint}\n${err}`);
      return;
    }

    // sincronização por diff a cada patch — evita depender da API de
    // callbacks do schema, que varia entre versões do colyseus.js
    this.room.onStateChange((state: any) => this.syncFromServer(state));
  }

  // ── rede ────────────────────────────────────────────────────────────

  private syncFromServer(state: any) {
    this.worldSeed = state.worldSeed >>> 0;
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
      });
    });
    for (const id of [...this.serverShips.keys()]) {
      if (!seen.has(id)) {
        this.serverShips.delete(id);
        this.remotes.get(id)?.gfx.destroy();
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
        mineBuffer: st.mineBuffer ?? 0,
      });
    });
    for (const id of [...this.serverStructures.keys()]) {
      if (!seenSt.has(id)) {
        this.serverStructures.delete(id);
        this.structViews.get(id)?.gfx.destroy();
        this.structViews.delete(id);
      }
    }

    // asteroides ocupados → atravessáveis (mesma regra da colisão do servidor)
    this.passthrough = new Set(
      [...this.serverStructures.values()].map((st) => st.asteroidId).filter(Boolean),
    );

    // a (re)inicialização da predição acontece em update(), conforme a nave
    // ativa (myShipId) aparecer ou mudar (troca no hangar)
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
      // [F] desancora quando já ancorado
      if (Phaser.Input.Keyboard.JustDown(this.keys.F) && mineServer.anchored) {
        this.room.send(MSG_ANCHOR);
      }
      // [F] pousar: envia sempre — servidor valida proximidade
      if (Phaser.Input.Keyboard.JustDown(this.keys.F) && !mineServer.anchored) {
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
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.C)) {
        this.room.send(MSG_SWAP);
      }
      if (Phaser.Input.Keyboard.JustDown(this.keys.G)) {
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
      if (this.mapCenter && this.mapRadius > 0) {
        clampToBoundary(this.localShip, this.mapCenter, this.mapRadius);
      }
    }
    this.sendAccum += dt;
    if (this.sendAccum >= 1 / INPUT_SEND_HZ) {
      this.sendAccum = 0;
      this.sendInput(input);
    }
    this.lastInput = input;

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
    // força re-inicialização das posições suavizadas dos remotos
    for (const view of this.remotes.values()) view.initialized = false;
  }

  /** (Re)inicializa a predição para a nave ativa (spawn ou troca no hangar). */
  private initActiveShip(server: ServerShip) {
    this.localShip = makeShip(server, server.owner, server.kind);
    this.localShip.angle = server.angle;
    this.localShip.anchored = server.anchored;
    this.localShipId = this.myShipId;
    this.setOrigin(server.sx, server.sy);
    // redesenha a nave própria com a silhueta da classe ativa
    this.ownGfx.clear();
    this.ownGfx.lineStyle(this.strokeW(), COLOR_OWN);
    this.ownGfx.strokePoints(shipVerts(server.kind), true, true);
    this.ownGfx.setVisible(true);
    this.ready = true;
  }

  private rebuildAsteroids() {
    for (const a of this.asteroidGfx) a.gfx.destroy();
    this.asteroidGfx = [];
    this.nearbyAsteroids = [];
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        for (const a of sectorAsteroids(this.worldSeed, this.origin.sx + ox, this.origin.sy + oy)) {
          const pos = this.toRender(a);
          const g = this.add.graphics({ x: pos.x, y: pos.y });
          const verts = asteroidVerts(a.shapeSeed, a.radius);

          // fill cinza médio
          g.fillStyle(0x6e7a80, 1);
          g.fillPoints(verts, true);

          // crateras (círculos escuros com anel claro) — sem manchas
          let cseed = a.shapeSeed ^ 0xabcd1234;
          const crng = () => { cseed = (cseed ^ (cseed << 13)) >>> 0; cseed = (cseed ^ (cseed >> 17)) >>> 0; cseed = (cseed ^ (cseed << 5)) >>> 0; return cseed / 0x100000000; };
          const nCraters = 2 + Math.floor(crng() * 4);
          for (let c = 0; c < nCraters; c++) {
            const ang = crng() * Math.PI * 2;
            const dist_ = crng() * a.radius * 0.6;
            const cr = a.radius * (0.05 + crng() * 0.1);
            const cx_ = Math.cos(ang) * dist_;
            const cy_ = Math.sin(ang) * dist_;
            g.fillStyle(0x2a3038, 0.7);
            g.fillCircle(cx_, cy_, cr);
            g.fillStyle(0x9aabb5, 0.35);
            g.fillCircle(cx_, cy_, cr * 1.35);
            g.fillStyle(0x2a3038, 0.7);
            g.fillCircle(cx_, cy_, cr);
          }

          // borda cinza escuro
          g.lineStyle(this.strokeW(), 0x3a4550, 1);
          g.strokePoints(verts, true, true);

          // poeira ao redor de asteroides pequenos
          if (a.asteroidClass === "small") {
            let dseed = a.shapeSeed ^ 0xf1e2d3c4;
            const drng = () => { dseed = (dseed ^ (dseed << 13)) >>> 0; dseed = (dseed ^ (dseed >> 17)) >>> 0; dseed = (dseed ^ (dseed << 5)) >>> 0; return dseed / 0x100000000; };
            const nDust = 18 + Math.floor(drng() * 14);
            for (let d = 0; d < nDust; d++) {
              const ang = drng() * Math.PI * 2;
              const r = a.radius * (1.05 + drng() * 0.55);
              const sz = 1.5 + drng() * 3.5;
              const alpha = 0.12 + drng() * 0.22;
              g.fillStyle(0x8a9aa0, alpha);
              g.fillRect(
                Math.cos(ang) * r - sz / 2,
                Math.sin(ang) * r - sz / 2,
                sz, sz,
              );
            }
          }

          this.worldLayer.add(g);
          this.worldLayer.sendToBack(g);
          this.asteroidGfx.push({ gfx: g, spin: asteroidSpin(a.shapeSeed) * MAX_ASTEROID_SPIN });
          this.nearbyAsteroids.push({ rx: pos.x, ry: pos.y, asteroidClass: a.asteroidClass });
        }
      }
    }
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
          const bright = rng() > 0.75;
          const size = bright ? 1.5 : 0.8;
          const alpha = bright ? 0.9 : 0.4 + rng() * 0.3;
          this.starGfx.fillStyle(bright ? COLOR_STAR_BRIGHT : COLOR_STAR_DIM, alpha);
          this.starGfx.fillRect(x - size / 2, y - size / 2, size, size);
        }
      }
    }
  }

  // ── paralax ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * Gera a camada de nebulosas num RenderTexture.
   * Cada nebulosa é um conjunto de círculos concêntricos semitransparentes
   * com cor variável (azul-roxo, verde-azul, laranja-avermelhado).
   * Constelacões são desenhadas por cima como pontos + linhas finas.
   */
  private buildNebulaLayer(rt: Phaser.GameObjects.RenderTexture) {
    const g = this.add.graphics();
    const S = BG_SIZE;
    let seed = 0xdeadbeef;
    const rng = () => {
      seed = (seed ^ (seed << 13)) >>> 0;
      seed = (seed ^ (seed >> 17)) >>> 0;
      seed = (seed ^ (seed << 5)) >>> 0;
      return seed / 0x100000000;
    };

    // paleta de cores de nebulosas
    const nebPalette = [
      [0x1a1a6e, 0x3a2a9e, 0x6040cc], // azul-roxo (emissão)
      [0x0d3d2a, 0x1a7a50, 0x30c880], // verde-azul (oxigênio)
      [0x5a1a00, 0xb03010, 0xff6030], // laranja-vermelho (hidrogênio)
      [0x1a0a3a, 0x4a1a7a, 0x9040c0], // violeta (ionizado)
      [0x002040, 0x004880, 0x0090d0], // azul-ciano (reflexo)
    ];

    // 30 nebulosas espalhadas pelo canvas
    for (let n = 0; n < 30; n++) {
      const nx = rng() * S;
      const ny = rng() * S;
      const pal = nebPalette[Math.floor(rng() * nebPalette.length)];
      const rx = 80 + rng() * 320;  // raio horizontal
      const ry = 50 + rng() * 200;  // raio vertical (elíptica)
      const rot = rng() * Math.PI;  // rotação da elípse
      const layers = 7;
      for (let l = layers; l >= 0; l--) {
        const t = l / layers;
        const alpha = (1 - t) * 0.38 * (0.5 + rng() * 0.5);
        const col = l < 2 ? pal[2] : l < 5 ? pal[1] : pal[0];
        g.fillStyle(col, alpha);
        // simula elípse com strokePoints de um círculo escalado
        const pts: { x: number; y: number }[] = [];
        const steps = 24;
        for (let i = 0; i < steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          const lx = Math.cos(a) * rx * t;
          const ly = Math.sin(a) * ry * t;
          pts.push({
            x: nx + lx * Math.cos(rot) - ly * Math.sin(rot),
            y: ny + lx * Math.sin(rot) + ly * Math.cos(rot),
          });
        }
        g.fillPoints(pts, true);
      }
      // núcleos brilhantes
      g.fillStyle(pal[2], 0.55);
      g.fillCircle(nx, ny, 12 + rng() * 28);
    }

    // constelacões: grupos de 4-7 estrelas conectadas por linhas finas
    const CONST_COUNT = 12;
    for (let c = 0; c < CONST_COUNT; c++) {
      const cx = rng() * S;
      const cy = rng() * S;
      const starCount = 4 + Math.floor(rng() * 4);
      const pts: { x: number; y: number }[] = [];
      for (let s = 0; s < starCount; s++) {
        pts.push({ x: cx + (rng() - 0.5) * 400, y: cy + (rng() - 0.5) * 400 });
      }
      // linhas da constelacão (cadeia simples)
      g.lineStyle(0.8, 0x8899cc, 0.25);
      for (let s = 0; s < pts.length - 1; s++) {
        g.lineBetween(pts[s].x, pts[s].y, pts[s + 1].x, pts[s + 1].y);
      }
      // estrelas da constelacão
      for (const p of pts) {
        g.fillStyle(0xddeeff, 0.7 + rng() * 0.3);
        g.fillCircle(p.x, p.y, 1.2 + rng() * 1.5);
      }
    }

    rt.draw(g, 0, 0);
    g.destroy();
  }

  /**
   * Gera a camada de estrelas densas da Via Láctea num RenderTexture.
   * Faixa diagonal de alta densidade com gradiente de cor (azul-branco no centro,
   * amarelado nas bordas) simulando o bojo galáctico.
   */
  private buildMilkyLayer(rt: Phaser.GameObjects.RenderTexture) {
    const g = this.add.graphics();
    const S = BG_SIZE;
    let seed = 0xcafebabe;
    const rng = () => {
      seed = (seed ^ (seed << 13)) >>> 0;
      seed = (seed ^ (seed >> 17)) >>> 0;
      seed = (seed ^ (seed << 5)) >>> 0;
      return seed / 0x100000000;
    };

    // faixa diagonal da Via Láctea: distribuição gaussiana ao redor de uma linha
    const angle = Math.PI * 0.22; // ~40 graus
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const bandW = S * 0.38; // largura da faixa (desvio padrão)

    const STAR_COUNT = 5000;
    for (let i = 0; i < STAR_COUNT; i++) {
      // posição ao longo da faixa + desvio gaussiano perpendicular
      const along = rng() * S * 1.4 - S * 0.2;
      // Box-Muller para distribuição gaussiana
      const u1 = Math.max(1e-9, rng());
      const u2 = rng();
      const gauss = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const perp = gauss * bandW * 0.28;

      const sx = S / 2 + along * cosA - perp * sinA;
      const sy = S / 2 + along * sinA + perp * cosA;
      if (sx < 0 || sx > S || sy < 0 || sy > S) continue;

      // distância ao centro da faixa determina cor e brilho
      const distNorm = Math.abs(perp) / (bandW * 0.28);
      const core = distNorm < 0.5;
      const size = core ? 0.9 + rng() * 0.8 : 0.5 + rng() * 0.5;
      const alpha = core ? 0.75 + rng() * 0.25 : 0.35 + rng() * 0.35;

      // cor: centro azul-branco, bordas amarelado
      let col: number;
      if (distNorm < 0.3) col = 0xd0e8ff;       // azul-branco (bojo)
      else if (distNorm < 0.6) col = 0xfff0d0;  // branco-amarelado
      else col = 0xffddaa;                        // amarelado (bordas)

      g.fillStyle(col, alpha);
      g.fillRect(sx - size / 2, sy - size / 2, size, size);
    }

    // bojo central: mancha difusa muito mais brilhante
    for (let l = 10; l >= 0; l--) {
      const t = l / 10;
      g.fillStyle(0xfff8e8, t * 0.22);
      g.fillEllipse(S / 2, S / 2, S * 0.32 * t, S * 0.14 * t);
    }
    // núcleo central intenso
    for (let l = 5; l >= 0; l--) {
      const t = l / 5;
      g.fillStyle(0xffffff, t * 0.18);
      g.fillEllipse(S / 2, S / 2, S * 0.10 * t, S * 0.05 * t);
    }

    rt.draw(g, 0, 0);
    g.destroy();
  }

  private makeShipGfx(color: number, kind: ShipKind): Phaser.GameObjects.Graphics {
    const g = this.add.graphics();
    g.lineStyle(this.strokeW(), color);
    g.strokePoints(shipVerts(kind), true, true);
    this.worldLayer.add(g);
    if (this.ownGfx) this.worldLayer.bringToTop(this.ownGfx);
    return g;
  }

  /** Cor de uma nave conforme o dono: própria pilotada, minha frota, ou alheia. */
  private shipColor(server: ServerShip, id: string): number {
    if (id === this.myShipId) return COLOR_OWN;
    if (server.owner === this.room.sessionId) return COLOR_FLEET_OWN;
    return COLOR_REMOTE;
  }

  /** Velocidade angular do asteroide hospedeiro de uma estrutura (rad/s). */
  private asteroidSpinById(st: ServerStructure): number {
    if (!st.asteroidId) return 0;
    for (const a of sectorAsteroids(this.worldSeed, st.sx, st.sy)) {
      if (a.id === st.asteroidId) return asteroidSpin(a.shapeSeed) * MAX_ASTEROID_SPIN;
    }
    return 0;
  }

  private makeStructGfx(): Phaser.GameObjects.Graphics {
    const g = this.add.graphics();
    this.worldLayer.add(g);
    return g;
  }

  /**
   * Desenha a estrutura + as vagas de hangar junto à base, com as naves que
   * as ocupam. Tudo em coordenadas locais — gira em grupo com o asteroide.
   */
  private drawStructInto(view: StructView, occupants: ShipKind[]) {
    const g = view.gfx;
    const w = this.strokeW();
    g.clear();
    g.lineStyle(w, view.own ? COLOR_STRUCT_OWN : COLOR_STRUCT_OTHER);
    g.strokePoints(structureVerts(view.type, view.radius), true, true);

    // vagas do hangar: fileira abaixo da base
    // expandidas (0..expandedBays-1): retangulares (mais largas) — cabem mining
    // normais (expandedBays..shipBays-1): quadradas menores — builder/attack
    const expandedBays = view.expandedBays;
    const cap = view.shipBays;
    const slotN = SHIP_RADIUS * 2.0;          // lado da vaga normal (quadrado)
    const slotEW = SHIP_RADIUS * 3.2;         // largura da vaga expandida
    const slotEH = SHIP_RADIUS * 2.4;         // altura da vaga expandida
    const gap = SHIP_RADIUS * 0.5;            // espaço entre vagas
    const y0 = view.radius + slotEH * 0.6;   // linha base das vagas

    // calcula largura total para centralizar
    let totalW = 0;
    for (let i = 0; i < cap; i++) {
      totalW += (i < expandedBays ? slotEW : slotN) + (i > 0 ? gap : 0);
    }
    let curX = -totalW / 2;
    for (let i = 0; i < cap; i++) {
      const isExp = i < expandedBays;
      const sw = isExp ? slotEW : slotN;
      const sh = isExp ? slotEH : slotN;
      const cx = curX + sw / 2;
      g.lineStyle(Math.max(w * 0.5, 0.5), COLOR_HANGAR);
      g.strokeRect(cx - sw / 2, y0 - sh / 2, sw, sh);
      // marca visual nas expandidas: linha horizontal no terço superior
      if (isExp) {
        g.lineStyle(Math.max(w * 0.3, 0.3), COLOR_HANGAR);
        g.lineBetween(cx - sw / 2 + w, y0 - sh / 2 + sh * 0.28, cx + sw / 2 - w, y0 - sh / 2 + sh * 0.28);
      }
      const kind = occupants[i];
      if (kind) {
        g.lineStyle(w * 0.75, view.own ? COLOR_FLEET_OWN : COLOR_REMOTE);
        const scale = isExp ? 0.9 : 0.7;
        const mini = shipVerts(kind).map((v) => ({ x: cx + v.x * scale, y: y0 + v.y * scale }));
        g.strokePoints(mini, true, true);
      }
      curX += sw + gap;
    }
  }

  /** Jato de propulsão pixelado (azul/roxo), escala com a velocidade. */
  private drawJet(x: number, y: number, angle: number, speed: number) {
    // normaliza contra 2×max (táxi) — nave comum chega a ~0.5, táxi a ~1
    const k = Math.min(speed / (SHIP_MAX_SPEED * 2), 1);
    if (k < 0.03) return;
    const g = this.jetGfx;
    const back = angle + Math.PI;
    const bx = Math.cos(back);
    const by = Math.sin(back);
    const px_ = -by; // perpendicular
    const py_ = bx;
    const t = this.time.now / 1000;
    const len = SHIP_RADIUS * (0.6 + 3.2 * k);
    const n = 2 + Math.floor(k * 8); // 2..10 "pixels"
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n;
      const flick = Math.sin(t * 31 + i * 2.7 + x * 0.013);
      const jitter = flick * SHIP_RADIUS * 0.28 * f;
      const cx = x + bx * (SHIP_RADIUS * 0.75 + f * len) + px_ * jitter;
      const cy = y + by * (SHIP_RADIUS * 0.75 + f * len) + py_ * jitter;
      const size = SHIP_RADIUS * (0.42 - f * 0.22) * (0.7 + 0.6 * k);
      g.fillStyle(i % 2 === 0 ? COLOR_JET_BLUE : COLOR_JET_PURPLE, 0.95 - f * 0.55);
      g.fillRect(cx - size / 2, cy - size / 2, size, size);
    }
  }

  /** Largura de traço em unidades de mundo para dar SCREEN_LINE_WIDTH px na tela. */
  private strokeW(): number {
    return Phaser.Math.Clamp(SCREEN_LINE_WIDTH / this.cameras.main.zoom, 0.5, 80);
  }

  /** Redesenha naves e asteroides com a largura de traço do zoom atual. */
  private redrawStrokes() {
    const w = this.strokeW();
    this.ownGfx.clear();
    this.ownGfx.lineStyle(w, COLOR_OWN);
    this.ownGfx.strokePoints(shipVerts(this.localShip?.kind ?? "builder"), true, true);
    for (const view of this.remotes.values()) {
      view.gfx.clear();
      view.gfx.lineStyle(w, view.color);
      view.gfx.strokePoints(shipVerts(view.kind), true, true);
    }
    // estruturas: invalida a assinatura → redesenhadas no próximo draw
    for (const view of this.structViews.values()) view.lastSig = "\0";
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
    this.ownGfx.setPosition(own.x, own.y).setRotation(ownAngle);
    this.cameras.main.centerOn(own.x, own.y);

    // paralax: desloca as camadas de fundo proporcionalmente ao movimento da câmera
    const sw = this.scale.width;
    const sh = this.scale.height;
    const cx = sw / 2;
    const cy = sh / 2;
    const dx = own.x - this.bgLastX;
    const dy = own.y - this.bgLastY;
    this.bgLastX = own.x;
    this.bgLastY = own.y;
    // acumula offset em espaço de tela (sem zoom) e envolve no tamanho do tile
    const nx = ((this.bgNebula.x - cx - dx * PARALLAX_NEBULA + BG_SIZE * 4) % BG_SIZE) + cx - BG_SIZE / 2;
    const ny = ((this.bgNebula.y - cy - dy * PARALLAX_NEBULA + BG_SIZE * 4) % BG_SIZE) + cy - BG_SIZE / 2;
    this.bgNebula.setPosition(nx + BG_SIZE / 2, ny + BG_SIZE / 2);
    const mx = ((this.bgMilky.x - cx - dx * PARALLAX_MILKY + BG_SIZE * 4) % BG_SIZE) + cx - BG_SIZE / 2;
    const my = ((this.bgMilky.y - cy - dy * PARALLAX_MILKY + BG_SIZE * 4) % BG_SIZE) + cy - BG_SIZE / 2;
    this.bgMilky.setPosition(mx + BG_SIZE / 2, my + BG_SIZE / 2);

    // rotação leve dos asteroides (visual, determinística por semente)
    const tt = this.time.now / 1000;
    for (const a of this.asteroidGfx) a.gfx.setRotation(a.spin * tt);

    // jatos de propulsão (pixelados): nave própria + remotas em movimento
    this.jetGfx.clear();
    this.drawJet(own.x, own.y, this.localShip!.angle, Math.hypot(this.localShip!.vx, this.localShip!.vy));

    // naves remotas: interpolação em direção ao snapshot do servidor
    for (const [id, server] of this.serverShips) {
      // pula a nave ativa (é a própria) e as guardadas no hangar
      if (id === this.myShipId || server.stored) {
        this.remotes.get(id)?.gfx.setVisible(false);
        continue;
      }
      let view = this.remotes.get(id);
      if (!view) {
        const color = this.shipColor(server, id);
        view = {
          gfx: this.makeShipGfx(color, server.kind).setDepth(9),
          rx: 0, ry: 0, angle: 0, initialized: false,
          kind: server.kind, color,
        };
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
      view.gfx.setPosition(view.rx, view.ry).setRotation(view.angle).setVisible(true);
      this.drawJet(view.rx, view.ry, view.angle, Math.hypot(server.vx, server.vy));
    }

    // estruturas: vivem DENTRO do asteroide hospedeiro e giram em grupo com
    // ele; hangares desenhados junto à base com as naves que os ocupam
    for (const [id, st] of this.serverStructures) {
      let view = this.structViews.get(id);
      if (!view) {
        const own_ = st.owner === this.room.sessionId;
        view = {
          gfx: this.makeStructGfx(),
          type: st.stype,
          radius: STRUCTURE_SPECS[st.stype].radius,
          shipBays: st.shipBays,
          expandedBays: st.expandedBays,
          own: own_,
          spin: this.asteroidSpinById(st),
          lastSig: "\0",
        };
        this.structViews.set(id, view);
      }
      // ocupantes do hangar desta estrutura (estáveis por id)
      const occupants: ShipKind[] = [];
      for (const [sid_, s] of [...this.serverShips].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        void sid_;
        if (s.stored && s.hqId === id) occupants.push(s.kind);
      }
      const sig = occupants.join(",");
      if (sig !== view.lastSig) {
        view.lastSig = sig;
        this.drawStructInto(view, occupants);
      }
      const p = this.toRender(st);
      view.gfx.setPosition(p.x, p.y).setRotation(st.angle + view.spin * tt);
    }

    const anchored = authoritative?.anchored ?? this.localShip!.anchored;

    // feixe de mineração (nave própria)
    this.beamGfx.clear();
    if (this.lastInput.mine) {
      const target = frameSim.nearestAsteroid(this.localShip!);
      if (target) {
        const t = this.toRender(target);
        const beamW = Phaser.Math.Clamp(SCREEN_BEAM_WIDTH / this.cameras.main.zoom, 0.5, 60);
        this.beamGfx.lineStyle(beamW, COLOR_BEAM, 0.8);
        this.beamGfx.lineBetween(own.x, own.y, t.x, t.y);
      }
    }

    // fronteira do mapa (arena)
    this.boundaryGfx.clear();
    if (this.mapCenter && this.mapRadius > 0) {
      const c = this.toRender(this.mapCenter);
      const bw = Phaser.Math.Clamp(SCREEN_LINE_WIDTH / this.cameras.main.zoom, 0.5, 120);
      this.boundaryGfx.lineStyle(bw, COLOR_BOUNDARY, 0.7);
      this.boundaryGfx.strokeCircle(c.x, c.y, this.mapRadius);
    }

    // zona de pouso: círculo amarelo piscante de 20% do raio do asteroide mais próximo
    // exibido apenas quando em voo livre (não pousado/ancorado/animando)
    this.landZoneGfx.clear();
    if (!anchored && lPhaseRender === "") {
      const landZoneAst = frameSim.nearestAsteroid(this.localShip!, DOCK_RANGE * 2);
      if (landZoneAst) {
        const zoneRadius = landZoneAst.radius + DOCK_RANGE;
        const ap = this.toRender(landZoneAst);
        const pulse = 0.4 + 0.4 * Math.sin(this.time.now / 220);
        const lw = Phaser.Math.Clamp(SCREEN_LINE_WIDTH * 1.5 / this.cameras.main.zoom, 0.5, 100);
        this.landZoneGfx.lineStyle(lw, 0xffdd44, pulse);
        this.landZoneGfx.fillStyle(0xffdd44, pulse * 0.12);
        this.landZoneGfx.fillCircle(ap.x, ap.y, zoneRadius);
        this.landZoneGfx.strokeCircle(ap.x, ap.y, zoneRadius);
      }
    }

    this.drawMinimap(own);

    const ore = Math.floor(this.myOre);
    const zoom = this.cameras.main.zoom;
    const activeKind = this.serverShips.get(this.myShipId)?.kind ?? "builder";
    const kindLabel: Record<ShipKind, string> = { builder: "builder", mining: "mineração", attack: "ataque" };

    // frota própria por tipo + hangar do QG ancorado + QG
    let nMining = 0;
    let nAttack = 0;
    let hangarMining = 0;
    let hangarAttack = 0;
    for (const [id, s] of this.serverShips) {
      if (s.owner !== this.room.sessionId || id === this.myShipId) continue;
      if (s.kind === "mining") nMining++;
      else if (s.kind === "attack") nAttack++;
      if (s.stored) {
        if (s.kind === "mining") hangarMining++;
        else if (s.kind === "attack") hangarAttack++;
      }
    }
    let hasHq = false;
    let nearOwnStation = false;
    let nearOwnStruct: ServerStructure | null = null;
    for (const st of this.serverStructures.values()) {
      if (st.owner !== this.room.sessionId) continue;
      if (st.stype === "hq") hasHq = true;
      if (st.stype === "miningStation" && dist(this.localShip!, st) <= DOCK_RANGE) nearOwnStation = true;
      if (dist(this.localShip!, st) <= DOCK_RANGE) {
        if (!nearOwnStruct || dist(this.localShip!, st) < dist(this.localShip!, nearOwnStruct)) {
          nearOwnStruct = st;
        }
      }
    }
    // vagas livres na estrutura mais próxima (para feedback de ancoragem)
    const nearStructOccupied = nearOwnStruct
      ? [...this.serverShips.values()].filter(
          (s) => s.hqId === [...this.serverStructures.entries()].find(([, v]) => v === nearOwnStruct)?.[0]
            && (s.stored || s.anchored),
        ).length
      : 0;
    const nearStructFree = nearOwnStruct ? Math.max(0, nearOwnStruct.shipBays - nearStructOccupied) : 0;
    const hangarTotal = hangarMining + hangarAttack;

    // dicas de construção e produção (produção constrói no QG mais próximo)
    const p3 = SHIP_PRODUCTION.mining;
    const p4 = SHIP_PRODUCTION.attack;
    const p5 = SHIP_PRODUCTION.builder;
    const mark = (ok: boolean) => (ok ? "» " : "  ");
    const need = !hasHq ? " — precisa de QG" : !anchored ? " — ancore [F]" : "";
    const hint3 = `[3] ${p3.label} (${p3.cost})${need}`;
    const hint4 = `[4] ${p4.label} (${p4.cost})${need}`;
    const hint5 = `[5] ${p5.label} (${p5.cost})${need}`;
    // [3]/[4] só aparecem ancorado no QG
    const anchoredInHq = anchored && (() => {
      const hqId = mineAuth?.hqId ?? "";
      const st = this.serverStructures.get(hqId);
      return !!st && st.stype === "hq";
    })();
    const anchorTag = anchored ? "  ⚓ ANCORADO" : "";
    // [F] só aparece quando dentro da zona de pouso (this.inLandZone)
    const canAnchor = !anchored && this.inLandZone;
    const anchorHint = canAnchor
      ? nearOwnStruct !== null
        ? nearStructFree > 0
          ? `  » [F] pousar (${nearStructFree} vaga${nearStructFree !== 1 ? "s" : ""} livre${nearStructFree !== 1 ? "s" : ""})`
          : "  ⚓ hangar cheio"
        : "  » [F] pousar"
      : "";
    const swapHint = anchored && !this.isFlying && hangarTotal > 0 ? `  » [C] trocar (hangar: ${hangarTotal})` : "";
    // [G] auto-mineração: pilotando mineradora ancorada na própria estação
    const canAuto = activeKind === "mining" && anchored && !this.isFlying && nearOwnStation;
    const autoHint = canAuto ? "  » [G] auto-minerar na estação" : "";
    // buffer da estação (quando builder ancorado na estação)
    const anchoredStationStruct = anchored ? (() => {
      const st = this.serverStructures.get(mineAuth?.hqId ?? "");
      return (st && st.stype === "miningStation") ? st : null;
    })() : null;
    const builderMining = anchoredStationStruct && (mineAuth?.mining ?? false);
    const stationBufferHint = anchoredStationStruct
      ? `  ·  Buffer: ${Math.floor(anchoredStationStruct.mineBuffer)}/${STATION_MINE_BUFFER}` +
        (activeKind === "builder" ? (builderMining ? "  » [ESP] parar mineração" : "  » [ESP] minerar") : "")
      : "";
    // [T]/[Y] táxi: só disponível ancorado na PRÓPRIA estação de mineração
    let taxiLine = "";
    if (anchored && nearOwnStation && this.taxiOpts.length > 0) {
      const o = this.taxiOpts[this.taxiSel];
      const km = (o.srcDist / 1000).toFixed(1);
      taxiLine =
        `\nTáxi ▸ ${kindLabel[o.kind]} (QG a ${km}k)  ` +
        `·  [T] trocar seleção (${this.taxiSel + 1}/${this.taxiOpts.length})  ·  [Y] chamar (2× vel.)`;
    }

    // HUD varia conforme a fase de pouso
    const mineServerLanding = this.serverShips.get(this.myShipId);
    const lPhase = mineServerLanding?.landingPhase ?? "";
    if (lPhase === "landing") {
      const pct = Math.round((mineServerLanding?.landingProgress ?? 0) * 100);
      this.hud.setText(`Pousando… ${pct}%`);
    } else if (lPhase === "landed") {
      const canBuild = ore >= STRUCTURE_SPECS.miningStation.cost;
      const isBuilder = activeKind === "builder";
      const miningOn = mineServerLanding?.anchored ?? false;
      this.hud.setText(
        `Pousado no asteroide${miningOn ? "  \u00b7  \u26cf MINERANDO (min\u00e9rio: " + ore + ")" : ""}\n` +
        (miningOn
          ? `[ESPA\u00c7O] parar minera\u00e7\u00e3o\n[F] decolar \u2014 pare a minera\u00e7\u00e3o antes`
          : `[ESPA\u00c7O] iniciar minera\u00e7\u00e3o autom\u00e1tica\n` +
            (isBuilder
              ? `[1] construir esta\u00e7\u00e3o de minera\u00e7\u00e3o (${STRUCTURE_SPECS.miningStation.cost} min\u00e9rio)${canBuild ? "" : " \u2014 sem min\u00e9rio"}\n` +
                `[2] construir QG (${STRUCTURE_SPECS.hq.cost} min\u00e9rio)${ore >= STRUCTURE_SPECS.hq.cost ? "" : " \u2014 sem min\u00e9rio"}\n`
              : "") +
            `[F] decolar`),
      );
    } else {
      const landHint = canAnchor ? " · [F] pousar" : "";
      const prodLine = anchoredInHq
        ? `\n${mark(ore >= p3.cost)}${hint3}   ${mark(ore >= p4.cost)}${hint4}   ${mark(ore >= p5.cost)}${hint5}`
        : "";
      this.hud.setText(
        `Minério: ${ore}  ·  Pilotando: ${kindLabel[activeKind]}  ·  Zoom ${zoom.toFixed(2)}x${anchorTag}${anchorHint}${swapHint}${autoHint}${stationBufferHint}\n` +
          `W/↑ acelerar · A/D girar${landHint}${(!anchored && !this.isFlying) ? " · [G] auto-minerar" : ""}${(!anchored && !this.isFlying) ? " · [C] trocar" : ""} · roda/+/- zoom` +
          prodLine +
          taxiLine,
      );
    }
  }

  /** Minimapa no canto superior direito, centrado na nave própria. */
  private drawMinimap(own: { x: number; y: number }) {
    const size = MINIMAP_SIZE;
    const x0 = this.scale.width - size - MINIMAP_MARGIN;
    const y0 = MINIMAP_MARGIN;
    const cx = x0 + size / 2;
    const cy = y0 + size / 2;
    const range = this.minimapFull && this.mapRadius > 0 ? this.mapRadius : MINIMAP_RANGE;
    const k = size / 2 / range;
    const half = size / 2;

    const g = this.minimapGfx;
    g.clear();
    g.fillStyle(COLOR_MINIMAP_BG, 0.55);
    g.fillRect(x0, y0, size, size);
    g.lineStyle(1, COLOR_MINIMAP_BORDER, 1);
    g.strokeRect(x0, y0, size, size);

    // fronteiras de setor
    g.lineStyle(1, COLOR_MINIMAP_GRID, 1);
    for (let i = -1; i <= 2; i++) {
      const dx = (i * SECTOR_SIZE - own.x) * k;
      if (Math.abs(dx) < half) g.lineBetween(cx + dx, y0, cx + dx, y0 + size);
      const dy = (i * SECTOR_SIZE - own.y) * k;
      if (Math.abs(dy) < half) g.lineBetween(x0, cy + dy, x0 + size, cy + dy);
    }

    // fronteira da arena no modo mapa inteiro
    if (this.minimapFull && this.mapCenter && this.mapRadius > 0) {
      const mc = this.toRender(this.mapCenter);
      g.lineStyle(1, COLOR_BOUNDARY, 0.7);
      g.strokeCircle(cx + (mc.x - own.x) * k, cy + (mc.y - own.y) * k, this.mapRadius * k);
    }

    // asteroides coloridos por classe (P=cinza, M=dourado, G=ouro)
    for (const a of this.nearbyAsteroids) {
      const dx = (a.rx - own.x) * k;
      const dy = (a.ry - own.y) * k;
      if (Math.abs(dx) < half - 2 && Math.abs(dy) < half - 2) {
        const col = parseInt(ASTEROID_CLASSES[a.asteroidClass as keyof typeof ASTEROID_CLASSES].color.slice(1), 16);
        g.fillStyle(col, 1);
        g.fillCircle(cx + dx, cy + dy, 1.5);
      }
    }

    // naves remotas
    g.fillStyle(COLOR_REMOTE, 1);
    for (const view of this.remotes.values()) {
      const dx = (view.rx - own.x) * k;
      const dy = (view.ry - own.y) * k;
      if (Math.abs(dx) < half - 2 && Math.abs(dy) < half - 2) {
        g.fillCircle(cx + dx, cy + dy, 2.5);
      }
    }

    // nave própria: ponto central + traço de direção
    g.fillStyle(COLOR_OWN, 1);
    g.fillCircle(cx, cy, 3);
    g.lineStyle(1, COLOR_OWN, 1);
    const ang = this.localShip!.angle;
    g.lineBetween(cx, cy, cx + Math.cos(ang) * 9, cy + Math.sin(ang) * 9);
  }
}
