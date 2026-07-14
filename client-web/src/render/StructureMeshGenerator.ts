/**
 * StructureMeshGenerator — substitui as silhuetas 2D (`structureVerts`) por
 * arquitetura 3D low-poly por tipo de estrutura, no mesmo estilo dos
 * asteroides: sólido escuro facetado (flat shading) + wireframe branco de
 * painéis + linhas de DESTAQUE com glow (aberturas de hangar, antenas) que o
 * renderer tinge com a cor do dono + quads pretos nas aberturas (vazio).
 *
 * Formas (capturadas do protótipo de arte):
 *   - initialBase: cúpula geodésica lat/long com portal frontal e antena;
 *   - hq: tronco de pirâmide com abertura de hangar, caixas de teto e antena;
 *   - miningStation: galpão com hangar + duas torres cilíndricas com cúpula
 *     e antena + maquinário de teto;
 *   - rationCenter: silo central com cúpula e antena + dois armazéns em
 *     abóbada (quonset) + guarita frontal.
 *
 * QUADRO LOCAL: X = largura (tangente do pad), Y = profundidade (bitangente),
 * Z = para cima (normal da plataforma, em direção à câmera). A FRENTE é −Y —
 * o mesmo lado onde o renderer enfileira as vagas de hangar. O renderer
 * orienta o nó raiz para o quadro da plataforma (buildFace) do asteroide.
 *
 * Geometria puramente visual e determinística por tipo — nada trafega pela
 * rede; o servidor continua conhecendo só posição/ângulo/asteroidId.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { STRUCTURE_SPECS } from "@ceres/shared";
import type { StructureType } from "@ceres/shared";

export interface StructureMeshData {
  /** corpo sólido facetado (vértices desagrupados por face) */
  vertices: Vector3[];
  triangles: number[];
  normals: Vector3[];
  /** quads pretos das aberturas (hangar/porta) — material sem iluminação */
  voidVertices: Vector3[];
  voidTriangles: number[];
  /** polilinhas do wireframe branco (bordas de painéis) */
  wires: Vector3[][];
  /** polilinhas de destaque com glow — o renderer aplica a cor do dono */
  accents: Vector3[][];
  /** altura nominal do sólido — base do squash de headroom no renderer */
  height: number;
}

/** afastamento dos vazios/destaques da parede que os hospeda (anti z-fight) */
const VOID_LIFT = 1.2;
const ACCENT_LIFT = 2;

// ── acumulador ─────────────────────────────────────────────────────────────

class Builder {
  vertices: Vector3[] = [];
  triangles: number[] = [];
  normals: Vector3[] = [];
  voidVertices: Vector3[] = [];
  voidTriangles: number[] = [];
  wires: Vector3[][] = [];
  accents: Vector3[][] = [];

  /** triângulo com normal plana; `out` orienta o lado iluminado */
  tri(p0: Vector3, p1: Vector3, p2: Vector3, out: Vector3): void {
    let n = Vector3.Cross(p1.subtract(p0), p2.subtract(p0));
    if (n.lengthSquared() < 1e-9) return;
    n = n.normalize();
    if (Vector3.Dot(n, out) < 0) n = n.negate();
    const base = this.vertices.length;
    this.vertices.push(p0.clone(), p1.clone(), p2.clone());
    this.normals.push(n, n.clone(), n.clone());
    this.triangles.push(base, base + 1, base + 2);
  }

  /** quadrilátero plano (p0→p1→p2→p3 em volta) */
  quad(p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3, out: Vector3): void {
    this.tri(p0, p1, p2, out);
    this.tri(p0, p2, p3, out);
  }

  wire(...pts: Vector3[]): void {
    this.wires.push(pts);
  }

  wireLoop(pts: Vector3[]): void {
    this.wires.push([...pts, pts[0]]);
  }

  accent(...pts: Vector3[]): void {
    this.accents.push(pts);
  }

  voidQuad(p0: Vector3, p1: Vector3, p2: Vector3, p3: Vector3): void {
    const base = this.voidVertices.length;
    this.voidVertices.push(p0, p1, p2, p3);
    this.voidTriangles.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

// ── primitivas ─────────────────────────────────────────────────────────────

/**
 * Tronco de caixa (paredes com leve inclinação, como no protótipo).
 * Sem face inferior (assenta na plataforma). Wires: perímetros + verticais.
 */
function box(
  b: Builder,
  cx: number, cy: number,
  z0: number, z1: number,
  wB: number, dB: number,
  wT: number = wB, dT: number = dB,
): void {
  const corner = (w: number, d: number, z: number, i: number): Vector3 => {
    const sx = i === 0 || i === 3 ? -1 : 1;
    const sy = i < 2 ? -1 : 1;
    return new Vector3(cx + (sx * w) / 2, cy + (sy * d) / 2, z);
  };
  const bo = [0, 1, 2, 3].map((i) => corner(wB, dB, z0, i));
  const to = [0, 1, 2, 3].map((i) => corner(wT, dT, z1, i));
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const mid = bo[i].add(bo[j]).scaleInPlace(0.5);
    b.quad(bo[i], bo[j], to[j], to[i], mid.subtractFromFloats(cx, cy, mid.z));
    b.wire(bo[i], to[i]);
  }
  b.quad(to[0], to[1], to[2], to[3], new Vector3(0, 0, 1));
  b.wireLoop(bo);
  b.wireLoop(to);
}

/** Cilindro vertical; tampa plana opcional. Wires: anéis + costuras. */
function cylinder(
  b: Builder,
  cx: number, cy: number, r: number,
  z0: number, z1: number,
  seg: number,
  topCap: boolean,
): Vector3[] {
  const ring = (z: number): Vector3[] => {
    const pts: Vector3[] = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      pts.push(new Vector3(cx + Math.cos(a) * r, cy + Math.sin(a) * r, z));
    }
    return pts;
  };
  const bo = ring(z0);
  const to = ring(z1);
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    const out = new Vector3(bo[i].x - cx, bo[i].y - cy, 0);
    b.quad(bo[i], bo[j], to[j], to[i], out);
    b.wire(bo[i], to[i]);
  }
  if (topCap) {
    const c = new Vector3(cx, cy, z1);
    for (let i = 0; i < seg; i++) b.tri(to[i], to[(i + 1) % seg], c, new Vector3(0, 0, 1));
  }
  b.wireLoop(bo);
  b.wireLoop(to);
  return to; // anel superior (para encaixar cúpula)
}

/** Cúpula lat/long (grade de painéis, como no protótipo). */
function dome(
  b: Builder,
  cx: number, cy: number, r: number,
  z0: number, height: number,
  latSteps: number, lonSteps: number,
): void {
  const ringAt = (k: number): Vector3[] => {
    const a = (k / latSteps) * (Math.PI / 2);
    const rk = Math.cos(a) * r;
    const zk = z0 + Math.sin(a) * height;
    const pts: Vector3[] = [];
    for (let i = 0; i < lonSteps; i++) {
      const t = (i / lonSteps) * Math.PI * 2;
      pts.push(new Vector3(cx + Math.cos(t) * rk, cy + Math.sin(t) * rk, zk));
    }
    return pts;
  };
  let prev = ringAt(0);
  b.wireLoop(prev);
  for (let k = 1; k < latSteps; k++) {
    const cur = ringAt(k);
    for (let i = 0; i < lonSteps; i++) {
      const j = (i + 1) % lonSteps;
      const out = prev[i].add(cur[i]).scaleInPlace(0.5).subtractFromFloats(cx, cy, prev[i].z);
      b.quad(prev[i], prev[j], cur[j], cur[i], new Vector3(out.x, out.y, r * 0.3));
    }
    b.wireLoop(cur);
    prev = cur;
  }
  const top = new Vector3(cx, cy, z0 + height);
  for (let i = 0; i < lonSteps; i++) {
    b.tri(prev[i], prev[(i + 1) % lonSteps], top, new Vector3(0, 0, 1));
  }
  // meridianos (um sim, um não — grade legível sem virar mingau)
  for (let i = 0; i < lonSteps; i += 2) {
    const t = (i / lonSteps) * Math.PI * 2;
    const line: Vector3[] = [];
    for (let k = 0; k <= latSteps; k++) {
      const a = (k / latSteps) * (Math.PI / 2);
      line.push(new Vector3(
        cx + Math.cos(t) * Math.cos(a) * r,
        cy + Math.sin(t) * Math.cos(a) * r,
        z0 + Math.sin(a) * height,
      ));
    }
    b.wire(...line);
  }
}

/** Armazém em abóbada (meia-cana ao longo de Y). */
function quonset(
  b: Builder,
  cx: number, cy: number,
  halfLen: number, r: number,
  seg: number,
): void {
  const arc = (y: number): Vector3[] => {
    const pts: Vector3[] = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI;
      pts.push(new Vector3(cx + Math.cos(a) * r, cy + y, Math.sin(a) * r));
    }
    return pts;
  };
  const near = arc(-halfLen);
  const far = arc(halfLen);
  for (let i = 0; i < seg; i++) {
    const out = new Vector3(near[i].x - cx, 0, near[i].z);
    b.quad(near[i], near[i + 1], far[i + 1], far[i], out);
  }
  // paredes de fundo (leques)
  const cNear = new Vector3(cx, cy - halfLen, 0);
  const cFar = new Vector3(cx, cy + halfLen, 0);
  for (let i = 0; i < seg; i++) {
    b.tri(near[i], near[i + 1], cNear, new Vector3(0, -1, 0));
    b.tri(far[i], far[i + 1], cFar, new Vector3(0, 1, 0));
  }
  b.wire(...near);
  b.wire(...far);
  // longarinas (uma sim, uma não)
  for (let i = 0; i <= seg; i += 2) b.wire(near[i], far[i]);
}

/** Antena: mastro + travessas, como linhas de destaque (glow). */
function antenna(b: Builder, x: number, y: number, z0: number, z1: number): void {
  b.accent(new Vector3(x, y, z0), new Vector3(x, y, z1));
  const arm = (z1 - z0) * 0.22;
  const zc = z0 + (z1 - z0) * 0.72;
  b.accent(new Vector3(x - arm, y, zc), new Vector3(x + arm, y, zc));
  b.accent(new Vector3(x - arm * 0.6, y, zc + arm * 0.7), new Vector3(x + arm * 0.6, y, zc + arm * 0.7));
}

/**
 * Abertura retangular numa parede frontal inclinada (hangar/porta):
 * quad preto + contorno de destaque, erguidos da parede.
 * A parede vai de (y=yB, z=zB) a (y=yT, z=zT); a abertura ocupa x∈±ow/2 e
 * fração [0, fh] da altura da parede.
 */
function opening(
  b: Builder,
  cx: number,
  yB: number, zB: number,
  yT: number, zT: number,
  ow: number, fh: number,
): void {
  const at = (x: number, f: number, lift: number): Vector3 => {
    const y = yB + (yT - yB) * f;
    const z = zB + (zT - zB) * f;
    // normal da parede no plano YZ (aponta para −Y/fora)
    const ny = -(zT - zB);
    const nz = yT - yB;
    const nl = Math.hypot(ny, nz);
    return new Vector3(cx + x, y + (ny / nl) * lift, z + (nz / nl) * lift);
  };
  const corners = (lift: number): Vector3[] => [
    at(-ow / 2, 0, lift), at(ow / 2, 0, lift), at(ow / 2, fh, lift), at(-ow / 2, fh, lift),
  ];
  const v = corners(VOID_LIFT);
  b.voidQuad(v[0], v[1], v[2], v[3]);
  const a = corners(ACCENT_LIFT);
  b.accents.push([...a, a[0]]);
}

// ── arquitetura por tipo ───────────────────────────────────────────────────

function buildInitialBase(b: Builder, R: number): number {
  // cúpula habitacional com portal frontal e antena — o elo com a Terra
  dome(b, 0, 0.1 * R, 0.7 * R, 0, 0.52 * R, 5, 14);
  box(b, 0, -0.62 * R, 0, 0.24 * R, 0.52 * R, 0.26 * R, 0.46 * R, 0.2 * R);
  opening(b, 0, -0.75 * R, 0, -0.72 * R, 0.24 * R, 0.3 * R, 0.68);
  antenna(b, 0, 0.1 * R, 0.62 * R, 0.95 * R);
  return 0.62 * R;
}

function buildHq(b: Builder, R: number): number {
  // tronco de pirâmide imponente com hangar e maquinário de teto
  box(b, 0, 0.08 * R, 0, 0.4 * R, 1.55 * R, 1.05 * R, 1.25 * R, 0.8 * R);
  opening(b, 0, 0.08 * R - 0.525 * R, 0, 0.08 * R - 0.4 * R, 0.4 * R, 0.5 * R, 0.6);
  box(b, -0.4 * R, 0.2 * R, 0.4 * R, 0.52 * R, 0.26 * R, 0.18 * R);
  box(b, 0.02 * R, 0.3 * R, 0.4 * R, 0.48 * R, 0.2 * R, 0.14 * R);
  box(b, 0.35 * R, 0.1 * R, 0.4 * R, 0.5 * R, 0.3 * R, 0.2 * R);
  box(b, -0.06 * R, -0.08 * R, 0.4 * R, 0.46 * R, 0.12 * R, 0.12 * R);
  antenna(b, -0.06 * R, -0.08 * R, 0.46 * R, 0.82 * R);
  return 0.52 * R;
}

function buildMiningStation(b: Builder, R: number): number {
  // galpão industrial com hangar + torres de processamento
  box(b, 0.12 * R, 0.12 * R, 0, 0.48 * R, 1.5 * R, 1.05 * R, 1.32 * R, 0.9 * R);
  opening(b, 0.12 * R, 0.12 * R - 0.525 * R, 0, 0.12 * R - 0.45 * R, 0.48 * R, 0.5 * R, 0.58);
  // torre alta (esquerda) e torre curta (direita), com cúpula e antena
  cylinder(b, -0.72 * R, -0.18 * R, 0.26 * R, 0, 0.8 * R, 10, false);
  dome(b, -0.72 * R, -0.18 * R, 0.26 * R, 0.8 * R, 0.14 * R, 2, 10);
  antenna(b, -0.72 * R, -0.18 * R, 0.94 * R, 1.2 * R);
  cylinder(b, 0.78 * R, -0.28 * R, 0.2 * R, 0, 0.5 * R, 10, false);
  dome(b, 0.78 * R, -0.28 * R, 0.2 * R, 0.5 * R, 0.1 * R, 2, 10);
  antenna(b, 0.78 * R, -0.28 * R, 0.6 * R, 0.82 * R);
  // maquinário de teto
  box(b, -0.1 * R, 0.28 * R, 0.48 * R, 0.58 * R, 0.24 * R, 0.18 * R);
  box(b, 0.24 * R, 0.34 * R, 0.48 * R, 0.56 * R, 0.18 * R, 0.14 * R);
  box(b, 0.3 * R, 0.02 * R, 0.48 * R, 0.6 * R, 0.16 * R, 0.16 * R);
  return 0.94 * R;
}

function buildRationCenter(b: Builder, R: number): number {
  // silo central com cúpula + armazéns em abóbada + guarita de despacho
  cylinder(b, 0, 0.08 * R, 0.4 * R, 0, 0.5 * R, 12, false);
  dome(b, 0, 0.08 * R, 0.4 * R, 0.5 * R, 0.16 * R, 3, 12);
  antenna(b, 0, 0.08 * R, 0.66 * R, 0.95 * R);
  quonset(b, -0.72 * R, 0.05 * R, 0.45 * R, 0.28 * R, 7);
  quonset(b, 0.72 * R, 0.05 * R, 0.45 * R, 0.28 * R, 7);
  box(b, 0, -0.5 * R, 0, 0.18 * R, 0.36 * R, 0.18 * R, 0.32 * R, 0.15 * R);
  opening(b, 0, -0.59 * R, 0, -0.575 * R, 0.18 * R, 0.2 * R, 0.7);
  return 0.66 * R;
}

const cache = new Map<StructureType, StructureMeshData>();

export function generateStructureMesh(type: StructureType): StructureMeshData {
  const cached = cache.get(type);
  if (cached) return cached;

  const R = STRUCTURE_SPECS[type].radius;
  const b = new Builder();
  const height =
    type === "hq" ? buildHq(b, R)
    : type === "miningStation" ? buildMiningStation(b, R)
    : type === "rationCenter" ? buildRationCenter(b, R)
    : buildInitialBase(b, R);

  const data: StructureMeshData = {
    vertices: b.vertices,
    triangles: b.triangles,
    normals: b.normals,
    voidVertices: b.voidVertices,
    voidTriangles: b.voidTriangles,
    wires: b.wires,
    accents: b.accents,
    height,
  };
  cache.set(type, data);
  return data;
}
