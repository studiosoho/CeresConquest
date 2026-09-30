/**
 * CeresMeshGenerator — Ceres como corpo SÓLIDO low poly, no mesmo idioma das
 * rochas (icosfera facetada, crateras côncavas com lábio, flat shading), mas
 * na escala de um planeta anão: raio CERES_RADIUS, relevo quase esférico,
 * muitas crateras de tamanhos variados e as PLATAFORMAS de construção de
 * shared/ceres.ts escavadas como mesas planas no relevo.
 *
 * Ceres é ESTÁTICA (não gira): as plataformas são pontos fixos do mapa, e o
 * servidor pousa naves nelas pelas mesmas contas.
 *
 * PROFUNDIDADE. Ceres é uma ESFERA CHEIA: o topo fica rente ao plano das
 * naves e o corpo desce 40 000 u para trás dele. Já foi achatada a 8% para
 * caber na faixa de profundidade das rochas — vista de cima lia redonda
 * (normais de esfera), mas o cockpit olha de LADO, e de lado ela era uma
 * placa fina. Por isso o fundo da vista de cima (lajes de detritos, estrelas,
 * sol e céu) mora atrás dela (Backdrop.ts, GameScene STAR_DEPTH_Z e maxZ).
 * CERES_DEPTH_SCALE fica como alavanca, em 1.
 *
 * COORDENADAS: local de CENA (y para cima = −y do jogo; câmera em −Z olhando
 * +Z, então "para fora, em direção à câmera" é −Z). Malha centrada na origem.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CERES_RADIUS, ceresPlatforms, mulberry32 } from "@ceres/shared";
import { icosphere } from "./AsteroidMeshGenerator";

/** achatamento em Z da posição (1 = esfera cheia; ver PROFUNDIDADE acima) */
export const CERES_DEPTH_SCALE = 1;
/**
 * subdivisões da icosfera: ~82 000 facetas, arestas de ~350 u — ainda low poly
 * na tela (35–90 px nos zooms do jogo), mas fino o bastante para crateras
 * pequenas e plataformas redondas (com 700 u elas saíam hexágonos serrilhados)
 */
const SUBDIV = 6;
const CRATER_COUNT = 110;

export interface CeresPlatformSurface {
  id: string;
  /** z local da mesa (já achatado) — onde a nave pousada fica */
  z: number;
}

export interface CeresMeshData {
  vertices: Vector3[];
  normals: Vector3[];
  colors: number[];
  triangles: number[];
  /** menor z local (a frente, mais perto da câmera) — o renderer recua o root por ele */
  minZ: number;
  platforms: CeresPlatformSurface[];
}

const smoothstep = (edge: number, x: number): number => {
  const u = Math.min(1, Math.max(0, x / edge));
  return u * u * (3 - 2 * u);
};

/**
 * Tom base de Ceres e a amplitude do grão mineral por faceta. Levemente FRIO
 * de propósito: a luz-chave do jogo é quente (Lighting.ts) e deixava o
 * regolito bege; com este tom o resultado na tela lê cinza.
 */
const BASE = [0.52, 0.545, 0.58];
const GRAIN = 0.06;

export function generateCeresMesh(worldSeed: number): CeresMeshData {
  const R = CERES_RADIUS;
  const rng = mulberry32((worldSeed ^ 0xce7e5) >>> 0);

  // relevo de grande escala: lóbulos baixos — Ceres é quase esférica
  const lobes: Array<{ dir: Vector3; freq: number; amp: number; phase: number }> = [];
  for (let i = 0; i < 4; i++) {
    const z = rng() * 2 - 1;
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    lobes.push({
      dir: new Vector3(Math.cos(a) * r, Math.sin(a) * r, z),
      freq: 1.5 + rng() * 4,
      amp: 0.004 + rng() * 0.01,
      phase: rng() * Math.PI * 2,
    });
  }

  // CRATERAS em lei de potência: muitas pequenas, poucas grandes. Bacia com
  // lábio erguido (a borda pega a luz, o fundo cai na sombra — é o par que
  // faz a luz descrever relevo em low poly); as maiores têm pico central.
  // Metade vai para a face visível (−Z), onde o jogador as vê.
  const craters: Array<{ dir: Vector3; radius: number; cosR: number; depth: number; peak: number }> = [];
  for (let i = 0; i < CRATER_COUNT; i++) {
    let z = rng() * 2 - 1;
    if (i % 2 === 0) z = -Math.abs(z);
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const u = rng();
    const radius = 0.04 + 0.26 * u * u * u; // rad de ângulo esférico
    craters.push({
      dir: new Vector3(Math.cos(a) * r, Math.sin(a) * r, z),
      radius,
      cosR: Math.cos(radius),
      depth: radius * (0.1 + rng() * 0.08),
      peak: radius > 0.14 ? radius * 0.05 : 0,
    });
  }

  const ico = icosphere(SUBDIV);
  const n = ico.dirs.length;
  const pts: Vector3[] = new Array(n);
  /** quanto cada vértice afundou em cratera (0 = superfície) — escurece o fundo */
  const sink = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = ico.dirs[i];
    let rr = 1;
    for (const l of lobes) rr += l.amp * Math.cos(l.freq * Vector3.Dot(d, l.dir) + l.phase);
    let s = 0;
    for (const c of craters) {
      const cosA = Vector3.Dot(d, c.dir);
      if (cosA <= c.cosR) continue;
      const t = Math.sqrt(2 * (1 - Math.min(1, cosA))) / c.radius;
      if (t >= 1) continue;
      const bowl = -(1 - t * t) * c.depth;
      const lipT = (t - 0.74) / 0.26;
      const lip = lipT > 0 ? Math.sin(lipT * Math.PI) * c.depth * 0.55 : 0;
      const peak = c.peak > 0 ? c.peak * Math.max(0, 1 - t / 0.2) : 0;
      rr += bowl + lip + peak;
      s = Math.max(s, -bowl / c.depth);
    }
    sink[i] = s;
    pts[i] = d.scale(rr * R);
  }

  // PLATAFORMAS: mesas planas (normal −Z, para a câmera) na face visível. A
  // altura é a mediana do relevo na área — rebaixa a parte alta e aterra a
  // baixa —, com a borda suavizada até o relevo em volta
  const pads = ceresPlatforms(worldSeed);
  const platforms: CeresPlatformSurface[] = [];
  const padMask = new Uint8Array(n);
  for (const p of pads) {
    const cx = p.dx;
    const cy = -p.dy; // jogo → cena
    const band = p.radius * 0.35;
    const inner: number[] = [];
    for (let i = 0; i < n; i++) {
      const q = pts[i];
      if (q.z >= 0) continue;
      if (Math.hypot(q.x - cx, q.y - cy) <= p.radius) inner.push(q.z);
    }
    inner.sort((a, b) => a - b);
    const plane = inner.length > 0 ? inner[Math.floor(inner.length / 2)] : -Math.sqrt(Math.max(0, R * R - cx * cx - cy * cy));
    for (let i = 0; i < n; i++) {
      const q = pts[i];
      if (q.z >= 0) continue;
      const dd = Math.hypot(q.x - cx, q.y - cy) - p.radius;
      if (dd >= band) continue;
      const f = dd <= 0 ? 1 : 1 - smoothstep(band, dd);
      q.z += (plane - q.z) * f;
      if (dd <= 0) {
        padMask[i] = 1;
        sink[i] = 0;
      }
    }
    platforms.push({ id: p.id, z: plane });
  }

  // silhueta XY máxima = CERES_RADIUS (o círculo de colisão do sim-core)
  let maxXY = 0;
  for (const q of pts) maxXY = Math.max(maxXY, Math.hypot(q.x, q.y));
  const k = R / maxXY;
  for (const q of pts) q.scaleInPlace(k);
  for (const p of platforms) p.z *= k * CERES_DEPTH_SCALE;

  // facetas desagrupadas (flat shading): normal da ESFERA cheia, posição achatada
  const grain = mulberry32((worldSeed ^ 0x9a1e) >>> 0);
  const vertices: Vector3[] = [];
  const normals: Vector3[] = [];
  const colors: number[] = [];
  const triangles: number[] = [];
  let minZ = Infinity;
  for (let f = 0; f < ico.faces.length; f += 3) {
    let ia = ico.faces[f], ib = ico.faces[f + 1], ic = ico.faces[f + 2];
    let nrm = Vector3.Cross(pts[ib].subtract(pts[ia]), pts[ic].subtract(pts[ia])).normalize();
    const centroid = pts[ia].add(pts[ib]).add(pts[ic]).scaleInPlace(1 / 3);
    if (Vector3.Dot(nrm, centroid) < 0) {
      nrm = nrm.negate();
      const tmp = ib;
      ib = ic;
      ic = tmp;
    }
    const onPad = padMask[ia] + padMask[ib] + padMask[ic] === 3;
    const deep = (sink[ia] + sink[ib] + sink[ic]) / 3;
    // grão mineral por faceta; mesas mais lisas; fundo de cratera mais escuro
    const g = 1 + (grain() * 2 - 1) * (onPad ? GRAIN * 0.3 : GRAIN);
    const shade = g * (1 - 0.22 * deep);
    const base = vertices.length;
    for (const idx of [ia, ib, ic]) {
      const q = pts[idx];
      const v = new Vector3(q.x, q.y, q.z * CERES_DEPTH_SCALE);
      if (v.z < minZ) minZ = v.z;
      vertices.push(v);
      normals.push(nrm);
      colors.push(BASE[0] * shade, BASE[1] * shade, BASE[2] * shade, 1);
    }
    triangles.push(base, base + 1, base + 2);
  }

  return { vertices, normals, colors, triangles, minZ, platforms };
}
