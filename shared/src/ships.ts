// Classes de nave e produção no QG.
// - builder:   a nave que o jogador pilota e usa para construir estruturas.
// - mining:    fabricada no QG; minera pousada / autonomamente na estação.
// - attack:    fabricada no QG; combate (munição perfurante + granada).
// - transport: fabricada no QG; carrega minério (estação → base inicial)
//              e rações (base inicial → QG/estação).

export type ShipKind = "builder" | "mining" | "attack" | "transport";

/** Classes fabricáveis no QG. */
export type ProducibleKind = "builder" | "mining" | "attack" | "transport";

export interface ShipProductionSpec {
  label: string;
  /** custo em minério */
  cost: number;
}

export const SHIP_PRODUCTION: Record<ProducibleKind, ShipProductionSpec> = {
  builder: { label: "Builder", cost: 300 },
  mining: { label: "Nave de mineração", cost: 80 },
  attack: { label: "Nave de ataque", cost: 150 },
  transport: { label: "Nave de transporte", cost: 120 },
};

// ── Carga (nave de transporte) ────────────────────────────────────────
/** Tipo de carga no porão ("" = vazio). */
export type CargoKind = "" | "ore" | "rations";
/** Capacidade do porão da nave de transporte (minério OU rações). */
export const TRANSPORT_CARGO_CAP = 500;

import type { AsteroidClass } from "./scale";
import { MINING_RATE, SHIP_ASSIST_FORCE, RCS_ATTITUDE_HOLD } from "./constants";

// ── Física de voo por classe ──────────────────────────────────────────
// Massa e momento de inércia são as grandezas PRIMÁRIAS; aceleração linear e
// angular são derivadas delas como num corpo rígido de verdade (a = F/m,
// α = τ/I). É isso que faz o transporte se sentir pesado sem nenhum número
// "de sensação" escrito à mão: ele tem 2,6× a massa do builder e 6,5× o
// momento de inércia, então o mesmo tipo de motor o move muito menos.
//
// RAIO DE GIRAÇÃO ≤ RAIO DO CORPO, e isto é teorema, não gosto:
// k² = ∫r²dm / m, e nenhuma massa do casco fica além do raio R dele, logo
// k ≤ R (igualdade só com TODA a massa na borda, um anel). O corpo que a física
// conhece é o círculo de colisão, R = SHIP_RADIUS = 20 u, o mesmo braço que o
// contato usa para o torque. Os valores antigos (builder 26, mineração 30, caça
// 22, cargueiro 42) punham a massa FORA do casco — o cargueiro, a mais que o
// dobro do próprio raio — e eram fisicamente impossíveis.
//
// Os novos mantêm a ORDEM e as proporções entre classes (≈ 0,45× os antigos):
//   builder 26 → 12   mineração 30 → 14   caça 22 → 10   cargueiro 42 → 19
// e o TORQUE de cada classe cai na mesma razão (k_novo/k_antigo)², então
// α = τ/(m·k²), a rotação nominal, a retenção de atitude e o tempo de virar
// 90°/180° ficam EXATAMENTE os de antes (há teste travando isso contra a tabela
// antiga). O cargueiro continua o mais lento para virar — agora pela razão
// certa: tem o menor torque por inércia, não uma massa que mora fora dele.
//   torque antes → depois: builder 6300 → 1342   mineração 8000 → 1742
//                          caça 5400 → 1116      cargueiro 11600 → 2374

/** Grandezas físicas escolhidas à mão para um casco. */
export interface ShipPhysicsSpec {
  /** Massa do casco, em massas-de-builder (o builder é a unidade). */
  mass: number;
  /**
   * Raio de giração do casco (unidades): distância eficaz da massa ao eixo de
   * guinada, I = m·k². Tem que caber no corpo: k ≤ SHIP_RADIUS (ver acima). Vem
   * da distribuição da massa — cascos compridos, com massa nas pontas, têm k
   * perto do raio; cascos compactos, bem menor.
   */
  gyration: number;
  /** Empuxo do motor principal (força). */
  thrust: number;
  /**
   * Empuxo do RCS de TRANSLAÇÃO (força): os bicos da casca que empurram de
   * lado e de ré sem girar o casco. É outro propulsor, não o motor principal
   * redirecionado — daí ter número próprio em vez de uma fração global.
   *
   * A fração do motor principal é escolhida por classe e fica entre 16% e 30%,
   * nunca perto de 100%: um RCS tão forte quanto o motor mataria a razão de
   * existir do nariz (e do leme, e do piloto automático retrógrado). Quem
   * carrega pacote denso de bicos é o caça, que precisa disso para brigar;
   * quem carrega o mínimo de atracação é o cargueiro. Como a aceleração é
   * F/m e o cargueiro é o mais pesado, a diferença que o jogador SENTE é bem
   * maior que a das fichas: 480 u/s² no caça contra 96 no cargueiro (5×),
   * enquanto os motores principais diferem só 2,7×.
   */
  rcsThrust: number;
  /** Torque máximo dos propulsores de atitude (RCS). */
  torque: number;
  /**
   * Velocidade angular NOMINAL do casco (rad/s): o RCS para de aplicar torque
   * ao chegar nela. É limitador de torque, não freio — a nave nunca é
   * desacelerada para caber neste número, só deixa de ser acelerada.
   */
  maxTurnRate: number;
  /**
   * Velocidade de projeto do casco (unidades/s). Mesma natureza: o motor corta
   * quando não há folga até ela. NÃO existe força que traga a nave de volta a
   * este valor se ela o ultrapassar por um impacto.
   */
  maxSpeed: number;
  /** Tempo de spool do motor de RAMP_MIN até 100% de empuxo (s). */
  spoolTime: number;
  /** Restituição do casco no impacto (0 = amassa, 1 = quica inteiro). */
  restitution: number;
}

/** Perfil físico completo: o que foi escolhido + o que se deduz dele. */
export interface ShipPhysics extends ShipPhysicsSpec {
  /** Momento de inércia I = m·k² (derivado). */
  inertia: number;
  /** Aceleração linear a = F/m, em u/s² (derivada). */
  accel: number;
  /** Aceleração do RCS de translação = rcsThrust/m, em u/s² (derivada). */
  rcsAccel: number;
  /** Aceleração angular α = τ/I, em rad/s² (derivada). */
  angularAccel: number;
  /**
   * Desaceleração angular do RCS ao segurar atitude, em rad/s² (derivada):
   * fração RCS_ATTITUDE_HOLD do torque de manobra. Auxílio de pilotagem
   * declarado, com autoridade finita — não é o vácuo comendo momento angular.
   */
  attitudeHold: number;
  /** Desaceleração do trim assistido = força de trim / massa, em u/s² (derivada). */
  assistDecel: number;
}

const PHYSICS_SPECS: Record<ShipKind, ShipPhysicsSpec> = {
  // Referência da escala: ágil, mas já com peso perceptível.
  builder: {
    mass: 1.0, gyration: 12, thrust: 1200, rcsThrust: 300, torque: 6300 * (12 / 26) ** 2,
    maxTurnRate: 2.6, maxSpeed: 5200, spoolTime: 0.8, restitution: 0.45,
  },
  // Casco de mineração: pesado de equipamento, motor médio, gira devagar. O
  // RCS é o de serviço (21% do motor) — serve para encostar na rocha, não para
  // esquivar.
  mining: {
    mass: 1.4, gyration: 14, thrust: 1260, rcsThrust: 265, torque: 8000 * (14 / 30) ** 2,
    maxTurnRate: 2.0, maxSpeed: 4600, spoolTime: 1.0, restitution: 0.40,
  },
  // Caça: casco curto e leve, o mais rápido a acelerar e a apontar — e o único
  // com pacote de RCS de combate (30% do motor, 480 u/s²).
  attack: {
    mass: 0.8, gyration: 10, thrust: 1280, rcsThrust: 384, torque: 5400 * (10 / 22) ** 2,
    maxTurnRate: 3.3, maxSpeed: 6000, spoolTime: 0.6, restitution: 0.50,
  },
  // Cargueiro: 2,6× a massa e 19 u de raio de giração — porão nas pontas, a
  // massa quase toda na borda do casco (k/R = 0,95). Sai devagar, para
  // devagar e vira devagar — é a classe que ensina o jogador a antecipar. E
  // strafeia MAL de propósito: 16% do motor sobre a maior massa do jogo dá
  // 96 u/s², um quinto do caça.
  transport: {
    mass: 2.6, gyration: 19, thrust: 1560, rcsThrust: 250, torque: 11600 * (19 / 42) ** 2,
    maxTurnRate: 1.15, maxSpeed: 4000, spoolTime: 1.4, restitution: 0.30,
  },
};

/** Deriva o perfil completo a partir das grandezas escolhidas. */
function derive(spec: ShipPhysicsSpec): ShipPhysics {
  const inertia = spec.mass * spec.gyration * spec.gyration;
  const angularAccel = spec.torque / inertia;
  return {
    ...spec,
    inertia,
    accel: spec.thrust / spec.mass,
    rcsAccel: spec.rcsThrust / spec.mass,
    angularAccel,
    attitudeHold: angularAccel * RCS_ATTITUDE_HOLD,
    assistDecel: SHIP_ASSIST_FORCE / spec.mass,
  };
}

/**
 * Perfil físico por classe (casco VAZIO — carga entra por `cargoLoadFactor`).
 * Valores derivados: aceleração linear / RCS / angular, e tempo de rampa até a
 * rotação nominal (ω/α):
 *   builder    a = 1200  rcs = 300  α =  9,32  ω = 2,60 rad/s (149 °/s) em 0,28 s
 *   mining     a =  900  rcs = 189  α =  6,35  ω = 2,00 rad/s (115 °/s) em 0,32 s
 *   attack     a = 1600  rcs = 480  α = 13,95  ω = 3,30 rad/s (189 °/s) em 0,24 s
 *   transport  a =  600  rcs =  96  α =  2,53  ω = 1,15 rad/s ( 66 °/s) em 0,45 s
 */
export const SHIP_PHYSICS: Record<ShipKind, ShipPhysics> = {
  builder: derive(PHYSICS_SPECS.builder),
  mining: derive(PHYSICS_SPECS.mining),
  attack: derive(PHYSICS_SPECS.attack),
  transport: derive(PHYSICS_SPECS.transport),
};

/** Perfil físico de uma classe; sem classe conhecida, usa o de referência. */
export function shipPhysics(kind?: ShipKind): ShipPhysics {
  return (kind && SHIP_PHYSICS[kind]) || SHIP_PHYSICS.builder;
}

/**
 * Massa de uma unidade de carga no porão, na mesma escala das naves. Um porão
 * cheio (TRANSPORT_CARGO_CAP = 500) pesa 1,3 — metade do casco do transporte,
 * que é 2,6. Ou seja: carregado, o cargueiro tem 1,5× a massa e 1,5× o momento
 * de inércia (a carga vai distribuída no porão, em torno do centro de massa,
 * então o raio de giração não muda e I = m·k² escala junto com a massa).
 */
export const CARGO_MASS_PER_UNIT = 1.3 / TRANSPORT_CARGO_CAP;

/**
 * Quanto a carga a bordo multiplica a massa (e o momento de inércia) da nave.
 * 1 = vazia. Tudo que é força dividida por massa — aceleração, aceleração
 * angular, trim do RCS — é dividido por este fator: um cargueiro cheio
 * acelera e gira 1/1,5 do que acelera e gira vazio, sem nenhum número
 * escrito à mão para isso.
 */
export function cargoLoadFactor(kind: ShipKind, cargoAmount: number): number {
  if (!(cargoAmount > 0)) return 1;
  const p = SHIP_PHYSICS[kind];
  return 1 + (cargoAmount * CARGO_MASS_PER_UNIT) / p.mass;
}

// Vagas de hangar por tipo: EXPANDIDAS aceitam QUALQUER classe; NORMAIS
// aceitam SOMENTE ataque e transporte. Logo builder/mineração só cabem nas
// expandidas, e ataque/transporte preferem as normais (transbordando para as
// expandidas quando não há normal livre).

/** Vagas EXPANDIDAS (qualquer classe) no QG — fixo. */
export const HQ_EXPANDED_BAYS = 2;
/** Vagas NORMAIS (só ataque/transporte) no QG — fixo. */
export const HQ_NORMAL_BAYS = 4;
/** Total de vagas de nave no QG. */
export const HQ_SHIP_BAYS = HQ_EXPANDED_BAYS + HQ_NORMAL_BAYS;

/** Vagas EXPANDIDAS na estação de mineração — fixo. */
export const STATION_EXPANDED_BAYS = 2;
/** Vagas NORMAIS na estação de mineração — fixo (nenhuma). */
export const STATION_NORMAL_BAYS = 0;
/** Total de vagas de nave na estação. */
export const STATION_SHIP_BAYS = STATION_EXPANDED_BAYS + STATION_NORMAL_BAYS;

/** Vagas EXPANDIDAS na base inicial — fixo. */
export const BASE_EXPANDED_BAYS = 1;
/** Vagas NORMAIS na base inicial — fixo. */
export const BASE_NORMAL_BAYS = 4;
/** Total de vagas de nave na base inicial. */
export const BASE_SHIP_BAYS = BASE_EXPANDED_BAYS + BASE_NORMAL_BAYS;

/** Vagas EXPANDIDAS no centro de distribuição de rações — fixo. */
export const RATION_CENTER_EXPANDED_BAYS = 1;
/** Vagas NORMAIS no centro de distribuição de rações — fixo (nenhuma). */
export const RATION_CENTER_NORMAL_BAYS = 0;
/** Total de vagas de nave no centro de distribuição. */
export const RATION_CENTER_SHIP_BAYS = RATION_CENTER_EXPANDED_BAYS + RATION_CENTER_NORMAL_BAYS;

/** Vagas de ARANHAS mineradoras na estação, pela classe do asteroide. */
export const STATION_SPIDER_BAYS: Record<AsteroidClass, number> = { small: 2, medium: 4, large: 6 };

/** Taxa de mineração por classe de nave (ataque/transporte não mineram). */
export const MINING_RATE_BY_KIND: Record<ShipKind, number> = {
  builder: MINING_RATE / 2,
  mining: MINING_RATE,
  attack: 0,
  transport: 0,
};

/** A aranha mineradora minera 1,5× mais rápido que a nave mineradora. */
export const SPIDER_MINING_MULT = 1.5;

/** Velocidade de caminhada da aranha na superfície (unidades/s). */
export const SPIDER_SPEED = 130;
/** Tempo minerando num ponto antes de voltar para descarregar (s). */
export const SPIDER_MINE_TIME = 5;

/** Distância máxima até a própria estrutura para ancorar. */
export const DOCK_RANGE = 500;

/** Naves em taxiamento voam no dobro da velocidade (e sem colisão). */
export const TAXI_SPEED_MULT = 2;

// ── Combate (nave de ataque) ──────────────────────────────────────────
/** Velocidade do projétil perfurante (unidades/s). */
export const BULLET_SPEED = 1_000;
/** Alcance máximo do projétil perfurante antes de sumir (unidades). */
export const BULLET_RANGE = 8_000;
/** Raio de detecção de colisão do projétil. */
export const BULLET_RADIUS = 30;
/** Dano do projétil perfurante (HP). */
export const BULLET_DAMAGE = 25;
/** Cooldown entre disparos perfurantes (s). */
export const BULLET_COOLDOWN = 0.25;
/** Estoque máximo de munição perfurante. */
export const BULLET_AMMO_MAX = 120;

/** Velocidade da granada de proximidade (unidades/s). */
export const GRENADE_SPEED = 1_000;
/** Raio de detonação por proximidade (unidades). */
export const GRENADE_PROX_RADIUS = 120;
/** Raio de dano da explosão (unidades). */
export const GRENADE_BLAST_RADIUS = 300;
/** Dano máximo da granada (no centro da explosão). */
export const GRENADE_DAMAGE = 120;
/** Cooldown entre granadas (s). */
export const GRENADE_COOLDOWN = 2.0;
/** Estoque máximo de granadas. */
export const GRENADE_AMMO_MAX = 10;
/** HP máximo de qualquer nave. */
export const SHIP_HP_MAX = 100;
