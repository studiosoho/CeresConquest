// Constantes do mundo. 1 unidade ≈ 1 km na escala do jogo (mapa 1:10 do sistema solar).
import { BELT_WIDTH } from "./scale";

/** Lado de um setor da grade, em unidades. */
export const SECTOR_SIZE = 10_000;

/** Raio do centro do cinturão a partir do Sol, em setores (~Ceres a 1:10). */
export const BELT_CENTER_SECTORS = 4_155;

/** Cinturão: anel fino de espessura BELT_WIDTH (≈ 10 diâmetros do maior asteroide). */
const BELT_HALF_WIDTH_SECTORS = BELT_WIDTH / 2 / SECTOR_SIZE;
export const BELT_INNER_SECTORS = BELT_CENTER_SECTORS - BELT_HALF_WIDTH_SECTORS;
export const BELT_OUTER_SECTORS = BELT_CENTER_SECTORS + BELT_HALF_WIDTH_SECTORS;

// ── Nave (protótipo: uma classe única de nave pilotável) ──────────────
export const SHIP_THRUST = 300; // aceleração, unidades/s²
export const SHIP_MAX_SPEED = 400; // unidades/s
export const SHIP_TURN_RATE = 3.5; // rad/s
export const SHIP_DRAG = 0.35; // coeficiente de arrasto exponencial

// ── Mineração ─────────────────────────────────────────────────────────
export const MINING_RANGE = 250; // distância máxima até a borda do asteroide
export const MINING_RATE = 25; // minério/s

// ── Rede ──────────────────────────────────────────────────────────────
export const TICK_RATE = 20; // ticks de simulação por segundo no servidor
export const DEFAULT_PORT = 2567;
