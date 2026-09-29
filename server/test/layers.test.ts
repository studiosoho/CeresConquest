import { afterEach, describe, expect, it } from "vitest";
import {
  CERES_RADIUS,
  DOCK_RANGE,
  HQ_EXPANDED_BAYS,
  HQ_SHIP_BAYS,
  LAYER_TRANSITION_TIME,
  SHIP_RADIUS,
  STATION_EXPANDED_BAYS,
  STATION_SHIP_BAYS,
  STATION_SPIDER_BAYS,
  asteroidClassOf,
  bayLayout,
  bayWorldPos,
  ceresPosition,
  dist,
  relVec,
  type ShipKind,
  type StructureType,
  type WorldPos,
} from "@ceres/shared";
import { sectorAsteroids, type Asteroid, type ShipState, type SimWorld, type Structure } from "@ceres/sim-core";
import { MatchRoom } from "../src/rooms/MatchRoom";

// Regras de camada e pouso na vaga do servidor (passo 3 das camadas), pelo
// caminho REAL: a sala de verdade, sem rede — as mensagens chamam os mesmos
// métodos que os handlers do Colyseus, e o tempo anda por `tick`.

const SEED = 4242;
const DT = 0.05;
/**
 * Setor de teste: DENTRO da arena (a fronteira é centrada em Ceres, com raio
 * de 8 setores no mapa pequeno — fora dela a contenção arremessa a nave) e no
 * cinturão, onde há rochas — Ceres tem raio de 2 setores e não tem rochas por perto.
 */
const CERES = ceresPosition(SEED);
const testSector = { sx: CERES.sx - 4, sy: CERES.sy };

/** Sala sem bots e sem rede; `r` expõe os privados que os testes dirigem. */
function makeRoom() {
  const room = new MatchRoom();
  // sem matchmaker não há registro de sala: o título do lobby vai para um
  // registro de mentira
  (room as unknown as { listing: object }).listing = { metadata: {}, save: async () => {} };
  room.onCreate({ worldSeed: SEED, bots: 0, maxPlayers: 4 });
  const r = room as unknown as {
    sim: SimWorld;
    activeShip: Map<string, string>;
    tick(dt: number): void;
    tryToggleAnchor(sid: string): void;
    trySwap(sid: string): void;
    tryLandAction(sid: string, action?: string): void;
    firstFreeShipBay(st: Structure, kind: ShipKind): number;
  };
  rooms.push(room);
  return { room, r };
}
const rooms: MatchRoom[] = [];
afterEach(() => {
  for (const room of rooms.splice(0)) room.clock.clear();
});

let shipSeq = 0;
/** Nave do jogador `owner`, parada em `pos`, já pilotada por ele. */
function pilot(r: ReturnType<typeof makeRoom>["r"], owner: string, kind: ShipKind, pos: WorldPos): ShipState {
  const id = `t${shipSeq++}`;
  const s = r.sim.addShip(id, pos, owner, kind);
  r.activeShip.set(owner, id);
  return s;
}

/** Estrutura de `owner` no asteroide `ast`, com a frente para `angle`. */
function build(r: ReturnType<typeof makeRoom>["r"], owner: string, ast: Asteroid, type: StructureType = "miningStation", angle = 0.7): Structure {
  const hq = type === "hq";
  const st: Structure = {
    id: `st-${ast.id}`, type, owner, angle,
    sx: ast.sx, sy: ast.sy, x: ast.x, y: ast.y,
    asteroidId: ast.id, asteroidClass: asteroidClassOf(ast.radius),
    shipBays: hq ? HQ_SHIP_BAYS : STATION_SHIP_BAYS,
    expandedBays: hq ? HQ_EXPANDED_BAYS : STATION_EXPANDED_BAYS,
    spiderBays: hq ? 0 : STATION_SPIDER_BAYS[asteroidClassOf(ast.radius)],
    nextShipBay: 0, nextSpiderBay: 0, oreStore: 0, rationStore: 0,
  };
  r.sim.addStructure(st);
  return st;
}

const run = (r: ReturnType<typeof makeRoom>["r"], seconds: number) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) r.tick(DT);
};

/** Rochas do setor do cinturão, maiores primeiro (sobra espaço para vagas). */
const rocks = [...sectorAsteroids(SEED, testSector.sx, testSector.sy)].sort((a, b) => b.radius - a.radius);
/** Ponto logo acima (em cruzeiro) do centro de uma rocha. */
const over = (a: Asteroid): WorldPos => ({ sx: a.sx, sy: a.sy, x: a.x + 5, y: a.y });
/** Ponto na borda de pouso de uma rocha (dentro do DOCK_RANGE, fora dela). */
const beside = (a: Asteroid): WorldPos => ({ sx: a.sx, sy: a.sy, x: a.x + a.radius + DOCK_RANGE * 0.5, y: a.y });
/** Espaço aberto: longe de qualquer rocha do setor. */
function openSpace(): WorldPos {
  for (let x = 500; x < 10_000; x += 250) {
    for (let y = 500; y < 10_000; y += 250) {
      const p = { ...testSector, x, y };
      if (rocks.every((a) => dist(p, a) > a.radius + 600)) return p;
    }
  }
  throw new Error("setor sem espaço aberto");
}
const samePos = (a: WorldPos, b: WorldPos) => {
  expect(a.sx).toBe(b.sx);
  expect(a.sy).toBe(b.sy);
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
};

describe("geometria das vagas (shared/bays.ts)", () => {
  it("a fileira é centrada, na ordem dos índices, expandidas primeiro, sem sobreposição", () => {
    const slots = bayLayout({ type: "hq", shipBays: HQ_SHIP_BAYS, expandedBays: HQ_EXPANDED_BAYS });
    expect(slots.length).toBe(HQ_SHIP_BAYS);
    expect(slots.filter((s) => s.expanded).length).toBe(HQ_EXPANDED_BAYS);
    expect(slots.slice(0, HQ_EXPANDED_BAYS).every((s) => s.expanded)).toBe(true);
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].x - slots[i].w / 2).toBeGreaterThan(slots[i - 1].x + slots[i - 1].w / 2);
    }
    const left = slots[0].x - slots[0].w / 2;
    const right = slots[slots.length - 1].x + slots[slots.length - 1].w / 2;
    expect(left + right).toBeCloseTo(0, 9);
  });

  it("toda vaga fica à FRENTE da estrutura, na direção de `angle`, fora do prédio", () => {
    const host = { type: "hq" as const, shipBays: HQ_SHIP_BAYS, expandedBays: HQ_EXPANDED_BAYS, sx: 3, sy: 4, x: 5000, y: 5000 };
    for (const angle of [0, 1, 2.5, -2]) {
      for (let i = 0; i < HQ_SHIP_BAYS; i++) {
        const p = bayWorldPos({ ...host, angle }, i)!;
        const { dx, dy } = relVec(host, p);
        expect(dx * Math.cos(angle) + dy * Math.sin(angle)).toBeGreaterThan(6 * SHIP_RADIUS);
      }
    }
    expect(bayWorldPos({ ...host, angle: 0 }, HQ_SHIP_BAYS)).toBeNull();
  });
});

describe("descer e subir com [F]", () => {
  it("no espaço aberto desce à superfície em LAYER_TRANSITION_TIME e sobe de volta", () => {
    const { r } = makeRoom();
    const s = pilot(r, "p1", "attack", openSpace());
    r.tryToggleAnchor("p1");
    expect(s.layerTo).toBe("surface");
    run(r, LAYER_TRANSITION_TIME + DT);
    expect(s.layer).toBe("surface");
    expect(s.layerTo).toBe("");
    r.tryToggleAnchor("p1");
    expect(s.layerTo).toBe("cruise");
    run(r, LAYER_TRANSITION_TIME + DT);
    expect(s.layer).toBe("cruise");
  });

  it("não troca de camada no meio de uma transição", () => {
    const { r } = makeRoom();
    const s = pilot(r, "p1", "attack", openSpace());
    r.tryToggleAnchor("p1");
    run(r, LAYER_TRANSITION_TIME / 2);
    r.tryToggleAnchor("p1");
    expect(s.layerTo).toBe("surface");
  });

  it("sobre Ceres ninguém desce", () => {
    const { r } = makeRoom();
    const s = pilot(r, "p1", "builder", { ...CERES, x: CERES.x + CERES_RADIUS * 0.5 });
    r.tryToggleAnchor("p1");
    expect(s.layer).toBe("cruise");
    expect(s.layerTo).toBe("");
    expect(s.landingPhase).toBe("");
  });

  it("sobre asteroide vazio: ataque e transporte não descem", () => {
    const { r } = makeRoom();
    for (const kind of ["attack", "transport"] as const) {
      const s = pilot(r, "p1", kind, over(rocks[0]));
      r.tryToggleAnchor("p1");
      expect(s.layerTo).toBe("");
      expect(s.landingPhase).toBe("");
    }
  });

  it("sobre asteroide vazio: builder e mineração pousam no CENTRO, na superfície", () => {
    const { r } = makeRoom();
    for (const kind of ["builder", "mining"] as const) {
      const s = pilot(r, "p1", kind, over(rocks[1]));
      r.tryToggleAnchor("p1");
      expect(s.landingPhase).toBe("landing");
      expect(s.layerTo).toBe("surface");
      run(r, 1.6);
      expect(s.landingPhase).toBe("landed");
      expect(s.layer).toBe("surface");
      samePos(s, rocks[1]);
      r.tryToggleAnchor("p1"); // pousada: [F] decola
      expect(s.landingPhase).toBe("");
      expect(s.layerTo).toBe("cruise");
    }
  });
});

describe("pouso na vaga livre", () => {
  it("[F] perto da estação própria pousa EXATAMENTE no centro da primeira vaga livre", () => {
    const { r } = makeRoom();
    const st = build(r, "p1", rocks[0]);
    const s = pilot(r, "p1", "builder", beside(rocks[0]));
    r.tryToggleAnchor("p1");
    expect(s.landingPhase).toBe("landing");
    expect(s.bay).toBe(0);
    run(r, 1.6);
    expect(s.anchored).toBe(true);
    expect(s.landingPhase).toBe("");
    expect(s.layer).toBe("surface");
    expect(s.layerTo).toBe("");
    expect(s.angle).toBe(st.angle);
    samePos(s, bayWorldPos(st, 0)!);
  });

  it("naves seguidas ocupam vagas diferentes; sem vaga compatível, não pousa", () => {
    const { r } = makeRoom();
    const st = build(r, "p1", rocks[0]); // estação: só vagas expandidas
    const placed: ShipState[] = [];
    for (let i = 0; i < STATION_EXPANDED_BAYS; i++) {
      const s = pilot(r, "p1", "mining", beside(rocks[0]));
      r.tryToggleAnchor("p1");
      expect(s.bay).toBe(i);
      placed.push(s);
    }
    run(r, 1.6);
    placed.forEach((s, i) => samePos(s, bayWorldPos(st, i)!));
    const extra = pilot(r, "p1", "builder", beside(rocks[0]));
    r.tryToggleAnchor("p1");
    expect(extra.landingPhase).toBe("");
    expect(extra.anchored).toBe(false);
  });

  it("a vaga reservada pelo pouso em andamento não é dada a outra nave", () => {
    const { r } = makeRoom();
    const st = build(r, "p1", rocks[0]);
    const a = pilot(r, "p1", "builder", beside(rocks[0]));
    r.tryToggleAnchor("p1");
    expect(r.firstFreeShipBay(st, "builder")).toBe(1);
    expect(a.bay).toBe(0);
  });

  it("decolar libera a vaga e sobe ao cruzeiro, sem colidir com o asteroide", () => {
    const { r } = makeRoom();
    const st = build(r, "p1", rocks[0]);
    const s = pilot(r, "p1", "builder", beside(rocks[0]));
    r.tryToggleAnchor("p1");
    run(r, 1.6);
    r.tryToggleAnchor("p1");
    expect(s.anchored).toBe(false);
    expect(s.bay).toBe(-1);
    expect(s.layerTo).toBe("cruise");
    expect(r.firstFreeShipBay(st, "builder")).toBe(0);
    run(r, LAYER_TRANSITION_TIME + DT);
    expect(s.layer).toBe("cruise");
  });

  it("[F] sobre a estação própria lotada desce à superfície (o asteroide próprio é atravessável)", () => {
    const { r } = makeRoom();
    const st = build(r, "p1", rocks[0]);
    const s = pilot(r, "p1", "builder", over(rocks[0]));
    r.tryToggleAnchor("p1");
    expect(s.landingPhase).toBe("landing");
    run(r, 1.6);
    samePos(s, bayWorldPos(st, 0)!);
    pilot(r, "p1", "builder", beside(rocks[0]));
    r.tryToggleAnchor("p1");
    const third = pilot(r, "p1", "builder", over(rocks[0]));
    r.tryToggleAnchor("p1");
    expect(third.landingPhase).toBe("");
    expect(third.layerTo).toBe("surface");
  });

  it("trocar de nave deixa cada uma na PRÓPRIA vaga", () => {
    const { r } = makeRoom();
    const st = build(r, "p1", rocks[0]);
    const b = pilot(r, "p1", "builder", beside(rocks[0]));
    r.tryToggleAnchor("p1");
    run(r, 1.6);
    const bId = r.activeShip.get("p1")!;
    const m = r.sim.addShip("guardada", rocks[0], "p1", "mining");
    m.stored = true;
    m.hqId = st.id;
    m.bay = 1;
    r.trySwap("p1");
    expect(r.activeShip.get("p1")).toBe("guardada");
    expect(b.stored).toBe(true);
    expect(b.bay).toBe(0);
    expect(m.stored).toBe(false);
    expect(m.anchored).toBe(true);
    samePos(m, bayWorldPos(st, 1)!);
    expect(r.activeShip.get("p1")).not.toBe(bId);
  });

  it("construir: o builder sai do centro do asteroide e pousa na vaga da estação nova", () => {
    const { r } = makeRoom();
    const s = pilot(r, "p1", "builder", over(rocks[2]));
    r.tryToggleAnchor("p1");
    run(r, 1.6);
    expect(s.landingPhase).toBe("landed");
    r.sim.addOre("p1", 10_000);
    r.tryLandAction("p1", "buildmine");
    const st = [...r.sim.structures.values()].find((x) => x.asteroidId === rocks[2].id)!;
    expect(st).toBeDefined();
    expect(s.landingPhase).toBe("landing");
    run(r, 1.6);
    expect(s.anchored).toBe(true);
    expect(s.hqId).toBe(st.id);
    samePos(s, bayWorldPos(st, s.bay)!);
  });
});

describe("modo ataque de estação", () => {
  it("nave de ataque descendo sobre estação INIMIGA entra em modo ataque", () => {
    const { r } = makeRoom();
    build(r, "p2", rocks[0]);
    const s = pilot(r, "p1", "attack", over(rocks[0]));
    r.tryToggleAnchor("p1");
    expect(s.layerTo).toBe("attack");
    run(r, LAYER_TRANSITION_TIME + DT);
    expect(s.layer).toBe("attack");
  });

  it("as outras classes não descem sobre estação inimiga (o asteroide é sólido para elas)", () => {
    const { r } = makeRoom();
    build(r, "p2", rocks[0]);
    for (const kind of ["builder", "mining", "transport"] as const) {
      const s = pilot(r, "p1", kind, over(rocks[0]));
      r.tryToggleAnchor("p1");
      expect(s.layerTo).toBe("");
      expect(s.landingPhase).toBe("");
    }
  });

  it("sair da zona da estação faz a nave subir sozinha ao cruzeiro", () => {
    const { r } = makeRoom();
    build(r, "p2", rocks[0]);
    const s = pilot(r, "p1", "attack", over(rocks[0]));
    r.tryToggleAnchor("p1");
    run(r, LAYER_TRANSITION_TIME + DT);
    // ainda dentro da zona: continua
    s.x = rocks[0].x + rocks[0].radius;
    run(r, DT);
    expect(s.layer).toBe("attack");
    expect(s.layerTo).toBe("");
    // fora da zona
    s.x = rocks[0].x + rocks[0].radius + 400;
    run(r, DT);
    expect(s.layerTo).toBe("cruise");
    run(r, LAYER_TRANSITION_TIME + DT);
    expect(s.layer).toBe("cruise");
  });

  it("a zona inclui a margem: perto do asteroide inimigo, sem estar em cima, já entra em modo ataque", () => {
    const { r } = makeRoom();
    build(r, "p2", rocks[0]);
    const s = pilot(r, "p1", "attack", { ...beside(rocks[0]), x: rocks[0].x + rocks[0].radius + 100 });
    r.tryToggleAnchor("p1");
    expect(s.layerTo).toBe("attack");
    run(r, LAYER_TRANSITION_TIME + DT);
    expect(s.layer).toBe("attack"); // não é expulsa ao entrar
  });

  it("perto da estação inimiga mas FORA da zona: desce à superfície comum, não ao modo ataque", () => {
    const { r } = makeRoom();
    build(r, "p2", rocks[0]);
    const s = pilot(r, "p1", "attack", { ...beside(rocks[0]), x: rocks[0].x + rocks[0].radius + 350 });
    r.tryToggleAnchor("p1");
    expect(s.layerTo).toBe("surface");
  });

  it("estação destruída: a nave em modo ataque sobe sozinha", () => {
    const { r } = makeRoom();
    const st = build(r, "p2", rocks[0]);
    const s = pilot(r, "p1", "attack", over(rocks[0]));
    r.tryToggleAnchor("p1");
    run(r, LAYER_TRANSITION_TIME + DT);
    r.sim.structures.delete(st.id);
    run(r, DT);
    expect(s.layerTo).toBe("cruise");
  });

  it("em modo ataque a nave atravessa o asteroide inimigo; na superfície ele a barra", () => {
    const { r } = makeRoom();
    build(r, "p2", rocks[0]);
    const s = pilot(r, "p1", "attack", over(rocks[0]));
    r.tryToggleAnchor("p1");
    run(r, LAYER_TRANSITION_TIME + DT);
    run(r, 0.5);
    expect(dist(s, rocks[0])).toBeLessThan(rocks[0].radius); // continua dentro, sem ser expulsa
    const blocked = pilot(r, "p1", "attack", { ...beside(rocks[0]), x: rocks[0].x + rocks[0].radius + SHIP_RADIUS + 300 });
    r.tryToggleAnchor("p1");
    run(r, LAYER_TRANSITION_TIME + DT);
    expect(blocked.layer).toBe("surface");
    blocked.vx = -3000;
    run(r, 0.5);
    expect(dist(blocked, rocks[0])).toBeGreaterThanOrEqual(rocks[0].radius);
  });
});

describe("cenário de teste", () => {
  it("o setor de teste está dentro da arena e tem rochas", () => {
    expect(rocks.length).toBeGreaterThan(3);
    const { r } = makeRoom();
    const s = pilot(r, "p1", "attack", openSpace());
    const before = { ...s };
    run(r, 1);
    expect(dist(s, before)).toBeLessThan(1);
  });
});
