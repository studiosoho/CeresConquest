/**
 * PARTIDA: modo de vitória, tempo-limite e pontuação — escolhidos na janela
 * de "Criar sala" do lobby e passados ao servidor nas opções da sala.
 *
 *  - "worms" (CAÇA ÀS MINHOCAS): vence quem matar mais minhocas até o fim do
 *    tempo (empate: maior pontuação);
 *  - "lastStand" (ÚLTIMO DE PÉ): sem limite — vence quem sobrar quando todos
 *    os outros jogadores forem eliminados;
 *  - "score" (PONTUAÇÃO): vence a maior pontuação até o fim do tempo.
 *
 * A pontuação (SCORE_POINTS) conta para todos os modos e aparece no placar.
 */

export type VictoryMode = "worms" | "lastStand" | "score";

export const VICTORY_MODES: ReadonlyArray<{ id: VictoryMode; label: string; timed: boolean; hint: string }> = [
  { id: "worms", label: "Caça às minhocas", timed: true, hint: "quem matar mais minhocas dentro do limite de tempo" },
  { id: "lastStand", label: "Último de pé", timed: false, hint: "sem limite — vence quem sobrar" },
  { id: "score", label: "Pontuação", timed: true, hint: "maior pontuação dentro do limite de tempo" },
];

/** modo das salas criadas sem escolha (JOGAR JÁ) */
export const DEFAULT_VICTORY: VictoryMode = "lastStand";
/** tempos-limite oferecidos (min) e o padrão */
export const MATCH_TIME_LIMITS: readonly number[] = [10, 15, 20, 30, 45];
export const DEFAULT_TIME_LIMIT = 20;
/** velocidades do jogo oferecidas (multiplicam mineração, broca e refino) */
export const GAME_SPEEDS: readonly number[] = [1, 2, 4];

/** Pontos por evento (a estrutura construída vale o custo dela em kits). */
export const SCORE_POINTS = {
  /** por kit refinado */
  kit: 1,
  turret: 100,
  shipProduced: 20,
  ruinClaimed: 100,
  enemyShipKilled: 40,
  enemyStructureKilled: 150,
  wormKilled: 300,
} as const;

export function isTimedMode(mode: VictoryMode): boolean {
  return VICTORY_MODES.find((m) => m.id === mode)?.timed ?? false;
}
