import { afterEach, describe, expect, it } from "vitest";
import {
  BULLET_DAMAGE,
  COLLISION_DAMAGE_DV_THRESHOLD,
  COLLISION_DAMAGE_PER_DV,
  LAYER_TRANSITION_TIME,
  SHIP_HP_MAX,
  STATION_EXPANDED_BAYS,
  STATION_SHIP_BAYS,
  STATION_SPIDER_BAYS,
  STRUCTURE_SPECS,
  asteroidClassOf,
  bayWorldPos,
  ceresPosition,
  cargoLoadFactor,
  dist,
  mulberry32,
  relVec,
  shipPhysics,
  type ShipKind,
  type WorldPos,
} from "@ceres/shared";
import { makeShip, sectorAsteroids, setLayer, type Asteroid, type ShipState, type SimWorld, type Structure } from "@ceres/sim-core";
import { MatchRoom } from "../src/rooms/MatchRoom";
import { collisionDamage, hittableLevel, splitDamage } from "../src/combat";

// Combate entre camadas (passo 4): regras puras de combat.ts e a sala de
// verdade, sem rede, com o tempo andando por `tick`.

const SEED = 4242;
const DT = 0.05;
const CERES = ceresPosition(SEED);
/** setor dentro da arena e com rochas (ver layers.test.ts) */
const testSector = { sx: CERES.sx - 4, sy: CERES.sy };
const rocks = [...sectorAsteroids(SEED, testSector.sx, testSector.sy)].sort((a, b) => b.radius - a.radius);

function openSpace(): WorldPos {
  for (let x = 500; x < 10_000; x += 250) {
    for (let y = 500; y < 10_000; y += 250) {
      const p = { ...testSector, x, y };
      if (rocks.every((a) => dist(p, a) > a.radius + 1500)) return p;
    }
  }
  throw new Error("setor sem espaço aberto");
}

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
    tick(dt: number): void;
    tryFire(sid: string, kind?: "bullet" | "grenade"): void;
    tryToggleAnchor(sid: string): void;
  };
}
type R = ReturnType<typeof makeRoom>;

let seq = 0;
function ship(r: R, owner: string, kind: ShipKind, pos: WorldPos, pilot = true): [string, ShipState] {
  const id = `c${seq++}`;
  const s = r.sim.addShip(id, pos, owner, kind);
  if (pilot) r.activeShip.set(owner, id);
  return [id, s];
}
function station(r: R, owner: string, ast: Asteroid, angle = 0.7): Structure {
  return r.sim.addStructure({
    id: `st-${ast.id}`, type: "miningStation", owner, angle,
    sx: ast.sx, sy: ast.sy, x: ast.x, y: ast.y,
    asteroidId: ast.id, asteroidClass: asteroidClassOf(ast.radius),
    shipBays: STATION_SHIP_BAYS, expandedBays: STATION_EXPANDED_BAYS,
    spiderBays: STATION_SPIDER_BAYS[asteroidClassOf(ast.radius)],
    nextShipBay: 0, nextSpiderBay: 0, oreStore: 0, rationStore: 0,
  });
}
const run = (r: R, seconds: number) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) r.tick(DT);
};
/** Aponta a nave para `target` e dispara um perfurante. */
function fireAt(r: R, owner: string, s: ShipState, target: WorldPos): void {
  const { dx, dy } = relVec(s, target);
  s.angle = Math.atan2(dy, dx);
  s.fireCooldown = 0;
  r.tryFire(owner, "bullet");
}
const at = (p: WorldPos, dx: number, dy = 0): WorldPos => ({ sx: p.sx, sy: p.sy, x: p.x + dx, y: p.y + dy });

describe("regras puras (combat.ts)", () => {
  it("a divisão sorteada soma o dano inteiro; sem hangar, tudo vai para a estação", () => {
    const rng = mulberry32(1);
    for (let n = 0; n < 6; n++) {
      for (let k = 0; k < 50; k++) {
        const s = splitDamage(100, n, rng);
        expect(s.ships.length).toBe(n);
        expect(s.station + s.ships.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 9);
        expect([s.station, ...s.ships].every((x) => x >= 0)).toBe(true);
      }
    }
    expect(splitDamage(100, 0, rng).station).toBe(100);
  });

  it("a divisão é um sorteio de verdade: varia, e em média cada parte leva 1/(n+1)", () => {
    const rng = mulberry32(7);
    const sum = [0, 0, 0];
    const draws = 20_000;
    const seen = new Set<number>();
    for (let k = 0; k < draws; k++) {
      const s = splitDamage(90, 2, rng);
      sum[0] += s.station; sum[1] += s.ships[0]; sum[2] += s.ships[1];
      seen.add(Math.round(s.station));
    }
    for (const x of sum) expect(x / draws).toBeCloseTo(30, 0);
    expect(seen.size).toBeGreaterThan(50);
  });

  it("mesma semente, mesmo sorteio: a partida é reproduzível", () => {
    const a = mulberry32(99), b = mulberry32(99);
    for (let k = 0; k < 20; k++) expect(splitDamage(100, 3, a)).toEqual(splitDamage(100, 3, b));
  });

  it("dano de colisão: nada até o limiar, linear no Δv acima dele, maior no casco mais leve", () => {
    const s = makeShip({ sx: 0, sy: 0, x: 0, y: 0 }, "p1", "attack");
    const m = shipPhysics("attack").mass * cargoLoadFactor("attack", 0);
    s.hullImpulse = m * COLLISION_DAMAGE_DV_THRESHOLD;
    expect(collisionDamage(s)).toBe(0);
    s.hullImpulse = m * (COLLISION_DAMAGE_DV_THRESHOLD + 1000);
    expect(collisionDamage(s)).toBeCloseTo(1000 * COLLISION_DAMAGE_PER_DV, 9);
    const heavy = makeShip({ sx: 0, sy: 0, x: 0, y: 0 }, "p1", "transport");
    heavy.hullImpulse = s.hullImpulse;
    expect(collisionDamage(heavy)).toBeLessThan(collisionDamage(s));
  });

  it("quem pode ser atingido, e em que nível", () => {
    const s = makeShip({ sx: 0, sy: 0, x: 0, y: 0 }, "p1", "attack");
    expect(hittableLevel(s)).toBe("cruise");
    setLayer(s, "surface");
    expect(hittableLevel(s)).toBe("surface");
    setLayer(s, "attack");
    expect(hittableLevel(s)).toBe("surface"); // o modo ataque está no nível das estações
    s.layerTo = "cruise";
    expect(hittableLevel(s)).toBeNull(); // em transição: invulnerável
    setLayer(s, "cruise");
    s.anchored = true;
    expect(hittableLevel(s)).toBe("surface"); // pousada na vaga
    s.anchored = false;
    s.landingPhase = "landed";
    expect(hittableLevel(s)).toBe("surface"); // pousada num asteroide
    s.landingPhase = "";
    s.stored = true;
    expect(hittableLevel(s)).toBeNull(); // no hangar: só pela estação
  });
});

describe("tiros entre camadas", () => {
  it("cruzeiro atinge cruzeiro", () => {
    const r = makeRoom();
    const p = openSpace();
    const [, a] = ship(r, "p1", "attack", p);
    const [, b] = ship(r, "p2", "attack", at(p, 400), false);
    fireAt(r, "p1", a, b);
    run(r, 1);
    expect(b.hp).toBe(SHIP_HP_MAX - BULLET_DAMAGE);
  });

  it("camadas diferentes não combatem: o tiro do cruzeiro atravessa a nave da superfície", () => {
    const r = makeRoom();
    const p = openSpace();
    const [, a] = ship(r, "p1", "attack", p);
    const [, b] = ship(r, "p2", "attack", at(p, 400), false);
    setLayer(b, "surface");
    fireAt(r, "p1", a, b);
    run(r, 1);
    expect(b.hp).toBe(SHIP_HP_MAX);
  });

  it("nave em transição é invulnerável", () => {
    const r = makeRoom();
    const p = openSpace();
    const [, a] = ship(r, "p1", "attack", p);
    const [, b] = ship(r, "p2", "attack", at(p, 400), false);
    b.layerTo = "surface"; // descendo
    fireAt(r, "p1", a, b);
    run(r, 0.6);
    expect(b.hp).toBe(SHIP_HP_MAX);
  });

  it("nave em transição, pousada ou guardada não atira", () => {
    const r = makeRoom();
    const [, a] = ship(r, "p1", "attack", openSpace());
    const ammo = a.ammo;
    a.layerTo = "surface";
    fireAt(r, "p1", a, at(a, 400));
    expect(a.ammo).toBe(ammo);
    a.layerTo = "";
    a.anchored = true;
    fireAt(r, "p1", a, at(a, 400));
    expect(a.ammo).toBe(ammo);
  });

  it("nave pousada numa vaga é atingida por nave de ataque em modo ataque", () => {
    const r = makeRoom();
    const st = station(r, "p2", rocks[0]);
    const [, landed] = ship(r, "p2", "builder", at(rocks[0], rocks[0].radius + 200));
    r.tryToggleAnchor("p2");
    run(r, 1.6);
    expect(landed.anchored).toBe(true);
    samePlace(landed, bayWorldPos(st, landed.bay)!);
    const [, attacker] = ship(r, "p1", "attack", at(rocks[0], 5));
    r.tryToggleAnchor("p1");
    run(r, LAYER_TRANSITION_TIME + DT);
    expect(attacker.layer).toBe("attack");
    const before = st.hp;
    fireAt(r, "p1", attacker, landed);
    run(r, 0.4);
    expect(landed.hp).toBe(SHIP_HP_MAX - BULLET_DAMAGE);
    expect(st.hp).toBe(before);
  });
});

function samePlace(a: WorldPos, b: WorldPos) {
  expect(dist(a, b)).toBeLessThan(1e-6);
}

describe("estação com HP", () => {
  /** Atacante em modo ataque sobre a estação inimiga de `rocks[0]`. */
  function assault(r: R, st: Structure) {
    // perto do prédio: cada tiro chega em ~0,2 s
    const [, attacker] = ship(r, "p1", "attack", at(rocks[0], 300));
    r.tryToggleAnchor("p1");
    run(r, LAYER_TRANSITION_TIME + DT);
    expect(attacker.layer).toBe("attack");
    return (shots: number) => {
      for (let i = 0; i < shots; i++) {
        fireAt(r, "p1", attacker, st);
        run(r, 0.3);
      }
    };
  }

  it("nasce com o HP do tipo; o tiro do modo ataque tira dela, sem hangar, o dano inteiro", () => {
    const r = makeRoom();
    const st = station(r, "p2", rocks[0]);
    expect(st.hp).toBe(STRUCTURE_SPECS.miningStation.hp);
    assault(r, st)(3);
    expect(st.hp).toBe(STRUCTURE_SPECS.miningStation.hp - 3 * BULLET_DAMAGE);
  });

  it("o tiro do CRUZEIRO passa por cima da estação", () => {
    const r = makeRoom();
    const st = station(r, "p2", rocks[0]);
    const [, a] = ship(r, "p1", "attack", at(rocks[0], rocks[0].radius * 0.5));
    fireAt(r, "p1", a, st);
    run(r, 1);
    expect(st.hp).toBe(STRUCTURE_SPECS.miningStation.hp);
  });

  it("estação própria não leva dano do dono", () => {
    const r = makeRoom();
    const st = station(r, "p1", rocks[0]);
    const [, a] = ship(r, "p1", "attack", at(rocks[0], rocks[0].radius * 0.5));
    setLayer(a, "surface");
    fireAt(r, "p1", a, st);
    run(r, 1);
    expect(st.hp).toBe(STRUCTURE_SPECS.miningStation.hp);
  });

  it("com naves no hangar, cada tiro é sorteado entre elas e a estação, sem sobra nem falta", () => {
    const r = makeRoom();
    const st = station(r, "p2", rocks[0]);
    const hangar = [0, 1].map((bay) => {
      const [, s] = ship(r, "p2", "mining", rocks[0], false);
      s.stored = true; s.hqId = st.id; s.bay = bay;
      return s;
    });
    const fire = assault(r, st);
    fire(1);
    const lost = (STRUCTURE_SPECS.miningStation.hp - st.hp) + hangar.reduce((a, s) => a + (SHIP_HP_MAX - s.hp), 0);
    expect(lost).toBeCloseTo(BULLET_DAMAGE, 6);
    expect(hangar.some((s) => s.hp < SHIP_HP_MAX)).toBe(true);
    expect(STRUCTURE_SPECS.miningStation.hp - st.hp).toBeGreaterThan(0);
  });

  it("estação zerada explode com o hangar; a pousada decola; o atacante sobe sozinho", () => {
    const r = makeRoom();
    // frente (e vagas) para −x, do lado oposto ao atacante: a nave pousada não
    // fica na linha de tiro e o último tiro chega ao prédio
    const st = station(r, "p2", rocks[0], Math.PI);
    const [storedId, stored] = ship(r, "p2", "mining", rocks[0], false);
    stored.stored = true; stored.hqId = st.id; stored.bay = 1;
    const [, landed] = ship(r, "p2", "builder", at(rocks[0], rocks[0].radius + 200));
    r.tryToggleAnchor("p2");
    run(r, 1.6);
    expect(landed.anchored).toBe(true);
    const fire = assault(r, st);
    st.hp = 1; // o último tiro
    stored.hp = 1e9; // não morre sozinha antes da estação
    fire(1);
    expect(r.sim.structures.has(st.id)).toBe(false);
    expect(r.sim.ships.has(storedId)).toBe(false);
    expect(landed.anchored).toBe(false);
    expect(landed.layerTo).toBe("cruise");
    const attacker = r.sim.ships.get(r.activeShip.get("p1")!)!;
    expect(attacker.layerTo).toBe("cruise");
  });

  it("o jogador cuja nave ativa estava no hangar recebe outra que NÃO explodiu junto", () => {
    const r = makeRoom();
    const st = station(r, "p2", rocks[0]);
    const doomed = [0, 1].map((bay) => {
      const [id, s] = ship(r, "p2", "mining", rocks[0], false);
      s.stored = true; s.hqId = st.id; s.bay = bay; s.hp = 1e9;
      return id;
    });
    const [survivorId] = ship(r, "p2", "attack", openSpace(), false);
    r.activeShip.set("p2", doomed[0]);
    const fire = assault(r, st);
    st.hp = 1;
    fire(1);
    expect(r.activeShip.get("p2")).toBe(survivorId);
  });
});

describe("dano de colisão na sala", () => {
  it("choque frontal no cruzeiro fere as duas naves", () => {
    const r = makeRoom();
    const p = openSpace();
    const [, a] = ship(r, "p1", "attack", p);
    const [, b] = ship(r, "p2", "attack", at(p, 400), false);
    // 8000 u/s relativos (4000 cada): Δv ≈ 6000 → ~68 HP (ver a calibração em shared/ships.ts)
    a.vx = 4000; b.vx = -4000; a.angle = 0; b.angle = Math.PI;
    run(r, 1);
    expect(a.hp).toBeLessThan(SHIP_HP_MAX - 40);
    expect(a.hp).toBeGreaterThan(0);
    expect(b.hp).toBeCloseTo(a.hp, 6);
    expect(a.hullImpulse).toBe(0); // o servidor zera depois de converter
  });

  it("encostar e empurrar com empuxo não fere", () => {
    const r = makeRoom();
    const q = openSpace();
    const [, c] = ship(r, "p1", "attack", q);
    const [, d] = ship(r, "p2", "transport", at(q, 2 * 20 + 1), false);
    c.angle = 0;
    r.sim.setInput(r.activeShip.get("p1")!, { thrust: true, turn: 0, mine: false });
    run(r, 3);
    expect(c.hp).toBe(SHIP_HP_MAX);
    expect(d.hp).toBe(SHIP_HP_MAX);
  });
});
