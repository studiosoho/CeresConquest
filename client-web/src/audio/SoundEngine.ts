/**
 * SoundEngine — toca os efeitos sfxr (sounds.ts) pela Web Audio.
 *
 * Os sons são sintetizados UMA vez, no carregamento (amostras puras, sem
 * contexto de áudio); o AudioContext só nasce no primeiro gesto do jogador
 * (`unlock`) — política de autoplay dos navegadores. Antes disso, `play` é
 * mudo e não falha.
 *
 * Cada som tem um teto de vozes simultâneas e um intervalo mínimo entre
 * disparos (SoundSpec): seis bots atirando juntos não viram um chiado. O
 * motor da nave própria é um laço de ruído grave, com volume pelo empuxo.
 */

import { synthesize, SFXR_RATE, Wave } from "./sfxr";
import { SOUNDS, type SoundName } from "./sounds";

/** volume geral */
const MASTER_GAIN = 0.6;
/** laço do motor: volume no empuxo máximo e tempo de resposta (s) */
const ENGINE_GAIN = 0.12;
const ENGINE_RESPONSE = 0.08;

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private samples = new Map<SoundName, Float32Array>();
  private buffers = new Map<SoundName, AudioBuffer>();
  private voices = new Map<SoundName, number>();
  private lastAt = new Map<SoundName, number>();
  private engineSamples: Float32Array;
  private engineGain: GainNode | null = null;
  private muted = false;

  constructor() {
    let seed = 1;
    for (const [name, spec] of Object.entries(SOUNDS) as Array<[SoundName, (typeof SOUNDS)[SoundName]]>) {
      this.samples.set(name, synthesize(spec.params, seed++));
    }
    // ruído grave e longo, sem envelope (sustentação plena) — vira laço
    this.engineSamples = synthesize({ wave: Wave.Noise, freq: 0.07, sustain: 0.7, decay: 0, lpf: 0.22, lpfResonance: 0.2 }, 99);
  }

  /** Cria/retoma o contexto de áudio — chamar num gesto do jogador (tecla, clique). */
  unlock(): void {
    if (!this.ctx) {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : MASTER_GAIN;
      this.master.connect(ctx.destination);
      for (const [name, data] of this.samples) this.buffers.set(name, this.toBuffer(data));
      // laço do motor, sempre tocando, com volume zero até haver empuxo
      const src = ctx.createBufferSource();
      src.buffer = this.toBuffer(this.engineSamples);
      src.loop = true;
      this.engineGain = ctx.createGain();
      this.engineGain.gain.value = 0;
      src.connect(this.engineGain).connect(this.master);
      src.start();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  /** Liga/desliga todo o som. Devolve o estado novo (true = mudo). */
  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : MASTER_GAIN, this.ctx.currentTime, 0.02);
    return this.muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /**
   * Toca `name` com `volume` (0..1, multiplica o do preset) e panorâmica
   * estéreo `pan` (−1 esquerda .. 1 direita). Uma leve variação de altura
   * evita que tiros repetidos soem idênticos.
   */
  play(name: SoundName, volume = 1, pan = 0): void {
    const ctx = this.ctx;
    const buf = this.buffers.get(name);
    if (!ctx || !this.master || !buf || volume <= 0.001) return;
    const spec = SOUNDS[name];
    const now = ctx.currentTime;
    if ((this.voices.get(name) ?? 0) >= spec.voices) return;
    if (now - (this.lastAt.get(name) ?? -Infinity) < spec.gap) return;
    this.lastAt.set(name, now);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 1 + (Math.random() * 2 - 1) * 0.04;
    const gain = ctx.createGain();
    gain.gain.value = spec.gain * Math.min(1, volume);
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(gain).connect(panner).connect(this.master);
    this.voices.set(name, (this.voices.get(name) ?? 0) + 1);
    src.onended = () => this.voices.set(name, Math.max(0, (this.voices.get(name) ?? 1) - 1));
    src.start();
  }

  /** Empuxo do motor da nave própria (0..1). */
  setThrust(level: number): void {
    if (!this.ctx || !this.engineGain) return;
    this.engineGain.gain.setTargetAtTime(ENGINE_GAIN * Math.max(0, Math.min(1, level)), this.ctx.currentTime, ENGINE_RESPONSE);
  }

  destroy(): void {
    void this.ctx?.close();
    this.ctx = null;
  }

  private toBuffer(data: Float32Array): AudioBuffer {
    const buf = this.ctx!.createBuffer(1, Math.max(1, data.length), SFXR_RATE);
    buf.getChannelData(0).set(data);
    return buf;
  }
}
