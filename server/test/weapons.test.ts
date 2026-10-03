import { afterEach, describe, expect, it } from "vitest";
import {
  CERES_RADIUS,
  HQ_EXPANDED_BAYS,
  HQ_SHIP_BAYS,
  LASER_DAMAGE,
  LASER_GIMBAL,
  LASER_SLEW,
  MINE_AMMO_MAX,
  MINE_DAMAGE,
  MINE_MAX_DISTANCE,
  MISSILE_AMMO_MAX,
  MISSILE_GIMBAL,
  MISSILE_SPEED,
  SHIP_HP_MAX,
  SHIP_TOP_SPEED_FACTOR,
  STATION_EXPANDED_BAYS,
  STATION_SHIP_BAYS,
  asteroidClassOf,
  ceresPosition,
  dist,
  interceptAngle,
  relVec,
  shipPhysics,
  slewAim,
  type ShipKind,
  type WeaponKind,
  type WorldPos,
} from "@ceres/shared";
import { makeShip, sectorAsteroids, type Asteroid, type ShipState, type SimWorld, type Structure } from "@ceres/sim-core";
import { MatchRoom } from "../src/rooms/MatchRoom";
import { pickTarget } from "../src/combat";

// Armamento (weapons.ts): computador de tiro, mísseis, laser, minas e recarga
// no QG — regras puras e a sala de verdade, sem rede.

const SEED = 4242;
const DT = 0.05;
const CERES = ceresPosition(SEED);
/** setor dentro da arena e com rochas (ver layers.test.ts) */
const testSector = { sx: CERES.sx - 4, sy: CERES.sy };
const rocks = [...sectorAsteroids(SEED, testSector.sx, testSector.sy)].sort((a, b) => b.radius - a.radius);

/** Rochas (e Ceres) em volta de `p`, para achar caminhos livres. */
function bodiesNear(p: WorldPos): Array<{ pos: WorldPos; radius: number }> {
  const out: Array<{ pos: WorldPos; radius: number }> = [{ pos: CERES, radius: CERES_RADIUS }];
  for (let ox = -2; ox <= 2; ox++) {
    for (let oy = -2; oy <= 2; oy++) {
      for (const a of sectorAsteroids(SEED, p.sx + ox, p.sy + oy)) out.push({ pos: a, radius: a.radius });
    }
  }
  return out;
}

/** Ponto de partida e direção com `len` u livres de rocha à frente. */
function clearLane(len: number): { p: WorldPos; angle: number } {
  for (let x = 500; x < 10_000; x += 500) {
    for (let y = 500; y < 10_000; y += 500) {
      const p = { ...testSector, x, y };
      const bodies = bodiesNear(p);
      for (let k = 0; k < 16; k++) {
        const angle = (k / 16) * Math.PI * 2;
        let ok = true;
        for (let d = 0; d <= len && ok; d += 50) {
          const q = { ...p, x: p.x + Math.cos(angle) * d, y: p.y + Math.sin(angle) * d };
          ok = bodies.every((b) => dist(q, b.pos) > b.radius + 300);
        }
        if (ok) return { p, angle };
      }
    }
  }
  throw new Error("sem corredor livre");
}

const rooms: MatchRoom[] = [];
afterEach(() => {
  for (const room of rooms.splice(0)) room.clock.clear();
});

interface WeaponState { weapon: WeaponKind; offset: number; target: string; locked: boolean }
interface Proj { kind: string; armed?: boolean; level: string; sx: number; sy: number; x: number; y: number; vx: number; vy: number }

function makeRoom() {
  const room = new MatchRoom();
  (room as unknown as { listing: object }).listing = { metadata: {}, save: async () => {} };
  room.onCreate({ worldSeed: SEED, bots: 0, maxPlayers: 4 });
  rooms.push(room);
  return room as unknown as {
    sim: SimWorld;
    activeShip: Map<string, string>;
    weapons: Map<string, WeaponState>;
    projectiles: Map<string, Proj>;
    state: { projectiles: Map<string, { armed: boolean }> };
    broadcast: (type: string, msg: never) => void;
    tick(dt: number): void;
    tryFire(sid: string): void;
    trySelectWeapon(sid: string, w: WeaponKind): void;
    dockAtBay(ship: ShipState, st: Structure): void;
  };
}
type R = ReturnType<typeof makeRoom>;

let seq = 0;
function ship(r: R, owner: string, kind: ShipKind, pos: WorldPos, pilot = true): [string, ShipState] {
  const id = `w${seq++}`;
  const s = r.sim.addShip(id, pos, owner, kind);
  if (pilot) r.activeShip.set(owner, id);
  return [id, s];
}
const run = (r: R, seconds: number) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) r.tick(DT);
};
const at = (p: WorldPos, dx: number, dy = 0): WorldPos => ({ sx: p.sx, sy: p.sy, x: p.x + dx, y: p.y + dy });
function spy(r: R) {
  const events: Array<{ kind: string; x: number; y: number; tx?: number; ty?: number }> = [];
  r.broadcast = (type, msg) => {
    if (type === "fx") events.push(msg);
  };
  return events;
}
const onlyProjectile = (r: R): Proj => {
  const all = [...r.projectiles.values()];
  expect(all.length).toBe(1);
  return all[0];
};

describe("computador de tiro (regras puras)", () => {
  it("interceptação: alvo parado → direto; alvo andando → o projétil chega junto com ele", () => {
    expect(interceptAngle(1000, 0, 0, 0, 2000)).toBeCloseTo(0, 9);
    const rx = 2000, ry = 0, vx = 0, vy = 400, speed = 2000;
    const a = interceptAngle(rx, ry, vx, vy, speed);
    expect(a).toBeGreaterThan(0); // leva o tiro à frente do alvo
    // tempo de voo t: |r + v t| = speed t
    const t = rx / (speed * Math.cos(a));
    expect(Math.hypot(rx + vx * t - speed * Math.cos(a) * t, ry + vy * t - speed * Math.sin(a) * t)).toBeLessThan(1e-6);
  });

  it("alvo mais rápido que o projétil, fugindo: mira direto", () => {
    expect(interceptAngle(1000, 500, 5000, 0, 2000)).toBeCloseTo(Math.atan2(500, 1000), 9);
  });

  it("a mira gira no máximo slew·dt por passo e não passa do gimbal", () => {
    expect(slewAim(0, 0.3, 0.5, 1, 0.1)).toBeCloseTo(0.1, 9);
    expect(slewAim(0.28, 0.3, 0.5, 1, 0.1)).toBeCloseTo(0.3, 9); // chega e para
    expect(slewAim(0.45, 2, 0.5, 1, 0.1)).toBeCloseTo(0.5, 9); // presa no gimbal
    expect(slewAim(0, -2, 0.5, 1, 0.1)).toBeCloseTo(-0.1, 9);
  });

  it("escolhe o inimigo mais perto da linha do nariz, dentro do cone e do alcance", () => {
    const s = makeShip({ sx: 0, sy: 0, x: 0, y: 0 }, "p1", "attack");
    s.angle = 0;
    const t = (id: string, x: number, y: number) => ({ id, pos: { sx: 0, sy: 0, x, y }, vx: 0, vy: 0 });
    const near = t("perto-mas-de-lado", 500, 400); // ~39° do nariz
    const aligned = t("alinhado", 2000, 100); // ~3°
    const behind = t("atras", -300, 0);
    const far = t("longe", 9000, 0);
    expect(pickTarget(s, [near, aligned, behind, far], 8000)?.id).toBe("alinhado");
    expect(pickTarget(s, [behind], 8000)).toBeNull();
    expect(pickTarget(s, [far], 8000)).toBeNull();
    expect(pickTarget(s, [t("fora-do-cone", 100, 400)], 8000)).toBeNull();
  });
});

describe("armas na sala", () => {
  it("a nave de ataque começa com mísseis selecionados e munição cheia; 1/2/3 trocam a arma", () => {
    const r = makeRoom();
    const { p } = clearLane(0);
    const [id, a] = ship(r, "p1", "attack", p);
    expect(a.ammo).toBe(MISSILE_AMMO_MAX);
    expect(a.grenadeAmmo).toBe(MINE_AMMO_MAX);
    run(r, DT);
    expect(r.weapons.get(id)?.weapon).toBe("missile");
    r.trySelectWeapon("p1", "laser");
    expect(r.weapons.get(id)?.weapon).toBe("laser");
    r.trySelectWeapon("p1", "bomba" as WeaponKind);
    expect(r.weapons.get(id)?.weapon).toBe("laser");
  });

  it("míssil: a mira leva o tiro ao ponto de interceptação de um alvo que cruza", () => {
    const r = makeRoom();
    const fx = spy(r);
    const { p, angle } = clearLane(3000);
    const [, a] = ship(r, "p1", "attack", p);
    a.angle = angle;
    const tp = at(p, Math.cos(angle) * 2000, Math.sin(angle) * 2000);
    const [, b] = ship(r, "p2", "attack", tp, false);
    // cruza a linha do nariz de lado, a 300 u/s
    b.vx = -Math.sin(angle) * 300;
    b.vy = Math.cos(angle) * 300;
    run(r, 0.3); // a mira do míssil (rápida) assenta
    r.tryFire("p1");
    run(r, 1.5);
    expect(fx.filter((e) => e.kind === "hit").length).toBe(1);
    expect(b.hp).toBeLessThan(SHIP_HP_MAX);
  });

  it("sem alvo, a mira fica no nariz e o míssil sai por ele", () => {
    const r = makeRoom();
    const { p, angle } = clearLane(3000);
    const [id, a] = ship(r, "p1", "attack", p);
    a.angle = angle;
    run(r, 0.3);
    expect(r.weapons.get(id)?.offset).toBe(0);
    r.tryFire("p1");
    const m = onlyProjectile(r);
    expect(Math.atan2(m.vy, m.vx)).toBeCloseTo(angle, 6);
    expect(Math.hypot(m.vx, m.vy)).toBeCloseTo(MISSILE_SPEED, 6);
  });

  it("laser: a mira CAMINHA até o alvo; só trava ao chegar, e só travado dispara", () => {
    const r = makeRoom();
    const fx = spy(r);
    const { p, angle } = clearLane(2500);
    const [id, a] = ship(r, "p1", "attack", p);
    a.angle = angle;
    const off = 0.4; // dentro do gimbal do laser
    expect(off).toBeLessThan(LASER_GIMBAL);
    const [, b] = ship(r, "p2", "attack", at(p, Math.cos(angle + off) * 2000, Math.sin(angle + off) * 2000), false);
    r.trySelectWeapon("p1", "laser");
    run(r, 0.2);
    const w = r.weapons.get(id)!;
    expect(w.target).not.toBe("");
    expect(w.locked).toBe(false);
    expect(w.offset).toBeGreaterThan(0.1);
    expect(w.offset).toBeLessThan(off - 0.1); // ainda a caminho
    r.tryFire("p1");
    expect(b.hp).toBe(SHIP_HP_MAX); // destravado: não dispara
    expect(fx.length).toBe(0);
    run(r, off / LASER_SLEW); // tempo de sobra para chegar
    expect(w.locked).toBe(true);
    r.tryFire("p1");
    // um feixe por canhão travado (laser duplo — ver "laser duplo" abaixo)
    const beams = fx.filter((e) => e.kind === "laser");
    expect(beams.length).toBeGreaterThanOrEqual(1);
    expect(b.hp).toBe(SHIP_HP_MAX - beams.length * LASER_DAMAGE);
    for (const beam of beams) expect(Math.hypot(beam.tx! - b.x, beam.ty! - b.y)).toBeLessThan(1e-3);
  });

  it("laser não alcança além do alcance, nem fora do gimbal", () => {
    const r = makeRoom();
    const { p, angle } = clearLane(5000);
    const [id, a] = ship(r, "p1", "attack", p);
    a.angle = angle;
    ship(r, "p2", "attack", at(p, Math.cos(angle) * 4500, Math.sin(angle) * 4500), false);
    r.trySelectWeapon("p1", "laser");
    run(r, 1);
    expect(r.weapons.get(id)?.target).toBe("");
    // agora dentro do alcance, mas a 0,7 rad: dentro do cone, fora do gimbal
    const r2 = makeRoom();
    const [id2, a2] = ship(r2, "p1", "attack", p);
    a2.angle = angle;
    ship(r2, "p2", "attack", at(p, Math.cos(angle + 0.7) * 1500, Math.sin(angle + 0.7) * 1500), false);
    r2.trySelectWeapon("p1", "laser");
    run(r2, 2);
    const w = r2.weapons.get(id2)!;
    expect(w.target).not.toBe("");
    expect(w.offset).toBeCloseTo(LASER_GIMBAL, 6);
    expect(w.locked).toBe(false);
  });

  it("mina: voa inerte, para a 10 km do lançamento, arma e só então detona", () => {
    const r = makeRoom();
    const fx = spy(r);
    const { p, angle } = clearLane(MINE_MAX_DISTANCE + 500);
    const [, a] = ship(r, "p1", "attack", p);
    a.angle = angle;
    // inimigo colado à rota da mina: ela passa por ele sem detonar
    const [eId, e] = ship(r, "p2", "attack", at(p, Math.cos(angle) * 2000 - Math.sin(angle) * 80, Math.sin(angle) * 2000 + Math.cos(angle) * 80), false);
    r.trySelectWeapon("p1", "mine");
    r.tryFire("p1");
    expect(a.grenadeAmmo).toBe(MINE_AMMO_MAX - 1);
    const mine = onlyProjectile(r);
    run(r, 3);
    expect(mine.armed).toBe(false);
    expect(e.hp).toBe(SHIP_HP_MAX);
    run(r, 5);
    expect(mine.armed).toBe(true);
    expect([...r.state.projectiles.values()][0].armed).toBe(true);
    expect(Math.hypot(mine.vx, mine.vy)).toBe(0);
    expect(dist(at(p, 0), mine)).toBeGreaterThan(MINE_MAX_DISTANCE);
    expect(dist(at(p, 0), mine)).toBeLessThan(MINE_MAX_DISTANCE + 200);
    const parked = { sx: mine.sx, sy: mine.sy, x: mine.x, y: mine.y };
    run(r, 1);
    expect(dist(parked, mine)).toBe(0); // parada, flutuando
    expect(fx.filter((x) => x.kind === "blast").length).toBe(0);
    // o inimigo chega perto: detona
    Object.assign(e, at(mine, 150), { vx: 0, vy: 0 });
    run(r, 0.1);
    expect(fx.filter((x) => x.kind === "blast").length).toBe(1);
    expect(r.projectiles.size).toBe(0);
    expect(r.sim.ships.get(eId)?.hp).toBeCloseTo(SHIP_HP_MAX - MINE_DAMAGE * (1 - 150 / 450), 0);
  });

  it("mina que encontra um asteroide no caminho se fixa na superfície dele e arma", () => {
    const r = makeRoom();
    const rock: Asteroid = rocks[0];
    const start = at(rock, rock.radius + 900);
    const [, a] = ship(r, "p1", "attack", start);
    const { dx, dy } = relVec(start, rock);
    a.angle = Math.atan2(dy, dx);
    r.trySelectWeapon("p1", "mine");
    r.tryFire("p1");
    const mine = onlyProjectile(r);
    run(r, 1.5);
    expect(mine.armed).toBe(true);
    expect(mine.level).toBe("surface");
    expect(dist(mine, rock)).toBeCloseTo(rock.radius, 0);
  });

  it("recarga: pousar numa vaga do PRÓPRIO QG enche mísseis e minas", () => {
    const r = makeRoom();
    const rock = rocks[0];
    const hq = (owner: string, id: string) => r.sim.addStructure({
      id, type: "hq", owner, angle: 0,
      sx: rock.sx, sy: rock.sy, x: rock.x, y: rock.y,
      asteroidId: rock.id, asteroidClass: asteroidClassOf(rock.radius),
      shipBays: HQ_SHIP_BAYS, expandedBays: HQ_EXPANDED_BAYS, spiderBays: 0,
      nextShipBay: 0, nextSpiderBay: 0, oreStore: 0, rationStore: 0,
    });
    const [, a] = ship(r, "p1", "attack", at(rock, rock.radius + 300));
    const empty = () => { a.ammo = 3; a.grenadeAmmo = 0; a.bay = 0; };
    empty();
    r.dockAtBay(a, hq("p2", "st-inimigo"));
    expect([a.ammo, a.grenadeAmmo]).toEqual([3, 0]); // QG inimigo: nada
    const station = r.sim.addStructure({
      id: "st-estacao", type: "miningStation", owner: "p1", angle: 0,
      sx: rock.sx, sy: rock.sy, x: rock.x, y: rock.y,
      asteroidId: rock.id, asteroidClass: asteroidClassOf(rock.radius),
      shipBays: STATION_SHIP_BAYS, expandedBays: STATION_EXPANDED_BAYS, spiderBays: 0,
      nextShipBay: 0, nextSpiderBay: 0, oreStore: 0, rationStore: 0,
    });
    empty();
    r.dockAtBay(a, station);
    expect([a.ammo, a.grenadeAmmo]).toEqual([3, 0]); // estação de mineração: nada
    empty();
    r.dockAtBay(a, hq("p1", "st-meu"));
    expect([a.ammo, a.grenadeAmmo]).toEqual([MISSILE_AMMO_MAX, MINE_AMMO_MAX]);
  });
});

describe("velocidade final", () => {
  it("40% menor em todos os cascos, com a mesma aceleração", () => {
    const orig: Record<ShipKind, number> = { builder: 5200, mining: 4600, attack: 6000, transport: 4000 };
    expect(SHIP_TOP_SPEED_FACTOR).toBe(0.6);
    for (const k of Object.keys(orig) as ShipKind[]) {
      expect(shipPhysics(k).maxSpeed).toBeCloseTo(orig[k] * 0.6, 9);
    }
    // a aceleração vem de empuxo/massa, que não mudaram (referência: builder)
    expect(shipPhysics("builder").thrust / shipPhysics("builder").mass).toBe(1200);
    expect(MISSILE_GIMBAL).toBeLessThan(LASER_GIMBAL);
  });
});

describe("laser duplo", () => {
  it("cada canhão trava no seu tempo; travados, os dois disparam, cada um da sua asa", () => {
    const r = makeRoom();
    const fx = spy(r);
    const { p, angle } = clearLane(2500);
    const [id, a] = ship(r, "p1", "attack", p);
    a.angle = angle;
    const off = 0.4;
    const [, b] = ship(r, "p2", "attack", at(p, Math.cos(angle + off) * 2000, Math.sin(angle + off) * 2000), false);
    r.trySelectWeapon("p1", "laser");
    const w = r.weapons.get(id)! as WeaponState & { offset2: number; locked2: boolean };
    // o 1º canhão (mais rápido) trava antes do 2º
    let t = 0;
    while (!w.locked && t < 3) { r.tick(DT); t += DT; }
    expect(w.locked).toBe(true);
    expect(w.locked2).toBe(false);
    expect(w.offset2).toBeLessThan(w.offset);
    while (!w.locked2 && t < 3) { r.tick(DT); t += DT; }
    expect(w.locked2).toBe(true);

    fx.length = 0;
    a.fireCooldown = 0;
    r.tryFire("p1");
    const beams = fx.filter((e) => e.kind === "laser");
    expect(beams.length).toBe(2);
    expect(b.hp).toBe(SHIP_HP_MAX - 2 * LASER_DAMAGE);
    // os feixes saem de pontos diferentes (as duas asas), ~44 u um do outro
    expect(Math.hypot(beams[0].x - beams[1].x, beams[0].y - beams[1].y)).toBeCloseTo(44, 0);
  });
});
