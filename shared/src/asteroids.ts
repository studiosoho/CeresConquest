// Classes de asteroide (P/M/G por raio) e suas propriedades.

import { ASTEROID_MAX_RADIUS, asteroidClassOf, SIZE_CLASS, type AsteroidClass } from "./scale";

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
    color: "#D4AF37",
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
