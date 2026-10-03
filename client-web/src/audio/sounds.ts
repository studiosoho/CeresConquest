/**
 * Catálogo de efeitos do jogo: um preset sfxr por evento (sfxr.ts), com o
 * volume e o controle de repetição de cada um. Ajuste de ouvido aqui — no
 * console, `__sfx.play("missile")` toca um som para comparar.
 */

import { Wave, type SfxrParams } from "./sfxr";

export type SoundName =
  | "missile" | "laser" | "turret" | "mineLaunch" | "mineArm"
  | "hit" | "blast" | "shipDown" | "structureDown"
  | "select" | "lock" | "dock" | "takeoff" | "layerShift"
  | "buildStart" | "turretReady" | "coin" | "hurt" | "alarm";

export interface SoundSpec {
  params: Partial<SfxrParams>;
  /** volume base (0..1) */
  gain: number;
  /** vozes simultâneas deste som (o excedente é descartado) */
  voices: number;
  /** intervalo mínimo entre dois disparos (s) — tiro de 6 bots não vira ruído branco */
  gap: number;
}

export const SOUNDS: Record<SoundName, SoundSpec> = {
  // ── armas ──
  /** mini míssil: "piu" quadrado descendo */
  missile: {
    params: { wave: Wave.Square, freq: 0.62, slide: -0.3, duty: 0.25, sustain: 0.06, punch: 0.25, decay: 0.2, hpf: 0.08 },
    gain: 0.35, voices: 4, gap: 0.04,
  },
  /** laser travado: zap em dente de serra */
  laser: {
    params: { wave: Wave.Saw, freq: 0.78, freqLimit: 0.1, slide: -0.24, sustain: 0.06, decay: 0.2, vibratoDepth: 0.15, vibratoSpeed: 0.6, hpf: 0.1 },
    gain: 0.3, voices: 3, gap: 0.05,
  },
  /** turreta: zap curto, mais grave que o laser da nave */
  turret: {
    params: { wave: Wave.Square, freq: 0.58, freqLimit: 0.1, slide: -0.22, duty: 0.4, sustain: 0.05, decay: 0.22 },
    gain: 0.3, voices: 4, gap: 0.05,
  },
  /** mina lançada: "blup" subindo */
  mineLaunch: {
    params: { wave: Wave.Square, freq: 0.24, slide: 0.2, duty: 0.5, sustain: 0.08, decay: 0.2 },
    gain: 0.35, voices: 2, gap: 0.1,
  },
  /** mina armada: bipe duplo */
  mineArm: {
    params: { wave: Wave.Square, freq: 0.52, arpMod: 0.45, arpSpeed: 0.6, duty: 0.5, sustain: 0.2, decay: 0.12 },
    gain: 0.25, voices: 2, gap: 0.2,
  },

  // ── explosões (crescem com o alvo) ──
  hit: {
    params: { wave: Wave.Noise, freq: 0.38, slide: -0.2, sustain: 0.08, punch: 0.45, decay: 0.3 },
    gain: 0.45, voices: 5, gap: 0.03,
  },
  blast: {
    params: { wave: Wave.Noise, freq: 0.22, slide: -0.12, sustain: 0.22, punch: 0.55, decay: 0.48, lpf: 0.75 },
    gain: 0.55, voices: 3, gap: 0.05,
  },
  shipDown: {
    params: { wave: Wave.Noise, freq: 0.14, slide: -0.06, sustain: 0.3, punch: 0.6, decay: 0.58, lpf: 0.65, phaserOffset: 0.2, phaserSweep: -0.1 },
    gain: 0.65, voices: 3, gap: 0.05,
  },
  structureDown: {
    params: { wave: Wave.Noise, freq: 0.08, slide: -0.03, sustain: 0.42, punch: 0.7, decay: 0.75, lpf: 0.5, phaserOffset: 0.35, phaserSweep: -0.15 },
    gain: 0.8, voices: 2, gap: 0.1,
  },

  // ── pilotagem e interface ──
  /** troca de arma */
  select: {
    params: { wave: Wave.Square, freq: 0.46, duty: 0.5, sustain: 0.08, decay: 0.14 },
    gain: 0.25, voices: 1, gap: 0.05,
  },
  /** mira do laser travou */
  lock: {
    params: { wave: Wave.Square, freq: 0.5, arpMod: 0.5, arpSpeed: 0.55, duty: 0.3, sustain: 0.2, decay: 0.15 },
    gain: 0.25, voices: 1, gap: 0.2,
  },
  /** atracou / pousou */
  dock: {
    params: { wave: Wave.Square, freq: 0.42, arpMod: -0.25, arpSpeed: 0.6, duty: 0.5, sustain: 0.1, decay: 0.25 },
    gain: 0.3, voices: 1, gap: 0.2,
  },
  /** decolou */
  takeoff: {
    params: { wave: Wave.Square, freq: 0.24, slide: 0.32, duty: 0.4, sustain: 0.12, decay: 0.22 },
    gain: 0.3, voices: 1, gap: 0.2,
  },
  /** troca de camada (subida/descida): sopro de ruído filtrado */
  layerShift: {
    params: { wave: Wave.Noise, freq: 0.5, attack: 0.18, sustain: 0.22, decay: 0.32, lpf: 0.3, lpfSweep: 0.3, lpfResonance: 0.3 },
    gain: 0.3, voices: 1, gap: 0.3,
  },
  /** obra de turreta começou: tique-taque de ferramenta */
  buildStart: {
    params: { wave: Wave.Square, freq: 0.32, duty: 0.6, repeatSpeed: 0.5, slide: 0.1, sustain: 0.22, decay: 0.12 },
    gain: 0.25, voices: 1, gap: 0.3,
  },
  /** turreta pronta: power-up */
  turretReady: {
    params: { wave: Wave.Square, freq: 0.32, slide: 0.24, repeatSpeed: 0.55, duty: 0.4, sustain: 0.25, decay: 0.32 },
    gain: 0.3, voices: 1, gap: 0.3,
  },
  /** minério carregado: moeda */
  coin: {
    params: { wave: Wave.Square, freq: 0.6, arpMod: 0.42, arpSpeed: 0.56, duty: 0.5, sustain: 0.05, punch: 0.45, decay: 0.26 },
    gain: 0.25, voices: 1, gap: 0.1,
  },
  /** a própria nave levou dano */
  hurt: {
    params: { wave: Wave.Square, freq: 0.45, slide: -0.45, duty: 0.6, sustain: 0.05, punch: 0.3, decay: 0.18, hpf: 0.2 },
    gain: 0.35, voices: 1, gap: 0.12,
  },
  /** estrutura própria sob ataque: sirene */
  alarm: {
    params: { wave: Wave.Square, freq: 0.5, vibratoDepth: 0.55, vibratoSpeed: 0.55, duty: 0.3, sustain: 0.55, decay: 0.12 },
    gain: 0.3, voices: 1, gap: 1,
  },
};
