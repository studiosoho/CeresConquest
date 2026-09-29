/**
 * Traço comportamental do modelo de voo — a metade mensurável da peça "física".
 *
 * Física não se julga por screenshot: um frame parado não mostra inércia. Este
 * harness roda cenários determinísticos no MESMO sim-core que servidor e cliente
 * usam e imprime números que um crítico consegue confrontar com o que se espera
 * de voo newtoniano.
 *
 * Uso (o Node do PATH é o 14, velho demais — prefixe o portátil):
 *   $env:Path = "$env:LOCALAPPDATA\Programs\node22;$env:Path"
 *   npx tsx scripts/phystrace.ts
 */
import {
  makeShip as makeShipRaw, stepShip, stepShipInWorld, collideShip, collideShipPair, drainSubsteps,
  sectorAsteroids, SimWorld, setLayer,
  type ShipState,
} from "../sim-core/src/index";
import {
  SHIP_PHYSICS, SHIP_RADIUS, CERES_RADIUS, SIM_MAX_DT, PHYSICS_SUBSTEP, IMPACT_SPIN_MAX,
  PHYSICS_WORST_CASE_SUBSTEPS, SNAPSHOT_AGE_FIXED_GUESS, ASTEROID_SURFACE_FRICTION,
  BELT_INNER_SECTORS, BELT_OUTER_SECTORS, dist,
  type ShipInput, type ShipKind, type WorldPos,
} from "@ceres/shared";

// O traço mede física de CONTATO — rocha, Ceres, casco × casco —, e contato só
// existe na SUPERFÍCIE: em cruzeiro a nave passa por cima de rocha e de Ceres
// (ver shared/layers.ts). Por isso TODA nave deste traço nasce na superfície,
// declarado aqui uma vez em vez de em cada cenário. A seção final (§ CAMADAS)
// é a única que compara camadas, e escolhe a camada de cada nave explicitamente.
const makeShip = (...args: Parameters<typeof makeShipRaw>): ShipState => {
  const s = makeShipRaw(...args);
  setLayer(s, "surface");
  return s;
};
const addShipRaw = SimWorld.prototype.addShip;
SimWorld.prototype.addShip = function (this: SimWorld, ...args: Parameters<typeof addShipRaw>) {
  const s = addShipRaw.apply(this, args);
  setLayer(s, "surface");
  return s;
};

const DT = 1 / 60;
const N = (v: number, d = 1) => v.toFixed(d).padStart(9);
const speed = (s: ShipState) => Math.hypot(s.vx, s.vy);
/** ângulo entre o nariz e o vetor velocidade (graus) — deriva */
const drift = (s: ShipState) => {
  if (speed(s) < 1e-6) return 0;
  const d = Math.atan2(s.vy, s.vx) - s.angle;
  return (Math.atan2(Math.sin(d), Math.cos(d)) * 180) / Math.PI;
};

const run = (s: ShipState, input: ShipInput, seconds: number) => {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) stepShip(s, input, DT);
};

const THRUST: ShipInput = { thrust: true, turn: 0, mine: false };
const COAST: ShipInput = { thrust: false, turn: 0, mine: false };
const TURN: ShipInput = { thrust: false, turn: 1, mine: false };
const origin = { sx: 0, sy: 0, x: 0, y: 0 };

console.log("=== 1. INÉRCIA: 2s de empuxo, depois motor cortado ===");
console.log("   t(s)   velocidade   % da velocidade no corte");
{
  const s = makeShip(origin, "p", "builder");
  run(s, THRUST, 2);
  const v0 = speed(s);
  console.log(`  ${N(0, 2)} ${N(v0)}   100.0  <- corte`);
  for (const t of [0.5, 1, 2, 4, 8]) {
    const prev = t === 0.5 ? 0 : [0.5, 1, 2, 4, 8][[0.5, 1, 2, 4, 8].indexOf(t) - 1];
    run(s, COAST, t - prev);
    console.log(`  ${N(t, 2)} ${N(speed(s))}   ${N((100 * speed(s)) / v0)}`);
  }
  console.log("  esperado: a perda é SÓ o trim assistido declarado (builder: 30 u/s²), LINEAR no tempo —");
  console.log("  240 u/s em 8 s, não uma curva de arrasto. Com o auxílio desligado fica 100% (ver §12).");
}

console.log("\n=== 2. MOMENTO ANGULAR: 1s girando, depois comando solto ===");
console.log("   t(s)   ângulo(°)   vel.ang(°/s)");
{
  const s = makeShip(origin, "p", "builder");
  let prevAngle = s.angle;
  for (let i = 1; i <= 60; i++) {
    stepShip(s, TURN, DT);
    if (i % 20 === 0) {
      const w = ((s.angle - prevAngle) / (20 * DT)) * (180 / Math.PI);
      console.log(`  ${N(i * DT, 2)} ${N((s.angle * 180) / Math.PI)} ${N(w)}   (comando ativo)`);
      prevAngle = s.angle;
    }
  }
  for (let i = 1; i <= 60; i++) {
    stepShip(s, COAST, DT);
    if (i % 20 === 0) {
      const w = ((s.angle - prevAngle) / (20 * DT)) * (180 / Math.PI);
      console.log(`  ${N(1 + i * DT, 2)} ${N((s.angle * 180) / Math.PI)} ${N(w)}   (comando solto)`);
      prevAngle = s.angle;
    }
  }
  console.log("  esperado newtoniano: vel.ang sobe em rampa e NÃO zera de imediato ao soltar.");
}

console.log("\n=== 3. DERIVA: acelera, gira 90° em inércia, acelera de novo ===");
console.log("   fase              velocidade   deriva(°)   nariz(°)");
{
  const s = makeShip(origin, "p", "builder");
  run(s, THRUST, 2);
  console.log(`  empuxo 2s        ${N(speed(s))} ${N(drift(s))} ${N((s.angle * 180) / Math.PI)}`);
  run(s, TURN, 0.45);
  console.log(`  girou ~90°       ${N(speed(s))} ${N(drift(s))} ${N((s.angle * 180) / Math.PI)}`);
  run(s, COAST, 1);
  console.log(`  inércia 1s       ${N(speed(s))} ${N(drift(s))} ${N((s.angle * 180) / Math.PI)}`);
  run(s, THRUST, 1);
  console.log(`  empuxo 1s        ${N(speed(s))} ${N(drift(s))} ${N((s.angle * 180) / Math.PI)}`);
  console.log("  esperado newtoniano: quando o giro assenta (linha 'inércia 1s') a deriva é ≈ −90°: o vetor");
  console.log("  velocidade não gruda no nariz.");
}

console.log("\n=== 4. MASSA POR CLASSE: 1s de empuxo a partir do repouso ===");
console.log("   classe        velocidade após 1s   (peso relativo)");
{
  const kinds: ShipKind[] = ["builder", "mining", "attack", "transport"];
  const vs: Array<[ShipKind, number]> = [];
  for (const k of kinds) {
    const s = makeShip(origin, "p", k);
    run(s, THRUST, 1);
    vs.push([k, speed(s)]);
  }
  const max = Math.max(...vs.map((v) => v[1]));
  for (const [k, v] of vs) {
    console.log(`  ${k.padEnd(12)} ${N(v)}          ${N((100 * v) / max)}%`);
  }
  console.log("  esperado: o transporte tem que se sentir pesado — números iguais = sem massa.");
}

console.log("\n=== 5. DETERMINISMO: duas execuções idênticas ===");
{
  const trace = () => {
    const s = makeShip(origin, "p", "attack");
    const out: number[] = [];
    for (let i = 0; i < 300; i++) {
      stepShip(s, i % 3 === 0 ? THRUST : TURN, DT);
      if (i % 50 === 0) out.push(s.x, s.y, s.angle, s.vx, s.vy);
    }
    return out.join(",");
  };
  const a = trace();
  const b = trace();
  console.log(`  ${a === b ? "IGUAIS — determinístico" : "DIVERGIRAM — quebrou o determinismo"}`);
}

// ── daqui para baixo: o que a rodada 3 consertou ou acrescentou ────────

const belt = Math.round((BELT_INNER_SECTORS + BELT_OUTER_SECTORS) / 2);
const SEED = 777;

console.log("\n=== 6. GOVERNOR: o que o motor pode fazer ACIMA da velocidade nominal ===");
console.log("   caça (nominal 6000 u/s) jogado a 8400 u/s por um impacto, 1 s de comando");
console.log("   comando                       Δv em 1 s   |v| final   rumo girou");
{
  const cases: Array<[string, ShipInput, number]> = [
    ["nariz PRÓGRADO, empuxo", THRUST, 0],
    ["nariz a 90°, empuxo", THRUST, Math.PI / 2],
    ["nariz RETRÓGRADO, empuxo", THRUST, Math.PI],
    ["RCS lateral (strafe)", { thrust: false, turn: 0, mine: false, strafe: 1 }, 0],
    ["RCS de ré (retro)", { thrust: false, turn: 0, mine: false, retro: true }, 0],
  ];
  for (const [label, input, angle] of cases) {
    const s = makeShip(origin, "p", "attack");
    s.vx = 8400;
    s.angle = angle;
    const h0 = Math.atan2(s.vy, s.vx);
    run(s, input, 1);
    const dv = Math.hypot(s.vx - 8400, s.vy);
    const turned = ((Math.atan2(s.vy, s.vx) - h0) * 180) / Math.PI;
    console.log(`  ${label.padEnd(26)} ${N(dv)} ${N(speed(s))} ${N(turned, 2)}°`);
  }
  console.log("  esperado: só o PRÓGRADO fica no trim (37,5). O resto tem que empurrar de verdade —");
  console.log("  antes do conserto TODOS os casos a menos de 90° davam exatamente 37,5 (motor morto).");
}

console.log("\n=== 7. RCS DE TRANSLAÇÃO: desviar sem girar o casco ===");
console.log("   classe        strafe 1s    ré 1s   % do motor   girar 90° custa");
{
  for (const k of ["builder", "mining", "attack", "transport"] as ShipKind[]) {
    const p = SHIP_PHYSICS[k];
    const st = makeShip(origin, "p", k);
    run(st, { thrust: false, turn: 0, mine: false, strafe: 1 }, 1);
    const rt = makeShip(origin, "p", k);
    rt.vx = 3000;
    run(rt, { thrust: false, turn: 0, mine: false, retro: true }, 1);
    const flip = Math.PI / 2 / p.maxTurnRate;
    console.log(
      `  ${k.padEnd(12)} ${N(st.vy)} ${N(3000 - rt.vx)}    ${N((100 * p.rcsAccel) / p.accel)}%  ${N(flip, 2)} s`,
    );
  }
  const s = makeShip(origin, "p", "attack");
  s.vx = 3000;
  run(s, { thrust: false, turn: 0, mine: false, strafe: 1 }, 2);
  console.log(`  caça a 3000 u/s: 2 s de strafe desviam o RUMO em ${((Math.atan2(s.vy, s.vx) * 180) / Math.PI).toFixed(1)}°`
    + ` com o nariz parado em ${(s.angle * 180 / Math.PI).toFixed(1)}°`);
  console.log("  esperado: RCS sempre MENOR que o motor principal, e o cargueiro o pior de todos.");
}

console.log("\n=== 8. GIRO DE IMPACTO: escala com a força do impacto? ===");
console.log("   impacto a 20° de aproximação (as DUAS componentes crescem juntas)");
console.log("   velocidade   giro impresso (rad/s)   razão com o anterior");
{
  const rock = sectorAsteroids(SEED, belt, 0)[0];
  let prev = 0;
  for (const v of [200, 500, 1000, 2000, 4000, 6000, 12_000]) {
    const s = makeShip({ sx: rock.sx, sy: rock.sy, x: rock.x + rock.radius, y: rock.y });
    s.vx = -v * Math.sin(Math.PI / 9);
    s.vy = v * Math.cos(Math.PI / 9);
    collideShip(s, SEED);
    const av = Math.abs(s.av);
    console.log(`  ${N(v, 0)} ${N(av, 4)}   ${prev ? (av / prev).toFixed(3) : "—"}`);
    prev = av;
  }
  console.log("  esperado: crescer SEMPRE, mesmo encostando no teto de 12 (a razão cai para ~1,04, não para 1,000).");
  console.log("  Com k fisicamente plausível e μ de atrito seco de verdade, o cruzeiro já está na faixa que satura:");
  console.log("  quem segura o valor é o limitador de rodopio, declarado. Antes saturava em 1,2000 já a 484 u/s.");
  console.log("  O ângulo é fixo e a VELOCIDADE varia de propósito: com atrito de Coulomb, segurar a normal");
  console.log("  em −100 u/s e só acelerar a tangente não é bater mais forte — é o mesmo aperto contra a");
  console.log("  parede, e o atrito satura em μ·|jn| como manda o modelo. Bater forte é bater nas duas.");
}

console.log("\n=== 9. PASSO FIXO: h é 1/120 mesmo, em qualquer taxa de quadros? ===");
console.log("   dt da chamada   sub-passos   h efetivo   resíduo guardado");
{
  for (const dt of [1 / 144, 1 / 60, 0.0166667, 1 / 30, 1 / 20, SIM_MAX_DT, 3.0]) {
    const r = drainSubsteps(dt);
    const h = r.steps > 0 ? PHYSICS_SUBSTEP : 0;
    console.log(`  ${N(dt, 7)} ${N(r.steps, 0)} ${N(h, 7)}   ${r.rest.toExponential(2)}`);
  }
  console.log("  esperado: h IDÊNTICO em toda linha. Antes (n=ceil(dt/passo), h=dt/n) o frame real de");
  console.log("  16,667 ms caía em h = 5,556 ms e o tick de 50 ms em 8,333 ms — 33% de diferença.");
  console.log(`  a linha de 3,0 s é drainSubsteps CRU e nunca acontece numa entrada da simulação: admitTime`);
  console.log(`  limita a PENDÊNCIA (atraso guardado + dt novo) a ${SIM_MAX_DT} s, ou seja ${PHYSICS_WORST_CASE_SUBSTEPS} sub-passos por chamada no pior caso.`);

  const rock = sectorAsteroids(SEED, belt, 0)[0];
  const bounce = (dt: number) => {
    const s = makeShip({ sx: rock.sx, sy: rock.sy, x: rock.x - rock.radius - 3000, y: rock.y + 120 }, "p", "attack");
    s.vx = 4000;
    for (let i = 0; i < Math.round(3 / dt); i++) stepShipInWorld(s, COAST, dt, 1, { seed: SEED });
    return s;
  };
  const ref = bounce(1 / 20);
  console.log("   o MESMO quique, medido contra o tick de 20 Hz do servidor:");
  for (const [label, dt] of [["60 Hz", 1 / 60], ["frame real 16,667 ms", 0.0166667],
    ["144 Hz", 1 / 144], ["30 Hz", 1 / 30]] as Array<[string, number]>) {
    const o = bounce(dt);
    console.log(`     ${label.padEnd(22)} Δpos = ${dist(ref, o).toExponential(2)} u   Δv = ${Math.hypot(ref.vx - o.vx, ref.vy - o.vy).toExponential(2)} u/s`);
  }
}

console.log("\n=== 10. TETO DE dt: aplicado DENTRO da simulação ===");
{
  const at: WorldPos = { sx: belt, sy: 0, x: 5000, y: 5000 };
  const world = (dt: number) => {
    const w = new SimWorld(SEED);
    const s = w.addShip("s", at, "p1", "attack");
    s.vx = 3000;
    w.tick(dt);
    return s;
  };
  const stalled = world(3.0);
  const capped = world(SIM_MAX_DT);
  console.log(`  SimWorld.tick(3,0 s) vs tick(${SIM_MAX_DT} s): Δpos = ${dist(stalled, capped).toExponential(2)} u  Δv = ${Math.abs(stalled.vx - capped.vx).toExponential(2)} u/s`);
  const a = makeShip(at, "p", "attack");
  const b = makeShip(at, "p", "attack");
  stepShipInWorld(a, THRUST, 3.0, 1, { seed: SEED });
  stepShipInWorld(b, THRUST, SIM_MAX_DT, 1, { seed: SEED });
  console.log(`  stepShipInWorld(3,0 s) vs (${SIM_MAX_DT} s): estados idênticos? ${JSON.stringify(a) === JSON.stringify(b)}`);
  console.log("  esperado: um tick engasgado entrega EXATAMENTE o mundo do dt no teto — o servidor");
  console.log("  não pode mais saltar à frente da predição do cliente por um stall de GC.");
  console.log("   abaixo do teto o tempo NÃO se perde — 1,2 s de relógio em fatias diferentes, caça sob empuxo:");
  const slices: Array<[string, number, number]> = [
    ["12 × 0,1 s (10 fps)", 0.1, 12], ["6 × 0,2 s (5 fps)", 0.2, 6], ["72 × 1/60 s", 1 / 60, 72],
    ["300 × 0,004 s", 0.004, 300],
  ];
  for (const [label, dt, n] of slices) {
    const s = makeShip(at, "p", "attack");
    for (let i = 0; i < n; i++) stepShip(s, THRUST, dt);
    console.log(`     ${label.padEnd(22)} |v| = ${N(speed(s), 3)} u/s   x = ${N(s.x, 3)}`);
  }
  console.log("  esperado: a mesma linha em todas (a de 0,004 s pode ficar até 1 sub-passo atrás). Antes");
  console.log("  o teto era min(dt, teto) POR CHAMADA e o excedente de cada quadro lento sumia.");
}

console.log("\n=== 11. PARIDADE NA CONDIÇÃO DE CAMPO: snapshot com IDADE, matriz 4×4 ===");
console.log("   Servidor a 20 Hz; cliente a 60 Hz; cada estado do servidor chega `lat` depois e fica em uso");
console.log("   até o seguinte (idade real de lat a lat + 50 ms). 3 encontros × 16 pares de classe; nave");
console.log("   predita com o auxílio desligado (o giro do choque fica guardado e é comparável), em espaço");
console.log("   aberto — no cinturão o caça, voltando, batia numa rocha e mediria a rocha, não o par.");
console.log("   colunas: pior |razão Δv − 1|, pior erro de posição (u), pior erro de giro (rad/s)");
{
  const at: WorldPos = { sx: 0, sy: 0, x: 5000, y: 5000 };
  const KINDS: ShipKind[] = ["builder", "mining", "attack", "transport"];
  const DRIFT: ShipInput = { thrust: false, turn: 0, mine: false, assistOff: true };
  // o snapshot leva a CAMADA: sem ela o fantasma cairia em cruzeiro e não tocaria
  // a nave predita na superfície (é o que o cliente real vai precisar sincronizar)
  const snapOf = (B: ShipState) => ({
    sx: B.sx, sy: B.sy, x: B.x, y: B.y, vx: B.vx, vy: B.vy, av: B.av, kind: B.kind, cargoAmount: B.cargoAmount,
    layer: B.layer, layerTo: B.layerTo, owner: B.owner,
  });
  const run = (lat: number, ageOf: (real: number) => number, otherAssist: boolean, ids: boolean) => {
    let ratio = 0;
    let gap = 0;
    let dav = 0;
    let mutated = 0;
    for (const [offY, vb] of [[0, 0], [25, -800], [10, -2500]]) {
      for (const ka of KINDS) {
        for (const kb of KINDS) {
          const w = new SimWorld(999);
          const A = w.addShip("A", at, "p1", ka);
          const B = w.addShip("B", { ...at, x: at.x + 300, y: at.y + offY }, "p2", kb);
          A.vx = 2000;
          A.av = 0.5;
          B.vx = vb;
          w.setInput("A", DRIFT);
          if (!otherAssist) w.setInput("B", DRIFT);
          const me = makeShip(at, "p1", ka);
          me.vx = 2000;
          me.av = 0.5;
          // o primeiro snapshot também chega com latência (B em t = −lat, em linha reta)
          const o0 = snapOf(B);
          const snaps = [{ t: -lat, o: { ...o0, x: o0.x - o0.vx * lat, y: o0.y - o0.vy * lat }, bits: "" }];
          snaps[0].bits = JSON.stringify(snaps[0].o);
          let tick = 0;
          for (let f = 0; f < 36; f++) {
            const t = f / 60;
            while ((tick + 1) * 0.05 <= t + 1e-9) {
              w.tick(0.05);
              tick++;
              const o = snapOf(B);
              snaps.push({ t: tick * 0.05, o, bits: JSON.stringify(o) });
            }
            let cur = snaps[0];
            for (const sn of snaps) if (sn.t + lat <= t + 1e-9) cur = sn;
            stepShipInWorld(me, DRIFT, 1 / 60, 1, {
              seed: 999, contacts: [cur.o], contactIds: ids ? ["B"] : undefined, contactsAge: ageOf(t - cur.t),
            });
          }
          while (tick < 12) {
            w.tick(0.05);
            tick++;
          }
          for (const sn of snaps) if (JSON.stringify(sn.o) !== sn.bits) mutated++;
          ratio = Math.max(ratio, Math.abs(Math.hypot(me.vx - 2000, me.vy) / Math.hypot(A.vx - 2000, A.vy) - 1));
          gap = Math.max(gap, dist(A, me));
          dav = Math.max(dav, Math.abs(A.av - me.av));
        }
      }
    }
    return `${ratio.toFixed(4).padStart(8)} ${gap.toFixed(2).padStart(9)} ${dav.toFixed(4).padStart(8)}   snapshots alterados: ${mutated}`;
  };
  console.log("   idade REAL informada, outro casco em inércia pura (isola o mecanismo):");
  for (const lat of [0, 0.016, 0.05, 0.075]) {
    console.log(`     ${String(Math.round(lat * 1000)).padStart(3)} ms  ${run(lat, (r) => r, false, true)}`);
  }
  console.log(`   CHUTE fixo de ${SNAPSHOT_AGE_FIXED_GUESS} s (o GameScene não mede a latência), outro com auxílio, SEM o blend:`);
  for (const lat of [0, 0.016, 0.05, 0.075, 0.1, 0.2, 0.3]) {
    console.log(`     ${String(Math.round(lat * 1000)).padStart(3)} ms  ${run(lat, () => SNAPSHOT_AGE_FIXED_GUESS, true, true)}`);
  }
  console.log("   o mesmo, informando idade ZERO (o que o cliente fazia antes):");
  for (const lat of [0.016, 0.05, 0.075]) {
    console.log(`     ${String(Math.round(lat * 1000)).padStart(3)} ms  ${run(lat, () => 0, true, true)}`);
  }
  console.log("   idade real mas SEM ids (o snapshot de antes do choque ressuscita o outro casco):");
  console.log(`      75 ms  ${run(0.075, (r) => r, false, false)}`);
  console.log("  esperado: com idade real e ids, ≈ 0 em todas as latências. Com o CHUTE fixo de 50 ms o Δv sai");
  console.log("  certo de 0 a 75 ms (a posição não: o fantasma nasce fora do lugar pelo erro do chute), e QUEBRA");
  console.log("  de 100 ms para cima: o chute fica curto e o choque se repete. Nada disto inclui o blend da nave");
  console.log("  própria (netcode pendente). Medir a latência exige carimbo de tempo no estado da sala.");
}

console.log("\n=== 12. FLIGHT ASSIST: o auxílio é auxílio, e tem interruptor ===");
console.log("   estado          av após 5 s   |v| após 5 s");
{
  for (const [label, assistOff] of [["ligado (padrão)", false], ["DESLIGADO", true]] as const) {
    const s = makeShip(origin, "p", "builder");
    s.av = 3;
    s.vx = 4000;
    run(s, { thrust: false, turn: 0, mine: false, assistOff }, 5);
    console.log(`  ${label.padEnd(15)} ${N(s.av, 4)} ${N(speed(s))}`);
  }
  console.log("  esperado: desligado, NADA come o giro nem a velocidade — deriva total, como no vácuo.");
}

console.log("\n=== 13. LEME ACIMA DA ROTAÇÃO NOMINAL: reagir tem que ajudar ===");
console.log("   nave a 8 rad/s (rodopio de impacto), tempo até voltar à nominal");
{
  const p = SHIP_PHYSICS.builder;
  const settle = (turn: -1 | 0) => {
    const s = makeShip(origin, "p", "builder");
    s.av = 8;
    for (let i = 0; i < 60 * 60; i++) {
      stepShip(s, { thrust: false, turn, mine: false }, DT);
      if (Math.abs(s.av) <= p.maxTurnRate) return i * DT;
    }
    return Infinity;
  };
  console.log(`  SEGURANDO o leme contra: ${N(settle(-1), 2)} s   (antes: nunca — av ficava em 8,000)`);
  console.log(`  SOLTANDO o leme:         ${N(settle(0), 2)} s`);
  const same = makeShip(origin, "p", "builder");
  same.av = 8;
  run(same, TURN, 2);
  console.log(`  leme A FAVOR por 2 s:    av = ${N(same.av, 4)}  (limitador intacto: não piora)`);
  console.log("  esperado: reagir certo tem que ser MAIS RÁPIDO que não reagir.");
}

console.log("\n=== 14. GOVERNOR NÃO VAZA: 5 min de empuxo a 90°, sem auxílio ===");
console.log("   auxílio        |v| final   pico   (nominal 6000)");
{
  for (const assistOff of [false, true]) {
    const s = makeShip(origin, "p", "attack");
    s.vx = SHIP_PHYSICS.attack.maxSpeed;
    s.angle = Math.PI / 2;
    let peak = speed(s);
    for (let i = 0; i < 60 * 300; i++) {
      stepShip(s, { thrust: true, turn: 0, mine: false, assistOff }, DT);
      if (speed(s) > peak) peak = speed(s);
    }
    console.log(`  ${(assistOff ? "DESLIGADO" : "ligado").padEnd(14)} ${N(speed(s))} ${N(peak)}`);
  }
  console.log("  esperado: nenhum crescimento. Antes, desligado, subia a 6511 u/s (+1,70 u/s², sem teto).");
}

console.log("\n=== 15. CONTATO COM ω×r: a casca é que raspa ===");
console.log("   av antes    vx depois   vy depois   av depois");
{
  const rock = sectorAsteroids(SEED, belt, 0)[0];
  for (const av0 of [5, 0, -5]) {
    const s = makeShip({ sx: rock.sx, sy: rock.sy, x: rock.x + rock.radius, y: rock.y }, "p", "builder");
    s.vx = -100;
    s.vy = 3000;
    s.av = av0;
    collideShip(s, SEED);
    console.log(`  ${N(av0, 1)} ${N(s.vx, 2)} ${N(s.vy, 2)} ${N(s.av, 4)}`);
  }
  console.log("  esperado: av DIFERENTE nos três (antes era idêntico, e saía intacto). vx é normal e");
  console.log("  corretamente indiferente ao giro — ω×r é tangencial. O caso DESLIZA: em atrito seco a");
  console.log("  magnitude é μ·|jn| e o escorregão só decide o sentido, por isso vy é IGUAL nos três. O giro");
  console.log("  é que muda: em ω = +5 o tranco AUMENTA um giro fora da faixa linear e o limitador de rodopio");
  console.log("  deixa passar só uma fração (Δω menor que em ω = 0) — sem tocar na translação. Ver §18.");
  console.log("   pião encostando na parede (o contato tem que TIRAR rotação, e o freio é o MESMO em ω = 8 e 3):");
  for (const av0 of [8, 3, -3]) {
    const s = makeShip({ sx: rock.sx, sy: rock.sy, x: rock.x + rock.radius, y: rock.y }, "p", "builder");
    s.vx = -20;
    s.av = av0;
    collideShip(s, SEED);
    console.log(`     av ${N(av0, 1)} -> ${N(s.av, 4)}   e rolou: vy = ${N(s.vy, 3)}`);
  }
  const a = makeShip(origin, "p", "attack");
  const b = makeShip({ ...origin, x: SHIP_RADIUS, y: SHIP_RADIUS }, "p", "attack");
  a.vx = 3000;
  collideShipPair(a, b);
  console.log(`   par raspando: av_a = ${N(a.av, 4)}  av_b = ${N(b.av, 4)}  — mesmo sentido, como o par de torques manda`);
}

// ── daqui para baixo: o que a rodada 5 consertou ───────────────────────

console.log("\n=== 16. ATRITO DE COULOMB: |jt| tem que caber em μ·|jn| ===");
console.log("   o MESMO deslizamento tangencial (3000 u/s), com aproximações normais diferentes");
console.log("   vn(u/s)        Δvn         Δvt   |Δvt|/|Δvn|");
{
  const rock = sectorAsteroids(SEED, belt, 0)[0];
  for (const vn of [-2000, -100, -0.2]) {
    const s = makeShip({ sx: rock.sx, sy: rock.sy, x: rock.x + rock.radius, y: rock.y }, "p", "builder");
    s.vx = vn;
    s.vy = 3000;
    collideShip(s, SEED);
    console.log(`  ${N(vn, 1)} ${N(s.vx - vn, 4)} ${N(s.vy - 3000, 4)} ${N(Math.abs((s.vy - 3000) / (s.vx - vn)), 3)}`);
  }
  console.log(`  esperado: a razão NUNCA passa de μ = ${ASTEROID_SURFACE_FRICTION.toFixed(4)} (o teto de Coulomb), e é CONSTANTE em μ enquanto`);
  console.log("  desliza: o impulso tangencial acompanha o normal nas três linhas — o limitador de rodopio");
  console.log("  não mexe na translação. Antes: 493 a vn = −0,2, e o MESMO Δvt = −98,55 saía de vn = −2000 e de");
  console.log("  −0,2 — amortecedor viscoso, não atrito.");
}

console.log("\n=== 17. FRONTEIRA DA ARENA: raspar a borda, auxílio LIGADO, 10 s ===");
console.log("        R(u)   vt0(u/s)   |v| final   % mantido    av final   RCS p/ anular");
{
  const hold = SHIP_PHYSICS.builder.attitudeHold;
  for (const R of [80_000, 200_000, 500_000]) {
    for (const vt0 of [1000, 4000]) {
      const center: WorldPos = { sx: belt, sy: 0, x: 5000, y: 5000 };
      const s = makeShip({ sx: belt, sy: 0, x: 5000 + R, y: 5000 }, "p", "builder");
      s.vy = vt0;
      for (let i = 0; i < 600; i++) {
        stepShipInWorld(s, COAST, DT, 1, { boundaryCenter: center, boundaryRadius: R });
      }
      const v = speed(s);
      console.log(
        `  ${N(R, 0)} ${N(vt0, 0)} ${N(v)} ${N((100 * v) / vt0)}% ${N(s.av, 3)} ${N(Math.abs(s.av) / hold, 2)} s`,
      );
    }
  }
  console.log("  esperado: a fronteira é CAMPO, não lixa. A perda é EXATAMENTE o trim (30 u/s² × 10 s = 300 u/s),");
  console.log("  por isso 70% a 1000 u/s e 92,5% a 4000; da borda, nada, e av = 0. Antes: 1000 u/s viravam 0,00");
  console.log("  com av = 15,75, e 4000 u/s deixavam 26% com av = 80,67. O μ = 0 da borda é modelagem, não o");
  console.log("  remendo: a causa do contato prensado foi tratada no contato (§18).");
}

console.log("\n=== 18. CONTATO PRENSADO SUSTENTADO: o atrito age até a casca ROLAR no giro do teto ===");
console.log("   o cenário do crítico: collideShip (a chamada do sub-passo) com 50 u/s de aproximação reimposta");
console.log("   a cada sub-passo — um aperto de ~6000 u/s², acima de qualquer motor — e 4000 u/s na tangente");
console.log("   sub-passo     vt(u/s)      av(rad/s)   perda de vt nos 300 anteriores");
{
  const rock = sectorAsteroids(SEED, belt, 0)[0];
  const s = makeShip({ sx: rock.sx, sy: rock.sy, x: rock.x + rock.radius - 1, y: rock.y }, "p", "builder");
  s.vy = 4000;
  let prev = 4000;
  let linkErr = 0;
  let peak = 0;
  const k = SHIP_PHYSICS.builder.gyration;
  for (let i = 1; i <= 1200; i++) {
    s.vx = -50;
    const vt0 = s.vy;
    const av0 = s.av;
    collideShip(s, SEED);
    peak = Math.max(peak, Math.abs(s.av));
    linkErr = Math.max(linkErr, Math.abs(s.av - av0 - (-SHIP_RADIUS * (s.vy - vt0)) / (k * k)));
    if (i % 300 === 0) {
      console.log(`  ${N(i, 0)} ${N(s.vy, 2)} ${N(s.av, 6)} ${N(prev - s.vy, 2)}`);
      prev = s.vy;
    }
  }
  console.log(`   folga do pico até o teto = ${(IMPACT_SPIN_MAX - peak).toExponential(2)} rad/s   maior tranco cortado pelo limitador num sub-passo = ${linkErr.toFixed(3)} rad/s`);
  console.log(`   escorregamento da casca no fim (vt − ω·R) = ${(s.vy - s.av * SHIP_RADIUS).toFixed(1)} u/s`);
  console.log(`  esperado: av ≤ IMPACT_SPIN_MAX = ${IMPACT_SPIN_MAX}. O atrito cobra μ·|jn| por sub-passo enquanto a casca`);
  console.log("  escorrega, e para quando ela ROLA: vt = ω·R com ω no teto, 12 × 20 = 240 u/s. É o fim físico do");
  console.log("  escorregamento, só que no giro do teto e não no giro livre (v/R = 200 rad/s) — a diferença é");
  console.log("  momento angular que o limitador de rodopio joga fora, declarado. Na rodada anterior o limitador");
  console.log("  escalava também o atrito linear, e no teto a rocha virava gelo (3594 u/s escorregando sem perda).");
}

console.log("\n=== 19. A PREDIÇÃO NÃO ESCREVE NO SNAPSHOT AUTORITATIVO ===");
{
  const at: WorldPos = { sx: belt, sy: 0, x: 5000, y: 5000 };
  const me = makeShip(at, "p1", "attack");
  me.vx = 4000;
  const snap = {
    sx: at.sx, sy: at.sy, x: at.x + 900, y: at.y,
    vx: 0, vy: 0, av: 0, kind: "transport" as ShipKind, layer: "surface" as const,
  };
  const before = { ...snap };
  for (let i = 0; i < 20; i++) stepShipInWorld(me, COAST, DT, 1, { seed: 999, contacts: [snap] });
  console.log(
    `  20 frames preditos contra o snapshot: Δx = ${N(snap.x - before.x, 4)} u  Δvx = ${N(snap.vx - before.vx, 4)} u/s  Δav = ${N(snap.av - before.av, 4)}`,
  );
  console.log("  esperado: zeros. Antes: 8,24 u injetados num único frame — e o draw() interpolava a malha");
  console.log("  remota contra esse MESMO objeto, então a predição inventava movimento para a nave do outro.");
}

console.log("\n=== 20. RECONCILIAÇÃO DE `av`: erro de rumo que o blend deixava para trás ===");
console.log("   (reproduz GameScene.blendTowards a 60 Hz, OWN_BLEND = 0,1, 5 s)");
console.log("   auxílio     Δav inicial   erro de rumo SEM blend de av   COM blend de av");
{
  const BLEND = 0.1;
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const deg = (r: number) => (Math.abs(r) * 180) / Math.PI;
  for (const assistOff of [true, false]) {
    for (const dav of [3, 8]) {
      const errs: number[] = [];
      for (const blendAv of [false, true]) {
        const input: ShipInput = { thrust: false, turn: 0, mine: false, assistOff };
        const server = makeShip(origin, "p", "builder"); // o autoritativo: sem giro
        const local = makeShip(origin, "p", "builder");
        local.av = dav; // a predição errou o giro (contato não predito, pacote perdido)
        let worst = 0;
        for (let i = 0; i < 300; i++) {
          stepShip(server, input, DT);
          stepShip(local, input, DT);
          local.angle += wrap(server.angle - local.angle) * BLEND;
          if (blendAv) local.av += (server.av - local.av) * BLEND;
          worst = Math.max(worst, Math.abs(wrap(server.angle - local.angle)));
        }
        errs.push(assistOff ? Math.abs(wrap(server.angle - local.angle)) : worst);
      }
      const label = assistOff ? "DESLIGADO" : "ligado";
      const kind = assistOff ? "permanente" : "pico";
      console.log(`  ${label.padEnd(11)} ${N(dav, 0)} ${N(deg(errs[0]), 2)}° (${kind})   ${N(deg(errs[1]), 2)}°`);
    }
  }
  console.log("  esperado: com assistOff, sem blend de av o erro de rumo é PERMANENTE (nada reconcilia a");
  console.log("  velocidade angular) e com ele vai a zero. Com o auxílio ligado o RCS já mata o giro sozinho,");
  console.log("  e o blend de av corta o PICO do erro à metade — não o zera.");
}

console.log("\n=== 21. RASPÃO: o choque não pode depender da velocidade nem da fase do sub-passo ===");
console.log("   caça passando rente à MENOR rocha, entrando p u na seção de choque; 24 fases de largada");
console.log("   (onde os pontos finais dos sub-passos caem em relação à rocha). |Δvy| mín..máx entre as fases");
{
  const small = sectorAsteroids(SEED, belt, 0).reduce((m, r) => (r.radius < m.radius ? r : m));
  const target = small.radius + SHIP_RADIUS;
  const e = SHIP_PHYSICS.attack.restitution; // × 1,0 da rocha
  for (const pen of [0.25, 1, 5]) {
    const cells: string[] = [];
    for (const v of [2000, 6000, 12_000]) {
      const d = target - pen;
      const ideal = (1 + e) * v * Math.sqrt(1 - (d / target) ** 2) * (d / target);
      let lo = Infinity;
      let hi = 0;
      let hits = 0;
      for (let k = 0; k < 24; k++) {
        const s = makeShip(
          { sx: small.sx, sy: small.sy, x: small.x - 600 - (k / 24) * (v / 120), y: small.y + d }, "p", "attack",
        );
        s.vx = v;
        for (let i = 0; i < 400; i++) {
          stepShipInWorld(s, COAST, DT, 1, { seed: SEED });
          if (s.x - small.x > 700) break;
        }
        const dvy = Math.abs(s.vy);
        if (dvy > 1e-6) hits++;
        lo = Math.min(lo, dvy);
        hi = Math.max(hi, dvy);
      }
      cells.push(`${v} u/s: ${String(hits).padStart(2)}/24  ${lo.toFixed(0)}..${hi.toFixed(0)} (só normal ${ideal.toFixed(0)})`);
    }
    console.log(`  p = ${String(pen).padEnd(4)} ${cells.join(" | ")}`);
  }
  console.log("  esperado: 24/24 em todas, mín ≈ máx (a fase não sorteia), e perto do impulso normal (o atrito");
  console.log("  tira um pouco). Antes: a 6000 u/s com p = 1, 10 de 24 fases, Δvy de 0 a 767 — o teste de ponto");
  console.log("  pulava a corda, e o 'ponto de maior aproximação' tinha vn = 0 e não aplicava nada.");
}

console.log("\n=== 22. PAR NAVE × NAVE PRENSANDO CONTRA A ROCHA: os sólidos têm a última palavra ===");
console.log("   caça encostado na rocha, cargueiro chegando por trás e EMPURRANDO (motor ligado), 2 s,");
console.log("   sub-passo a sub-passo: pior penetração do caça na pedra e pior sobreposição dos cascos");
{
  const rock = sectorAsteroids(SEED, belt, 0)[0];
  const minD = rock.radius + SHIP_RADIUS;
  for (const vb of [800, 2000, 4000]) {
    const w = new SimWorld(SEED);
    const a = w.addShip("a", { sx: rock.sx, sy: rock.sy, x: rock.x - minD, y: rock.y }, "p1", "attack");
    const b = w.addShip("b", { sx: rock.sx, sy: rock.sy, x: rock.x - minD - 400, y: rock.y }, "p2", "transport");
    b.vx = vb;
    w.setInput("b", THRUST);
    let pen = 0;
    let over = 0;
    for (let i = 0; i < 240; i++) {
      w.tick(PHYSICS_SUBSTEP);
      pen = Math.max(pen, minD - dist(a, rock));
      over = Math.max(over, 2 * SHIP_RADIUS - dist(a, b));
    }
    console.log(`  cargueiro a ${N(vb, 0)} u/s: penetração ${pen.toExponential(2)} u   sobreposição ${over.toExponential(2)} u`);
  }
  console.log("  esperado: ≈ 0 (arredondamento) nos dois. Antes (medido pelo crítico): cascos sobrepostos 5,1–10,2 u");
  console.log("  no fim do tick — a rocha devolvia o caça para dentro do cargueiro. Agora o casco que a rocha");
  console.log("  segurou fica PRESO (massa infinita) no par refeito, e quem sai do caminho é o cargueiro.");
}

console.log("\n=== 23. PAR NAVE × NAVE CONTÍNUO: o passo relativo não atravessa o casco ===");
console.log("   caça contra nave, mira central, 24 fases de largada, servidor; Δv do caça mín..máx entre fases");
{
  const at: WorldPos = { sx: belt, sy: 0, x: 5000, y: 5000 };
  for (const [va, vb] of [[6000, 0], [5200, -5200], [12_000, 0]]) {
    let through = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < 24; k++) {
      const w = new SimWorld(999);
      const a0 = { ...at, x: at.x - 600 - (k / 24) * (Math.abs(va - vb) / 120) };
      const A = w.addShip("A", a0, "p1", "attack");
      const B = w.addShip("B", { ...at, x: at.x + 300 }, "p2", "builder");
      A.vx = va;
      B.vx = vb;
      for (let i = 0; i < 12; i++) w.tick(0.05);
      if (dist(A, a0) > dist(B, a0)) through++;
      lo = Math.min(lo, A.vx - va);
      hi = Math.max(hi, A.vx - va);
    }
    console.log(`  ${N(va, 0)} contra ${N(vb, 0)}: atravessou ${through}/24   Δvx ${lo.toFixed(1)}..${hi.toFixed(1)}`);
  }
  console.log("  esperado: 0/24 e mín ≈ máx. Antes (medido pelo crítico): 5 de 24 a 6000 contra parado, 13 de 24");
  console.log("  a 5200 de frente — o passo relativo de 50–100 u pulava o diâmetro de 40 u.");
}

console.log("\n=== 24. ORDEM DOS PARES: nem a do Map, nem a dos ids ===");
console.log("   caça parado entre dois cargueiros simétricos a ±3000 u/s; vx final do caça");
{
  const at: WorldPos = { sx: belt, sy: 0, x: 5000, y: 5000 };
  const squeeze = (insertion: string[], left: string, right: string) => {
    const w = new SimWorld(999);
    const add: Record<string, () => void> = {
      F: () => { w.addShip("F", at, "p", "attack"); },
      [left]: () => { w.addShip(left, { ...at, x: at.x - 100 }, "p", "transport").vx = 3000; },
      [right]: () => { w.addShip(right, { ...at, x: at.x + 100 }, "p", "transport").vx = -3000; },
    };
    for (const k of insertion) add[k]();
    for (let i = 0; i < 4; i++) w.tick(0.05);
    return (w.ships.get("F") as ShipState).vx;
  };
  for (const order of [["F", "L", "R"], ["R", "L", "F"], ["L", "F", "R"]]) {
    console.log(`  inserção ${order.join(",")} (esquerdo "L", direito "R"): ${N(squeeze(order, "L", "R"), 3)}`);
  }
  console.log(`  ids TROCADOS (esquerdo "R", direito "L"):          ${N(squeeze(["F", "L", "R"], "R", "L"), 3)}`);
  console.log("  esperado: 0 nas quatro. Antes, com os pares em sequência, o caça saía a −3364,9 ou +3364,9");
  console.log("  conforme a inserção, e depois ±3431,6 conforme os ids. O solver iterativo resolve os contatos");
  console.log("  simultâneos juntos e converge para uma solução única: espremido por dois iguais, o caça fica.");
}

console.log("\n=== 25. RAIO DE GIRAÇÃO ≤ RAIO DO CORPO (R = 20 u), com o giro de antes ===");
console.log("   classe       k antes→agora   torque antes→agora   α (rad/s²)   90° em   180° em");
{
  const OLD: Record<ShipKind, [number, number]> = {
    builder: [26, 6300], mining: [30, 8000], attack: [22, 5400], transport: [42, 11600],
  };
  for (const k of ["builder", "mining", "attack", "transport"] as ShipKind[]) {
    const p = SHIP_PHYSICS[k];
    const turn = (target: number) => {
      const s = makeShip(origin, "p", k);
      let n = 0;
      while (s.angle < target && n < 10_000) {
        stepShip(s, TURN, PHYSICS_SUBSTEP);
        n++;
      }
      return n * PHYSICS_SUBSTEP;
    };
    const oldAlpha = OLD[k][1] / (p.mass * OLD[k][0] ** 2);
    console.log(
      `  ${k.padEnd(10)} ${String(OLD[k][0]).padStart(5)} → ${String(p.gyration).padStart(2)}   ${String(OLD[k][1]).padStart(7)} → ${p.torque.toFixed(0).padStart(5)}` +
      `   ${oldAlpha.toFixed(3)} → ${p.angularAccel.toFixed(3)}  ${turn(Math.PI / 2).toFixed(3)} s  ${turn(Math.PI).toFixed(3)} s`,
    );
  }
  console.log("  esperado: k ≤ 20 em todas (k² = ∫r²dm/m ≤ R² é teorema; 42 u num casco de 20 era impossível), α");
  console.log("  IGUAL antes e depois — o torque caiu na mesma razão (k_novo/k_antigo)² — e o cargueiro ainda o");
  console.log("  mais lento para virar, agora por ter menos torque por inércia. Os μ de atrito ficaram nos valores");
  console.log("  de atrito seco (rocha 0,07): o giro de impacto subiu (§8) e o teto de giro o contém.");
}

console.log("\n=== 26. CASCOS EM CADEIA E SIMULTÂNEOS: sem túnel, sem sobreposição, sem ordem ===");
console.log("   cargueiro contra um caça ENCOSTADO noutro caça (folga 0 e 15 u), 24 fases, espaço aberto, 1 s");
{
  const at: WorldPos = { sx: 0, sy: 0, x: 5000, y: 5000 };
  const wx = (q: WorldPos) => q.sx * 10_000 + q.x;
  const chain = (v: number, k: number, ids: string[], gap: number) => {
    const w = new SimWorld(999);
    const T = w.addShip(ids[0], { ...at, x: at.x - 400 - (k / 24) * (v / 120) }, "p", "transport");
    const M = w.addShip(ids[1], at, "p", "attack");
    const L = w.addShip(ids[2], { ...at, x: at.x + 2 * SHIP_RADIUS + gap }, "p", "attack");
    T.vx = v;
    let over = 0;
    let through = false;
    for (let i = 0; i < 20; i++) {
      w.tick(0.05);
      over = Math.max(over, 2 * SHIP_RADIUS - dist(T, M), 2 * SHIP_RADIUS - dist(M, L));
      if (wx(M) > wx(L) || wx(T) > wx(M)) through = true;
    }
    return { through, over, v: [T.vx, M.vx, L.vx] };
  };
  for (const gap of [0, 15]) {
    for (const v of [3000, 6000, 12_000]) {
      let th = 0;
      let over = 0;
      let spread = 0;
      let order = 0;
      const ref = chain(v, 0, ["a", "b", "c"], gap);
      for (let k = 0; k < 24; k++) {
        const r = chain(v, k, ["a", "b", "c"], gap);
        const q = chain(v, k, ["c", "a", "b"], gap);
        if (r.through) th++;
        over = Math.max(over, r.over);
        for (let i = 0; i < 3; i++) {
          spread = Math.max(spread, Math.abs(r.v[i] - ref.v[i]));
          order = Math.max(order, Math.abs(r.v[i] - q.v[i]));
        }
      }
      console.log(`  folga ${String(gap).padStart(2)} u, ${N(v, 0)} u/s: atravessou ${th}/24  sobreposição ${over.toExponential(1)} u  fase ±${spread.toFixed(2)} u/s  ids ±${order.toExponential(1)} u/s`);
    }
  }
  console.log("   caça a 6000 u/s mirando ENTRE dois parados (três corpos no mesmo instante), 24 fases:");
  const tri = (k: number, ids: string[]) => {
    const w = new SimWorld(999);
    const F = w.addShip(ids[0], { ...at, x: at.x - 400 - (k / 24) * 50 }, "p", "attack");
    F.vx = 6000;
    const U = w.addShip(ids[1], { ...at, y: at.y + 19 }, "p", "builder");
    const D = w.addShip(ids[2], { ...at, y: at.y - 19 }, "p", "builder");
    for (let i = 0; i < 10; i++) w.tick(0.05);
    return [F.vx, F.vy, U.vx, U.vy, D.vx, D.vy];
  };
  const r0 = tri(0, ["f", "u", "d"]);
  let spread = 0;
  let order = 0;
  for (let k = 0; k < 24; k++) {
    const a = tri(k, ["f", "u", "d"]);
    const b = tri(k, ["u", "d", "f"]);
    for (let i = 0; i < 6; i++) {
      spread = Math.max(spread, Math.abs(a[i] - r0[i]));
      order = Math.max(order, Math.abs(a[i] - b[i]));
    }
  }
  console.log(`     F = (${r0[0].toFixed(1)}, ${r0[1].toFixed(3)})  U = (${r0[2].toFixed(1)}, ${r0[3].toFixed(1)})  D = (${r0[4].toFixed(1)}, ${r0[5].toFixed(1)})`);
  console.log(`     fase ±${spread.toFixed(2)} u/s   ids ±${order.toExponential(1)} u/s`);
  console.log("  esperado: 0/24, sobreposição ≈ 0, fase só no trim (< 1 u/s), ids ≈ 0, e U/D espelhados com F");
  console.log("  sem desvio lateral. Antes (medido pelo crítico): o do meio atravessava o último em 12–21 de 24");
  console.log("  fases, a cadeia ficava 25–40 u sobreposta, a ordem dos ids mudava o erro de 0,9 para 2851 u/s,");
  console.log("  e nos três corpos o erro ia de 0 a 494 u/s conforme a fase.");
}

console.log("\n=== CAMADAS: contra o que a nave colide em cada camada ===");
console.log("   caça a 3000 u/s pelo centro da menor rocha do setor, e pelo centro de Ceres");
console.log("   camada        rocha: menor distância   Ceres: menor distância   (raio rocha / raio Ceres)");
{
  const rock = sectorAsteroids(SEED, belt, 0).reduce((m, r) => (r.radius < m.radius ? r : m));
  const ceres = new SimWorld(SEED).ceres;
  const closest = (layer: "cruise" | "surface" | "attack", target: WorldPos, radius: number, env: Parameters<typeof stepShipInWorld>[4]) => {
    const s = makeShipRaw({ sx: target.sx, sy: target.sy, x: target.x - radius - 400, y: target.y }, "p", "attack");
    setLayer(s, layer);
    s.vx = 3000;
    let c = Infinity;
    // folga de 20% no tempo: o auxílio de voo desacelera a nave em inércia, e
    // no raio de Ceres (20 000 u) ela pararia antes do centro sem bater em nada
    for (let i = 0; i < Math.round(((radius + 400) / 3000 * 1.2 + 0.1) * 60); i++) {
      stepShipInWorld(s, COAST, 1 / 60, 1, env);
      c = Math.min(c, dist(s, target));
    }
    return c;
  };
  const cr = CERES_RADIUS;
  for (const layer of ["cruise", "surface", "attack"] as const) {
    const r = closest(layer, rock, rock.radius, { seed: SEED });
    const c = closest(layer, ceres, cr, { ceres });
    console.log(`  ${layer.padEnd(10)} ${N(r)}                ${N(c)}               (${rock.radius.toFixed(0)} / ${cr})`);
  }
  console.log("  esperado: cruzeiro e ataque passam pelo centro (≈ 0) nos dois; superfície nunca entra");
  console.log("  (menor distância ≥ raio). Naves na mesma camada colidem entre si; camadas diferentes não.");
}
