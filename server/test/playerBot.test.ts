import { afterEach, describe, expect, it } from "vitest";
import { CERES_PLATFORM_PREFIX, structureMaxHp } from "@ceres/shared";
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

function makeRoom() {
  const room = new MatchRoom();
  (room as unknown as { listing: object }).listing = { metadata: {}, save: async () => {} };
  room.onCreate({ worldSeed: SEED, bots: 0, maxPlayers: 4, playerBots: 1, testSpeed: 4 });
  rooms.push(room);
  return room as unknown as {
    sim: SimWorld;
    freighters: Map<string, { mode: string }>;
    raiders: Map<string, { kind: string }>;
    turrets: Map<string, number>;
    droneUpgrades: Map<string, Record<string, number>>;
    repairJobs: Map<string, unknown>;
    hole: unknown;
    quake: unknown;
    worms: Map<string, unknown>;
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
      "estação em Ceres", "tremores", "toca aberta", "caça à minhoca", "tapando a toca", "toca tapada",
      "incursão", "dano no humano",
    ]) {
      expect(seen.has(k), k).toBe(true);
    }
  }, 600_000);
});
