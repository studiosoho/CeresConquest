import { afterEach, describe, expect, it } from "vitest";
import {
  LAYER_TRANSITION_TIME,
  MISSILE_DAMAGE,
  STATION_EXPANDED_BAYS,
  STATION_SHIP_BAYS,
  STATION_SPIDER_BAYS,
  asteroidClassOf,
  ceresPosition,
  dist,
  relVec,
  wrapAngle,
  type FxEvent,
  type ShipInput,
  type WorldPos,
} from "@ceres/shared";
import { attackModeInput, makeShip, sectorAsteroids, type Asteroid, type ShipState, type SimWorld, type Structure } from "@ceres/sim-core";
import { MatchRoom } from "../src/rooms/MatchRoom";

// Modo ataque (nariz travado na estação, A/D circulam — sim-core
// attackModeInput) e explosões anunciadas EM QUEM recebeu o dano.

const SEED = 4242;
const DT = 0.05;
const CERES = ceresPosition(SEED);
const sector = { sx: CERES.sx - 4, sy: CERES.sy };
const rocks = [...sectorAsteroids(SEED, sector.sx, sector.sy)].sort((a, b) => b.radius - a.radius);

const rooms: MatchRoom[] = [];
afterEach(() => {
  for (const room of rooms.splice(0)) room.clock.clear();
});

function makeRoom() {
  const room = new MatchRoom();
  (room as unknown as { listing: object }).listing = { metadata: {}, save: async () => {} };
  room.onCreate({ worldSeed: SEED, bots: 0, maxPlayers: 4 });
  rooms.push(room);
  return room as unknown as {
    sim: SimWorld;
    activeShip: Map<string, string>;
    rawInputs: Map<string, ShipInput>;
    attackTargets: Map<string, { structId: string; radius: number }>;
    broadcast: (type: string, msg: never) => void;
    tick(dt: number): void;
    tryToggleAnchor(sid: string): void;
    tryFire(sid: string): void;
    combatRng: () => number;
  };
}
type R = ReturnType<typeof makeRoom>;
const run = (r: R, seconds: number) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) r.tick(DT);
};
const at = (p: WorldPos, dx: number, dy = 0): WorldPos => ({ sx: p.sx, sy: p.sy, x: p.x + dx, y: p.y + dy });

function station(r: R, owner: string, ast: Asteroid): Structure {
  return r.sim.addStructure({
    id: `st-${ast.id}`, type: "miningStation", owner, angle: 0.7,
    sx: ast.sx, sy: ast.sy, x: ast.x, y: ast.y,
    asteroidId: ast.id, asteroidClass: asteroidClassOf(ast.radius),
    shipBays: STATION_SHIP_BAYS, expandedBays: STATION_EXPANDED_BAYS,
    spiderBays: STATION_SPIDER_BAYS[asteroidClassOf(ast.radius)],
    nextShipBay: 0, nextSpiderBay: 0, oreStore: 0, rationStore: 0,
  });
}
const bearing = (from: WorldPos, to: WorldPos) => {
  const { dx, dy } = relVec(from, to);
  return Math.atan2(dy, dx);
};

describe("tradução do modo ataque (regra pura)", () => {
  const ship = makeShip({ sx: 0, sy: 0, x: 0, y: 0 }, "p1", "attack");
  const target = { sx: 0, sy: 0, x: 1000, y: 0 };
  const idle: ShipInput = { thrust: false, turn: 0, mine: false };

  it("A/D viram voo lateral; o leme é do piloto automático (nariz na estação)", () => {
    ship.angle = Math.PI / 2; // nariz fora da estação
    const d = attackModeInput(ship, target, 2000, { ...idle, turn: 1 });
    expect(d.strafe).toBe(1);
    expect(d.turn).toBe(-1); // vira o nariz para a estação (ângulo 0)
    const a = attackModeInput(ship, target, 2000, { ...idle, turn: -1 });
    expect(a.strafe).toBe(-1);
  });

  it("parede macia: longe da estação, puxa de volta — só com o nariz nela, e não com S", () => {
    ship.angle = 0;
    ship.av = 0;
    expect(attackModeInput(ship, target, 500, idle).thrust).toBe(true);
    expect(attackModeInput(ship, target, 2000, idle).thrust).toBe(false);
    expect(attackModeInput(ship, target, 500, { ...idle, retro: true }).thrust).toBe(false);
    ship.angle = Math.PI; // de costas: empurrar afastaria
    expect(attackModeInput(ship, target, 500, idle).thrust).toBe(false);
  });
});

describe("modo ataque na sala", () => {
  it("segurando D, a nave circula a estação de nariz nela, sem sair da zona", () => {
    const r = makeRoom();
    const rock = rocks[0];
    const st = station(r, "p2", rock);
    const s = r.sim.addShip("atk", at(rock, rock.radius + 100), "p1", "attack");
    s.angle = Math.PI / 2; // entra olhando para o lado
    r.activeShip.set("p1", "atk");
    r.tryToggleAnchor("p1");
    run(r, LAYER_TRANSITION_TIME + 0.2);
    expect(r.attackTargets.get("atk")?.structId).toBe(st.id);
    // o nariz já travou na estação
    expect(Math.abs(wrapAngle(bearing(s, st) - s.angle))).toBeLessThan(0.2);

    const start = bearing(st, s);
    r.rawInputs.set("atk", { thrust: false, turn: 1, mine: false });
    run(r, 8);
    expect(r.attackTargets.has("atk")).toBe(true); // continua no modo ataque
    expect(Math.abs(wrapAngle(bearing(st, s) - start))).toBeGreaterThan(0.3); // deu a volta (parte dela)
    expect(Math.abs(wrapAngle(bearing(s, st) - s.angle))).toBeLessThan(0.25);
    expect(dist(s, st)).toBeLessThan(rock.radius + 200);
  });
});

describe("explosão em quem recebeu o dano", () => {
  function spy(r: R) {
    const events: FxEvent[] = [];
    r.broadcast = (type, msg) => {
      if (type === "fx") events.push(msg);
    };
    return events;
  }

  it("míssil na nave: a explosão é nela (on: ship, id)", () => {
    const r = makeRoom();
    const fx = spy(r);
    const rock = rocks[0];
    const p = at(rock, rock.radius + 3000);
    const a = r.sim.addShip("a", p, "p1", "attack");
    r.sim.addShip("b", at(p, 400), "p2", "attack");
    r.activeShip.set("p1", "a");
    a.angle = 0;
    r.tryFire("p1");
    run(r, 1);
    const hits = fx.filter((e) => e.kind === "hit");
    expect(hits.length).toBe(1);
    expect(hits[0]).toMatchObject({ on: "ship", id: "b" });
  });

  it("míssil na estação: uma explosão em cada um que o sorteio atingiu (prédio e vagas)", () => {
    const r = makeRoom();
    const fx = spy(r);
    const rock = rocks[0];
    const st = station(r, "p2", rock);
    // duas naves guardadas no hangar da estação
    const stored: ShipState[] = [];
    for (let i = 0; i < 2; i++) {
      const s = r.sim.addShip(`h${i}`, st, "p2", "builder");
      Object.assign(s, { stored: true, hqId: st.id, bay: i });
      stored.push(s);
    }
    // atacante em modo ataque, de frente para a estação
    r.sim.addShip("a", at(rock, rock.radius + 100), "p1", "attack");
    r.activeShip.set("p1", "a");
    r.tryToggleAnchor("p1");
    run(r, LAYER_TRANSITION_TIME + 1);
    const before = [st.hp, ...stored.map((s) => s.hp)];
    fx.length = 0;
    r.tryFire("p1");
    run(r, 1);
    const lost = [st.hp, ...stored.map((s) => s.hp)].map((hp, i) => before[i] - hp);
    expect(lost.reduce((x, y) => x + y, 0)).toBeCloseTo(MISSILE_DAMAGE, 6);
    const hits = fx.filter((e) => e.kind === "hit");
    // exatamente quem perdeu HP explodiu — no prédio ou na vaga de cada nave
    expect(hits.length).toBe(lost.filter((x) => x > 0).length);
    if (lost[0] > 0) expect(hits).toContainEqual(expect.objectContaining({ on: "structure", id: st.id }));
    stored.forEach((s, i) => {
      if (lost[i + 1] > 0) expect(hits).toContainEqual(expect.objectContaining({ on: "bay", id: st.id, bay: s.bay }));
    });
  });
});
