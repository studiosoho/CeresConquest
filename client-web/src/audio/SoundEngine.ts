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
 *
 * Sons feitos direto na Web Audio (não cabem num preset sfxr):
 *  - POUSO (playLanding): o ruído do jato ao contrário — começa alto e some,
 *    com o filtro fechando e a altura caindo, como um motor desligando;
 *  - DECOLAGEM (playTakeoff): o mesmo jato num CRESCENDO — do silêncio ao
 *    alto, com o filtro abrindo e a altura subindo, motor acelerando;
 *  - TOQUE NO SOLO (playClank): um hit de CAIXA INVERTIDO (ruído + corpo
 *    grave, tocado de trás para frente: cresce do silêncio e corta no pico)
 *    em CORO de 4 vozes — atrasos curtos, desafinação leve, abertas no estéreo;
 *  - MINERAÇÃO (setMining): laço de ruído grave num passa-baixa ressonante,
 *    pulsado por um oscilador lento — WOOSH-WOOSH-WOOSH.
 */

import { synthesize, SFXR_RATE, Wave } from "./sfxr";
import { SOUNDS, type SoundName } from "./sounds";

/** volume geral */
const MASTER_GAIN = 0.6;
/** laço do motor: volume no empuxo máximo e tempo de resposta (s) */
const ENGINE_GAIN = 0.12;
const ENGINE_RESPONSE = 0.08;
/** pouso: volume no início e o quanto o filtro fecha */
const LANDING_GAIN = 0.3;
const LANDING_CUTOFF = [2200, 160] as const;
/** toque no solo: volume e as 4 vozes do coro (atraso s, desafinação, panorâmica, volume) */
const CLANK_GAIN = 0.45;
const CLANK_CHORUS: ReadonlyArray<{ delay: number; rate: number; pan: number; gain: number }> = [
  { delay: 0, rate: 1, pan: -0.35, gain: 1 },
  { delay: 0.012, rate: 0.97, pan: 0.35, gain: 0.9 },
  { delay: 0.022, rate: 1.03, pan: -0.12, gain: 0.8 },
  { delay: 0.034, rate: 0.985, pan: 0.15, gain: 0.7 },
];
/** mineração: volume, pulsos por segundo e o corte do passa-baixa (Hz, ± a varredura) */
const MINING_GAIN = 0.45;
const MINING_PULSE_HZ = 1.5;
const MINING_CUTOFF = 260;
const MINING_SWEEP = 180;

/**
 * Hit de CAIXA INVERTIDO: a caixa é ruído (a esteira) com um corpo grave que
 * cai um pouco de altura, os dois decaindo; tocada de trás para frente, ela
 * cresce do silêncio e corta seca no pico — o "fwoomp" do pé assentando.
 */
function synthReverseSnare(rate: number): Float32Array {
  const n = Math.round(0.38 * rate);
  const hit = new Float32Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let prev = 0;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    // esteira: ruído "clareado" (diferença entre amostras corta o grave)
    const w = rnd();
    const wires = (w - prev * 0.6) * Math.exp(-t * 11);
    prev = w;
    // corpo: ~190 Hz caindo para ~150 Hz, decaindo mais rápido que a esteira
    phase += (2 * Math.PI * (150 + 40 * Math.exp(-t * 25))) / rate;
    const body = Math.sin(phase) * Math.exp(-t * 22);
    hit[i] = 0.55 * wires + 0.75 * body;
  }
  // invertido, com 3 ms de saída suave para o corte no pico não estalar
  const out = new Float32Array(n);
  const fade = Math.round(0.003 * rate);
  for (let i = 0; i < n; i++) out[i] = hit[n - 1 - i] * Math.min(1, (n - 1 - i) / fade) * 0.45;
  return out;
}

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private samples = new Map<SoundName, Float32Array>();
  private buffers = new Map<SoundName, AudioBuffer>();
  private voices = new Map<SoundName, number>();
  private lastAt = new Map<SoundName, number>();
  private engineSamples: Float32Array;
  private engineGain: GainNode | null = null;
  private engineBuffer: AudioBuffer | null = null;
  private clankSamples: Float32Array;
  private clankBuffer: AudioBuffer | null = null;
  private miningGain: GainNode | null = null;
  private muted = false;

  constructor() {
    let seed = 1;
    for (const [name, spec] of Object.entries(SOUNDS) as Array<[SoundName, (typeof SOUNDS)[SoundName]]>) {
      this.samples.set(name, synthesize(spec.params, seed++));
    }
    // ruído grave e longo, sem envelope (sustentação plena) — vira laço
    this.engineSamples = synthesize({ wave: Wave.Noise, freq: 0.07, sustain: 0.7, decay: 0, lpf: 0.22, lpfResonance: 0.2 }, 99);
    this.clankSamples = synthReverseSnare(SFXR_RATE);
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
      this.engineBuffer = this.toBuffer(this.engineSamples);
      this.clankBuffer = this.toBuffer(this.clankSamples);
      const src = ctx.createBufferSource();
      src.buffer = this.engineBuffer;
      src.loop = true;
      this.engineGain = ctx.createGain();
      this.engineGain.gain.value = 0;
      src.connect(this.engineGain).connect(this.master);
      src.start();
      this.startMiningLoop(ctx);
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

  /**
   * POUSO da nave própria: o ruído do jato ao contrário, de alto a mudo em
   * `duration` s — o filtro fecha e a altura cai junto, motor desligando.
   */
  playLanding(duration: number): void {
    this.jetSweep(duration, false);
  }

  /** DECOLAGEM da nave própria: o jato num crescendo, de mudo a alto em `duration` s. */
  playTakeoff(duration: number): void {
    this.jetSweep(duration, true);
  }

  /**
   * O ruído do jato varrido no tempo: `rising` = crescendo (volume, corte e
   * altura sobem — decolagem); senão o contrário (pouso). Na subida o volume
   * fica no pico um instante e solta, passando a vez ao laço do motor.
   */
  private jetSweep(duration: number, rising: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.engineBuffer) return;
    const now = ctx.currentTime;
    const end = now + duration;
    const [lo, hi] = [LANDING_CUTOFF[1], LANDING_CUTOFF[0]];
    const src = ctx.createBufferSource();
    src.buffer = this.engineBuffer;
    src.loop = true;
    src.playbackRate.setValueAtTime(rising ? 0.6 : 1.4, now);
    src.playbackRate.exponentialRampToValueAtTime(rising ? 1.4 : 0.6, end);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 1.5;
    filter.frequency.setValueAtTime(rising ? lo : hi, now);
    filter.frequency.exponentialRampToValueAtTime(rising ? hi : lo, end);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(rising ? 0.0005 : LANDING_GAIN, now);
    gain.gain.exponentialRampToValueAtTime(rising ? LANDING_GAIN : 0.0005, end);
    if (rising) gain.gain.setTargetAtTime(0.0005, end, 0.12);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(now);
    src.stop(end + (rising ? 0.6 : 0.05));
  }

  /** TOQUE NO SOLO: o hit de caixa invertido em coro de 4 vozes. */
  playClank(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.clankBuffer) return;
    const now = ctx.currentTime;
    for (const v of CLANK_CHORUS) {
      const src = ctx.createBufferSource();
      src.buffer = this.clankBuffer;
      src.playbackRate.value = v.rate;
      const gain = ctx.createGain();
      gain.gain.value = CLANK_GAIN * v.gain;
      const panner = ctx.createStereoPanner();
      panner.pan.value = v.pan;
      src.connect(gain).connect(panner).connect(this.master);
      src.start(now + v.delay);
    }
  }

  /** Liga/desliga o WOOSH-WOOSH-WOOSH da mineração da nave própria. */
  setMining(on: boolean): void {
    if (!this.ctx || !this.miningGain) return;
    this.miningGain.gain.setTargetAtTime(on ? MINING_GAIN : 0, this.ctx.currentTime, 0.2);
  }

  /**
   * Laço da mineração, sempre tocando e mudo até haver mineração: ruído grave
   * (o do motor, mais lento) num passa-baixa ressonante; um oscilador lento
   * pulsa o volume (0..1) e varre o corte junto — cada pulso é um WOOSH.
   */
  private startMiningLoop(ctx: AudioContext): void {
    const src = ctx.createBufferSource();
    src.buffer = this.engineBuffer;
    src.loop = true;
    src.playbackRate.value = 0.6;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 5;
    filter.frequency.value = MINING_CUTOFF;
    const pulse = ctx.createGain();
    pulse.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = MINING_PULSE_HZ;
    const depth = ctx.createGain();
    depth.gain.value = 0.5; // 0.5 ± 0.5 → o volume vai de 0 a 1 a cada pulso
    lfo.connect(depth).connect(pulse.gain);
    const sweep = ctx.createGain();
    sweep.gain.value = MINING_SWEEP;
    lfo.connect(sweep).connect(filter.frequency);
    this.miningGain = ctx.createGain();
    this.miningGain.gain.value = 0;
    src.connect(filter).connect(pulse).connect(this.miningGain).connect(this.master!);
    src.start();
    lfo.start();
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
