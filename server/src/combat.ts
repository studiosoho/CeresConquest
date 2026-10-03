import {
  COLLISION_DAMAGE_DV_THRESHOLD,
  COLLISION_DAMAGE_PER_DV,
  cargoLoadFactor,
  shipPhysics,
  interceptAngle,
  relVec,
  wrapAngle,
  MISSILE_SPEED,
  TARGET_CONE,
  type ShipLayer,
  type WeaponKind,
  type WorldPos,
} from "@ceres/shared";
import type { ShipState } from "@ceres/sim-core";

/**
 * Regras de combate entre camadas (ver shared/layers.ts). Funções puras — a
 * sala só as aplica — para que cada regra tenha teste sem rede e sem sala.
 *
 * O combate acontece em dois NÍVEIS, e só dentro do mesmo nível:
 *  - "cruise": naves em cruzeiro atiram e são atingidas entre si;
 *  - "surface": o nível das estações — naves na superfície, em modo ataque,
 *    pousadas numa vaga ou num asteroide, e as próprias estruturas.
 * Nave em transição de camada (inclusive a animação de pouso e a decolagem) é
 * invulnerável e não atira.
 */
export type CombatLevel = "cruise" | "surface";

/** Nível em que vive um tiro disparado de uma nave nesta camada. */
export function levelOfLayer(layer: ShipLayer): CombatLevel {
  return layer === "cruise" ? "cruise" : "surface";
}

/**
 * Nível em que a nave pode ser ATINGIDA — ou null se nada a atinge: em
 * transição, guardada no hangar (o dano chega a ela só pela estação, ver
 * `splitDamage`) ou como aranha mineradora, que é parte da estação.
 */
export function hittableLevel(s: Readonly<ShipState>): CombatLevel | null {
  if (s.stored || s.autoMining) return null;
  if (s.layerTo || s.landingPhase === "landing" || s.landingPhase === "liftoff") return null;
  if (s.anchored || s.landingPhase === "landed") return "surface";
  return levelOfLayer(s.layer);
}

/** A nave pode atirar agora? (parada numa camada, voando) */
export function canFire(s: Readonly<ShipState>): boolean {
  return !s.stored && !s.anchored && !s.layerTo && s.landingPhase === "";
}

/**
 * Reparte o dano de um projétil que atinge uma estação entre ela e as naves
 * GUARDADAS no hangar dela, por sorteio: `ships` pontos de corte uniformes em
 * [0, 1] dividem o dano em ships+1 fatias (uniforme sobre as partilhas
 * possíveis). A primeira fatia é da estação; as outras, das naves, na ordem
 * dada. Sem nave no hangar, a estação leva tudo. A soma é sempre `damage`.
 *
 * `rng` é o gerador com semente da sala: a partida continua reproduzível.
 */
export function splitDamage(damage: number, ships: number, rng: () => number): { station: number; ships: number[] } {
  if (ships <= 0) return { station: damage, ships: [] };
  const cuts: number[] = [];
  for (let i = 0; i < ships; i++) cuts.push(rng());
  cuts.sort((a, b) => a - b);
  const shares: number[] = [];
  let prev = 0;
  for (const c of cuts) {
    shares.push((c - prev) * damage);
    prev = c;
  }
  shares.push((1 - prev) * damage);
  const station = shares.shift()!;
  return { station, ships: shares };
}

/**
 * Dano de colisão de um tick: o impulso normal acumulado pelo solver, visto
 * como o Δv que ele impôs a ESTE casco (impulso ÷ massa com carga), acima do
 * limiar. Empurrar e encostar ficam abaixo dele.
 */
export function collisionDamage(s: Readonly<ShipState>): number {
  if (!(s.hullImpulse > 0)) return 0;
  const mass = shipPhysics(s.kind).mass * cargoLoadFactor(s.kind, s.cargoAmount);
  const dv = s.hullImpulse / mass;
  return Math.max(0, dv - COLLISION_DAMAGE_DV_THRESHOLD) * COLLISION_DAMAGE_PER_DV;
}

// ── computador de tiro (mira automática, weapons.ts) ───────────────────

/** Um alvo possível do computador de tiro: nave ou estrutura inimiga. */
export interface AimTarget {
  id: string;
  pos: WorldPos;
  vx: number;
  vy: number;
}

/**
 * Escolhe o alvo como o Elite: o inimigo MAIS PERTO DA LINHA DO NARIZ, dentro
 * do cone TARGET_CONE e do alcance da arma. Quem filtra nível de combate e
 * dono é quem monta `candidates`.
 */
export function pickTarget(shooter: Readonly<ShipState>, candidates: readonly AimTarget[], range: number): AimTarget | null {
  let best: AimTarget | null = null;
  let bestOff = TARGET_CONE;
  for (const c of candidates) {
    const { dx, dy } = relVec(shooter, c.pos);
    if (Math.hypot(dx, dy) > range) continue;
    const off = Math.abs(wrapAngle(Math.atan2(dy, dx) - shooter.angle));
    if (off <= bestOff) {
      bestOff = off;
      best = c;
    }
  }
  return best;
}

/**
 * Desvio (relativo ao nariz) que a arma QUER para acertar o alvo: o ponto de
 * interceptação para o míssil (balístico, herda a velocidade da nave); o
 * alvo direto para o laser (instantâneo).
 */
export function desiredOffset(shooter: Readonly<ShipState>, target: AimTarget, weapon: WeaponKind): number {
  const { dx, dy } = relVec(shooter, target.pos);
  const ang = weapon === "missile"
    ? interceptAngle(dx, dy, target.vx - shooter.vx, target.vy - shooter.vy, MISSILE_SPEED)
    : Math.atan2(dy, dx);
  return wrapAngle(ang - shooter.angle);
}
