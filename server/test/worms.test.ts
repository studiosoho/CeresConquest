import { afterEach, describe, expect, it } from "vitest";
import {
  CERES_PLATFORM_PREFIX,
  RUIN_OWNER,
  SHIP_HP_MAX,
  STATION_EXPANDED_BAYS,
  STATION_SHIP_BAYS,
  STRUCTURE_SPECS,
  WORM_RAM_DAMAGE,
  WORM_RAM_RETREAT,
  WORM_DEN_TIME,
  CERES_RADIUS,
  REPAIR_HP_PER_KIT,
  REPAIR_RATE,
  structureMaxHp,
  WORM_QUAKE_BREACH_TIME,
  WORM_QUAKE_DANGER_TIME,
  WORM_QUAKE_WARN_TIME,
  WORM_SIEGE_TIME,
  WORM_BODY_DAMAGE,
  WORM_HOLE_ID,
  WORM_HOLE_SEAL_MINES,
  WORM_ROAM_TIME,
  LAYER_TRANSITION_TIME,
  stationUpgradeCost,
  WORM_HP,
  WORM_CHASE_TIME,
  WORM_CLIMB_RATE,
  WORM_DECIDE_FRACTION,
  WORM_DECIDE_MIN,
  WORM_SEGMENTS,
  WORM_SPACING,
  asteroidClassOf,
  ceresPlatformPos,
  ceresPlatforms,
  ceresPosition,
  dist,
  normalizePos,
  type WorldPos,
} from "@ceres/shared";
import { sectorAsteroids, setLayer, wormBodyAt, type Asteroid, type ShipState, type SimWorld, type Structure } from "@ceres/sim-core";
import { MatchRoom } from "../src/rooms/MatchRoom";
import { BOT_AMMO } from "../src/bots";
import type { Worm } from "../src/worms";

// Minhocas gigantes (shared/worms.ts): ninho em Ceres, caça, mordida,
// engolida, dano do corpo exposto e morte. Sala de verdade, sem rede.

const SEED = 4242;
const DT = 0.05;
const CERES = ceresPosition(SEED);
const sector = { sx: CERES.sx - 4, sy: CERES.sy };
const rocks = [...sectorAsteroids(SEED, sector.sx, sector.sy)].sort((a, b) => b.radius - a.radius);

const rooms: MatchRoom[] = [];
afterEach(() => {
  for (const room of rooms.splice(0)) room.clock.clear();
});

function makeRoom(bots = 0) {
  const room = new MatchRoom();
  (room as unknown as { listing: object }).listing = { metadata: {}, save: async () => {} };
  room.onCreate({ worldSeed: SEED, bots, maxPlayers: 4 });
  // sem investida crítica (a destruição total tem teste próprio): o cerco fica previsível
  (room as unknown as { wormCritChance: number }).wormCritChance = 0;
  rooms.push(room);
  return room as unknown as {
    sim: SimWorld;
    state: { worms: Map<string, unknown>; wormHole: string; wormHoleSeal: number };
    worms: Map<string, Worm>;
    hole: { padId: string; pos: WorldPos; radius: number; seal: number } | null;
    activeShip: Map<string, string>;
    projectiles: Map<string, { kind: string; armed?: boolean; inHole?: boolean }>;
    attackTargets: Map<string, { structId: string; radius: number }>;
    tick(dt: number): void;
    dockAtBay(s: ShipState, st: Structure): void;
    tryUpgrade(sid: string): void;
    tryToggleAnchor(sid: string): void;
    trySelectWeapon(sid: string, weapon: string): void;
    tryFire(sid: string): void;
    tryAutoMine(sid: string): void;
    tryTransfer(sid: string, item: string, dir: string): void;
    spawnBot(): string | null;
    bots: Map<string, { phase: string }>;
    spawnWorm(): string;
    damageWorm(id: string, damage: number, at?: WorldPos, attacker?: string): void;
  };
}
type R = ReturnType<typeof makeRoom>;

const run = (r: R, seconds: number) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) r.tick(DT);
};
const at = (p: WorldPos, dx: number, dy = 0): WorldPos => {
  const q = { sx: p.sx, sy: p.sy, x: p.x + dx, y: p.y + dy };
  normalizePos(q);
  return q;
};

/** Um ponto no vácuo (fora de Ceres e de toda rocha), com folga para a minhoca inteira. */
function vacuum(): WorldPos {
  for (let k = 0; k < 400; k++) {
    const p = at(rocks[0], 3000 + (k % 20) * 700, Math.floor(k / 20) * 700);
    let clear = true;
    for (let i = -WORM_SEGMENTS; i <= 4 && clear; i++) if (wormBodyAt(SEED, at(p, i * WORM_SPACING))) clear = false;
    if (clear) return p;
  }
  throw new Error("sem vácuo");
}

/** Minhoca esticada no vácuo, cabeça em `head` olhando para +x. */
function wormAt(r: R, head: WorldPos): [string, Worm] {
  const id = r.spawnWorm();
  const w = r.worms.get(id)!;
  Object.assign(w, { sx: head.sx, sy: head.sy, x: head.x, y: head.y, angle: 0 });
  w.segs.forEach((s, i) => Object.assign(s, at(head, -i * WORM_SPACING)));
  w.exposed.fill(true);
  return [id, w];
}

function station(r: R, owner: string, ast: Asteroid | { id: string; pos: WorldPos; radius: number }): Structure {
  const pos = "pos" in ast ? ast.pos : ast;
  return r.sim.addStructure({
    id: `st-${ast.id}`, type: "miningStation", owner, angle: 0.7,
    sx: pos.sx, sy: pos.sy, x: pos.x, y: pos.y,
    asteroidId: ast.id, asteroidClass: asteroidClassOf(ast.radius),
    shipBays: STATION_SHIP_BAYS, expandedBays: STATION_EXPANDED_BAYS,
    spiderBays: 0, nextShipBay: 0, nextSpiderBay: 0, oreStore: 0, rationStore: 0,
  });
}

/** Estação de jogador numa plataforma de Ceres, com o builder atracado e kits para evoluir. */
function ceresStation(r: R, owner = "p1"): [Structure, ShipState] {
  const pad = ceresPlatforms(SEED)[1];
  const st = station(r, owner, { id: pad.id, pos: ceresPlatformPos(SEED, pad), radius: pad.radius });
  const b = r.sim.addShip("bld", st, owner, "builder");
  b.bay = 0;
  r.dockAtBay(b, st);
  b.kits = stationUpgradeCost(1)!;
  r.activeShip.set(owner, "bld");
  return [st, b];
}

/** Evolui a estação de Ceres ao nível 2 e espera a cratera romper; `calm` tira as minhocas do caminho. */
function breach(r: R, calm = false): void {
  r.tryUpgrade("p1");
  run(r, WORM_QUAKE_BREACH_TIME + 0.1);
  if (calm) {
    r.worms.clear();
    Object.assign(r, { nestTimer: 1e9 });
  }
}

describe("ninho de Ceres e a toca", () => {
  it("nível 2: tremores com alertas aos 40 e 60 s; aos 70 a cratera rompe com estação e hangar, e a minhoca sai na hora", () => {
    const r = makeRoom();
    const [st] = ceresStation(r);
    const alerts: string[] = [];
    (r as unknown as { clients: object[] }).clients.push({
      sessionId: "p1", send: (_t: string, m: { text: string; level: string }) => alerts.push(`${m.level}: ${m.text}`),
      enqueueRaw: () => {}, raw: () => {},
    });
    const hang = r.sim.addShip("hang", st, "p1", "mining");
    Object.assign(hang, { stored: true, hqId: st.id, bay: 1 });
    run(r, 5);
    expect(r.hole).toBeNull(); // nível 1: o ninho dorme
    r.tryUpgrade("p1");
    run(r, WORM_QUAKE_WARN_TIME - 1);
    expect(alerts).toEqual([]);
    run(r, 2);
    expect(alerts).toEqual(["warn: Sua estação de mineração em Ceres sente tremores"]);
    run(r, WORM_QUAKE_DANGER_TIME - WORM_QUAKE_WARN_TIME);
    expect(alerts[1]).toBe("danger: A estação de mineração está em perigo! Evacuar");
    expect(r.sim.structures.has(st.id)).toBe(true);
    expect(r.worms.size).toBe(0);
    run(r, WORM_QUAKE_BREACH_TIME - WORM_QUAKE_DANGER_TIME);
    expect(r.sim.structures.has(st.id)).toBe(false);
    expect(r.sim.ships.has("hang")).toBe(false); // o hangar explode junto
    expect(r.sim.ships.has("bld")).toBe(false); // quem não evacuou também
    expect(r.hole?.padId).toBe(st.asteroidId);
    expect(r.worms.size).toBe(1);
    expect(dist([...r.worms.values()][0], r.hole!.pos)).toBeLessThan(2500); // saiu do buraco
    expect(r.state.wormHole).toBe(st.asteroidId);
    expect(st.asteroidId.startsWith(CERES_PLATFORM_PREFIX)).toBe(true);
  });

  it("fim da ronda: entra na toca, descansa WORM_DEN_TIME e sobe para outra ronda", () => {
    const r = makeRoom();
    ceresStation(r);
    breach(r); // o builder não evacuou: explode (o piloto sai num pod, que ela não come)
    const [id, w] = [...r.worms][0];
    Object.assign(r, { nestTimer: 1e9 }); // só esta minhoca
    run(r, WORM_ROAM_TIME - 5);
    expect(w.den).toBe(-1); // ainda na ronda
    let t = 0;
    while (w.den < 0 && t < 120) { r.tick(DT); t += DT; }
    expect(w.den).toBeGreaterThan(0); // voltou e entrou
    r.tick(DT);
    expect(r.state.worms.size).toBe(0); // dentro da toca: some do mapa
    expect(r.worms.has(id)).toBe(true);
    run(r, WORM_DEN_TIME - 1);
    expect(w.den).toBeGreaterThan(0);
    run(r, 2);
    expect(w.den).toBe(-1); // de volta à superfície
    expect(w.roam).toBeGreaterThan(WORM_ROAM_TIME - 2);
    expect(dist(w, r.hole!.pos)).toBeLessThan(2500);
    expect(r.state.worms.size).toBe(1);
  });

  it("tapada a toca com ela lá dentro, fica presa", () => {
    const r = makeRoom();
    ceresStation(r);
    breach(r);
    const [id, w] = [...r.worms][0];
    Object.assign(r, { nestTimer: 1e9 });
    w.roam = 0;
    let t = 0;
    while (w.den < 0 && t < 120) { r.tick(DT); t += DT; }
    Object.assign(r, { hole: null });
    r.tick(DT);
    expect(r.worms.has(id)).toBe(false);
  });

  it("sem presa, salta da borda de Ceres para uma rocha e volta pelo mesmo caminho", () => {
    const r = makeRoom();
    const id = r.spawnWorm(); // sem toca: sai do núcleo de Ceres
    const w = r.worms.get(id)!;
    let out = false;
    let back = false;
    for (let t = 0; t < 140 && !back; t += DT) {
      r.tick(DT);
      const d = dist(w, CERES);
      if (d > CERES_RADIUS + 500) out = true;
      if (out && d < CERES_RADIUS - 1500) back = true;
    }
    expect(out).toBe(true); // saltou para fora de Ceres
    expect(back).toBe(true); // e voltou
  });

  it("a plataforma da toca aberta não aceita pouso", () => {
    const r = makeRoom();
    const [st] = ceresStation(r);
    breach(r, true);
    const b2 = r.sim.addShip("b2", at(st, 0, 0), "p1", "builder");
    r.activeShip.set("p1", "b2");
    r.tryToggleAnchor("p1");
    expect(b2.landingPhase).toBe("");
  });

  it("minas no buraco + míssil nelas tapam a toca; aí dá para pousar de novo", () => {
    const r = makeRoom();
    const [st] = ceresStation(r);
    breach(r, true);
    const hole = r.hole!;
    // nave de ataque na borda da plataforma, em cruzeiro: [F] = modo ataque na toca
    const a = r.sim.addShip("atk", at(hole.pos, hole.radius), "p1", "attack");
    r.activeShip.set("p1", "atk");
    r.tryToggleAnchor("p1");
    expect(r.attackTargets.get("atk")?.structId).toBe(WORM_HOLE_ID);
    run(r, LAYER_TRANSITION_TIME + 1);
    r.trySelectWeapon("p1", "mine");
    for (let k = 0; k < WORM_HOLE_SEAL_MINES; k++) {
      r.tryFire("p1");
      run(r, 2.1);
    }
    run(r, 3);
    const inHole = [...r.projectiles.values()].filter((p) => p.inHole);
    expect(inHole.length).toBe(WORM_HOLE_SEAL_MINES);
    r.trySelectWeapon("p1", "missile");
    run(r, 1.5); // a mira gira até a mina
    r.tryFire("p1");
    run(r, 3);
    expect(r.hole).toBeNull();
    expect(r.state.wormHole).toBe("");
    expect([...r.projectiles.values()].some((p) => p.inHole)).toBe(false);
    expect(a.hp).toBeGreaterThan(0);
    // tapada: a plataforma aceita pouso (e construção) de novo
    const b2 = r.sim.addShip("b2", at(st, 0, 0), "p1", "builder");
    r.activeShip.set("p1", "b2");
    r.tryToggleAnchor("p1");
    expect(b2.landingPhase).toBe("landing");
  });

  it("menos minas que o necessário: conta, mas não tapa", () => {
    const r = makeRoom();
    ceresStation(r);
    breach(r, true);
    const hole = r.hole!;
    const room = r as unknown as { projectiles: Map<string, object>; blastHole(): void };
    room.projectiles.set("m1", { kind: "mine", owner: "p1", level: "surface", ...hole.pos, vx: 0, vy: 0, traveled: 0, armed: true, inHole: true });
    room.blastHole();
    expect(r.hole?.seal).toBe(1);
    expect(r.hole).not.toBeNull();
  });
});

describe("caça", () => {
  it("investe: toca a estrutura (dano), passa direto, afasta-se, dá a volta e investe de novo", () => {
    const r = makeRoom();
    const st = station(r, "p1", rocks[0]);
    st.hp = 1e9;
    const hp0 = st.hp;
    const [, w] = wormAt(r, vacuum());
    w.retarget = 0;
    const R = STRUCTURE_SPECS.miningStation.radius;
    let hits = 0;
    let lastHp = hp0;
    let farAfterHit = 0;
    for (let t = 0; t < 24 && hits < 3; t += DT) {
      r.tick(DT);
      if (st.hp < lastHp) {
        hits++;
        expect(lastHp - st.hp).toBe(WORM_RAM_DAMAGE); // sem hangar: tudo no prédio
        lastHp = st.hp;
        farAfterHit = 0;
      } else if (hits > 0) {
        farAfterHit = Math.max(farAfterHit, dist(w, st));
      }
      if (hits >= 2) break;
    }
    expect(hits).toBeGreaterThanOrEqual(2);
    // entre um toque e o outro ela se afastou e deu a volta
    const [, w2] = [0, w];
    expect(w2.target).toBe(st.id);
    expect(farAfterHit === 0 || farAfterHit >= R + WORM_RAM_RETREAT * 0.9).toBe(true);
  });

  it("o toque fere também as naves do hangar (sorteado)", () => {
    const r = makeRoom();
    const st = station(r, "p1", rocks[0]);
    st.hp = 1e9;
    const hang = r.sim.addShip("hang", st, "p1", "mining");
    Object.assign(hang, { stored: true, hqId: st.id, bay: 1 });
    const [, w] = wormAt(r, vacuum());
    w.retarget = 0;
    run(r, 24);
    expect(st.hp).toBeLessThan(1e9);
    expect(!r.sim.ships.has("hang") || hang.hp < SHIP_HP_MAX).toBe(true);
  });

  it("investida CRÍTICA (1 em 10): vai no centro e a estrutura é destruída inteira", () => {
    const r = makeRoom();
    (r as unknown as { wormCritChance: number }).wormCritChance = 1;
    const st = station(r, "p1", rocks[0]);
    st.hp = 1e9;
    const [, w] = wormAt(r, vacuum());
    w.retarget = 0;
    let t = 0;
    while (r.sim.structures.has(st.id) && t < 40) { r.tick(DT); t += DT; }
    expect(r.sim.structures.has(st.id)).toBe(false);
  });

  it("investida normal passa RASPANDO ao lado: a cabeça não cruza o centro da estrutura", () => {
    const r = makeRoom();
    const st = station(r, "p1", rocks[0]);
    st.hp = 1e9;
    const [, w] = wormAt(r, vacuum());
    w.retarget = 0;
    let closest = Infinity;
    let hits = 0;
    let last = st.hp;
    for (let t = 0; t < 30 && hits < 2; t += DT) {
      r.tick(DT);
      closest = Math.min(closest, dist(w, st));
      if (st.hp < last) { hits++; last = st.hp; }
    }
    expect(hits).toBeGreaterThan(0);
    expect(closest).toBeGreaterThan(STRUCTURE_SPECS.miningStation.radius); // raspou ao lado
  });

  it("o cerco dura WORM_SIEGE_TIME; depois ela parte para outra presa", () => {
    const r = makeRoom();
    const st1 = station(r, "p1", rocks[0]);
    const st2 = station(r, "p1", rocks[3]);
    st1.hp = 1e9;
    st2.hp = 1e9;
    const [, w] = wormAt(r, vacuum());
    w.retarget = 0;
    let t = 0;
    while (w.siege < 0 && t < 30) { r.tick(DT); t += DT; } // chegou: o cerco começa
    expect(t).toBeLessThan(30);
    const first = w.target;
    const other = first === st1.id ? st2.id : st1.id;
    expect([st1.id, st2.id]).toContain(first);
    run(r, WORM_SIEGE_TIME - 1);
    expect(w.target).toBe(first); // cercando, não troca
    run(r, 1.5);
    expect(w.besieged.has(first)).toBe(true);
    expect(w.target).toBe(other);
  });

  it("quem a fere vira o alvo: o atacante mais perto (nave ou turreta)", () => {
    const r = makeRoom();
    const st = station(r, "p1", rocks[0]);
    st.hp = 1e9;
    const turretSt = station(r, "p2", rocks[3]);
    const head = vacuum();
    const [id, w] = wormAt(r, head);
    w.retarget = 0;
    run(r, 2);
    expect(w.target).toBe(st.id);
    const atk = r.sim.addShip("atk", at(w, 9000), "p2", "attack");
    r.damageWorm(id, 10, undefined, "atk");
    expect(w.target).toBe("atk");
    // a turreta (estrutura) mais perto que a nave passa a ser o alvo
    Object.assign(atk, at(w, 25_000));
    r.damageWorm(id, 6, undefined, turretSt.id);
    expect(w.target).toBe(dist(w, turretSt) < dist(w, atk) ? turretSt.id : "atk");
  });

  it("a cabeça engole a nave inteira — no fundo, a do nível das estruturas", () => {
    const r = makeRoom();
    const head = vacuum();
    wormAt(r, head);
    const prey = r.sim.addShip("prey", at(head, 120), "p1", "transport");
    setLayer(prey, "surface");
    const high = r.sim.addShip("high", at(head, 150, 40), "p1", "transport"); // em cruzeiro: passa por cima
    r.tick(DT);
    expect(r.sim.ships.has("prey")).toBe(false);
    expect(r.sim.ships.has("high")).toBe(true);
  });

  it("o corpo exposto fere quem bate nele (com intervalo)", () => {
    const r = makeRoom();
    const head = vacuum();
    const [, w] = wormAt(r, head);
    w.target = "x"; // inexistente: reavalia — a nave é a única presa
    const s: ShipState = r.sim.addShip("hit", at(head, -10 * WORM_SPACING, 60), "p1", "transport");
    setLayer(s, "surface");
    r.tick(DT);
    expect(s.hp).toBe(SHIP_HP_MAX - WORM_BODY_DAMAGE);
    r.tick(DT);
    expect(s.hp).toBe(SHIP_HP_MAX - WORM_BODY_DAMAGE);
  });

  it("ignora ruínas e vagueia; fim da ronda sem toca aberta: enterra-se em Ceres", () => {
    const r = makeRoom();
    station(r, RUIN_OWNER, rocks[0]);
    const [id, w] = wormAt(r, vacuum());
    run(r, 1);
    expect(w.target).toBe("");
    expect(w.route.length).toBeGreaterThan(0); // vagueia (excursão)
    w.roam = 0;
    run(r, 60);
    expect(r.worms.has(id)).toBe(false);
  });
});

describe("dano na minhoca", () => {
  it("morre com WORM_HP de dano e some do estado", () => {
    const r = makeRoom();
    const [id] = wormAt(r, vacuum());
    r.tick(DT);
    r.damageWorm(id, WORM_HP - 1);
    expect(r.worms.has(id)).toBe(true);
    r.damageWorm(id, 1);
    expect(r.worms.has(id)).toBe(false);
    r.tick(DT);
    expect(r.state.worms.size).toBe(0);
  });

  it("enterrada numa rocha, o gomo não fica exposto", () => {
    const r = makeRoom();
    const [, w] = wormAt(r, vacuum());
    const rock = rocks[0];
    w.segs.forEach((s) => Object.assign(s, { sx: rock.sx, sy: rock.sy, x: rock.x, y: rock.y }));
    Object.assign(w, { sx: rock.sx, sy: rock.sy, x: rock.x, y: rock.y, breach: 0 });
    w.target = "x";
    r.tick(DT);
    expect(w.exposed.slice(3).every((e) => !e)).toBe(true);
    expect(STRUCTURE_SPECS.miningStation.radius).toBeGreaterThan(0);
  });
});

describe("ruínas", () => {
  /** Ruína numa rocha e um builder do p1 pousado numa vaga dela via [F]. */
  function ruinDocked(): { r: R; st: Structure; b: ShipState } {
    const r = makeRoom();
    const st = station(r, RUIN_OWNER, rocks[0]);
    Object.assign(st, { oreStore: 300, kitStore: 40, rationStore: 0 }); // sem rações: a broca não mexe no buffer
    st.hp = structureMaxHp("miningStation", 1) - 200;
    const b = r.sim.addShip("b", at(rocks[0], rocks[0].radius + 200), "p1", "builder");
    r.activeShip.set("p1", "b");
    r.tryToggleAnchor("p1");
    run(r, 3);
    return { r, st, b };
  }

  it("o builder pousa numa ruína; lá só o [G] funciona", () => {
    const { r, st, b } = ruinDocked();
    expect([b.anchored, b.hqId]).toEqual([true, st.id]);
    b.kits = 0;
    r.tryTransfer("p1", "ore", "withdraw");
    r.tryTransfer("p1", "kits", "withdraw");
    expect([b.cargoAmount, b.kits, st.oreStore, st.kitStore]).toEqual([0, 0, 300, 40]);
  });

  it("[G] recupera a ruína com kits do porão; ela volta ao jogo como do jogador, com o buffer intacto", () => {
    const { r, st, b } = ruinDocked();
    b.kits = 30;
    r.tryAutoMine("p1"); // [G]
    run(r, 200 / REPAIR_RATE + 1);
    expect(st.owner).toBe("p1");
    expect(st.hp).toBe(structureMaxHp("miningStation", 1));
    expect(b.kits).toBe(30 - 200 / REPAIR_HP_PER_KIT); // só do porão
    expect([st.oreStore, st.kitStore]).toEqual([300, 40]); // espólio intacto
    // agora é dela: as trocas com o buffer funcionam
    r.tryTransfer("p1", "kits", "withdraw");
    expect(st.kitStore).toBe(0);
  });

  it("de HP cheio, a recuperação é imediata", () => {
    const { r, st } = ruinDocked();
    st.hp = structureMaxHp("miningStation", 1);
    r.tryAutoMine("p1");
    r.tick(DT);
    expect(st.owner).toBe("p1");
  });
});

describe("bots contra a minhoca", () => {
  it("a minhoca é o alvo prioritário: o bot em ataque vai nela, não na estação", () => {
    const r = makeRoom(1);
    const st = station(r, "p1", rocks[3]);
    st.hp = 1e9;
    const head = vacuum();
    const [, w] = wormAt(r, head);
    // ocupada com a estação (como numa partida): o bot a caça de longe
    w.target = st.id;
    w.siege = 1e9;
    const id = r.spawnBot()!;
    const bot = r.sim.ships.get(id)!;
    Object.assign(bot, at(head, 12_000, 1500), { vx: 0, vy: 0, anchored: false, hqId: "", bay: -1 });
    setLayer(bot, "cruise");
    r.bots.get(id)!.phase = "raid";
    // atirou nela (mirando a minhoca): o acerto depende da trajetória dela
    let aimedWorm = false;
    for (let t = 0; t < 40 && bot.ammo === BOT_AMMO; t += DT) {
      r.tick(DT);
      if ((r as unknown as { weapons: Map<string, { target: string }> }).weapons.get(id)?.target.startsWith("worm:")) aimedWorm = true;
    }
    expect(aimedWorm).toBe(true);
    expect(bot.ammo).toBeLessThan(BOT_AMMO);
    expect(r.attackTargets.has(id)).toBe(false); // não desceu sobre a estação
  });
});

/** Põe a minhoca toda no CRUZEIRO, perseguindo `target`. */
function lifted(w: Worm, target: string): void {
  Object.assign(w, { high: true, alt: 1, chase: WORM_CHASE_TIME, target, retarget: 1 });
  w.lift.fill(1);
}

describe("camadas: fundo e cruzeiro", () => {
  it("no cruzeiro a cabeça engole e o corpo fere as naves em cruzeiro — não as do fundo", () => {
    const r = makeRoom();
    const head = vacuum();
    const [, w] = wormAt(r, head);
    const low = r.sim.addShip("low", at(head, 140, -40), "p1", "transport");
    setLayer(low, "surface");
    r.sim.addShip("prey", at(head, 120), "p2", "attack");
    const side: ShipState = r.sim.addShip("side", at(head, -10 * WORM_SPACING, 60), "p2", "attack");
    lifted(w, "prey");
    r.tick(DT);
    expect(r.sim.ships.has("prey")).toBe(false);
    expect(r.sim.ships.has("low")).toBe(true);
    expect(side.hp).toBe(SHIP_HP_MAX - WORM_BODY_DAMAGE);
  });

  it("no CENTRO da rocha decide: deixa a estação e sobe na diagonal atrás das naves de ataque", () => {
    const r = makeRoom();
    (r as unknown as { wormChaseChance: number }).wormChaseChance = 1;
    const rock = rocks[0];
    const st = station(r, "p1", rock);
    st.hp = 1e9;
    const [, w] = wormAt(r, vacuum());
    w.retarget = 0;
    r.sim.addShip("atk", at(rock, 3000, 3000), "p2", "attack");
    let t = 0;
    while (!w.high && t < 30) { r.tick(DT); t += DT; }
    expect(w.high).toBe(true);
    expect(w.target).toBe("atk");
    // decidiu perto do CENTRO da rocha em que estava (a da estação ou uma do caminho)
    const body = wormBodyAt(SEED, w)!;
    expect(w.decided).toBe(body.id);
    expect(body.d).toBeLessThan(Math.max(WORM_DECIDE_MIN, body.radius * WORM_DECIDE_FRACTION) + 200);
    // sobe aos poucos, andando: a rampa é diagonal e o corpo vem atrás
    run(r, 0.5 / WORM_CLIMB_RATE);
    expect(w.alt).toBeGreaterThan(0.4);
    expect(w.alt).toBeLessThan(0.6);
    expect(w.lift[0]).toBeGreaterThan(w.lift[WORM_SEGMENTS - 1]);
    run(r, 0.6 / WORM_CLIMB_RATE);
    expect(w.alt).toBe(1);
    expect(r.state.worms.size).toBe(1);
    // persegue no cruzeiro até engolir
    t = 0;
    while (r.sim.ships.has("atk") && t < 15) { r.tick(DT); t += DT; }
    expect(r.sim.ships.has("atk")).toBe(false);
  });

  it("sem sorte na decisão, segue para a estação e ignora as naves em cruzeiro", () => {
    const r = makeRoom();
    (r as unknown as { wormChaseChance: number }).wormChaseChance = 0;
    const rock = rocks[0];
    const st = station(r, "p1", rock);
    st.hp = 1e9;
    const [, w] = wormAt(r, vacuum());
    w.retarget = 0;
    r.sim.addShip("atk", at(rock, 3000, 3000), "p2", "attack");
    let high = false;
    for (let t = 0; t < 20; t += DT) {
      r.tick(DT);
      high ||= w.high;
    }
    expect(high).toBe(false);
    expect(w.target).toBe(st.id);
    expect(st.hp).toBeLessThan(1e9);
    expect(r.sim.ships.has("atk")).toBe(true);
  });

  it("rocha vazia: com naves de ataque por perto, sobe sempre", () => {
    const r = makeRoom();
    (r as unknown as { wormChaseChance: number }).wormChaseChance = 0;
    const rock = rocks[1];
    const [, w] = wormAt(r, rock);
    w.roam = WORM_ROAM_TIME;
    r.sim.addShip("atk", at(rock, 5000), "p2", "attack");
    r.tick(DT);
    expect(w.high).toBe(true);
    expect(w.target).toBe("atk");
  });

  it("ferida por uma nave em cruzeiro no vácuo: sobe na hora atrás dela", () => {
    const r = makeRoom();
    const head = vacuum();
    const [id, w] = wormAt(r, head);
    r.sim.addShip("atk", at(head, 6000), "p2", "attack");
    r.damageWorm(id, 10, undefined, "atk");
    r.tick(DT);
    expect(w.target).toBe("atk");
    expect(w.high).toBe(true);
  });

  it("acabada a perseguição, MERGULHA de volta ao fundo", () => {
    const r = makeRoom();
    const head = vacuum();
    const [, w] = wormAt(r, head);
    r.sim.addShip("atk", at(head, 20000), "p2", "attack");
    lifted(w, "atk");
    run(r, 1);
    expect(w.high).toBe(true);
    w.chase = 0.01;
    r.tick(DT);
    expect(w.high).toBe(false);
    expect(w.target).not.toBe("atk");
    run(r, 1.05 / WORM_CLIMB_RATE);
    expect(w.alt).toBe(0);
    run(r, 6); // o corpo refaz a descida da cabeça
    expect(Math.max(...w.lift)).toBeLessThan(0.5);
  });

  it("a presa pousa (desce ao nível das estruturas): ela mergulha e segue atrás", () => {
    const r = makeRoom();
    const head = vacuum();
    const [, w] = wormAt(r, head);
    const atk = r.sim.addShip("atk", at(head, 20000), "p2", "attack");
    lifted(w, "atk");
    r.tick(DT);
    setLayer(atk, "surface");
    r.tick(DT);
    expect(w.high).toBe(false);
    expect(w.target).toBe("atk");
  });

  it("o espelho leva a altura de cada gomo", () => {
    const r = makeRoom();
    const [id, w] = wormAt(r, vacuum());
    r.sim.addShip("atk", at(w, 20000), "p2", "attack");
    lifted(w, "atk");
    r.tick(DT);
    const ws = r.state.worms.get(id) as { lift: number[] };
    expect(ws.lift.length).toBe(WORM_SEGMENTS);
    expect(ws.lift[0]).toBe(255);
  });
});
