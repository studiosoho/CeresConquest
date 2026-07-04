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

/** Troca a nave ativa por outra do hangar do QG ancorado (sem payload). */
export const MSG_SWAP = "swap";
