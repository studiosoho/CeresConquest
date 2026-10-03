/**
 * sfxr — sintetizador de efeitos 8 bits no estilo do sfxr de DrPetter (o
 * algoritmo clássico, reescrito aqui): uma onda (quadrada, dente de serra,
 * senoide ou ruído) com envelope ataque/sustentação/estalo/decaimento,
 * deslize de frequência, vibrato, arpejo, varredura do ciclo da quadrada,
 * repetição, phaser e filtros passa-baixa/passa-alta.
 *
 * Os parâmetros seguem as faixas do sfxr (0..1, ou −1..1 nos deslizes), então
 * presets podem ser ajustados de ouvido como no programa original. Tudo é
 * gerado no código: nenhum arquivo de áudio, nenhuma licença de terceiros.
 */

export enum Wave {
  Square = 0,
  Saw = 1,
  Sine = 2,
  Noise = 3,
}

export interface SfxrParams {
  wave: Wave;
  /** envelope (0..1; o tempo cresce com o quadrado) */
  attack: number;
  sustain: number;
  /** estalo no início da sustentação (0..1) */
  punch: number;
  decay: number;
  /** frequência inicial e piso (0..1); com piso > 0, o som acaba ao cair abaixo dele */
  freq: number;
  freqLimit: number;
  /** deslize de frequência e a aceleração do deslize (−1..1) */
  slide: number;
  deltaSlide: number;
  vibratoDepth: number;
  vibratoSpeed: number;
  /** arpejo: salto de frequência (−1..1) e quando acontece (0..1) */
  arpMod: number;
  arpSpeed: number;
  /** ciclo da quadrada (0..1) e a varredura dele (−1..1) */
  duty: number;
  dutySweep: number;
  /** recomeça o deslize/arpejo a cada intervalo (0 = nunca) */
  repeatSpeed: number;
  phaserOffset: number;
  phaserSweep: number;
  /** passa-baixa: corte (1 = aberto), varredura e ressonância */
  lpf: number;
  lpfSweep: number;
  lpfResonance: number;
  /** passa-alta: corte (0 = aberto) e varredura */
  hpf: number;
  hpfSweep: number;
}

/** Valores neutros — um preset só declara o que muda. */
export const SFXR_DEFAULTS: SfxrParams = {
  wave: Wave.Square,
  attack: 0, sustain: 0.3, punch: 0, decay: 0.4,
  freq: 0.3, freqLimit: 0, slide: 0, deltaSlide: 0,
  vibratoDepth: 0, vibratoSpeed: 0,
  arpMod: 0, arpSpeed: 0,
  duty: 0, dutySweep: 0,
  repeatSpeed: 0,
  phaserOffset: 0, phaserSweep: 0,
  lpf: 1, lpfSweep: 0, lpfResonance: 0,
  hpf: 0, hpfSweep: 0,
};

/** Taxa nativa do sfxr: o tempo dos envelopes e deslizes é contado nela. */
export const SFXR_RATE = 44_100;
/** teto de duração (s) — segurança contra presets que não terminam */
const MAX_SECONDS = 4;

/** Gerador determinístico (o ruído sai igual a cada síntese do mesmo preset). */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sintetiza o efeito em amostras mono a SFXR_RATE, normalizadas para pico
 * `peak` (o volume de cada som fica a cargo de quem toca).
 */
export function synthesize(partial: Partial<SfxrParams>, seed = 1, peak = 0.9): Float32Array {
  const p: SfxrParams = { ...SFXR_DEFAULTS, ...partial };
  const rnd = mulberry(seed);
  const signed = (x: number) => Math.sign(x) * x * x;

  // ── estado (ver o reset do sfxr) ──
  let fperiod = 0, fmaxperiod = 0, fslide = 0, fdslide = 0;
  let squareDuty = 0, squareSlide = 0, arpMod = 0, arpTime = 0, arpLimit = 0;
  let period = 0;
  // recomeço do deslize/arpejo (também chamado pela repetição)
  const reset = () => {
    fperiod = 100 / (p.freq * p.freq + 0.001);
    period = Math.floor(fperiod);
    fmaxperiod = 100 / (p.freqLimit * p.freqLimit + 0.001);
    fslide = 1 - p.slide ** 3 * 0.01;
    fdslide = -(p.deltaSlide ** 3) * 0.000001;
    squareDuty = 0.5 - p.duty * 0.5;
    squareSlide = -p.dutySweep * 0.00005;
    arpMod = p.arpMod >= 0 ? 1 - p.arpMod * p.arpMod * 0.9 : 1 + p.arpMod * p.arpMod * 10;
    arpTime = 0;
    arpLimit = p.arpSpeed === 1 ? 0 : Math.floor((1 - p.arpSpeed) ** 2 * 20000 + 32);
  };
  reset();

  let fltp = 0, fltdp = 0, fltphp = 0;
  let fltw = p.lpf ** 3 * 0.1;
  const fltwD = 1 + p.lpfSweep * 0.0001;
  let fltdmp = (5 / (1 + p.lpfResonance ** 2 * 20)) * (0.01 + fltw);
  if (fltdmp > 0.8) fltdmp = 0.8;
  let flthp = p.hpf ** 2 * 0.1;
  const flthpD = 1 + p.hpfSweep * 0.0003;

  let vibPhase = 0;
  const vibSpeed = p.vibratoSpeed ** 2 * 0.01;
  const vibAmp = p.vibratoDepth * 0.5;

  const envLength = [
    Math.floor(p.attack * p.attack * 100000),
    Math.floor(p.sustain * p.sustain * 100000),
    Math.floor(p.decay * p.decay * 100000),
  ];
  let envVol = 0, envStage = 0, envTime = 0;

  let fphase = signed(p.phaserOffset) * 1020;
  const fdphase = signed(p.phaserSweep);
  let iphase = Math.abs(Math.floor(fphase));
  let ipp = 0;
  const phaserBuffer = new Float32Array(1024);
  const noiseBuffer = new Float32Array(32);
  for (let i = 0; i < 32; i++) noiseBuffer[i] = rnd() * 2 - 1;

  let repTime = 0;
  const repLimit = p.repeatSpeed === 0 ? 0 : Math.floor((1 - p.repeatSpeed) ** 2 * 20000 + 32);

  let phase = 0;
  const out: number[] = [];
  const maxSamples = MAX_SECONDS * SFXR_RATE;
  let playing = true;

  while (playing && out.length < maxSamples) {
    repTime++;
    if (repLimit !== 0 && repTime >= repLimit) {
      repTime = 0;
      reset();
    }
    arpTime++;
    if (arpLimit !== 0 && arpTime >= arpLimit) {
      arpLimit = 0;
      fperiod *= arpMod;
    }
    fslide += fdslide;
    fperiod *= fslide;
    if (fperiod > fmaxperiod) {
      fperiod = fmaxperiod;
      if (p.freqLimit > 0) playing = false;
    }
    let rfperiod = fperiod;
    if (vibAmp > 0) {
      vibPhase += vibSpeed;
      rfperiod = fperiod * (1 + Math.sin(vibPhase) * vibAmp);
    }
    period = Math.max(8, Math.floor(rfperiod));
    squareDuty = Math.min(0.5, Math.max(0, squareDuty + squareSlide));

    envTime++;
    if (envTime > envLength[envStage]) {
      envTime = 0;
      envStage++;
      if (envStage === 3) break;
    }
    if (envStage === 0) envVol = envLength[0] > 0 ? envTime / envLength[0] : 1;
    else if (envStage === 1) envVol = 1 + (1 - envTime / Math.max(1, envLength[1])) * 2 * p.punch;
    else envVol = 1 - envTime / Math.max(1, envLength[2]);

    fphase += fdphase;
    iphase = Math.min(1023, Math.abs(Math.floor(fphase)));
    if (flthpD !== 0) flthp = Math.min(0.1, Math.max(0.00001, flthp * flthpD));

    let ssample = 0;
    for (let si = 0; si < 8; si++) {
      phase++;
      if (phase >= period) {
        phase %= period;
        if (p.wave === Wave.Noise) for (let i = 0; i < 32; i++) noiseBuffer[i] = rnd() * 2 - 1;
      }
      const fp = phase / period;
      let sample: number;
      switch (p.wave) {
        case Wave.Square: sample = fp < squareDuty ? 0.5 : -0.5; break;
        case Wave.Saw: sample = 1 - fp * 2; break;
        case Wave.Sine: sample = Math.sin(fp * 2 * Math.PI); break;
        default: sample = noiseBuffer[Math.floor((phase * 32) / period) % 32];
      }
      // passa-baixa ressonante
      const pp = fltp;
      fltw = Math.min(0.1, Math.max(0, fltw * fltwD));
      if (p.lpf !== 1) {
        fltdp += (sample - fltp) * fltw;
        fltdp -= fltdp * fltdmp;
      } else {
        fltp = sample;
        fltdp = 0;
      }
      fltp += fltdp;
      // passa-alta
      fltphp += fltp - pp;
      fltphp -= fltphp * flthp;
      sample = fltphp;
      // phaser
      phaserBuffer[ipp & 1023] = sample;
      sample += phaserBuffer[(ipp - iphase + 1024) & 1023];
      ipp = (ipp + 1) & 1023;
      ssample += sample * envVol;
    }
    out.push(ssample / 8);
  }

  // normaliza o pico: a altura de cada som é decidida na hora de tocar
  let max = 0;
  for (const v of out) max = Math.max(max, Math.abs(v));
  const k = max > 0 ? peak / max : 0;
  const buf = new Float32Array(out.length);
  for (let i = 0; i < out.length; i++) buf[i] = out[i] * k;
  return buf;
}
