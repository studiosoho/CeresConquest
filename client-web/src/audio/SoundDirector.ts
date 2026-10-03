/**
 * SoundDirector — decide QUANDO e ONDE tocar cada efeito, a partir do que o
 * cliente já recebe: os efeitos anunciados (MSG_FX) e as mudanças entre dois
 * estados sincronizados (projéteis novos, mina que armou, a nave própria que
 * atracou, decolou, trocou de arma, travou a mira, levou dano...).
 *
 * Sons do mundo são POSICIONAIS: o volume cai com a distância à nave própria
 * (o ouvinte) até HEAR_RADIUS, e a panorâmica segue o lado da tela. Sons da
 * própria nave e da interface tocam cheios, no centro.
 *
 * O primeiro estado só é memorizado: entrar numa partida em andamento não
 * dispara de uma vez o som de tudo que já existia.
 */

import { LAND_DURATION, LAYER_TRANSITION_TIME, relVec, type FxEvent, type WorldPos } from "@ceres/shared";
import type { SoundEngine } from "./SoundEngine";
import type { SoundName } from "./sounds";

/** além disto (u de mundo) um som do mundo não se ouve */
const HEAR_RADIUS = 9000;
/** distância lateral (u) em que a panorâmica chega ao extremo */
const PAN_SPAN = 3500;
/** intervalo mínimo entre dois alarmes de ataque (s) */
const ALARM_COOLDOWN = 12;

export interface DirectorShip extends WorldPos {
  owner: string;
  kind: string;
  anchored: boolean;
  landingPhase: string;
  /** minerando (pousada num asteroide, ou o builder na estação) */
  mining: boolean;
  layerTo: string;
  weapon: string;
  aimLocked: boolean;
  hp: number;
  cargoAmount: number;
  attackTarget: string;
}
export interface DirectorStructure extends WorldPos {
  owner: string;
  turrets: number;
  turretBuild: number;
}
export interface DirectorProjectile extends WorldPos {
  kind: string;
  owner: string;
  armed: boolean;
}

export interface DirectorSnapshot {
  sessionId: string;
  myShipId: string;
  ships: ReadonlyMap<string, DirectorShip>;
  structures: ReadonlyMap<string, DirectorStructure>;
  projectiles: ReadonlyMap<string, DirectorProjectile>;
}

interface Memory {
  myShipId: string;
  me: DirectorShip | null;
  projectiles: Map<string, { kind: string; armed: boolean }>;
  structures: Map<string, { turrets: number; turretBuild: number }>;
  underAttack: boolean;
}

export class SoundDirector {
  private engine: SoundEngine;
  private memory: Memory | null = null;
  private lastAlarm = -Infinity;

  constructor(engine: SoundEngine) {
    this.engine = engine;
  }

  /** Alarme de um alerta do servidor (MSG_ALERT). */
  alarm(): void {
    this.engine.play("alarm");
  }

  /** Efeito anunciado pelo servidor (explosão, laser). */
  fx(ev: FxEvent, listener: WorldPos | null, myShipId: string): void {
    const at = { sx: ev.sx, sy: ev.sy, x: ev.x, y: ev.y };
    switch (ev.kind) {
      case "laser":
        // a origem do traço é a turreta ou a nave que atirou
        this.playAt(ev.from === "turret" ? "turret" : "laser", at, listener);
        break;
      case "hit":
        if (ev.on === "ship" && ev.id === myShipId) this.engine.play("hurt");
        this.playAt("hit", at, listener);
        break;
      case "blast":
        this.playAt("blast", at, listener);
        break;
      case "shipDown":
        this.playAt("shipDown", at, listener);
        break;
      case "structureDown":
        this.playAt("structureDown", at, listener);
        break;
    }
  }

  /** Compara com o estado anterior e toca o que mudou. */
  sync(s: DirectorSnapshot, listener: WorldPos | null, now: number): void {
    const prev = this.memory;
    const me = s.ships.get(s.myShipId) ?? null;
    // WOOSH-WOOSH-WOOSH enquanto a nave própria minera
    this.engine.setMining(!!me?.mining);
    const next: Memory = {
      myShipId: s.myShipId,
      me: me ? { ...me } : null,
      projectiles: new Map(),
      structures: new Map(),
      underAttack: false,
    };
    for (const [id, p] of s.projectiles) next.projectiles.set(id, { kind: p.kind, armed: p.armed });
    for (const [id, st] of s.structures) next.structures.set(id, { turrets: st.turrets, turretBuild: st.turretBuild });
    const mine = new Set([...s.structures].filter(([, st]) => st.owner === s.sessionId).map(([id]) => id));
    for (const ship of s.ships.values()) {
      if (ship.owner !== s.sessionId && ship.attackTarget && mine.has(ship.attackTarget)) next.underAttack = true;
    }
    this.memory = next;
    if (!prev) return; // primeiro estado: só memoriza

    // projéteis novos (disparos) e minas que acabaram de armar
    for (const [id, p] of s.projectiles) {
      const before = prev.projectiles.get(id);
      if (!before) this.playAt(p.kind === "mine" ? "mineLaunch" : "missile", p, listener);
      else if (!before.armed && p.armed) this.playAt("mineArm", p, listener);
    }

    // obras e turretas das estruturas PRÓPRIAS
    for (const [id, st] of s.structures) {
      if (st.owner !== s.sessionId) continue;
      const before = prev.structures.get(id);
      if (!before) continue;
      if (st.turrets > before.turrets) this.engine.play("turretReady");
      else if (before.turretBuild < 0 && st.turretBuild >= 0) this.engine.play("buildStart");
    }

    // estrutura própria passou a ser atacada
    if (next.underAttack && !prev.underAttack && now - this.lastAlarm >= ALARM_COOLDOWN) {
      this.lastAlarm = now;
      this.engine.play("alarm");
    }

    // a nave própria (a mesma de antes — trocar de nave não é evento)
    const was = prev.me;
    if (!me || !was || prev.myShipId !== s.myShipId) return;
    if (me.weapon !== was.weapon) this.engine.play("select");
    if (me.aimLocked && !was.aimLocked) this.engine.play("lock");
    // pouso: o jato morrendo durante a descida e o CLANK dos pés ao tocar o chão
    if (me.landingPhase === "landing" && was.landingPhase !== "landing") this.engine.playLanding(LAND_DURATION);
    const parked = (x: DirectorShip) => x.anchored || x.landingPhase === "landed";
    if (parked(me) && !parked(was)) this.engine.playClank();
    else if (!parked(me) && parked(was)) this.engine.playTakeoff(LAYER_TRANSITION_TIME);
    else if (me.layerTo && me.layerTo !== was.layerTo) this.engine.play("layerShift");
    // moeda: carga PONTUAL de minério ([O], transporte) — minerando, o porão
    // cresce a cada estado e a moeda virava um bip contínuo sobre o WOOSH
    if (me.cargoAmount > was.cargoAmount + 0.5 && me.anchored && !me.mining && !was.mining) this.engine.play("coin");
  }

  /** Empuxo do motor da nave própria (0..1). */
  setThrust(level: number): void {
    this.engine.setThrust(level);
  }

  /** Som do mundo em `at`, atenuado pela distância ao ouvinte. */
  private playAt(name: SoundName, at: WorldPos, listener: WorldPos | null): void {
    if (!listener) {
      this.engine.play(name);
      return;
    }
    const { dx, dy } = relVec(listener, at);
    const d = Math.hypot(dx, dy);
    if (d >= HEAR_RADIUS) return;
    const volume = (1 - d / HEAR_RADIUS) ** 1.5;
    this.engine.play(name, volume, dx / PAN_SPAN);
  }
}
