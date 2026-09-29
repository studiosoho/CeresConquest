import { BAY_SLOT_EXPANDED_H, bayLayout, type BayHost, type ShipLayer } from "@ceres/shared";

/**
 * PRESENÇA de uma nave na tela: o tamanho em que ela é desenhada e a sua
 * "altitude" aparente — a leitura visual da camada de voo (shared/layers.ts).
 * A câmera é ortográfica e vê tudo de cima; sem uma pista visual, nave em
 * cruzeiro e nave na superfície são indistinguíveis, e o jogador não sabe se
 * vai bater na rocha que está sob ela.
 *
 *  - CRUZEIRO: tamanho de exibição cheio e sombra projetada (altitude 1).
 *  - SUPERFÍCIE e MODO ATAQUE: menor (SURFACE_SIZE) e sem sombra — mais longe
 *    da câmera, rente às rochas (altitude 0).
 *  - POUSADA (na vaga ou num asteroide): encolhe até caber na vaga, num tamanho
 *    perto do real da nave — a nave "estaciona" na placa.
 *  - TRANSIÇÃO: interpola entre as duas camadas pelo progresso sincronizado;
 *    o POUSO interpola até o tamanho da vaga pelo progresso do pouso.
 *
 * Tudo aqui é ALVO; quem suaviza os saltos (decolar da vaga começa uma subida
 * que parte do tamanho de superfície, não do da vaga) é `easePresence`.
 */

/** Fração do tamanho de cruzeiro em que a nave aparece na superfície. */
export const SURFACE_SIZE = 0.6;
/** Fração da altura da placa que a nave pousada ocupa (sobra borda à vista). */
const BAY_FILL = 0.8;
/** Constante de tempo (s) da suavização do tamanho e da altitude. */
const EASE_TAU = 0.18;

/** O que a presença precisa saber de uma nave (o espelho do schema). */
export interface PresenceShip {
  layer: ShipLayer;
  layerTo: ShipLayer | "";
  layerProgress: number;
  anchored: boolean;
  landingPhase: string;
  landingProgress: number;
  hqId: string;
  bay: number;
}

export interface Presence {
  /** escala de exibição na câmera principal (1 = tamanho de mundo) */
  scale: number;
  /** 1 = cruzeiro (sombra cheia), 0 = rente à superfície */
  altitude: number;
  /** em modo ataque (ou descendo para ele) */
  attack: boolean;
}

const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};
const altitudeOf = (l: ShipLayer | "") => (l === "cruise" ? 1 : 0);

/**
 * Escala em que a nave cabe na vaga: o comprimento dela (nariz para a frente
 * da estrutura, ao longo da altura da placa) ocupa BAY_FILL da placa. Sem
 * vaga — pousada num asteroide vazio — usa a placa expandida.
 */
export function dockScale(ship: PresenceShip, meshLength: number, host: BayHost | undefined): number {
  const slot = host && ship.bay >= 0 ? bayLayout(host)[ship.bay] : undefined;
  const h = slot ? slot.h : BAY_SLOT_EXPANDED_H;
  return (BAY_FILL * h) / meshLength;
}

/** Presença-ALVO da nave agora. `cruiseScale` = escala de exibição da classe. */
export function presenceTarget(ship: PresenceShip, cruiseScale: number, docked: number): Presence {
  const flying = (alt: number) => cruiseScale * (SURFACE_SIZE + (1 - SURFACE_SIZE) * alt);
  const attack = ship.layer === "attack" || ship.layerTo === "attack";

  if (ship.anchored || ship.landingPhase === "landed") {
    return { scale: docked, altitude: 0, attack: false };
  }
  if (ship.landingPhase === "landing") {
    // desce do cruzeiro até a placa; já na superfície (o builder que acabou
    // de construir e taxia do centro do asteroide para a vaga), fica no
    // tamanho da vaga o caminho todo
    const s = smooth(ship.landingProgress);
    if (ship.layer !== "cruise") return { scale: docked, altitude: 0, attack: false };
    return { scale: flying(1) + (docked - flying(1)) * s, altitude: 1 - s, attack: false };
  }
  let alt = altitudeOf(ship.layer);
  if (ship.layerTo) {
    const s = smooth(ship.layerProgress);
    alt = alt + (altitudeOf(ship.layerTo) - alt) * s;
  }
  return { scale: flying(alt), altitude: alt, attack };
}

/** Aproxima a presença mostrada do alvo, sem saltos (decolagem, troca de alvo). */
export function easePresence(shown: Presence | undefined, target: Presence, dt: number): Presence {
  if (!shown) return { ...target };
  const k = 1 - Math.exp(-Math.max(0, dt) / EASE_TAU);
  return {
    scale: shown.scale + (target.scale - shown.scale) * k,
    altitude: shown.altitude + (target.altitude - shown.altitude) * k,
    attack: target.attack,
  };
}
