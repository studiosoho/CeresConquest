import { describe, expect, it } from "vitest";
import {
  sectorAsteroids,
  stepShip,
  makeShip,
  collideShip,
  clampToBoundary,
  findClearSpawn,
  SimWorld,
} from "../src";
import {
  BELT_INNER_SECTORS,
  BELT_OUTER_SECTORS,
  SECTOR_SIZE,
  SHIP_RADIUS,
  dist,
  type WorldPos,
} from "@ceres/shared";

// setor garantidamente dentro do anel do cinturão
const beltSector = Math.round((BELT_INNER_SECTORS + BELT_OUTER_SECTORS) / 2);

describe("procgen determinística", () => {
  it("mesma semente e setor produzem asteroides idênticos", () => {
    const a = sectorAsteroids(12345, beltSector, 0);
    const b = sectorAsteroids(12345, beltSector, 0);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("sementes diferentes produzem setores diferentes", () => {
    const a = sectorAsteroids(1, beltSector, 0);
    const b = sectorAsteroids(2, beltSector, 0);
    expect(a).not.toEqual(b);
  });

  it("fora do cinturão o espaço é vazio", () => {
    expect(sectorAsteroids(12345, 0, 0)).toEqual([]); // perto do Sol
    expect(sectorAsteroids(12345, BELT_OUTER_SECTORS * 2, 0)).toEqual([]);
  });
});

describe("física da nave", () => {
  it("é determinística para a mesma sequência de inputs", () => {
    const run = () => {
      const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 });
      for (let i = 0; i < 200; i++) {
        stepShip(ship, { thrust: true, turn: i % 3 === 0 ? 1 : 0, mine: false }, 1 / 20);
      }
      return ship;
    };
    expect(run()).toEqual(run());
  });

  it("atravessa a borda do setor normalizando a posição local", () => {
    const ship = makeShip({ sx: beltSector, sy: 0, x: 9990, y: 5000 });
    ship.vx = 400;
    for (let i = 0; i < 20; i++) stepShip(ship, { thrust: false, turn: 0, mine: false }, 1 / 20);
    expect(ship.sx).toBe(beltSector + 1);
    expect(ship.x).toBeGreaterThanOrEqual(0);
    expect(ship.x).toBeLessThan(10_000);
  });
});

describe("colisão nave × asteroide", () => {
  const seed = 777;

  it("empurra a nave para fora quando penetra um asteroide", () => {
    const a = sectorAsteroids(seed, beltSector, 0)[0];
    const ship = { sx: a.sx, sy: a.sy, x: a.x + 10, y: a.y, vx: 5, vy: 0 };
    collideShip(ship, seed);
    expect(dist(a, ship)).toBeGreaterThanOrEqual(a.radius + SHIP_RADIUS - 0.5);
  });

  it("empurra mesmo se a nave estiver exatamente no centro", () => {
    const a = sectorAsteroids(seed, beltSector, 0)[0];
    const ship = { sx: a.sx, sy: a.sy, x: a.x, y: a.y, vx: 0, vy: 0 };
    collideShip(ship, seed);
    expect(dist(a, ship)).toBeGreaterThanOrEqual(a.radius + SHIP_RADIUS - 0.5);
  });

  it("não afeta nave em espaço vazio (fora do cinturão)", () => {
    const ship = { sx: 0, sy: 0, x: 5000, y: 5000, vx: 100, vy: 0 };
    const before = { ...ship };
    collideShip(ship, seed);
    expect(ship).toEqual(before);
  });

  it("findClearSpawn devolve um ponto livre de asteroides", () => {
    const sp = findClearSpawn(seed, beltSector, 0);
    const point: WorldPos = { sx: beltSector, sy: 0, x: sp.x, y: sp.y };
    let inside = false;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        for (const a of sectorAsteroids(seed, beltSector + ox, 0 + oy)) {
          if (dist(a, point) < a.radius + SHIP_RADIUS) inside = true;
        }
      }
    }
    expect(inside).toBe(false);
  });
});

describe("fronteira do mapa", () => {
  const center: WorldPos = { sx: beltSector, sy: 0, x: 5000, y: 5000 };
  const R = 5 * SECTOR_SIZE;

  it("puxa a nave de volta quando ultrapassa o limite", () => {
    const ship = { sx: beltSector + 10, sy: 0, x: 5000, y: 5000, vx: 400, vy: 0 };
    clampToBoundary(ship, center, R);
    expect(dist(center, ship)).toBeLessThanOrEqual(R + 0.5);
  });

  it("remove a velocidade para fora ao bater no limite", () => {
    // nave além do limite, movendo-se para fora
    const ship = { sx: beltSector, sy: 0, x: 5000 + R + 1000, y: 5000, vx: 400, vy: 0 };
    clampToBoundary(ship, center, R);
    expect(ship.vx).toBeLessThanOrEqual(0.001); // velocidade radial p/ fora zerada
    expect(dist(center, ship)).toBeLessThanOrEqual(R + 0.5);
  });

  it("não afeta nave dentro do limite", () => {
    const ship = { sx: beltSector, sy: 0, x: 6000, y: 5000, vx: 100, vy: 0 };
    const before = { ...ship };
    clampToBoundary(ship, center, R);
    expect(ship).toEqual(before);
  });
});

describe("estruturas", () => {
  it("estação de mineração produz minério para o dono ao longo do tempo", () => {
    const w = new SimWorld(999);
    const owner = w.addShip("p1", { sx: beltSector, sy: 0, x: 5000, y: 5000 });
    w.addStructure({
      id: "st-0",
      type: "miningStation",
      owner: "p1",
      sx: beltSector,
      sy: 0,
      x: 5000,
      y: 5000,
      angle: 0,
    });
    const oreAntes = owner.ore;
    for (let i = 0; i < 20; i++) w.tick(1 / 20); // 1s
    // productionRate=10 → ~10 de minério em 1s (+ possível mineração passiva=0)
    expect(owner.ore - oreAntes).toBeGreaterThan(9);
    expect(owner.ore - oreAntes).toBeLessThan(11);
  });
});
