import {
  CERES_PLATFORM_PREFIX,
  DOCK_RANGE,
  DRONE_TRACKS,
  REFINE_ORE,
  RUIN_OWNER,
  SHIP_PRODUCTION,
  STRUCTURE_SPECS,
  TURRET_COST,
  WORM_HOLE_SEAL_MINES,
  WORM_WAKE_LEVEL,
  ceresPlatformPos,
  ceresPlatforms,
  dist,
  droneUpgradeCost,
  holdRoom,
  stationUpgradeCost,
  structureMaxHp,
  type DroneTrack,
  type ShipInput,
  type StructureType,
  type WorldPos,
} from "@ceres/shared";
import { seekInput, sectorAsteroids, type ShipState, type SimWorld, type Structure } from "@ceres/sim-core";

/**
 * JOGADOR-BOT — um "jogador" inteiro pilotado pelo servidor, para testar o
 * jogo de ponta a ponta. Ele entra como um jogador comum (base inicial e
 * builder com os kits de partida) e joga apertando as MESMAS ações das
 * teclas ([F], [E], [O]/[P], [U], [G], [B], construir, produzir) — o que se
 * testa é a lógica real da sala, não um atalho.
 *
 * O plano do builder, reavaliado a cada passo (o primeiro que se aplica):
 *  1. sem estação de mineração: minera e refina numa rocha livre e a ergue;
 *  2. sem QG: junta kits na estação e ergue o QG numa rocha livre;
 *  3. CONSERTA ([G]) a estrutura própria mais danificada;
 *  4. produz naves com o minério do QG (sem rota de minério, leva ele mesmo):
 *     transporte de minério, 3 de ataque, uma de mineração (vira ARANHA),
 *     e, com a central, o transporte de rações;
 *  5. ergue a central de rações;
 *  6. TURRETAS em todas as bases (QG com 2);
 *  7. EVOLUI a estação de mineração ([U]) e os DRONES da central;
 *  8. CERES: ergue uma estação numa plataforma e a evolui ao nível 2 — o
 *     ninho acorda; ele não volta a ela (os alertas mandam evacuar);
 *  9. no mais, junta kits na estação.
 *
 * O jogador-bot PILOTA UMA NAVE SÓ — o builder. Da frota ele dá as ordens
 * que um jogador dá uma vez e o jogo automatiza (transporte na rota, nave de
 * mineração virando aranha). As naves de ATAQUE agem sozinhas, numa ALA
 * (AttackWing). A prioridade é DEFENDER: naves inimigas atacando uma
 * estrutura dele são caçadas primeiro. Depois a minhoca (caçar a que está
 * fora da toca; tapar a toca depois de matar uma, ou de ela estar aberta há
 * PLAYER_BOT_SEAL_AFTER). Em segundo plano, atacam o vizinho mais próximo: a
 * estrutura inimiga mais perto (INCURSÃO) ou, se estiver mais perto, a nave
 * inimiga em voo (CAÇA) — de qualquer outro jogador, humano ou jogador-bot,
 * ou da frota de Ceres: os jogadores-bot se enfrentam.
 */

/** naves de ataque por incursão, e quantas o bot mantém */
export const PLAYER_BOT_RAID_SIZE = 3;
/** duração do ataque de uma incursão (s) e o intervalo mínimo entre incursões (s) */
export const PLAYER_BOT_RAID_TIME = 45;
export const PLAYER_BOT_RAID_COOLDOWN = 60;
/** tapa a toca depois de matar uma minhoca, ou depois deste tempo com ela aberta (s) */
export const PLAYER_BOT_SEAL_AFTER = 300;
/** com uma minhoca a menos disto do QG, nenhuma nave decola dele (u) */
export const PLAYER_BOT_WORM_CLEARANCE = 7000;
/** turretas por tipo de estrutura */
const TURRETS_WANTED: Partial<Record<StructureType, number>> = { hq: 2, initialBase: 1, miningStation: 1, rationCenter: 1 };
/** nível até onde evolui a estação de mineração da rocha, e o nível de cada trilha dos drones */
const STATION_LEVEL_WANTED = 3;
const DRONE_LEVEL_WANTED = 1;
/** abaixo desta fração do HP máximo, conserta */
const REPAIR_BELOW = 0.65;
/** intervalo mínimo entre duas ações "de tecla" do bot (s) */
const ACTION_GAP = 0.3;
const NEUTRAL: ShipInput = { thrust: false, turn: 0, mine: false };

/** Um local de pouso: rocha livre ou plataforma de Ceres. */
interface Site extends WorldPos {
  id: string;
  radius: number;
}

/** O que a sala oferece ao bot: as ações do jogador e alguns atalhos de frota. */
export interface PlayerBotHost {
  readonly sim: SimWorld;
  elapsed(): number;
  /** nave ativa do jogador (id e estado), ou null */
  active(sid: string): { id: string; ship: ShipState } | null;
  /** [F] pousar/decolar/trocar de camada */
  anchor(sid: string): void;
  /** ações pousado: "mine" (liga/desliga), "buildmine", "buildhq", "buildration", "stationmine" */
  landAction(sid: string, action: string): void;
  /** [E] liga/desliga o refino automático do builder, e se ele está ligado */
  refine(sid: string): void;
  isAutoRefining(shipId: string): boolean;
  /** [O]/[P]/[K]/[L]/[J] trocas com o buffer da estrutura atracada */
  transfer(sid: string, item: "ore" | "kits" | "rations", dir: "withdraw" | "deposit"): void;
  /** [3]–[6] fabrica uma nave no QG */
  produce(sid: string, kind: keyof typeof SHIP_PRODUCTION): void;
  /** [B] turreta na estrutura atracada */
  turret(sid: string): void;
  /** [U] evolui a estação atracada */
  upgrade(sid: string): void;
  /** [1]/[2]/[3] na central atracada: melhora uma trilha dos drones */
  droneUpgrade(sid: string, track: DroneTrack): void;
  droneLevels(centerId: string): Record<DroneTrack, number>;
  /** [G] do builder: conserto (ou recuperação de ruína) da estrutura atracada */
  repair(sid: string): void;
  isRepairing(structId: string): boolean;
  /** comando de voo da nave ativa */
  input(sid: string, input: ShipInput): void;
  /** põe um transporte numa rota automática (o mesmo que o [G] do transporte) */
  startFreighter(shipId: string, mode: "ore" | "rations", pickupId: string, destId: string): boolean;
  /** rota em que o transporte está (ou null) */
  freighterMode(shipId: string): "ore" | "rations" | null;
  /** manda a nave de mineração virar aranha da estação (o mesmo que o [G] dela) */
  sendSpider(shipId: string, stationId: string): boolean;
  /** a nave de mineração já é aranha (ou está a caminho de virar)? */
  isBusyMiner(shipId: string): boolean;
  /** lança as naves de ataque contra `targetId` por `seconds` s; elas voltam ao QG depois */
  launchRaid(sid: string, shipIds: string[], targetId: string, seconds: number): void;
  /**
   * Missão das naves de ataque: caçar a minhoca ("worm"), tapar a toca
   * ("seal"), DEFENDER uma estrutura ("defend": `target` = nave inimiga,
   * `site` = a estrutura atacada) ou caçar uma nave inimiga no cruzeiro ("hunt").
   */
  launchMission(sid: string, shipIds: string[], kind: "worm" | "seal" | "defend" | "hunt", seconds: number, target?: string, site?: string): void;
  /** naves inimigas atacando estruturas do jogador (modo ataque sobre elas) */
  threats(sid: string): Array<{ shipId: string; structId: string }>;
  /** nave inimiga em voo no cruzeiro mais perto de `from` */
  nearestEnemyShip(sid: string, from: WorldPos): { id: string; dist: number } | null;
  /** missão em curso da nave de ataque ("raid", "worm", "seal") ou null */
  mission(shipId: string): string | null;
  isRaiding(shipId: string): boolean;
  /** turretas prontas ou em obra na estrutura, e se há uma obra em curso nela */
  turrets(structId: string): number;
  turretInProgress(structId: string): boolean;
  /** toca aberta (plataforma e minas já detonadas) ou null; estação em tremores ("" = nenhuma) */
  hole(): { padId: string; seal: number } | null;
  quakeStation(): string;
  /** minhocas fora da toca, e a distância da cabeça mais perto de `p` (Infinity = nenhuma) */
  wormsOut(): number;
  wormDistance(p: WorldPos): number;
  wormKills(sid: string): number;
  /** estrutura em que o piloto espera a pé ("" = está numa nave) e [C] embarcar numa nave do hangar dela */
  waitingAt(sid: string): string;
  board(sid: string): void;
  /** o dono `owner` é um jogador (humano ou bot) da sala? — os outros são alvo das incursões */
  isPlayer(owner: string): boolean;
  log(msg: string): void;
}

export class PlayerBot {
  readonly sid: string;
  private host: PlayerBotHost;
  private cool = 0;
  private goal = "";
  /** rocha/plataforma escolhida para a próxima obra (fica até a obra sair) */
  private siteId = "";

  constructor(sid: string, host: PlayerBotHost) {
    this.sid = sid;
    this.host = host;
  }

  step(dt: number): void {
    this.cool = Math.max(0, this.cool - dt);
    this.manageFleet();
    const a = this.host.active(this.sid);
    if (!a) return this.recover();
    if (a.ship.kind !== "builder") {
      // embarcou noutra nave: troca ([C]) até o builder guardado no mesmo hangar
      const host = a.ship.hqId;
      if (a.ship.anchored && this.fleet().some(([, s]) => s.kind === "builder" && s.stored && s.hqId === host)) {
        this.act(() => this.host.board(this.sid), "trocar para o builder");
      }
      return;
    }
    if (a.ship.stored) return;
    this.planBuilder(a.ship);
  }

  /**
   * Sem nave (o builder foi destruído; o piloto chegou a pé de escape pod):
   * num QG, fabrica um builder novo e embarca nele; em outra estrutura,
   * embarca no que houver no hangar.
   */
  private recover(): void {
    const at = this.host.sim.structures.get(this.host.waitingAt(this.sid));
    if (!at) return;
    const here = this.fleet().filter(([, s]) => s.stored && s.hqId === at.id);
    if (here.some(([, s]) => s.kind === "builder") || (here.length > 0 && at.type !== "hq")) {
      this.act(() => this.host.board(this.sid), "embarcar");
      return;
    }
    if (at.type === "hq" && at.oreStore >= SHIP_PRODUCTION.builder.cost) this.act(() => this.host.produce(this.sid, "builder"), "produzir builder");
  }

  // ── o builder ───────────────────────────────────────────────────────

  private planBuilder(ship: ShipState): void {
    const quake = this.host.quakeStation();
    const own = (t: StructureType) => this.own().filter((s) => s.type === t);
    // a estação "de casa" é a da rocha; a de Ceres é só para acordar o ninho
    const station = own("miningStation").find((s) => !onCeres(s));
    const ceresStation = own("miningStation").find((s) => onCeres(s));
    const hq = own("hq")[0];
    const center = own("rationCenter")[0];
    const kits = ship.kits;
    const cost = (t: StructureType) => STRUCTURE_SPECS[t].cost;

    if (!station) {
      if (kits >= cost("miningStation")) return this.buildOn(ship, this.freeRock(), "buildmine", "estação de mineração");
      return this.mineRock(ship);
    }
    if (!hq) {
      if (kits >= cost("hq")) return this.buildOn(ship, this.freeRock(), "buildhq", "QG");
      return this.kitsAt(ship, station);
    }
    // conserto: a estrutura própria mais danificada (nunca a dos tremores)
    const hurt = this.own()
      .filter((s) => s.id !== quake && s.hp < structureMaxHp(s.type, s.level) * REPAIR_BELOW)
      .sort((a, b) => a.hp / structureMaxHp(a.type, a.level) - b.hp / structureMaxHp(b.type, b.level))[0];
    if (hurt && kits >= 10) {
      this.setGoal(`consertar ${hurt.type}`);
      if (this.dock(ship, hurt) && !this.host.isRepairing(hurt.id)) this.act(() => this.host.repair(this.sid), `conserto: ${hurt.type}`);
      return;
    }
    // naves: produz com o minério do QG; sem rota de minério, ele mesmo leva
    const want = this.nextProduction(!!center);
    if (want) {
      const price = SHIP_PRODUCTION[want].cost;
      if (hq.oreStore >= price && ship.anchored) this.act(() => this.host.produce(this.sid, want), `produzir ${want}`);
      else if (hq.oreStore < price && !this.hasRoute("ore")) return this.haulOre(ship, station, hq);
    }
    if (!center) {
      if (kits >= cost("rationCenter")) return this.buildOn(ship, this.freeRock(), "buildration", "central de rações");
      return this.kitsAt(ship, station);
    }
    // turretas em todas as bases (menos a estação de Ceres) — uma obra por vez
    if (kits >= TURRET_COST && !this.own().some((s) => this.host.turretInProgress(s.id))) {
      const bare = [hq, ...own("initialBase"), station, center]
        .find((s) => s.id !== quake && !onCeres(s) && this.host.turrets(s.id) < (TURRETS_WANTED[s.type] ?? 0));
      if (bare) {
        this.setGoal(`turreta em ${bare.type}`);
        if (this.dock(ship, bare)) this.act(() => this.host.turret(this.sid), `turreta: ${bare.type}`);
        return;
      }
    }
    // evolução da estação da rocha
    const up = stationUpgradeCost(station.level);
    if (up !== null && station.level < STATION_LEVEL_WANTED && kits >= up) {
      this.setGoal(`evoluir a estação ao nível ${station.level + 1}`);
      if (this.dock(ship, station)) this.act(() => this.host.upgrade(this.sid), `estação nível ${station.level + 1}`);
      return;
    }
    // evolução dos drones da central
    const lv = this.host.droneLevels(center.id);
    const track = DRONE_TRACKS.find((t) => lv[t] < DRONE_LEVEL_WANTED && kits >= (droneUpgradeCost(lv[t]) ?? Infinity));
    if (track) {
      this.setGoal(`drones: ${track}`);
      if (this.dock(ship, center)) this.act(() => this.host.droneUpgrade(this.sid, track), `drones ${track} nível ${lv[track] + 1}`);
      return;
    }
    // CERES: estação numa plataforma, evoluída ao nível 2 (acorda o ninho)
    if (!this.host.hole() && !quake) {
      if (!ceresStation) {
        if (kits >= cost("miningStation")) return this.buildOn(ship, this.freePad(), "buildmine", "estação em Ceres");
      } else if (ceresStation.level < WORM_WAKE_LEVEL && kits >= (stationUpgradeCost(ceresStation.level) ?? Infinity)) {
        this.setGoal("evoluir a estação de Ceres (acorda o ninho)");
        if (this.dock(ship, ceresStation)) this.act(() => this.host.upgrade(this.sid), "estação de Ceres nível 2");
        return;
      }
    }
    this.kitsAt(ship, station);
  }

  /** Sem estação: pousa numa rocha livre perto da base, minera e refina. */
  private mineRock(ship: ShipState): void {
    const rock = this.freeRock();
    if (!rock) return this.idle();
    this.setGoal("minerar numa rocha");
    if (!this.landOn(ship, rock)) return;
    if (!ship.anchored && holdRoom(ship, "ore") > 0) this.act(() => this.host.landAction(this.sid, "mine"));
    this.refineIfAble(ship);
  }

  /** Pousa no local (rocha ou plataforma de Ceres) e ergue a estrutura (`action`). */
  private buildOn(ship: ShipState, site: Site | null, action: string, label: string): void {
    if (!site) return this.idle();
    this.setGoal(`construir ${label}`);
    if (!this.landOn(ship, site)) return;
    this.act(() => {
      this.host.landAction(this.sid, action);
      this.siteId = ""; // a próxima obra escolhe outro local
    }, `obra: ${label}`);
  }

  /** Kits na estação: minera para o buffer, retira minério e refina. */
  private kitsAt(ship: ShipState, station: Structure): void {
    this.setGoal("juntar kits na estação");
    if (!this.dock(ship, station)) return;
    if (!ship.mining) this.act(() => this.host.landAction(this.sid, "stationmine"));
    const ore = ship.cargoKind === "ore" ? ship.cargoAmount : 0;
    if (ore < REFINE_ORE && station.oreStore >= REFINE_ORE && holdRoom(ship, "ore") > 0) {
      this.act(() => this.host.transfer(this.sid, "ore", "withdraw"));
    }
    this.refineIfAble(ship);
  }

  /** Leva minério da estação ao QG (até haver a rota de minério). */
  private haulOre(ship: ShipState, station: Structure, hq: Structure): void {
    this.setGoal("levar minério ao QG");
    const ore = ship.cargoKind === "ore" ? ship.cargoAmount : 0;
    const full = holdRoom(ship, "ore") <= 0 || (ore > 0 && station.oreStore < 1);
    if (ore < 1 || (!full && !(ship.anchored && ship.hqId === hq.id))) {
      // carregar na estação (minerando para o buffer enquanto isso)
      if (!this.dock(ship, station)) return;
      if (!ship.mining) this.act(() => this.host.landAction(this.sid, "stationmine"));
      if (station.oreStore >= 1 && holdRoom(ship, "ore") > 0) this.act(() => this.host.transfer(this.sid, "ore", "withdraw"));
      if (ore < 100) return;
    }
    if (!this.dock(ship, hq)) return;
    this.act(() => this.host.transfer(this.sid, "ore", "deposit"), "minério no QG");
  }

  /** O refino automático ([E]) fica ligado: cada lote entra sozinho quando há minério. */
  private refineIfAble(ship: ShipState): void {
    const id = this.host.active(this.sid)?.id;
    const ore = ship.cargoKind === "ore" ? ship.cargoAmount : 0;
    if (id && ore >= REFINE_ORE && !this.host.isAutoRefining(id)) this.act(() => this.host.refine(this.sid), "refino automático");
  }

  // ── navegação do builder (só pelas ações do jogador) ────────────────

  /** Chega e atraca numa vaga da estrutura. true = atracado nela. */
  private dock(ship: ShipState, st: Structure): boolean {
    if (ship.anchored && ship.hqId === st.id && ship.landingPhase === "") return true;
    if (!this.toCruise(ship)) return false;
    // sobre o prédio (o centro da rocha dele): a rocha mais próxima é a dele
    if (dist(ship, st) <= DOCK_RANGE * 0.6) {
      this.host.input(this.sid, NEUTRAL);
      this.act(() => this.host.anchor(this.sid));
      return false;
    }
    this.host.input(this.sid, seekInput(ship, st, { arriveRadius: DOCK_RANGE * 0.25 }));
    return false;
  }

  /**
   * Chega e pousa no centro do local. true = pousado nele. O [F] só vem com a
   * nave SOBRE ele (no cruzeiro dá para passar por cima): na borda, uma
   * rocha vizinha colada — a da estação, por exemplo — podia ser a "mais
   * próxima" e o pouso ia parar na vaga dela.
   */
  private landOn(ship: ShipState, site: Site): boolean {
    if (ship.landingPhase === "landed" && ship.anchoredAsteroidId === site.id) return true;
    if (!this.toCruise(ship)) return false;
    if (dist(ship, site) <= site.radius * 0.5) {
      this.host.input(this.sid, NEUTRAL);
      this.act(() => this.host.anchor(this.sid));
      return false;
    }
    this.host.input(this.sid, seekInput(ship, site, { arriveRadius: site.radius * 0.25 }));
    return false;
  }

  /**
   * Põe a nave voando em cruzeiro: pousada, para de minerar e decola; na
   * superfície, sobe. false enquanto isso acontece (inclusive as animações).
   */
  private toCruise(ship: ShipState): boolean {
    if (ship.landingPhase === "landing" || ship.landingPhase === "liftoff" || ship.layerTo) {
      this.host.input(this.sid, NEUTRAL);
      return false;
    }
    if (ship.landingPhase === "landed") {
      this.host.input(this.sid, NEUTRAL);
      if (ship.anchored) this.act(() => this.host.landAction(this.sid, "mine")); // para de minerar
      else this.act(() => this.host.anchor(this.sid)); // decola
      return false;
    }
    if (ship.anchored || ship.layer !== "cruise") {
      this.host.input(this.sid, NEUTRAL);
      this.act(() => this.host.anchor(this.sid));
      return false;
    }
    return true;
  }

  /** Rocha livre (sem estrutura de ninguém) mais perto da base inicial. Escolhida uma vez por obra. */
  private freeRock(): Site | null {
    const sim = this.host.sim;
    const from = this.home();
    if (!from) return null;
    const taken = new Set([...sim.structures.values()].map((s) => s.asteroidId));
    const rocks: Site[] = [];
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) rocks.push(...sectorAsteroids(sim.seed, from.sx + ox, from.sy + oy));
    }
    return this.pick(rocks.filter((r) => !taken.has(r.id)), from);
  }

  /** Plataforma de Ceres livre (sem estrutura, sem a toca) mais perto da base. */
  private freePad(): Site | null {
    const sim = this.host.sim;
    const from = this.home();
    if (!from) return null;
    const taken = new Set([...sim.structures.values()].map((s) => s.asteroidId));
    const hole = this.host.hole()?.padId;
    const pads = ceresPlatforms(sim.seed)
      .filter((p) => !taken.has(p.id) && p.id !== hole)
      .map((p) => ({ ...ceresPlatformPos(sim.seed, p), id: p.id, radius: p.radius }));
    return this.pick(pads, from);
  }

  /** O local escolhido para a obra em curso, ou o mais perto de `from`. */
  private pick(sites: Site[], from: WorldPos): Site | null {
    const kept = sites.find((s) => s.id === this.siteId);
    if (kept) return kept;
    let best: Site | null = null;
    let bd = Infinity;
    for (const s of sites) {
      const d = dist(from, s);
      if (d < bd) { bd = d; best = s; }
    }
    this.siteId = best?.id ?? "";
    return best;
  }

  private home(): WorldPos | undefined {
    return this.own().find((s) => s.type === "initialBase") ?? this.host.active(this.sid)?.ship;
  }

  // ── a frota ─────────────────────────────────────────────────────────

  /**
   * Ordens de logística (o que o jogador faz uma vez e o jogo automatiza):
   * transportes nas rotas e naves de mineração virando aranhas. As naves de
   * ATAQUE não são dele — agem sozinhas (AttackWing).
   */
  private manageFleet(): void {
    const own = this.own();
    const station = own.find((s) => s.type === "miningStation" && !onCeres(s));
    const hq = own.find((s) => s.type === "hq");
    const base = own.find((s) => s.type === "initialBase");
    const center = own.find((s) => s.type === "rationCenter");
    const fleet = this.fleet();

    // transportes livres → rota de minério (estação → QG), depois a de rações (base → central)
    for (const [id] of fleet.filter(([fid, s]) => s.kind === "transport" && !this.host.freighterMode(fid))) {
      if (station && hq && !this.hasRoute("ore")) {
        if (this.host.startFreighter(id, "ore", station.id, hq.id)) this.host.log(`${this.sid}: transporte ${id} na rota de minério`);
      } else if (base && center && !this.hasRoute("rations")) {
        if (this.host.startFreighter(id, "rations", base.id, center.id)) this.host.log(`${this.sid}: transporte ${id} na rota de rações`);
      }
    }
    // naves de mineração livres → aranhas da estação
    if (station) {
      for (const [id] of fleet.filter(([fid, s]) => s.kind === "mining" && !this.host.isBusyMiner(fid))) {
        if (this.host.sendSpider(id, station.id)) this.host.log(`${this.sid}: nave de mineração ${id} vai virar aranha`);
      }
    }
  }

  /**
   * Próxima nave a fabricar: o transporte de minério, as de ataque, uma de
   * mineração (aranha) e, com a central, o transporte de rações.
   */
  private nextProduction(hasCenter: boolean): "transport" | "attack" | "mining" | null {
    const fleet = this.fleet();
    const count = (k: string) => fleet.filter(([, s]) => s.kind === k).length;
    if (count("transport") < 1) return "transport";
    if (count("attack") < PLAYER_BOT_RAID_SIZE) return "attack";
    if (count("mining") < 1) return "mining";
    if (hasCenter && count("transport") < 2) return "transport";
    return null;
  }

  private hasRoute(mode: "ore" | "rations"): boolean {
    return this.fleet().some(([id]) => this.host.freighterMode(id) === mode);
  }

  // ── utilidades ──────────────────────────────────────────────────────

  private own(): Structure[] {
    return [...this.host.sim.structures.values()].filter((s) => s.owner === this.sid);
  }

  private fleet(): Array<[string, ShipState]> {
    return [...this.host.sim.ships].filter(([, s]) => s.owner === this.sid);
  }

  /** Uma ação "de tecla", no máximo uma a cada ACTION_GAP. */
  private act(fn: () => void, label?: string): void {
    if (this.cool > 0) return;
    this.cool = ACTION_GAP;
    fn();
    if (label) this.host.log(`${this.sid}: ${label}`);
  }

  private setGoal(goal: string): void {
    if (goal === this.goal) return;
    this.goal = goal;
    this.host.log(`${this.sid}: objetivo → ${goal}`);
  }

  private idle(): void {
    this.host.input(this.sid, NEUTRAL);
  }
}

/**
 * ALA DE ATAQUE de um jogador-bot: as naves de ataque dele agem SOZINHAS —
 * ninguém as pilota. A sala chama step() a cada passo; prontas no QG
 * (recarregadas), elas decidem a missão, nesta ordem: DEFENDER uma estrutura
 * atacada, tapar a toca, caçar a minhoca e, em segundo plano, atacar o
 * vizinho mais próximo (estrutura ou nave inimiga, o que estiver mais perto).
 */
export class AttackWing {
  readonly sid: string;
  private host: PlayerBotHost;
  private nextRaidAt = 0;
  /** quando a toca abriu (s de partida; −1 = fechada) */
  private holeSince = -1;

  constructor(sid: string, host: PlayerBotHost) {
    this.sid = sid;
    this.host = host;
  }

  step(): void {
    const hq = [...this.host.sim.structures.values()].find((s) => s.owner === this.sid && s.type === "hq");
    const fleet = [...this.host.sim.ships].filter(([, s]) => s.owner === this.sid);
    const now = this.host.elapsed();
    if (!hq) return;
    // minhoca rondando o QG: decolar dali é ser engolido — as naves esperam no hangar
    if (this.host.wormDistance(hq) < PLAYER_BOT_WORM_CLEARANCE) return;
    const ready = fleet.filter(([id, s]) =>
      s.kind === "attack" && !this.host.isRaiding(id) && s.hqId === hq.id && (s.stored || s.anchored) && s.ammo > 0);

    // 1. DEFESA: inimigos atacando uma estrutura nossa — o mais perto do QG primeiro
    const threats = this.host.threats(this.sid)
      .map((t) => ({ ...t, d: dist(hq, this.host.sim.ships.get(t.shipId)!) }))
      .sort((a, b) => a.d - b.d);
    if (threats.length > 0 && ready.length > 0 && !fleet.some(([id]) => this.host.mission(id) === "defend")) {
      const t = threats[0];
      const ids = ready.slice(0, PLAYER_BOT_RAID_SIZE).map(([id]) => id);
      this.host.launchMission(this.sid, ids, "defend", 60, t.shipId, t.structId);
      this.host.log(`${this.sid}: ${ids.length} naves defendendo ${t.structId} de ${t.shipId}`);
      return;
    }

    // a TOCA: tapa depois de matar uma minhoca, ou se ela está aberta há muito
    const hole = this.host.hole();
    if (!hole) this.holeSince = -1;
    else if (this.holeSince < 0) this.holeSince = now;
    const sealing = fleet.some(([id]) => this.host.mission(id) === "seal");
    // só com a minhoca dentro da toca (descansando): fora, ela engole quem chega
    if (hole && !sealing && this.host.wormsOut() === 0 && (this.host.wormKills(this.sid) > 0 || now - this.holeSince >= PLAYER_BOT_SEAL_AFTER)) {
      const sealer = ready.find(([, s]) => s.grenadeAmmo >= WORM_HOLE_SEAL_MINES - hole.seal && s.ammo >= 2);
      if (sealer) {
        this.host.launchMission(this.sid, [sealer[0]], "seal", 120);
        this.host.log(`${this.sid}: ${sealer[0]} vai tapar a toca`);
        return;
      }
    }
    // a MINHOCA fora da toca: as naves prontas vão caçá-la
    if (this.host.wormsOut() > 0 && ready.length >= 2 && !fleet.some(([id]) => this.host.mission(id) === "worm")) {
      const ids = ready.slice(0, PLAYER_BOT_RAID_SIZE).map(([id]) => id);
      this.host.launchMission(this.sid, ids, "worm", 60);
      this.host.log(`${this.sid}: ${ids.length} naves caçando a minhoca`);
      return;
    }

    // 2º plano — o vizinho mais próximo: a estrutura inimiga (INCURSÃO) ou,
    // se estiver mais perto, a nave inimiga em voo (CAÇA)
    if (now < this.nextRaidAt || ready.length < PLAYER_BOT_RAID_SIZE) return;
    const target = this.enemyTarget(hq);
    const ship = this.host.nearestEnemyShip(this.sid, hq);
    const ids = ready.slice(0, PLAYER_BOT_RAID_SIZE).map(([id]) => id);
    if (ship && (!target || ship.dist < dist(hq, target))) {
      this.nextRaidAt = now + PLAYER_BOT_RAID_COOLDOWN;
      this.host.launchMission(this.sid, ids, "hunt", PLAYER_BOT_RAID_TIME, ship.id);
      this.host.log(`${this.sid}: ${ids.length} naves caçando a nave inimiga ${ship.id}`);
      return;
    }
    if (!target) return;
    this.nextRaidAt = now + PLAYER_BOT_RAID_COOLDOWN;
    this.host.launchRaid(this.sid, ids, target.id, PLAYER_BOT_RAID_TIME);
    this.host.log(`${this.sid}: incursão de ${ids.length} naves contra ${target.type} ${target.id} (${target.owner})`);
  }

  /** Estrutura de OUTRO jogador (humano ou jogador-bot) mais perto do QG. */
  private enemyTarget(from: WorldPos): Structure | null {
    let best: Structure | null = null;
    let bd = Infinity;
    for (const st of this.host.sim.structures.values()) {
      if (st.owner === this.sid || st.owner === RUIN_OWNER || !this.host.isPlayer(st.owner)) continue;
      const d = dist(from, st);
      if (d < bd) { bd = d; best = st; }
    }
    return best;
  }
}

/** Estrutura numa plataforma de Ceres? */
function onCeres(s: Structure): boolean {
  return s.asteroidId.startsWith(CERES_PLATFORM_PREFIX);
}
