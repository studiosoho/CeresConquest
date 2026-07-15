/**
 * Lobby — tela inicial (overlay DOM) antes do jogo. O jogador informa o nome,
 * acompanha a lista de salas em tempo real (título + jogadores conectados /
 * limite) e entra numa sala existente, cria uma nova ou usa "jogar já".
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

  /** joinOrCreate: entra numa sala com vaga ou cria uma. */
  private quickPlay(): void {
    const name = this.playerName();
    void this.enter(name, () => this.client.joinOrCreate(MATCH_NAME, { name }));
  }

  /** create: sempre uma sala nova, com título derivado do nome. */
  private createRoom(): void {
    const name = this.playerName();
    void this.enter(name, () => this.client.create(MATCH_NAME, { name, title: `Arena de ${name}` }));
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
    const create = this.button("CRIAR SALA", false, () => this.createRoom());
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
