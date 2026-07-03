// Escala de tamanhos do jogo — fonte ÚNICA de proporções.
// Tudo é derivado do tamanho da nave, que é a referência. Para dimensionar
// qualquer coisa nova (estruturas, naves maiores, Ceres), use uma classe de
// tamanho ou multiplique SHIP_RADIUS — assim as proporções ficam garantidas.

/** Raio característico (bounding) da nave do jogador, em unidades. Base da escala. */
export const SHIP_RADIUS = 20;

/**
 * Classes de tamanho, em múltiplos do raio da nave.
 * ship=1×, asteroides de 10× (pequeno) a 100× (gigante).
 */
export const SIZE_CLASS = {
  ship: 1,
  asteroidSmall: 10,
  asteroidMedium: 30,
  asteroidLarge: 60,
  asteroidHuge: 100,
} as const;

export type SizeClassName = keyof typeof SIZE_CLASS;

/** Raio, em unidades, de uma classe de tamanho. */
export function radiusOf(cls: SizeClassName): number {
  return SIZE_CLASS[cls] * SHIP_RADIUS;
}

/** Faixa de raio dos asteroides: 10× a 100× a nave. */
export const ASTEROID_MIN_RADIUS = radiusOf("asteroidSmall"); // 200
export const ASTEROID_MAX_RADIUS = radiusOf("asteroidHuge"); // 2000

/** Diâmetro do maior asteroide. */
export const ASTEROID_MAX_DIAMETER = 2 * ASTEROID_MAX_RADIUS; // 4000

/**
 * Largura (espessura radial) do cinturão ≈ 10 diâmetros do maior asteroide.
 * O cinturão é uma "pista" fina em torno do Sol, não um disco preenchido.
 */
export const BELT_WIDTH = 10 * ASTEROID_MAX_DIAMETER; // 40 000
