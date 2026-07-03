// Constantes do mundo. 1 unidade ≈ 1 km na escala do jogo (mapa 1:10 do sistema solar).

/** Lado de um setor da grade, em unidades. */
export const SECTOR_SIZE = 10_000;

/** Raio interno/externo do cinturão de asteroides, em setores a partir do Sol. */
export const BELT_INNER_SECTORS = 3_300;
export const BELT_OUTER_SECTORS = 4_950;

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
