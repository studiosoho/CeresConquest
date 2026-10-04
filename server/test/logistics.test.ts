import { afterEach, describe, expect, it } from "vitest";
import {
  TRANSPORT_HANDLING_TIME,
  STRUCTURE_SPECS,
  DRONE_BASE_CARGO,
  DRILL_BASE_RATE,
  DRONE_BASE_COUNT,
  DRONE_REBUILD_TIME,
  DRONE_UPGRADE_COST,
  HQ_EXPANDED_BAYS,
  HQ_SHIP_BAYS,
  RATIONS_PER_MINING_CYCLE,
  RATIONS_PER_SHIP,
  RATION_CENTER_EXPANDED_BAYS,
  RATION_CENTER_SHIP_BAYS,
  STATION_EXPANDED_BAYS,
  STATION_SHIP_BAYS,
  STATION_SPIDER_BAYS,
  STRUCTURE_START_RATIONS,
  asteroidClassOf,
  ceresPosition,
  dist,
  type DroneTrack,
  type ShipKind,
  type StructureType,
  type WorldPos,
} from "@ceres/shared";
import { sectorAsteroids, type Asteroid, type ShipState, type SimWorld, type Structure } from "@ceres/sim-core";
import { MatchRoom } from "../src/rooms/MatchRoom";

// Logística (logistics.ts): rações nas estações e QGs, drones da central de
// rações (entrega, abate, reposição, melhorias) e construções pagas em kits.

const SEED = 4242;
const DT = 0.05;
const CERES = ceresPosition(SEED);
const sector = { sx: CERES.sx - 4, sy: CERES.sy };
const rocks = [...sectorAsteroids(SEED, sector.sx, sector.sy)].sort((a, b) => b.radius - a.radius);

const rooms: MatchRoom[] = [];
afterEach(() => {
  for (const room of rooms.splice(0)) room.clock.clear();
});

interface Drone extends WorldPos { owner: string; center: string; phase: string; target: string; cargo: number; hp: number }

function makeRoom() {
  const room = new MatchRoom();
  (room as unknown as { listing: object }).listing = { metadata: {}, save: async () => {} };
  room.onCreate({ worldSeed: SEED, bots: 0, maxPlayers: 4 });
  rooms.push(room);
  return room as unknown as {
    sim: SimWorld;
    activeShip: Map<string, string>;
    drones: Map<string, Drone>;
    droneUpgrades: Map<string, Record<DroneTrack, number>>;
    tick(dt: number): void;
    dockAtBay(s: ShipState, st: Structure): void;
    tryAutoMine(sid: string): void;
    tryProduce(sid: string, kind: string): void;
    tryDroneUpgrade(sid: string, track: DroneTrack): void;
    tryLandAction(sid: string, action: string): void;
    tryToggleAnchor(sid: string): void;
    onBuilt(sid: string, id: string): void;
    damageDrone(id: string, dmg: number): void;
  };
}
type R = ReturnType<typeof makeRoom>;
const run = (r: R, seconds: number) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) r.tick(DT);
};
const until = (r: R, cond: () => boolean, limit: number) => {
  let t = 0;
  while (!cond() && t < limit) { r.tick(DT); t += DT; }
  return t;
};

function structure(r: R, owner: string, type: StructureType, ast: Asteroid, rations = 0): Structure {
  const bays: Record<StructureType, [number, number]> = {
    miningStation: [STATION_SHIP_BAYS, STATION_EXPANDED_BAYS],
    hq: [HQ_SHIP_BAYS, HQ_EXPANDED_BAYS],
    rationCenter: [RATION_CENTER_SHIP_BAYS, RATION_CENTER_EXPANDED_BAYS],
    initialBase: [5, 1],
  };
  return r.sim.addStructure({
    id: `st-${type}-${ast.id}`, type, owner, angle: 0.7,
    sx: ast.sx, sy: ast.sy, x: ast.x, y: ast.y,
    asteroidId: ast.id, asteroidClass: asteroidClassOf(ast.radius),
    shipBays: bays[type][0], expandedBays: bays[type][1],
    spiderBays: type === "miningStation" ? STATION_SPIDER_BAYS[asteroidClassOf(ast.radius)] : 0,
    nextShipBay: 0, nextSpiderBay: 0, oreStore: 0, rationStore: rations,
  });
}
let seq = 0;
function docked(r: R, owner: string, kind: ShipKind, st: Structure, bay: number): [string, ShipState] {
  const id = `l${seq++}`;
  const s = r.sim.addShip(id, st, owner, kind);
  s.bay = bay;
  r.dockAtBay(s, st);
  r.activeShip.set(owner, id);
  return [id, s];
}

describe("rações nas estações", () => {
  it("estação construída nasce com 100 rações (e paga em kits)", () => {
    const r = makeRoom();
    const rock = rocks[2];
    const s = r.sim.addShip("b", { ...rock, x: rock.x + rock.radius + 150 }, "p1", "builder");
    r.activeShip.set("p1", "b");
    r.tryToggleAnchor("p1");
    run(r, 1.6);
    expect(s.landingPhase).toBe("landed");
    r.tryLandAction("p1", "buildmine");
    expect([...r.sim.structures.values()].length).toBe(0); // sem kits, nada
    Object.assign(s, { kits: STRUCTURE_SPECS.miningStation.cost + 50 });
    r.tryLandAction("p1", "buildmine");
    const st = [...r.sim.structures.values()][0];
    expect(st.type).toBe("miningStation");
    expect(st.rationStore).toBe(STRUCTURE_START_RATIONS);
    expect(s.kits).toBe(50);
  });

  it("cada ciclo de coleta da aranha consome 10 rações; sem rações, ela para", () => {
    const r = makeRoom();
    const st = structure(r, "p1", "miningStation", rocks[0], 2 * RATIONS_PER_MINING_CYCLE);
    docked(r, "p1", "mining", st, 0);
    r.tryAutoMine("p1");
    // dois ciclos esgotam as rações
    expect(until(r, () => st.rationStore === 0, 200)).toBeLessThan(200);
    const ore = st.oreStore;
    expect(ore).toBeGreaterThan(0);
    run(r, 60);
    expect(st.oreStore).toBe(ore); // máquina parada
    st.rationStore = RATIONS_PER_MINING_CYCLE; // chegou ração: volta
    expect(until(r, () => st.oreStore > ore, 120)).toBeLessThan(120);
  });

  it("o QG sem rações não fabrica; cada nave consome 10", () => {
    const r = makeRoom();
    const q = structure(r, "p1", "hq", rocks[0], 0);
    docked(r, "p1", "builder", q, 0);
    q.oreStore = 1000; // a nave é paga com o minério do buffer do QG
    r.tryProduce("p1", "mining");
    expect([...r.sim.ships.values()].filter((s) => s.kind === "mining").length).toBe(0);
    q.rationStore = 15;
    r.tryProduce("p1", "mining");
    expect([...r.sim.ships.values()].filter((s) => s.kind === "mining").length).toBe(1);
    expect(q.rationStore).toBe(15 - RATIONS_PER_SHIP);
  });
});

describe("drones da central de rações", () => {
  /** central com estoque + uma estação sem rações; a central nasce com seus drones */
  function setup(r: R) {
    const center = structure(r, "p1", "rationCenter", rocks[0], 500);
    const st = structure(r, "p1", "miningStation", rocks[1], 0);
    r.onBuilt("p1", center.id);
    return { center, st };
  }

  it("a central nasce com 2 drones, que levam 10 rações por vez até a estação", () => {
    const r = makeRoom();
    const { center, st } = setup(r);
    const mine = () => [...r.drones.values()].filter((d) => d.center === center.id);
    expect(mine().length).toBe(DRONE_BASE_COUNT);
    run(r, 0.1);
    expect(mine().every((d) => d.phase === "out" && d.cargo === DRONE_BASE_CARGO)).toBe(true);
    expect(center.rationStore).toBe(500 - DRONE_BASE_COUNT * DRONE_BASE_CARGO);
    const trip = 2 * dist(center, st) / 900 + 2;
    run(r, trip);
    expect(st.rationStore).toBeGreaterThanOrEqual(DRONE_BASE_COUNT * DRONE_BASE_CARGO);
  });

  it("drone abatido some com a carga e a central o repõe depois de 30 s", () => {
    const r = makeRoom();
    const { center } = setup(r);
    run(r, 0.5);
    const [id] = [...r.drones.keys()];
    r.damageDrone(id, 1000);
    expect(r.drones.has(id)).toBe(false);
    const count = () => [...r.drones.values()].filter((d) => d.center === center.id).length;
    expect(count()).toBe(DRONE_BASE_COUNT - 1);
    run(r, DRONE_REBUILD_TIME - 1);
    expect(count()).toBe(DRONE_BASE_COUNT - 1);
    run(r, 1.5);
    expect(count()).toBe(DRONE_BASE_COUNT);
  });

  it("melhorias (kits): mais drones, mais velocidade, mais carga", () => {
    const r = makeRoom();
    const { center } = setup(r);
    const [, b] = docked(r, "p1", "builder", center, 0);
    Object.assign(b, { kits: 1000 });
    r.tryDroneUpgrade("p1", "drones");
    r.tryDroneUpgrade("p1", "cargo");
    r.tryDroneUpgrade("p1", "cargo");
    expect(r.droneUpgrades.get(center.id)).toEqual({ drones: 1, speed: 0, cargo: 2 });
    expect(b.kits).toBe(1000 - DRONE_UPGRADE_COST[0] * 2 - DRONE_UPGRADE_COST[1]);
    expect([...r.drones.values()].filter((d) => d.center === center.id).length).toBe(DRONE_BASE_COUNT + 1);
    for (let k = 0; k < 10; k++) r.tryDroneUpgrade("p1", "speed");
    expect(r.droneUpgrades.get(center.id)!.speed).toBe(4); // teto
  });

  it("drones distribuem também para o QG", () => {
    const r = makeRoom();
    const center = structure(r, "p1", "rationCenter", rocks[0], 500);
    const q = structure(r, "p1", "hq", rocks[1], 0);
    r.onBuilt("p1", center.id);
    run(r, 2 * dist(center, q) / 900 + 2);
    expect(q.rationStore).toBeGreaterThan(0);
  });
});

describe("transporte automático ([G])", () => {
  type RR = R & {
    waitingAt: Map<string, string>;
    freighters: Map<string, { leg: string }>;
    destroyStructure(id: string): void;
  };

  it("na estação de mineração: leva minério à base (sem QG) em laço; o piloto fica a pé na estação", () => {
    const r = makeRoom() as RR;
    // sem rações a broca fica parada: os números do estoque ficam exatos
    const st = structure(r, "p1", "miningStation", rocks[0], 0);
    const base = structure(r, "p1", "initialBase", rocks[1]);
    st.oreStore = 900;
    const [tId, t] = docked(r, "p1", "transport", st, STATION_EXPANDED_BAYS);
    r.tryAutoMine("p1");
    expect(r.freighters.has(tId)).toBe(true);
    expect(r.activeShip.has("p1")).toBe(false);
    expect(r.waitingAt.get("p1")).toBe(st.id);
    // CARGA: 15 s pousado na vaga da estação
    run(r, TRANSPORT_HANDLING_TIME - 0.5);
    expect([t.cargoAmount, t.anchored]).toEqual([0, true]);
    run(r, 1);
    expect([t.cargoKind, t.cargoAmount]).toEqual(["ore", 500]);
    expect(st.oreStore).toBe(400);
    // POUSA numa vaga da base e só então descarrega, em 15 s
    expect(until(r, () => t.anchored && t.hqId === base.id, 120)).toBeLessThan(120);
    expect(base.oreStore).toBe(0);
    run(r, TRANSPORT_HANDLING_TIME - 0.5);
    expect(base.oreStore).toBe(0);
    run(r, 1);
    expect([base.oreStore, t.cargoAmount]).toEqual([500, 0]);
    // volta, pousa na estação, carrega o resto e entrega
    expect(until(r, () => t.anchored && t.hqId === st.id, 120)).toBeLessThan(120);
    expect(until(r, () => t.cargoAmount === 400, 60)).toBeLessThan(60);
    expect(until(r, () => base.oreStore >= 900, 120)).toBeLessThan(120);
  });

  it("na base inicial: leva rações à central de rações", () => {
    const r = makeRoom() as RR;
    const base = structure(r, "p1", "initialBase", rocks[0], 300);
    const center = structure(r, "p1", "rationCenter", rocks[1], 0);
    docked(r, "p1", "transport", base, 1);
    r.tryAutoMine("p1");
    expect(until(r, () => center.rationStore > 0, 120)).toBeLessThan(120);
    expect(center.rationStore + base.rationStore).toBeGreaterThanOrEqual(299);
  });

  it("ao iniciar, o piloto passa para a próxima nave do hangar daquela estação", () => {
    const r = makeRoom() as RR;
    const st = structure(r, "p1", "miningStation", rocks[0], 100);
    structure(r, "p1", "initialBase", rocks[1]);
    const [, other] = docked(r, "p1", "builder", st, 0);
    Object.assign(other, { stored: true, anchored: false });
    const [tId] = docked(r, "p1", "transport", st, STATION_EXPANDED_BAYS);
    r.tryAutoMine("p1");
    const now = r.activeShip.get("p1")!;
    expect(now).not.toBe(tId);
    expect(r.sim.ships.get(now)!.kind).toBe("builder");
    expect(r.waitingAt.has("p1")).toBe(false);
  });

  it("sem a base inicial, o transporte volta e para na estação de mineração", () => {
    const r = makeRoom() as RR;
    const st = structure(r, "p1", "miningStation", rocks[0], 0);
    const base = structure(r, "p1", "initialBase", rocks[1]);
    st.oreStore = 300;
    const [tId, t] = docked(r, "p1", "transport", st, STATION_EXPANDED_BAYS);
    r.tryAutoMine("p1");
    r.tick(DT);
    r.destroyStructure(base.id);
    expect(until(r, () => !r.freighters.has(tId), 120)).toBeLessThan(120);
    expect([t.anchored, t.hqId]).toEqual([true, st.id]);
    expect(st.oreStore).toBe(300); // a carga voltou ao estoque
  });
});

describe("broca da estação e rota ao QG", () => {
  it("a broca escava 2 minérios/s por nível; parada sem rações", () => {
    const r = makeRoom();
    const st = structure(r, "p1", "miningStation", rocks[0], 100);
    run(r, 5);
    expect(st.oreStore).toBeCloseTo(DRILL_BASE_RATE * 5, 0);
    st.level = 2;
    st.oreStore = 0;
    run(r, 5);
    expect(st.oreStore).toBeCloseTo(DRILL_BASE_RATE * 2 * 5, 0);
    st.rationStore = 0;
    const ore = st.oreStore;
    run(r, 5);
    expect(st.oreStore).toBe(ore);
  });

  it("evoluir a estação custa kits (100 para o nível 2) e acelera a broca", () => {
    const r = makeRoom() as R & { tryUpgrade(sid: string): void };
    const st = structure(r, "p1", "miningStation", rocks[0], 100);
    const [, b] = docked(r, "p1", "builder", st, 0);
    b.kits = 99;
    r.tryUpgrade("p1");
    expect(st.level).toBe(1);
    b.kits = 100;
    r.tryUpgrade("p1");
    expect([st.level, b.kits]).toEqual([2, 0]);
  });

  it("com QG, a rota automática de minério vai para o QG mais próximo", () => {
    const r = makeRoom() as R & { freighters: Map<string, { dest: string }> };
    const st = structure(r, "p1", "miningStation", rocks[0], 0);
    structure(r, "p1", "initialBase", rocks[2]);
    const q = structure(r, "p1", "hq", rocks[1], 0);
    st.oreStore = 200;
    const [tId] = docked(r, "p1", "transport", st, STATION_EXPANDED_BAYS);
    r.tryAutoMine("p1");
    expect(r.freighters.get(tId)!.dest).toBe(q.id);
    expect(until(r, () => q.oreStore >= 200, 120)).toBeLessThan(120);
  });
});
