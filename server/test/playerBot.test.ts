import { afterEach, describe, expect, it } from "vitest";
import {
  CERES_PLATFORM_PREFIX,
  HQ_EXPANDED_BAYS,
  HQ_SHIP_BAYS,
  asteroidClassOf,
  ceresPlatformPos,
  ceresPlatforms,
  structureMaxHp,
} from "@ceres/shared";
import { sectorAsteroids, setLayer, type Structure } from "@ceres/sim-core";
import type { ShipState, SimWorld } from "@ceres/sim-core";
import { MatchRoom } from "../src/rooms/MatchRoom";

// Jogador-bot (playerBot.ts): uma partida inteira jogada pelo servidor, em
// velocidade de teste 4x — constrói, minera, refina, abre rotas de transporte,
// fabrica naves (com aranha), põe turretas, evolui estação e drones, conserta,
// acorda o ninho de Ceres, caça a minhoca, tapa a toca e ataca o humano.
// Sala de verdade, sem rede.

const SEED = 4242;
const DT = 0.05;

const rooms: MatchRoom[] = [];
afterEach(() => {
  for (const room of rooms.splice(0)) room.clock.clear();
});

function makeRoom(playerBots = 1, bots = 0) {
  const room = new MatchRoom();
  (room as unknown as { listing: object }).listing = { metadata: {}, save: async () => {} };
  room.onCreate({ worldSeed: SEED, bots, maxPlayers: 4, playerBots, testSpeed: 4 });
  rooms.push(room);
  return room as unknown as {
    sim: SimWorld;
    freighters: Map<string, { mode: string }>;
    raiders: Map<string, { kind: string; target: string }>;
    activeShip: Map<string, string>;
    attackTargets: Map<string, { structId: string }>;
    bots: Map<string, unknown>;
    turrets: Map<string, number>;
    droneUpgrades: Map<string, Record<string, number>>;
    repairJobs: Map<string, unknown>;
    hole: unknown;
    quake: unknown;
    worms: Map<string, unknown>;
    state: { players: Map<string, { wormKills: number }> };
    tick(dt: number): void;
    addPlayer(sid: string, name: string): void;
  };
}

describe("jogador-bot", () => {
  it("joga a partida inteira", () => {
    const r = makeRoom();
    r.addPlayer("human", "Humano"); // fica parado: é o alvo das incursões
    const human = () => [...r.sim.structures.values()].filter((s) => s.owner === "human");
    const humanHp0 = human().reduce((a, s) => a + s.hp, 0);
    const mine = () => [...r.sim.structures.values()].filter((s) => s.owner === "pbot-1");
    const own = (t: string) => mine().filter((s) => s.type === t);
    const fleet = (k: string) => [...r.sim.ships.values()].filter((s: ShipState) => s.owner === "pbot-1" && s.kind === k);
    const turretsOn = (t: string) => own(t).some((s) => !s.asteroidId.startsWith(CERES_PLATFORM_PREFIX) && (r.turrets.get(s.id) ?? 0) > 0);
    const seen = new Map<string, number>();
    const mark = (k: string, ok: boolean, t: number) => { if (ok && !seen.has(k)) seen.set(k, Math.round(t)); };
    let hadHole = false;
    let damaged = false;
    for (let t = 0; t < 40 * 60; t += DT) {
      r.tick(DT);
      mark("estação", own("miningStation").length > 0, t);
      mark("QG", own("hq").length > 0, t);
      mark("central", own("rationCenter").length > 0, t);
      mark("rota minério", [...r.freighters.values()].some((f) => f.mode === "ore"), t);
      mark("rota rações", [...r.freighters.values()].some((f) => f.mode === "rations"), t);
      mark("aranha", fleet("mining").some((s) => s.autoMining), t);
      mark("3 naves de ataque", fleet("attack").length >= 3, t);
      mark("turreta no QG", turretsOn("hq"), t);
      mark("turreta na base", turretsOn("initialBase"), t);
      mark("turreta na estação", turretsOn("miningStation"), t);
      mark("estação nível 2+", own("miningStation").some((s) => !s.asteroidId.startsWith(CERES_PLATFORM_PREFIX) && s.level >= 2), t);
      mark("drones evoluídos", own("rationCenter").some((c) => Object.values(r.droneUpgrades.get(c.id) ?? {}).some((v) => v > 0)), t);
      mark("estação em Ceres", own("miningStation").some((s) => s.asteroidId.startsWith(CERES_PLATFORM_PREFIX)), t);
      mark("tremores", !!r.quake, t);
      if (r.hole) hadHole = true;
      mark("toca aberta", !!r.hole, t);
      mark("caça à minhoca", [...r.raiders.values()].some((m) => m.kind === "worm"), t);
      mark("tapando a toca", [...r.raiders.values()].some((m) => m.kind === "seal"), t);
      mark("toca tapada", hadHole && !r.hole, t);
      mark("incursão", [...r.raiders.values()].some((m) => m.kind === "raid"), t);
      mark("dano no humano", human().reduce((a, s) => a + s.hp, 0) < humanHp0, t);
      // um dano forçado no QG do bot, para ver o conserto
      const hq = own("hq")[0];
      if (hq && seen.has("turreta no QG") && !damaged) {
        damaged = true;
        hq.hp = structureMaxHp("hq", hq.level) * 0.3;
      }
      mark("conserto", r.repairJobs.size > 0, t);
      if (seen.size >= 22) break;
    }
    console.log("[marcos]", JSON.stringify(Object.fromEntries(seen)));
    for (const k of [
      "estação", "QG", "central", "rota minério", "rota rações", "aranha", "3 naves de ataque",
      "turreta no QG", "turreta na base", "turreta na estação", "estação nível 2+", "drones evoluídos", "conserto",
      // tapar a toca depende de a ala sobreviver à minhoca (às vezes ela devasta
      // a frota): coberto à parte, em "a ala tapa a toca", sem sorteio
      "estação em Ceres", "tremores", "toca aberta", "caça à minhoca",
      "incursão", "dano no humano",
    ]) {
      expect(seen.has(k), k).toBe(true);
    }
  }, 600_000);

  it("pilota uma nave só (o builder); as naves de ataque agem sozinhas", () => {
    const r = makeRoom();
    r.addPlayer("human", "Humano");
    let ok = true;
    let attacks = 0;
    for (let t = 0; t < 200; t += DT) {
      r.tick(DT);
      const active = r.sim.ships.get(r.activeShip.get("pbot-1") ?? "");
      if (active && active.kind !== "builder") ok = false;
      attacks = Math.max(attacks, [...r.raiders.keys()].filter((id) => r.sim.ships.get(id)?.owner === "pbot-1").length);
    }
    expect(ok).toBe(true);
    expect(attacks).toBeGreaterThan(0); // saíram sem ninguém pilotá-las
  }, 120_000);

  it("os jogadores-bot se enfrentam", () => {
    const r = makeRoom(2);
    const owner = (id: string) => r.sim.structures.get(id)?.owner ?? "";
    const hp0 = new Map([...r.sim.structures.values()].map((s) => [s.id, s.hp]));
    let raid = "";
    let hit = false;
    for (let t = 0; t < 15 * 60 && !(raid && hit); t += DT) {
      r.tick(DT);
      for (const [id, m] of r.raiders) {
        const by = r.sim.ships.get(id)?.owner ?? "";
        const victim = owner(m.target);
        if (m.kind === "raid" && by.startsWith("pbot-") && victim.startsWith("pbot-") && victim !== by) raid = `${by} → ${victim}`;
      }
      for (const s of r.sim.structures.values()) {
        if (s.owner.startsWith("pbot-") && hp0.has(s.id) && s.hp < hp0.get(s.id)!) hit = true;
      }
      for (const s of r.sim.structures.values()) if (!hp0.has(s.id)) hp0.set(s.id, s.hp);
    }
    console.log("[rivais]", raid);
    expect(raid).not.toBe("");
    expect(hit).toBe(true);
  }, 300_000);

  it("a frota neutra de Ceres ataca também os jogadores-bot", () => {
    const r = makeRoom(1, 6);
    let target = "";
    for (let t = 0; t < 10 * 60 && !target; t += DT) {
      r.tick(DT);
      for (const [id, at] of r.attackTargets) {
        if (!r.bots.has(id)) continue;
        const owner = r.sim.structures.get(at.structId)?.owner ?? "";
        if (owner.startsWith("pbot-")) target = owner;
      }
    }
    expect(target).toBe("pbot-1");
  }, 300_000);

  it("a ala tapa a toca: com a minhoca descansando, uma nave pronta lança as minas e um míssil", () => {
    const r = makeRoom();
    // um QG do bot numa rocha, com uma nave de ataque pronta no hangar
    const rock = [...sectorAsteroids(SEED, 0, 0)].sort((a, b) => b.radius - a.radius)[0];
    const pads = ceresPlatforms(SEED);
    const near = [...r.sim.structures.values()].find((x) => x.owner === "pbot-1")!;
    const hqRock = [...sectorAsteroids(SEED, near.sx, near.sy)].filter((a) => a.id !== near.asteroidId)
      .sort((a, b) => b.radius - a.radius)[0] ?? rock;
    const hq = r.sim.addStructure({
      id: "st-hq-test", type: "hq", owner: "pbot-1", angle: 0,
      sx: hqRock.sx, sy: hqRock.sy, x: hqRock.x, y: hqRock.y,
      asteroidId: hqRock.id, asteroidClass: asteroidClassOf(hqRock.radius),
      shipBays: HQ_SHIP_BAYS, expandedBays: HQ_EXPANDED_BAYS,
      spiderBays: 0, nextShipBay: 0, nextSpiderBay: 0, oreStore: 0, rationStore: 100,
    });
    const atk = r.sim.addShip("atk", hq, "pbot-1", "attack");
    Object.assign(atk, { stored: true, hqId: hq.id, bay: 0 });
    // a toca aberta numa plataforma, a minhoca dentro (nenhuma fora) e uma já morta
    const pad = pads[2];
    Object.assign(r, { hole: { padId: pad.id, pos: ceresPlatformPos(SEED, pad), radius: pad.radius, seal: 0 }, nestTimer: 1e9 });
    r.state.players.get("pbot-1")!.wormKills = 1;
    let launched = false;
    for (let t = 0; t < 240 && r.hole; t += DT) {
      r.tick(DT);
      if (r.raiders.get("atk")?.kind === "seal") launched = true;
    }
    expect(launched).toBe(true);
    expect(r.hole).toBeNull();
  }, 120_000);

  /** Um QG do bot numa rocha perto da base dele, com 3 naves de ataque prontas no hangar. */
  function botHq(r: ReturnType<typeof makeRoom>): Structure {
    const base = [...r.sim.structures.values()].find((x) => x.owner === "pbot-1" && x.type === "initialBase")!;
    const rock = [...sectorAsteroids(SEED, base.sx, base.sy)].filter((a) => a.id !== base.asteroidId)
      .sort((a, b) => b.radius - a.radius)[0];
    const hq = r.sim.addStructure({
      id: "st-hq-test", type: "hq", owner: "pbot-1", angle: 0,
      sx: rock.sx, sy: rock.sy, x: rock.x, y: rock.y,
      asteroidId: rock.id, asteroidClass: asteroidClassOf(rock.radius),
      shipBays: HQ_SHIP_BAYS, expandedBays: HQ_EXPANDED_BAYS,
      spiderBays: 0, nextShipBay: 0, nextSpiderBay: 0, oreStore: 0, rationStore: 100,
    });
    for (let k = 0; k < 3; k++) {
      const a = r.sim.addShip(`atk${k}`, hq, "pbot-1", "attack");
      Object.assign(a, { stored: true, hqId: hq.id, bay: k });
    }
    return hq;
  }

  it("a ala DEFENDE primeiro: a nave inimiga atacando a base do bot é caçada", () => {
    const r = makeRoom();
    r.addPlayer("human", "Humano");
    botHq(r);
    const base = [...r.sim.structures.values()].find((x) => x.owner === "pbot-1" && x.type === "initialBase")!;
    const rock = [...sectorAsteroids(SEED, base.sx, base.sy)].find((a) => a.id === base.asteroidId)!;
    // a nave inimiga em MODO ATAQUE sobre a base do bot
    const enemy = r.sim.addShip("enemy", { sx: base.sx, sy: base.sy, x: base.x + rock.radius + 100, y: base.y }, "human", "attack");
    setLayer(enemy, "attack");
    r.attackTargets.set("enemy", { structId: base.id, radius: rock.radius } as never);
    let defended = false;
    for (let t = 0; t < 120 && r.sim.ships.has("enemy"); t += DT) {
      r.tick(DT);
      if ([...r.raiders.values()].some((m) => m.kind === "defend" && m.target === "enemy")) defended = true;
    }
    expect(defended).toBe(true);
    expect(!r.sim.ships.has("enemy") || enemy.hp < 100).toBe(true);
  }, 120_000);

  it("em segundo plano, a nave inimiga mais perto que qualquer estrutura inimiga é caçada", () => {
    const r = makeRoom();
    const hq = botHq(r);
    // nenhuma estrutura inimiga; uma nave inimiga voando no cruzeiro perto do QG
    const enemy = r.sim.addShip("enemy", { sx: hq.sx, sy: hq.sy, x: hq.x + 6000, y: hq.y }, "human", "attack");
    let hunted = false;
    for (let t = 0; t < 120 && r.sim.ships.has("enemy") && enemy.hp >= 100; t += DT) {
      r.tick(DT);
      if ([...r.raiders.values()].some((m) => m.kind === "hunt" && m.target === "enemy")) hunted = true;
    }
    expect(hunted).toBe(true);
    expect(!r.sim.ships.has("enemy") || enemy.hp < 100).toBe(true);
  }, 120_000);
});
