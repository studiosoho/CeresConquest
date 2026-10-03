/** Contrato de mensagens cliente ↔ servidor. Neutro de engine. */

/**
 * Intenção de pilotagem enviada pelo cliente a cada ~33ms.
 *
 * Os três primeiros campos são o contrato antigo e continuam obrigatórios. Os
 * três novos são OPCIONAIS de propósito: `undefined` significa exatamente o
 * comportamento que o jogo sempre teve (sem RCS, com auxílio ligado), então
 * nenhum emissor de input existente — bots, piloto automático, testes, clientes
 * de versão anterior — precisa mudar, e desfazer a mudança é apagar três linhas.
 */
export interface ShipInput {
  thrust: boolean;
  /** -1 = anti-horário, 0 = reto, 1 = horário */
  turn: -1 | 0 | 1;
  mine: boolean;
  /**
   * RCS de translação lateral: -1 = bombordo, 0 = nada, +1 = boreste. "Boreste"
   * é o lado para onde `turn: 1` varre o nariz (ângulo + 90°), para que os dois
   * comandos tenham o mesmo sentido na cabeça do piloto.
   */
  strafe?: -1 | 0 | 1;
  /** RCS retrógrado: empurra na direção OPOSTA ao nariz, sem girar o casco. */
  retro?: boolean;
  /**
   * "Flight assist off": desliga os AUXÍLIOS automáticos (o trim linear do RCS
   * e a retenção de atitude). Não mexe no RCS de translação — aquilo é empuxo
   * pedido pelo piloto, não auxílio. Ausente/false = auxílio ligado, que é o
   * padrão e o que bots e piloto automático usam.
   */
  assistOff?: boolean;
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

/**
 * [F] (sem payload): o único comando de pouso e de camada de voo — pousa na
 * vaga livre da estação própria ou num asteroide vazio, decola, desce do
 * cruzeiro à superfície, entra no modo ataque sobre estação inimiga e sobe de
 * volta. O servidor decide qual pelo contexto (ver MatchRoom.tryToggleAnchor).
 */
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
 * Carga/descarga da nave de transporte pousada numa vaga (sem payload — o
 * contexto decide): na estação carrega minério ou descarrega rações; na
 * base inicial descarrega minério (credita a carteira / envia à Terra) ou
 * carrega rações; no QG descarrega rações.
 */
export const MSG_CARGO = "cargo";

/**
 * Disparo da nave de ataque (sem payload): dispara a arma SELECIONADA
 * (MSG_WEAPON). A mira é do servidor — o computador de tiro (weapons.ts).
 */
export const MSG_FIRE = "fire";

/** Seleciona a arma da nave de ataque (teclas 1, 2 e 3). */
import type { WeaponKind } from "./weapons";
export interface WeaponCommand { weapon: WeaponKind; }
export const MSG_WEAPON = "weapon";

/**
 * Evolui a estação de mineração de Ceres em que o builder está atracado (sem
 * payload): um nível a mais, pelo custo de ceresStationUpgradeCost.
 */
export const MSG_UPGRADE = "upgrade";

/**
 * Builder atracado numa estrutura própria: começa a construir uma turreta
 * (turrets.ts), pagando com o minério do porão. Trava o builder até o fim.
 */
export const MSG_TURRET = "turret";

/** Jogador encerrado recomeça com uma base inicial nova num lugar aleatório. */
export const MSG_RESTART = "restart";

/** Builder atracado na central de rações: compra um nível de uma melhoria dos drones (kits). */
import type { DroneTrack } from "./logistics";
export interface DroneUpgradeCommand { track: DroneTrack; }
export const MSG_DRONE_UPGRADE = "droneUpgrade";

/**
 * Builder atracado numa estrutura própria troca com o buffer dela:
 * [O] retira minério, [P] deposita minério, [K] retira kits, [L] deposita kits;
 * [J] rações — carrega na base inicial, descarrega na estação de mineração ou
 * no QG; na central de rações, descarrega se o builder chega com rações e
 * carrega se chega sem (a direção vem da estrutura e do porão; `dir` é ignorado).
 */
export interface TransferCommand { item: "ore" | "kits" | "rations"; dir: "withdraw" | "deposit"; }
export const MSG_TRANSFER = "transfer";

/**
 * Efeito visual anunciado pelo servidor a todos os clientes — não muda o jogo,
 * só diz ONDE e O QUÊ explodiu, na posição exata do servidor (o cliente não
 * teria como saber: o projétil some do estado no mesmo tick do acerto).
 *  - "hit": míssil acertou nave ou estrutura;
 *  - "blast": mina detonou (raio de dano MINE_BLAST_RADIUS);
 *  - "laser": disparo de laser TRAVADO — traço da nave (sx..y) ao alvo (tsx..ty);
 *  - "shipDown": nave destruída (tiro ou colisão);
 *  - "structureDown": estrutura destruída.
 */
export type FxKind = "hit" | "blast" | "shipDown" | "structureDown" | "laser";
export interface FxEvent {
  kind: FxKind;
  sx: number; sy: number; x: number; y: number;
  /** ponta do traço (só "laser") */
  tsx?: number; tsy?: number; tx?: number; ty?: number;
  /** quem disparou o laser: uma nave (padrão) ou uma turreta — muda o som */
  from?: "ship" | "turret";
  /** quem disparou o laser (id da nave ou da estrutura da turreta) — o
   *  cliente tira dele a altura do início do traço 3D */
  src?: string;
  /**
   * EM QUEM a explosão acontece — quem recebeu o dano: a nave `id`, a
   * estrutura `id` ou a nave GUARDADA na vaga `bay` da estrutura `id` (o
   * sorteio do dano, combat.ts splitDamage). O cliente dimensiona a explosão
   * pelo alvo e a prende a ele (a nave atingida a leva junto).
   */
  on?: "ship" | "structure" | "bay";
  id?: string;
  bay?: number;
}
export const MSG_FX = "fx";

/** Alerta a UM jogador (faixa no centro da tela + alarme): ex. os tremores da toca das minhocas. */
export interface AlertEvent {
  text: string;
  level: "warn" | "danger";
}
export const MSG_ALERT = "alert";

/** Expande a arena para o próximo tamanho (small→medium→large). */
// @deprecated("adicionar isto na criação da sala")
//export const MSG_EXPAND = "expandMap";
