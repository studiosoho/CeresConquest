import { describe, expect, it } from "vitest";
import {
  sectorAsteroids,
  clearSectorCache,
  stepShip,
  stepShipInWorld,
  drainSubsteps,
  makeShip,
  freezeShip,
  seekInput,
  collideShip,
  collideShipPair,
  collideCeres,
  clampToBoundary,
  findClearSpawn,
  SimWorld,
  type ShipState,
} from "../src";
import {
  BELT_INNER_SECTORS,
  BELT_OUTER_SECTORS,
  SECTOR_SIZE,
  SHIP_RADIUS,
  CERES_RADIUS,
  SHIP_PHYSICS,
  SIM_MAX_DT,
  PHYSICS_SUBSTEP,
  IMPACT_SPIN_LINEAR,
  IMPACT_SPIN_MAX,
  ASTEROID_SURFACE_FRICTION,
  CERES_SURFACE_FRICTION,
  ASTEROID_SURFACE_RESTITUTION,
  BOUNDARY_SURFACE_FRICTION,
  HULL_FRICTION,
  PHYSICS_WORST_CASE_SUBSTEPS,
  SNAPSHOT_AGE_FIXED_GUESS,
  TRANSPORT_CARGO_CAP,
  cargoLoadFactor,
  ceresPosition,
  dist,
  type ShipInput,
  type ShipKind,
  type WorldPos,
} from "@ceres/shared";

const THRUST: ShipInput = { thrust: true, turn: 0, mine: false };
const COAST: ShipInput = { thrust: false, turn: 0, mine: false };
const TURN: ShipInput = { thrust: false, turn: 1, mine: false };
const speedOf = (s: { vx: number; vy: number }) => Math.hypot(s.vx, s.vy);
/** Roda `seconds` de simulação em passos de dt. */
const fly = (s: ReturnType<typeof makeShip>, input: ShipInput, seconds: number, dt = 1 / 60) => {
  for (let i = 0; i < Math.round(seconds / dt); i++) stepShip(s, input, dt);
};

// setor garantidamente dentro do anel do cinturão
const beltSector = Math.round((BELT_INNER_SECTORS + BELT_OUTER_SECTORS) / 2);

describe("procgen determinística", () => {
  it("mesma semente e setor produzem asteroides idênticos", () => {
    // limpa o memo entre as chamadas: senão a 2ª devolveria o MESMO array e o
    // teste passaria sem provar que a geração é reprodutível
    clearSectorCache();
    const a = sectorAsteroids(12345, beltSector, 0).map((x) => ({ ...x }));
    clearSectorCache();
    const b = sectorAsteroids(12345, beltSector, 0);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("o memo de setor devolve exatamente o que a geração devolveria", () => {
    clearSectorCache();
    const fresh = sectorAsteroids(4242, beltSector, 1).map((x) => ({ ...x }));
    const cached = sectorAsteroids(4242, beltSector, 1); // agora vem do memo
    expect(cached).toEqual(fresh);
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
  // NOTA: estes testes provam REPRODUTIBILIDADE (mesma entrada → mesma saída,
  // sem relógio nem sorteio no caminho), rodando duas vezes no mesmo motor.
  // Não provam igualdade bit a bit entre V8 e JSC — e o jogo não precisa
  // disso: a reconciliação é blend exponencial, não rollback+replay.
  it("é reprodutível para a mesma sequência de inputs", () => {
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

  it("é reprodutível mesmo com dt VARIÁVEL (mesma sequência → mesmo estado)", () => {
    // o dt vem do frame do cliente e do tick do servidor: varia. O que precisa
    // ser reprodutível é a MESMA sequência de dt, não um dt fixo.
    const dts = [1 / 60, 1 / 30, 0.1, 1 / 144, 0.007, 0.05];
    const run = () => {
      const s = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "transport");
      for (let i = 0; i < 240; i++) {
        stepShip(s, { thrust: i % 4 !== 0, turn: (i % 7 < 3 ? 1 : -1) as 1 | -1, mine: false },
          dts[i % dts.length]);
      }
      return s;
    };
    expect(run()).toEqual(run());
  });

  it("é ESTÁVEL com dt grande: dt=0.1 não diverge de passos pequenos", () => {
    // o sub-passo fixo faz o resultado quase não depender do tamanho do dt
    const big = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 });
    const small = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 });
    fly(big, THRUST, 2, 0.1);
    fly(small, THRUST, 2, 1 / 240);
    expect(speedOf(big)).toBeGreaterThan(0);
    expect(Number.isFinite(speedOf(big))).toBe(true);
    // menos de 1% de diferença entre um passo 24× maior e o de referência
    expect(Math.abs(speedOf(big) - speedOf(small)) / speedOf(small)).toBeLessThan(0.01);
  });

  it("20 Hz do servidor e 60 Hz do cliente dão a MESMA trajetória", () => {
    // é isto que sustenta a predição: ambos caem no mesmo h = 1/120, então
    // rodam a mesma quantidade de sub-passos idênticos — inclusive de colisão
    const seed = 777;
    // fases em segundos inteiros: o MESMO comando vale no mesmo instante de
    // relógio nas duas taxas (senão o teste compararia voos diferentes)
    const phases: Array<[ShipInput, number]> = [
      [{ thrust: true, turn: 1, mine: false }, 3],
      [{ thrust: true, turn: 0, mine: false }, 4],
      [{ thrust: false, turn: -1, mine: false }, 3],
    ];
    const run = (dt: number) => {
      const s = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
      for (const [input, seconds] of phases) {
        for (let i = 0; i < Math.round(seconds / dt); i++) {
          stepShipInWorld(s, input, dt, 1, { seed });
        }
      }
      return s;
    };
    const server = run(1 / 20);
    const client = run(1 / 60);
    expect(dist(server, client)).toBeLessThan(1e-6);
    expect(client.angle).toBeCloseTo(server.angle, 9);
    expect(client.vx).toBeCloseTo(server.vx, 6);
    expect(client.vy).toBeCloseTo(server.vy, 6);
  });

  it("dt = 0 não altera nada além de normalizar a posição", () => {
    const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 });
    ship.vx = 900;
    ship.av = 1.5;
    const before = { ...ship };
    stepShip(ship, THRUST, 0);
    expect(ship).toEqual(before);
  });
});

describe("inércia linear (voo newtoniano)", () => {
  it("a velocidade PERSISTE quando o empuxo para — o vácuo não freia", () => {
    const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 });
    fly(ship, THRUST, 2);
    const v0 = speedOf(ship);
    expect(v0).toBeGreaterThan(1500);

    fly(ship, COAST, 8);
    // com arrasto exponencial sobrava 6% aos 8s; aqui o único freio é o trim
    // assistido do RCS, de autoridade constante e pequena
    expect(speedOf(ship) / v0).toBeGreaterThan(0.8);
  });

  it("em inércia a nave só perde o Δv do trim assistido (desaceleração constante)", () => {
    const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 });
    ship.vx = 4000;
    const t = 4;
    fly(ship, COAST, t);
    const expected = 4000 - SHIP_PHYSICS.builder.assistDecel * t;
    expect(speedOf(ship)).toBeCloseTo(expected, 0);
  });

  it("a deriva é real: girar NÃO gira o vetor velocidade", () => {
    const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 });
    fly(ship, THRUST, 2);
    const heading = Math.atan2(ship.vy, ship.vx);
    const v0 = speedOf(ship);

    // gira até o nariz passar de 90° — sem tocar no acelerador
    while (ship.angle < Math.PI / 2) stepShip(ship, TURN, 1 / 60);

    // o nariz apontou para outro lado, mas o vetor velocidade não mudou
    expect(Math.atan2(ship.vy, ship.vx)).toBeCloseTo(heading, 3);
    expect(speedOf(ship) / v0).toBeGreaterThan(0.95);
    expect(ship.angle).toBeGreaterThan(Math.PI / 2);
  });

  it("o limite de velocidade é LIMITADOR DE EMPUXO, não freio escondido", () => {
    // acima da nominal, a única desaceleração admitida é o trim declarado.
    // Qualquer "teto suave" que puxe a nave de volta apareceria aqui como uma
    // perda muito maior que assistDecel·t.
    const limit = SHIP_PHYSICS.builder.maxSpeed;
    const trim = SHIP_PHYSICS.builder.assistDecel;
    for (const input of [COAST, THRUST]) {
      const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 });
      ship.vx = limit + 3000; // chegou acima da nominal (quique/impacto)
      const t = 2;
      fly(ship, input, t);
      expect(speedOf(ship)).toBeCloseTo(limit + 3000 - trim * t, 0);
    }
  });

  it("acima da nominal o motor corta, mas a nave ainda manobra", () => {
    const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 });
    ship.vx = SHIP_PHYSICS.builder.maxSpeed + 2000;
    ship.angle = Math.PI; // nariz para trás: empuxo retrógrado
    const before = speedOf(ship);
    fly(ship, THRUST, 1);
    // freio pedido pelo piloto funciona normalmente (não é o motor "cortado")
    expect(speedOf(ship)).toBeLessThan(before - 800);
  });

  it("sob empuxo contínuo nenhuma classe passa da própria nominal", () => {
    for (const kind of ["builder", "mining", "attack", "transport"] as ShipKind[]) {
      const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", kind);
      fly(ship, THRUST, 30, 1 / 60);
      expect(speedOf(ship)).toBeLessThanOrEqual(SHIP_PHYSICS[kind].maxSpeed + 0.5);
      expect(speedOf(ship)).toBeGreaterThan(SHIP_PHYSICS[kind].maxSpeed - 60);
    }
  });
});

describe("carga é massa", () => {
  const full = TRANSPORT_CARGO_CAP;

  it("o porão cheio muda o fator de massa em 1,5×", () => {
    expect(cargoLoadFactor("transport", 0)).toBe(1);
    expect(cargoLoadFactor("transport", full)).toBeCloseTo(1.5, 6);
  });

  it("cargueiro cheio acelera menos e gira menos que vazio", () => {
    const run = (cargo: number) => {
      const s = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "transport");
      s.cargoKind = "ore";
      s.cargoAmount = cargo;
      fly(s, { thrust: true, turn: 1, mine: false }, 0.4);
      return { v: speedOf(s), spin: s.av };
    };
    const empty = run(0);
    const loaded = run(full);
    expect(loaded.v).toBeLessThan(empty.v * 0.72); // ~1/1,5 do impulso
    expect(loaded.spin).toBeLessThan(empty.spin);
    expect(loaded.spin).toBeGreaterThan(0);
  });

  it("num contato, o cheio empurra o vazio (impulso reparte por massa inversa)", () => {
    const heavy = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "transport");
    heavy.cargoAmount = full;
    heavy.vx = 400;
    const light = makeShip({ sx: beltSector, sy: 0, x: 5000 + SHIP_RADIUS, y: 5000 }, "p", "attack");
    const pHeavy = heavy.vx * SHIP_PHYSICS.transport.mass * cargoLoadFactor("transport", full);
    collideShipPair(heavy, light);
    // o leve sai empurrado bem mais rápido do que o pesado desacelera
    expect(light.vx).toBeGreaterThan(heavy.vx);
    // e o momento linear total se conserva
    const after =
      heavy.vx * SHIP_PHYSICS.transport.mass * cargoLoadFactor("transport", full) +
      light.vx * SHIP_PHYSICS.attack.mass;
    expect(after).toBeCloseTo(pHeavy, 6);
  });
});

describe("momento angular (a nave não é um cursor)", () => {
  it("o leme acelera a rotação em RAMPA, não em degrau", () => {
    const p = SHIP_PHYSICS.builder;
    const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 });
    stepShip(ship, TURN, 1 / 60);
    const first = ship.av;
    fly(ship, TURN, 0.5);

    expect(first).toBeGreaterThan(0);
    expect(first).toBeCloseTo((p.angularAccel * 1) / 60, 6); // α·dt, puro torque
    // meio segundo depois já chegou à nominal (rampa de α: ω/α = 0,28 s)
    expect(ship.av).toBeCloseTo(p.maxTurnRate, 6);
    fly(ship, TURN, 3);
    expect(ship.av).toBeLessThanOrEqual(p.maxTurnRate); // limitador, sem passar
  });

  it("o RCS gasta autoridade DECLARADA para segurar a atitude", () => {
    // o giro não some sozinho no vácuo: some a uma taxa que está na ficha
    const p = SHIP_PHYSICS.builder;
    const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 });
    ship.av = 3.0; // rodopio de impacto
    const t = 0.3;
    fly(ship, COAST, t);
    expect(ship.av).toBeCloseTo(3.0 - p.attitudeHold * t, 6);
    // e o tempo total até parar é ω/attitudeHold, não um decaimento mágico
    const expected = 3.0 / p.attitudeHold;
    expect(expected).toBeGreaterThan(0.5);
  });

  it("ao soltar o leme a nave CONTINUA girando e só então assenta", () => {
    const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 });
    fly(ship, TURN, 1);
    const spinning = ship.av;
    const angleAtRelease = ship.angle;

    stepShip(ship, COAST, 1 / 60);
    expect(ship.av).toBeGreaterThan(spinning * 0.9); // nada de zerar no degrau

    fly(ship, COAST, 0.5);
    expect(ship.angle).toBeGreaterThan(angleAtRelease + 0.3); // rodou por inércia
    fly(ship, COAST, 3);
    expect(ship.av).toBe(0); // o RCS acaba segurando, e para exatamente em zero
  });

  it("freezeShip mata o giro residual ao atracar", () => {
    const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 });
    fly(ship, TURN, 1);
    expect(ship.av).toBeGreaterThan(0.5);
    freezeShip(ship);
    expect(ship.av).toBe(0);
    expect(ship.vx).toBe(0);
    expect(ship.thrustRamp).toBe(0);
  });
});

describe("massa e inércia por classe", () => {
  it("cada classe acelera de um jeito — o transporte é o mais pesado", () => {
    const after1s = (kind: ShipKind) => {
      const s = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", kind);
      fly(s, THRUST, 1);
      return speedOf(s);
    };
    const attack = after1s("attack");
    const builder = after1s("builder");
    const mining = after1s("mining");
    const transport = after1s("transport");

    expect(attack).toBeGreaterThan(builder);
    expect(builder).toBeGreaterThan(mining);
    expect(mining).toBeGreaterThan(transport);
    // e a diferença é grande o bastante para se SENTIR (não 1%)
    expect(transport).toBeLessThan(attack * 0.45);
  });

  it("cada classe gira de um jeito — momento de inércia I = m·k²", () => {
    // meio segundo de leme: a rampa (α) ainda manda, antes da nominal
    const spinAfter = (kind: ShipKind) => {
      const s = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", kind);
      fly(s, TURN, 0.2);
      return s.av;
    };
    expect(spinAfter("attack")).toBeGreaterThan(spinAfter("builder"));
    expect(spinAfter("builder")).toBeGreaterThan(spinAfter("mining"));
    expect(spinAfter("mining")).toBeGreaterThan(spinAfter("transport"));
    // o cargueiro tem 6,5× o momento de inércia do builder (2,6 · 19² / 12²)
    expect(SHIP_PHYSICS.transport.inertia / SHIP_PHYSICS.builder.inertia).toBeGreaterThan(6);
  });

  it("os valores derivados batem com a definição física (a = F/m, α = τ/I)", () => {
    for (const p of Object.values(SHIP_PHYSICS)) {
      expect(p.inertia).toBeCloseTo(p.mass * p.gyration * p.gyration, 6);
      expect(p.accel).toBeCloseTo(p.thrust / p.mass, 6);
      expect(p.angularAccel).toBeCloseTo(p.torque / p.inertia, 6);
      expect(p.attitudeHold).toBeLessThan(p.angularAccel); // segurar < manobrar
    }
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

  it("asteroide com estrutura (passthrough) é atravessável", () => {
    const a = sectorAsteroids(seed, beltSector, 0)[0];
    const ship = { sx: a.sx, sy: a.sy, x: a.x, y: a.y, vx: 100, vy: 0 };
    const before = { ...ship };
    collideShip(ship, seed, new Set([a.id]));
    expect(ship).toEqual(before); // sem empurrão: a nave está dentro e fica
  });

  it("bate com RESTITUIÇÃO: a nave quica, não para seca nem teleporta", () => {
    const a = sectorAsteroids(seed, beltSector, 0)[0];
    // nave dentro do asteroide, indo para o centro dele a 2000 u/s
    const ship = makeShip({ sx: a.sx, sy: a.sy, x: a.x + a.radius, y: a.y });
    ship.vx = -2000;
    collideShip(ship, seed);

    // a componente normal INVERTEU (quicou) em vez de zerar
    expect(ship.vx).toBeGreaterThan(0);
    // e devolveu uma fração plausível: e = casco × superfície, nunca ≥ 1
    const bounce = ship.vx / 2000;
    expect(bounce).toBeGreaterThan(0.3);
    expect(bounce).toBeLessThan(1); // impacto NÃO cria energia
    expect(dist(a, ship)).toBeGreaterThanOrEqual(a.radius + SHIP_RADIUS - 0.5);
  });

  it("o quique é o do CASCO: o caça quica mais que o cargueiro", () => {
    const a = sectorAsteroids(seed, beltSector, 0)[0];
    const hit = (kind: ShipKind) => {
      const s = makeShip({ sx: a.sx, sy: a.sy, x: a.x + a.radius, y: a.y }, "p", kind);
      s.vx = -2000;
      collideShip(s, seed);
      return s.vx;
    };
    // e = restituição do casco × 1,0 da rocha nua — sem inventar recuo da pedra
    expect(hit("attack")).toBeCloseTo(2000 * SHIP_PHYSICS.attack.restitution, 6);
    expect(hit("transport")).toBeCloseTo(2000 * SHIP_PHYSICS.transport.restitution, 6);
    expect(hit("attack")).toBeGreaterThan(hit("transport"));
  });

  it("a rocha é PAREDE: o quique não depende do tamanho dela", () => {
    // asteroide procedural nunca é movido pela simulação, então não se finge
    // troca de momento com massa finita — mesma resposta em pedra e em monstro
    const rocks = sectorAsteroids(seed, beltSector, 0);
    const small = rocks.reduce((m, r) => (r.radius < m.radius ? r : m));
    const big = rocks.reduce((m, r) => (r.radius > m.radius ? r : m));
    expect(big.radius).toBeGreaterThan(small.radius * 1.5);

    const hit = (a: (typeof rocks)[number]) => {
      const s = makeShip({ sx: a.sx, sy: a.sy, x: a.x + a.radius, y: a.y }, "p", "transport");
      s.vx = -2000;
      collideShip(s, seed);
      return s.vx;
    };
    expect(hit(big)).toBeCloseTo(hit(small), 6);
  });

  it("encostar devagar ASSENTA (contato de repouso) em vez de tremer", () => {
    const a = sectorAsteroids(seed, beltSector, 0)[0];
    const ship = makeShip({ sx: a.sx, sy: a.sy, x: a.x + a.radius, y: a.y });
    ship.vx = -10; // aproximação lenta
    collideShip(ship, seed);
    // a aproximação morre sem quicar: sobra só o resíduo da razão de massas
    expect(ship.vx).toBeGreaterThan(-0.1);
    expect(ship.vx).toBeLessThan(0.1);
  });

  it("raspão imprime giro na nave (impulso tangencial tem braço de alavanca)", () => {
    const a = sectorAsteroids(seed, beltSector, 0)[0];
    // nave penetrando pela direita, deslizando na tangente (+y)
    const ship = makeShip({ sx: a.sx, sy: a.sy, x: a.x + a.radius, y: a.y });
    ship.vx = -100;
    ship.vy = 3000;
    collideShip(ship, seed);
    expect(ship.av).not.toBe(0);
    // limite continua existindo — mas ele é ASSÍNTOTA, não um valor fixo que
    // todo contato do jogo atinge (ver o describe de escalonamento adiante).
    // UMA chamada não prova esse limite, e por dois anos um teste achou que
    // provava: quem o exercita é o teste de contato SUSTENTADO, lá embaixo.
    expect(Math.abs(ship.av)).toBeLessThan(IMPACT_SPIN_MAX);
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

describe("Ceres", () => {
  const seed = 424242;
  const ceres = ceresPosition(seed);

  it("posição é determinística e fica no cinturão", () => {
    expect(ceresPosition(seed)).toEqual(ceres);
    const r = Math.hypot(ceres.sx + 0.5, ceres.sy + 0.5);
    expect(r).toBeGreaterThan(BELT_INNER_SECTORS - 1);
    expect(r).toBeLessThan(BELT_OUTER_SECTORS + 1);
  });

  it("não gera asteroides dentro do raio de Ceres", () => {
    // o setor de Ceres e o vizinho imediato devem estar vazios
    expect(sectorAsteroids(seed, ceres.sx, ceres.sy)).toEqual([]);
    expect(sectorAsteroids(seed, ceres.sx + 1, ceres.sy)).toEqual([]);
  });

  it("empurra a nave para fora do planeta (colisão sólida)", () => {
    const ship = { sx: ceres.sx, sy: ceres.sy, x: ceres.x + 100, y: ceres.y, vx: -50, vy: 0 };
    collideCeres(ship, ceres, CERES_RADIUS);
    expect(dist(ceres, ship)).toBeGreaterThanOrEqual(CERES_RADIUS + SHIP_RADIUS - 0.5);
  });

  it("não afeta nave fora do planeta", () => {
    const ship = {
      sx: ceres.sx,
      sy: ceres.sy,
      x: ceres.x + CERES_RADIUS + 500,
      y: ceres.y,
      vx: 100,
      vy: 0,
    };
    const before = { ...ship };
    collideCeres(ship, ceres, CERES_RADIUS);
    expect(ship).toEqual(before);
  });
});

describe("tunelamento (varredura de parâmetros de impacto)", () => {
  const seed = 777;
  const rock = sectorAsteroids(seed, beltSector, 0)[0];

  /**
   * Atira naves contra o asteroide variando o parâmetro de impacto (a que
   * distância do centro a trajetória passa) e mede quantas atravessam sem
   * nunca serem tocadas pela colisão. Uma nave que sai do outro lado com o
   * vetor velocidade intacto passou batido.
   */
  const sweep = (speed: number, dt: number, samples = 200) => {
    const reach = rock.radius + SHIP_RADIUS;
    let missed = 0;
    for (let i = 0; i < samples; i++) {
      // parâmetro de impacto dentro da seção de choque (evita a tangente exata)
      const b = ((i + 0.5) / samples) * reach * 0.98;
      const ship = makeShip({
        sx: rock.sx,
        sy: rock.sy,
        x: rock.x - reach - speed * dt,
        y: rock.y + b,
      });
      ship.vx = speed;
      const travel = 2 * (reach + speed * dt);
      const ticks = Math.ceil(travel / (speed * dt));
      for (let t = 0; t < ticks; t++) {
        stepShipInWorld(ship, { thrust: false, turn: 0, mine: false }, dt, 1, { seed });
      }
      // atravessou intacta = nunca colidiu
      if (ship.vx > speed * 0.999 && Math.abs(ship.vy) < 1e-6) missed++;
    }
    return missed / samples;
  };

  it("a 20 Hz do servidor, nenhuma nave rápida atravessa a rocha", () => {
    expect(sweep(7000, 1 / 20)).toBe(0);
    expect(sweep(5200, 1 / 20)).toBe(0);
  });

  it("a 60 Hz do cliente dá o MESMO resultado (predição não discorda)", () => {
    expect(sweep(7000, 1 / 60)).toBe(0);
    expect(sweep(5200, 1 / 60)).toBe(0);
  });

  it("aguenta mesmo muito acima de qualquer velocidade do jogo", () => {
    // margem do sub-passo: h = 1/120 e alvo de raio ≥ 220 u tolera ~52 800 u/s
    expect(sweep(20_000, 1 / 20, 60)).toBe(0);
  });
});

describe("contato nave × nave", () => {
  it("duas naves se empurram em vez de se atravessarem", () => {
    const a = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "builder");
    const b = makeShip({ sx: beltSector, sy: 0, x: 5000 + SHIP_RADIUS, y: 5000 }, "p", "builder");
    a.vx = 600;
    collideShipPair(a, b);
    expect(dist(a, b)).toBeGreaterThanOrEqual(2 * SHIP_RADIUS - 1e-6);
    expect(b.vx).toBeGreaterThan(0); // recebeu o impulso
    expect(a.vx).toBeLessThan(600); // e o outro recuou
  });

  it("conserva momento linear e não cria energia", () => {
    const a = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
    const b = makeShip({ sx: beltSector, sy: 0, x: 5000 + SHIP_RADIUS, y: 5000 }, "p", "mining");
    a.vx = 1500;
    b.vx = -500;
    const ma = SHIP_PHYSICS.attack.mass;
    const mb = SHIP_PHYSICS.mining.mass;
    const p0 = a.vx * ma + b.vx * mb;
    const e0 = 0.5 * (ma * a.vx * a.vx + mb * b.vx * b.vx);
    collideShipPair(a, b);
    expect(a.vx * ma + b.vx * mb).toBeCloseTo(p0, 6);
    const e1 = 0.5 * (ma * a.vx * a.vx + mb * b.vx * b.vx);
    expect(e1).toBeLessThan(e0); // e < 1: impacto sempre dissipa
  });

  it("naves longe não interagem", () => {
    const a = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 });
    const b = makeShip({ sx: beltSector, sy: 0, x: 5000 + 10 * SHIP_RADIUS, y: 5000 });
    a.vx = 900;
    const before = { ...a };
    collideShipPair(a, b);
    expect(a).toEqual(before);
  });

  it("o táxi fica FORA dos contatos: não arremessa o jogador de passagem", () => {
    const w = new SimWorld(999);
    const at: WorldPos = { sx: beltSector, sy: 0, x: 5000, y: 5000 };
    const player = w.addShip("mine", at, "p1", "builder");
    const taxi = w.addShip("taxi", { ...at, x: at.x + 5 }, "p1", "attack");
    taxi.taxiTo = "hq-0"; // em taxiamento: corredor de trânsito
    taxi.vx = 8000;
    w.tick(1 / 20);
    expect(player.vx).toBe(0); // não levou tranco nenhum
  });

  it("o táxi atravessa asteroide (caminho reto), a nave normal não", () => {
    const seed = 777;
    const a = sectorAsteroids(seed, beltSector, 0)[0];
    const inside: WorldPos = { sx: a.sx, sy: a.sy, x: a.x, y: a.y };
    const w = new SimWorld(seed);
    const normal = w.addShip("n", inside, "p1", "attack");
    const taxi = w.addShip("t", inside, "p1", "attack");
    taxi.taxiTo = "hq-0";
    w.tick(1 / 20);
    expect(dist(a, normal)).toBeGreaterThan(a.radius); // expulsa da rocha
    expect(dist(a, taxi)).toBeLessThan(a.radius); // segue reto por dentro
  });

  it("o mundo resolve os contatos: naves sobrepostas se separam no tick", () => {
    const w = new SimWorld(999);
    const at: WorldPos = { sx: beltSector, sy: 0, x: 5000, y: 5000 };
    w.addShip("s1", at, "p1", "attack");
    w.addShip("s2", { ...at, x: at.x + 5 }, "p2", "attack");
    w.tick(1 / 20);
    const s1 = w.ships.get("s1")!;
    const s2 = w.ships.get("s2")!;
    expect(dist(s1, s2)).toBeGreaterThan(2 * SHIP_RADIUS - 1);
  });
});

describe("piloto automático newtoniano", () => {
  const start: WorldPos = { sx: beltSector, sy: 0, x: 1000, y: 1000 };
  const target: WorldPos = { sx: beltSector + 2, sy: 0, x: 5000, y: 4000 };

  it("chega ao destino e PARA lá, em vez de orbitar para sempre", () => {
    for (const kind of ["builder", "transport", "attack"] as ShipKind[]) {
      const ship = makeShip(start, "p", kind);
      for (let i = 0; i < 60 * 60; i++) {
        // 60 s no máximo
        stepShip(ship, seekInput(ship, target, { arriveRadius: 200 }), 1 / 60);
        if (dist(ship, target) < 300 && speedOf(ship) < 200) break;
      }
      expect(dist(ship, target)).toBeLessThan(300);
      expect(speedOf(ship)).toBeLessThan(200);
    }
  });

  it("aponta o nariz para TRÁS para frear quando chega rápido demais", () => {
    const ship = makeShip(start, "p", "builder");
    // já em cima do alvo e com velocidade de sobra: só resta queimar retrógrado
    ship.vx = 3000;
    const cmd = seekInput(ship, { ...start, x: start.x + 400 }, { arriveRadius: 100 });
    // o Δv pedido aponta para -x, ou seja, o piloto quer virar de costas
    const wanted = Math.atan2(0, -1);
    // gira até alinhar e confere que aí ele manda empurrar (freio retrógrado)
    ship.angle = wanted;
    const braking = seekInput(ship, { ...start, x: start.x + 400 }, { arriveRadius: 100 });
    expect(cmd.turn).not.toBe(0); // enquanto não está alinhado, gira
    expect(braking.thrust).toBe(true); // alinhado a ré: queima para frear
  });

  it("o táxi FICA dentro da janela de atracação, não a cruza num tick", () => {
    // O servidor testa a chegada por distância uma vez por tick (20 Hz). Se o
    // táxi passasse voando, a janela cairia entre dois testes e ele orbitaria
    // para sempre. O que importa não é a velocidade de cruzeiro e sim que ele
    // chegue devagar: aqui exigimos vários ticks CONSECUTIVOS dentro do raio.
    const DOCK_RANGE = 500;
    for (const kind of ["attack", "transport"] as ShipKind[]) {
      const ship = makeShip(start, "p", kind);
      let inside = 0;
      for (let i = 0; i < 20 * 120; i++) {
        stepShip(ship, seekInput(ship, target, { speedMult: 2, arriveRadius: 250 }), 1 / 20, 2);
        if (dist(ship, target) <= DOCK_RANGE) {
          inside++;
          if (inside >= 3) break;
        } else {
          inside = 0; // saiu de novo: não valeu
        }
      }
      expect(inside).toBeGreaterThanOrEqual(3);
      expect(speedOf(ship)).toBeLessThan(DOCK_RANGE * 20); // < 1 janela por tick
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// Travas dos consertos da rodada 3. Cada describe abaixo existe porque o
// comportamento que ele mede JÁ ESTEVE ERRADO — os números nos comentários
// são o que foi medido antes do conserto.
// ══════════════════════════════════════════════════════════════════════

describe("governor de empuxo: limita só o que AUMENTA |v|", () => {
  const p = SHIP_PHYSICS.attack;

  it("acima da nominal, empuxo PERPENDICULAR empurra — o motor não morre a 90°", () => {
    // ANTES: o governor resolvia |v + s·Δ| = L para o vetor inteiro; acima da
    // nominal L = |v| e qualquer Δ a menos de 90° dava s = 0. Medido: |Δv| =
    // 37,5 u/s em 1 s, exatamente o trim — ou seja, motor DESLIGADO.
    const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
    ship.vx = 8400; // muito acima da nominal (6000), como depois de um quique
    ship.angle = Math.PI / 2; // nariz a 90° da velocidade
    fly(ship, THRUST, 1);

    // o empuxo foi para +y, que é para onde o nariz aponta
    expect(ship.vy).toBeGreaterThan(1000);
    // e o Δv total é da ordem do empuxo do casco, não do trim
    const trim = p.assistDecel * 1;
    expect(Math.hypot(ship.vx - 8400, ship.vy)).toBeGreaterThan(20 * trim);
  });

  it("acima da nominal, o RCS lateral também empurra (mesmo defeito, outro eixo)", () => {
    const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
    ship.vx = 8400;
    ship.angle = 0; // nariz na direção da velocidade: strafe sai a 90°
    fly(ship, { thrust: false, turn: 0, mine: false, strafe: 1 }, 1);
    // um segundo de RCS lateral = rcsAccel, descontado o trim que age no módulo
    expect(ship.vy).toBeGreaterThan(p.rcsAccel * 0.95);
  });

  it("acima da nominal o empuxo PRÓGRADO continua cortado (o limitador não virou enfeite)", () => {
    const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
    ship.vx = 8400;
    ship.angle = 0; // nariz na direção da velocidade
    fly(ship, THRUST, 1);
    // só o trim mexeu no módulo: nada de acelerar acima do que já estava
    expect(ship.vx).toBeCloseTo(8400 - p.assistDecel, 0);
    expect(ship.vy).toBe(0);
  });

  it("abaixo da nominal, o prógrado é cortado EXATAMENTE na folga que falta", () => {
    // folga de 2 u/s contra um sub-passo que entregaria 5,4 u/s (empuxo do caça
    // no início da rampa de spool): sem governor passaria do teto
    const h = 1 / 120;
    const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
    ship.vx = p.maxSpeed - 2;
    ship.angle = 0;
    stepShip(ship, THRUST, h);
    // encostou no teto e parou lá: sobra só o desconto do trim declarado
    expect(ship.vx).toBeCloseTo(p.maxSpeed - p.assistDecel * h, 6);
    expect(ship.vx).toBeLessThanOrEqual(p.maxSpeed);
    expect(ship.vy).toBe(0);
  });

  it("empuxo RETRÓGRADO nunca precisa de licença, esteja onde estiver", () => {
    for (const v0 of [1000, p.maxSpeed, 12_000]) {
      const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
      ship.vx = v0;
      ship.angle = Math.PI;
      fly(ship, THRUST, 0.5);
      // meio segundo de freio a 1600 u/s² (com spool) tira centenas de u/s
      expect(v0 - ship.vx).toBeGreaterThan(500);
    }
  });
});

describe("RCS de translação: desviar sem girar o casco", () => {
  const strafeR: ShipInput = { thrust: false, turn: 0, mine: false, strafe: 1 };
  const retro: ShipInput = { thrust: false, turn: 0, mine: false, retro: true };

  it("strafe puro empurra PERPENDICULAR ao nariz e não gira o casco", () => {
    const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "builder");
    fly(ship, strafeR, 1);
    expect(ship.angle).toBe(0); // o casco não girou um radiano sequer
    expect(ship.av).toBe(0);
    expect(ship.vx).toBe(0); // nada foi para a frente
    expect(ship.vy).toBeGreaterThan(0); // tudo foi para o lado
  });

  it("a autoridade por classe bate com a ficha (a = rcsThrust/m)", () => {
    for (const kind of ["builder", "mining", "attack", "transport"] as ShipKind[]) {
      const q = SHIP_PHYSICS[kind];
      expect(q.rcsAccel).toBeCloseTo(q.rcsThrust / q.mass, 9);
      const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", kind);
      fly(ship, strafeR, 1);
      // 1 s de RCS = rcsAccel, menos o trim que age sobre o módulo
      expect(ship.vy).toBeCloseTo(q.rcsAccel - q.assistDecel, 4);
    }
  });

  it("o RCS é SEMPRE mais fraco que o motor principal — o nariz não virou enfeite", () => {
    for (const q of Object.values(SHIP_PHYSICS)) {
      expect(q.rcsAccel).toBeLessThan(q.accel * 0.31);
      expect(q.rcsAccel).toBeGreaterThan(q.accel * 0.15);
    }
  });

  it("o cargueiro strafeia MAL: um quinto do caça", () => {
    const ratio = SHIP_PHYSICS.attack.rcsAccel / SHIP_PHYSICS.transport.rcsAccel;
    expect(ratio).toBeGreaterThan(4.5);
    // e a separação é maior que a dos motores principais (2,7×): as classes se
    // diferenciam MAIS no RCS do que na aceleração à frente, de propósito
    expect(ratio).toBeGreaterThan(SHIP_PHYSICS.attack.accel / SHIP_PHYSICS.transport.accel);
  });

  it("carga a bordo pesa no RCS igual pesa no motor (é a mesma massa)", () => {
    const run = (cargo: number) => {
      const s = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "transport");
      s.cargoAmount = cargo;
      fly(s, strafeR, 1);
      return s.vy;
    };
    // porão cheio = 1,5× a massa; sobra 1/1,5 do empuxo lateral (o trim
    // também cai por 1,5, então a razão não é exatamente 1/1,5 — mas é perto)
    expect(run(TRANSPORT_CARGO_CAP) / run(0)).toBeLessThan(0.72);
    expect(run(TRANSPORT_CARGO_CAP) / run(0)).toBeGreaterThan(0.6);
  });

  it("retro freia sem girar o casco (não é o motor principal de costas)", () => {
    const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "builder");
    ship.vx = 2000;
    fly(ship, retro, 1);
    expect(ship.angle).toBe(0); // não virou de costas para frear
    const q = SHIP_PHYSICS.builder;
    expect(ship.vx).toBeCloseTo(2000 - q.rcsAccel - q.assistDecel, 4);
    // e freia bem menos que o motor principal faria de ré
    expect(ship.vx).toBeGreaterThan(2000 - q.accel);
  });

  it("lateral + ré REPARTEM o orçamento do RCS — a diagonal não soma 1,41×", () => {
    const diag = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "builder");
    fly(diag, { thrust: false, turn: 0, mine: false, strafe: 1, retro: true }, 1);
    const axis = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "builder");
    fly(axis, strafeR, 1);
    expect(speedOf(diag)).toBeCloseTo(speedOf(axis), 6);
    // e foi mesmo na diagonal: metade para trás, metade para o lado
    expect(diag.vx).toBeLessThan(0);
    expect(diag.vy).toBeGreaterThan(0);
  });

  it("desviar de lado é MUITO mais rápido que girar o casco inteiro", () => {
    // este é o motivo de o RCS existir: sem ele, mudar de direção custava
    // 0,95 s no caça e 2,73 s no cargueiro só de rotação do casco
    const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
    ship.vx = 3000;
    const before = Math.atan2(ship.vy, ship.vx);
    fly(ship, strafeR, 2);
    const after = Math.atan2(ship.vy, ship.vx);
    expect(((after - before) * 180) / Math.PI).toBeGreaterThan(15);
    expect(ship.angle).toBe(0); // e o nariz continua exatamente onde estava
  });

  it("cliente (60 Hz) e servidor (20 Hz) dão a MESMA trajetória com RCS no comando", () => {
    // paridade é requisito: os dois entram pelo MESMO stepShipInWorld e caem
    // no mesmo h = 1/120, então rodam a mesma sequência de sub-passos
    const seed = 777;
    const phases: Array<[ShipInput, number]> = [
      [{ thrust: true, turn: 1, mine: false, strafe: 1 }, 3],
      [{ thrust: false, turn: 0, mine: false, strafe: -1, retro: true }, 4],
      [{ thrust: false, turn: -1, mine: false, assistOff: true }, 3],
    ];
    const run = (dt: number) => {
      const s = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
      for (const [input, seconds] of phases) {
        for (let i = 0; i < Math.round(seconds / dt); i++) {
          stepShipInWorld(s, input, dt, 1, { seed });
        }
      }
      return s;
    };
    const server = run(1 / 20);
    const client = run(1 / 60);
    expect(dist(server, client)).toBeLessThan(1e-6);
    expect(client.angle).toBeCloseTo(server.angle, 9);
    expect(client.vx).toBeCloseTo(server.vx, 6);
    expect(client.vy).toBeCloseTo(server.vy, 6);
  });

  it("input SEM os campos novos voa exatamente como antes (mudança reversível)", () => {
    // bots, piloto automático e clientes antigos não mandam strafe/retro:
    // `undefined` tem que ser bit a bit igual a `0`/`false`
    const legacy = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
    const explicit = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
    for (let i = 0; i < 200; i++) {
      const turn = (i % 5 < 2 ? 1 : -1) as 1 | -1;
      stepShip(legacy, { thrust: i % 3 !== 0, turn, mine: false }, 1 / 60);
      stepShip(explicit, {
        thrust: i % 3 !== 0, turn, mine: false,
        strafe: 0, retro: false, assistOff: false,
      }, 1 / 60);
    }
    expect(legacy).toEqual(explicit);
  });
});

describe("passo FIXO: h é 1/120 de verdade, não 'quase'", () => {
  const seed = 777;

  it("o acumulador entrega sub-passos de tamanho EXATO, guardando o resto", () => {
    // ANTES: n = ceil(dt/passo), h = dt/n. Um frame real de 16,667 ms é um fio
    // maior que 1/60, o ceil subia para n = 3 e h desabava para 5,556 ms — 33%
    // menor que o prometido, por sete microssegundos de diferença no frame.
    expect(drainSubsteps(1 / 60)).toEqual({ steps: 2, rest: 0 });
    expect(drainSubsteps(1 / 20)).toEqual({ steps: 6, rest: 0 });
    // o teto de pendência inteiro vira sub-passos exatos, sem resto: é o pior
    // caso por chamada, e é derivado (0,25 s / (1/120) = 30), não escolhido
    expect(drainSubsteps(SIM_MAX_DT)).toEqual({ steps: PHYSICS_WORST_CASE_SUBSTEPS, rest: 0 });
    expect(PHYSICS_WORST_CASE_SUBSTEPS).toBe(Math.round(SIM_MAX_DT / PHYSICS_SUBSTEP));

    // o frame REAL, que era o caso que quebrava: 2 sub-passos e o resto guardado
    const real = drainSubsteps(0.0166667);
    expect(real.steps).toBe(2);
    expect(real.rest).toBeGreaterThan(0);
    expect(real.rest).toBeLessThan(PHYSICS_SUBSTEP);

    // e um dt menor que um sub-passo não roda nada: acumula para a próxima
    expect(drainSubsteps(0.004)).toEqual({ steps: 0, rest: 0.004 });
  });

  it("o resíduo é conservado: nada de tempo some ao longo de muitas chamadas", () => {
    let accum = 0;
    let total = 0;
    const FRAME = 0.0166667; // frame real, que não é múltiplo do sub-passo
    for (let i = 0; i < 6000; i++) {
      accum += FRAME;
      const { steps, rest } = drainSubsteps(accum);
      accum = rest;
      total += steps;
    }
    // 100,0002 s de relógio viraram sub-passos, a menos do resíduo em voo
    const simulated = total * PHYSICS_SUBSTEP;
    expect(Math.abs(simulated - 6000 * FRAME)).toBeLessThan(PHYSICS_SUBSTEP);
  });

  it("o MESMO quique sai igual a 20 Hz, 60 Hz, 144 Hz e no frame real de 16,667 ms", () => {
    // é ISTO que o passo fixo compra. Com h variando por taxa de quadros,
    // cliente e servidor entravam na rocha com penetrações diferentes e saíam
    // com velocidades diferentes — a predição discordava do autoritativo por
    // construção, e os comentários do modelo afirmavam o contrário.
    const rock = sectorAsteroids(seed, beltSector, 0)[0];
    const bounce = (dt: number) => {
      const s = makeShip(
        { sx: rock.sx, sy: rock.sy, x: rock.x - rock.radius - 3000, y: rock.y + 120 },
        "p", "attack",
      );
      s.vx = 4000;
      for (let i = 0; i < Math.round(3 / dt); i++) stepShipInWorld(s, COAST, dt, 1, { seed });
      return s;
    };
    const server = bounce(1 / 20);
    for (const dt of [1 / 60, 0.0166667, 1 / 144, 1 / 30]) {
      const other = bounce(dt);
      expect(dist(server, other)).toBeLessThan(1e-6);
      expect(other.vx).toBeCloseTo(server.vx, 6);
      expect(other.vy).toBeCloseTo(server.vy, 6);
      expect(other.av).toBeCloseTo(server.av, 9);
    }
  });

  it("h não depende do dt, então nem um tick engasgado muda a margem de tunelamento", () => {
    // a margem agora é uma conta só, e não uma função da taxa de quadros:
    // 12 000 u/s (caça em táxi) × 1/120 s = 100 u, contra a seção de choque da
    // MENOR rocha do cinturão
    const small = sectorAsteroids(seed, beltSector, 0).reduce(
      (m, r) => (r.radius < m.radius ? r : m),
    );
    const target = small.radius + SHIP_RADIUS;
    const top = SHIP_PHYSICS.attack.maxSpeed * 2;
    expect(top * PHYSICS_SUBSTEP).toBeLessThan(target);

    // e comportamentalmente: varredura da seção de choque a dt absurdo.
    //
    // O detector é "a trajetória foi desviada em ALGUM momento", e não "o
    // estado FINAL tem vy ≠ 0". O detector antigo julgava o fim da viagem, e com
    // o acumulador guardando o excedente a mesma chamada de 1 s ou 3 s passou a
    // render 0,25 s de voo (antes rendia 0,1): em 40 chamadas a nave voava 10 s,
    // quicava pelo cinturão e terminava PARADA, v = (0, 0), em 2 dos 100
    // parâmetros de impacto — contada como "atravessou" apesar de ter batido já
    // na primeira chamada. Era o detector medindo a duração do voo.
    const sweep = (speed: number, dt: number, samples = 100) => {
      let missed = 0;
      for (let i = 0; i < samples; i++) {
        const b = ((i + 0.5) / samples) * target * 0.98;
        const s = makeShip({
          sx: small.sx, sy: small.sy, x: small.x - target - 400, y: small.y + b,
        });
        s.vx = speed;
        let deflected = false;
        for (let t = 0; t < 40 && !deflected; t++) {
          stepShipInWorld(s, COAST, dt, 1, { seed });
          deflected = Math.abs(s.vy) > 1e-9;
        }
        if (!deflected) missed++;
      }
      return missed / samples;
    };
    for (const dt of [1 / 60, 1 / 20, SIM_MAX_DT, 1.0, 3.0]) {
      expect(sweep(top, dt)).toBe(0);
    }
  });
});

describe("teto de dt: é propriedade da SIMULAÇÃO, não disciplina de quem chama", () => {
  const seed = 777;
  const at: WorldPos = { sx: beltSector, sy: 0, x: 5000, y: 5000 };

  it("SimWorld.tick limita o dt por dentro: um tick engasgado não salta o mundo", () => {
    // ANTES o teto só existia no render loop do cliente; o servidor passava o
    // deltaMs cru e ninguém percebeu por meses. Agora um dt absurdo entrega
    // EXATAMENTE o mesmo mundo que o dt no teto.
    const build = (dt: number) => {
      const w = new SimWorld(seed);
      const s = w.addShip("s", at, "p1", "attack");
      s.vx = 3000;
      w.tick(dt);
      return s;
    };
    const stalled = build(3.0);
    const capped = build(SIM_MAX_DT);
    expect(dist(stalled, capped)).toBe(0);
    expect(stalled.vx).toBe(capped.vx);
    expect(stalled.vy).toBe(capped.vy);
  });

  /**
   * Mundo com as DUAS fontes de recurso que o tick realmente credita: uma
   * mineradora pousada e ancorada (minério) e a base inicial (rações da Terra).
   * A versão anterior deste teste usava um QG — productionRate 0 em TODAS as
   * estruturas —, então comparava 0 com 0 e passaria com qualquer dt.
   */
  const econWorld = () => {
    const w = new SimWorld(seed);
    const m = w.addShip("m", at, "p1", "mining");
    m.landingPhase = "landed";
    m.anchored = true;
    w.addStructure({
      id: "base-0", type: "initialBase", owner: "p1", sx: beltSector, sy: 0, x: 9000, y: 9000,
      angle: 0, asteroidId: "", asteroidClass: "small" as const,
      shipBays: 6, expandedBays: 2, spiderBays: 0,
      nextShipBay: 0, nextSpiderBay: 0, oreStore: 0, rationStore: 0,
    });
    const read = () => ({ ore: w.getOre("p1"), rations: w.structures.get("base-0")!.rationStore });
    return { w, read };
  };

  it("o teto vale para a ECONOMIA também: engasgo não gera recurso de graça", () => {
    // o dt limitado entra em TUDO que o tick faz, não só na física — senão um
    // stall de 3 s renderia 3 s de produção num quadro
    const build = (dt: number) => {
      const { w, read } = econWorld();
      w.tick(dt);
      return read();
    };
    const capped = build(SIM_MAX_DT);
    expect(capped.ore).toBeGreaterThan(0); // as fontes são reais
    expect(capped.rations).toBeGreaterThan(0);
    expect(build(3.0)).toEqual(capped);
  });

  it("stepShipInWorld limita o dt por dentro (é a entrada da predição do cliente)", () => {
    const stalled = makeShip(at, "p1", "attack");
    const capped = makeShip(at, "p1", "attack");
    stepShipInWorld(stalled, THRUST, 3.0, 1, { seed });
    stepShipInWorld(capped, THRUST, SIM_MAX_DT, 1, { seed });
    expect(stalled).toEqual(capped);
  });

  it("stepShip limita o dt por dentro", () => {
    const stalled = makeShip(at, "p1", "attack");
    const capped = makeShip(at, "p1", "attack");
    stepShip(stalled, THRUST, 3.0);
    stepShip(capped, THRUST, SIM_MAX_DT);
    expect(stalled).toEqual(capped);
  });

  // ── o teto é da PENDÊNCIA: abaixo dele, o tempo não se perde ─────────
  // ANTES: `accum += min(dt, SIM_MAX_DT)` descartava o excedente de CADA quadro
  // lento — 5 chamadas de 0,2 s entregavam bem menos voo que 10 de 0,1 s, e a
  // 5 fps a predição perdia metade do relógio. As três entradas, pelo mesmo
  // critério: mesmo tempo total em pedaços diferentes ⇒ mesmos sub-passos ⇒
  // MESMO estado. Os pedaços incluem dt maiores que um tick e menores que um
  // sub-passo, e a sequência cruza contato (rocha, par de naves) de propósito.
  const kin = (s: ShipState) => ({ sx: s.sx, sy: s.sy, x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle, av: s.av });
  /** 1,2 s de relógio fatiados de jeitos diferentes, todos com pendência < teto */
  const SLICINGS: number[][] = [
    Array(12).fill(0.1),
    Array(6).fill(0.2),
    [0.24, 0.24, 0.24, 0.24, 0.24],
    Array(24).fill(0.05),
    [0.004, 0.2, 0.0166667, 0.1, 0.2, 0.004, 0.2, 0.0754, 0.24, 0.1599333],
  ];
  const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  it("as fatias do relógio somam o mesmo tempo (o cenário é o que diz ser)", () => {
    for (const sl of SLICINGS) {
      expect(total(sl)).toBeCloseTo(1.2, 9);
      expect(Math.max(...sl)).toBeLessThan(SIM_MAX_DT);
    }
  });

  it("stepShip: mesmo tempo total em fatias diferentes dá o MESMO voo", () => {
    const fly = (sl: number[]) => {
      const s = makeShip(at, "p1", "attack");
      for (const dt of sl) stepShip(s, THRUST, dt);
      return s;
    };
    const ref = fly(SLICINGS[0]);
    expect(speedOf(ref)).toBeGreaterThan(1000); // voou de verdade
    for (const sl of SLICINGS.slice(1)) expect(kin(fly(sl))).toEqual(kin(ref));
  });

  it("stepShipInWorld: idem, atravessando um quique na rocha", () => {
    const rock = sectorAsteroids(seed, beltSector, 0)[0];
    const fly = (sl: number[]) => {
      const s = makeShip(
        { sx: rock.sx, sy: rock.sy, x: rock.x - rock.radius - 1500, y: rock.y + 60 }, "p1", "attack",
      );
      s.vx = 3000;
      for (const dt of sl) stepShipInWorld(s, COAST, dt, 1, { seed });
      return s;
    };
    const ref = fly(SLICINGS[0]);
    expect(ref.vx).toBeLessThan(0); // bateu e voltou
    for (const sl of SLICINGS.slice(1)) expect(kin(fly(sl))).toEqual(kin(ref));
  });

  it("SimWorld.tick: idem, com par nave × nave e com a ECONOMIA junto", () => {
    const run = (sl: number[]) => {
      const { w, read } = econWorld();
      const a = w.addShip("a", { ...at, y: at.y + 3000 }, "p1", "attack");
      const b = w.addShip("b", { ...at, x: at.x + 1200, y: at.y + 3000 }, "p2", "transport");
      a.vx = 3000;
      for (const dt of sl) w.tick(dt);
      return { a: kin(a), b: kin(b), ...read() };
    };
    const ref = run(SLICINGS[0]);
    expect(ref.b.vx).toBeGreaterThan(0); // o par se tocou
    expect(ref.ore).toBeGreaterThan(0);
    for (const sl of SLICINGS.slice(1)) {
      const r = run(sl);
      expect({ a: r.a, b: r.b }).toEqual({ a: ref.a, b: ref.b });
      // o recurso é SOMADO fatia a fatia, e a soma em ponto flutuante depende
      // da ordem das parcelas: igualdade a 1e-9, não bit a bit
      expect(r.ore).toBeCloseTo(ref.ore, 9);
      expect(r.rations).toBeCloseTo(ref.rations, 9);
    }
  });

  it("a economia segue o tempo que a física GASTOU, nem mais nem menos", () => {
    // o dt da produção é steps × PHYSICS_SUBSTEP: quadros menores que um
    // sub-passo não produzem nada sozinhos, e o que ficou guardado no
    // acumulador é produzido quando vira sub-passo. Em 1 s de relógio a
    // diferença para o relógio exato é no máximo o resíduo em voo (< 1 sub-passo).
    const produce = (dt: number, n: number) => {
      const { w, read } = econWorld();
      for (let i = 0; i < n; i++) w.tick(dt);
      return read();
    };
    const second = produce(1 / 20, 20);
    expect(second.ore).toBeGreaterThan(0);
    // o MESMO relógio da física, ao sub-passo: um quadro que não completa
    // sub-passo nenhum não produz nada, e o que o completa produz exatamente um
    const { w, read } = econWorld();
    w.tick(0.004);
    expect(read()).toEqual({ ore: 0, rations: 0 });
    w.tick(PHYSICS_SUBSTEP - 0.004);
    expect(read().ore).toBeCloseTo(second.ore * PHYSICS_SUBSTEP, 12);
    expect(read().rations).toBeCloseTo(second.rations * PHYSICS_SUBSTEP, 12);
    for (const k of ["ore", "rations"] as const) {
      const oneStep = second[k] * PHYSICS_SUBSTEP;
      // quadros menores que um sub-passo (250 fps): nada se perde além do resíduo
      expect(Math.abs(produce(0.004, 250)[k] - second[k])).toBeLessThanOrEqual(oneStep + 1e-9);
      // quadros de 5 fps: nada se perde, ponto (era aqui que o min(dt, teto) comia)
      expect(produce(0.2, 5)[k]).toBeCloseTo(second[k], 9);
      // e um engasgo continua sem render de graça: 3 s de parede, 0,25 s de mundo
      expect(produce(3.0, 1)[k]).toBeCloseTo(second[k] * SIM_MAX_DT, 9);
    }
  });
});

describe("leme acima da rotação nominal: o limite governa o ALCANÇAR, não o DESFAZER", () => {
  it("torque CONTRÁRIO é sempre aplicado — reagir ao rodopio tem que ajudar", () => {
    // ANTES: `Math.max(s.av, rated)` ignorava o torque contrário. Com av = 8, o
    // jogador que SEGURAVA o leme contra ficava em 8,000 rad/s indefinidamente,
    // enquanto quem SOLTAVA se recuperava. Reagir certo era punido.
    const p = SHIP_PHYSICS.builder;
    const spun = () => {
      const s = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "builder");
      s.av = 8;
      return s;
    };
    const timeToNominal = (s: ReturnType<typeof spun>, turn: -1 | 0) => {
      for (let i = 0; i < 60 * 60; i++) {
        stepShip(s, { thrust: false, turn, mine: false }, 1 / 60);
        if (Math.abs(s.av) <= p.maxTurnRate) return i / 60;
      }
      return Infinity;
    };
    const held = timeToNominal(spun(), -1);
    const released = timeToNominal(spun(), 0);

    expect(held).toBeLessThan(Infinity); // antes: nunca
    // e SEGURAR tem que ser mais rápido que soltar — o leme (α) é mais forte
    // que a retenção do RCS (0,5·α), então a razão é ~2×
    expect(held).toBeLessThan(released);
    expect(released / held).toBeGreaterThan(1.8);
  });

  it("o leme desfaz o giro na sua autoridade CHEIA, mesmo muito acima da nominal", () => {
    const p = SHIP_PHYSICS.builder;
    const s = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "builder");
    s.av = 8;
    const h = 1 / 120;
    stepShip(s, { thrust: false, turn: -1, mine: false }, h);
    // α cheio, sem desconto por estar acima da nominal
    expect(s.av).toBeCloseTo(8 - p.angularAccel * h, 9);
  });

  it("mas o leme ainda NÃO consegue passar da nominal (limitador intacto)", () => {
    const p = SHIP_PHYSICS.attack;
    const s = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
    fly(s, TURN, 5);
    expect(s.av).toBeCloseTo(p.maxTurnRate, 6);
  });

  it("acima da nominal, o leme A FAVOR não piora o rodopio", () => {
    const s = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "builder");
    s.av = 8;
    fly(s, TURN, 2); // leme no mesmo sentido do giro
    expect(s.av).toBe(8); // não sobe nem desce: o motor de atitude fica saturado
  });

  it("um raspão a alta velocidade é recuperável, e mais rápido com o leme", () => {
    // conexão com o giro de impacto: um impacto de 6000 u/s numa aproximação de
    // 20° passa da rotação nominal de todas as classes. Se o leme morresse ali,
    // o caso comum de combate seria irrecuperável. (O cenário mede as DUAS
    // componentes de propósito: com atrito de Coulomb, "raspão forte" é o que
    // aperta forte contra a rocha, não o que passa rápido por ela.)
    const seed = 777;
    const rock = sectorAsteroids(seed, beltSector, 0)[0];
    for (const kind of ["builder", "attack", "transport"] as ShipKind[]) {
      const p = SHIP_PHYSICS[kind];
      const hit = () => {
        const s = makeShip(
          { sx: rock.sx, sy: rock.sy, x: rock.x + rock.radius, y: rock.y }, "p", kind,
        );
        s.vx = -6000 * Math.sin(Math.PI / 9);
        s.vy = 6000 * Math.cos(Math.PI / 9);
        collideShip(s, seed);
        return s;
      };
      const spun = hit();
      expect(Math.abs(spun.av)).toBeGreaterThan(p.maxTurnRate); // acima da nominal
      const settle = (s: ReturnType<typeof hit>, turn: -1 | 0) => {
        for (let i = 0; i < 60 * 60; i++) {
          stepShip(s, { thrust: false, turn, mine: false }, 1 / 60);
          if (Math.abs(s.av) <= p.maxTurnRate) return i / 60;
        }
        return Infinity;
      };
      const held = settle(hit(), -1);
      const released = settle(hit(), 0);
      expect(held).toBeLessThan(released);
      // o leme desfaz na autoridade CHEIA (α da ficha): o tempo é o que a conta
      // dá, a menos de um quadro. Com k fisicamente plausível o impacto gira
      // mais que antes, e o cargueiro leva ~2,7 s — é o preço de ter a massa
      // DENTRO do casco, e o teto de giro (12 rad/s) o limita
      const av0 = Math.abs(hit().av);
      expect(Math.abs(held - (av0 - p.maxTurnRate) / p.angularAccel)).toBeLessThan(2 / 60);
    }
  });
});

describe("o governor NÃO vaza: empuxo de través não engorda |v|", () => {
  it("com o auxílio DESLIGADO, cinco minutos de empuxo a 90° não sobem |v|", () => {
    // ANTES: o resíduo de segunda ordem da soma de Euler valia +1,70 u/s² sem
    // teto — de 6000 para 6511 u/s em 5 min. Com o auxílio ligado o trim comia
    // o vazamento e escondia o defeito; desligado, ele aparecia inteiro.
    const p = SHIP_PHYSICS.attack;
    const s = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
    s.vx = p.maxSpeed;
    s.angle = Math.PI / 2; // nariz a 90° da velocidade, empuxo perpendicular
    let peak = p.maxSpeed;
    for (let i = 0; i < 60 * 300; i++) {
      stepShip(s, { thrust: true, turn: 0, mine: false, assistOff: true }, 1 / 60);
      peak = Math.max(peak, speedOf(s));
    }
    expect(peak).toBeLessThanOrEqual(p.maxSpeed + 1e-6);
    expect(speedOf(s)).toBeCloseTo(p.maxSpeed, 6);
  });

  it("o mesmo vale para o RCS lateral, que também empurra de través", () => {
    const p = SHIP_PHYSICS.attack;
    const s = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
    s.vx = p.maxSpeed;
    let peak = p.maxSpeed;
    for (let i = 0; i < 60 * 120; i++) {
      stepShip(s, { thrust: false, turn: 0, mine: false, strafe: 1, assistOff: true }, 1 / 60);
      peak = Math.max(peak, speedOf(s));
    }
    expect(peak).toBeLessThanOrEqual(p.maxSpeed + 1e-6);
  });

  it("e o corte NUNCA desce abaixo do |v| de entrada: não virou freio", () => {
    // acima da nominal, com empuxo perpendicular e sem auxílio, o módulo tem
    // que ficar PARADO no valor de entrada — nem subir (vazamento) nem descer
    // (freio escondido)
    const s = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
    s.vx = 8400;
    s.angle = Math.PI / 2;
    for (let i = 0; i < 600; i++) {
      stepShip(s, { thrust: true, turn: 0, mine: false, assistOff: true }, 1 / 60);
    }
    expect(speedOf(s)).toBeCloseTo(8400, 6);
  });

  it("mas o vetor GIROU: fechar o módulo não matou a autoridade de manobra", () => {
    const s = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
    s.vx = 8400;
    s.angle = Math.PI / 2;
    fly(s, { thrust: true, turn: 0, mine: false, assistOff: true }, 1);
    expect(s.vy).toBeGreaterThan(1000); // empurrou de verdade para o lado
    expect(Math.atan2(s.vy, s.vx)).toBeGreaterThan(0.15); // e o rumo mudou
  });
});

describe("contato leva ω×r: a casca é que raspa, não o centro de massa", () => {
  const seed = 777;
  const rock = sectorAsteroids(seed, beltSector, 0)[0];
  /**
   * `vn` fundo o bastante para o atrito GRUDAR (μ·|jn| cobre o deslizamento):
   * é o regime em que a magnitude do impulso tangencial depende de ω.
   */
  const stick = (av0: number, vt = 100) => {
    const s = makeShip({ sx: rock.sx, sy: rock.sy, x: rock.x + rock.radius, y: rock.y }, "p", "builder");
    s.vx = -3000;
    s.vy = vt;
    s.av = av0;
    collideShip(s, seed);
    return s;
  };
  /** raspão de verdade: o atrito DESLIZA, saturado em μ·|jn|. */
  const graze = (av0: number, vt = 3000) => {
    const s = makeShip({ sx: rock.sx, sy: rock.sy, x: rock.x + rock.radius, y: rock.y }, "p", "builder");
    s.vx = -100;
    s.vy = vt;
    s.av = av0;
    collideShip(s, seed);
    return s;
  };

  it("no regime que GRUDA, a MAGNITUDE do atrito depende de ω", () => {
    // ANTES: raspar com av = +5, 0 ou −5 dava exatamente o mesmo resultado
    // tangencial, e av saía intacto. A rotação simplesmente não participava.
    const spinning = stick(5);
    const still = stick(0);
    const counter = stick(-5);
    expect(spinning.vy).not.toBeCloseTo(still.vy, 3);
    expect(counter.vy).not.toBeCloseTo(still.vy, 3);
    // a casca que gira A FAVOR do deslizamento raspa menos e perde menos vy
    expect(spinning.vy).toBeGreaterThan(still.vy);
    expect(counter.vy).toBeLessThan(still.vy);
  });

  it("no regime que DESLIZA, o SENTIDO do atrito segue a casca, não o centro de massa", () => {
    // Atrito seco: escorregando, a magnitude é μ·|jn| e não depende mais de
    // quão rápido escorrega — mas o SENTIDO é o do escorregão da CASCA, que
    // leva ω×r. Uma nave girando rápido o bastante inverte o próprio atrito, e
    // isso um modelo sem ω×r não tem como produzir de jeito nenhum.
    const still = graze(0, 100); // casca desliza para +y → atrito empurra −y
    const fast = graze(10, 100); // ω·R = 200 > 100 → a casca desliza para −y
    expect(still.vy).toBeLessThan(100);
    expect(fast.vy).toBeGreaterThan(100);
    // e o tranco de rotação inverte junto: o contato freia o pião
    expect(Math.abs(fast.av)).toBeLessThan(10);
  });

  it("a componente NORMAL continua indiferente ao giro (ω×r é tangencial)", () => {
    // isto não é defeito: girar não aproxima nem afasta a casca da parede
    expect(graze(5).vx).toBeCloseTo(graze(0).vx, 9);
    expect(graze(-5).vx).toBeCloseTo(graze(0).vx, 9);
  });

  it("o contato REMOVE rotação, e não só adiciona: um pião encostado freia", () => {
    // era o buraco central: nenhum contato do modelo tirava giro de ninguém
    for (const av0 of [8, 3, -3, -8]) {
      const s = makeShip({ sx: rock.sx, sy: rock.sy, x: rock.x + rock.radius, y: rock.y }, "p", "builder");
      s.vx = -20; // encosta devagar, sem deslizamento de translação
      s.av = av0;
      collideShip(s, seed);
      expect(Math.abs(s.av)).toBeLessThan(Math.abs(av0));
      expect(Math.sign(s.av)).toBe(Math.sign(av0)); // freia, não inverte
    }
  });

  it("o pião encostado também ROLA: a casca empurra a nave na tangente", () => {
    const s = makeShip({ sx: rock.sx, sy: rock.sy, x: rock.x + rock.radius, y: rock.y }, "p", "builder");
    s.vx = -20;
    s.av = 8;
    collideShip(s, seed);
    expect(s.vy).toBeGreaterThan(0); // girar contra a parede move a nave
  });

  it("o atrito reparte entre transladar e TORCER (inércia efetiva 1 + R²/k²)", () => {
    const k = SHIP_PHYSICS.builder.gyration;
    const lever = (SHIP_RADIUS * SHIP_RADIUS) / (k * k);
    // 50 u/s: pequeno o bastante para o tranco (R·jt/k²) ficar na faixa LINEAR
    // de giro — acima dela a assíntota escala o impulso inteiro (ver spinShare)
    const vt = 50;
    const s = stick(0, vt); // regime que gruda: o deslizamento morre inteiro
    // jt = -vt_casca/(1 + R²/k²) e Δω = -R·jt/k²
    const jt = vt / (1 + lever);
    expect(vt - s.vy).toBeCloseTo(jt, 6); // e o que sobra na tangente é o resto
    expect(Math.abs(s.av)).toBeCloseTo((SHIP_RADIUS * jt) / (k * k), 6);
    expect(Math.abs(s.av)).toBeLessThan(IMPACT_SPIN_LINEAR); // faixa linear
  });

  it("dois cascos raspando giram no MESMO sentido, não em sentidos opostos", () => {
    // o atrito pega `a` de um lado do seu centro e `b` do lado oposto do dele,
    // e as forças são opostas: os dois torques caem no mesmo sinal. O código
    // anterior invertia o de `a`.
    const a = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
    const b = makeShip({ sx: beltSector, sy: 0, x: 5000 + SHIP_RADIUS, y: 5000 + SHIP_RADIUS }, "p", "attack");
    a.vx = 3000;
    collideShipPair(a, b);
    expect(a.av).not.toBe(0);
    expect(Math.sign(a.av)).toBe(Math.sign(b.av));
  });

  it("no par, a rotação dos DOIS entra na velocidade relativa da superfície", () => {
    const pair = (avA: number, avB: number) => {
      const a = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
      const b = makeShip({ sx: beltSector, sy: 0, x: 5000 + SHIP_RADIUS, y: 5000 }, "p", "attack");
      a.vx = 2000;
      a.vy = 40; // deslizamento tangencial pequeno: o atrito GRUDA
      a.av = avA;
      b.av = avB;
      collideShipPair(a, b);
      return { a, b };
    };
    const still = pair(0, 0);
    const spinA = pair(6, 0);
    const spinB = pair(0, 6);
    expect(spinA.b.vy).not.toBeCloseTo(still.b.vy, 3);
    expect(spinB.b.vy).not.toBeCloseTo(still.b.vy, 3);
    // e o momento linear continua conservado com rotação no meio
    const m = SHIP_PHYSICS.attack.mass;
    expect(spinA.a.vy * m + spinA.b.vy * m).toBeCloseTo(40 * m, 6);
  });
});

describe("paridade cliente × servidor no contato nave × nave", () => {
  const seed = 999;
  const at: WorldPos = { sx: beltSector, sy: 0, x: 5000, y: 5000 };
  const DT = 1 / 20;
  const TICKS = 8;

  /** Cenário: um caça a 4000 u/s entra num cargueiro parado. */
  const scenario = () => {
    const w = new SimWorld(seed);
    const a = w.addShip("A", at, "p1", "attack");
    const b = w.addShip("B", { ...at, x: at.x + 900 }, "p2", "transport");
    a.vx = 4000;
    return { w, a, b };
  };

  /**
   * Prediz só a própria nave e ressincroniza o snapshot da outra a cada estado
   * do servidor — mas com UMA chamada por snapshot (20 Hz contra 20 Hz). O
   * cliente real roda vários quadros por snapshot; essa cadência, na matriz
   * 4×4, está em "a predição do cliente não escreve no snapshot autoritativo".
   */
  const predict = (snapshots: Array<{ x: number; vx: number }>, withContacts: boolean) => {
    const a = makeShip(at, "p1", "attack");
    a.vx = 4000;
    for (const snap of snapshots) {
      const other = {
        sx: at.sx, sy: at.sy, x: snap.x, y: at.y,
        vx: snap.vx, vy: 0, kind: "transport" as ShipKind, cargoAmount: 0,
      };
      stepShipInWorld(a, COAST, DT, 1, {
        seed,
        contacts: withContacts ? [other] : undefined,
      });
    }
    return a;
  };

  it("a predição resolve o MESMO contato que o servidor", () => {
    const srv = scenario();
    const snapshots: Array<{ x: number; vx: number }> = [];
    for (let i = 0; i < TICKS; i++) {
      snapshots.push({ x: srv.b.x, vx: srv.b.vx });
      srv.w.tick(DT);
    }
    const withContacts = predict(snapshots, true);
    const without = predict(snapshots, false);

    // o contato aconteceu de verdade: o caça foi rebatido
    expect(srv.a.vx).toBeLessThan(0);

    // ANTES: uma única colisão não predita divergia 624 u e 4633 u/s em 0,2 s,
    // e o blend de 0,1 por frame levava quase um segundo maquiando o erro.
    expect(dist(srv.a, without)).toBeGreaterThan(100);
    // AGORA: a predição bate com o autoritativo dentro de um raio de casco
    expect(dist(srv.a, withContacts)).toBeLessThan(SHIP_RADIUS);
    expect(Math.abs(srv.a.vx - withContacts.vx)).toBeLessThan(1);
    // e a melhora é de ordem de grandeza, não de ajuste fino
    expect(dist(srv.a, withContacts)).toBeLessThan(dist(srv.a, without) / 100);
  });

  it("sem `contacts` o comportamento é o de antes (o campo é opt-in)", () => {
    const a = makeShip(at, "p1", "attack");
    const b = makeShip(at, "p1", "attack");
    a.vx = 3000;
    b.vx = 3000;
    for (let i = 0; i < 40; i++) {
      stepShipInWorld(a, THRUST, DT, 1, { seed });
      stepShipInWorld(b, THRUST, DT, 1, { seed, contacts: [] });
    }
    expect(a).toEqual(b);
  });
});

describe("fronteira × rocha: a matéria tem a última palavra", () => {
  const seed = 777;
  const rock = sectorAsteroids(seed, beltSector, 0)[0];
  // fronteira cujo raio passa EXATAMENTE pelo centro da rocha: metade dela fica
  // fora da arena. Não é canto exótico — com raio de 500 000 u a borda corta o
  // cinturão, então esta é a geometria normal da arena.
  const R = 3 * SECTOR_SIZE;
  const center: WorldPos = { sx: rock.sx - 3, sy: rock.sy, x: rock.x, y: rock.y };

  it("o raio da fronteira realmente corta a rocha (o cenário é o que diz ser)", () => {
    expect(dist(center, rock)).toBeCloseTo(R, 6);
    expect(rock.radius).toBeGreaterThan(100);
  });

  it("a nave NÃO repousa dentro da rocha quando a borda da arena a corta", () => {
    // ANTES: clampToBoundary rodava DEPOIS de collideShip e dava a última
    // palavra, então a nave assentava 20,0 u dentro da pedra — o raio inteiro
    // do casco, dentro de matéria sólida, para sempre.
    for (const [ox, oy] of [[10, 0], [30, 120], [5, -200], [-40, 60]]) {
      const ship = makeShip(
        { sx: rock.sx, sy: rock.sy, x: rock.x + ox, y: rock.y + oy }, "p", "builder",
      );
      for (let i = 0; i < 200; i++) {
        stepShipInWorld(ship, COAST, 1 / 20, 1, {
          seed, boundaryCenter: center, boundaryRadius: R,
        });
      }
      expect(speedOf(ship)).toBeLessThan(1); // assentou, não ficou vibrando
      // e assentou FORA da pedra
      expect(dist(rock, ship)).toBeGreaterThanOrEqual(rock.radius + SHIP_RADIUS - 1e-6);
    }
  });

  it("o preço declarado é sair um pouco da linha da fronteira, nunca entrar na pedra", () => {
    // entalada entre a rocha e a borda, a nave assenta na SUPERFÍCIE da rocha,
    // o que pode deixá-la além do raio da arena. É o lado certo para errar:
    // lá fora não há nada sólido, aqui dentro há.
    const ship = makeShip({ sx: rock.sx, sy: rock.sy, x: rock.x + 10, y: rock.y }, "p", "builder");
    for (let i = 0; i < 200; i++) {
      stepShipInWorld(ship, COAST, 1 / 20, 1, {
        seed, boundaryCenter: center, boundaryRadius: R,
      });
    }
    expect(dist(rock, ship)).toBeGreaterThanOrEqual(rock.radius + SHIP_RADIUS - 1e-6);
    // o excesso é limitado pela geometria: no máximo a seção de choque da rocha
    expect(dist(center, ship) - R).toBeLessThanOrEqual(rock.radius + SHIP_RADIUS + 1e-6);
  });

  it("longe de rocha, a fronteira continua contendo normalmente", () => {
    const ship = makeShip({ sx: center.sx + 4, sy: center.sy, x: center.x, y: center.y }, "p", "builder");
    ship.vx = 3000;
    for (let i = 0; i < 40; i++) {
      stepShipInWorld(ship, COAST, 1 / 20, 1, { boundaryCenter: center, boundaryRadius: R });
    }
    expect(dist(center, ship)).toBeLessThanOrEqual(R + 1);
  });
});

describe("giro de impacto ESCALA com o impulso tangencial", () => {
  const seed = 777;
  const rock = sectorAsteroids(seed, beltSector, 0)[0];
  /**
   * Impacto a `v` u/s numa aproximação FIXA de 20°: devolve o giro impresso.
   *
   * O ângulo é fixo e a VELOCIDADE varia, e isso é deliberado. A versão
   * anterior fixava a normal em −100 u/s e variava só a tangente, o que num
   * modelo de Coulomb não é "raspão mais forte" — é o mesmo aperto contra a
   * parede com o casco passando mais rápido, e aí o atrito satura em μ·|jn| e
   * não tem por que crescer. Bater mais forte é bater mais forte nas DUAS
   * componentes.
   */
  const graze = (v: number, kind: ShipKind = "builder") => {
    const s = makeShip({ sx: rock.sx, sy: rock.sy, x: rock.x + rock.radius, y: rock.y }, "p", kind);
    s.vx = -v * Math.sin(Math.PI / 9);
    s.vy = v * Math.cos(Math.PI / 9);
    collideShip(s, seed);
    return Math.abs(s.av);
  };

  it("impactos mais fortes giram mais — em TODA a faixa que o jogo usa", () => {
    // ANTES: IMPACT_SPIN_MAX = 1,2 saturava acima de 484 u/s tangenciais, ou
    // seja, em praticamente todo contato real. Raspar de leve e capotar a
    // 6 km/s davam EXATAMENTE o mesmo rodopio — um teto que sempre satura
    // deixou de ser teto e virou valor fixo.
    const speeds = [200, 500, 1000, 2000, 4000, 6000, 12_000];
    const spins = speeds.map((v) => graze(v));
    for (let i = 1; i < spins.length; i++) {
      expect(spins[i]).toBeGreaterThan(spins[i - 1]);
    }
    // e a separação é grande o bastante para o jogador SENTIR, não 1%
    expect(spins[spins.length - 1] / spins[0]).toBeGreaterThan(10);
    // dobrar o impacto na faixa de cruzeiro ainda muda o resultado de verdade
    expect(graze(4000) / graze(2000)).toBeGreaterThan(1.3);
  });

  it("o CONTATO SUSTENTADO também respeita a assíntota, e é ele que importa", () => {
    // ESTE é o teste que estava medindo a coisa errada. A versão anterior
    // chamava `collideShip` UMA vez, via 12,0000 a 100 000 u/s e declarava
    // "assíntota, nunca ultrapassada". Só que contato real dura dezenas de
    // sub-passos, e o teto valia por CHAMADA: encostado numa rocha a 4000 u/s
    // tangenciais, 400 sub-passos levavam av a 74,17 rad/s — 6,2× a assíntota,
    // 11,8 voltas por segundo. O número que o teste travava era o número que o
    // autor queria ver, não o que o jogador sofria.
    const sustained = (vt: number, vn: number, steps: number) => {
      const s = makeShip(
        { sx: rock.sx, sy: rock.sy, x: rock.x + rock.radius - 1, y: rock.y }, "p", "builder",
      );
      s.vy = vt;
      let peak = 0;
      let toHalf = Infinity;
      for (let i = 0; i < steps; i++) {
        s.vx = vn; // o piloto segura a nave contra a rocha: contato que não acaba
        collideShip(s, seed);
        peak = Math.max(peak, Math.abs(s.av));
        if (toHalf === Infinity && peak >= IMPACT_SPIN_MAX / 2) toHalf = i;
      }
      return { av: s.av, peak, toHalf };
    };
    for (const vt of [1000, 4000, 20_000]) {
      for (const vn of [-5, -50, -500]) {
        // ≤, não <: no contínuo a curva nunca encosta, mas em ponto flutuante,
        // com tranco acumulado acima de ~330 rad/s, arredonda para o teto
        expect(sustained(vt, vn, 600).peak).toBeLessThanOrEqual(IMPACT_SPIN_MAX);
      }
    }
    // Contato longo o bastante encosta na assíntota — é o que "assíntota" quer
    // dizer, e é o preço de o rodopio ser recuperável por contrato. O que
    // separa um contato do outro é o TEMPO de chegar lá, e ele segue o APERTO
    // contra a rocha, não a velocidade de passagem: em atrito seco escorregando,
    // o impulso tangencial é μ·|jn| e o escorregão só decide o sentido. Raspar
    // de leve por muito tempo tem que ser barato.
    expect(sustained(4000, -500, 2000).toHalf).toBeLessThan(
      sustained(4000, -5, 2000).toHalf / 10,
    );
    // e a assinatura do Coulomb, medida: dobrar a velocidade tangencial não
    // muda a taxa de rodopio; dobrar o aperto muda
    expect(sustained(4000, -50, 2000).toHalf).toBe(sustained(1000, -50, 2000).toHalf);
    // um impacto ISOLADO continua saindo exatamente como antes (a saturação
    // passou a ser do contato, mas a partir do repouso é a mesma curva)
    for (const v of [6000, 20_000, 100_000]) expect(graze(v)).toBeLessThanOrEqual(IMPACT_SPIN_MAX);
    // e a assíntota é alta o bastante para não achatar a faixa útil, mas
    // recuperável: o RCS do caça anula a assíntota inteira em poucos segundos
    expect(IMPACT_SPIN_MAX / SHIP_PHYSICS.attack.attitudeHold).toBeLessThan(3);
  });

  it("o contato longo NÃO sangra rotação de graça quando o atrito é zero", () => {
    // contrapartida do teste acima: saturar a SOMA (e não cada tranco) tem que
    // ser invariante por deslocamento, senão milhares de sub-passos de contato
    // sem atrito nenhum comeriam o giro em silêncio — o mesmo tipo de freio
    // escondido que o modelo já expulsou duas vezes.
    const center: WorldPos = { sx: beltSector, sy: 0, x: 5000, y: 5000 };
    const R = 200_000;
    const s = makeShip({ sx: beltSector, sy: 0, x: 5000 + R, y: 5000 }, "p", "builder");
    s.vy = 4000;
    s.av = 8;
    const ASSIST_OFF: ShipInput = { thrust: false, turn: 0, mine: false, assistOff: true };
    for (let i = 0; i < 600; i++) {
      stepShipInWorld(s, ASSIST_OFF, 1 / 60, 1, { boundaryCenter: center, boundaryRadius: R });
    }
    expect(s.av).toBe(8); // exatamente, não "quase"
  });

  it("o raio de giração ainda manda: casco curto capota mais fácil", () => {
    expect(graze(1000, "attack")).toBeGreaterThan(graze(1000, "transport"));
  });

  it("nave × nave também escala com o impulso tangencial", () => {
    const bump = (v: number) => {
      const a = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
      const b = makeShip({ sx: beltSector, sy: 0, x: 5000 + SHIP_RADIUS, y: 5000 + SHIP_RADIUS }, "p", "attack");
      a.vx = v;
      collideShipPair(a, b);
      return Math.abs(b.av);
    };
    expect(bump(4000)).toBeGreaterThan(bump(2000) * 1.3);
    expect(bump(2000)).toBeGreaterThan(bump(1000) * 1.3);
  });
});

describe("flight assist off: o auxílio tem interruptor", () => {
  const ASSIST_OFF: ShipInput = { thrust: false, turn: 0, mine: false, assistOff: true };

  it("desligado, o momento angular é CONSERVADO — nada o come", () => {
    // ANTES: 3 rad/s morriam em 0,43 s de graça, sem como desligar.
    const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "builder");
    ship.av = 3;
    fly(ship, ASSIST_OFF, 5);
    expect(ship.av).toBe(3); // exatamente, não "quase"
    expect(ship.angle).toBeCloseTo(15, 6); // e rodou 3 rad/s × 5 s
  });

  it("desligado, o trim linear some junto: deriva TOTAL, como no vácuo", () => {
    const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "builder");
    ship.vx = 4000;
    fly(ship, ASSIST_OFF, 5);
    expect(ship.vx).toBe(4000);
  });

  it("o padrão é LIGADO: sem a flag, tudo se comporta como sempre", () => {
    const p = SHIP_PHYSICS.builder;
    const ship = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "builder");
    ship.av = 3;
    ship.vx = 4000;
    fly(ship, COAST, 5);
    expect(ship.av).toBe(0); // o RCS segurou a atitude
    expect(speedOf(ship)).toBeCloseTo(4000 - p.assistDecel * 5, 3); // e o trim agiu
  });

  it("o interruptor tira o AUXÍLIO, não a autoridade: leme e RCS seguem inteiros", () => {
    const p = SHIP_PHYSICS.builder;
    // leme com assist off acelera igual (é torque de manobra, não auxílio)
    const helm = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "builder");
    fly(helm, { thrust: false, turn: 1, mine: false, assistOff: true }, 0.2);
    expect(helm.av).toBeCloseTo(p.angularAccel * 0.2, 6);

    // e o RCS de translação é empuxo PEDIDO pelo piloto: não passa pelo
    // interruptor de auxílio. Com ele desligado sai o valor cheio (sem trim).
    const rcs = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "builder");
    fly(rcs, { thrust: false, turn: 0, mine: false, strafe: 1, assistOff: true }, 1);
    expect(rcs.vy).toBeCloseTo(p.rcsAccel, 4);
  });

  it("continua reprodutível com a flag oscilando no meio do voo", () => {
    const run = () => {
      const s = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
      for (let i = 0; i < 300; i++) {
        stepShip(s, {
          thrust: i % 3 === 0, turn: (i % 7 < 3 ? 1 : -1) as 1 | -1, mine: false,
          strafe: (i % 5 === 0 ? 1 : 0) as 0 | 1, retro: i % 11 === 0,
          assistOff: i % 13 < 6,
        }, 1 / 60);
      }
      return s;
    };
    expect(run()).toEqual(run());
  });
});

describe("atrito é de COULOMB: |jt| tem que caber em μ·|jn|", () => {
  const seed = 777;
  const rock = sectorAsteroids(seed, beltSector, 0)[0];
  /** um contato só; devolve os dois impulsos por unidade de massa. */
  const hit = (vn: number, vt: number) => {
    const s = makeShip({ sx: rock.sx, sy: rock.sy, x: rock.x + rock.radius, y: rock.y }, "p", "builder");
    s.vx = vn;
    s.vy = vt;
    collideShip(s, seed);
    return { jn: Math.abs(s.vx - vn), jt: Math.abs(s.vy - vt), out: s };
  };

  it("a razão |jt|/|jn| nunca passa de μ, em toda a faixa de aproximação", () => {
    // ANTES: `jt` era 0,06·vt e NÃO olhava para a normal. Com vn = −0,2 u/s a
    // razão dava 565 — o contato inventava um impulso tangencial 565× maior que
    // o normal que o sustentava, o que não é atrito, é um amortecedor viscoso.
    for (const vn of [-4000, -2000, -500, -100, -40, -5, -0.2, -0.001]) {
      const r = hit(vn, 3000);
      expect(r.jt).toBeLessThanOrEqual(r.jn * ASTEROID_SURFACE_FRICTION + 1e-9);
    }
  });

  it("encostar de leve NÃO custa o mesmo que capotar", () => {
    // ANTES: o MESMO Δvt = −113,09 saía de vn = −2000 e de vn = −0,2.
    const hard = hit(-2000, 3000);
    const soft = hit(-0.2, 3000);
    expect(hard.jt / soft.jt).toBeGreaterThan(1000);
    // e o atrito escala com a normal, que é o que "de Coulomb" quer dizer. O par
    // de aproximações fica dentro da faixa LINEAR de giro (tranco rígido ≤ 3
    // rad/s no builder): acima dela a assíntota escala o impulso tangencial
    // inteiro, linear e angular juntos — ver "a assíntota de giro não quebra
    // a ligação impulso ↔ momento angular".
    expect(hit(-800, 3000).jt / hit(-400, 3000).jt).toBeCloseTo(2, 6);
  });

  it("quando a normal dá conta, o atrito GRUDA: o deslizamento morre inteiro", () => {
    const k = SHIP_PHYSICS.builder.gyration;
    const lever = (SHIP_RADIUS * SHIP_RADIUS) / (k * k);
    const r = hit(-3000, 50); // μ·|jn| ≫ o que o deslizamento pede (e o giro fica na faixa linear)
    expect(r.jt).toBeCloseTo(50 / (1 + lever), 6);
    expect(r.jt).toBeLessThan(r.jn * ASTEROID_SURFACE_FRICTION);
  });

  it("o atrito nunca INVERTE o deslizamento nem cria energia", () => {
    for (const vn of [-4000, -800, -100, -10, -1]) {
      for (const vt of [10, 100, 1000, 6000]) {
        const before = 0.5 * (vn * vn + vt * vt);
        const r = hit(vn, vt);
        expect(r.out.vy).toBeGreaterThanOrEqual(0); // freou, não empurrou de volta
        expect(r.out.vy).toBeLessThanOrEqual(vt + 1e-9);
        // energia: a normal pode devolver até e², o atrito só tira
        const after = 0.5 * (r.out.vx * r.out.vx + r.out.vy * r.out.vy);
        const emax = SHIP_PHYSICS.builder.restitution * ASTEROID_SURFACE_RESTITUTION;
        expect(after).toBeLessThanOrEqual(before * Math.max(1, emax * emax) + 1e-6);
      }
    }
  });

  it("casco contra casco agarra MENOS que rocha nua, e também com teto", () => {
    const a = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
    const b = makeShip({ sx: beltSector, sy: 0, x: 5000 + SHIP_RADIUS, y: 5000 }, "p", "attack");
    a.vx = 2000;
    a.vy = 6000; // deslizamento enorme: o teto de Coulomb é quem manda
    const before = { vx: a.vx, vy: a.vy };
    collideShipPair(a, b);
    const jn = Math.abs(a.vx - before.vx);
    const jt = Math.abs(a.vy - before.vy);
    expect(jt).toBeLessThanOrEqual(jn * HULL_FRICTION + 1e-9);
    expect(HULL_FRICTION).toBeLessThan(ASTEROID_SURFACE_FRICTION);
  });
});

describe("a fronteira da arena é CAMPO, não lixa", () => {
  const R_CASES = [80_000, 200_000, 500_000]; // os três tamanhos reais de mapa
  const center: WorldPos = { sx: beltSector, sy: 0, x: 5000, y: 5000 };
  /** voa `seconds` raspando a fronteira, tangencialmente, sem tocar em rocha. */
  const skim = (R: number, vt: number, input: ShipInput, seconds = 10) => {
    const s = makeShip({ sx: beltSector, sy: 0, x: 5000 + R, y: 5000 }, "p", "builder");
    s.vy = vt;
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      stepShipInWorld(s, input, 1 / 60, 1, { boundaryCenter: center, boundaryRadius: R });
    }
    return s;
  };

  it("raspar a borda por 10 s não come a velocidade nem impõe rodopio", () => {
    // ANTES, com auxílio LIGADO e nos TRÊS raios de arena: 1000 u/s tangenciais
    // saíam em 0,00 u/s com av = 15,75, e 4000 u/s deixavam 26% da velocidade
    // com av = 80,67 rad/s — 12,8 voltas por segundo, 7,5× o próprio
    // IMPACT_SPIN_MAX, 11,6 s de RCS para anular. Raspar a fronteira custava a
    // nave, e a fronteira é geometria normal do mapa, não canto exótico.
    const p = SHIP_PHYSICS.builder;
    for (const R of R_CASES) {
      for (const vt of [1000, 4000]) {
        const s = skim(R, vt, COAST);
        // o único gasto legítimo em 10 s é o trim assistido, e ele é declarado
        const trim = p.assistDecel * 10;
        expect(speedOf(s)).toBeGreaterThan(vt - trim - 1);
        expect(s.av).toBe(0); // campo não torce nada
      }
    }
  });

  it("sem auxílio nenhum, a fronteira devolve a nave sem cobrar pedágio", () => {
    const ASSIST_OFF: ShipInput = { thrust: false, turn: 0, mine: false, assistOff: true };
    for (const R of R_CASES) {
      const s = skim(R, 4000, ASSIST_OFF);
      // > 99,9%: o que resta é a curvatura da borda (a normal gira sob a nave),
      // não atrito — e é erro de discretização, não modelo
      expect(speedOf(s)).toBeGreaterThan(4000 * 0.999);
      expect(s.av).toBe(0);
    }
  });

  it("mas ela CONTÉM: a nave continua sem sair da arena", () => {
    for (const R of R_CASES) {
      const s = skim(R, 4000, COAST);
      expect(dist(center, s)).toBeLessThanOrEqual(R + 1);
    }
  });

  it("o μ da borda é zero DE PROPÓSITO, e o da rocha não é", () => {
    expect(BOUNDARY_SURFACE_FRICTION).toBe(0);
    expect(ASTEROID_SURFACE_FRICTION).toBeGreaterThan(0);
  });
});

describe("a predição do cliente não escreve no snapshot autoritativo", () => {
  const at: WorldPos = { sx: beltSector, sy: 0, x: 5000, y: 5000 };

  it("20 frames de contato predito deixam o snapshot BIT A BIT igual", () => {
    // REINCIDÊNCIA: apontado na rodada 2 (Δx = 9,0 u e Δvx = 1318 u/s por frame
    // de contato), consertado do lado do cliente, e voltou. Agora a garantia é
    // do sim-core: o par é resolvido contra um FANTASMA, cópia local do snapshot.
    const me = makeShip(at, "p1", "attack");
    me.vx = 4000;
    const snap = {
      sx: at.sx, sy: at.sy, x: at.x + 900, y: at.y,
      vx: 0, vy: 0, av: 0, kind: "transport" as ShipKind, cargoAmount: 0,
    };
    const before = { ...snap };
    for (let i = 0; i < 20; i++) {
      stepShipInWorld(me, COAST, 1 / 60, 1, { seed: 999, contacts: [snap] });
    }
    expect(snap).toEqual(before);
    expect(me.vx).toBeLessThan(0); // e o contato aconteceu de verdade
  });

  // ── paridade na condição de CAMPO: snapshot com idade, na matriz inteira ──
  // O cliente prediz a própria nave a 60 Hz; o servidor avança a 20 Hz; cada
  // estado do servidor chega ao cliente `lat` segundos depois de acontecer, num
  // objeto NOVO, e fica em uso até chegar o seguinte. Ou seja: o snapshot que a
  // predição usa tem entre `lat` e `lat + 50 ms` de idade — nunca zero, a não
  // ser com latência zero. As versões anteriores deste teste consumiam o
  // snapshot no mesmo tick em que ele era tirado (idade zero), uma cadência que
  // o jogo não tem.
  //
  // Histórico do que ele pega (medido, não suposto):
  //  · par contra o snapshot congelado: razão Δv predito/servidor 1,083–2,758;
  //  · fantasma recriado a cada quadro: até 1,67 (e 0,004 com o alvo andando);
  //  · fantasma persistente mas nascendo NA IDADE do snapshot (medido pelo
  //    crítico): 0,44–1,48 a 16 ms, 0,65–2,60 a 50–75 ms, até 586 u de erro;
  //  · adiantado pela idade mas SEM ids: o snapshot de antes do choque
  //    ressuscitava o outro casco e o choque se repetia — até 1,81 a 75 ms.
  const KINDS: ShipKind[] = ["builder", "mining", "attack", "transport"];
  const snapOf = (B: ShipState) => Object.freeze({
    sx: B.sx, sy: B.sy, x: B.x, y: B.y, vx: B.vx, vy: B.vy, av: B.av,
    kind: B.kind, cargoAmount: B.cargoAmount,
  });
  /**
   * `lat`: latência de chegada (s); `ageOf`: a idade que o cliente INFORMA,
   * dada a idade real (padrão: a real).
   */
  const encounter = (
    ka: ShipKind, kb: ShipKind, lat: number, offY: number, vb: number,
    ageOf: (real: number) => number = (real) => real,
    otherAssist = false,
    blend = false,
  ) => {
    // espaço ABERTO (fora do cinturão): no cinturão o caça, voltando do choque,
    // batia numa rocha perto do fim da janela, e o instante desse segundo choque
    // varia com qualquer erro de posição — mediria a rocha, não o par
    const at: WorldPos = { sx: 0, sy: 0, x: 5000, y: 5000 };
    const w = new SimWorld(999);
    const A = w.addShip("A", at, "p1", ka);
    const B = w.addShip("B", { ...at, x: at.x + 300, y: at.y + offY }, "p2", kb);
    A.vx = 2000;
    A.av = 0.5;
    B.vx = vb;
    // o auxílio DESLIGADO na nave predita: sem retenção de atitude o giro que o
    // choque imprimiu fica guardado até o fim, e o erro de giro é medível
    const DRIFT: ShipInput = { thrust: false, turn: 0, mine: false, assistOff: true };
    w.setInput("A", DRIFT);
    // o outro casco: sem auxílio, ele anda em inércia pura — exatamente o que o
    // fantasma supõe, e o erro que sobra é só o da predição. Com auxílio (o
    // padrão do jogo) o servidor aplica o trim nele e o fantasma não sabe:
    // esse é o erro de NÃO CONHECER O COMANDO do outro, medido à parte
    if (!otherAssist) w.setInput("B", DRIFT);
    const me = makeShip(at, "p1", ka);
    me.vx = 2000;
    me.av = 0.5;
    // o primeiro snapshot também chega com latência: descreve B em t = −lat
    // (antes do encontro B anda em linha reta, então é só recuá-lo). Não existe
    // snapshot de idade zero no jogo, nem no primeiro quadro
    const first = snapOf(B);
    const firstA = snapOf(A);
    const snaps = [{
      t: -lat,
      o: Object.freeze({ ...first, x: first.x - first.vx * lat, y: first.y - first.vy * lat }),
      own: { ...firstA, x: firstA.x - firstA.vx * lat, y: firstA.y - firstA.vy * lat, angle: A.angle },
    }];
    const bits = snaps.map((s) => JSON.stringify(s.o));
    let tick = 0;
    const FR = 60;
    const T = 0.6;
    // velocidade do servidor em cada tick, para comparar no MESMO instante
    const srvV: Array<[number, number]> = [[A.vx, A.vy]];
    const advance = (until: number) => {
      while ((tick + 1) * 0.05 <= until + 1e-9) {
        w.tick(0.05);
        tick++;
        snaps.push({ t: tick * 0.05, o: snapOf(B), own: { ...snapOf(A), angle: A.angle } });
        bits.push(JSON.stringify(snaps[snaps.length - 1].o));
        srvV.push([A.vx, A.vy]);
      }
    };
    let track = 0;
    for (let f = 0; f < FR * T; f++) {
      const t = f / FR;
      advance(t);
      // o último estado que já CHEGOU ao cliente
      let cur = snaps[0];
      for (const s of snaps) if (s.t + lat <= t + 1e-9) cur = s;
      stepShipInWorld(me, DRIFT, 1 / FR, 1, {
        seed: 999, contacts: [cur.o], contactIds: ["B"], contactsAge: ageOf(t - cur.t),
      });
      if (blend) {
        // GameScene.blendTowards, linha a linha (OWN_BLEND = 0,1 por quadro),
        // contra o snapshot da PRÓPRIA nave, com a mesma idade do outro
        const k = 0.1;
        const own = cur.own;
        const r = { dx: own.x - me.x + (own.sx - me.sx) * SECTOR_SIZE, dy: own.y - me.y + (own.sy - me.sy) * SECTOR_SIZE };
        me.x += r.dx * k;
        me.y += r.dy * k;
        me.vx += (own.vx - me.vx) * k;
        me.vy += (own.vy - me.vy) * k;
        me.angle += Math.atan2(Math.sin(own.angle - me.angle), Math.cos(own.angle - me.angle)) * k;
        me.av += (own.av - me.av) * k;
        stepShip(me, COAST, 0);
      }
      // no fim de todo quadro que cai num tick, a nave predita contra a do
      // servidor NO MESMO INSTANTE: é o que o jogador vê na hora do choque
      if ((f + 1) % 3 === 0) {
        advance((f + 1) / FR);
        const sv = srvV[(f + 1) / 3];
        track = Math.max(track, Math.hypot(me.vx - sv[0], me.vy - sv[1]));
      }
    }
    advance(T);
    const dvServer = Math.hypot(A.vx - 2000, A.vy);
    const dvPred = Math.hypot(me.vx - 2000, me.vy);
    return {
      ratio: dvPred / dvServer, dvServer, gap: dist(A, me),
      // pior erro de velocidade no mesmo instante, em frações do Δv do choque
      track: track / dvServer,
      // erro de giro RELATIVO ao giro que o choque imprimiu (mín. 0,1 rad/s)
      dav: Math.abs(A.av - me.av) / Math.max(0.1, Math.abs(A.av - 0.5)),
      intact: snaps.every((s, i) => JSON.stringify(s.o) === bits[i]),
    };
  };

  const SCENES: Array<[string, number, number]> = [
    ["frontal, alvo parado", 0, 0],
    ["oblíquo, alvo vindo a −800 u/s", 25, -800],
    ["quase frontal, alvo vindo a −2500 u/s", 10, -2500],
  ];
  for (const lat of [0, 0.016, 0.05, 0.075]) {
    it(`Δv predito = Δv do servidor nos 16 pares, snapshot com ${Math.round(lat * 1000)} ms de latência`, () => {
      for (const [, offY, vb] of SCENES) {
        for (const ka of KINDS) {
          for (const kb of KINDS) {
            const r = encounter(ka, kb, lat, offY, vb);
            expect(r.intact).toBe(true); // o snapshot sai bit a bit
            expect(r.dvServer).toBeGreaterThan(100); // o encontro aconteceu mesmo
            expect(Math.abs(r.ratio - 1)).toBeLessThan(0.001);
            // e no MESMO instante, quadro a quadro, não só no fim
            expect(r.track).toBeLessThan(0.01);
            expect(r.gap).toBeLessThan(2);
            expect(r.dav).toBeLessThan(0.01);
          }
        }
      }
    });
  }

  it("idade FIXA chutada e o outro com auxílio, SEM o blend: o choque predito sai certo", () => {
    // NÃO é "a condição do jogo", e o nome anterior dizia que era: o jogo ainda
    // puxa a nave predita para o snapshot da PRÓPRIA nave a cada quadro
    // (GameScene.blendTowards) — ver o teste pendente logo abaixo. Este mede só
    // a predição do par: o cliente não mede a latência e informa
    // SNAPSHOT_AGE_FIXED_GUESS; com latência real de 16 a 75 ms o erro de idade
    // chega a ±~40 ms. E o outro casco voa com o auxílio ligado, cujo trim o
    // fantasma não conhece
    const worst = (age: number) => {
      let ratio = 0;
      let gap = 0;
      for (const lat of [0.016, 0.05, 0.075]) {
        for (const [, offY, vb] of SCENES) {
          for (const ka of KINDS) {
            for (const kb of KINDS) {
              const r = encounter(ka, kb, lat, offY, vb, () => age, true);
              expect(r.intact).toBe(true);
              ratio = Math.max(ratio, Math.abs(r.ratio - 1));
              gap = Math.max(gap, r.gap);
            }
          }
        }
      }
      return { ratio, gap };
    };
    // medido (phystrace §11): estimada → |razão − 1| ≤ 0,0013 e até 88,5 u de
    // posição (o fantasma nasce adiantado ou atrasado pelo erro da idade; o
    // choque em si sai certo); idade zero (o que o cliente informava) → 0,81 e
    // 353 u. O teto do teste fica pouco acima do medido, e a comparação com
    // zero prova que a idade é o conserto
    const est = worst(SNAPSHOT_AGE_FIXED_GUESS);
    const zero = worst(0);
    expect(est.ratio).toBeLessThan(0.003);
    expect(est.gap).toBeLessThan(100);
    expect(zero.ratio).toBeGreaterThan(100 * est.ratio);
    expect(zero.gap).toBeGreaterThan(est.gap);
  });

  // PENDENTE DE DECISÃO — netcode (rodada seguinte). A condição do jogo inclui
  // o blend da nave própria contra o snapshot DELA, que tem a mesma latência:
  // ele puxa a nave predita para trás, para um estado de antes do choque, e o
  // choque predito acontece fora de hora (medido pelo crítico: Δv predito 0,00
  // em 48 de 80 encontros). Não é defeito da física do par; é a reconciliação
  // sem sequência de input nem replay. `it.fails`: o teste afirma o que devia valer
  // e falha HOJE; quando a reconciliação existir, ele passa a passar e o
  // vitest acusa — aí vira `it` comum.
  it.fails("PENDENTE (netcode): com o blend real da nave própria, a predição acompanha o servidor no instante do choque", () => {
    // idade REAL (o melhor caso possível para a física do par) e o blend: o
    // que sobra de erro é da reconciliação. Medido: erro de velocidade no mesmo
    // instante = 100% do Δv do choque (a nave predita, puxada para trás pelo
    // snapshot velho dela, bate um tick depois); sem o blend, 0,1%.
    for (const lat of [0.016, 0.05, 0.075]) {
      for (const [, offY, vb] of SCENES) {
        for (const ka of KINDS) {
          for (const kb of KINDS) {
            const r = encounter(ka, kb, lat, offY, vb, (real) => real, false, true);
            expect(r.track).toBeLessThan(0.05);
          }
        }
      }
    }
  });
});

describe("estados congelados não guardam tempo pendente", () => {
  it("freezeShip zera o resíduo do acumulador junto com as velocidades", () => {
    // 0,005 s sobreviviam à atracação inteira: a nave soltava com um pedaço de
    // tempo do voo ANTERIOR no bolso e rodava um sub-passo a mais no primeiro
    // quadro de voo livre.
    const s = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "builder");
    stepShip(s, THRUST, 0.02); // 2 sub-passos + resíduo
    expect(s.stepAccum).toBeGreaterThan(0);
    freezeShip(s);
    expect(s.stepAccum).toBe(0);
    expect(s.vx).toBe(0);
    expect(s.av).toBe(0);
  });

  it("e o mundo congela igual: atracar e soltar não adianta a física", () => {
    const w = new SimWorld(777);
    const s = w.addShip("s", { sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p1", "builder");
    w.setInput("s", THRUST);
    w.tick(0.0166667); // deixa resíduo na nave
    s.anchored = true;
    w.tick(0.05);
    expect(s.stepAccum).toBe(0);
  });
});

describe("o teto de sub-passos era código morto — e o custo virou conta conferível", () => {
  it("o pior caso é derivado do teto de dt, e o acumulador nunca o passa", () => {
    // ANTES: PHYSICS_MAX_SUBSTEPS = 32, com um ramo que descartava o excedente
    // e que nenhuma chamada alcançava. Agora o teto é UM, o da pendência
    // (admitTime), e o pior caso é a conta dele — e a conta é ATINGIDA, então
    // não é outro limite decorativo.
    expect(PHYSICS_WORST_CASE_SUBSTEPS).toBe(Math.round(SIM_MAX_DT / PHYSICS_SUBSTEP));
    // o laço REAL de uma entrada: pendência admitida pelo teto, drenada em
    // sub-passos exatos, resíduo guardado — com engasgos no meio da sequência
    const s = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "builder");
    let worst = 0;
    const frames = [1 / 60, 0.0166667, 3.0, 1 / 144, 0.05, 0.2, 0.26, 1 / 30];
    for (let i = 0; i < 4000; i++) {
      const before = s.stepAccum;
      const dt = frames[i % frames.length];
      const admitted = Math.min(before + dt, SIM_MAX_DT);
      stepShip(s, COAST, dt);
      const steps = Math.round((admitted - s.stepAccum) / PHYSICS_SUBSTEP);
      worst = Math.max(worst, steps);
      expect(s.stepAccum).toBeLessThan(PHYSICS_SUBSTEP); // o resto é sempre < 1 sub-passo
    }
    expect(worst).toBe(PHYSICS_WORST_CASE_SUBSTEPS);
  });

  it("e nada mais some em silêncio: o resíduo é sempre guardado", () => {
    // o ramo antigo devolvia `rest: 0` e engolia o tempo excedente
    for (const t of [0.5, 1, 3, 60]) {
      const r = drainSubsteps(t);
      expect(r.steps * PHYSICS_SUBSTEP + r.rest).toBeCloseTo(t, 9);
    }
  });
});

describe("raspão: o choque não pode depender da velocidade nem da fase do sub-passo", () => {
  const seed = 777;
  const small = sectorAsteroids(seed, beltSector, 0).reduce((m, r) => (r.radius < m.radius ? r : m));
  const target = small.radius + SHIP_RADIUS;
  const e = SHIP_PHYSICS.attack.restitution * ASTEROID_SURFACE_RESTITUTION;
  /**
   * Passa rente à MENOR rocha, entrando `pen` u na seção de choque, a `v` u/s.
   * `phase` desloca a largada em frações do passo: é o que decide onde os
   * pontos finais dos sub-passos caem em relação à rocha. Voa pelo caminho
   * REAL (stepShipInWorld) só até sair da vizinhança, para nenhuma outra rocha
   * entrar na conta.
   */
  const pass = (pen: number, v: number, phase: number, dt = 1 / 60) => {
    const s = makeShip(
      { sx: small.sx, sy: small.sy, x: small.x - 600 - phase * (v / 120), y: small.y + target - pen },
      "p", "attack",
    );
    s.vx = v;
    for (let i = 0; i < 400; i++) {
      stepShipInWorld(s, COAST, dt, 1, { seed });
      if (s.x - small.x > 700 || Math.abs(s.y - small.y) > 700) break;
    }
    return s;
  };

  it("o cenário é o que diz ser: a corda do raspão é menor que o passo", () => {
    // 1 u de penetração na rocha mínima: corda 2·√(2·R·p) ≈ 42 u, contra 50 u
    // de passo a 6000 u/s. Um teste de ponto PODE pular o raspão inteiro.
    expect(2 * Math.sqrt(2 * target * 1)).toBeLessThan(6000 * PHYSICS_SUBSTEP);
  });

  it("todo raspão registra, em toda velocidade e toda fase, com o MESMO impulso", () => {
    // ANTES (teste de ponto + "ponto de maior aproximação", onde vn = 0 e o
    // impulso saía nulo): 1 u a 6000 u/s registrava em 10 de 24 fases, a 4000
    // u/s em 15 de 24, e quando registrava o Δv variava de 0 a 767 u/s
    for (const pen of [0.25, 1, 5]) {
      for (const v of [2000, 4000, 6000, 8000, 12_000]) {
        const d = target - pen;
        // só a parte NORMAL do impulso, projetada em y: o atrito tira um pouco
        const ideal = (1 + e) * v * Math.sqrt(1 - (d / target) ** 2) * (d / target);
        const dvy: number[] = [];
        for (let k = 0; k < 24; k++) dvy.push(Math.abs(pass(pen, v, k / 24).vy));
        const lo = Math.min(...dvy);
        const hi = Math.max(...dvy);
        expect(lo).toBeGreaterThan(0); // registrou nas 24 fases
        expect(hi - lo).toBeLessThan(0.01 * hi); // e a fase não sorteia o resultado
        expect(lo).toBeGreaterThan(0.95 * ideal); // e é o choque de verdade
        expect(hi).toBeLessThanOrEqual(ideal * 1.0001);
      }
    }
  });

  it("cliente (60 Hz) e servidor (20 Hz) veem o MESMO raspão", () => {
    // mesmo tempo total nos dois (um múltiplo do tick), só o necessário para
    // cruzar a rocha: o trim assistido age sobre vy também, então comparar
    // voos de durações diferentes mediria o trim, não o choque
    const fixed = (v: number, dt: number) => {
      const T = Math.ceil((600 + 2 * target + 200) / v / 0.05) * 0.05;
      const s = makeShip(
        { sx: small.sx, sy: small.sy, x: small.x - 600 - 0.37 * (v / 120), y: small.y + target - 1 },
        "p", "attack",
      );
      s.vx = v;
      for (let i = 0; i < Math.round(T / dt); i++) stepShipInWorld(s, COAST, dt, 1, { seed });
      return s;
    };
    for (const v of [4000, 6000, 12_000]) {
      const srv = fixed(v, 1 / 20);
      const cli = fixed(v, 1 / 60);
      expect(Math.abs(srv.vy)).toBeGreaterThan(100); // o raspão aconteceu
      expect(cli.vy).toBe(srv.vy);
      expect(cli.av).toBe(srv.av);
      expect(dist(cli, srv)).toBe(0);
    }
  });
});

describe("o limitador de rodopio age SÓ no giro: o atrito linear não paga o teto", () => {
  const seed = 777;
  const rock = sectorAsteroids(seed, beltSector, 0)[0];
  const R = SHIP_RADIUS;
  /** um contato com a rocha (normal +x, tangente +y); devolve Δvt e Δω. */
  const touch = (vn: number, vt: number, av0: number, kind: ShipKind = "builder") => {
    const s = makeShip({ sx: rock.sx, sy: rock.sy, x: rock.x + rock.radius, y: rock.y }, "p", kind);
    s.vx = vn;
    s.vy = vt;
    s.av = av0;
    collideShip(s, seed);
    return { dvt: s.vy - vt, dav: s.av - av0, av: s.av };
  };

  it("a translação leva o impulso de Coulomb INTEIRO, em qualquer ω; o giro nunca passa do teto", () => {
    // Por duas rodadas o teto de giro escalava também o impulso LINEAR, e no
    // teto a rocha virava gelo com a casca escorregando a 3354 u/s. Agora o
    // limitador de rodopio é declarado e age só em ω: o que ele corta é
    // momento angular jogado fora de propósito, não atrito.
    for (const kind of ["builder", "attack", "transport"] as ShipKind[]) {
      const k = SHIP_PHYSICS[kind].gyration;
      const e = SHIP_PHYSICS[kind].restitution * ASTEROID_SURFACE_RESTITUTION;
      for (const av0 of [-11.9, -8, -5, -1, 0, 1, 5, 8, 11.9]) {
        for (const [vn, vt] of [[-2000, 3000], [-50, 4000], [-50, -4000]]) {
          const r = touch(vn, vt, av0, kind);
          // regime que DESLIZA: |Δvt| = μ·|jn|, exatamente, ω nenhum o reduz
          const jn = (-vn < 40 ? 1 : 1 + e) * -vn;
          expect(Math.abs(r.dvt)).toBeCloseTo(ASTEROID_SURFACE_FRICTION * jn, 9);
          expect(Math.abs(r.av)).toBeLessThanOrEqual(IMPACT_SPIN_MAX);
          // e o giro recebe no máximo o tranco rígido R·Δvt/k², no mesmo sentido
          const rigid = (-R * r.dvt) / (k * k);
          expect(Math.abs(r.dav)).toBeLessThanOrEqual(Math.abs(rigid) + 1e-12);
          expect(r.dav * rigid).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("na faixa LINEAR de giro não há corte nenhum: Δω = R·Δvt/k² exato", () => {
    for (const kind of ["builder", "attack", "transport"] as ShipKind[]) {
      const k = SHIP_PHYSICS[kind].gyration;
      for (const av0 of [-1, 0, 1]) {
        const r = touch(-50, 3000, av0, kind); // tranco pequeno: fica abaixo de 3 rad/s
        expect(Math.abs(r.av)).toBeLessThan(IMPACT_SPIN_LINEAR);
        expect(r.dav).toBeCloseTo((-R * r.dvt) / (k * k), 12);
      }
    }
  });

  it("o FREIO de giro não é comprimido perto da assíntota", () => {
    // mesmo aperto, casca escorregando para −y nos dois (regime que desliza):
    // o tranco que tira giro tem que ser o mesmo em ω = 5 e em ω = 11,9
    const mid = touch(-50, -100, 5);
    const top = touch(-50, -100, 11.9);
    expect(mid.dav).toBeLessThan(0);
    expect(top.dav).toBeCloseTo(mid.dav, 12);
    expect(top.dvt).toBeCloseTo(mid.dvt, 12);
  });

  it("no par nave × nave: momento linear conservado, giro no máximo o rígido e nunca acima do teto", () => {
    for (const [avA, avB] of [[0, 0], [11.5, 11.5], [-11.5, 4], [6, -11.9]]) {
      const a = makeShip({ sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p", "attack");
      const b = makeShip({ sx: beltSector, sy: 0, x: 5000 + SHIP_RADIUS, y: 5000 + SHIP_RADIUS }, "p", "transport");
      a.vx = 4000;
      a.av = avA;
      b.av = avB;
      const va = { x: a.vx, y: a.vy };
      collideShipPair(a, b);
      const ma = SHIP_PHYSICS.attack.mass;
      const mb = SHIP_PHYSICS.transport.mass;
      expect(ma * (a.vx - va.x) + mb * b.vx).toBeCloseTo(0, 9);
      expect(ma * (a.vy - va.y) + mb * b.vy).toBeCloseTo(0, 9);
      // tangente do contato: normal de a para b girada 90°
      const n = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
      const t = { x: -n.y, y: n.x };
      const dvtA = (a.vx - va.x) * t.x + (a.vy - va.y) * t.y;
      const dvtB = b.vx * t.x + b.vy * t.y;
      const kA = SHIP_PHYSICS.attack.gyration;
      const kB = SHIP_PHYSICS.transport.gyration;
      // o atrito pega `a` do lado +n e `b` do lado −n: os torques caem no mesmo
      // sinal; o limitador só pode encurtar o tranco, nunca aumentar nem inverter
      const rigA = (R * dvtA) / (kA * kA);
      const rigB = (-R * dvtB) / (kB * kB);
      expect(Math.abs(a.av - avA)).toBeLessThanOrEqual(Math.abs(rigA) + 1e-12);
      expect(Math.abs(b.av - avB)).toBeLessThanOrEqual(Math.abs(rigB) + 1e-12);
      expect((a.av - avA) * rigA).toBeGreaterThanOrEqual(0);
      expect((b.av - avB) * rigB).toBeGreaterThanOrEqual(0);
      expect(Math.abs(a.av)).toBeLessThanOrEqual(IMPACT_SPIN_MAX);
      expect(Math.abs(b.av)).toBeLessThanOrEqual(IMPACT_SPIN_MAX);
    }
  });
});

describe("contato prensado com o giro no teto: o atrito CONTINUA, o limitador corta só o giro", () => {
  const seed = 777;
  const rock = sectorAsteroids(seed, beltSector, 0)[0];

  it("no teto de giro a rocha continua agarrando, no ritmo de Coulomb", () => {
    // O CENÁRIO DO CRÍTICO: `collideShip` — a chamada que o sub-passo faz — com
    // a aproximação de 50 u/s reimposta a cada sub-passo (o casco prensado
    // contra a pedra) e 4000 u/s na tangente. Aperto de ~6000 u/s², acima de
    // qualquer motor do jogo: é o pior caso, não o típico.
    //
    // Por uma rodada, no teto a rocha virava GELO (perda 0,00 em 300 sub-passos
    // com a casca escorregando a 3354 u/s), porque o teto de giro escalava
    // também o atrito linear. Agora o limitador de rodopio é declarado e corta
    // só ω; a translação segue pagando μ·|jn| por sub-passo enquanto escorrega.
    const s = makeShip({ sx: rock.sx, sy: rock.sy, x: rock.x + rock.radius - 1, y: rock.y }, "p", "builder");
    s.vy = 4000;
    const vt: number[] = [4000];
    for (let i = 0; i < 1200; i++) {
      s.vx = -50;
      collideShip(s, seed);
      vt.push(s.vy);
    }
    // cada sub-passo desliza e paga exatamente μ·|jn|, jn = (1+e)·50
    const e = SHIP_PHYSICS.builder.restitution * ASTEROID_SURFACE_RESTITUTION;
    const perStep = ASTEROID_SURFACE_FRICTION * (1 + e) * 50;
    for (const i of [1, 300, 600]) expect(vt[i - 1] - vt[i]).toBeCloseTo(perStep, 9);
    expect(Math.abs(s.av)).toBeLessThanOrEqual(IMPACT_SPIN_MAX);
  });

  it("no caminho REAL, empurrando contra Ceres, a perda cabe no orçamento de Coulomb", () => {
    // Aperto de verdade: o piloto mantém o nariz no centro de Ceres com o
    // motor ligado, deslizando a 4000 u/s. Ceres é o único sólido grande o
    // bastante para sustentar esse contato — contra um disco, a nave só fica
    // encostada se o aperto vencer v²/r. A perda tangencial em 10 s não pode
    // passar de (μ·aperto + trim)·t, e o aperto não passa do motor.
    const c = ceresPosition(seed);
    const s = makeShip({ sx: c.sx, sy: c.sy, x: c.x + CERES_RADIUS + SHIP_RADIUS, y: c.y }, "p", "builder");
    s.vy = 4000;
    const p = SHIP_PHYSICS.builder;
    let inContact = 0;
    // o nariz é segurado no centro a CADA sub-passo: com o giro que o atrito
    // imprime, segurar só por quadro deixava o nariz varrer ±0,2 rad e o
    // motor ganhava componente tangencial — o teste mediria o piloto
    for (let i = 0; i < 1200; i++) {
      const r = { dx: c.x - s.x + (c.sx - s.sx) * SECTOR_SIZE, dy: c.y - s.y + (c.sy - s.sy) * SECTOR_SIZE };
      s.angle = Math.atan2(r.dy, r.dx);
      s.av = 0;
      stepShipInWorld(s, THRUST, PHYSICS_SUBSTEP, 1, { ceres: c });
      if (dist(s, c) < CERES_RADIUS + SHIP_RADIUS + 1) inContact++;
    }
    expect(inContact).toBeGreaterThan(1000); // contato sustentado de fato
    const loss = 4000 - speedOf(s);
    expect(loss).toBeGreaterThan(p.assistDecel * 10); // o atrito cobra algo
    expect(loss).toBeLessThanOrEqual((CERES_SURFACE_FRICTION * p.accel + p.assistDecel) * 10);
  });
});

describe("os sólidos têm a última palavra também depois do par nave × nave", () => {
  const seed = 777;
  const rock = sectorAsteroids(seed, beltSector, 0)[0];
  const minD = rock.radius + SHIP_RADIUS;
  // A encostada na rocha, B (cargueiro) chegando por trás e prensando A contra
  // a pedra: a separação do par empurra A para DENTRO da rocha.
  const place = () => ({
    a: { sx: rock.sx, sy: rock.sy, x: rock.x - minD, y: rock.y },
    b: { sx: rock.sx, sy: rock.sy, x: rock.x - minD - 400, y: rock.y },
  });

  it("no servidor (SimWorld.tick): nem casco na rocha, nem casco dentro de casco", () => {
    // o cargueiro chega E, num dos casos, continua empurrando (motor ligado,
    // nariz na rocha): contato prensado sustentado. ANTES (medido pelo crítico)
    // os cascos terminavam o tick sobrepostos 5,1–10,2 u: a rocha empurrava o
    // caça de volta para dentro do cargueiro e ninguém desfazia.
    for (const vb of [800, 2000, 4000]) {
      for (const push of [false, true]) {
        const w = new SimWorld(seed);
        const pos = place();
        const a = w.addShip("a", pos.a, "p1", "attack");
        const b = w.addShip("b", pos.b, "p2", "transport");
        b.vx = vb;
        if (push) w.setInput("b", THRUST);
        let worstRock = Infinity;
        let worstHull = Infinity;
        let touched = false;
        for (let i = 0; i < 240; i++) {
          w.tick(PHYSICS_SUBSTEP); // um sub-passo por chamada: olha dentro do laço
          worstRock = Math.min(worstRock, dist(a, rock));
          worstHull = Math.min(worstHull, dist(a, b));
          if (a.vx !== 0) touched = true;
        }
        expect(touched).toBe(true);
        expect(worstRock).toBeGreaterThanOrEqual(minD - 1e-6);
        expect(worstHull).toBeGreaterThanOrEqual(2 * SHIP_RADIUS - 1e-6);
      }
    }
  });

  it("na predição (stepShipInWorld + contatos): idem, contra o fantasma do cargueiro", () => {
    for (const vb of [800, 2000, 4000]) {
      const pos = place();
      const a = makeShip(pos.a, "p1", "attack");
      const snap = { ...pos.b, vx: vb, vy: 0, av: 0, kind: "transport" as ShipKind, cargoAmount: 0 };
      let worst = Infinity;
      for (let i = 0; i < 120; i++) {
        stepShipInWorld(a, COAST, PHYSICS_SUBSTEP, 1, { seed, contacts: [snap] });
        worst = Math.min(worst, dist(a, rock));
      }
      expect(a.vx).not.toBe(0);
      expect(worst).toBeGreaterThanOrEqual(minD - 1e-6);
    }
  });
});

describe("par nave × nave CONTÍNUO: o passo relativo não atravessa o casco", () => {
  const at: WorldPos = { sx: beltSector, sy: 0, x: 5000, y: 5000 };
  /**
   * `va` contra `vb`, mira central, 24 fases de largada (onde as posições dos
   * sub-passos caem em relação ao alvo). Devolve quantas ATRAVESSARAM.
   */
  const pass = (va: number, vb: number, predicted: boolean) => {
    let through = 0;
    for (let k = 0; k < 24; k++) {
      const phase = (k / 24) * (Math.abs(va - vb) / 120);
      const a0 = { ...at, x: at.x - 600 - phase };
      const b0 = { ...at, x: at.x + 300 };
      if (!predicted) {
        const w = new SimWorld(999);
        const A = w.addShip("A", a0, "p1", "attack");
        const B = w.addShip("B", b0, "p2", "builder");
        A.vx = va;
        B.vx = vb;
        for (let i = 0; i < 12; i++) w.tick(0.05);
        if (dist(A, a0) > dist(B, a0)) through++;
      } else {
        // o snapshot do instante 0, com a idade real a cada quadro
        const A = makeShip(a0, "p1", "attack");
        A.vx = va;
        const snap = { ...b0, vx: vb, vy: 0, av: 0, kind: "builder" as ShipKind, cargoAmount: 0 };
        for (let i = 0; i < 36; i++) {
          stepShipInWorld(A, COAST, 1 / 60, 1, {
            seed: 999, contacts: [snap], contactIds: ["B"], contactsAge: i / 60,
          });
        }
        // o fantasma é interno: atravessar = nenhum impulso chegou a A (só o
        // trim de 0,6 s, 22,5 u/s, tirou velocidade dele)
        if (Math.abs(A.vx - va) < 100) through++;
      }
    }
    return through;
  };

  it("o cenário é o que diz ser: o passo relativo é maior que o diâmetro", () => {
    expect(6000 * PHYSICS_SUBSTEP).toBeGreaterThan(2 * SHIP_RADIUS);
    expect(10_400 * PHYSICS_SUBSTEP).toBeGreaterThan(2 * SHIP_RADIUS);
  });

  it("servidor: nenhuma fase atravessa (antes: 5 de 24 a 6000 u/s, 13 de 24 de frente a 5200)", () => {
    for (const [va, vb] of [[6000, 0], [5200, -5200], [12_000, 0]]) expect(pass(va, vb, false)).toBe(0);
  });

  it("predição contra o fantasma: nenhuma fase atravessa, e todas dão o MESMO choque", () => {
    // sem varredura a predição não chegava a atravessar, mas pegava o toque
    // tarde em parte das fases, fundo demais, e o Δv saía errado: 536 u/s em
    // vez de 1065 em 5 de 24 fases (6000 contra parado), 461 em vez de −3039
    // em 13 de 24 (5200 de frente)
    for (const [va, vb] of [[6000, 0], [5200, -5200], [12_000, 0]]) {
      expect(pass(va, vb, true)).toBe(0);
      const vx: number[] = [];
      for (let k = 0; k < 24; k++) {
        const A = makeShip({ ...at, x: at.x - 600 - (k / 24) * (Math.abs(va - vb) / 120) }, "p1", "attack");
        A.vx = va;
        const snap = { ...at, x: at.x + 300, vx: vb, vy: 0, av: 0, kind: "builder" as ShipKind, cargoAmount: 0 };
        for (let i = 0; i < 36; i++) {
          stepShipInWorld(A, COAST, 1 / 60, 1, {
            seed: 999, contacts: [snap], contactIds: ["B"], contactsAge: i / 60,
          });
        }
        vx.push(A.vx);
      }
      for (const v of vx) expect(Math.abs(v - vx[0])).toBeLessThan(0.002 * va);
    }
  });

  it("o choque varrido sai IGUAL em toda fase (a fase não sorteia o resultado)", () => {
    const out: number[] = [];
    for (let k = 0; k < 24; k++) {
      const w = new SimWorld(999);
      w.addShip("A", { ...at, x: at.x - 600 - (k / 24) * 50 }, "p1", "attack").vx = 6000;
      const B = w.addShip("B", { ...at, x: at.x + 300, y: at.y + 15 }, "p2", "builder");
      for (let i = 0; i < 6; i++) w.tick(0.05);
      out.push(B.vy);
    }
    expect(Math.abs(out[0])).toBeGreaterThan(10);
    // o choque em si é o mesmo; o que varia com a fase é só o resto do
    // sub-passo integrado depois dele (trim, 1 parte em 10⁵)
    for (const v of out) expect(Math.abs(v - out[0])).toBeLessThan(1e-4 * Math.abs(out[0]));
  });
});

describe("cascos em CADEIA e simultâneos: solver iterativo, sem túnel, sem ordem", () => {
  // espaço aberto: só os cascos
  const at: WorldPos = { sx: 0, sy: 0, x: 5000, y: 5000 };
  /** cargueiro a `v` contra um caça ENCOSTADO noutro caça; fase `k`/24 do passo */
  const chain = (v: number, k: number, ids: [string, string, string], gap = 0) => {
    const w = new SimWorld(999);
    const T = w.addShip(ids[0], { ...at, x: at.x - 400 - (k / 24) * (v / 120) }, "p", "transport");
    const M = w.addShip(ids[1], at, "p", "attack");
    const L = w.addShip(ids[2], { ...at, x: at.x + 2 * SHIP_RADIUS + gap }, "p", "attack");
    T.vx = v;
    let overlap = 0;
    let through = false;
    for (let i = 0; i < 20; i++) {
      w.tick(0.05);
      overlap = Math.max(overlap, 2 * SHIP_RADIUS - dist(T, M), 2 * SHIP_RADIUS - dist(M, L));
      // x de mundo: a 12 000 u/s a fila cruza a borda do setor
      const wx = (q: WorldPos) => q.sx * SECTOR_SIZE + q.x;
      if (wx(M) > wx(L) || wx(T) > wx(M)) through = true;
    }
    return { through, overlap, v: [T.vx, M.vx, L.vx] };
  };

  it("cadeia de três: ninguém atravessa, nada fica sobreposto, e a fase não decide", () => {
    // ANTES (medido pelo crítico): o casco do meio atravessava o último em 12
    // de 24 fases a 3000 u/s, 21 a 4000, 19 a 6000; em espaço aberto a cadeia
    // terminava o tick sobreposta 25–40 u
    for (const v of [3000, 4000, 6000, 12_000]) {
      const runs = Array.from({ length: 24 }, (_, k) => chain(v, k, ["a", "b", "c"]));
      for (const r of runs) {
        expect(r.through).toBe(false);
        expect(r.overlap).toBeLessThan(1e-6);
      }
      // a fase só muda o trim integrado depois do choque (< 1 u/s)
      for (let i = 0; i < 3; i++) {
        const vs = runs.map((r) => r.v[i]);
        expect(Math.max(...vs) - Math.min(...vs)).toBeLessThan(1);
      }
      // e o impulso chegou ao último da fila
      expect(runs[0].v[2]).toBeGreaterThan(0.3 * v);
    }
  });

  it("cadeia com FOLGA: o segundo choque cai no MESMO sub-passo do primeiro, e também é varrido", () => {
    // o do meio, recém-acertado, sai a ~5000–10 000 u/s e cobre a folga de
    // 5–15 u em uma fração do sub-passo: é um segundo evento dentro do mesmo
    // passo, que a varredura tem de achar em vez de deixar para a acomodação
    for (const v of [6000, 12_000]) {
      for (const gap of [5, 15]) {
        for (let k = 0; k < 24; k++) {
          const r = chain(v, k, ["a", "b", "c"], gap);
          expect(r.through).toBe(false);
          expect(r.overlap).toBeLessThan(1e-6);
          expect(r.v[2]).toBeGreaterThan(0.3 * v);
        }
      }
    }
  });

  it("cadeia de três: a ordem dos ids não muda nada (antes: 0,9 contra 2851 u/s de erro)", () => {
    for (const v of [3000, 6000]) {
      for (let k = 0; k < 24; k += 5) {
        const a = chain(v, k, ["a", "b", "c"]);
        for (const ids of [["c", "a", "b"], ["b", "c", "a"], ["c", "b", "a"]] as Array<[string, string, string]>) {
          const b = chain(v, k, ids);
          for (let i = 0; i < 3; i++) expect(Math.abs(a.v[i] - b.v[i])).toBeLessThan(1e-6);
        }
      }
    }
  });

  it("três corpos simultâneos: caça a 6000 u/s entre dois parados sai simétrico em toda fase e toda ordem", () => {
    // ANTES (medido pelo crítico): o erro contra a referência de passo fino ia
    // de 0 a 494 u/s conforme a fase
    const run = (k: number, ids: [string, string, string]) => {
      const w = new SimWorld(999);
      const F = w.addShip(ids[0], { ...at, x: at.x - 400 - (k / 24) * 50 }, "p", "attack");
      F.vx = 6000;
      const U = w.addShip(ids[1], { ...at, y: at.y + 19 }, "p", "builder");
      const D = w.addShip(ids[2], { ...at, y: at.y - 19 }, "p", "builder");
      for (let i = 0; i < 10; i++) w.tick(0.05);
      return [F.vx, F.vy, U.vx, U.vy, D.vx, D.vy];
    };
    const ref = run(0, ["f", "u", "d"]);
    expect(ref[3]).toBeGreaterThan(100); // o choque aconteceu nos dois
    // simetria: F não desvia, U e D saem espelhados
    expect(Math.abs(ref[1])).toBeLessThan(1e-6);
    expect(ref[2]).toBeCloseTo(ref[4], 6);
    expect(ref[3]).toBeCloseTo(-ref[5], 6);
    for (let k = 0; k < 24; k++) {
      const a = run(k, ["f", "u", "d"]);
      const b = run(k, ["u", "d", "f"]);
      for (let i = 0; i < 6; i++) {
        expect(Math.abs(a[i] - b[i])).toBeLessThan(1e-6);
        expect(Math.abs(a[i] - ref[i])).toBeLessThan(1);
      }
    }
  });
});

describe("a ordem dos pares é CANÔNICA, não a do Map", () => {
  const at: WorldPos = { sx: beltSector, sy: 0, x: 5000, y: 5000 };
  // caça parado entre dois cargueiros simétricos a ±3000 u/s: três corpos no
  // mesmo sub-passo, o caso em que resolver em sequência depende da ordem
  const squeeze = (insertion: string[], left = "L", right = "R") => {
    const w = new SimWorld(999);
    const add: Record<string, () => void> = {
      F: () => { w.addShip("F", at, "p", "attack"); },
      [left]: () => { w.addShip(left, { ...at, x: at.x - 100 }, "p", "transport").vx = 3000; },
      [right]: () => { w.addShip(right, { ...at, x: at.x + 100 }, "p", "transport").vx = -3000; },
    };
    for (const k of insertion) add[k]();
    for (let i = 0; i < 4; i++) w.tick(0.05);
    return [...w.ships.entries()]
      .sort((p, q) => (p[0] < q[0] ? -1 : 1))
      .map(([id, s]) => [id, s.x, s.y, s.vx, s.vy, s.av] as const);
  };

  it("a ordem de INSERÇÃO não muda nada, bit a bit (antes: −3364,9 ou +3364,9)", () => {
    const ref = squeeze(["F", "L", "R"]);
    for (const order of [["R", "L", "F"], ["L", "F", "R"], ["F", "R", "L"], ["R", "F", "L"]]) {
      expect(squeeze(order)).toEqual(ref);
    }
  });

  it("e nem a ordem dos IDS: o caso simétrico sai simétrico (antes: −3431,6 ou +3431,6)", () => {
    // o solver iterativo resolve os contatos simultâneos juntos e converge
    // para uma solução única; o caça espremido por dois cargueiros iguais não
    // tem lado para onde ir
    const vxOf = (rows: ReturnType<typeof squeeze>) => rows.find((r) => r[0] === "F")![3];
    const a = vxOf(squeeze(["F", "L", "R"], "L", "R"));
    const b = vxOf(squeeze(["F", "L", "R"], "R", "L"));
    expect(Math.abs(a)).toBeLessThan(1e-6);
    expect(Math.abs(b - a)).toBeLessThan(1e-6);
  });
});

describe("varredura contra VÁRIAS rochas: nada termina o sub-passo dentro de pedra", () => {
  it("em corredores estreitos a 6000 u/s nenhum sub-passo termina dentro de rocha", () => {
    // pares de rochas com vão ≤ 200 u, em 3 sementes; a nave cruza o vão em
    // 5 afastamentos × 3 ângulos. ANTES (medido pelo crítico): 87 de 1340
    // passagens terminavam o sub-passo dentro de rocha, até 20,3 u; com o
    // collision.ts da rodada anterior este teste mede 11,7 u.
    //
    // O que ele NÃO exercita, declarado: um trecho reto de ≤ 100 u entrando em
    // DUAS rochas (a de menor t contra a primeira da lista). Com a folga mínima
    // do procgen isso exige atravessar uma corda inteira da primeira, e a busca
    // em 5 sementes × 40 setores não achou nenhum. O que acontece de fato é a
    // reentrada DEPOIS do quique, e a passada de ponto sobre todas as rochas
    let runs = 0;
    let worst = 0;
    for (const seed of [777, 999, 12345]) {
      for (let sy = -4; sy < 4; sy++) {
        const rocks = sectorAsteroids(seed, beltSector, sy);
        for (const a of rocks) {
          for (const b of rocks) {
            if (a.id >= b.id) continue;
            const D = dist(a, b);
            const gap = D - a.radius - b.radius;
            if (gap > 200) continue;
            const ux = (b.x - a.x) / D;
            const uy = (b.y - a.y) / D;
            const mx = a.x + ux * (a.radius + gap / 2);
            const my = a.y + uy * (a.radius + gap / 2);
            for (const off of [-30, -10, 0, 10, 30]) {
              for (const ang of [0, 0.3, -0.3]) {
                const dx = -uy * Math.cos(ang) - ux * Math.sin(ang);
                const dy = -uy * Math.sin(ang) + ux * Math.cos(ang);
                const w = new SimWorld(seed);
                const s = w.addShip("s", {
                  sx: a.sx, sy: a.sy, x: mx + ux * off - dx * 800, y: my + uy * off - dy * 800,
                }, "p", "attack");
                s.vx = dx * 6000;
                s.vy = dy * 6000;
                runs++;
                for (let i = 0; i < 40; i++) {
                  w.tick(PHYSICS_SUBSTEP);
                  for (let oy = -1; oy <= 1; oy++) {
                    for (let ox = -1; ox <= 1; ox++) {
                      for (const k of sectorAsteroids(seed, s.sx + ox, s.sy + oy)) {
                        worst = Math.max(worst, k.radius + SHIP_RADIUS - dist(s, k));
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(runs).toBeGreaterThan(300); // o cenário existe de fato
    expect(worst).toBeLessThan(1e-6);
  });
});

describe("raio de giração ≤ raio do corpo, com o giro de antes", () => {
  // k² = ∫r²dm/m ≤ R²: é teorema. Os valores antigos (26/30/22/42) punham a
  // massa fora do casco de 20 u. Ficam aqui SÓ como régua do "giro de antes":
  // α = τ/(m·k²) e a rotação nominal são as de então.
  const OLD: Record<ShipKind, { k: number; torque: number }> = {
    builder: { k: 26, torque: 6300 },
    mining: { k: 30, torque: 8000 },
    attack: { k: 22, torque: 5400 },
    transport: { k: 42, torque: 11600 },
  };
  const KINDS = Object.keys(OLD) as ShipKind[];

  it("toda classe tem k ≤ SHIP_RADIUS", () => {
    for (const k of KINDS) expect(SHIP_PHYSICS[k].gyration).toBeLessThanOrEqual(SHIP_RADIUS);
  });

  it("α, retenção de atitude e tempo de virar 90°/180° são os de antes", () => {
    for (const kind of KINDS) {
      const p = SHIP_PHYSICS[kind];
      const oldAlpha = OLD[kind].torque / (p.mass * OLD[kind].k ** 2);
      expect(p.angularAccel).toBeCloseTo(oldAlpha, 10);
      expect(p.attitudeHold).toBeCloseTo(oldAlpha * 0.5, 10);
      // o tempo de virar, simulado no integrador, contra a conta com o α antigo
      for (const target of [Math.PI / 2, Math.PI]) {
        const s = makeShip({ sx: 0, sy: 0, x: 0, y: 0 }, "p", kind);
        let n = 0;
        while (s.angle < target && n < 10_000) {
          stepShip(s, TURN, PHYSICS_SUBSTEP);
          n++;
        }
        const ramp = p.maxTurnRate / oldAlpha;
        const rampAngle = 0.5 * oldAlpha * ramp * ramp;
        const expected = target <= rampAngle
          ? Math.sqrt((2 * target) / oldAlpha)
          : ramp + (target - rampAngle) / p.maxTurnRate;
        expect(Math.abs(n * PHYSICS_SUBSTEP - expected)).toBeLessThan(2 * PHYSICS_SUBSTEP);
      }
    }
  });

  it("o cargueiro continua o mais lento para virar — pelo torque, não por massa fora do casco", () => {
    const alpha = (k: ShipKind) => SHIP_PHYSICS[k].angularAccel;
    for (const k of KINDS) {
      if (k === "transport") continue;
      expect(alpha("transport")).toBeLessThan(alpha(k));
    }
  });
});

describe("estruturas", () => {
  it("a estação de mineração NÃO produz minério sozinha (só as aranhas)", () => {
    const w = new SimWorld(999);
    w.addShip("p1-ship", { sx: beltSector, sy: 0, x: 5000, y: 5000 }, "p1");
    w.addStructure({
      id: "st-0",
      type: "miningStation",
      owner: "p1",
      sx: beltSector,
      sy: 0,
      x: 5000,
      y: 5000,
      angle: 0,
      asteroidId: "",
      asteroidClass: "small" as const,
      shipBays: 2,
      expandedBays: 2,
      spiderBays: 2,
      nextShipBay: 0,
      nextSpiderBay: 0,
      oreStore: 0,
      rationStore: 0,
    });
    for (let i = 0; i < 20; i++) w.tick(1 / 20); // 1s
    expect(w.getOre("p1")).toBe(0);
  });
});
