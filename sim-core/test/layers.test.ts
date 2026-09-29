import { describe, expect, it } from "vitest";
import {
  makeShip,
  stepShipInWorld,
  sectorAsteroids,
  SimWorld,
  beginLayerChange,
  setLayer,
  inLayerTransition,
  type ShipState,
} from "../src";
import {
  BELT_INNER_SECTORS,
  BELT_OUTER_SECTORS,
  CERES_RADIUS,
  LAYER_TRANSITION_TIME,
  PHYSICS_SUBSTEP,
  ceresPosition,
  dist,
  type ShipInput,
  type ShipLayer,
  type WorldPos,
} from "@ceres/shared";

// Camadas de voo: a matriz de colisão de shared/layers.ts, travada pelo caminho
// REAL de voo (stepShipInWorld / SimWorld.tick), não por chamadas isoladas.

const COAST: ShipInput = { thrust: false, turn: 0, mine: false };
const beltSector = Math.round((BELT_INNER_SECTORS + BELT_OUTER_SECTORS) / 2);
const seed = 777;
/** a MENOR rocha do setor: a travessia cabe dentro de uma transição de camada */
const rock = sectorAsteroids(seed, beltSector, 0).reduce((m, r) => (r.radius < m.radius ? r : m));
/** espaço aberto, longe do cinturão */
const open: WorldPos = { sx: 0, sy: 0, x: 5000, y: 5000 };

/** Nave na camada pedida (sem transição). */
const shipIn = (layer: ShipLayer, pos: WorldPos, owner = "p1"): ShipState => {
  const s = makeShip(pos, owner, "attack");
  setLayer(s, layer);
  return s;
};

/**
 * Voa em linha reta pelo CENTRO de um corpo e devolve a menor distância que a
 * nave chegou dele. Atravessou = passou perto do centro; bateu = nunca entrou.
 */
const closestApproach = (s: ShipState, target: WorldPos, seconds: number, env: Parameters<typeof stepShipInWorld>[4]) => {
  let closest = Infinity;
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    stepShipInWorld(s, COAST, 1 / 60, 1, env);
    closest = Math.min(closest, dist(s, target));
  }
  return closest;
};

describe("camada padrão", () => {
  it("a nave nasce em cruzeiro, parada numa camada", () => {
    const s = makeShip(open, "p1", "builder");
    expect(s.layer).toBe("cruise");
    expect(s.layerTo).toBe("");
    expect(inLayerTransition(s)).toBe(false);
  });
});

describe("sólidos do mundo por camada", () => {
  const approach = (layer: ShipLayer) => {
    const s = shipIn(layer, { sx: rock.sx, sy: rock.sy, x: rock.x - rock.radius - 400, y: rock.y });
    s.vx = 3000;
    return closestApproach(s, rock, (rock.radius + 400) / 3000 + 0.1, { seed });
  };

  it("em CRUZEIRO a nave passa por cima da rocha", () => {
    expect(approach("cruise")).toBeLessThan(rock.radius * 0.1);
  });

  it("na SUPERFÍCIE a rocha é sólida", () => {
    expect(approach("surface")).toBeGreaterThanOrEqual(rock.radius);
  });

  it("em MODO ATAQUE a nave atravessa a rocha", () => {
    expect(approach("attack")).toBeLessThan(rock.radius * 0.1);
  });

  const ceres = ceresPosition(seed);
  const approachCeres = (layer: ShipLayer) => {
    const s = shipIn(layer, { sx: ceres.sx, sy: ceres.sy, x: ceres.x - CERES_RADIUS - 400, y: ceres.y });
    s.vx = 3000;
    return closestApproach(s, ceres, (CERES_RADIUS + 400) / 3000 + 0.1, { ceres });
  };

  it("em CRUZEIRO a nave passa por cima de Ceres", () => {
    expect(approachCeres("cruise")).toBeLessThan(CERES_RADIUS * 0.1);
  });

  it("na SUPERFÍCIE Ceres é sólida", () => {
    expect(approachCeres("surface")).toBeGreaterThanOrEqual(CERES_RADIUS);
  });

  it("a FRONTEIRA da arena contém a nave em todas as camadas", () => {
    const center: WorldPos = { sx: 0, sy: 0, x: 0, y: 0 };
    const R = 5000;
    for (const layer of ["cruise", "surface", "attack"] as ShipLayer[]) {
      const s = shipIn(layer, { sx: 0, sy: 0, x: R - 100, y: 0 });
      s.vx = 3000;
      for (let i = 0; i < 60; i++) {
        stepShipInWorld(s, COAST, 1 / 60, 1, { boundaryCenter: center, boundaryRadius: R });
      }
      expect(dist(s, center)).toBeLessThanOrEqual(R + 1e-6);
    }
  });
});

describe("transição entre camadas", () => {
  it("dura LAYER_TRANSITION_TIME e chega no MESMO sub-passo a 20 Hz e a 60 Hz", () => {
    for (const dt of [1 / 20, 1 / 60]) {
      const s = shipIn("cruise", open);
      expect(beginLayerChange(s, "surface")).toBe(true);
      const calls = Math.round(LAYER_TRANSITION_TIME / dt);
      for (let i = 0; i < calls - 1; i++) stepShipInWorld(s, COAST, dt, 1, null);
      expect(s.layer).toBe("cruise"); // ainda a caminho
      expect(inLayerTransition(s)).toBe(true);
      stepShipInWorld(s, COAST, dt, 1, null);
      expect(s.layer).toBe("surface");
      expect(inLayerTransition(s)).toBe(false);
    }
  });

  it("não reinicia uma transição para a camada em que já está ou para onde já vai", () => {
    const s = shipIn("cruise", open);
    expect(beginLayerChange(s, "cruise")).toBe(false);
    expect(beginLayerChange(s, "surface")).toBe(true);
    stepShipInWorld(s, COAST, 0.5, 1, null);
    const progress = s.layerProgress;
    expect(beginLayerChange(s, "surface")).toBe(false);
    expect(s.layerProgress).toBe(progress);
  });

  it("durante a transição a nave não colide com rocha — mesmo descendo PARA a superfície", () => {
    const s = shipIn("cruise", { sx: rock.sx, sy: rock.sy, x: rock.x - rock.radius - 400, y: rock.y });
    s.vx = 3000;
    beginLayerChange(s, "surface");
    // a travessia inteira acontece antes de a transição terminar
    const crossing = (rock.radius + 400) / 3000;
    expect(crossing).toBeLessThan(LAYER_TRANSITION_TIME);
    const closest = closestApproach(s, rock, crossing, { seed });
    expect(inLayerTransition(s)).toBe(true);
    expect(closest).toBeLessThan(rock.radius * 0.1);
  });

  it("ao chegar à superfície, a rocha passa a ser sólida", () => {
    const s = shipIn("cruise", { sx: rock.sx, sy: rock.sy, x: rock.x - rock.radius - 3200, y: rock.y });
    s.vx = 3000;
    beginLayerChange(s, "surface");
    const closest = closestApproach(s, rock, (rock.radius + 3200) / 3000 + 0.1, { seed });
    expect(s.layer).toBe("surface");
    expect(closest).toBeGreaterThanOrEqual(rock.radius);
  });
});

describe("nave × nave por camada", () => {
  /**
   * Duas naves de frente em espaço aberto, pelo caminho do servidor. Colidiram
   * se A voltou (vx < 0); não colidiram se A passou por B.
   */
  const meet = (la: ShipLayer, lb: ShipLayer, bTransition?: ShipLayer) => {
    const w = new SimWorld(seed);
    const a = w.addShip("a", open, "p1", "attack");
    const b = w.addShip("b", { ...open, x: open.x + 300 }, "p2", "attack");
    setLayer(a, la);
    setLayer(b, lb);
    if (bTransition) beginLayerChange(b, bTransition);
    a.vx = 1000;
    b.vx = -1000;
    for (let i = 0; i < 6; i++) w.tick(1 / 20);
    return { collided: a.vx < 0, a, b };
  };

  it("mesma camada colide: cruzeiro × cruzeiro e superfície × superfície", () => {
    expect(meet("cruise", "cruise").collided).toBe(true);
    expect(meet("surface", "surface").collided).toBe(true);
  });

  it("camadas diferentes não colidem", () => {
    expect(meet("cruise", "surface").collided).toBe(false);
    expect(meet("surface", "cruise").collided).toBe(false);
  });

  it("modo ataque não colide com nave nenhuma", () => {
    expect(meet("attack", "attack").collided).toBe(false);
    expect(meet("attack", "cruise").collided).toBe(false);
    expect(meet("surface", "attack").collided).toBe(false);
  });

  it("nave em transição não colide com a camada de onde saiu", () => {
    expect(meet("cruise", "cruise", "surface").collided).toBe(false);
  });

  it("o choque acumula o impulso normal nos DOIS cascos (matéria-prima do dano)", () => {
    const hit = meet("cruise", "cruise");
    expect(hit.a.hullImpulse).toBeGreaterThan(0);
    expect(hit.b.hullImpulse).toBeCloseTo(hit.a.hullImpulse, 9);
    const miss = meet("cruise", "surface");
    expect(miss.a.hullImpulse).toBe(0);
    expect(miss.b.hullImpulse).toBe(0);
  });
});

describe("asteroide com estação, na superfície", () => {
  const station = (owner: string) => ({
    id: "st-1", type: "miningStation" as const, owner, angle: 0,
    sx: rock.sx, sy: rock.sy, x: rock.x, y: rock.y,
    asteroidId: rock.id, asteroidClass: rock.asteroidClass,
    shipBays: 0, expandedBays: 0, spiderBays: 0, nextShipBay: 0, nextSpiderBay: 0,
    oreStore: 0, rationStore: 0,
  });
  const cross = (shipOwner: string) => {
    const w = new SimWorld(seed);
    w.addStructure(station("p1"));
    const s = w.addShip("s", { sx: rock.sx, sy: rock.sy, x: rock.x - rock.radius - 400, y: rock.y }, shipOwner, "attack");
    setLayer(s, "surface");
    s.vx = 3000;
    let closest = Infinity;
    for (let i = 0; i < Math.round(((rock.radius + 400) / 3000 + 0.1) * 20); i++) {
      w.tick(1 / 20);
      closest = Math.min(closest, dist(s, rock));
    }
    return closest;
  };

  it("estação PRÓPRIA: o asteroide é atravessável", () => {
    expect(cross("p1")).toBeLessThan(rock.radius * 0.1);
  });

  it("estação INIMIGA: o asteroide é sólido", () => {
    expect(cross("p2")).toBeGreaterThanOrEqual(rock.radius);
  });
});

describe("predição do cliente respeita a camada do snapshot", () => {
  /** A nave própria contra o FANTASMA de um snapshot vindo de frente. */
  const predict = (own: ShipLayer, other: ShipLayer) => {
    const a = shipIn(own, open);
    a.vx = 1000;
    const snap = { ...open, x: open.x + 300, vx: -1000, vy: 0, av: 0, kind: "attack" as const, cargoAmount: 0, layer: other };
    for (let i = 0; i < 18; i++) {
      stepShipInWorld(a, COAST, PHYSICS_SUBSTEP * 2, 1, { contacts: [snap], contactIds: ["b"] });
    }
    return a.vx < 0;
  };

  it("mesma camada: a predição resolve o choque", () => {
    expect(predict("cruise", "cruise")).toBe(true);
    expect(predict("surface", "surface")).toBe(true);
  });

  it("camadas diferentes: a predição deixa passar", () => {
    expect(predict("cruise", "surface")).toBe(false);
    expect(predict("surface", "cruise")).toBe(false);
  });
});
