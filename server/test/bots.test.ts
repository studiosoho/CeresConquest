import { afterEach, describe, expect, it } from "vitest";
import {
  CERES_PLATFORM_PREFIX,
  MISSILE_DAMAGE,
  SHIP_HP_MAX,
  STATION_EXPANDED_BAYS,
  STATION_SHIP_BAYS,
  STATION_SPIDER_BAYS,
  STRUCTURE_SPECS,
  TURRET_MAX,
  asteroidClassOf,
  ceresPosition,
  type WorldPos,
} from "@ceres/shared";
import { sectorAsteroids, setLayer, type Asteroid, type ShipState, type SimWorld, type Structure } from "@ceres/sim-core";
import { MatchRoom } from "../src/rooms/MatchRoom";
import { BOT_AMMO, BOT_BUILD_INTERVAL, BOT_FLEET_MAX, BOT_OWNER, BOT_RELOAD_TIME, BOT_WAVE_SIZE, type BotState } from "../src/bots";

// Frota dos bots (bots.ts): QG em Ceres que produz um bot a cada
// BOT_BUILD_INTERVAL até BOT_FLEET_MAX; cada bot ataca com BOT_AMMO mísseis,
// volta ao QG e recarrega em BOT_RELOAD_TIME. Sala de verdade, sem rede.

const SEED = 4242;
const DT = 0.05;
const CERES = ceresPosition(SEED);
const sector = { sx: CERES.sx - 4, sy: CERES.sy };
const rocks = [...sectorAsteroids(SEED, sector.sx, sector.sy)].sort((a, b) => b.radius - a.radius);

const rooms: MatchRoom[] = [];
afterEach(() => {
  for (const room of rooms.splice(0)) room.clock.clear();
});

function makeRoom(bots: number) {
  const room = new MatchRoom();
  (room as unknown as { listing: object }).listing = { metadata: {}, save: async () => {} };
  room.onCreate({ worldSeed: SEED, bots, maxPlayers: 4 });
  rooms.push(room);
  return room as unknown as {
    sim: SimWorld;
    bots: Map<string, BotState>;
    botHqId: string;
    turrets: Map<string, number>;
    attackTargets: Map<string, { structId: string; radius: number }>;
    tick(dt: number): void;
    spawnBot(): string | null;
    destroyStructure(id: string): void;
  };
}
type R = ReturnType<typeof makeRoom>;

const run = (r: R, seconds: number, dt = DT) => {
  for (let i = 0; i < Math.round(seconds / dt); i++) r.tick(dt);
};
/** Roda até `cond` (ou estourar `limit` s); devolve o tempo gasto. */
const until = (r: R, cond: () => boolean, limit: number): number => {
  let t = 0;
  while (!cond() && t < limit) { r.tick(DT); t += DT; }
  return t;
};
const at = (p: WorldPos, dx: number, dy = 0): WorldPos => ({ sx: p.sx, sy: p.sy, x: p.x + dx, y: p.y + dy });

function station(r: R, owner: string, ast: Asteroid): Structure {
  return r.sim.addStructure({
    id: `st-test-${ast.id}`, type: "miningStation", owner, angle: 0.7,
    sx: ast.sx, sy: ast.sy, x: ast.x, y: ast.y,
    asteroidId: ast.id, asteroidClass: asteroidClassOf(ast.radius),
    shipBays: STATION_SHIP_BAYS, expandedBays: STATION_EXPANDED_BAYS,
    spiderBays: STATION_SPIDER_BAYS[asteroidClassOf(ast.radius)],
    nextShipBay: 0, nextSpiderBay: 0, oreStore: 0, rationStore: 0,
  });
}

describe("QG dos bots", () => {
  it("fica numa plataforma de Ceres e é dos bots; sem frota, não existe", () => {
    const r = makeRoom(BOT_FLEET_MAX);
    const hq = r.sim.structures.get(r.botHqId)!;
    expect(hq.type).toBe("hq");
    expect(hq.owner).toBe(BOT_OWNER);
    expect(hq.asteroidId.startsWith(CERES_PLATFORM_PREFIX)).toBe(true);
    expect(r.bots.size).toBe(0); // a partida começa sem bots

    const empty = makeRoom(0);
    expect(empty.botHqId).toBe("");
    expect(empty.sim.structures.size).toBe(0);
  });

  it("produz um bot a cada 2 minutos, atracado e armado, até 6", () => {
    const r = makeRoom(BOT_FLEET_MAX);
    run(r, BOT_BUILD_INTERVAL - 1, 0.1);
    expect(r.bots.size).toBe(0);
    run(r, 2, 0.1);
    expect(r.bots.size).toBe(1);
    const [first] = [...r.bots.keys()];
    const s = r.sim.ships.get(first)!;
    expect([s.anchored, s.hqId, s.ammo, s.owner]).toEqual([true, r.botHqId, BOT_AMMO, BOT_OWNER]);

    run(r, BOT_BUILD_INTERVAL * (BOT_FLEET_MAX - 1), 0.1);
    expect(r.bots.size).toBe(BOT_FLEET_MAX);
    run(r, BOT_BUILD_INTERVAL * 2, 0.1);
    expect(r.bots.size).toBe(BOT_FLEET_MAX); // vagas cheias: não passa de 6
    // sem estrutura de jogador para atacar, todos esperam nas vagas
    const bays = [...r.bots.keys()].map((id) => r.sim.ships.get(id)!).filter((b) => b.anchored).map((b) => b.bay);
    expect(new Set(bays).size).toBe(BOT_FLEET_MAX);
  });

  it("perdido um bot, outro sai 2 minutos depois", () => {
    const r = makeRoom(2);
    const a = r.spawnBot()!;
    r.spawnBot();
    run(r, 1);
    r.sim.removeShip(a);
    r.bots.delete(a);
    run(r, BOT_BUILD_INTERVAL - 1, 0.1);
    expect(r.bots.size).toBe(1);
    run(r, 2, 0.1);
    expect(r.bots.size).toBe(2);
  });

  it("QG destruído: a produção para", () => {
    const r = makeRoom(BOT_FLEET_MAX);
    r.destroyStructure(r.botHqId);
    expect(r.botHqId).toBe("");
    run(r, BOT_BUILD_INTERVAL + 5, 0.1);
    expect(r.bots.size).toBe(0);
  });
});

describe("ciclo do bot", () => {
  it("sozinhos ou em dupla, os bots esperam no QG; o 3º pronto lança o grupo inteiro", () => {
    const r = makeRoom(BOT_FLEET_MAX);
    station(r, "p1", rocks[0]);
    const first = [r.spawnBot()!, r.spawnBot()!];
    run(r, 5);
    for (const id of first) expect(r.sim.ships.get(id)!.anchored).toBe(true);
    const third = r.spawnBot()!;
    r.tick(DT);
    for (const id of [...first, third]) {
      expect(r.sim.ships.get(id)!.anchored).toBe(false); // saíram no mesmo tick
      expect(r.bots.get(id)!.phase).toBe("raid");
    }
  });

  it("com 4 prontos, saem só 3 — o 4º espera o próximo grupo", () => {
    const r = makeRoom(BOT_FLEET_MAX);
    // produzidos sem alvo: ficam todos nas vagas
    const ids = [0, 1, 2, 3].map(() => r.spawnBot()!);
    run(r, 1);
    station(r, "p1", rocks[0]);
    r.tick(DT);
    const out = ids.filter((id) => !r.sim.ships.get(id)!.anchored);
    expect(out.length).toBe(BOT_WAVE_SIZE);
  });

  it("o grupo ataca com 2 mísseis cada, volta, recarrega em 30 s e sai de novo junto", () => {
    const r = makeRoom(BOT_FLEET_MAX);
    const st = station(r, "p1", rocks[0]);
    const ids = [r.spawnBot()!, r.spawnBot()!, r.spawnBot()!];
    const bots = ids.map((id) => r.sim.ships.get(id)!);
    const [id, bot] = [ids[0], bots[0]];
    const state = r.bots.get(id)!;

    expect(until(r, () => r.attackTargets.get(id)?.structId === st.id, 120)).toBeLessThan(120);
    expect(until(r, () => bots.every((b) => b.ammo === 0), 30)).toBeLessThan(30);
    run(r, 1.5); // os últimos mísseis ainda em voo
    expect(st.hp).toBe(STRUCTURE_SPECS.miningStation.hp - BOT_WAVE_SIZE * BOT_AMMO * MISSILE_DAMAGE);

    // voltam e pousam nas vagas do QG — sem recarregar na hora
    expect(until(r, () => bot.anchored && bot.hqId === r.botHqId, 150)).toBeLessThan(150);
    expect(state.phase).toBe("reload");
    expect(bot.ammo).toBe(0);
    run(r, BOT_RELOAD_TIME - 1);
    expect(bot.ammo).toBe(0);
    // recarregados, saem de novo — os três no mesmo instante
    expect(until(r, () => bots.some((b) => !b.anchored && b.ammo === BOT_AMMO), 60)).toBeLessThan(60);
    expect(bots.every((b) => !b.anchored && b.ammo === BOT_AMMO)).toBe(true);
  });

  it("as turretas da estação atingem o bot em modo ataque", () => {
    const r = makeRoom(1);
    const rock = rocks[0];
    const st = station(r, "p1", rock);
    r.turrets.set(st.id, TURRET_MAX);
    const id = r.spawnBot()!;
    const bot = r.sim.ships.get(id)!;
    // tirado do QG e posto perto da estação, em cruzeiro
    Object.assign(bot, at(rock, rock.radius + 2500), { vx: 0, vy: 0, anchored: false, hqId: "", bay: -1 });
    setLayer(bot, "cruise");
    r.bots.get(id)!.phase = "raid";
    expect(until(r, () => r.attackTargets.has(id), 20)).toBeLessThan(20);
    run(r, 4);
    expect(r.sim.ships.get(id)?.hp ?? 0).toBeLessThan(SHIP_HP_MAX);
  });
});

/** Bots não recarregam pela regra dos jogadores (120 mísseis ao atracar). */
describe("pouso de bot no QG", () => {
  it("não enche a munição de jogador", () => {
    const r = makeRoom(1);
    const id = r.spawnBot()!;
    const bot: ShipState = r.sim.ships.get(id)!;
    expect(bot.ammo).toBe(BOT_AMMO);
  });
});
