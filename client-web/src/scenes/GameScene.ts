import Phaser from "phaser";
import { Client, type Room } from "colyseus.js";
import {
  DEFAULT_PORT,
  MSG_INPUT,
  MSG_BUILD,
  MSG_PRODUCE,
  MSG_ANCHOR,
  SECTOR_SIZE,
  STRUCTURE_SPECS,
  SHIP_PRODUCTION,
  HANGAR_CAP,
  BUILD_ASTEROID_RANGE,
  relVec,
  mapSizeFromRadiusSectors,
  type MapSize,
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
const COLOR_ASTEROID = 0x5a6b7a;
const COLOR_BEAM = 0x9fd4ff;
const COLOR_BOUNDARY = 0xcc5544;
const COLOR_STRUCT_OWN = 0x5fd0a8;
const COLOR_STRUCT_OTHER = 0xc8985a;
/** naves da minha frota (produzidas, autônomas) */
const COLOR_FLEET_OWN = 0x8fe36a;

const MAP_SIZE_LABEL: Record<MapSize | "custom", string> = {
  small: "pequeno",
  medium: "médio",
  large: "grande",
  custom: "custom",
};

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
  ore: number;
  mining: boolean;
  owner: string;
  kind: ShipKind;
  anchored: boolean;
}

/** Snapshot plano de uma estrutura vinda do schema. */
interface ServerStructure extends WorldPos {
  stype: StructureType;
  owner: string;
  angle: number;
}

interface StructView {
  gfx: Phaser.GameObjects.Graphics;
  type: StructureType;
  radius: number;
  own: boolean;
}

export class GameScene extends Phaser.Scene {
  private room!: Room;
  private worldSeed = 0;
  private ready = false;

  /** nave própria, predita localmente com o mesmo sim-core do servidor */
  private localShip: ShipState | null = null;
  private serverShips = new Map<string, ServerShip>();

  /** origem flutuante: setor de referência do espaço de render */
  private origin = { sx: 0, sy: 0 };

  /** fronteira do mapa (arena) recebida do servidor */
  private mapCenter: WorldPos | null = null;
  private mapRadius = 0;

  private ownGfx!: Phaser.GameObjects.Graphics;
  private beamGfx!: Phaser.GameObjects.Graphics;
  private boundaryGfx!: Phaser.GameObjects.Graphics;
  private remotes = new Map<string, RemoteView>();
  private asteroidGfx: Array<{ gfx: Phaser.GameObjects.Graphics; spin: number }> = [];
  private serverStructures = new Map<string, ServerStructure>();
  private structViews = new Map<string, StructView>();
  private hud!: Phaser.GameObjects.Text;

  /** câmera de UI (sem zoom/scroll) e camadas separadas mundo × interface */
  private uiCam!: Phaser.Cameras.Scene2D.Camera;
  private worldLayer!: Phaser.GameObjects.Container;
  private uiLayer!: Phaser.GameObjects.Container;
  private minimapGfx!: Phaser.GameObjects.Graphics;
  /** cache das posições (espaço de render) dos asteroides 3×3 — para o minimapa */
  private nearbyAsteroids: Array<{ rx: number; ry: number }> = [];
  private zoomTarget = INITIAL_ZOOM;
  /** zoom no qual as linhas foram desenhadas por último (para redesenhar) */
  private lastStrokeZoom = 0;

  private keys!: Record<
    | "W" | "A" | "S" | "D" | "UP" | "LEFT" | "RIGHT" | "SPACE" | "PLUS" | "MINUS"
    | "ONE" | "TWO" | "THREE" | "FOUR" | "F",
    Phaser.Input.Keyboard.Key
  >;
  private sendAccum = 0;
  private lastInput: ShipInput = { thrust: false, turn: 0, mine: false };

  constructor() {
    super("game");
  }

  async create() {
    this.keys = this.input.keyboard!.addKeys(
      "W,A,S,D,UP,LEFT,RIGHT,SPACE,PLUS,MINUS,ONE,TWO,THREE,FOUR,F",
    ) as GameScene["keys"];

    // camadas: a câmera principal (com zoom) só vê o mundo;
    // a câmera de UI (fixa) só vê HUD e minimapa
    this.worldLayer = this.add.container(0, 0);
    this.uiLayer = this.add.container(0, 0);

    this.beamGfx = this.add.graphics();
    this.boundaryGfx = this.add.graphics();
    this.worldLayer.add(this.beamGfx);
    this.worldLayer.add(this.boundaryGfx);
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
        ore: s.ore, mining: s.mining,
        owner: s.owner, kind: s.kind, anchored: s.anchored,
      });
    });
    for (const id of [...this.serverShips.keys()]) {
      if (!seen.has(id)) {
        this.serverShips.delete(id);
        this.remotes.get(id)?.gfx.destroy();
        this.remotes.delete(id);
      }
    }

    // estruturas (estáticas): upsert + remoção
    const seenSt = new Set<string>();
    state.structures.forEach((st: any, id: string) => {
      seenSt.add(id);
      this.serverStructures.set(id, {
        stype: st.stype, owner: st.owner, sx: st.sx, sy: st.sy, x: st.x, y: st.y, angle: st.angle,
      });
    });
    for (const id of [...this.serverStructures.keys()]) {
      if (!seenSt.has(id)) {
        this.serverStructures.delete(id);
        this.structViews.get(id)?.gfx.destroy();
        this.structViews.delete(id);
      }
    }

    // primeira visão da própria nave → inicializa predição e origem
    if (!this.ready) {
      const mine = this.serverShips.get(this.room.sessionId);
      if (!mine) return;
      this.localShip = makeShip(mine);
      this.localShip.angle = mine.angle;
      this.setOrigin(mine.sx, mine.sy);
      this.ownGfx.setVisible(true);
      this.ready = true;
    }
  }

  private sendInput(input: ShipInput) {
    this.room.send(MSG_INPUT, input);
  }

  // ── loop ────────────────────────────────────────────────────────────

  update(_time: number, deltaMs: number) {
    if (!this.ready || !this.localShip) return;
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
    if (Phaser.Input.Keyboard.JustDown(this.keys.ONE)) {
      this.room.send(MSG_BUILD, { type: "miningStation" as StructureType });
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.TWO)) {
      this.room.send(MSG_BUILD, { type: "hq" as StructureType });
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.THREE)) {
      this.room.send(MSG_PRODUCE, { kind: "mining" });
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.FOUR)) {
      this.room.send(MSG_PRODUCE, { kind: "attack" });
    }
    if (Phaser.Input.Keyboard.JustDown(this.keys.F)) {
      this.room.send(MSG_ANCHOR);
    }

    const anchored = this.serverShips.get(this.room.sessionId)?.anchored ?? false;

    // input → predição local (mesmo stepShip + colisão do servidor) → envio
    const input = anchored ? { thrust: false, turn: 0 as const, mine: false } : this.readInput();
    if (anchored) {
      this.localShip.vx = 0;
      this.localShip.vy = 0;
    } else {
      stepShip(this.localShip, input, dt);
      collideShip(this.localShip, this.worldSeed);
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
    const authoritative = this.serverShips.get(this.room.sessionId);
    if (authoritative) this.blendTowards(this.localShip, authoritative);

    // origem flutuante acompanha o setor da nave própria
    if (this.localShip.sx !== this.origin.sx || this.localShip.sy !== this.origin.sy) {
      this.setOrigin(this.localShip.sx, this.localShip.sy);
    }

    this.draw(dt, authoritative);
  }

  private readInput(): ShipInput {
    const k = this.keys;
    const turn = (k.A.isDown || k.LEFT.isDown ? -1 : 0) + (k.D.isDown || k.RIGHT.isDown ? 1 : 0);
    return {
      thrust: k.W.isDown || k.UP.isDown,
      turn: turn as ShipInput["turn"],
      mine: k.SPACE.isDown,
    };
  }

  private blendTowards(local: ShipState, server: ServerShip) {
    const { dx, dy } = relVec(local, server);
    local.x += dx * OWN_BLEND;
    local.y += dy * OWN_BLEND;
    local.vx += (server.vx - local.vx) * OWN_BLEND;
    local.vy += (server.vy - local.vy) * OWN_BLEND;
    local.angle += Phaser.Math.Angle.Wrap(server.angle - local.angle) * OWN_BLEND;
    local.ore = server.ore;
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

  private rebuildAsteroids() {
    for (const a of this.asteroidGfx) a.gfx.destroy();
    this.asteroidGfx = [];
    this.nearbyAsteroids = [];
    // 3×3 setores ao redor da origem — muito além do alcance da tela
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        for (const a of sectorAsteroids(this.worldSeed, this.origin.sx + ox, this.origin.sy + oy)) {
          const pos = this.toRender(a);
          const g = this.add.graphics({ x: pos.x, y: pos.y });
          g.lineStyle(this.strokeW(), COLOR_ASTEROID);
          g.strokePoints(asteroidVerts(a.shapeSeed, a.radius), true, true);
          this.worldLayer.add(g);
          this.worldLayer.sendToBack(g);
          this.asteroidGfx.push({ gfx: g, spin: asteroidSpin(a.shapeSeed) * MAX_ASTEROID_SPIN });
          this.nearbyAsteroids.push({ rx: pos.x, ry: pos.y });
        }
      }
    }
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
    if (id === this.room.sessionId) return COLOR_OWN;
    if (server.owner === this.room.sessionId) return COLOR_FLEET_OWN;
    return COLOR_REMOTE;
  }

  private makeStructGfx(type: StructureType, own: boolean): Phaser.GameObjects.Graphics {
    const g = this.add.graphics();
    g.lineStyle(this.strokeW(), own ? COLOR_STRUCT_OWN : COLOR_STRUCT_OTHER);
    g.strokePoints(structureVerts(type, STRUCTURE_SPECS[type].radius), true, true);
    this.worldLayer.add(g);
    return g;
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
    this.ownGfx.strokePoints(shipVerts("builder"), true, true);
    for (const view of this.remotes.values()) {
      view.gfx.clear();
      view.gfx.lineStyle(w, view.color);
      view.gfx.strokePoints(shipVerts(view.kind), true, true);
    }
    for (const view of this.structViews.values()) {
      view.gfx.clear();
      view.gfx.lineStyle(w, view.own ? COLOR_STRUCT_OWN : COLOR_STRUCT_OTHER);
      view.gfx.strokePoints(structureVerts(view.type, view.radius), true, true);
    }
    this.rebuildAsteroids();
  }

  private draw(_dt: number, authoritative: ServerShip | undefined) {
    const own = this.toRender(this.localShip!);
    this.ownGfx.setPosition(own.x, own.y).setRotation(this.localShip!.angle);
    this.cameras.main.centerOn(own.x, own.y);

    // rotação leve dos asteroides (visual, determinística por semente)
    const tt = this.time.now / 1000;
    for (const a of this.asteroidGfx) a.gfx.setRotation(a.spin * tt);

    // naves remotas: interpolação em direção ao snapshot do servidor
    for (const [id, server] of this.serverShips) {
      if (id === this.room.sessionId) continue;
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
      view.gfx.setPosition(view.rx, view.ry).setRotation(view.angle);
    }

    // estruturas (estáticas): cria o gráfico na primeira vez, reposiciona sempre
    for (const [id, st] of this.serverStructures) {
      let view = this.structViews.get(id);
      if (!view) {
        const own_ = st.owner === this.room.sessionId;
        view = {
          gfx: this.makeStructGfx(st.stype, own_),
          type: st.stype,
          radius: STRUCTURE_SPECS[st.stype].radius,
          own: own_,
        };
        this.structViews.set(id, view);
      }
      const p = this.toRender(st);
      view.gfx.setPosition(p.x, p.y).setRotation(st.angle);
    }

    const sim = new SimWorld(this.worldSeed);

    // feixe de mineração (nave própria)
    this.beamGfx.clear();
    if (this.lastInput.mine) {
      const target = sim.nearestAsteroid(this.localShip!);
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

    this.drawMinimap(own);

    const ore = Math.floor(authoritative?.ore ?? this.localShip!.ore);
    const zoom = this.cameras.main.zoom;
    const mapName = MAP_SIZE_LABEL[mapSizeFromRadiusSectors(this.mapRadius / SECTOR_SIZE)];

    // frota própria por tipo + QG
    let fleet = 0;
    let nMining = 0;
    let nAttack = 0;
    let hasHq = false;
    for (const [id, s] of this.serverShips) {
      if (s.owner === this.room.sessionId && id !== this.room.sessionId) {
        fleet++;
        if (s.kind === "mining") nMining++;
        else if (s.kind === "attack") nAttack++;
      }
    }
    for (const st of this.serverStructures.values()) {
      if (st.owner === this.room.sessionId && st.stype === "hq") hasHq = true;
    }
    const anchored = authoritative?.anchored ?? false;

    // dicas de construção e produção
    const nearAst = !!sim.nearestAsteroid(this.localShip!, BUILD_ASTEROID_RANGE);
    const st1 = STRUCTURE_SPECS.miningStation;
    const st2 = STRUCTURE_SPECS.hq;
    const p3 = SHIP_PRODUCTION.mining;
    const p4 = SHIP_PRODUCTION.attack;
    const mark = (ok: boolean) => (ok ? "» " : "  ");
    const need = (n: number) => (!hasHq ? " — QG" : !anchored ? " — ancore [F]" : `  ${n}/${HANGAR_CAP}`);
    const hint1 = `[1] ${st1.label} (${st1.cost})${nearAst ? "" : " — perto de asteroide"}`;
    const hint2 = `[2] ${st2.label} (${st2.cost})`;
    const hint3 = `[3] ${p3.label} (${p3.cost})${need(nMining)}`;
    const hint4 = `[4] ${p4.label} (${p4.cost})${need(nAttack)}`;
    const canProd = (n: number) => hasHq && anchored && n < HANGAR_CAP;
    const anchorTag = anchored ? "  ⚓ ANCORADO" : "";

    this.hud.setText(
      `Minério: ${ore}  ·  Frota: ${fleet}  ·  Mapa: ${mapName}  ·  Estruturas: ${this.serverStructures.size}  ·  Zoom ${zoom.toFixed(2)}x${anchorTag}\n` +
        `W/↑ acelerar · A/D girar · ESPAÇO minerar · [F] ancorar no QG · roda/+/- zoom\n` +
        `${mark(ore >= st1.cost && nearAst)}${hint1}    ${mark(ore >= st2.cost && nearAst)}${hint2}\n` +
        `${mark(canProd(nMining) && ore >= p3.cost)}${hint3}    ${mark(canProd(nAttack) && ore >= p4.cost)}${hint4}`,
    );
  }

  /** Minimapa no canto superior direito, centrado na nave própria. */
  private drawMinimap(own: { x: number; y: number }) {
    const size = MINIMAP_SIZE;
    const x0 = this.scale.width - size - MINIMAP_MARGIN;
    const y0 = MINIMAP_MARGIN;
    const cx = x0 + size / 2;
    const cy = y0 + size / 2;
    const k = size / 2 / MINIMAP_RANGE; // unidades → pixels do minimapa
    const half = size / 2;

    const g = this.minimapGfx;
    g.clear();
    g.fillStyle(COLOR_MINIMAP_BG, 0.55);
    g.fillRect(x0, y0, size, size);
    g.lineStyle(1, COLOR_MINIMAP_BORDER, 1);
    g.strokeRect(x0, y0, size, size);

    // fronteiras de setor (a grade dos quadrantes)
    g.lineStyle(1, COLOR_MINIMAP_GRID, 1);
    for (let i = -1; i <= 2; i++) {
      const dx = (i * SECTOR_SIZE - own.x) * k;
      if (Math.abs(dx) < half) g.lineBetween(cx + dx, y0, cx + dx, y0 + size);
      const dy = (i * SECTOR_SIZE - own.y) * k;
      if (Math.abs(dy) < half) g.lineBetween(x0, cy + dy, x0 + size, cy + dy);
    }

    // asteroides próximos
    g.fillStyle(COLOR_ASTEROID, 1);
    for (const a of this.nearbyAsteroids) {
      const dx = (a.rx - own.x) * k;
      const dy = (a.ry - own.y) * k;
      if (Math.abs(dx) < half - 2 && Math.abs(dy) < half - 2) {
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
