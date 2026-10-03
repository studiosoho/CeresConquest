/**
 * KeyInput — estado de teclado via eventos DOM, substituindo o
 * input.keyboard do Phaser com a MESMA semântica que o GameScene usa:
 *
 * - isDown(nome): a tecla está pressionada agora.
 * - justDown(nome): true UMA única vez por pressionada — a chamada CONSOME
 *   o flag (como Phaser.Input.Keyboard.JustDown). Chamar duas vezes no
 *   mesmo frame retorna false na segunda.
 *
 * Os nomes são os mesmos usados com addKeys ("W", "UP", "SPACE", "ONE"…),
 * mapeados para KeyboardEvent.code (independente de layout).
 */

export type KeyName =
  | "W" | "A" | "S" | "D" | "UP" | "LEFT" | "RIGHT" | "SPACE" | "PLUS" | "MINUS"
  | "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE" | "SIX"
  | "E" | "F" | "C" | "G" | "T" | "Y" | "M" | "Q" | "X" | "U" | "V" | "B" | "N" | "R"
  | "O" | "P" | "K" | "L" | "J";

const CODE_MAP: Record<KeyName, string[]> = {
  W: ["KeyW"], A: ["KeyA"], S: ["KeyS"], D: ["KeyD"],
  UP: ["ArrowUp"], LEFT: ["ArrowLeft"], RIGHT: ["ArrowRight"],
  SPACE: ["Space"],
  PLUS: ["Equal", "NumpadAdd"],
  MINUS: ["Minus", "NumpadSubtract"],
  ONE: ["Digit1"], TWO: ["Digit2"], THREE: ["Digit3"],
  FOUR: ["Digit4"], FIVE: ["Digit5"], SIX: ["Digit6"],
  E: ["KeyE"], F: ["KeyF"], C: ["KeyC"], G: ["KeyG"],
  T: ["KeyT"], Y: ["KeyY"], M: ["KeyM"],
  // liga/desliga o som
  N: ["KeyN"],
  // recomeçar (encerrado, no modo espectador)
  R: ["KeyR"],
  // builder atracado: [O] retira / [P] deposita minério, [K] retira / [L] deposita kits
  O: ["KeyO"], P: ["KeyP"], K: ["KeyK"], L: ["KeyL"], J: ["KeyJ"],
  // RCS de translação (Q/E lateral, S de ré) e flight assist off (X)
  Q: ["KeyQ"], X: ["KeyX"],
  // evolui a estação de mineração de Ceres (builder atracado nela)
  U: ["KeyU"],
  // alterna a vista: de cima ↔ cockpit em tela cheia
  V: ["KeyV"],
  // builder atracado: constrói uma turreta na estrutura
  B: ["KeyB"],
};

/** code → nome (invertido uma vez no módulo) */
const NAME_BY_CODE = new Map<string, KeyName>();
for (const [name, codes] of Object.entries(CODE_MAP) as Array<[KeyName, string[]]>) {
  for (const code of codes) NAME_BY_CODE.set(code, name);
}

/** teclas cujo default do navegador atrapalha o jogo (scroll, etc.) */
const PREVENT_DEFAULT = new Set(["Space", "ArrowUp", "ArrowLeft", "ArrowRight", "ArrowDown"]);

export class KeyInput {
  private down = new Set<KeyName>();
  /** pressionadas ainda não consumidas por justDown() */
  private pressed = new Set<KeyName>();

  private onKeyDown = (ev: KeyboardEvent): void => {
    if (PREVENT_DEFAULT.has(ev.code)) ev.preventDefault();
    const name = NAME_BY_CODE.get(ev.code);
    if (!name) return;
    if (!ev.repeat && !this.down.has(name)) this.pressed.add(name);
    this.down.add(name);
  };

  private onKeyUp = (ev: KeyboardEvent): void => {
    const name = NAME_BY_CODE.get(ev.code);
    if (!name) return;
    this.down.delete(name);
  };

  constructor() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  isDown(name: KeyName): boolean {
    return this.down.has(name);
  }

  /** Consome e retorna o flag de "acabou de pressionar". */
  justDown(name: KeyName): boolean {
    if (this.pressed.has(name)) {
      this.pressed.delete(name);
      return true;
    }
    return false;
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.down.clear();
    this.pressed.clear();
  }
}
