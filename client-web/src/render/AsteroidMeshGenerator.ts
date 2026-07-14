/**
 * AsteroidMeshGenerator — substitui o antigo `asteroidVerts()` (silhueta 2D):
 * gera, deterministicamente a partir da `shapeSeed`, uma malha 3D de asteroide
 * com uma PLATAFORMA DE CONSTRUÇÃO retangular integrada à geometria.
 *
 * Algoritmo:
 *   1. icosfera low-poly (subdivisões conforme a classe do asteroide);
 *   2. achatamento em Z + alongamento elipsoidal + ruído radial determinístico
 *      (soma de lóbulos cossenoidais por direção — suave e sem lib de noise);
 *   3. direção da plataforma derivada da seed — azimute livre, inclinação
 *      LIMITADA em relação ao eixo da câmera (ver nota abaixo);
 *   4. a região correspondente é rebaixada para um plano, formando uma
 *      plataforma quadrilateral larga o suficiente para QUALQUER estrutura
 *      (o QG, a maior, tem raio SHIP_RADIUS*6 = 120 unidades);
 *   5. transição suavizada (smoothstep pela distância ao retângulo);
 *   6. normais por face (flat shading — o look facetado é o análogo 3D do
 *      wireframe retrô) e winding voltado para fora.
 *
 * NOTA sobre a direção da plataforma: a câmera do jogo é ortográfica olhando
 * ao longo de +Z, e o servidor posiciona estruturas no CENTRO do asteroide
 * girando em sincronia com o spin (rotação só em Z). Por isso o azimute é
 * livre mas a inclinação é limitada (MAX_TILT): em POSE PLANA (rocha travada
 * pelo renderer por estar ocupada ou em pouso — ver AsteroidRenderer) a
 * plataforma encara a câmera e contém o centro local, onde as estruturas são
 * renderizadas. Rochas livres tombam nos 3 eixos e levam a plataforma junto.
 *
 * COORDENADAS: tudo aqui é LOCAL DE CENA do asteroide (Y para cima, câmera em
 * −Z olhando +Z) — a malha é puramente visual, sem contraparte no sim-core,
 * então não passa pela fronteira game↔cena de coords.ts. A malha é CENTRADA
 * na origem (o asteroide tomba nos 3 eixos): o renderer recua o root em
 * z = boundingRadius − ROCK_FRONT_REACH, garantindo que nenhum ponto avança
 * além de −ROCK_FRONT_REACH sob qualquer rotação (ver render/layers.ts).
 *
 * Invariante de colisão preservada: o maior raio da silhueta XY em pose
 * plana é exatamente `radius` (mesma normalização do asteroidVerts 2D) —
 * coerente com o círculo de colisão/mineração do sim-core. Sob tombamento a
 * silhueta pode variar entre ~0.94·radius e ~1.06·radius (contribuição do
 * eixo achatado) — desvio transitório aceito.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { mulberry32 } from "@ceres/shared";
import type { AsteroidClass } from "@ceres/shared";

/** Plataforma de construção: um quadro ortonormal + dimensões, local de cena. */
export interface AsteroidBuildFace {
  /** centro do retângulo, sobre o plano da plataforma */
  center: Vector3;
  /** normal do plano (aponta para FORA da rocha ≈ para a câmera) */
  normal: Vector3;
  /** eixo da largura (no plano) */
  tangent: Vector3;
  /** eixo da altura (no plano) */
  bitangent: Vector3;
  width: number;
  height: number;
}

export interface AsteroidMeshData {
  /** vértices já desagrupados por face (flat shading) */
  vertices: Vector3[];
  /** índices (3 por triângulo) */
  triangles: number[];
  /** normais por vértice (constantes dentro de cada face) */
  normals: Vector3[];
  buildFace: AsteroidBuildFace;
  /**
   * raio da esfera envolvente centrada na origem — o renderer posiciona o
   * root em z = boundingRadius − ROCK_FRONT_REACH (orçamento de profundidade)
   */
  boundingRadius: number;
  /**
   * contorno XY da projeção da malha em pose plana (linha de brilho retrô) —
   * gira em 3D junto com o corpo; sob tombamento lê-se como um anel na rocha.
   */
  silhouette: Array<{ x: number; y: number }>;
  /**
   * arestas das facetas como segmentos de 2 pontos, já erguidos da superfície
   * (sem z-fight com o corpo sólido; as do dorso perdem no teste de
   * profundidade — hidden line de graça). Arestas coplanares são filtradas:
   * o interior plano da plataforma não mostra a triangulação.
   */
  wireEdges: Vector3[][];
}

/**
 * cosseno do ângulo diedral mínimo para uma aresta virar linha: faces quase
 * coplanares (plataforma, regiões lisas) não desenham a triangulação interna
 */
const WIRE_DIHEDRAL_COS = 0.997;
/** quanto cada aresta é erguida radialmente da superfície */
const WIRE_LIFT = 2.5;
/** inclinação máxima da plataforma em relação ao eixo da câmera (rad) */
const MAX_TILT = 0.2;
/** meia-largura/meia-altura mínimas — cabe o QG (raio 120) com folga */
const PAD_MIN_HALF_W = 150;
const PAD_MIN_HALF_H = 120;
/** fração do raio para plataformas proporcionais em rochas grandes */
const PAD_HALF_W_FRAC = 0.3;
const PAD_HALF_H_FRAC = 0.22;

// ── icosfera base (compartilhada e cacheada por nível de subdivisão) ────────

interface IcoSphere {
  /** direções unitárias */
  dirs: Vector3[];
  faces: number[];
}

const icoCache = new Map<number, IcoSphere>();

function icosphere(subdiv: number): IcoSphere {
  const cached = icoCache.get(subdiv);
  if (cached) return cached;

  const t = (1 + Math.sqrt(5)) / 2;
  const raw: Array<[number, number, number]> = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  let dirs = raw.map(([x, y, z]) => new Vector3(x, y, z).normalize());
  let faces = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
    1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
    4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];

  for (let s = 0; s < subdiv; s++) {
    const mid = new Map<number, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      let idx = mid.get(key);
      if (idx === undefined) {
        idx = dirs.length;
        dirs.push(dirs[a].add(dirs[b]).normalize());
        mid.set(key, idx);
      }
      return idx;
    };
    const next: number[] = [];
    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f], b = faces[f + 1], c = faces[f + 2];
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    faces = next;
  }

  const result = { dirs, faces };
  icoCache.set(subdiv, result);
  return result;
}

// ── helpers ────────────────────────────────────────────────────────────────

const smoothstep = (edge: number, x: number): number => {
  const u = Math.min(1, Math.max(0, x / edge));
  return u * u * (3 - 2 * u);
};

/** quantil simples (q em [0,1]) de um array não-vazio */
const quantile = (values: number[], q: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

/** fecho convexo 2D (monotone chain) da projeção XY, em ordem anti-horária */
function convexHull2D(pts: Vector3[]): Array<{ x: number; y: number }> {
  const sorted = pts
    .map((p) => ({ x: p.x, y: p.y }))
    .sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Array<{ x: number; y: number }> = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Array<{ x: number; y: number }> = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// ── gerador ────────────────────────────────────────────────────────────────

export function generateAsteroidMesh(
  shapeSeed: number,
  radius: number,
  asteroidClass: AsteroidClass,
): AsteroidMeshData {
  const rng = mulberry32(shapeSeed);

  // rochas pequenas são mais redondas/lisas: precisam ceder a maior parte da
  // face à plataforma (o QG tem raio 120; a menor rocha, 200)
  const ampScale = asteroidClass === "small" ? 0.5 : asteroidClass === "medium" ? 0.8 : 1;
  const subdiv = asteroidClass === "small" ? 2 : 3;

  // alongamento elipsoidal no plano XY (análogo do "aspect" da versão 2D)
  const aspect = 1 + rng() * (asteroidClass === "small" ? 0.15 : asteroidClass === "medium" ? 0.35 : 0.5);
  const sx = Math.sqrt(aspect);
  const sy = 1 / sx;
  const rot = rng() * Math.PI * 2;
  // achatamento em Z: a rocha é um "seixo" — mantém a leitura top-down e o
  // orçamento de profundidade (z atrás do plano de jogo, à frente das estrelas)
  const fz = 0.76 + rng() * 0.1;

  // 4 lóbulos cossenoidais por direção — a "lombada" 3D da batata
  const lobes: Array<{ dir: Vector3; freq: number; amp: number; phase: number }> = [];
  for (let i = 0; i < 4; i++) {
    const z = rng() * 2 - 1;
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    lobes.push({
      dir: new Vector3(Math.cos(a) * r, Math.sin(a) * r, z),
      freq: 1.5 + rng() * 3,
      amp: (0.05 + rng() * 0.12) * ampScale,
      phase: rng() * Math.PI * 2,
    });
  }

  // direção da plataforma: azimute e "roll" livres, inclinação limitada
  const tiltAz = rng() * Math.PI * 2;
  const tilt = rng() * MAX_TILT;
  const rollAz = rng() * Math.PI * 2;

  // ── 1–2: esfera → elipsoide achatado → ruído radial ──
  const ico = icosphere(subdiv);
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  const pts: Vector3[] = new Array(ico.dirs.length);
  let maxXY = 0;
  for (let i = 0; i < ico.dirs.length; i++) {
    const d = ico.dirs[i];
    let rr = 1;
    for (const lobe of lobes) {
      rr += lobe.amp * Math.cos(lobe.freq * Vector3.Dot(d, lobe.dir) + lobe.phase);
    }
    // alongamento no eixo `rot`: rotaciona, escala, desfaz a rotação
    const u = (cosR * d.x + sinR * d.y) * sx;
    const v = (-sinR * d.x + cosR * d.y) * sy;
    const x = (cosR * u - sinR * v) * rr;
    const y = (sinR * u + cosR * v) * rr;
    const z = d.z * fz * rr;
    const p = new Vector3(x, y, z);
    const dxy = Math.hypot(x, y);
    if (dxy > maxXY) maxXY = dxy;
    pts[i] = p;
  }
  // normalização: silhueta XY máxima = radius (invariante de colisão)
  const k = radius / maxXY;
  for (const p of pts) p.scaleInPlace(k);

  // ── 3–5: plataforma ──
  const normal = new Vector3(
    Math.sin(tilt) * Math.cos(tiltAz),
    Math.sin(tilt) * Math.sin(tiltAz),
    -Math.cos(tilt),
  );
  // tangente: projeção de um vetor de "roll" no plano da plataforma
  const roll = new Vector3(Math.cos(rollAz), Math.sin(rollAz), 0);
  const tangent = roll.subtract(normal.scale(Vector3.Dot(roll, normal))).normalize();
  const bitangent = Vector3.Cross(normal, tangent).normalize();

  const halfW = Math.max(PAD_MIN_HALF_W, radius * PAD_HALF_W_FRAC);
  const halfH = Math.max(PAD_MIN_HALF_H, radius * PAD_HALF_H_FRAC);
  const band = Math.max(40, radius * 0.16);

  // altura do plano: quantil baixo das alturas da região — rebaixa a maior
  // parte dos vértices (carve), levantando só as depressões da borda
  const inner: number[] = [];
  for (const p of pts) {
    const w = Vector3.Dot(p, normal);
    if (w <= 0) continue;
    if (Math.abs(Vector3.Dot(p, tangent)) <= halfW && Math.abs(Vector3.Dot(p, bitangent)) <= halfH) {
      inner.push(w);
    }
  }
  // quantil mais alto = plataforma mais elevada ("mesa"): além do visual,
  // dá headroom vertical para os prédios 3D das estruturas — eles se erguem
  // da plataforma em direção à câmera e NÃO podem cruzar o plano de jogo z=0
  const planeD = inner.length > 0 ? quantile(inner, 0.45) : fz * radius * 0.5;

  for (const p of pts) {
    const w = Vector3.Dot(p, normal);
    if (w <= 0) continue; // só o lado da câmera — não belisca o dorso
    const du = Math.max(0, Math.abs(Vector3.Dot(p, tangent)) - halfW);
    const dv = Math.max(0, Math.abs(Vector3.Dot(p, bitangent)) - halfH);
    const distRect = Math.hypot(du, dv);
    if (distRect >= band) continue;
    const f = 1 - smoothstep(band, distRect); // 1 dentro do retângulo → 0 na banda
    p.addInPlace(normal.scale((planeD - w) * f));
  }

  // ── raio envolvente (malha centrada; o recuo em z é papel do renderer) ──
  let boundingRadius = 0;
  for (const p of pts) {
    const d = p.length();
    if (d > boundingRadius) boundingRadius = d;
  }

  const center = normal.scale(planeD);

  // ── silhueta XY (para a linha de contorno com glow) ──
  // fecho convexo da projeção: robusto para qualquer densidade de vértices
  // (o binning radial criava espículas em rochas low-poly); a leve perda de
  // concavidade é invisível na escala do jogo
  const silhouette = convexHull2D(pts);

  // ── 6: desagrupa por face (flat shading) com winding para fora ──
  const bodyCenter = Vector3.Zero();
  const vertices: Vector3[] = [];
  const normals: Vector3[] = [];
  const triangles: number[] = [];
  const faceNormals: Vector3[] = [];
  for (let f = 0; f < ico.faces.length; f += 3) {
    let p0 = pts[ico.faces[f]];
    let p1 = pts[ico.faces[f + 1]];
    let p2 = pts[ico.faces[f + 2]];
    let n = Vector3.Cross(p1.subtract(p0), p2.subtract(p0)).normalize();
    const centroid = p0.add(p1).add(p2).scaleInPlace(1 / 3);
    if (Vector3.Dot(n, centroid.subtract(bodyCenter)) < 0) {
      n = n.negate();
      const tmp = p1;
      p1 = p2;
      p2 = tmp;
    }
    faceNormals.push(n);
    const base = vertices.length;
    vertices.push(p0.clone(), p1.clone(), p2.clone());
    normals.push(n, n.clone(), n.clone());
    triangles.push(base, base + 1, base + 2);
  }

  // ── arestas das facetas (linhas brancas do wireframe) ──
  // adjacência pelos índices COMPARTILHADOS da icosfera (antes do desagrupar);
  // numa malha fechada toda aresta tem exatamente 2 faces
  const edgeFaces = new Map<number, { a: number; b: number; f0: number; f1: number }>();
  for (let f = 0; f < ico.faces.length; f += 3) {
    const fi = f / 3;
    for (let e = 0; e < 3; e++) {
      const a = ico.faces[f + e];
      const b = ico.faces[f + ((e + 1) % 3)];
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      const entry = edgeFaces.get(key);
      if (entry) entry.f1 = fi;
      else edgeFaces.set(key, { a, b, f0: fi, f1: -1 });
    }
  }
  // ergue radialmente (com o tombo nos 3 eixos, "em direção à câmera" não
  // existe no espaço local — o afastamento radial separa de qualquer ângulo)
  const liftPoint = (p: Vector3): Vector3 =>
    p.add(p.normalizeToNew().scaleInPlace(WIRE_LIFT));
  const wireEdges: Vector3[][] = [];
  for (const { a, b, f0, f1 } of edgeFaces.values()) {
    if (f1 >= 0 && Vector3.Dot(faceNormals[f0], faceNormals[f1]) > WIRE_DIHEDRAL_COS) continue;
    wireEdges.push([liftPoint(pts[a]), liftPoint(pts[b])]);
  }

  return {
    vertices,
    triangles,
    normals,
    buildFace: { center, normal, tangent, bitangent, width: halfW * 2, height: halfH * 2 },
    boundingRadius,
    silhouette,
    wireEdges,
  };
}
