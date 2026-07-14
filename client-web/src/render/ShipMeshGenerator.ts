/**
 * ShipMeshGenerator — malha 3D wireframe por classe de nave, montada a
 * partir de MÓDULOS COMUNS (cabine, spine leve/pesada, motores 2×/4×,
 * broca, guindaste, braços mecânicos, asas armadas, carga, containers,
 * deck, radar). Formas e layout capturados do protótipo de arte
 * (docs/visualizador_de_naves_modulares.html — modo holograma); as chamas
 * de motor do protótipo ficam de fora (o jato é do EffectsRenderer).
 *
 * Cada classe é um MANIFESTO DE MONTAGEM: módulos + offsets. Os módulos
 * são montados como triângulos e o resultado é reduzido às ARESTAS DE
 * FEIÇÃO (bordas + vincos, via ângulo diedro — wireframe de triângulos
 * puro satura em borrão com o glow), fundidas numa lista única de
 * segmentos por classe: o MeshFactory desenha tudo numa só GreasedLine —
 * uma malha, um draw call por nave.
 *
 * Espaços de coordenadas:
 *   - Os módulos são descritos no quadro do PROTÓTIPO (x lateral, y para
 *     cima, z para a frente), com os números originais preservados.
 *   - `finalize` converte ao quadro local de cena da nave (+X = nariz,
 *     Y lateral, −Z em direção à câmera) e NORMALIZA a escala: o alcance
 *     radial máximo em planta vira `planR × SHIP_RADIUS` (coerente com a
 *     silhueta 2D anterior e o raio de colisão) e a profundidade é
 *     achatada para ±MAX_HALF_DEPTH — em câmera ortográfica top-down a
 *     altura não aparece na projeção, só no depth test, então o
 *     achatamento não tem custo visual e mantém a nave dentro da sua
 *     camada de voo (render/layers.ts).
 *
 * Geometria puramente visual e determinística por classe — sem engine,
 * entidades, multiplayer ou lógica de jogo.
 */

import { SHIP_RADIUS } from "@ceres/shared";
import type { ShipKind } from "@ceres/shared";

/** meia-profundidade máxima da nave em unidades de mundo (orçamento de Z) */
const MAX_HALF_DEPTH = 2.5;

/** alcance radial em planta por classe, em múltiplos de SHIP_RADIUS —
 *  mesmos valores máximos das silhuetas 2D anteriores (broca estica a mining) */
const PLAN_RADIUS: Record<ShipKind, number> = {
  builder: 1.0,
  mining: 1.35,
  attack: 1.15,
  transport: 1.12,
};

export interface ShipMeshData {
  /** segmentos de ARESTA (x1,y1,z1,x2,y2,z2 por segmento), espaço de cena */
  segments: number[];
}

// ── acumulador de geometria ────────────────────────────────────────────

/** rotação Euler aplicada como no Babylon (roll Z, depois pitch X, depois yaw Y) */
type Rot = { x?: number; y?: number; z?: number };

class Acc {
  positions: number[] = [];
  indices: number[] = [];

  /** adiciona vértices/índices com rotação + translação (quadro do protótipo) */
  push(verts: number[], idx: number[], px: number, py: number, pz: number, rot?: Rot): void {
    const base = this.positions.length / 3;
    const { sx, cx, sy, cy, sz, cz } = {
      sx: Math.sin(rot?.x ?? 0), cx: Math.cos(rot?.x ?? 0),
      sy: Math.sin(rot?.y ?? 0), cy: Math.cos(rot?.y ?? 0),
      sz: Math.sin(rot?.z ?? 0), cz: Math.cos(rot?.z ?? 0),
    };
    for (let i = 0; i < verts.length; i += 3) {
      let x = verts[i], y = verts[i + 1], z = verts[i + 2];
      // roll (Z)
      let t = x; x = t * cz - y * sz; y = t * sz + y * cz;
      // pitch (X)
      t = y; y = t * cx - z * sx; z = t * sx + z * cx;
      // yaw (Y)
      t = z; z = t * cy - x * sy; x = t * sy + x * cy;
      this.positions.push(x + px, y + py, z + pz);
    }
    for (const i of idx) this.indices.push(base + i);
  }
}

// ── primitivas (locais, centradas na origem, eixo Y = altura) ──────────

const boxGeo = (w: number, h: number, d: number): [number[], number[]] => {
  const x = w / 2, y = h / 2, z = d / 2;
  return [
    [-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z],
    [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2],
  ];
};

/** cilindro/cone sem tampas (rims lêem bem de cima; tampas só poluem) */
const cylGeo = (dTop: number, dBottom: number, h: number, tess: number): [number[], number[]] => {
  const verts: number[] = [];
  const idx: number[] = [];
  const rt = dTop / 2, rb = dBottom / 2, y = h / 2;
  if (rt <= 0) {
    // cone: ápice + anel inferior
    verts.push(0, y, 0);
    for (let i = 0; i < tess; i++) {
      const a = (i / tess) * Math.PI * 2;
      verts.push(Math.cos(a) * rb, -y, Math.sin(a) * rb);
    }
    for (let i = 0; i < tess; i++) idx.push(0, 1 + i, 1 + ((i + 1) % tess));
  } else {
    for (let i = 0; i < tess; i++) {
      const a = (i / tess) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      verts.push(c * rt, y, s * rt, c * rb, -y, s * rb);
    }
    for (let i = 0; i < tess; i++) {
      const t0 = i * 2, b0 = i * 2 + 1;
      const t1 = ((i + 1) % tess) * 2, b1 = ((i + 1) % tess) * 2 + 1;
      idx.push(t0, b0, b1, t0, b1, t1);
    }
  }
  return [verts, idx];
};

/** esfera UV low-poly (juntas pequenas — não precisa de mais) */
const sphereGeo = (d: number, slices = 6, stacks = 4): [number[], number[]] => {
  const r = d / 2;
  const verts: number[] = [0, r, 0];
  const idx: number[] = [];
  for (let st = 1; st < stacks; st++) {
    const phi = (st / stacks) * Math.PI;
    for (let sl = 0; sl < slices; sl++) {
      const th = (sl / slices) * Math.PI * 2;
      verts.push(Math.sin(phi) * Math.cos(th) * r, Math.cos(phi) * r, Math.sin(phi) * Math.sin(th) * r);
    }
  }
  verts.push(0, -r, 0);
  const bottom = verts.length / 3 - 1;
  const ring = (st: number, sl: number) => 1 + (st - 1) * slices + (sl % slices);
  for (let sl = 0; sl < slices; sl++) idx.push(0, ring(1, sl), ring(1, sl + 1));
  for (let st = 1; st < stacks - 1; st++)
    for (let sl = 0; sl < slices; sl++)
      idx.push(ring(st, sl), ring(st + 1, sl), ring(st + 1, sl + 1), ring(st, sl), ring(st + 1, sl + 1), ring(st, sl + 1));
  for (let sl = 0; sl < slices; sl++) idx.push(bottom, ring(stacks - 1, sl + 1), ring(stacks - 1, sl));
  return [verts, idx];
};

// ── biblioteca de módulos comuns (números do protótipo) ────────────────

type Off = { x: number; y: number; z: number };
const at = (x: number, y: number, z: number): Off => ({ x, y, z });

/** Cabine: corpo + vidro cônico inclinado. */
function modCabin(a: Acc, o: Off): void {
  a.push(...boxGeo(1.2, 1.0, 1.8), o.x, o.y, o.z);
  a.push(...cylGeo(0.1, 1.2, 1.2, 4), o.x, o.y + 0.1, o.z + 0.4, { x: Math.PI / 2 });
}

/** Espinha dorsal treliçada (chassi), leve ou pesada. */
function modSpine(a: Acc, o: Off, heavy: boolean): void {
  const length = heavy ? 4.5 : 3.5;
  const h = heavy ? 0.6 : 0.4;
  const w = heavy ? 0.8 : 0.6;
  a.push(...boxGeo(w, 0.1, length), o.x, o.y + h / 2, o.z);
  a.push(...boxGeo(w, 0.1, length), o.x, o.y - h / 2, o.z);
  const steps = heavy ? 6 : 4;
  for (let i = 0; i <= steps; i++) {
    const zPos = -length / 2 + (length / steps) * i;
    a.push(...boxGeo(w + 0.1, h, 0.1), o.x, o.y, o.z + zPos);
    if (i < steps) {
      a.push(...boxGeo(0.05, h * 1.3, 0.05), o.x, o.y, o.z + zPos + length / steps / 2, { x: Math.PI / 4 });
    }
  }
}

/** Motores duplos leves (2 nacelas + bocais). */
function modEngineSmall(a: Acc, o: Off): void {
  for (const side of [-0.4, 0.4]) {
    a.push(...cylGeo(0.35, 0.5, 1.5, 8), o.x + side, o.y, o.z, { x: Math.PI / 2 });
    a.push(...cylGeo(0.5, 0.3, 0.4, 8), o.x + side, o.y, o.z - 0.8, { x: Math.PI / 2 });
  }
}

/** Motores quadruplos pesados (arranjo 2×2 + bocais). */
function modEngineLarge(a: Acc, o: Off): void {
  for (const p of [{ x: -0.5, y: 0.4 }, { x: 0.5, y: 0.4 }, { x: -0.5, y: -0.4 }, { x: 0.5, y: -0.4 }]) {
    a.push(...cylGeo(0.45, 0.7, 1.8, 8), o.x + p.x, o.y + p.y, o.z, { x: Math.PI / 2 });
    a.push(...cylGeo(0.6, 0.4, 0.5, 8), o.x + p.x, o.y + p.y, o.z - 1.0, { x: Math.PI / 2 });
  }
}

/** Broca de mineração: corpo, cone helicoidal e anéis escalonados. */
function modDrill(a: Acc, o: Off): void {
  a.push(...cylGeo(1.2, 1.2, 0.4, 8), o.x, o.y, o.z, { x: Math.PI / 2 });
  a.push(...cylGeo(0, 1.0, 2.2, 6), o.x, o.y, o.z + 1.1, { x: Math.PI / 2 });
  for (let i = 1; i <= 4; i++) {
    const ringSize = 1.0 - i * 0.2;
    a.push(...cylGeo(ringSize, ringSize + 0.1, 0.15, 6), o.x, o.y, o.z + 0.2 + i * 0.45, { x: Math.PI / 2 });
  }
}

/** Guindaste articulado superior. */
function modCrane(a: Acc, o: Off): void {
  a.push(...cylGeo(0.8, 0.8, 0.3, 12), o.x, o.y, o.z);
  a.push(...boxGeo(0.2, 1.5, 0.2), o.x, o.y + 0.75, o.z, { x: -Math.PI / 6 });
  a.push(...boxGeo(0.15, 0.15, 2.2), o.x, o.y + 1.6, o.z + 0.7);
  a.push(...cylGeo(0.03, 0.03, 1.0, 4), o.x, o.y + 1.1, o.z + 1.6);
  a.push(...boxGeo(0.3, 0.2, 0.3), o.x, o.y + 0.6, o.z + 1.6);
}

/** Braço mecânico lateral com garra (side = ±1). */
function modMechanicalArm(a: Acc, o: Off, side: number): void {
  a.push(...cylGeo(0.4, 0.4, 0.4, 8), o.x, o.y, o.z, { z: Math.PI / 2 });
  const a1x = 0.1 * side, a1z = 0.5;
  a.push(...boxGeo(0.15, 0.15, 1.2), o.x + a1x, o.y, o.z + a1z, { y: 0.3 * side });
  const ex = a1x + Math.sin(0.3 * side) * 0.6, ez = a1z + Math.cos(0.3 * side) * 0.6;
  a.push(...sphereGeo(0.3), o.x + ex, o.y, o.z + ez);
  const a2x = ex - 0.1 * side, a2z = ez + 0.4;
  a.push(...boxGeo(0.12, 0.12, 0.8), o.x + a2x, o.y, o.z + a2z, { y: -0.15 * side });
  a.push(...boxGeo(0.4, 0.1, 0.3), o.x + a2x, o.y, o.z + a2z + 0.4);
}

/** Asa de ataque com canhão e canos duplos (side = ±1). */
function modWingWeapon(a: Acc, o: Off, side: number): void {
  a.push(...boxGeo(1.8, 0.1, 1.5), o.x + 1.0 * side, o.y, o.z, { y: 0.2 * side, z: -0.15 * side });
  a.push(...cylGeo(0.2, 0.2, 1.6, 8), o.x + 1.7 * side, o.y, o.z + 0.4, { x: Math.PI / 2 });
  for (const off of [-0.07, 0.07]) {
    a.push(...cylGeo(0.05, 0.05, 0.8, 4), o.x + (1.7 + off) * side, o.y, o.z + 1.2, { x: Math.PI / 2 });
  }
}

/** Gaiola de carga com blocos internos. */
function modCargo(a: Acc, o: Off): void {
  a.push(...boxGeo(1.8, 1.1, 3.2), o.x, o.y, o.z);
  for (const z of [-0.9, 0, 0.9]) a.push(...boxGeo(1.4, 0.8, 0.7), o.x, o.y, o.z + z);
}

/** Bloco triplo de containers com frisos em X. */
function modContainers(a: Acc, o: Off): void {
  for (const pos of [-1.0, 0, 1.0]) {
    a.push(...boxGeo(1.6, 1.1, 0.85), o.x, o.y, o.z + pos);
    a.push(...boxGeo(1.62, 0.05, 0.05), o.x, o.y, o.z + pos, { y: 0.5 });
    a.push(...boxGeo(1.62, 0.05, 0.05), o.x, o.y, o.z + pos, { y: -0.5 });
  }
}

/** Deck de placas com pinos de amarração. */
function modDeck(a: Acc, o: Off): void {
  a.push(...boxGeo(2.2, 0.15, 3.0), o.x, o.y, o.z);
  for (const z of [-1.0, 0, 1.0])
    for (const x of [-0.8, 0.8]) a.push(...boxGeo(0.15, 0.5, 0.15), o.x + x, o.y + 0.25, o.z + z);
}

/** Radar: mastro, domo e placa rotativa. */
function modRadar(a: Acc, o: Off): void {
  a.push(...cylGeo(0.1, 0.1, 1.2, 4), o.x, o.y + 0.6, o.z);
  a.push(...boxGeo(0.6, 0.1, 0.6), o.x, o.y + 1.2, o.z);
  a.push(...boxGeo(0.1, 0.4, 0.4), o.x, o.y + 1.45, o.z);
}

// ── manifestos de montagem por classe (presets do protótipo) ───────────

const ASSEMBLE: Record<ShipKind, (a: Acc) => void> = {
  // Construtora: spine leve + cabine + motores leves + guindaste + braços + deck
  builder: (a) => {
    modSpine(a, at(0, 0, 0), false);
    modCabin(a, at(0, 0, 2.5));
    modEngineSmall(a, at(0, 0, -2.4));
    modCrane(a, at(0, 0.4, 0.2));
    modMechanicalArm(a, at(-0.5, 0, 0.8), -1);
    modMechanicalArm(a, at(0.5, 0, 0.8), 1);
    modDeck(a, at(0, -0.5, -0.2));
  },
  // Mineradora: spine pesada + cabine + broca + carga + garras + motores pesados
  mining: (a) => {
    modSpine(a, at(0, 0, 0), true);
    modCabin(a, at(0, 0, 1.3));
    modDrill(a, at(0, 0, 2.8));
    modCargo(a, at(0, 0.1, -1.1));
    modMechanicalArm(a, at(-0.6, -0.2, 1.0), -1);
    modMechanicalArm(a, at(0.6, -0.2, 1.0), 1);
    modEngineLarge(a, at(0, 0, -2.8));
  },
  // Ataque: spine leve + cabine + radar + asas armadas + motores pesados
  attack: (a) => {
    modSpine(a, at(0, 0, 0), false);
    modCabin(a, at(0, 0.1, 2.3));
    modRadar(a, at(0, 0.5, 0.2));
    modWingWeapon(a, at(-0.6, 0, 0.2), -1);
    modWingWeapon(a, at(0.6, 0, 0.2), 1);
    modEngineLarge(a, at(0, 0, -2.4));
  },
  // Transporte: spine pesada + cabine + containers + deck + motores pesados
  transport: (a) => {
    modSpine(a, at(0, 0, 0), true);
    modCabin(a, at(0, 0, 2.5));
    modContainers(a, at(0, 0.2, -0.2));
    modDeck(a, at(0, -0.4, -0.2));
    modEngineLarge(a, at(0, 0, -2.6));
  },
};

// ── conversão de quadro + normalização de escala ───────────────────────

function finalize(a: Acc, kind: ShipKind): ShipMeshData {
  const p = a.positions;
  let maxPlan = 0, maxH = 0;
  for (let i = 0; i < p.length; i += 3) {
    maxPlan = Math.max(maxPlan, Math.hypot(p[i], p[i + 2]));
    maxH = Math.max(maxH, Math.abs(p[i + 1]));
  }
  const s = (PLAN_RADIUS[kind] * SHIP_RADIUS) / maxPlan;
  const zs = MAX_HALF_DEPTH / maxH;
  const out = new Array<number>(p.length);
  for (let i = 0; i < p.length; i += 3) {
    // protótipo (x lateral, y cima, z frente) → cena (x nariz, y lateral, −z câmera)
    out[i] = p[i + 2] * s;
    out[i + 1] = p[i] * s;
    out[i + 2] = -p[i + 1] * zs;
  }
  return { segments: extractEdges(out, a.indices) };
}

/**
 * Extrai as ARESTAS DE FEIÇÃO da malha de triângulos: bordas abertas e
 * vincos (ângulo diedro acentuado). Diagonais coplanares das faces caem
 * fora — sem isso o wireframe de triângulos satura em borrão com o glow.
 */
function extractEdges(positions: number[], indices: number[]): number[] {
  // solda vértices por quantização (primitivas vizinhas não se tocam por índice)
  const weld = new Map<string, number>();
  const rep = new Array<number>(positions.length / 3);
  for (let i = 0; i < positions.length / 3; i++) {
    const k = `${Math.round(positions[i * 3] * 100)},${Math.round(positions[i * 3 + 1] * 100)},${Math.round(positions[i * 3 + 2] * 100)}`;
    const r = weld.get(k);
    if (r === undefined) {
      weld.set(k, i);
      rep[i] = i;
    } else rep[i] = r;
  }

  interface EdgeInfo { a: number; b: number; count: number; nx: number; ny: number; nz: number; sharp: boolean }
  const edges = new Map<string, EdgeInfo>();
  const FLAT_COS = Math.cos((30 * Math.PI) / 180);

  for (let t = 0; t < indices.length; t += 3) {
    const i0 = rep[indices[t]], i1 = rep[indices[t + 1]], i2 = rep[indices[t + 2]];
    // normal da face
    const ax = positions[i1 * 3] - positions[i0 * 3], ay = positions[i1 * 3 + 1] - positions[i0 * 3 + 1], az = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];
    const bx = positions[i2 * 3] - positions[i0 * 3], by = positions[i2 * 3 + 1] - positions[i0 * 3 + 1], bz = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue; // triângulo degenerado
    nx /= len; ny /= len; nz /= len;

    for (const [a, b] of [[i0, i1], [i1, i2], [i2, i0]] as const) {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      if (lo === hi) continue;
      const key = `${lo}_${hi}`;
      const e = edges.get(key);
      if (!e) {
        edges.set(key, { a: lo, b: hi, count: 1, nx, ny, nz, sharp: false });
      } else {
        e.count++;
        // |dot| trata enrolamento inconsistente e faces coplanares opostas
        if (Math.abs(e.nx * nx + e.ny * ny + e.nz * nz) < FLAT_COS) e.sharp = true;
      }
    }
  }

  // Simplificação de PLANTA: a câmera do jogo é ortográfica top-down FIXA,
  // então aresta quase vertical projeta num ponto (só satura o glow) e pares
  // topo/fundo (ex.: as duas faces de uma caixa) projetam no MESMO traço —
  // descarta as primeiras e deduplica os últimos pela projeção XY. O corte
  // de comprimento também poda micro-feições (pinos, cabos, frisos) que em
  // zoom de jogo viram ruído de glow antes de virarem desenho.
  const MIN_PLAN_LEN = 2.2;
  const q = (v: number) => Math.round(v);
  const seen = new Set<string>();
  const segments: number[] = [];
  for (const e of edges.values()) {
    // borda aberta (1 face), junção múltipla (>2) ou vinco acentuado
    if (e.count === 2 && !e.sharp) continue;
    const ax = positions[e.a * 3], ay = positions[e.a * 3 + 1], az = positions[e.a * 3 + 2];
    const bx = positions[e.b * 3], by = positions[e.b * 3 + 1], bz = positions[e.b * 3 + 2];
    if (Math.hypot(bx - ax, by - ay) < MIN_PLAN_LEN) continue;
    const ka = `${q(ax)},${q(ay)}`, kb = `${q(bx)},${q(by)}`;
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (seen.has(key)) continue;
    seen.add(key);
    segments.push(ax, ay, az, bx, by, bz);
  }
  return segments;
}

const cache = new Map<ShipKind, ShipMeshData>();

/** Geometria fundida da nave conforme a classe — computada uma vez. */
export function shipMeshData(kind: ShipKind): ShipMeshData {
  let data = cache.get(kind);
  if (!data) {
    const a = new Acc();
    ASSEMBLE[kind](a);
    data = finalize(a, kind);
    cache.set(kind, data);
  }
  return data;
}
