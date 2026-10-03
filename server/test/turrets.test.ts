import { afterEach, describe, expect, it } from "vitest";
import {
  BASE_EXPANDED_BAYS,
  BASE_SHIP_BAYS,
  BUILDER_ORE_CAP,
  HQ_EXPANDED_BAYS,
  HQ_SHIP_BAYS,
  LAYER_TRANSITION_TIME,
  SHIP_HP_MAX,
  STATION_EXPANDED_BAYS,
  STATION_SHIP_BAYS,
  STATION_SPIDER_BAYS,
  TURRET_BUILD_TIME,
  TURRET_COST,
  TURRET_DAMAGE,
  TURRET_MAX,
  asteroidClassOf,
  ceresPosition,
  type ShipKind,
  type StructureType,
  type WorldPos,
} from "@ceres/shared";
import { sectorAsteroids, type Asteroid, type ShipState, type SimWorld, type Structure } from "@ceres/sim-core";
import { MatchRoom } from "../src/rooms/MatchRoom";

// Turretas (turrets.ts): porão de minério do builder, obra com trava, defesa
// automática; e os bots atacantes. Sala de verdade, sem rede.

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
  rooms.push(room);
  return room as unknown as {
    sim: SimWorld;
    activeShip: Map<string, string>;
    turrets: Map<string, number>;
    turretJobs: Map<string, { shipId: string; progress: number }>;
    attackTargets: Map<string, { structId: string; radius: number }>;
    broadcast: (type: string, msg: never) => void;
    tick(dt: number): void;
    tryCargo(sid: string): void;
    tryBuildTurret(sid: string): void;
    tryToggleAnchor(sid: string): void;
    trySwap(sid: string): void;
    dockAtBay(s: ShipState, st: Structure): void;
  };
}
type R = ReturnType<typeof makeRoom>;

const run = (r: R, seconds: number) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) r.tick(DT);
};
const at = (p: WorldPos, dx: number, dy = 0): WorldPos => ({ sx: p.sx, sy: p.sy, x: p.x + dx, y: p.y + dy });

function structure(r: R, owner: string, type: StructureType, ast: Asteroid, angle = 0.7): Structure {
  const base = type === "initialBase";
  return r.sim.addStructure({
    id: `st-${type}-${ast.id}`, type, owner, angle,
    sx: ast.sx, sy: ast.sy, x: ast.x, y: ast.y,
    asteroidId: ast.id, asteroidClass: asteroidClassOf(ast.radius),
    shipBays: base ? BASE_SHIP_BAYS : STATION_SHIP_BAYS,
    expandedBays: base ? BASE_EXPANDED_BAYS : STATION_EXPANDED_BAYS,
    spiderBays: base ? 0 : STATION_SPIDER_BAYS[asteroidClassOf(ast.radius)],
    nextShipBay: 0, nextSpiderBay: 0, oreStore: 0, rationStore: 0,
  });
}

let seq = 0;
/** Nave atracada na vaga `bay` da estrutura (e pilotada, se `pilot`). */
function docked(r: R, owner: string, kind: ShipKind, st: Structure, bay: number, pilot = true): [string, ShipState] {
  const id = `t${seq++}`;
  const s = r.sim.addShip(id, st, owner, kind);
  s.bay = bay;
  r.dockAtBay(s, st);
  if (pilot) r.activeShip.set(owner, id);
  return [id, s];
}

describe("porão de minério do builder", () => {
  it("[E] carrega do estoque da estação e, na base, da carteira — até BUILDER_ORE_CAP", () => {
    const r = makeRoom();
    const st = structure(r, "p1", "miningStation", rocks[0]);
    st.oreStore = 200;
    const [, b] = docked(r, "p1", "builder", st, 0);
    r.tryCargo("p1");
    expect([b.cargoKind, b.cargoAmount, st.oreStore]).toEqual(["ore", 200, 0]);

    const base = structure(r, "p1", "initialBase", rocks[1]);
    r.sim.addOre("p1", 1000);
    b.bay = 0;
    r.dockAtBay(b, base);
    r.tryCargo("p1");
    expect(b.cargoAmount).toBe(BUILDER_ORE_CAP);
    expect(r.sim.getOre("p1")).toBe(1000 - (BUILDER_ORE_CAP - 200));
    r.tryCargo("p1"); // cheio: nada muda
    expect(r.sim.getOre("p1")).toBe(1000 - (BUILDER_ORE_CAP - 200));
  });
});

describe("obra de turreta", () => {
  it("custa minério do porão, trava o builder até o fim e entra em serviço", () => {
    const r = makeRoom();
    const st = structure(r, "p1", "miningStation", rocks[0]);
    const [bId, b] = docked(r, "p1", "builder", st, 0);
    r.tryBuildTurret("p1");
    expect(r.turretJobs.size).toBe(0); // porão vazio: nada

    b.cargoKind = "ore";
    b.cargoAmount = TURRET_COST + 30;
    r.tryBuildTurret("p1");
    expect(r.turretJobs.get(st.id)?.shipId).toBe(bId);
    expect(b.cargoAmount).toBe(30);

    r.tryToggleAnchor("p1"); // [F]: não decola em obra
    expect(b.anchored).toBe(true);
    run(r, TURRET_BUILD_TIME * 0.5);
    expect(r.turretJobs.get(st.id)?.progress).toBeCloseTo(0.5, 1);
    expect(b.anchored).toBe(true);

    run(r, TURRET_BUILD_TIME * 0.5 + 0.2);
    expect(r.turrets.get(st.id)).toBe(1);
    expect(r.turretJobs.size).toBe(0);
    r.tryToggleAnchor("p1"); // pronto: decola
    expect(b.anchored).toBe(false);
  });

  it("só uma obra por vez, até TURRET_MAX, e só em estrutura própria", () => {
    const r = makeRoom();
    const st = structure(r, "p1", "miningStation", rocks[0]);
    const [, b] = docked(r, "p1", "builder", st, 0);
    b.cargoKind = "ore";
    b.cargoAmount = 10_000;
    for (let k = 0; k < TURRET_MAX + 2; k++) {
      r.tryBuildTurret("p1");
      r.tryBuildTurret("p1"); // a segunda chamada não abre outra obra
      run(r, TURRET_BUILD_TIME + 0.2);
    }
    expect(r.turrets.get(st.id)).toBe(TURRET_MAX);
    expect(b.cargoAmount).toBe(10_000 - TURRET_MAX * TURRET_COST);

    const enemy = structure(r, "p2", "miningStation", rocks[1]);
    b.bay = 0;
    r.dockAtBay(b, enemy);
    r.tryBuildTurret("p1");
    expect(r.turretJobs.size).toBe(0);
  });

  it("trocar de nave deixa o builder trabalhando na vaga; pronta a obra, ele vai ao hangar", () => {
    const r = makeRoom();
    const st = structure(r, "p1", "miningStation", rocks[0]);
    const [bId, b] = docked(r, "p1", "builder", st, 0);
    const [aId, a] = docked(r, "p1", "attack", st, STATION_EXPANDED_BAYS, false);
    a.stored = true;
    a.anchored = false;
    b.cargoKind = "ore";
    b.cargoAmount = TURRET_COST;
    r.tryBuildTurret("p1");
    r.trySwap("p1");
    expect(r.activeShip.get("p1")).toBe(aId);
    expect(b.anchored).toBe(true);
    expect(b.stored).toBe(false);
    expect(r.turretJobs.get(st.id)?.shipId).toBe(bId);
    run(r, TURRET_BUILD_TIME + 0.2);
    expect(r.turrets.get(st.id)).toBe(1);
    expect(b.stored).toBe(true);
    expect(b.anchored).toBe(false);
  });

  it("builder destruído: a obra se perde", () => {
    const r = makeRoom();
    const st = structure(r, "p1", "miningStation", rocks[0]);
    const [bId, b] = docked(r, "p1", "builder", st, 0);
    b.cargoKind = "ore";
    b.cargoAmount = TURRET_COST;
    r.tryBuildTurret("p1");
    r.sim.removeShip(bId);
    run(r, TURRET_BUILD_TIME + 0.2);
    expect(r.turrets.get(st.id) ?? 0).toBe(0);
    expect(r.turretJobs.size).toBe(0);
  });
});

describe("defesa automática", () => {
  it("as turretas atiram na nave inimiga em modo ataque da estação, e só nela", () => {
    const r = makeRoom();
    const fx: Array<{ kind: string }> = [];
    r.broadcast = (type, msg) => {
      if (type === "fx") fx.push(msg);
    };
    const rock = rocks[0];
    const st = structure(r, "p1", "miningStation", rock);
    r.turrets.set(st.id, 2);
    // atacante: desce ao modo ataque sobre a estação
    const atk = r.sim.addShip("enemy", at(rock, rock.radius + 100), "p2", "attack");
    r.activeShip.set("p2", "enemy");
    // vizinho inimigo em cruzeiro, perto, mas fora do modo ataque
    const passer = r.sim.addShip("passer", at(rock, -(rock.radius + 300)), "p3", "attack");
    r.tryToggleAnchor("p2");
    run(r, LAYER_TRANSITION_TIME + 0.1);
    expect(r.attackTargets.get("enemy")?.structId).toBe(st.id);
    const before = atk.hp;
    const fired = fx.length;
    run(r, 2);
    const shots = fx.slice(fired).filter((e) => e.kind === "laser").length;
    expect(shots).toBeGreaterThanOrEqual(4); // 2 turretas, ~0,8 s
    expect(atk.hp).toBeCloseTo(before - shots * TURRET_DAMAGE, 6);
    expect(passer.hp).toBe(SHIP_HP_MAX);
  });

  it("sem turretas, nenhum tiro", () => {
    const r = makeRoom();
    const fx: Array<{ kind: string }> = [];
    r.broadcast = (type, msg) => {
      if (type === "fx") fx.push(msg);
    };
    const rock = rocks[0];
    structure(r, "p1", "miningStation", rock);
    const atk = r.sim.addShip("enemy", at(rock, rock.radius + 100), "p2", "attack");
    r.activeShip.set("p2", "enemy");
    r.tryToggleAnchor("p2");
    run(r, LAYER_TRANSITION_TIME + 2);
    expect(fx.length).toBe(0);
    expect(atk.hp).toBe(SHIP_HP_MAX);
  });
});

describe("troca de nave no hangar ([C])", () => {
  it("percorre todas as vagas ocupadas em ordem (1 → 6) e volta ao início", () => {
    const r = makeRoom();
    const rock = rocks[0];
    const hq = r.sim.addStructure({
      id: "st-hq", type: "hq", owner: "p1", angle: 0,
      sx: rock.sx, sy: rock.sy, x: rock.x, y: rock.y,
      asteroidId: rock.id, asteroidClass: asteroidClassOf(rock.radius),
      shipBays: HQ_SHIP_BAYS, expandedBays: HQ_EXPANDED_BAYS, spiderBays: 0,
      nextShipBay: 0, nextSpiderBay: 0, oreStore: 0, rationStore: 0,
    });
    // vagas 0–1 expandidas (builder/mineração), 2–5 normais (ataque/transporte)
    const kinds: ShipKind[] = ["builder", "mining", "attack", "transport", "attack", "transport"];
    const ids = kinds.map((k, bay) => {
      const [id, s] = docked(r, "p1", k, hq, bay, bay === 0);
      if (bay > 0) Object.assign(s, { stored: true, anchored: false });
      return id;
    });
    const visited: number[] = [];
    for (let k = 0; k < kinds.length; k++) {
      r.trySwap("p1");
      visited.push(r.sim.ships.get(r.activeShip.get("p1")!)!.bay);
    }
    expect(visited).toEqual([1, 2, 3, 4, 5, 0]);
    // cada nave continua na própria vaga, uma pilotada e cinco guardadas
    for (const [bay, id] of ids.entries()) expect(r.sim.ships.get(id)!.bay).toBe(bay);
    expect(ids.filter((id) => r.sim.ships.get(id)!.stored).length).toBe(5);
  });

  it("pula as vagas vazias", () => {
    const r = makeRoom();
    const st = structure(r, "p1", "miningStation", rocks[0]);
    const [aId] = docked(r, "p1", "attack", st, STATION_EXPANDED_BAYS);
    const [, far] = docked(r, "p1", "transport", st, STATION_EXPANDED_BAYS + 3, false);
    Object.assign(far, { stored: true, anchored: false });
    r.trySwap("p1");
    expect(r.sim.ships.get(r.activeShip.get("p1")!)!.bay).toBe(STATION_EXPANDED_BAYS + 3);
    r.trySwap("p1");
    expect(r.activeShip.get("p1")).toBe(aId);
  });
});
