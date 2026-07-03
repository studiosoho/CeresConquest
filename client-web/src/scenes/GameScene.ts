import Phaser from "phaser";
import { Client, type Room } from "colyseus.js";
import {
  DEFAULT_PORT,
  MSG_INPUT,
  SECTOR_SIZE,
  relVec,
  type ShipInput,
  type WorldPos,
} from "@ceres/shared";
import {
  SimWorld,
  makeShip,
  stepShip,
  sectorAsteroids,
  type ShipState,
} from "@ceres/sim-core";
import { SHIP_VERTS, asteroidVerts } from "../shapes";

const COLOR_OWN = 0xffffff;
const COLOR_REMOTE = 0x7f8ea3;
const COLOR_ASTEROID = 0x5a6b7a;
const COLOR_BEAM = 0x9fd4ff;

/** Largura das linhas do wireframe (dobrada). */
const LINE_WIDTH = 3;
const BEAM_WIDTH = 2;

/** Zoom inicial: os asteroides agora são grandes; parte-se afastado para ver a escala. */
const INITIAL_ZOOM = 0.5;

const INPUT_SEND_HZ = 30;
/** fator de correção por frame em direção ao estado autoritativo */
const OWN_BLEND = 0.1;
const REMOTE_BLEND = 0.3;

// ── zoom ──
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 3;
const ZOOM_WHEEL_STEP = 1.15;
const ZOOM_KEY_STEP = 1.03;
const ZOOM_SMOOTH = 0.15;

// ── minimapa ──
const MINIMAP_SIZE = 220;
const MINIMAP_MARGIN = 12;
/** alcance do minimapa: unidades do centro até a borda */
const MINIMAP_RANGE = 15_000;
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
}

/** Snapshot plano de uma nave vindo do schema Colyseus. */
interface ServerShip extends WorldPos {
  vx: number;
  vy: number;
  angle: number;
  ore: number;
  mining: boolean;
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

  private ownGfx!: Phaser.GameObjects.Graphics;
  private beamGfx!: Phaser.GameObjects.Graphics;
  private remotes = new Map<string, RemoteView>();
  private asteroidGfx: Phaser.GameObjects.Graphics[] = [];
  private hud!: Phaser.GameObjects.Text;

  /** câmera de UI (sem zoom/scroll) e camadas separadas mundo × interface */
  private uiCam!: Phaser.Cameras.Scene2D.Camera;
  private worldLayer!: Phaser.GameObjects.Container;
  private uiLayer!: Phaser.GameObjects.Container;
  private minimapGfx!: Phaser.GameObjects.Graphics;
  /** cache das posições (espaço de render) dos asteroides 3×3 — para o minimapa */
  private nearbyAsteroids: Array<{ rx: number; ry: number }> = [];
  private zoomTarget = INITIAL_ZOOM;

  private keys!: Record<
    "W" | "A" | "S" | "D" | "UP" | "LEFT" | "RIGHT" | "SPACE" | "PLUS" | "MINUS",
    Phaser.Input.Keyboard.Key
  >;
  private sendAccum = 0;
  private lastInput: ShipInput = { thrust: false, turn: 0, mine: false };

  constructor() {
    super("game");
  }

  async create() {
    this.keys = this.input.keyboard!.addKeys(
      "W,A,S,D,UP,LEFT,RIGHT,SPACE,PLUS,MINUS",
    ) as GameScene["keys"];

    // camadas: a câmera principal (com zoom) só vê o mundo;
    // a câmera de UI (fixa) só vê HUD e minimapa
    this.worldLayer = this.add.container(0, 0);
    this.uiLayer = this.add.container(0, 0);

    this.beamGfx = this.add.graphics();
    this.worldLayer.add(this.beamGfx);
    this.ownGfx = this.makeShipGfx(COLOR_OWN);
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

    const seen = new Set<string>();
    state.ships.forEach((s: any, id: string) => {
      seen.add(id);
      this.serverShips.set(id, {
        sx: s.sx, sy: s.sy, x: s.x, y: s.y,
        vx: s.vx, vy: s.vy, angle: s.angle,
        ore: s.ore, mining: s.mining,
      });
    });
    for (const id of [...this.serverShips.keys()]) {
      if (!seen.has(id)) {
        this.serverShips.delete(id);
        this.remotes.get(id)?.gfx.destroy();
        this.remotes.delete(id);
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

    // input → predição local (mesmo stepShip do servidor) → envio
    const input = this.readInput();
    stepShip(this.localShip, input, dt);
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
    for (const g of this.asteroidGfx) g.destroy();
    this.asteroidGfx = [];
    this.nearbyAsteroids = [];
    // 3×3 setores ao redor da origem — muito além do alcance da tela
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        for (const a of sectorAsteroids(this.worldSeed, this.origin.sx + ox, this.origin.sy + oy)) {
          const pos = this.toRender(a);
          const g = this.add.graphics({ x: pos.x, y: pos.y });
          g.lineStyle(LINE_WIDTH, COLOR_ASTEROID);
          g.strokePoints(asteroidVerts(a.shapeSeed, a.radius), true, true);
          this.worldLayer.add(g);
          this.worldLayer.sendToBack(g);
          this.asteroidGfx.push(g);
          this.nearbyAsteroids.push({ rx: pos.x, ry: pos.y });
        }
      }
    }
  }

  private makeShipGfx(color: number): Phaser.GameObjects.Graphics {
    const g = this.add.graphics();
    g.lineStyle(LINE_WIDTH, color);
    g.strokePoints(SHIP_VERTS, true, true);
    this.worldLayer.add(g);
    if (this.ownGfx) this.worldLayer.bringToTop(this.ownGfx);
    return g;
  }

  private draw(_dt: number, authoritative: ServerShip | undefined) {
    const own = this.toRender(this.localShip!);
    this.ownGfx.setPosition(own.x, own.y).setRotation(this.localShip!.angle);
    this.cameras.main.centerOn(own.x, own.y);

    // naves remotas: interpolação em direção ao snapshot do servidor
    for (const [id, server] of this.serverShips) {
      if (id === this.room.sessionId) continue;
      let view = this.remotes.get(id);
      if (!view) {
        view = { gfx: this.makeShipGfx(COLOR_REMOTE).setDepth(9), rx: 0, ry: 0, angle: 0, initialized: false };
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

    // feixe de mineração (nave própria)
    this.beamGfx.clear();
    if (this.lastInput.mine) {
      const sim = new SimWorld(this.worldSeed);
      const target = sim.nearestAsteroid(this.localShip!);
      if (target) {
        const t = this.toRender(target);
        this.beamGfx.lineStyle(BEAM_WIDTH, COLOR_BEAM, 0.8);
        this.beamGfx.lineBetween(own.x, own.y, t.x, t.y);
      }
    }

    this.drawMinimap(own);

    const ore = Math.floor(authoritative?.ore ?? this.localShip!.ore);
    const zoom = this.cameras.main.zoom;
    this.hud.setText(
      `Minério: ${ore}  ·  Jogadores: ${this.serverShips.size}  ·  Setor (${this.localShip!.sx}, ${this.localShip!.sy})  ·  Zoom ${zoom.toFixed(2)}x\n` +
        `W/↑ acelerar · A/D ou ←/→ girar · ESPAÇO minerar · roda/+/- zoom`,
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
