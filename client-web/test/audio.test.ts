import { describe, expect, it } from "vitest";
import { synthesize, SFXR_RATE, Wave } from "../src/audio/sfxr";
import { SOUNDS, type SoundName } from "../src/audio/sounds";
import { SoundDirector, type DirectorProjectile, type DirectorShip, type DirectorSnapshot, type DirectorStructure } from "../src/audio/SoundDirector";
import type { SoundEngine } from "../src/audio/SoundEngine";

/** Cruzamentos de zero por segundo numa janela — mede a altura do som. */
function crossings(s: Float32Array, from: number, to: number): number {
  let n = 0;
  for (let i = from + 1; i < to; i++) if ((s[i - 1] < 0) !== (s[i] < 0)) n++;
  return n / ((to - from) / SFXR_RATE);
}

describe("sintetizador sfxr", () => {
  it("todo som do catálogo sai audível, finito, normalizado e curto", () => {
    for (const [name, spec] of Object.entries(SOUNDS)) {
      const s = synthesize(spec.params, 7);
      expect(s.length, name).toBeGreaterThan(SFXR_RATE * 0.03);
      expect(s.length, name).toBeLessThan(SFXR_RATE * 4);
      let peak = 0;
      for (const v of s) {
        expect(Number.isFinite(v)).toBe(true);
        peak = Math.max(peak, Math.abs(v));
      }
      expect(peak, name).toBeCloseTo(0.9, 5);
    }
  });

  it("arpejo acontece antes do fim (senão o bipe duplo vira bipe simples); zaps não viram clique", () => {
    for (const [name, spec] of Object.entries(SOUNDS)) {
      const p = spec.params;
      const len = synthesize(p).length;
      if (p.arpMod) {
        const arpAt = Math.floor((1 - (p.arpSpeed ?? 0)) ** 2 * 20000 + 32);
        expect(len, name).toBeGreaterThan(arpAt * 1.3);
      }
    }
    for (const name of ["laser", "turret", "missile"] as const) {
      expect(synthesize(SOUNDS[name].params).length, name).toBeGreaterThan(SFXR_RATE * 0.08);
    }
  });

  it("mesma semente, mesmo som (ruído incluído)", () => {
    const a = synthesize(SOUNDS.hit.params, 3);
    const b = synthesize(SOUNDS.hit.params, 3);
    expect(a).toEqual(b);
  });

  it("deslize negativo desce a altura; envelope maior dura mais", () => {
    const pew = synthesize({ wave: Wave.Square, freq: 0.6, slide: -0.3, sustain: 0.2, decay: 0.3 });
    const q = Math.floor(pew.length / 4);
    expect(crossings(pew, 0, q)).toBeGreaterThan(crossings(pew, 2 * q, 3 * q) * 1.3);
    const short = synthesize({ sustain: 0.1, decay: 0.1 });
    const long = synthesize({ sustain: 0.4, decay: 0.5 });
    expect(long.length).toBeGreaterThan(short.length * 4);
  });

  it("explosão de estrutura dura mais que o acerto, e o acerto mais que o tiro", () => {
    const len = (n: SoundName) => synthesize(SOUNDS[n].params).length;
    expect(len("structureDown")).toBeGreaterThan(len("hit"));
    expect(len("hit")).toBeGreaterThan(len("missile"));
  });
});

/** Motor falso: só registra o que tocaria. */
function fakeEngine() {
  const played: Array<{ name: SoundName | "landing" | "clank" | "takeoff"; volume: number; pan: number }> = [];
  const state = { mining: false };
  const engine = {
    play: (name: SoundName, volume = 1, pan = 0) => played.push({ name, volume, pan }),
    playLanding: () => played.push({ name: "landing", volume: 1, pan: 0 }),
    playClank: () => played.push({ name: "clank", volume: 1, pan: 0 }),
    playTakeoff: () => played.push({ name: "takeoff", volume: 1, pan: 0 }),
    setMining: (on: boolean) => { state.mining = on; },
    setThrust: () => {},
  } as unknown as SoundEngine;
  return { engine, played, state, names: () => played.map((p) => p.name) };
}

const ship = (o: Partial<DirectorShip> = {}): DirectorShip => ({
  sx: 0, sy: 0, x: 5000, y: 5000, owner: "me", kind: "attack", anchored: false, landingPhase: "", mining: false,
  layerTo: "", weapon: "missile", aimLocked: false, hp: 100, cargoAmount: 0, attackTarget: "", ...o,
});
const struct = (o: Partial<DirectorStructure> = {}): DirectorStructure => ({
  sx: 0, sy: 0, x: 6000, y: 5000, owner: "me", turrets: 0, turretBuild: -1, ...o,
});
const proj = (o: Partial<DirectorProjectile> = {}): DirectorProjectile => ({
  sx: 0, sy: 0, x: 5500, y: 5000, kind: "missile", owner: "x", armed: false, ...o,
});
function snap(ships: Record<string, DirectorShip>, structures: Record<string, DirectorStructure> = {}, projectiles: Record<string, DirectorProjectile> = {}): DirectorSnapshot {
  return {
    sessionId: "me", myShipId: "p0",
    ships: new Map(Object.entries(ships)),
    structures: new Map(Object.entries(structures)),
    projectiles: new Map(Object.entries(projectiles)),
  };
}
const listener = { sx: 0, sy: 0, x: 5000, y: 5000 };

describe("direção do som", () => {
  it("o primeiro estado só é memorizado: entrar na partida não dispara nada", () => {
    const f = fakeEngine();
    const d = new SoundDirector(f.engine);
    d.sync(snap({ p0: ship() }, {}, { a: proj(), b: proj({ kind: "mine", armed: true }) }), listener, 0);
    expect(f.played).toEqual([]);
  });

  it("disparo novo toca no lugar dele: mais baixo longe, panorâmica do lado; longe demais, nada", () => {
    const f = fakeEngine();
    const d = new SoundDirector(f.engine);
    d.sync(snap({ p0: ship() }), listener, 0);
    d.sync(snap({ p0: ship() }, {}, {
      near: proj({ x: 5500 }),
      left: proj({ x: 2000, kind: "mine" }),
      far: proj({ sx: 3, x: 5000 }),
    }), listener, 0.05);
    const [near, left] = f.played;
    expect(f.names()).toEqual(["missile", "mineLaunch"]);
    expect(near.volume).toBeGreaterThan(left.volume);
    expect(near.pan).toBeGreaterThan(0);
    expect(left.pan).toBeLessThan(0);
  });

  it("mina que arma bipa uma vez", () => {
    const f = fakeEngine();
    const d = new SoundDirector(f.engine);
    d.sync(snap({ p0: ship() }, {}, { m: proj({ kind: "mine" }) }), listener, 0);
    d.sync(snap({ p0: ship() }, {}, { m: proj({ kind: "mine", armed: true }) }), listener, 1);
    d.sync(snap({ p0: ship() }, {}, { m: proj({ kind: "mine", armed: true }) }), listener, 2);
    expect(f.names()).toEqual(["mineArm"]);
  });

  it("a própria nave: troca de arma, trava a mira, pousa, decola, troca de camada, carrega minério", () => {
    const f = fakeEngine();
    const d = new SoundDirector(f.engine);
    const steps: DirectorShip[] = [
      ship(),
      ship({ weapon: "laser" }),
      ship({ weapon: "laser", aimLocked: true }),
      ship({ weapon: "laser", anchored: true }),
      ship({ weapon: "laser", anchored: true, cargoAmount: 120 }),
      ship({ weapon: "laser" }),
      ship({ weapon: "laser", layerTo: "surface" }),
    ];
    steps.forEach((s, i) => d.sync(snap({ p0: s }), listener, i));
    expect(f.names()).toEqual(["select", "lock", "clank", "coin", "takeoff", "layerShift"]);
  });

  it("pouso: o jato morrendo na descida e o CLANK ao tocar o chão; mineração liga e desliga o WOOSH", () => {
    const f = fakeEngine();
    const d = new SoundDirector(f.engine);
    const steps: DirectorShip[] = [
      ship({ kind: "builder" }),
      ship({ kind: "builder", landingPhase: "landing" }),
      ship({ kind: "builder", landingPhase: "landing" }),
      ship({ kind: "builder", landingPhase: "landed" }),
    ];
    steps.forEach((s, i) => d.sync(snap({ p0: s }), listener, i));
    expect(f.names()).toEqual(["landing", "clank"]);
    d.sync(snap({ p0: ship({ kind: "builder", landingPhase: "landed", anchored: true, mining: true }) }), listener, 5);
    expect(f.state.mining).toBe(true);
    // minerando, o porão cresce a cada estado: sem moeda
    d.sync(snap({ p0: ship({ kind: "builder", landingPhase: "landed", anchored: true, mining: true, cargoAmount: 40 }) }), listener, 5.5);
    d.sync(snap({ p0: ship({ kind: "builder", landingPhase: "landed", anchored: true, mining: true, cargoAmount: 80 }) }), listener, 5.6);
    expect(f.names()).toEqual(["landing", "clank"]);
    d.sync(snap({ p0: ship({ kind: "builder", landingPhase: "landed" }) }), listener, 6);
    expect(f.state.mining).toBe(false);
  });

  it("trocar de nave não é evento", () => {
    const f = fakeEngine();
    const d = new SoundDirector(f.engine);
    d.sync(snap({ p0: ship() }), listener, 0);
    d.sync({ ...snap({ p1: ship({ weapon: "mine", anchored: true }) }), myShipId: "p1" }, listener, 1);
    expect(f.played).toEqual([]);
  });

  it("turreta própria: obra começou, turreta pronta", () => {
    const f = fakeEngine();
    const d = new SoundDirector(f.engine);
    d.sync(snap({ p0: ship() }, { st: struct() }), listener, 0);
    d.sync(snap({ p0: ship() }, { st: struct({ turretBuild: 0 }) }), listener, 1);
    d.sync(snap({ p0: ship() }, { st: struct({ turrets: 1 }) }), listener, 2);
    // a obra de outro jogador não toca
    d.sync(snap({ p0: ship() }, { st: struct({ turrets: 1 }), other: struct({ owner: "x", turretBuild: 0 }) }), listener, 3);
    expect(f.names()).toEqual(["buildStart", "turretReady"]);
  });

  it("alarme quando uma estrutura própria passa a ser atacada — sem repetir em seguida", () => {
    const f = fakeEngine();
    const d = new SoundDirector(f.engine);
    const base = { st: struct() };
    const attacker = (target: string) => ship({ owner: "bot", attackTarget: target });
    d.sync(snap({ p0: ship(), b: attacker("") }, base), listener, 0);
    d.sync(snap({ p0: ship(), b: attacker("st") }, base), listener, 1);
    d.sync(snap({ p0: ship(), b: attacker("") }, base), listener, 2);
    d.sync(snap({ p0: ship(), b: attacker("st") }, base), listener, 3); // cedo demais
    d.sync(snap({ p0: ship(), b: attacker("") }, base), listener, 20);
    d.sync(snap({ p0: ship(), b: attacker("st") }, base), listener, 21);
    expect(f.names()).toEqual(["alarm", "alarm"]);
  });

  it("efeitos do servidor: explosões por tamanho, laser de turreta, dano na própria nave", () => {
    const f = fakeEngine();
    const d = new SoundDirector(f.engine);
    const at = { sx: 0, sy: 0, x: 5200, y: 5000 };
    d.fx({ kind: "laser", ...at, from: "turret" }, listener, "p0");
    d.fx({ kind: "laser", ...at }, listener, "p0");
    d.fx({ kind: "hit", ...at, on: "ship", id: "p0" }, listener, "p0");
    d.fx({ kind: "structureDown", ...at }, listener, "p0");
    expect(f.names()).toEqual(["turret", "laser", "hurt", "hit", "structureDown"]);
  });
});
