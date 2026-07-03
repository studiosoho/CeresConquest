import { describe, expect, it } from "vitest";
import { sectorAsteroids, stepShip, makeShip } from "../src";
import { BELT_INNER_SECTORS, BELT_OUTER_SECTORS } from "@ceres/shared";

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
