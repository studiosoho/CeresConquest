/** Contrato de mensagens cliente ↔ servidor. Neutro de engine. */

/** Intenção de pilotagem enviada pelo cliente a cada ~33ms. */
export interface ShipInput {
  thrust: boolean;
  /** -1 = anti-horário, 0 = reto, 1 = horário */
  turn: -1 | 0 | 1;
  mine: boolean;
}

export const MSG_INPUT = "input";

export const NEUTRAL_INPUT: ShipInput = { thrust: false, turn: 0, mine: false };

// ── Construção ────────────────────────────────────────────────────────
import type { StructureType } from "./structures";

/** Pedido de construção enviado pelo cliente. */
export interface BuildCommand {
  type: StructureType;
}

export const MSG_BUILD = "build";

// ── Produção de naves ─────────────────────────────────────────────────
import type { ProducibleKind } from "./ships";

/** Pedido de fabricação de nave no QG. */
export interface ProduceCommand {
  kind: ProducibleKind;
}

export const MSG_PRODUCE = "produce";

/** Alterna ancoragem no QG (sem payload). */
export const MSG_ANCHOR = "anchor";

/** Troca a nave ativa por outra do hangar da estrutura ancorada (sem payload). */
export const MSG_SWAP = "swap";

/** Configura a mineradora ancorada na estação para minerar sozinha (sem payload). */
export const MSG_AUTOMINE = "automine";

/** Ação do builder após pousar num asteroide vazio. */
export type LandAction = "mine" | "build" | "buildhq" | "buildration" | "liftoff" | "stationmine";
export interface LandActionCommand { action: LandAction; }
export const MSG_LAND_ACTION = "landAction";

/** Requisita um táxi: uma nave vem à estrutura ancorada. */
export interface TaxiCommand {
  /** nave escolhida do hangar; se ausente, o servidor pega a do hangar mais próximo */
  shipId?: string;
}

export const MSG_TAXI = "taxi";

/**
 * Carga/descarga da nave de transporte na vaga de pouso (sem payload — o
 * contexto decide): na estação carrega minério ou descarrega rações; na
 * base inicial descarrega minério (credita a carteira / envia à Terra) ou
 * carrega rações; no QG descarrega rações.
 */
export const MSG_CARGO = "cargo";

/** Disparo da nave de ataque: "bullet" = perfurante, "grenade" = granada. */
export type FireKind = "bullet" | "grenade";
export interface FireCommand { kind: FireKind; }
export const MSG_FIRE = "fire";

/** Expande a arena para o próximo tamanho (small→medium→large). */
// @deprecated("adicionar isto na criação da sala")
//export const MSG_EXPAND = "expandMap";
