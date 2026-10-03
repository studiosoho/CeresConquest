import { afterEach, describe, expect, it } from "vitest";
import {
  BASE_EXPANDED_BAYS,
  BASE_SHIP_BAYS,
  BUILDER_HOLD_TOTAL,
  BUILDER_ITEM_CAP,
  REFINE_KITS,
  REFINE_ORE,
  REFINE_TIME,
  RUIN_OWNER,
  HQ_EXPANDED_BAYS,
  HQ_SHIP_BAYS,
  LAYER_TRANSITION_TIME,
  MINING_RATE_BY_KIND,
  REPAIR_HP_PER_KIT,
  REPAIR_RATE,
  structureMaxHp,
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
  dist,
  type ShipKind,
  type StructureType,
  type WorldPos,
} from "@ceres/shared";
import { makeShip, sectorAsteroids, type Asteroid, type ShipState, type SimWorld, type Structure } from "@ceres/sim-core";
import { hittableLevel } from "../src/combat";
import { MatchRoom } from "../src/rooms/MatchRoom";
import { PlayerSchema } from "../src/schema/State";

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

describe("conserto [G] e mineração do builder na estação", () => {
  type RG = R & { tryAutoMine(sid: string): void; tryStationMine(sid: string): void; repairJobs: Map<string, unknown> };

  it("[G] conserta a estrutura própria: kits do porão primeiro, depois do buffer", () => {
    const r = makeRoom() as RG;
    const st = structure(r, "p1", "miningStation", rocks[0]);
    const max = structureMaxHp("miningStation", 1);
    st.hp = max - 200;
    st.kitStore = 50;
    const [, b] = docked(r, "p1", "builder", st, 0);
    b.kits = 5;
    r.tryAutoMine("p1");
    run(r, 50 / REPAIR_RATE); // 50 HP: os 5 kits do porão
    expect(st.hp).toBeCloseTo(max - 150, 5);
    expect([b.kits, st.kitStore]).toEqual([0, 50]);
    run(r, 150 / REPAIR_RATE + 1);
    expect(st.hp).toBe(max);
    expect(st.kitStore).toBe(50 - 150 / REPAIR_HP_PER_KIT);
    expect(r.repairJobs.size).toBe(0); // terminou sozinho
  });

  it("[G] de novo desliga; sem kits nem começa; acabando os kits, para", () => {
    const r = makeRoom() as RG;
    const st = structure(r, "p1", "miningStation", rocks[0]);
    const max = structureMaxHp("miningStation", 1);
    st.hp = max - 300;
    const [, b] = docked(r, "p1", "builder", st, 0);
    b.kits = 0;
    r.tryAutoMine("p1");
    expect(r.repairJobs.size).toBe(0);
    b.kits = 3;
    r.tryAutoMine("p1");
    r.tryAutoMine("p1");
    expect(r.repairJobs.size).toBe(0);
    r.tryAutoMine("p1");
    run(r, 300 / REPAIR_RATE);
    expect(st.hp).toBeCloseTo(max - 300 + 3 * REPAIR_HP_PER_KIT, 5);
    expect(r.repairJobs.size).toBe(0);
  });

  it("builder atracado na estação: [ESP] minera direto para o buffer dela", () => {
    const r = makeRoom() as RG;
    const st = structure(r, "p1", "miningStation", rocks[0]); // sem rações: broca parada
    const [, b] = docked(r, "p1", "builder", st, 0);
    r.tryStationMine("p1");
    run(r, 10);
    expect(st.oreStore).toBeCloseTo(MINING_RATE_BY_KIND.builder * 10, 0);
    expect(b.cargoAmount).toBe(0);
    r.tryStationMine("p1");
    const before = st.oreStore;
    run(r, 2);
    expect(st.oreStore).toBe(before);
  });
});

describe("porão do builder: refinaria e trocas com o buffer", () => {
  type RT = R & { tryTransfer(sid: string, item: "ore" | "kits" | "rations", dir: "withdraw" | "deposit"): void };

  it("[E] refina 50 de minério do PORÃO em 10 kits (5:1), em 5 s; os lotes fazem fila", () => {
    const r = makeRoom();
    const st = structure(r, "p1", "miningStation", rocks[0]);
    const [, b] = docked(r, "p1", "builder", st, 0);
    Object.assign(b, { cargoKind: "ore", cargoAmount: 120 });
    r.tryCargo("p1");
    r.tryCargo("p1");
    r.tryCargo("p1"); // só sobrou 20: não refina
    expect(b.cargoAmount).toBe(120 - 2 * REFINE_ORE);
    expect(b.kits).toBe(0);
    run(r, REFINE_TIME - 0.2);
    expect(b.kits).toBe(0);
    run(r, 0.4);
    expect(b.kits).toBe(REFINE_KITS);
    run(r, REFINE_TIME);
    expect(b.kits).toBe(2 * REFINE_KITS);
  });

  it("refina também fora da estação (ex.: pousado minerando)", () => {
    const r = makeRoom();
    const b = r.sim.addShip("solo", at(rocks[0], rocks[0].radius + 2000), "p1", "builder");
    r.activeShip.set("p1", "solo");
    Object.assign(b, { cargoKind: "ore", cargoAmount: REFINE_ORE });
    r.tryCargo("p1");
    run(r, REFINE_TIME + 0.1);
    expect([b.kits, b.cargoAmount]).toEqual([REFINE_KITS, 0]);
  });

  it("os kits (com a fila) não passam do teto do item", () => {
    const r = makeRoom();
    const st = structure(r, "p1", "miningStation", rocks[0]);
    const [, b] = docked(r, "p1", "builder", st, 0);
    Object.assign(b, { cargoKind: "ore", cargoAmount: 200, kits: BUILDER_ITEM_CAP - REFINE_KITS });
    r.tryCargo("p1");
    r.tryCargo("p1"); // passaria do teto: recusado
    expect(b.cargoAmount).toBe(200 - REFINE_ORE);
    run(r, REFINE_TIME + 0.1);
    expect(b.kits).toBe(BUILDER_ITEM_CAP);
  });

  it("[O]/[P] retiram e depositam minério; [K]/[L], kits — respeitando porão e buffer", () => {
    const r = makeRoom() as RT;
    const base = structure(r, "p1", "initialBase", rocks[0]);
    base.oreStore = 500;
    base.kitStore = 40;
    const [, b] = docked(r, "p1", "builder", base, 0);
    b.kits = 230;
    r.tryTransfer("p1", "ore", "withdraw");
    // 250 de minério cabem no item, mas o total pararia em 500: 230 + 250 = 480
    expect([b.cargoAmount, base.oreStore]).toEqual([BUILDER_ITEM_CAP, 500 - BUILDER_ITEM_CAP]);
    r.tryTransfer("p1", "kits", "withdraw");
    expect([b.kits, base.kitStore]).toEqual([BUILDER_ITEM_CAP, 20]); // 250 + 250 = 500
    r.tryTransfer("p1", "ore", "deposit");
    expect([b.cargoAmount, b.cargoKind, base.oreStore]).toEqual([0, "", 500]);
    r.tryTransfer("p1", "kits", "deposit");
    expect([b.kits, base.kitStore]).toEqual([0, 20 + BUILDER_ITEM_CAP]);
  });

  it("o porão nunca passa de 500 somados (250 por item)", () => {
    const r = makeRoom() as RT;
    const base = structure(r, "p1", "initialBase", rocks[0]);
    Object.assign(base, { oreStore: 1000, kitStore: 1000, rationStore: 1000 });
    const [, b] = docked(r, "p1", "builder", base, 0);
    b.kits = 0;
    r.tryTransfer("p1", "rations", "withdraw");
    r.tryTransfer("p1", "ore", "withdraw");
    r.tryTransfer("p1", "kits", "withdraw");
    expect([b.rations, b.cargoAmount, b.kits]).toEqual([BUILDER_ITEM_CAP, BUILDER_ITEM_CAP, 0]);
    expect(b.rations + b.cargoAmount + b.kits).toBe(BUILDER_HOLD_TOTAL);
  });

  it("[J]: carrega rações na base e na central; descarrega na estação de mineração e no QG", () => {
    const r = makeRoom() as RT;
    const base = structure(r, "p1", "initialBase", rocks[0]);
    base.rationStore = 400;
    const st = structure(r, "p1", "miningStation", rocks[1]);
    st.rationStore = 0;
    const [, b] = docked(r, "p1", "builder", base, 0);
    b.kits = 0;
    r.tryTransfer("p1", "rations", "withdraw");
    expect([b.rations, Math.round(base.rationStore)]).toEqual([BUILDER_ITEM_CAP, 400 - BUILDER_ITEM_CAP]);
    b.bay = 0;
    r.dockAtBay(b, st);
    r.tryTransfer("p1", "rations", "withdraw"); // a direção vem da estrutura: aqui descarrega
    expect([b.rations, st.rationStore]).toEqual([0, BUILDER_ITEM_CAP]);
  });

  it("[J] na central de rações: chegando com rações descarrega; sem rações, carrega", () => {
    const r = makeRoom() as RT;
    const center = structure(r, "p1", "rationCenter", rocks[0]);
    center.rationStore = 100;
    const [, b] = docked(r, "p1", "builder", center, 0);
    b.kits = 0;
    b.rations = 80;
    r.tryTransfer("p1", "rations", "withdraw");
    expect([b.rations, center.rationStore]).toEqual([0, 180]);
    r.tryTransfer("p1", "rations", "withdraw");
    expect([b.rations, center.rationStore]).toEqual([180, 0]);
  });
});

describe("obra de turreta", () => {
  it("custa minério do porão, trava o builder até o fim e entra em serviço", () => {
    const r = makeRoom();
    const st = structure(r, "p1", "miningStation", rocks[0]);
    const [bId, b] = docked(r, "p1", "builder", st, 0);
    r.tryBuildTurret("p1");
    expect(r.turretJobs.size).toBe(0); // porão vazio: nada

    b.kits = TURRET_COST + 30;
    r.tryBuildTurret("p1");
    expect(r.turretJobs.get(st.id)?.shipId).toBe(bId);
    expect(b.kits).toBe(30);

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

  it("paga com os kits do BUFFER da estação primeiro; o que faltar sai do porão", () => {
    const r = makeRoom();
    const st = structure(r, "p1", "miningStation", rocks[0]);
    st.kitStore = TURRET_COST - 30;
    const [, b] = docked(r, "p1", "builder", st, 0);
    b.kits = 50;
    r.tryBuildTurret("p1");
    expect(r.turretJobs.has(st.id)).toBe(true);
    expect([st.kitStore, b.kits]).toEqual([0, 20]);
  });

  it("só uma obra por vez, até TURRET_MAX, e só em estrutura própria", () => {
    const r = makeRoom();
    const st = structure(r, "p1", "miningStation", rocks[0]);
    const [, b] = docked(r, "p1", "builder", st, 0);
    b.kits = 10_000;
    for (let k = 0; k < TURRET_MAX + 2; k++) {
      r.tryBuildTurret("p1");
      r.tryBuildTurret("p1"); // a segunda chamada não abre outra obra
      run(r, TURRET_BUILD_TIME + 0.2);
    }
    expect(r.turrets.get(st.id)).toBe(TURRET_MAX);
    expect(b.kits).toBe(10_000 - TURRET_MAX * TURRET_COST);

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
    b.kits = TURRET_COST;
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
    b.kits = TURRET_COST;
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

describe("escape pod, piloto a pé e fim de jogo", () => {
  type RR = R & {
    state: { players: Map<string, PlayerSchema> };
    waitingAt: Map<string, string>;
    restartPlayer(sid: string): void;
    raidTargetOf(s: ShipState): Structure | null;
    destroyStructure(id: string): void;
    tryProduce(sid: string, kind: string): void;
    tryTaxi(sid: string, shipId?: string): void;
    tryAutoMine(sid: string): void;
    stat(sid: string): unknown;
  };
  const room = () => {
    const r = makeRoom() as RR;
    r.state.players.set("p1", new PlayerSchema());
    r.stat("p1"); // relógio de sobrevivência (a entrada na sala faz isto)
    return r;
  };
  const kill = (r: R, id: string) => {
    const s = r.sim.ships.get(id)!;
    (r as unknown as { damageShip(e: [string, ShipState], d: number): void }).damageShip([id, s], 10_000);
  };
  const hq = (r: R, owner: string, ast: Asteroid) => r.sim.addStructure({
    id: `st-hq-${ast.id}`, type: "hq", owner, angle: 0,
    sx: ast.sx, sy: ast.sy, x: ast.x, y: ast.y,
    asteroidId: ast.id, asteroidClass: asteroidClassOf(ast.radius),
    shipBays: HQ_SHIP_BAYS, expandedBays: HQ_EXPANDED_BAYS, spiderBays: 0,
    nextShipBay: 0, nextSpiderBay: 0, oreStore: 0, rationStore: 0,
  });
  const until = (r: R, cond: () => boolean, limit = 60) => {
    let t = 0;
    while (!cond() && t < limit) { r.tick(DT); t += DT; }
    return t;
  };

  it("nave destruída: o pod voa sozinho até a estrutura própria mais próxima e o piloto espera a pé", () => {
    const r = room();
    const q = hq(r, "p1", rocks[0]);
    const other = structure(r, "p1", "miningStation", rocks[2]);
    const me = r.sim.addShip("me", at(rocks[0], rocks[0].radius + 3000), "p1", "builder");
    const nearest = dist(me, q) < dist(me, other) ? q : other;
    r.activeShip.set("p1", "me");
    kill(r, "me");
    const pod = r.sim.ships.get(r.activeShip.get("p1")!)!;
    expect([pod.kind, pod.taxiTo]).toEqual(["pod", nearest.id]);
    expect(until(r, () => r.waitingAt.has("p1"))).toBeLessThan(60);
    expect(r.waitingAt.get("p1")).toBe(nearest.id);
    expect(r.activeShip.has("p1")).toBe(false);
    expect([...r.sim.ships.values()].some((s) => s.kind === "pod")).toBe(false);
    r.tick(DT);
    expect(r.state.players.get("p1")!.station).toBe(nearest.id);
  });

  it("a pé no QG: fabrica e embarca com [C]", () => {
    const r = room();
    const q = hq(r, "p1", rocks[0]);
    r.sim.addShip("b", at(rocks[1], 0), "p1", "builder"); // há builder: o jogo segue
    r.waitingAt.set("p1", q.id);
    q.rationStore = 100; // o QG precisa de rações para fabricar
    q.oreStore = 200; // e de minério no buffer dele
    r.tryProduce("p1", "attack");
    const made = [...r.sim.ships].find(([, s]) => s.hqId === q.id && s.stored)!;
    expect(made[1].kind).toBe("attack");
    r.trySwap("p1");
    expect(r.activeShip.get("p1")).toBe(made[0]);
    expect(made[1].anchored).toBe(true);
    expect(r.waitingAt.has("p1")).toBe(false);
  });

  it("a pé: o táxi vem de QUALQUER hangar até a estação, e o piloto embarca nele", () => {
    const r = room();
    const here = structure(r, "p1", "miningStation", rocks[0]);
    const there = structure(r, "p1", "initialBase", rocks[1]); // não é QG
    const [cab, s] = docked(r, "p1", "builder", there, 0, false);
    Object.assign(s, { stored: true, anchored: false });
    r.waitingAt.set("p1", here.id);
    r.tryTaxi("p1", cab);
    expect(s.taxiTo).toBe(here.id);
    expect(until(r, () => r.activeShip.get("p1") === cab, 120)).toBeLessThan(120);
    expect([s.anchored, s.hqId]).toEqual([true, here.id]);
    expect(r.waitingAt.has("p1")).toBe(false);
  });

  it("automineração: o piloto desembarca e fica na estação (sem teleporte)", () => {
    const r = room();
    const st = structure(r, "p1", "miningStation", rocks[0]);
    r.sim.addShip("b", at(rocks[1], 0), "p1", "builder");
    const [mId] = docked(r, "p1", "mining", st, 0);
    r.tryAutoMine("p1");
    expect(r.sim.ships.get(mId)!.autoMining).toBe(true);
    expect(r.activeShip.has("p1")).toBe(false);
    expect(r.waitingAt.get("p1")).toBe(st.id);
  });

  it("a estação onde o piloto espera explode: escape pod para a mais próxima", () => {
    const r = room();
    const q = hq(r, "p1", rocks[1]);
    const st = structure(r, "p1", "miningStation", rocks[0]);
    r.waitingAt.set("p1", st.id);
    r.destroyStructure(st.id);
    const pod = r.sim.ships.get(r.activeShip.get("p1")!)!;
    expect([pod.kind, pod.taxiTo]).toEqual(["pod", q.id]);
  });

  it("estação destruída com o jogador atracado: ele é expelido num pod", () => {
    const r = room();
    const q = hq(r, "p1", rocks[0]);
    const st = structure(r, "p1", "miningStation", rocks[1]);
    const [aId] = docked(r, "p1", "builder", st, 0);
    r.destroyStructure(st.id);
    expect(r.sim.ships.has(aId)).toBe(false);
    const pod = r.sim.ships.get(r.activeShip.get("p1")!)!;
    expect([pod.kind, pod.taxiTo]).toEqual(["pod", q.id]);
  });

  it("sem estação para onde o pod ir: fim de jogo", () => {
    const r = room();
    const st = structure(r, "p1", "miningStation", rocks[0]);
    const [, b] = docked(r, "p1", "builder", st, 0, false);
    Object.assign(b, { stored: true, anchored: false });
    r.waitingAt.set("p1", st.id);
    r.destroyStructure(st.id); // o builder do hangar vai junto; não sobra estrutura
    expect(r.state.players.get("p1")!.eliminated).toBe(true);
  });

  it("sem QG e sem builder: fim de jogo, mesmo com estação e outra nave; ruínas; recomeçar dá base nova", () => {
    const r = room();
    const base = structure(r, "p1", "initialBase", rocks[0]);
    r.turrets.set(base.id, 2);
    const [aId] = docked(r, "p1", "attack", base, BASE_EXPANDED_BAYS);
    run(r, 2);
    expect(r.state.players.get("p1")!.eliminated).toBe(true); // nunca teve QG nem builder
    expect(r.sim.ships.has(aId)).toBe(false);
    expect(r.activeShip.has("p1")).toBe(false);
    expect(base.owner).toBe(RUIN_OWNER);
    expect(r.turrets.has(base.id)).toBe(false);
    const p = r.state.players.get("p1")!;
    expect(JSON.parse(p.summary).ruins).toBe(1);
    // ruína: os bots caçam; jogadores não a atacam
    expect(r.raidTargetOf(makeShip(at(rocks[0], 3000), "", "attack"))?.id).toBe(base.id);
    const hostile = (r as unknown as { hostileStructure(a: string, st: Structure): boolean }).hostileStructure.bind(r);
    expect([hostile("", base), hostile("p2", base)]).toEqual([true, false]);

    r.restartPlayer("p1");
    expect(p.eliminated).toBe(false);
    expect(r.sim.ships.get(r.activeShip.get("p1")!)!.kind).toBe("builder");
    const own = [...r.sim.structures.values()].filter((st) => st.owner === "p1");
    expect(own.map((st) => st.type)).toEqual(["initialBase"]);
    expect(own[0].asteroidId).not.toBe(base.asteroidId); // a ruína continua ocupando o asteroide
    run(r, 1);
    expect(p.eliminated).toBe(false); // com builder, segue no jogo
  });

  it("o pod é intocável", () => {
    expect(hittableLevel(makeShip({ sx: 0, sy: 0, x: 0, y: 0 }, "p1", "pod"))).toBeNull();
  });
});
