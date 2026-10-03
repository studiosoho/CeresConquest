import { afterEach, describe, expect, it } from "vitest";
import { REFINE_KITS, REFINE_ORE, REFINE_TIME, SCORE_POINTS, WORM_HP, type VictoryMode } from "@ceres/shared";
import type { ShipState, SimWorld } from "@ceres/sim-core";
import { MatchRoom } from "../src/rooms/MatchRoom";

// Partida (shared/match.ts): placar, abates e o fim por modo de vitória.

const SEED = 4242;
const DT = 0.05;

const rooms: MatchRoom[] = [];
afterEach(() => {
  for (const room of rooms.splice(0)) room.clock.clear();
});

function makeRoom(victory: VictoryMode, timeLimit = 1) {
  const room = new MatchRoom();
  (room as unknown as { listing: object }).listing = { metadata: {}, save: async () => {} };
  room.onCreate({ worldSeed: SEED, bots: 0, maxPlayers: 4, victory, timeLimit });
  rooms.push(room);
  return room as unknown as {
    sim: SimWorld;
    state: {
      victory: string; timeLimit: number; finished: boolean; winner: string;
      players: Map<string, { score: number; wormKills: number; eliminated: boolean }>;
    };
    activeShip: Map<string, string>;
    tick(dt: number): void;
    addPlayer(sid: string, name: string): void;
    tryCargo(sid: string): void;
    spawnWorm(): string;
    damageWorm(id: string, damage: number, at?: unknown, attacker?: string): void;
    eliminatePlayer(sid: string): void;
  };
}
type R = ReturnType<typeof makeRoom>;
const run = (r: R, s: number) => { for (let i = 0; i < Math.round(s / DT); i++) r.tick(DT); };
const builder = (r: R, sid: string): ShipState => r.sim.ships.get(r.activeShip.get(sid)!)!;

describe("placar", () => {
  it("kits refinados e minhoca morta pontuam; a minhoca conta para quem deu o golpe final", () => {
    const r = makeRoom("score", 30);
    r.addPlayer("p1", "Um");
    const b = builder(r, "p1");
    Object.assign(b, { cargoKind: "ore", cargoAmount: REFINE_ORE });
    r.tryCargo("p1");
    run(r, REFINE_TIME + 0.2);
    const p = r.state.players.get("p1")!;
    expect(p.score).toBe(REFINE_KITS * SCORE_POINTS.kit);
    const w = r.spawnWorm();
    r.damageWorm(w, WORM_HP, undefined, r.activeShip.get("p1"));
    expect(p.wormKills).toBe(1);
    expect(p.score).toBe(REFINE_KITS * SCORE_POINTS.kit + SCORE_POINTS.wormKilled);
  });
});

describe("modos de vitória", () => {
  it("pontuação: no fim do tempo vence o maior placar, e o placar congela", () => {
    const r = makeRoom("score", 1);
    r.addPlayer("p1", "Um");
    r.addPlayer("p2", "Dois");
    expect(r.state.timeLimit).toBe(60);
    r.state.players.get("p2")!.score = 500;
    run(r, 59);
    expect(r.state.finished).toBe(false);
    run(r, 2);
    expect([r.state.finished, r.state.winner]).toEqual([true, "p2"]);
  });

  it("caça às minhocas: vence quem matou mais (empate: pontos)", () => {
    const r = makeRoom("worms", 1);
    r.addPlayer("p1", "Um");
    r.addPlayer("p2", "Dois");
    r.state.players.get("p1")!.wormKills = 2;
    r.state.players.get("p2")!.wormKills = 1;
    r.state.players.get("p2")!.score = 9999;
    run(r, 61);
    expect(r.state.winner).toBe("p1");
  });

  it("último de pé: sem tempo; vence quem sobra", () => {
    const r = makeRoom("lastStand");
    r.addPlayer("p1", "Um");
    r.addPlayer("p2", "Dois");
    expect(r.state.timeLimit).toBe(0);
    run(r, 5);
    expect(r.state.finished).toBe(false);
    r.eliminatePlayer("p1");
    r.tick(DT);
    expect([r.state.finished, r.state.winner]).toEqual([true, "p2"]);
  });
});
