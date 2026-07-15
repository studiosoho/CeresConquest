// Classes de asteroide (P/M/G por raio) e suas propriedades.

import { ASTEROID_MAX_RADIUS, asteroidClassOf, SIZE_CLASS, type AsteroidClass } from "./scale";
import { mulberry32 } from "./rng";

/** Rotação máxima dos asteroides (rad/s) — leve. */
export const MAX_ASTEROID_SPIN = 0.12;

/**
 * Velocidade angular normalizada [-1,1] de um asteroide pela shapeSeed.
 * FONTE ÚNICA: usada pelo cliente (visual) e pelo servidor (nave pousada
 * gira junto) — precisa ser idêntica nos dois lados.
 */
export function asteroidSpin(shapeSeed: number): number {
  return mulberry32((shapeSeed ^ 0x51ed2c) >>> 0)() * 2 - 1;
}

/** Velocidade angular efetiva (rad/s) de um asteroide. */
export function asteroidSpinRate(shapeSeed: number): number {
  return asteroidSpin(shapeSeed) * MAX_ASTEROID_SPIN;
}

/** Especificação da classe de asteroide. */
export interface AsteroidClassSpec {
  /** Label exibido no jogo. */
  label: string;
  /** Raio mínimo (inclusivo). */
  minRadius: number;
  /** Raio máximo (exclusivo, exceto para large). */
  maxRadius: number;
  /** Cor no minimapa. */
  color: string;
  /** Quantidade de minério disponível. */
  oreAmount: number;
}

/** Especificações das classes de asteroide. */
export const ASTEROID_CLASSES: Record<AsteroidClass, AsteroidClassSpec> = {
  small: {
    label: "Pequeno (P)",
    minRadius: SIZE_CLASS.asteroidSmall,
    maxRadius: SIZE_CLASS.asteroidMedium,
    color: "#A0A0A0",
    oreAmount: 5000,
  },
  medium: {
    label: "Médio (M)",
    minRadius: SIZE_CLASS.asteroidMedium,
    maxRadius: SIZE_CLASS.asteroidLarge,
    color: "#29a1de",
    oreAmount: 15000,
  },
  large: {
    label: "Grande (G)",
    minRadius: SIZE_CLASS.asteroidLarge,
    maxRadius: ASTEROID_MAX_RADIUS + 1,
    color: "#FFD700",
    oreAmount: 30000,
  },
};

/** Determina a classe de um asteroide pelo raio. */
export function getAsteroidClass(radius: number): AsteroidClass {
  return asteroidClassOf(radius);
}
