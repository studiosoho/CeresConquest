/**
 * Armamento da nave de ataque — três armas, escolhidas com 1, 2 e 3:
 *
 *  - MÍSSEIS (1): mini mísseis balísticos (sem guiamento depois de disparados),
 *    com mira automática RÁPIDA.
 *  - LASER (2): acerto instantâneo, mira automática LENTA; só dispara com a
 *    mira TRAVADA no alvo, e só então há traço da nave ao alvo.
 *  - MINAS (3): voam pelo nariz até MINE_MAX_DISTANCE do ponto de lançamento
 *    e param flutuando, ou se fixam no asteroide (ou em Ceres) que
 *    encontrarem no caminho. Só armam depois de paradas.
 *
 * MIRA AUTOMÁTICA (estilo "gimbal" do Elite Dangerous): a arma gira em torno
 * do nariz, até `gimbal` rad para cada lado, e o computador de tiro a leva na
 * direção do alvo — o inimigo mais perto da linha do nariz, dentro de
 * TARGET_CONE. Para o míssil a mira é o ponto de INTERCEPTAÇÃO (desconta o
 * movimento do alvo e da própria nave); para o laser, o alvo direto. O giro
 * tem velocidade finita (`slew`): é o que faz a mira do laser "caminhar" até
 * o alvo.
 */

export type WeaponKind = "missile" | "laser" | "mine";
export const WEAPON_KINDS: readonly WeaponKind[] = ["missile", "laser", "mine"];

/** Meio-ângulo (rad) do cone, em volta do nariz, em que o computador escolhe alvos. */
export const TARGET_CONE = 0.8;

// ── mini mísseis ──────────────────────────────────────────────────────
export const MISSILE_SPEED = 2000;
export const MISSILE_RANGE = 8000;
export const MISSILE_RADIUS = 30;
export const MISSILE_DAMAGE = 25;
export const MISSILE_COOLDOWN = 0.25;
export const MISSILE_AMMO_MAX = 120;
/** giro máximo da arma em volta do nariz e velocidade do giro (rad, rad/s) */
export const MISSILE_GIMBAL = 0.35;
export const MISSILE_SLEW = 4;

// ── laser ─────────────────────────────────────────────────────────────
export const LASER_RANGE = 3500;
export const LASER_DAMAGE = 9;
export const LASER_COOLDOWN = 0.2;
export const LASER_GIMBAL = 0.52;
/** giro lento: a mira anda até o alvo em ~0,5 s por 25° */
export const LASER_SLEW = 0.9;
/** erro angular (rad) abaixo do qual a mira do laser TRAVA */
export const LASER_LOCK_TOLERANCE = 0.02;

// ── minas ─────────────────────────────────────────────────────────────
export const MINE_SPEED = 1500;
/** distância máxima do ponto de lançamento até a mina parar (10 km) */
export const MINE_MAX_DISTANCE = 10_000;
/** inimigo a esta distância de uma mina ARMADA a detona */
export const MINE_TRIGGER_RADIUS = 250;
export const MINE_BLAST_RADIUS = 450;
export const MINE_DAMAGE = 120;
export const MINE_COOLDOWN = 2;
export const MINE_AMMO_MAX = 10;
/** vida de uma mina depois de armada (s): some sozinha, para não acumular */
export const MINE_LIFETIME = 300;

/** Giro máximo e velocidade de giro da arma (a mina não tem mira: sai pelo nariz). */
export function gimbalOf(w: WeaponKind): { gimbal: number; slew: number } {
  if (w === "laser") return { gimbal: LASER_GIMBAL, slew: LASER_SLEW };
  if (w === "missile") return { gimbal: MISSILE_GIMBAL, slew: MISSILE_SLEW };
  return { gimbal: 0, slew: Infinity };
}

/** Normaliza um ângulo para (−π, π]. */
export function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * Ângulo de tiro que intercepta um alvo, para um projétil de velocidade
 * `speed` RELATIVA a quem atira (o míssil herda a velocidade da nave).
 * `rx, ry` = posição do alvo relativa a quem atira; `vx, vy` = velocidade
 * relativa. Resolve |r + v·t| = speed·t pela menor raiz positiva; sem
 * solução (alvo mais rápido que o projétil, se afastando), mira direto.
 */
export function interceptAngle(rx: number, ry: number, vx: number, vy: number, speed: number): number {
  const a = vx * vx + vy * vy - speed * speed;
  const b = 2 * (rx * vx + ry * vy);
  const c = rx * rx + ry * ry;
  let t = -1;
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) > 1e-9) t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      const t1 = (-b - s) / (2 * a);
      const t2 = (-b + s) / (2 * a);
      t = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2);
    }
  }
  if (!(t > 0)) return Math.atan2(ry, rx);
  return Math.atan2(ry + vy * t, rx + vx * t);
}

/**
 * Um passo da mira: leva o desvio atual da arma (`offset`, relativo ao nariz)
 * na direção do `desired`, no máximo `slew·dt`, e nunca além do `gimbal`.
 */
export function slewAim(offset: number, desired: number, gimbal: number, slew: number, dt: number): number {
  const target = Math.max(-gimbal, Math.min(gimbal, desired));
  const step = slew * dt;
  const d = target - offset;
  return Math.abs(d) <= step ? target : offset + Math.sign(d) * step;
}
