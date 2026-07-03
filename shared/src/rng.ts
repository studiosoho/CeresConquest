/**
 * RNG determinística compartilhada. Mesmo seed → mesma sequência em qualquer
 * plataforma (só inteiros de 32 bits + operações IEEE bem definidas).
 */

/** PRNG mulberry32: rápida, boa o suficiente para procgen. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Combina três inteiros (ex.: seedDoMundo, setorX, setorY) num hash de 32 bits. */
export function hash3(a: number, b: number, c: number): number {
  let h = a >>> 0;
  h = Math.imul(h ^ ((b + 0x9e3779b9) | 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ ((c + 0x9e3779b9) | 0), 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
