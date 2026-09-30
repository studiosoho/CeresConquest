// Ceres: o planeta anão, objetivo de conquista do jogo. Vive dentro do
// cinturão de asteroides, com diâmetro igual à largura do cinturão.

import { mulberry32 } from "./rng";
import { BELT_CENTER_SECTORS, SECTOR_SIZE } from "./constants";
import { BELT_WIDTH } from "./scale";
import { normalizePos, type WorldPos } from "./coords";

/** Raio de Ceres — seu diâmetro é exatamente a largura do cinturão. */
export const CERES_RADIUS = BELT_WIDTH / 2;

/**
 * Posição de Ceres no cinturão: determinística pela semente do mundo, então
 * servidor e cliente calculam o MESMO ponto sem precisar sincronizar nada
 * pela rede (como a procgen dos asteroides).
 *
 * Protótipo: os jogadores nascem perto daqui (ver mapSpawns). Na versão
 * final, o spawn dos jogadores é independente e aleatório — só a posição
 * de Ceres continua fixa por partida.
 */
export function ceresPosition(seed: number): WorldPos & { angle: number } {
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const angle = rng() * Math.PI * 2;
  const R = BELT_CENTER_SECTORS;
  return {
    sx: Math.round(Math.cos(angle) * R),
    sy: Math.round(Math.sin(angle) * R),
    x: SECTOR_SIZE / 2,
    y: SECTOR_SIZE / 2,
    angle,
  };
}

/**
 * Áreas de construção de Ceres: PLATAFORMAS planas escavadas no relevo, em
 * posições fixas do mapa — Ceres é estática (não gira), então cada plataforma
 * é um ponto do mundo, e servidor (pouso) e cliente (relevo, aro de pouso)
 * calculam as mesmas da semente, sem sincronizar nada.
 *
 * Espalhadas numa espiral de ângulo áureo com jitter, na face visível, entre
 * 22% e 72% do raio (longe da borda, onde o relevo cai rápido demais para uma
 * mesa plana), e sem se sobreporem.
 */
export interface CeresPlatform {
  /** "ceres-<i>" — fica no lugar do id de asteroide de quem pousa nela */
  id: string;
  /** centro, relativo ao centro de Ceres (coordenadas do jogo) */
  dx: number;
  dy: number;
  /** raio da área plana */
  radius: number;
}

export const CERES_PLATFORM_COUNT = 7;
/** prefixo do id — distingue plataforma de Ceres de asteroide */
export const CERES_PLATFORM_PREFIX = "ceres-";

const platformCache = new Map<number, CeresPlatform[]>();

export function ceresPlatforms(seed: number): CeresPlatform[] {
  const cached = platformCache.get(seed);
  if (cached) return cached;
  const rng = mulberry32((seed ^ 0x51a7f0) >>> 0);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const spin = rng() * Math.PI * 2;
  const out: CeresPlatform[] = [];
  for (let i = 0; i < CERES_PLATFORM_COUNT; i++) {
    const t = (i + 0.5) / CERES_PLATFORM_COUNT;
    const r = CERES_RADIUS * (0.22 + 0.5 * Math.sqrt(t)) * (0.94 + rng() * 0.12);
    const a = spin + i * golden + (rng() - 0.5) * 0.25;
    out.push({
      id: `${CERES_PLATFORM_PREFIX}${i}`,
      dx: Math.cos(a) * r,
      dy: Math.sin(a) * r,
      radius: 1500 + rng() * 900,
    });
  }
  platformCache.set(seed, out);
  return out;
}

/** Centro da plataforma no mundo. */
export function ceresPlatformPos(seed: number, p: CeresPlatform): WorldPos {
  const c = ceresPosition(seed);
  const pos = { sx: c.sx, sy: c.sy, x: c.x + p.dx, y: c.y + p.dy };
  normalizePos(pos);
  return pos;
}
