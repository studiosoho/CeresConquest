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

const INPUT_SEND_HZ = 30;
/** fator de correção por frame em direção ao estado autoritativo */
const OWN_BLEND = 0.1;
const REMOTE_BLEND = 0.3;

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

  private keys!: Record<"W" | "A" | "S" | "D" | "UP" | "LEFT" | "RIGHT" | "SPACE", Phaser.Input.Keyboard.Key>;
  private sendAccum = 0;
  private lastInput: ShipInput = { thrust: false, turn: 0, mine: false };

  constructor() {
    super("game");
  }

  async create() {
    this.keys = this.input.keyboard!.addKeys("W,A,S,D,UP,LEFT,RIGHT,SPACE") as GameScene["keys"];

    this.beamGfx = this.add.graphics().setDepth(5);
    this.ownGfx = this.makeShipGfx(COLOR_OWN).setDepth(10);
    this.ownGfx.setVisible(false);

    this.hud = this.add
      .text(12, 10, "Conectando…", {
        fontFamily: "monospace",
        fontSize: "16px",
        color: "#c8d6e5",
      })
      .setScrollFactor(0)
      .setDepth(100);

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
    // 3×3 setores ao redor da origem — muito além do alcance da tela
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        for (const a of sectorAsteroids(this.worldSeed, this.origin.sx + ox, this.origin.sy + oy)) {
          const pos = this.toRender(a);
          const g = this.add.graphics({ x: pos.x, y: pos.y });
          g.lineStyle(1.5, COLOR_ASTEROID);
          g.strokePoints(asteroidVerts(a.shapeSeed, a.radius), true, true);
          this.asteroidGfx.push(g);
        }
      }
    }
  }

  private makeShipGfx(color: number): Phaser.GameObjects.Graphics {
    const g = this.add.graphics();
    g.lineStyle(1.5, color);
    g.strokePoints(SHIP_VERTS, true, true);
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
        this.beamGfx.lineStyle(1, COLOR_BEAM, 0.8);
        this.beamGfx.lineBetween(own.x, own.y, t.x, t.y);
      }
    }

    const ore = Math.floor(authoritative?.ore ?? this.localShip!.ore);
    this.hud.setText(
      `Minério: ${ore}  ·  Jogadores: ${this.serverShips.size}  ·  Setor (${this.localShip!.sx}, ${this.localShip!.sy})\n` +
        `W/↑ acelerar · A/D ou ←/→ girar · ESPAÇO minerar`,
    );
  }
}
