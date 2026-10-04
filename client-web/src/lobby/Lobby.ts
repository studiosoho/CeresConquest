/**
 * Lobby — tela inicial (overlay DOM) antes do jogo. O jogador informa o nome,
 * acompanha a lista de salas em tempo real (título + jogadores conectados /
 * limite) e entra numa sala existente, cria uma nova ou usa "jogar já".
 *
 * CRIAR SALA abre a janela de configuração: nome, velocidade do jogo,
 * jogadores-bot, frota inimiga de Ceres, modo de vitória e tempo-limite
 * (MatchOptions do servidor; shared/match.ts).
 *
 * Usa a LobbyRoom embutida do Colyseus para a listagem em tempo real:
 * ao entrar em "lobby", recebe a mensagem "rooms" (lista completa) e depois
 * "+" ([roomId, dados]) / "-" (roomId) a cada mudança das salas com
 * enableRealtimeListing (as "match"). Ver:
 * https://docs.colyseus.io/room/built-in/lobby
 *
 * Estilo casado com o HUD (preto, fósforo azulado, monospace). Sem Babylon,
 * sem lógica de jogo: só matchmaking. Devolve a Room de "match" já juntada,
 * que o main.ts entrega ao GameScene.
 */

import type { Client, Room, RoomAvailable } from "colyseus.js";
import { Palette } from "../render/Palette";
import { DEFAULT_TIME_LIMIT, GAME_SPEEDS, MATCH_TIME_LIMITS, VICTORY_MODES, type VictoryMode } from "@ceres/shared";

const NAME_KEY = "ceres.playerName";
/** nome da sala de jogo definida no servidor (index.ts) */
const MATCH_NAME = "match";

/** `0xRRGGBB` → string CSS, com alpha opcional. */
function cssColor(hex: number, alpha = 1): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Opções da sala escolhidas na janela de "Criar sala" (MatchOptions do servidor). */
interface RoomSetup {
  title: string;
  testSpeed: number;
  playerBots: number;
  bots: number;
  victory: VictoryMode;
  timeLimit: number;
}

interface RoomMeta {
  title?: string;
}

export interface EnterGame {
  room: Room;
  name: string;
}

export class Lobby {
  private client: Client;
  private root: HTMLDivElement;
  private nameInput!: HTMLInputElement;
  private listEl!: HTMLDivElement;
  private statusEl!: HTMLDivElement;
  private emptyEl!: HTMLDivElement;
  private buttons: HTMLButtonElement[] = [];

  private lobbyRoom?: Room;
  private rooms = new Map<string, RoomAvailable<RoomMeta>>();
  private resolve?: (v: EnterGame) => void;
  private busy = false;

  constructor(client: Client) {
    this.client = client;
    this.root = document.createElement("div");
    this.build();
  }

  /** Exibe o lobby e resolve quando o jogador entra numa sala de jogo. */
  waitForEnter(): Promise<EnterGame> {
    document.body.appendChild(this.root);
    void this.connectLobby();
    return new Promise((res) => {
      this.resolve = res;
    });
  }

  // ── conexão com a LobbyRoom ─────────────────────────────────────────

  private async connectLobby(): Promise<void> {
    try {
      this.lobbyRoom = await this.client.joinOrCreate("lobby");
    } catch (err) {
      this.setStatus(`Falha ao conectar ao servidor. ${errText(err)}`, true);
      return;
    }
    this.lobbyRoom.onMessage("rooms", (rooms: RoomAvailable<RoomMeta>[]) => {
      this.rooms.clear();
      for (const r of rooms) this.rooms.set(r.roomId, r);
      this.renderList();
    });
    this.lobbyRoom.onMessage("+", ([roomId, room]: [string, RoomAvailable<RoomMeta>]) => {
      this.rooms.set(roomId, room);
      this.renderList();
    });
    this.lobbyRoom.onMessage("-", (roomId: string) => {
      this.rooms.delete(roomId);
      this.renderList();
    });
    this.lobbyRoom.onError((code, message) => this.setStatus(`Lobby: ${message ?? code}`, true));
  }

  // ── ações de entrada no jogo ────────────────────────────────────────

  private playerName(): string {
    const n = this.nameInput.value.trim().slice(0, 20);
    return n.length > 0 ? n : "Piloto";
  }

  /**
   * MODO DE TESTE pela URL: `?playerBots=1&testSpeed=4` cria a sala com
   * jogadores-bot e mineração/refino acelerados (MatchOptions do servidor).
   */
  private testOptions(): { playerBots?: number; testSpeed?: number } | null {
    const q = new URLSearchParams(location.search);
    const playerBots = Number(q.get("playerBots") ?? 0);
    const testSpeed = Number(q.get("testSpeed") ?? 1);
    if (!(playerBots > 0) && !(testSpeed > 1)) return null;
    return { playerBots: playerBots > 0 ? playerBots : undefined, testSpeed: testSpeed > 1 ? testSpeed : undefined };
  }

  /** joinOrCreate: entra numa sala com vaga ou cria uma (com opções de teste, sempre cria). */
  private quickPlay(): void {
    const name = this.playerName();
    const test = this.testOptions();
    if (test) void this.enter(name, () => this.client.create(MATCH_NAME, { name, title: `Teste de ${name}`, ...test }));
    else void this.enter(name, () => this.client.joinOrCreate(MATCH_NAME, { name }));
  }

  /** create: sempre uma sala nova, com as opções escolhidas na janela de configuração. */
  private createRoom(opts: RoomSetup): void {
    const name = this.playerName();
    // quem cria a sala entra ASSISTINDO e começa a jogar com [R]
    void this.enter(name, () => this.client.create(MATCH_NAME, { name, ...opts, spectate: true }));
  }

  /** Janela de "Criar sala": a partida inteira é configurada aqui. */
  private openCreateDialog(): void {
    if (this.busy) return;
    const test = this.testOptions();
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
      `background:${cssColor(0x000000, 0.7)};z-index:2;`;
    const box = document.createElement("div");
    box.style.cssText =
      `width:min(460px,90vw);max-height:86vh;overflow:auto;box-sizing:border-box;padding:22px 26px;` +
      `background:${cssColor(0x05080c, 0.97)};border:1px solid ${cssColor(Palette.structure.own, 0.7)};`;
    const head = document.createElement("div");
    head.textContent = "NOVA SALA";
    head.style.cssText = `font-size:18px;letter-spacing:4px;color:${cssColor(Palette.structure.own)};margin-bottom:16px;`;
    box.appendChild(head);

    const field = (label: string, el: HTMLElement) => {
      box.appendChild(this.label(label));
      el.style.marginBottom = "14px";
      box.appendChild(el);
    };
    const select = (options: Array<[string, string]>, value: string) => {
      const sel = document.createElement("select");
      sel.style.cssText =
        `width:100%;padding:8px 10px;font-family:monospace;font-size:14px;outline:none;` +
        `background:${cssColor(0x0a1018, 0.9)};color:${cssColor(Palette.ui.text)};` +
        `border:1px solid ${cssColor(Palette.ui.minimapBorder, 0.6)};`;
      for (const [v, t] of options) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = t;
        sel.appendChild(o);
      }
      sel.value = value;
      return sel;
    };

    const title = document.createElement("input");
    title.maxLength = 24;
    title.value = `Arena de ${this.playerName()}`;
    title.style.cssText =
      `width:100%;box-sizing:border-box;padding:8px 10px;font-family:monospace;font-size:14px;outline:none;` +
      `background:${cssColor(0x0a1018, 0.9)};color:${cssColor(Palette.ui.text)};` +
      `border:1px solid ${cssColor(Palette.ui.minimapBorder, 0.6)};`;
    field("NOME DA SALA", title);
    const speed = select(GAME_SPEEDS.map((v) => [String(v), v === 1 ? "1x (normal)" : `${v}x`]), String(test?.testSpeed ?? 1));
    field("VELOCIDADE DO JOGO (MINERAÇÃO, BROCA E REFINO)", speed);
    const pbots = select([0, 1, 2, 3, 4].map((v) => [String(v), v === 0 ? "nenhum" : String(v)]), String(test?.playerBots ?? 0));
    field("JOGADORES-BOT (CONSTROEM E ATACAM COMO JOGADORES)", pbots);
    const fleet = select([0, 1, 2, 3, 4, 5, 6].map((v) => [String(v), v === 0 ? "nenhuma" : v === 1 ? "1 nave" : `${v} naves`]), "6");
    field("FROTA INIMIGA DE CERES (BOTS)", fleet);

    // modo de vitória: um botão de rádio por modo, com a explicação
    box.appendChild(this.label("MODO DE VITÓRIA"));
    let mode: VictoryMode = "lastStand";
    const modes = document.createElement("div");
    modes.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-bottom:14px;";
    const time = select(MATCH_TIME_LIMITS.map((v) => [String(v), `${v} min`]), String(DEFAULT_TIME_LIMIT));
    const syncTime = () => {
      const timed = VICTORY_MODES.find((m) => m.id === mode)?.timed ?? false;
      time.disabled = !timed;
      time.style.opacity = timed ? "1" : "0.4";
    };
    for (const m of VICTORY_MODES) {
      const row = document.createElement("label");
      row.style.cssText = "display:flex;gap:8px;align-items:flex-start;cursor:pointer;font-size:13px;";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "victory";
      radio.checked = m.id === mode;
      radio.addEventListener("change", () => { mode = m.id; syncTime(); });
      const text = document.createElement("span");
      text.innerHTML = `<b>${m.label}</b><br><span style="opacity:.6">${m.hint}</span>`;
      row.append(radio, text);
      modes.appendChild(row);
    }
    box.appendChild(modes);
    field("TEMPO-LIMITE", time);
    syncTime();

    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:10px;margin-top:6px;";
    const ok = this.button("CRIAR", true, () => {
      overlay.remove();
      this.createRoom({
        title: title.value.trim() || `Arena de ${this.playerName()}`,
        testSpeed: Number(speed.value),
        playerBots: Number(pbots.value),
        bots: Number(fleet.value),
        victory: mode,
        timeLimit: Number(time.value),
      });
    });
    const cancel = this.button("CANCELAR", false, () => overlay.remove());
    ok.style.flex = "1";
    cancel.style.flex = "1";
    row.append(ok, cancel);
    box.appendChild(row);
    overlay.appendChild(box);
    this.root.appendChild(overlay);
  }

  /** joinById: entra numa sala específica da lista. */
  private joinRoom(roomId: string): void {
    const name = this.playerName();
    void this.enter(name, () => this.client.joinById(roomId, { name }));
  }

  private async enter(name: string, join: () => Promise<Room>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.setBusy(true);
    localStorage.setItem(NAME_KEY, name);
    this.setStatus("Entrando…", false);
    try {
      const room = await join();
      // sai da sala de lobby antes de entregar o jogo
      await this.lobbyRoom?.leave();
      this.root.remove();
      this.resolve?.({ room, name });
    } catch (err) {
      this.busy = false;
      this.setBusy(false);
      this.setStatus(`Não foi possível entrar. ${errText(err)}`, true);
    }
  }

  // ── DOM ─────────────────────────────────────────────────────────────

  private build(): void {
    this.root.style.cssText =
      "position:fixed;inset:0;z-index:20;display:flex;align-items:center;" +
      "justify-content:center;background:#000;font-family:monospace;" +
      `color:${cssColor(Palette.ui.text)};user-select:none;`;

    const panel = document.createElement("div");
    panel.style.cssText =
      `width:min(560px,92vw);max-height:88vh;overflow:auto;box-sizing:border-box;` +
      `padding:28px 32px;background:${cssColor(0x000000, 0.85)};` +
      `border:1px solid ${cssColor(Palette.ui.minimapBorder, 0.7)};`;

    const title = document.createElement("div");
    title.textContent = "CERES CONQUEST";
    title.style.cssText =
      `font-size:26px;letter-spacing:6px;font-weight:bold;` +
      `color:${cssColor(Palette.structure.own)};margin-bottom:2px;`;
    const subtitle = document.createElement("div");
    subtitle.textContent = "SALA DE ESPERA";
    subtitle.style.cssText = `font-size:12px;letter-spacing:3px;opacity:0.6;margin-bottom:22px;`;
    panel.append(title, subtitle);

    // nome do jogador
    panel.appendChild(this.label("NOME DE JOGADOR"));
    this.nameInput = document.createElement("input");
    this.nameInput.maxLength = 20;
    this.nameInput.placeholder = "Piloto";
    this.nameInput.value = localStorage.getItem(NAME_KEY) ?? "";
    this.nameInput.style.cssText =
      `width:100%;box-sizing:border-box;padding:10px 12px;margin-bottom:18px;` +
      `background:${cssColor(0x0a1018, 0.9)};color:${cssColor(Palette.ui.text)};` +
      `border:1px solid ${cssColor(Palette.ui.minimapBorder, 0.6)};` +
      `font-family:monospace;font-size:15px;outline:none;`;
    this.nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.quickPlay();
    });
    panel.appendChild(this.nameInput);

    // ações principais
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:10px;margin-bottom:22px;";
    const quick = this.button("JOGAR JÁ", true, () => this.quickPlay());
    const create = this.button("CRIAR SALA", false, () => this.openCreateDialog());
    quick.style.flex = "1";
    create.style.flex = "1";
    actions.append(quick, create);
    panel.appendChild(actions);

    // lista de salas
    const listHeader = document.createElement("div");
    listHeader.style.cssText =
      `display:flex;justify-content:space-between;align-items:center;` +
      `border-bottom:1px solid ${cssColor(Palette.ui.minimapBorder, 0.4)};` +
      `padding-bottom:6px;margin-bottom:8px;`;
    const lh = this.label("SALAS ATIVAS");
    lh.style.marginBottom = "0";
    const legend = document.createElement("span");
    legend.textContent = "JOGADORES";
    legend.style.cssText = "font-size:10px;letter-spacing:2px;opacity:0.5;";
    listHeader.append(lh, legend);
    panel.appendChild(listHeader);

    this.listEl = document.createElement("div");
    this.listEl.style.cssText = "display:flex;flex-direction:column;gap:6px;min-height:48px;";
    this.emptyEl = document.createElement("div");
    this.emptyEl.textContent = "Nenhuma sala ativa — crie a primeira.";
    this.emptyEl.style.cssText = "opacity:0.45;font-size:13px;padding:14px 2px;";
    this.listEl.appendChild(this.emptyEl);
    panel.appendChild(this.listEl);

    this.statusEl = document.createElement("div");
    this.statusEl.style.cssText = "min-height:18px;margin-top:16px;font-size:13px;";
    panel.appendChild(this.statusEl);

    this.root.appendChild(panel);
  }

  private renderList(): void {
    const items = [...this.rooms.values()].filter((r) => r.name === MATCH_NAME);
    this.listEl.replaceChildren();
    if (items.length === 0) {
      this.listEl.appendChild(this.emptyEl);
      return;
    }
    items.sort((a, b) => a.roomId.localeCompare(b.roomId));
    for (const r of items) {
      const full = r.clients >= r.maxClients;
      const row = document.createElement("div");
      row.style.cssText =
        `display:flex;align-items:center;gap:10px;padding:9px 12px;` +
        `background:${cssColor(0x0a1018, 0.7)};` +
        `border:1px solid ${cssColor(Palette.ui.minimapBorder, 0.35)};`;

      const name = document.createElement("div");
      name.textContent = r.metadata?.title ?? `Sala ${r.roomId.slice(0, 6)}`;
      name.style.cssText = "flex:1;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

      const count = document.createElement("div");
      count.textContent = `${r.clients}/${r.maxClients}`;
      count.style.cssText =
        `font-size:14px;min-width:44px;text-align:right;` +
        `color:${cssColor(full ? Palette.fx.boundary : Palette.structure.own)};`;

      const join = this.button(full ? "CHEIA" : "ENTRAR", false, () => this.joinRoom(r.roomId));
      join.disabled = full || this.busy;
      join.style.padding = "6px 14px";
      join.style.fontSize = "12px";
      if (full) join.style.opacity = "0.4";

      row.append(name, count, join);
      this.listEl.appendChild(row);
    }
  }

  private label(text: string): HTMLDivElement {
    const el = document.createElement("div");
    el.textContent = text;
    el.style.cssText = "font-size:11px;letter-spacing:2px;opacity:0.6;margin-bottom:6px;";
    return el;
  }

  private button(text: string, primary: boolean, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = text;
    const accent = primary ? Palette.structure.own : Palette.ui.minimapBorder;
    b.style.cssText =
      `padding:10px 16px;cursor:pointer;font-family:monospace;font-size:13px;` +
      `letter-spacing:1px;background:${cssColor(accent, primary ? 0.16 : 0.06)};` +
      `color:${cssColor(accent)};border:1px solid ${cssColor(accent, 0.8)};outline:none;`;
    b.addEventListener("click", onClick);
    this.buttons.push(b);
    return b;
  }

  private setBusy(busy: boolean): void {
    for (const b of this.buttons) b.disabled = busy;
    this.nameInput.disabled = busy;
  }

  private setStatus(text: string, error: boolean): void {
    this.statusEl.textContent = text;
    this.statusEl.style.color = error ? cssColor(Palette.fx.boundary) : cssColor(Palette.ui.text);
  }
}

function errText(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}
