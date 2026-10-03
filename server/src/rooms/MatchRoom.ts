import { Room, updateLobby, type Client } from "../colyseus";
import {
  MSG_INPUT,
  MSG_ALERT,
  type AlertEvent,
  MSG_BUILD,
  MSG_PRODUCE,
  MSG_ANCHOR,
  MSG_SWAP,
  MSG_AUTOMINE,
  MSG_TAXI,
  MSG_LAND_ACTION,
  // MSG_EXPAND,
  MSG_CARGO,
  MSG_FIRE,
  MSG_WEAPON,
  MSG_FX,
  MSG_UPGRADE,
  MSG_TURRET,
  MSG_RESTART,
  RUIN_OWNER,
  TICK_RATE,
  SIM_MAX_DT,
  SECTOR_SIZE,
  STRUCTURE_SPECS,
  SHIP_PRODUCTION,
  HQ_SHIP_BAYS,
  HQ_EXPANDED_BAYS,
  STATION_SHIP_BAYS,
  STATION_EXPANDED_BAYS,
  STATION_SPIDER_BAYS,
  BASE_SHIP_BAYS,
  BASE_EXPANDED_BAYS,
  CERES_STATION_MAX_LEVEL,
  CERES_STATION_SPIDER_BAYS_PER_LEVEL,
  structureMaxHp,
  LAND_DURATION,
  WORM_HEAD_RADIUS,
  DEFAULT_TIME_LIMIT,
  DEFAULT_VICTORY,
  SCORE_POINTS,
  VICTORY_MODES,
  isTimedMode,
  type VictoryMode,
  WORM_RAM_DAMAGE,
  WORM_RAM_RETREAT,
  WORM_QUAKE_BREACH_TIME,
  WORM_QUAKE_DANGER_TIME,
  WORM_QUAKE_WARN_TIME,
  WORM_REVENGE_MEMORY,
  WORM_SIEGE_TIME,
  WORM_BODY_COOLDOWN,
  WORM_BODY_DAMAGE,
  WORM_HOLE_ID,
  WORM_HOLE_RADIUS,
  WORM_HOLE_SEAL_MINES,
  WORM_WAKE_LEVEL,
  WORM_DEN_TIME,
  WORM_ROAM_TIME,
  WORM_MAX,
  WORM_MOUTH_RADIUS,
  WORM_SENSE_RANGE,
  WORM_SPAWN_INTERVAL,
  WORM_SPACING,
  WORM_SPEED,
  wormRadiusAt,
  REPAIR_HP_PER_KIT,
  REPAIR_RATE,
  SHIP_HP_MAX,
  stationOreCap,
  RATION_STORE_CAP,
  RATION_CENTER_SHIP_BAYS,
  RATION_CENTER_EXPANDED_BAYS,
  TRANSPORT_CARGO_CAP,
  DOCK_RANGE,
  BUILD_ASTEROID_RANGE,
  MINING_RATE_BY_KIND,
  WEAPON_KINDS,
  MISSILE_SPEED,
  MISSILE_RANGE,
  MISSILE_RADIUS,
  MISSILE_DAMAGE,
  MISSILE_COOLDOWN,
  MISSILE_AMMO_MAX,
  LASER_RANGE,
  LASER_DAMAGE,
  LASER_COOLDOWN,
  LASER_LOCK_TOLERANCE,
  LASER_SLEWS,
  laserMount,
  MINE_SPEED,
  MINE_MAX_DISTANCE,
  MINE_TRIGGER_RADIUS,
  MINE_BLAST_RADIUS,
  MINE_DAMAGE,
  MINE_COOLDOWN,
  MINE_AMMO_MAX,
  MINE_LIFETIME,
  gimbalOf,
  slewAim,
  TURRET_MAX,
  TURRET_COST,
  TURRET_BUILD_TIME,
  TURRET_RANGE,
  TURRET_DAMAGE,
  TURRET_COOLDOWN,
  holdRoom,
  REFINE_ORE,
  STARTING_KITS,
  DRILL_BASE_RATE,
  DRILL_CYCLE_ORE,
  STRUCTURE_ORE_CAP,
  STRUCTURE_KIT_CAP,
  stationUpgradeCost,
  MSG_TRANSFER,
  type TransferCommand,
  REFINE_KITS,
  REFINE_TIME,
  STRUCTURE_START_RATIONS,
  RATIONS_PER_MINING_CYCLE,
  RATIONS_PER_SHIP,
  DRONE_TRACKS,
  DRONE_HP,
  DRONE_RADIUS,
  DRONE_REBUILD_TIME,
  droneStats,
  droneUpgradeCost,
  MSG_DRONE_UPGRADE,
  type DroneTrack,
  type DroneUpgradeCommand,
  turretWorldPos,
  ATTACK_ZONE_MARGIN,
  CERES_RADIUS,
  SHIP_RADIUS,
  bayWorldPos,
  ceresPlatforms,
  ceresPlatformPos,
  CERES_PLATFORM_PREFIX,
  type AsteroidClass,
  type CeresPlatform,
  asteroidClassOf,
  mulberry32,
  asteroidSpinRate,
  ceresPosition,
  relVec,
  dist,
  normalizePos,
  type ShipInput,
  type ShipKind,
  type StructureType,
  type ProducibleKind,
  type BuildCommand,
  type ProduceCommand,
  type TaxiCommand,
  type LandActionCommand,
  type WeaponCommand,
  type WeaponKind,
  type FxEvent,
  type FxKind,
  type WorldPos,
} from "@ceres/shared";
import {
  SimWorld,
  attackModeInput,
  faceInput,
  seekInput,
  findClearSpawn,
  sectorAsteroids,
  wormBodyAt,
  beginLayerChange,
  setLayer,
  type Asteroid,
  type ShipState,
  type Structure,
} from "@ceres/sim-core";
import { MatchState, ShipSchema, StructureSchema, PlayerSchema, ProjectileSchema, DroneSchema, WormSchema } from "../schema/State";
import { makeWorm, moveWorm, type Worm } from "../worms";
import { PlayerBot, type PlayerBotHost } from "../playerBot";
import {
  canFire,
  collisionDamage,
  desiredOffset,
  hittableLevel,
  levelOfLayer,
  pickTarget,
  splitDamage,
  type AimTarget,
  type CombatLevel,
} from "../combat";
import { mapSpawns, type SpawnStrategy } from "../spawn";
import {
  BOT_AIM_TOLERANCE,
  BOT_AMMO,
  BOT_BUILD_INTERVAL,
  BOT_FIRE_INTERVAL,
  BOT_FLEET_MAX,
  BOT_OWNER,
  BOT_RELOAD_TIME,
  BOT_REPAIR_TIME,
  BOT_WAVE_SIZE,
  computeBotInput,
  computeTaxiInput,
  makeBotState,
  type BotState,
} from "../bots";
import { makeSpiderState, stepSpider, type SpiderState } from "../spiders";

/**
 * Projétil em voo — míssil ou mina; `level` é o nível de combate em que foi
 * disparado (combat.ts). A mina guarda o ponto de lançamento (`origin`):
 * para a MINE_MAX_DISTANCE dele, ou antes, no asteroide em que bater, e
 * então ARMA; `age` conta o tempo desde que armou.
 */
interface Projectile {
  kind: "missile" | "mine";
  owner: string;
  level: CombatLevel;
  sx: number; sy: number; x: number; y: number;
  vx: number; vy: number;
  traveled: number;
  origin?: WorldPos;
  armed?: boolean;
  age?: number;
  /** mina parada dentro do buraco da toca das minhocas */
  inHole?: boolean;
  /** id da nave que disparou (a minhoca se vinga dela) */
  shooter?: string;
}

/**
 * Estado do armamento de uma nave de ataque: arma selecionada e a mira do
 * computador de tiro (desvio em volta do nariz, alvo, travada).
 */
interface WeaponState {
  weapon: WeaponKind;
  /** mira do míssil, ou do 1º canhão do laser */
  offset: number;
  target: string;
  locked: boolean;
  /** 2º canhão do laser: mira e travamento próprios */
  offset2: number;
  locked2: boolean;
}

/** Rota de um transporte em entrega automática. */
interface Freighter {
  mode: "ore" | "rations";
  /** onde carrega (estação de mineração ou base inicial) e para onde leva */
  pickup: string;
  dest: string;
  leg: "load" | "out" | "back";
}

/** Prefixo dos alvos de mira que são drones (o resto são naves e estruturas). */
const DRONE_PREFIX = "drone:";
/** alvo de mira numa minhoca: "worm:<id>:<gomo>" */
const WORM_PREFIX = "worm:";
/** alvo de mira numa mina dentro da toca: "mine:<id do projétil>" */
const MINE_PREFIX = "mine:";
/** bot caçando a minhoca: distância em que para de chegar perto e atira (u) */
const BOT_WORM_STANDOFF = 7000;
/** cabeça da minhoca mais perto que isto: o bot recua (u) */
const BOT_WORM_FLEE = 6000;

/** Drone de ração (logistics.ts). "home" = guardado na central. */
interface Drone extends WorldPos {
  id: string;
  owner: string;
  center: string;
  angle: number;
  phase: "home" | "out" | "back";
  target: string;
  cargo: number;
  hp: number;
}

/** O que o jogador fez na partida (tela de fim de jogo). */
interface PlayerStats {
  joinedAt: number;
  built: Partial<Record<StructureType, number>>;
  produced: Partial<Record<ProducibleKind, number>>;
  turrets: number;
}
const freshStats = (now: number): PlayerStats => ({ joinedAt: now, built: {}, produced: {}, turrets: 0 });

/** Frota máxima de bots por padrão (QG dos bots em Ceres; 0 = sem bots). */
const DEFAULT_BOTS = BOT_FLEET_MAX;

export interface MatchOptions {
  maxPlayers?: number;
  worldSeed?: number;
  spawnStrategy?: SpawnStrategy;
  mapSize?: string;
  bots?: number;
  /** título exibido no lobby (definido por quem cria a sala) */
  title?: string;
  /** nome de jogador de quem entra (usado no onJoin) */
  name?: string;
  /** JOGADORES-BOT (playerBot.ts): quantos entram na sala ao ser criada — para teste */
  playerBots?: number;
  /** modo de teste: multiplica mineração, broca e refino (1 = normal) */
  testSpeed?: number;
  /** modo de vitória (shared/match.ts) e o tempo-limite em minutos (modos com tempo) */
  victory?: VictoryMode;
  timeLimit?: number;
}

/** Sanitiza um texto livre vindo do cliente (nome/título) para exibição. */
function sanitizeLabel(raw: unknown, fallback: string, max: number): string {
  if (typeof raw !== "string") return fallback;
  const clean = Array.from(raw)
    .filter((ch) => { const c = ch.codePointAt(0); return c !== undefined && c >= 0x20 && c !== 0x7f; })
    .join("").trim().slice(0, max);
  return clean.length > 0 ? clean : fallback;
}

/**
 * Sala do modo partida (início/fim). O SimWorld é a autoridade; o schema
 * Colyseus é só o espelho sincronizado para os clientes.
 */
export class MatchRoom extends Room<MatchState> {
  private sim!: SimWorld;
  private spawns: ReturnType<typeof mapSpawns> = [];
  private spawnIndex = 0;
  private bots = new Map<string, BotState>();
  /** QG dos bots em Ceres ("" = não há, ou foi destruído), a frota máxima e o relógio da produção */
  private botHqId = "";
  private botFleetMax = 0;
  private botBuildTimer = BOT_BUILD_INTERVAL;
  private botSeq = 0;
  private structSeq = 0;
  private shipSeq = 0;
  /** nave que cada jogador pilota (sessionId → shipId) */
  private activeShip = new Map<string, string>();
  /** estado das aranhas mineradoras (shipId → SpiderState) */
  private spiders = new Map<string, SpiderState>();
  /**
   * Centro da arena (para expandir a fronteira). Não é `private` de propósito:
   * o único leitor é o `expandMap()` desativado logo abaixo, guardado para a
   * configuração na criação da sala — e `noUnusedLocals` reprova campo privado
   * que ninguém lê.
   */
  arenaCenter = { sx: 0, sy: 0, x: 0, y: 0 };
  /** tempo total acumulado (s) — usado para calcular ângulo atual dos asteroides */
  private elapsed = 0;
  /** projéteis ativos (id → estado) */
  private projSeq = 0;
  /**
   * Transportes em ENTREGA AUTOMÁTICA (id da nave → rota): minério da estação
   * de mineração para a base inicial, ou rações da base para a central.
   */
  private freighters = new Map<string, Freighter>();
  /** piloto esperando numa estrutura, SEM nave (sessionId → id da estrutura) */
  private waitingAt = new Map<string, string>();
  /** o que cada jogador fez na partida (tela de fim de jogo) */
  private stats = new Map<string, PlayerStats>();
  /** turretas prontas por estrutura (id → quantidade) */
  private turrets = new Map<string, number>();
  /** obra de turreta em curso por estrutura: o builder travado e o progresso (0..1) */
  private turretJobs = new Map<string, { shipId: string; progress: number }>();
  /** recarga de cada turreta, por estrutura (s até o próximo tiro) */
  private turretCooldowns = new Map<string, number[]>();
  /** armamento por nave de ataque (id da nave → estado; criado sob demanda) */
  private weapons = new Map<string, WeaponState>();
  /** último comando CRU de cada nave de jogador (o modo ataque o traduz a cada tick) */
  private rawInputs = new Map<string, ShipInput>();
  private projectiles = new Map<string, Projectile>();
  /**
   * Sorteios do combate (divisão do dano entre estação e hangar), semeados
   * pela semente do mundo: a partida continua reproduzível.
   */
  private combatRng: () => number = Math.random;
  /** timer por centro de distribuição (structId → segundos até próximo drone) */
  /** refinaria de bordo de cada builder: lotes na fila e tempo do lote atual */
  private refine = new Map<string, { queue: number; t: number }>();
  /** minério escavado pela broca de cada estação desde o último ciclo de rações */
  private drillCycle = new Map<string, number>();
  /** consertos em andamento: estrutura → builder que conserta e o HP já pago em kits */
  private repairJobs = new Map<string, { shipId: string; credit: number; claim?: string }>();
  /** minhocas gigantes vivas (shared/worms.ts) */
  private worms = new Map<string, Worm>();
  private wormSeq = 0;
  /** TOCA aberta do ninho de Ceres (null = ninho dormindo ou toca tapada) e s até a próxima minhoca */
  private hole: { padId: string; pos: WorldPos; radius: number; seal: number } | null = null;
  /** tremores em curso: a estação de Ceres que chegou ao nível 2, o dono e os s desde então */
  private quake: { stationId: string; padId: string; owner: string; t: number } | null = null;
  private nestTimer = 0;
  /** naves que bateram no corpo de uma minhoca: s até poder tomar dano de novo */
  private wormBodyHits = new Map<string, number>();
  /** drones de ração em voo / em casa, e as melhorias e reposições de cada central */
  private drones = new Map<string, Drone>();
  private droneSeq = 0;
  private droneUpgrades = new Map<string, Record<DroneTrack, number>>();
  private droneRebuild = new Map<string, number>();
  /**
   * Naves em modo ataque (ou descendo para ele) → a estação atacada e o raio
   * do asteroide dela: a zona fora da qual a nave sobe sozinha ao cruzeiro.
   */
  private attackTargets = new Map<string, { structId: string; radius: number }>();
  /** modo de teste (MatchOptions.testSpeed): multiplica mineração, broca e refino */
  private testSpeed = 1;
  /** jogadores-bot da sala (playerBot.ts) */
  private playerBots: PlayerBot[] = [];
  /** naves de ataque de jogador-bot em incursão: estado de pilotagem, alvo, prazo e o QG de volta */
  private raiders = new Map<string, { bot: BotState; target: string; until: number; home: string; kind: "raid" | "worm" | "seal" }>();
  /** naves de mineração do jogador-bot a caminho de virar aranha: nave → estação */
  private ferries = new Map<string, string>();

  onCreate(options: MatchOptions = {}) {
    this.maxClients = options.maxPlayers ?? 12;
    const botCount = Math.max(0, Math.min(HQ_SHIP_BAYS, options.bots ?? DEFAULT_BOTS));
    const radiusSectors = options.mapSize === "large" ? 50
      : options.mapSize === "medium" ? 20 : 8;
    const seed = options.worldSeed ?? (Math.random() * 0xffffffff) >>> 0;

    this.sim = new SimWorld(seed);
    this.combatRng = mulberry32((seed ^ 0x5eedc0b7) >>> 0);
    // spawns em setores distintos do cinturão dentro da arena do mapa
    this.spawns = mapSpawns(seed, radiusSectors, this.maxClients);

    // fronteira circular: centrada em Ceres, raio pelo tamanho do mapa
    const base = ceresPosition(seed);
    const center = { sx: base.sx, sy: base.sy, x: SECTOR_SIZE / 2, y: SECTOR_SIZE / 2 };
    const radiusUnits = radiusSectors * SECTOR_SIZE;
    this.arenaCenter = center;
    this.sim.setBoundary(center, radiusUnits);

    this.setState(new MatchState());
    this.state.worldSeed = seed;
    this.state.mapCenterSx = base.sx;
    this.state.mapCenterSy = base.sy;
    this.state.mapRadius = radiusUnits;

    // QG dos bots numa plataforma de Ceres: produz a frota (ver bots.ts)
    this.botFleetMax = botCount;
    if (botCount > 0) this.createBotHq();
    // modo de teste e jogadores-bot
    this.testSpeed = Math.max(1, Math.min(10, options.testSpeed ?? 1));
    this.state.speed = this.testSpeed;
    // modo de vitória e tempo-limite
    const victory = VICTORY_MODES.some((m) => m.id === options.victory) ? options.victory! : DEFAULT_VICTORY;
    this.state.victory = victory;
    this.state.timeLimit = isTimedMode(victory) ? Math.max(1, Math.min(120, options.timeLimit ?? DEFAULT_TIME_LIMIT)) * 60 : 0;
    this.sim.miningSpeed = this.testSpeed;
    const pbots = Math.max(0, Math.min(4, options.playerBots ?? 0));
    for (let i = 0; i < pbots; i++) {
      const sid = `pbot-${i + 1}`;
      this.addPlayer(sid, `Bot ${i + 1}`);
      this.state.players.get(sid)!.bot = true;
      this.playerBots.push(new PlayerBot(sid, this.botHost()));
    }

    this.onMessage(MSG_INPUT, (client: Client, input: ShipInput) => {
      const active = this.activeShip.get(client.sessionId);
      // no escape pod quem pilota é o piloto automático
      if (active && this.sim.ships.get(active)?.kind === "pod") return;
      if (active) {
        this.rawInputs.set(active, input);
        this.sim.setInput(active, input);
      }
    });

    this.onMessage(MSG_BUILD, (client: Client, cmd: BuildCommand) => {
      this.tryBuild(client.sessionId, cmd?.type);
    });

    this.onMessage(MSG_PRODUCE, (client: Client, cmd: ProduceCommand) => {
      this.tryProduce(client.sessionId, cmd?.kind);
    });

    this.onMessage(MSG_ANCHOR, (client: Client) => {
      this.tryToggleAnchor(client.sessionId);
    });

    this.onMessage(MSG_SWAP, (client: Client) => {
      this.trySwap(client.sessionId);
    });

    this.onMessage(MSG_AUTOMINE, (client: Client) => {
      this.tryAutoMine(client.sessionId);
    });

    this.onMessage(MSG_TAXI, (client: Client, cmd: TaxiCommand) => {
      this.tryTaxi(client.sessionId, cmd?.shipId);
    });

    this.onMessage(MSG_LAND_ACTION, (client: Client, cmd: LandActionCommand) => {
      this.tryLandAction(client.sessionId, cmd?.action);
    });

    // this.onMessage(MSG_EXPAND, () => this.expandMap());

    this.onMessage(MSG_CARGO, (client: Client) => {
      this.tryCargo(client.sessionId);
    });

    this.onMessage(MSG_FIRE, (client: Client) => {
      this.tryFire(client.sessionId);
    });

    this.onMessage(MSG_WEAPON, (client: Client, cmd: WeaponCommand) => {
      this.trySelectWeapon(client.sessionId, cmd?.weapon);
    });

    this.onMessage(MSG_UPGRADE, (client: Client) => {
      this.tryUpgrade(client.sessionId);
    });

    this.onMessage(MSG_TURRET, (client: Client) => {
      this.tryBuildTurret(client.sessionId);
    });

    this.onMessage(MSG_RESTART, (client: Client) => {
      this.restartPlayer(client.sessionId);
    });

    this.onMessage(MSG_TRANSFER, (client: Client, cmd: TransferCommand) => {
      this.tryTransfer(client.sessionId, cmd?.item, cmd?.dir);
    });

    this.onMessage(MSG_DRONE_UPGRADE, (client: Client, cmd: DroneUpgradeCommand) => {
      this.tryDroneUpgrade(client.sessionId, cmd?.track);
    });

    // metadata exibida na lista do lobby (título da sala)
    void this.setMetadata({
      title: sanitizeLabel(options.title, `Arena ${seed.toString(16).slice(0, 4)}`, 24),
    });

    // dt CLAMPADO em SIM_MAX_DT, exatamente como o render loop do cliente
    // (main.ts). O servidor usava o deltaMs cru: um engasgo de tick (GC, IO,
    // instância dormindo no PaaS gratuito) entregava dt = 1 s ou mais à física
    // e ressuscitava o tunelamento — 22,8% da seção de choque atravessando a
    // rocha a dt = 1 s, 100% a dt = 3 s — além de fazer servidor e cliente
    // integrarem com h diferentes e dessincronizarem justo no frame ruim.
    this.setSimulationInterval(
      (deltaMs) => this.tick(Math.min(deltaMs / 1000, SIM_MAX_DT)),
      1000 / TICK_RATE,
    );
    console.log(
      `[room] match criada — seed=${seed} raio=${radiusSectors}s ` +
      `maxPlayers=${this.maxClients} bots=${botCount}`,
    );
  }

  onJoin(client: Client, options: MatchOptions = {}) {
    this.addPlayer(client.sessionId, sanitizeLabel(options.name, "Piloto", 20));
    // atualiza a contagem de jogadores exibida no lobby
    void updateLobby(this);
  }

  /** Um jogador entra (humano no onJoin, ou jogador-bot): builder com kits e a base inicial. */
  private addPlayer(sessionId: string, name: string): void {
    const client = { sessionId };
    const base = this.spawns[this.spawnIndex++ % this.spawns.length];
    const id = `p${this.shipSeq++}`;
    const ship = this.spawnShip(id, base, client.sessionId, "builder"); // default: builder
    this.activeShip.set(client.sessionId, id);
    // espelha a posição de spawn JÁ no join — o primeiro estado que o
    // cliente recebe precisa ser real, não os defaults do schema
    this.state.ships.set(id, this.mirrorSpawn(ship));
    const p = new PlayerSchema();
    p.activeShip = id;
    p.name = name;
    this.state.players.set(client.sessionId, p);
    ship.kits = STARTING_KITS; // não há carteira: o jogador começa com kits a bordo
    this.stats.set(client.sessionId, freshStats(this.elapsed));
    // o jogador RECEBE a Base Inicial no asteroide livre mais próximo do spawn
    this.grantInitialBase(client.sessionId, ship);
    console.log(`[room] ${p.name} (${client.sessionId}) entrou — nave ${id} setor (${ship.sx}, ${ship.sy})`);
  }

  /**
   * Concede a Base Inicial do jogador no asteroide livre mais próximo do
   * ponto de spawn. Ela liga o jogador à Terra: recebe rações (fluxo
   * contínuo) e recebe minério dos transportes (creditando a carteira).
   */
  private grantInitialBase(sessionId: string, spawn: { sx: number; sy: number; x: number; y: number }): void {
    const occupied = new Set(
      [...this.sim.structures.values()].map((s) => s.asteroidId),
    );
    let best: ReturnType<typeof this.sim.nearestAsteroid> = null;
    let bd = Infinity;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        for (const a of sectorAsteroids(this.sim.seed, spawn.sx + ox, spawn.sy + oy)) {
          if (occupied.has(a.id)) continue;
          const { dx, dy } = relVec(spawn, a);
          const d = Math.hypot(dx, dy) - a.radius;
          if (d < bd) {
            bd = d;
            best = a;
          }
        }
      }
    }
    if (!best) {
      console.log(`[room] ${sessionId} sem asteroide livre por perto — base inicial não concedida`);
      return;
    }

    const { dx, dy } = relVec(best, spawn);
    const angle = Math.atan2(dy, dx);
    const cls = asteroidClassOf(best.radius);
    const id = `st-${this.structSeq++}`;
    this.sim.addStructure({
      id, type: "initialBase", owner: sessionId,
      sx: best.sx, sy: best.sy, x: best.x, y: best.y,
      angle, asteroidId: best.id, asteroidClass: cls,
      shipBays: BASE_SHIP_BAYS, expandedBays: BASE_EXPANDED_BAYS,
      spiderBays: 0, nextShipBay: 0, nextSpiderBay: 0,
      oreStore: 0, rationStore: 0,
    });
    const ss = new StructureSchema();
    ss.stype = "initialBase"; ss.owner = sessionId;
    ss.sx = best.sx; ss.sy = best.sy; ss.x = best.x; ss.y = best.y;
    ss.angle = angle; ss.asteroidId = best.id; ss.asteroidClass = cls;
    ss.shipBays = BASE_SHIP_BAYS; ss.expandedBays = BASE_EXPANDED_BAYS;
    ss.spiderBays = 0; ss.nextShipBay = 0; ss.nextSpiderBay = 0;
    this.state.structures.set(id, ss);
    console.log(`[room] base inicial de ${sessionId} concedida em ${best.id} (${cls})`);
  }

  onLeave(client: Client) {
    // remove a frota inteira do jogador (nave ativa + hangar + produzidas)
    for (const [id, ship] of [...this.sim.ships]) {
      if (ship.owner === client.sessionId) {
        this.sim.removeShip(id);
        this.bots.delete(id);
        this.state.ships.delete(id);
      }
    }
    this.activeShip.delete(client.sessionId);
    this.waitingAt.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
    // atualiza a contagem de jogadores exibida no lobby
    void updateLobby(this);
    console.log(`[room] ${client.sessionId} saiu`);
  }

  private activeShipOf(sessionId: string): ShipState | undefined {
    const id = this.activeShip.get(sessionId);
    return id ? this.sim.ships.get(id) : undefined;
  }

  /** Cria uma nave no sim num ponto livre dentro do setor de spawn dado. */
  private spawnShip(
    id: string,
    base: { sx: number; sy: number },
    owner = "",
    kind: ShipState["kind"] = "builder",
  ): ShipState {
    const local = findClearSpawn(this.sim.seed, base.sx, base.sy);
    return this.sim.addShip(id, { sx: base.sx, sy: base.sy, x: local.x, y: local.y }, owner, kind);
  }

  /** Velocidade angular de um asteroide pela shapeSeed (rad/s) — fonte única no shared. */
  private asteroidSpinOf(shapeSeed: number): number {
    return asteroidSpinRate(shapeSeed);
  }

  /** Centro da vaga `bay` da estrutura, no mundo (ver shared/bays.ts). */
  private bayPosOf(struct: Structure, bay: number) {
    return bayWorldPos(struct, bay) ?? { sx: struct.sx, sy: struct.sy, x: struct.x, y: struct.y };
  }

  /**
   * Começa a animação de pouso até `target`. O alvo é guardado no referencial
   * do SETOR em que a nave está (a animação interpola x/y sem trocar de setor);
   * ao terminar, o tick assenta a nave na posição exata, setor incluído.
   *
   * O pouso É a travessia de camada: a nave fica "a caminho da superfície"
   * (layerTo) durante a animação — invulnerável, como qualquer transição — e
   * chega à superfície quando ela termina.
   */
  private startLanding(ship: ShipState, target: { sx: number; sy: number; x: number; y: number }, spin: number): void {
    const { dx, dy } = relVec(ship, target);
    ship.landingPhase = "landing";
    ship.landingProgress = 0;
    ship.landingOriginX = ship.x;
    ship.landingOriginY = ship.y;
    ship.landingTargetX = ship.x + dx;
    ship.landingTargetY = ship.y + dy;
    ship.landingAsteroidSpin = spin;
    ship.vx = 0;
    ship.vy = 0;
    ship.layerTo = "surface";
    ship.layerProgress = 0;
    this.attackTargets.delete(this.shipIdOf(ship));
  }

  /**
   * Pouso numa estrutura PRÓPRIA: exatamente na primeira vaga livre
   * compatível com a classe. Sem vaga, não pousa (devolve false). O asteroide
   * de uma estrutura não gira, então a vaga é um ponto fixo do mundo.
   */
  private landAtBay(ship: ShipState, struct: Structure): boolean {
    const bay = this.firstFreeShipBay(struct, ship.kind);
    if (bay < 0) return false;
    this.startLanding(ship, this.bayPosOf(struct, bay), 0);
    ship.anchoredAsteroidId = "";
    ship.hqId = struct.id;
    ship.bay = bay;
    return true;
  }

  /** Pouso num asteroide VAZIO (builder e mineração): até o centro dele. */
  private landOnAsteroid(ship: ShipState, ast: Asteroid): void {
    this.startLanding(ship, ast, this.asteroidSpinOf(ast.shapeSeed));
    ship.anchoredAsteroidId = ast.id;
    ship.hqId = "";
    ship.bay = -1;
  }

  /**
   * Decola: solta a nave da vaga (ou do asteroide) e a manda de volta ao
   * cruzeiro. A subida é uma transição comum — sem colisão e invulnerável —,
   * então sair de dentro do asteroide em que estava pousada não esbarra nele.
   */
  private liftOff(ship: ShipState): void {
    ship.landingPhase = "";
    ship.anchored = false;
    ship.anchoredAsteroidId = "";
    ship.bay = -1;
    ship.landingProgress = 0;
    if (!ship.stored) ship.hqId = "";
    beginLayerChange(ship, "cruise");
  }

  /**
   * Depois de construir, o builder — pousado no centro do asteroide — vai para
   * a primeira vaga livre da estrutura nova, com a animação de pouso.
   */
  private settleAfterBuild(ship: ShipState, structId: string): void {
    const struct = this.sim.structures.get(structId);
    if (!struct) return;
    ship.anchored = false;
    ship.mining = false;
    const bay = this.firstFreeShipBay(struct, ship.kind);
    if (bay < 0) {
      ship.bay = -1;
      this.dockAtBay(ship, struct);
      return;
    }
    this.startLanding(ship, this.bayPosOf(struct, bay), 0);
    ship.anchoredAsteroidId = "";
    ship.hqId = struct.id;
    ship.bay = bay;
  }

  /** Id da nave no mundo (o ShipState não guarda o próprio id). */
  private shipIdOf(ship: ShipState): string {
    for (const [id, s] of this.sim.ships) if (s === ship) return id;
    return "";
  }

  /**
   * [F] — o único comando de pouso e de camada. A regra de cada caso segue a
   * especificação das camadas (shared/layers.ts):
   *
   *  - pousada numa vaga ou num asteroide: decola e sobe ao cruzeiro;
   *  - na superfície ou em modo ataque: sobe ao cruzeiro;
   *  - em cruzeiro, na ordem:
   *    · perto (DOCK_RANGE) de estação própria: pousa na primeira vaga livre
   *      compatível com a classe;
   *    · perto de asteroide vazio, builder e mineração: pousam no centro dele;
   *    · perto de uma plataforma de Ceres, builder e mineração: pousam no
   *      centro dela (shared/ceres.ts — áreas planas fixas, Ceres não gira);
   *    · nave de ataque dentro da zona de uma estação inimiga: modo ataque — a
   *      zona é a mesma que a mantém nele, então ela não é expulsa ao entrar;
   *    · sobre Ceres, ou sobre uma rocha que não seja de estação própria:
   *      nada (a nave nasceria dentro de algo sólido);
   *    · no mais: desce à superfície.
   */
  private tryToggleAnchor(sessionId: string): void {
    const ship = this.activeShipOf(sessionId);
    const shipId = this.activeShip.get(sessionId) ?? "";
    if (!ship || ship.stored || ship.autoMining || ship.taxiTo) return;
    // builder construindo turreta: travado na vaga até o fim da obra
    if (this.buildingTurret(shipId)) return;

    // pouso em andamento ou transição de camada: [F] espera terminar
    if (ship.landingPhase === "landing" || ship.landingPhase === "liftoff" || ship.layerTo) return;

    // pousada num asteroide ou numa vaga: decola
    if (ship.landingPhase === "landed" || ship.anchored) {
      if (ship.landingPhase === "landed" && ship.anchored) return; // minerando: pare antes ([SPACE])
      this.liftOff(ship);
      return;
    }

    // fora do cruzeiro: sobe
    if (ship.layer !== "cruise") {
      beginLayerChange(ship, "cruise");
      this.attackTargets.delete(shipId);
      return;
    }

    // ── em cruzeiro ──
    const near = this.sim.nearestAsteroid(ship, DOCK_RANGE);
    if (near) {
      const structs = [...this.sim.structures.values()].filter((s) => s.asteroidId === near.id);
      const own = structs.find((s) => s.owner === sessionId);
      if (own && this.landAtBay(ship, own)) return;
      // RUÍNA: só o builder pousa — para recuperá-la com [G]
      const ruin = ship.kind === "builder" ? structs.find((s) => s.owner === RUIN_OWNER) : undefined;
      if (ruin && this.landAtBay(ship, ruin)) return;
      if (structs.length === 0 && (ship.kind === "builder" || ship.kind === "mining")) {
        this.landOnAsteroid(ship, near);
        return;
      }
    }
    const ownNear = this.nearestOwnStructure(sessionId, ship, DOCK_RANGE);
    if (ownNear && this.landAtBay(ship, ownNear)) return;

    // plataforma de Ceres: com estrutura PRÓPRIA, pousa na vaga livre dela (o
    // alcance é a área da plataforma, não o centro do prédio); VAZIA, é como um
    // asteroide vazio — builder e mineração pousam no centro; com estrutura
    // inimiga, não pousa (a nave de ataque cai no modo ataque, abaixo)
    const pad = this.ceresPlatformNear(ship);
    if (pad) {
      const built = [...this.sim.structures.values()].find((st) => st.asteroidId === pad.id);
      if (built && (built.owner === sessionId || (built.owner === RUIN_OWNER && ship.kind === "builder")) && this.landAtBay(ship, built)) return;
      if (!built && this.hole?.padId !== pad.id && (ship.kind === "builder" || ship.kind === "mining")) {
        this.startLanding(ship, ceresPlatformPos(this.sim.seed, pad), 0);
        ship.anchoredAsteroidId = pad.id;
        ship.hqId = "";
        ship.bay = -1;
        return;
      }
    }

    if (ship.kind === "attack") {
      const target = this.enemyStationZoneAt(ship, sessionId);
      if (target) {
        beginLayerChange(ship, "attack");
        this.attackTargets.set(shipId, target);
        return;
      }
    }

    if (dist(ship, ceresPosition(this.sim.seed)) < CERES_RADIUS + SHIP_RADIUS) return;
    const under = this.asteroidUnder(ship);
    if (under) {
      // só o asteroide da estação PRÓPRIA é atravessável na superfície
      const ownRock = [...this.sim.structures.values()].some((s) => s.asteroidId === under.id && s.owner === sessionId);
      if (!ownRock) return;
    }
    beginLayerChange(ship, "surface");
  }

  /**
   * Evolui a estação de mineração de Ceres em que o builder do jogador está
   * atracado: um nível a mais, pagando ceresStationUpgradeCost. Cada nível
   * soma vagas de aranha, capacidade de estoque, HP (a diferença do máximo
   * entra também no HP atual) e produção própria — e o render acrescenta
   * anexos na plataforma.
   */
  private tryUpgrade(sessionId: string): void {
    const ship = this.activeShipOf(sessionId);
    if (!ship || ship.kind !== "builder" || !ship.anchored) return;
    const st = this.sim.structures.get(ship.hqId);
    if (!st || st.owner !== sessionId || st.type !== "miningStation") return;
    const cost = stationUpgradeCost(st.level);
    if (cost === null || st.level >= CERES_STATION_MAX_LEVEL) return;
    if (!this.payKits(ship, st, cost)) return;
    const oldMax = structureMaxHp(st.type, st.level);
    st.level += 1;
    // em Ceres, cada nível também abre vagas de aranha (e anexos no render)
    if (st.asteroidId.startsWith(CERES_PLATFORM_PREFIX)) st.spiderBays += CERES_STATION_SPIDER_BAYS_PER_LEVEL;
    st.hp += structureMaxHp(st.type, st.level) - oldMax;
    console.log(`[room] ${sessionId} evoluiu a estação ${st.id} para o nível ${st.level}`);
    if (st.asteroidId.startsWith(CERES_PLATFORM_PREFIX) && st.level >= WORM_WAKE_LEVEL && !this.hole && !this.quake) this.startQuake(st);
  }

  /**
   * Local de construção em que a nave está POUSADA: o asteroide vazio (pelo
   * id guardado no pouso) ou uma plataforma de Ceres. Devolve posição, id,
   * raio, classe e a orientação da estrutura: no asteroide, virada para onde a
   * nave estava; na plataforma de Ceres (a nave pousa no centro), para FORA de
   * Ceres — a fileira de vagas fica do lado da borda. null se não achar.
   */
  private landedSite(ship: ShipState): (WorldPos & { id: string; radius: number; cls: AsteroidClass; angle: number }) | null {
    const id = ship.anchoredAsteroidId;
    if (!id) return null;
    if (id.startsWith(CERES_PLATFORM_PREFIX)) {
      const pad = ceresPlatforms(this.sim.seed).find((p) => p.id === id);
      if (!pad) return null;
      const pos = ceresPlatformPos(this.sim.seed, pad);
      return { ...pos, id, radius: pad.radius, cls: asteroidClassOf(pad.radius), angle: Math.atan2(pad.dy, pad.dx) };
    }
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        for (const a of sectorAsteroids(this.sim.seed, ship.sx + ox, ship.sy + oy)) {
          if (a.id !== id) continue;
          const { dx, dy } = relVec(a, ship);
          return { sx: a.sx, sy: a.sy, x: a.x, y: a.y, id, radius: a.radius, cls: asteroidClassOf(a.radius), angle: Math.atan2(dy, dx) };
        }
      }
    }
    return null;
  }

  /**
   * Raio do local que hospeda a estrutura — o asteroide, ou a plataforma de
   * Ceres — ou null se não achar. É a zona do modo ataque e o chão da aranha.
   */
  private siteRadius(st: Structure): number | null {
    if (st.asteroidId.startsWith(CERES_PLATFORM_PREFIX)) {
      return ceresPlatforms(this.sim.seed).find((p) => p.id === st.asteroidId)?.radius ?? null;
    }
    return sectorAsteroids(this.sim.seed, st.sx, st.sy).find((a) => a.id === st.asteroidId)?.radius ?? null;
  }

  /** Plataforma de Ceres cuja borda está a até DOCK_RANGE da nave (a mais próxima). */
  private ceresPlatformNear(ship: ShipState): CeresPlatform | null {
    let best: CeresPlatform | null = null;
    let bestEdge = DOCK_RANGE;
    for (const p of ceresPlatforms(this.sim.seed)) {
      const edge = dist(ship, ceresPlatformPos(this.sim.seed, p)) - p.radius;
      if (edge <= bestEdge) {
        bestEdge = edge;
        best = p;
      }
    }
    return best;
  }

  /**
   * Estação inimiga cuja zona de ataque (raio do asteroide + margem) contém a
   * nave — a mesma zona que `superviseAttackMode` usa para mantê-la no modo.
   */
  private enemyStationZoneAt(ship: ShipState, sessionId: string): { structId: string; radius: number } | null {
    // a TOCA das minhocas também: é sobre ela que se lançam as minas para tapá-la
    if (this.hole && dist(ship, this.hole.pos) <= this.hole.radius + ATTACK_ZONE_MARGIN) {
      return { structId: WORM_HOLE_ID, radius: this.hole.radius };
    }
    for (const st of this.sim.structures.values()) {
      if (!this.hostileStructure(sessionId, st)) continue;
      const radius = this.siteRadius(st);
      if (radius === null) continue;
      if (dist(ship, st) <= radius + ATTACK_ZONE_MARGIN) return { structId: st.id, radius };
    }
    return null;
  }

  /**
   * Asteroide sob a nave: o casco encosta no círculo dele (raio + casco). É o
   * mesmo critério da colisão na superfície — descer ali poria a nave dentro.
   */
  private asteroidUnder(ship: ShipState): Asteroid | null {
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        for (const a of sectorAsteroids(this.sim.seed, ship.sx + ox, ship.sy + oy)) {
          if (dist(ship, a) < a.radius + SHIP_RADIUS) return a;
        }
      }
    }
    return null;
  }

  /**
   * Modo ataque preso à estação: a nave que sai da zona do asteroide atacado,
   * ou cuja estação deixou de existir, sobe sozinha ao cruzeiro. Vale também
   * durante a descida para o modo ataque.
   */
  private superviseAttackMode(): void {
    for (const [id, target] of this.attackTargets) {
      const ship = this.sim.ships.get(id);
      if (!ship || (ship.layer !== "attack" && ship.layerTo !== "attack")) {
        this.attackTargets.delete(id);
        continue;
      }
      const site = this.attackSitePos(target.structId);
      if (!site || dist(ship, site) > target.radius + ATTACK_ZONE_MARGIN) {
        beginLayerChange(ship, "cruise");
        this.attackTargets.delete(id);
      }
    }
  }

  /** Centro do alvo do modo ataque: a estrutura, ou a toca das minhocas (WORM_HOLE_ID). */
  private attackSitePos(id: string): WorldPos | null {
    if (id === WORM_HOLE_ID) return this.hole?.pos ?? null;
    return this.sim.structures.get(id) ?? null;
  }

  /** Troca a nave ativa por uma do hangar da estrutura ancorada. */
  private trySwap(sessionId: string): void {
    // a pé na estação: embarca na nave guardada ali (ordem das vagas)
    const waiting = this.sim.structures.get(this.waitingAt.get(sessionId) ?? "");
    if (waiting) {
      const here = [...this.sim.ships]
        .filter(([, s]) => s.owner === sessionId && s.hqId === waiting.id && s.stored)
        .sort(([, a], [, b]) => a.bay - b.bay);
      if (here.length > 0) this.boardShip(sessionId, here[0][0], here[0][1], waiting);
      return;
    }
    const active = this.activeShipOf(sessionId);
    if (!active || !active.anchored) return;
    const struct = this.sim.structures.get(active.hqId) ?? this.nearestOwnStructure(sessionId, active, DOCK_RANGE);
    if (!struct || struct.owner !== sessionId) return;

    // naves guardadas no hangar desta estrutura, na ORDEM DAS VAGAS: [C] vai
    // para a próxima vaga ocupada depois da atual (1 → 6) e volta ao início.
    // Pegar "a primeira guardada" do mapa fazia a nave que acabou de entrar
    // ser escolhida de volta — o [C] só alternava entre duas vagas
    const stored = [...this.sim.ships]
      .filter(([, s]) => s.owner === sessionId && s.hqId === struct.id && s.stored)
      .sort(([, a], [, b]) => a.bay - b.bay);
    if (stored.length === 0) return; // hangar vazio
    const pick = stored.find(([, s]) => s.bay > active.bay) ?? stored[0];

    // cada nave fica na PRÓPRIA vaga: a ativa, pousada na dela, entra no
    // hangar ali mesmo; a escolhida sai do hangar para a placa da vaga dela
    const [nid, next] = pick;
    const activeId = this.activeShip.get(sessionId)!;
    if (this.buildingTurret(activeId)) {
      // builder em obra: fica na vaga, trabalhando; vai para o hangar
      // sozinho quando a turreta ficar pronta (stepTurretJobs)
      active.mining = false;
    } else {
      active.stored = true;
      active.anchored = false;
      active.hqId = struct.id;
      if (active.bay < 0) active.bay = this.firstFreeShipBay(struct, active.kind);
    }
    this.sim.setInput(activeId, { thrust: false, turn: 0, mine: false });

    this.deployFromHangar(next, struct);
    this.activeShip.set(sessionId, nid);
    console.log(`[room] ${sessionId} trocou de nave → ${next.kind} (${nid})`);
  }

  /**
   * Transforma a mineradora ancorada numa ARANHA mineradora da estação:
   * ela passa a caminhar pelo asteroide, minerando e descarregando sozinha.
   */
  private tryAutoMine(sessionId: string): void {
    const active = this.activeShipOf(sessionId);
    if (active?.kind === "transport") {
      this.tryAutoTransport(sessionId);
      return;
    }
    if (active?.kind === "builder") {
      this.tryRepair(sessionId);
      return;
    }
    if (!active || active.kind !== "mining" || !active.anchored) return;
    const station = this.nearestOwnStructure(sessionId, active, DOCK_RANGE, "miningStation");
    if (!station) return;

    // vagas de aranha da estação (2/4/6 pela classe do asteroide)
    if (station.nextSpiderBay >= station.spiderBays) return;

    // o piloto DESEMBARCA e fica esperando na estação (sem nave): dali chama
    // um táxi de qualquer hangar ou embarca numa nave guardada ali
    const activeId = this.activeShip.get(sessionId)!;
    this.activeShip.delete(sessionId);
    this.waitingAt.set(sessionId, station.id);
    this.makeSpider(activeId, active, station);
  }

  /** A nave de mineração vira ARANHA da estação (se há vaga de aranha). */
  private makeSpider(id: string, ship: ShipState, station: Structure): boolean {
    if (station.nextSpiderBay >= station.spiderBays) return false;
    // raio do asteroide hospedeiro (para a aranha caminhar na superfície)
    const astRadius = this.siteRadius(station) ?? 400;
    ship.autoMining = true;
    ship.stationId = station.id;
    ship.anchored = false;
    ship.stored = false;
    ship.bay = -1; // libera a vaga de nave — a aranha usa vaga de aranha
    ship.hqId = "";
    ship.taxiTo = "";
    this.spiders.set(id, makeSpiderState(astRadius));
    station.nextSpiderBay += 1;
    console.log(`[room] ${ship.owner} aranha mineradora ativa em ${station.id} (${station.nextSpiderBay}/${station.spiderBays})`);
    return true;
  }

  /**
   * Ação do builder após pousar num asteroide vazio:
   * "mine" = inicia mineração automática, "build" = constrói estação, "liftoff" = decola.
   * "stationmine" = coleta o buffer da estação (builder ancorado na estação).
   */
  private tryLandAction(sessionId: string, action?: string): void {
    const ship = this.activeShipOf(sessionId);
    if (!ship) return;

    // coleta buffer da estação: builder ancorado (qualquer fase)
    if (action === "stationmine") {
      this.tryStationMine(sessionId);
      return;
    }

    if ((ship.kind !== "builder" && ship.kind !== "mining") || ship.landingPhase !== "landed") return;

    if (action === "liftoff") {
      if (ship.anchored) return;
      this.liftOff(ship);
      return;
    }

    if (action === "mine") {
      // liga/desliga a mineração automática; PERMANECE pousado ("landed")
      ship.anchored = !ship.anchored;
      return;
    }

    if (action === "buildmine" && ship.kind === "builder") {
      // constrói estação de mineração no asteroide pousado
      const spec = STRUCTURE_SPECS["miningStation"];
      if (!this.hasKits(ship, spec.cost)) return;

      // o local em que o builder pousou: asteroide vazio ou plataforma de Ceres
      const ast = this.landedSite(ship);
      if (!ast) return;

      // 1 estrutura por asteroide
      for (const st of this.sim.structures.values()) {
        if (st.asteroidId === ast.id) return;
      }

      const { angle, cls } = ast;
      const shipBays = STATION_SHIP_BAYS;
      const expandedBays = STATION_EXPANDED_BAYS;
      const spiderBays = STATION_SPIDER_BAYS[cls];

      this.spendKits(ship, spec.cost);
      const id = `st-${this.structSeq++}`;
      this.sim.addStructure({
        id, type: "miningStation", owner: sessionId,
        sx: ast.sx, sy: ast.sy, x: ast.x, y: ast.y,
        angle, asteroidId: ast.id, asteroidClass: cls,
        shipBays, expandedBays, spiderBays, nextShipBay: 0, nextSpiderBay: 0,
        oreStore: 0, rationStore: 0,
      });
      const ss = new StructureSchema();
      ss.stype = "miningStation"; ss.owner = sessionId;
      ss.sx = ast.sx; ss.sy = ast.sy; ss.x = ast.x; ss.y = ast.y;
      ss.angle = angle; ss.asteroidId = ast.id; ss.asteroidClass = cls;
      ss.shipBays = shipBays; ss.expandedBays = expandedBays;
      ss.spiderBays = spiderBays; ss.nextShipBay = 0; ss.nextSpiderBay = 0;
      this.state.structures.set(id, ss);

      // o builder sai do centro do asteroide e pousa na vaga livre da estrutura nova
      this.settleAfterBuild(ship, id);
      this.onBuilt(sessionId, id);
      console.log(`[room] ${sessionId} construiu miningStation (via pouso) em ${cls} — builder a caminho da vaga`);
    }

    // em Ceres só se constrói estação de mineração (ver CERES_STATION_MAX_LEVEL)
    const onCeres = ship.anchoredAsteroidId.startsWith(CERES_PLATFORM_PREFIX);

    if (action === "buildhq" && ship.kind === "builder" && !onCeres) {
      const spec = STRUCTURE_SPECS["hq"];
      if (!this.hasKits(ship, spec.cost)) return;
      // o local em que o builder pousou: asteroide vazio ou plataforma de Ceres
      const ast = this.landedSite(ship);
      if (!ast) return;
      for (const st of this.sim.structures.values()) {
        if (st.asteroidId === ast.id) return;
      }
      const { angle, cls } = ast;
      const shipBays = HQ_SHIP_BAYS;
      const expandedBays = HQ_EXPANDED_BAYS;
      this.spendKits(ship, spec.cost);
      const id = `st-${this.structSeq++}`;
      this.sim.addStructure({
        id, type: "hq", owner: sessionId,
        sx: ast.sx, sy: ast.sy, x: ast.x, y: ast.y,
        angle, asteroidId: ast.id, asteroidClass: cls,
        shipBays, expandedBays, spiderBays: 0, nextShipBay: 0, nextSpiderBay: 0,
        oreStore: 0, rationStore: 0,
      });
      const ss = new StructureSchema();
      ss.stype = "hq"; ss.owner = sessionId;
      ss.sx = ast.sx; ss.sy = ast.sy; ss.x = ast.x; ss.y = ast.y;
      ss.angle = angle; ss.asteroidId = ast.id; ss.asteroidClass = cls;
      ss.shipBays = shipBays; ss.expandedBays = expandedBays;
      ss.spiderBays = 0; ss.nextShipBay = 0; ss.nextSpiderBay = 0;
      this.state.structures.set(id, ss);
      // o builder sai do centro do asteroide e pousa na vaga livre da estrutura nova
      this.settleAfterBuild(ship, id);
      this.onBuilt(sessionId, id);
      console.log(`[room] ${sessionId} construiu hq (via pouso) em ${cls}`);
    }

    if (action === "buildration" && ship.kind === "builder" && !onCeres) {
      const spec = STRUCTURE_SPECS["rationCenter"];
      if (!this.hasKits(ship, spec.cost)) return;
      // o local em que o builder pousou: asteroide vazio ou plataforma de Ceres
      const ast = this.landedSite(ship);
      if (!ast) return;
      for (const st of this.sim.structures.values()) {
        if (st.asteroidId === ast.id) return;
      }
      const { angle, cls } = ast;
      this.spendKits(ship, spec.cost);
      const id = `st-${this.structSeq++}`;
      this.sim.addStructure({
        id, type: "rationCenter", owner: sessionId,
        sx: ast.sx, sy: ast.sy, x: ast.x, y: ast.y,
        angle, asteroidId: ast.id, asteroidClass: cls,
        shipBays: RATION_CENTER_SHIP_BAYS, expandedBays: RATION_CENTER_EXPANDED_BAYS,
        spiderBays: 0, nextShipBay: 0, nextSpiderBay: 0,
        oreStore: 0, rationStore: 0,
      });
      const ss = new StructureSchema();
      ss.stype = "rationCenter"; ss.owner = sessionId;
      ss.sx = ast.sx; ss.sy = ast.sy; ss.x = ast.x; ss.y = ast.y;
      ss.angle = angle; ss.asteroidId = ast.id; ss.asteroidClass = cls;
      ss.shipBays = RATION_CENTER_SHIP_BAYS; ss.expandedBays = RATION_CENTER_EXPANDED_BAYS;
      ss.spiderBays = 0; ss.nextShipBay = 0; ss.nextSpiderBay = 0;
      this.state.structures.set(id, ss);
      // o builder sai do centro do asteroide e pousa na vaga livre da estrutura nova
      this.settleAfterBuild(ship, id);
      this.onBuilt(sessionId, id);
      console.log(`[room] ${sessionId} construiu rationCenter em ${cls}`);
    }
  }

  /**
   * Builder ancorado na estação: SPACE liga/desliga sua mineração automática.
   * O minério acumula no buffer da estação (junto com as aranhas).
   */
  private tryStationMine(sessionId: string): void {
    const ship = this.activeShipOf(sessionId);
    if (!ship || ship.kind !== "builder" || !ship.anchored) return;
    const station = this.sim.structures.get(ship.hqId);
    if (!station || station.type !== "miningStation" || station.owner !== sessionId) return;
    ship.mining = !ship.mining;
  }

  // ── turretas (turrets.ts) ──────────────────────────────────────────

  /**
   * [G] no builder atracado numa estrutura PRÓPRIA danificada: liga/desliga o
   * conserto automático (stepRepair). Precisa de algum kit — no porão ou no
   * buffer da estrutura.
   */
  private tryRepair(sessionId: string): void {
    const shipId = this.activeShip.get(sessionId);
    const ship = this.activeShipOf(sessionId);
    if (!shipId || !ship || ship.kind !== "builder" || !ship.anchored || ship.stored) return;
    const st = this.sim.structures.get(ship.hqId);
    if (!st || (st.owner !== sessionId && st.owner !== RUIN_OWNER)) return;
    const job = this.repairJobs.get(st.id);
    if (job) {
      if (job.shipId === shipId) this.repairJobs.delete(st.id);
      return;
    }
    // ruína: a recuperação vale mesmo de HP cheio, paga só com o porão (o
    // buffer dela é do espólio e fica como está)
    if (st.owner === RUIN_OWNER) {
      this.repairJobs.set(st.id, { shipId, credit: 0, claim: sessionId });
      return;
    }
    if (st.hp >= structureMaxHp(st.type, st.level) || ship.kits + st.kitStore < 1) return;
    this.repairJobs.set(st.id, { shipId, credit: 0 });
  }

  /**
   * Conserto: REPAIR_RATE HP/s, pagando 1 kit a cada REPAIR_HP_PER_KIT HP — do
   * porão do builder primeiro, depois do buffer da estrutura. Termina no HP
   * cheio, sem kits, ou quando o builder sai da vaga.
   */
  private stepRepair(dt: number): void {
    for (const [stId, job] of [...this.repairJobs]) {
      const st = this.sim.structures.get(stId);
      const ship = this.sim.ships.get(job.shipId);
      if (!st || !ship || !ship.anchored || ship.stored || ship.hqId !== stId) {
        this.repairJobs.delete(stId);
        continue;
      }
      const max = structureMaxHp(st.type, st.level);
      let heal = Math.min(REPAIR_RATE * dt, max - st.hp);
      while (job.credit < heal) {
        if (ship.kits >= 1) ship.kits -= 1;
        else if (!job.claim && st.kitStore >= 1) st.kitStore -= 1;
        else break;
        job.credit += REPAIR_HP_PER_KIT;
      }
      heal = Math.min(heal, job.credit);
      st.hp += heal;
      job.credit -= heal;
      if (st.hp >= max && job.claim) this.claimRuin(st, job.claim);
      if (st.hp >= max || heal <= 0) this.repairJobs.delete(stId);
    }
  }

  /**
   * RUÍNA RECUPERADA: volta a funcionar como estrutura do jogador, com o
   * buffer (minério, kits, rações) que tinha — agora no inventário dele.
   */
  private claimRuin(st: Structure, sessionId: string): void {
    st.owner = sessionId;
    this.addScore(sessionId, SCORE_POINTS.ruinClaimed);
    console.log(`[room] ${sessionId} recuperou a ruína ${st.id} (${st.type})`);
  }

  /** O builder `shipId` está construindo uma turreta (e por isso travado na vaga)? */
  private buildingTurret(shipId: string): boolean {
    for (const job of this.turretJobs.values()) if (job.shipId === shipId) return true;
    return false;
  }

  /**
   * [E] no builder: põe um lote de REFINE_ORE minério do PORÃO na refinaria de
   * bordo, que rende REFINE_KITS kits em REFINE_TIME s (stepRefine). Vale em
   * qualquer lugar — pousado minerando inclusive. Os lotes fazem fila; os kits
   * (contando a fila) cabem no porão (holdRoom: teto do item e do total).
   */
  private loadBuilderOre(sessionId: string, ship: ShipState): void {
    const shipId = this.activeShip.get(sessionId);
    if (!shipId || ship.cargoKind !== "ore" || ship.cargoAmount < REFINE_ORE) return;
    const job = this.refine.get(shipId) ?? { queue: 0, t: 0 };
    if (holdRoom(ship, "kits") < (job.queue + 1) * REFINE_KITS) return;
    ship.cargoAmount -= REFINE_ORE;
    if (ship.cargoAmount <= 0) { ship.cargoKind = ""; ship.cargoAmount = 0; }
    job.queue++;
    this.refine.set(shipId, job);
  }

  /** [E] na nave de mineração atracada: descarrega o porão no buffer da estrutura. */
  private unloadOre(sessionId: string, ship: ShipState): void {
    if (!ship.anchored || ship.cargoKind !== "ore" || ship.cargoAmount <= 0) return;
    const st = this.sim.structures.get(ship.hqId);
    if (!st || st.owner !== sessionId) return;
    const moved = Math.min(ship.cargoAmount, Math.max(0, this.oreCap(st) - st.oreStore));
    if (moved <= 0) return;
    st.oreStore += moved;
    ship.cargoAmount -= moved;
    if (ship.cargoAmount <= 0) { ship.cargoKind = ""; ship.cargoAmount = 0; }
  }

  /** Capacidade do buffer de minério de uma estrutura. */
  private oreCap(st: Structure): number {
    return st.type === "miningStation" ? stationOreCap(st.level) : STRUCTURE_ORE_CAP;
  }

  /**
   * [O]/[P]/[K]/[L]: o builder atracado numa estrutura própria retira ou
   * deposita minério e kits no buffer dela (base inicial, QG, estação de
   * mineração), respeitando o porão e o buffer.
   */
  private tryTransfer(sessionId: string, item?: "ore" | "kits" | "rations", dir?: "withdraw" | "deposit"): void {
    const ship = this.activeShipOf(sessionId);
    if (!ship || ship.kind !== "builder" || !ship.anchored) return;
    const st = this.sim.structures.get(ship.hqId);
    if (!st || st.owner !== sessionId) return;
    // [J] rações: carrega onde elas nascem/estocam (base, central), descarrega
    // onde são consumidas (estação de mineração, QG)
    if (item === "rations") {
      // na central de rações o [J] vale nos dois sentidos: chegando COM rações,
      // descarrega (abastece os drones); de porão sem rações, carrega
      const unload = st.type === "miningStation" || st.type === "hq" || (st.type === "rationCenter" && ship.rations > 0);
      if (!unload && (st.type === "initialBase" || st.type === "rationCenter")) {
        const moved = Math.min(holdRoom(ship, "rations"), Math.floor(st.rationStore));
        if (moved > 0) { st.rationStore -= moved; ship.rations += moved; }
      } else if (unload) {
        const moved = Math.min(ship.rations, Math.max(0, RATION_STORE_CAP - Math.floor(st.rationStore)));
        if (moved > 0) { st.rationStore += moved; ship.rations -= moved; }
      }
      return;
    }
    if (st.type !== "initialBase" && st.type !== "hq" && st.type !== "miningStation") return;
    if (item === "ore") {
      const hold = ship.cargoKind === "ore" ? ship.cargoAmount : 0;
      if (ship.cargoKind !== "" && ship.cargoKind !== "ore") return;
      const moved = dir === "withdraw"
        ? Math.min(holdRoom(ship, "ore"), Math.floor(st.oreStore))
        : Math.min(hold, Math.max(0, this.oreCap(st) - st.oreStore));
      if (!(moved > 0)) return;
      st.oreStore += dir === "withdraw" ? -moved : moved;
      ship.cargoAmount = hold + (dir === "withdraw" ? moved : -moved);
      ship.cargoKind = ship.cargoAmount > 0 ? "ore" : "";
    } else if (item === "kits") {
      const moved = dir === "withdraw"
        ? Math.min(holdRoom(ship, "kits"), st.kitStore)
        : Math.min(ship.kits, Math.max(0, STRUCTURE_KIT_CAP - st.kitStore));
      if (!(moved > 0)) return;
      st.kitStore += dir === "withdraw" ? -moved : moved;
      ship.kits += dir === "withdraw" ? moved : -moved;
    }
  }

  /** Refinarias de bordo: cada lote vira REFINE_KITS kits após REFINE_TIME s. */
  private stepRefine(dt: number): void {
    for (const [id, job] of [...this.refine]) {
      const ship = this.sim.ships.get(id);
      if (!ship) {
        this.refine.delete(id);
        continue;
      }
      job.t += dt * this.testSpeed;
      while (job.queue > 0 && job.t >= REFINE_TIME) {
        job.t -= REFINE_TIME;
        job.queue--;
        const made = Math.min(REFINE_KITS, holdRoom(ship, "kits"));
        ship.kits += made;
        this.addScore(ship.owner, made * SCORE_POINTS.kit);
      }
      if (job.queue === 0) this.refine.delete(id);
    }
  }

  /** O builder tem `cost` kits no porão? */
  private hasKits(ship: ShipState, cost: number): boolean {
    return ship.kits >= cost;
  }

  /** Tira `cost` kits do porão do builder (false se não houver). */
  private spendKits(ship: ShipState, cost: number): boolean {
    if (!this.hasKits(ship, cost)) return false;
    ship.kits -= cost;
    return true;
  }

  /**
   * Paga `cost` kits de uma obra NA estrutura `st` (turreta, evolução): primeiro
   * com o buffer dela, o que faltar com o porão do builder. false se não der.
   */
  private payKits(ship: ShipState, st: Structure, cost: number): boolean {
    if (st.kitStore + ship.kits < cost) return false;
    const fromStore = Math.min(st.kitStore, cost);
    st.kitStore -= fromStore;
    ship.kits -= cost - fromStore;
    return true;
  }

  /**
   * [B] no builder atracado numa estrutura PRÓPRIA: começa uma turreta no
   * próximo lugar livre, pagando TURRET_COST do porão. Uma obra por vez por
   * estrutura; o builder fica travado na vaga até o fim.
   */
  private tryBuildTurret(sessionId: string): void {
    const shipId = this.activeShip.get(sessionId);
    const ship = this.activeShipOf(sessionId);
    if (!shipId || !ship || ship.kind !== "builder" || !ship.anchored || ship.stored) return;
    const struct = this.sim.structures.get(ship.hqId);
    if (!struct || struct.owner !== sessionId) return;
    if (this.turretJobs.has(struct.id) || this.buildingTurret(shipId)) return;
    if ((this.turrets.get(struct.id) ?? 0) >= TURRET_MAX) return;
    if (!this.payKits(ship, struct, TURRET_COST)) return;
    ship.mining = false;
    this.turretJobs.set(struct.id, { shipId, progress: 0 });
    console.log(`[room] ${sessionId} começou turreta ${(this.turrets.get(struct.id) ?? 0) + 1} em ${struct.id}`);
  }

  /**
   * Avança as obras. O builder tem de continuar atracado na estrutura — se
   * ele explodiu, a obra se perde (o minério já foi gasto). Pronta, a
   * turreta entra em serviço e o builder destrava; se o jogador já estava
   * em outra nave, o builder entra no hangar (senão ficaria órfão na vaga).
   */
  private stepTurretJobs(dt: number): void {
    for (const [structId, job] of [...this.turretJobs]) {
      const ship = this.sim.ships.get(job.shipId);
      if (!ship || !ship.anchored || ship.hqId !== structId) {
        this.turretJobs.delete(structId);
        continue;
      }
      job.progress = Math.min(1, job.progress + dt / TURRET_BUILD_TIME);
      if (job.progress < 1) continue;
      this.turretJobs.delete(structId);
      this.turrets.set(structId, (this.turrets.get(structId) ?? 0) + 1);
      this.stat(ship.owner).turrets++;
      this.addScore(ship.owner, SCORE_POINTS.turret);
      const piloted = [...this.activeShip.values()].includes(job.shipId);
      if (!piloted) {
        ship.anchored = false;
        ship.stored = true;
      }
      console.log(`[room] turreta pronta em ${structId} (${this.turrets.get(structId)}/${TURRET_MAX})`);
    }
  }

  /**
   * DEFESA AUTOMÁTICA: cada turreta pronta atira na nave inimiga mais perto
   * dela entre as que estão em MODO ATAQUE contra a estrutura (e no nível
   * dela — em transição ninguém é atingido), dentro de TURRET_RANGE.
   */
  private stepTurrets(dt: number): void {
    for (const [structId, count] of this.turrets) {
      const st = this.sim.structures.get(structId);
      if (!st || count <= 0) continue;
      let cds = this.turretCooldowns.get(structId);
      if (!cds) this.turretCooldowns.set(structId, (cds = []));
      const attackers: Array<[string, ShipState]> = [];
      for (const [id, target] of this.attackTargets) {
        if (target.structId !== structId) continue;
        const s = this.sim.ships.get(id);
        if (s && s.owner !== st.owner && hittableLevel(s) === "surface") attackers.push([id, s]);
      }
      for (let i = 0; i < count; i++) {
        cds[i] = Math.max(0, (cds[i] ?? 0) - dt);
        if (cds[i] > 0 || (attackers.length === 0 && this.worms.size === 0)) continue;
        const from = turretWorldPos(st, i);
        let best: [string, ShipState] | null = null;
        let bd = TURRET_RANGE;
        for (const a of attackers) {
          if (!this.sim.ships.has(a[0])) continue;
          const d = dist(from, a[1]);
          if (d <= bd) { bd = d; best = a; }
        }
        if (!best) {
          const wt = this.wormInRange(from, TURRET_RANGE);
          if (!wt) continue;
          cds[i] = TURRET_COOLDOWN;
          const seg = wt.worm.segs[wt.seg];
          this.broadcast(MSG_FX, {
            kind: "laser", sx: from.sx, sy: from.sy, x: from.x, y: from.y,
            tsx: seg.sx, tsy: seg.sy, tx: seg.x, ty: seg.y, from: "turret", src: structId,
          } satisfies FxEvent);
          this.damageWorm(wt.id, TURRET_DAMAGE, undefined, structId);
          continue;
        }
        cds[i] = TURRET_COOLDOWN;
        const [, t] = best;
        this.broadcast(MSG_FX, {
          kind: "laser", sx: from.sx, sy: from.sy, x: from.x, y: from.y,
          tsx: t.sx, tsy: t.sy, tx: t.x, ty: t.y, from: "turret", src: structId, on: "ship", id: best[0],
        } satisfies FxEvent);
        this.damageShip(best, TURRET_DAMAGE, false, st.owner);
      }
    }
  }

  // ── frota dos bots (bots.ts) ───────────────────────────────────────

  /**
   * Ergue o QG dos bots numa plataforma de Ceres, de frente para fora do
   * planeta (as vagas olham para o espaço). Só ele produz bots.
   */
  private createBotHq(): void {
    const seed = this.sim.seed;
    const pad = ceresPlatforms(seed)[0];
    if (!pad) return;
    const pos = ceresPlatformPos(seed, pad);
    const { dx, dy } = relVec(ceresPosition(seed), pos);
    const angle = Math.atan2(dy, dx);
    const id = `st-${this.structSeq++}`;
    this.sim.addStructure({
      id, type: "hq", owner: BOT_OWNER, angle,
      sx: pos.sx, sy: pos.sy, x: pos.x, y: pos.y,
      asteroidId: pad.id, asteroidClass: asteroidClassOf(pad.radius),
      shipBays: HQ_SHIP_BAYS, expandedBays: HQ_EXPANDED_BAYS, spiderBays: 0,
      nextShipBay: 0, nextSpiderBay: 0, oreStore: 0, rationStore: 0,
    });
    const ss = new StructureSchema();
    ss.stype = "hq"; ss.owner = BOT_OWNER;
    ss.sx = pos.sx; ss.sy = pos.sy; ss.x = pos.x; ss.y = pos.y;
    ss.angle = angle; ss.asteroidId = pad.id; ss.asteroidClass = asteroidClassOf(pad.radius);
    ss.shipBays = HQ_SHIP_BAYS; ss.expandedBays = HQ_EXPANDED_BAYS;
    this.state.structures.set(id, ss);
    this.botHqId = id;
    console.log(`[room] QG dos bots em ${pad.id} (frota máx. ${this.botFleetMax})`);
  }

  /** Produz um bot novo, atracado numa vaga livre do QG e já armado. */
  private spawnBot(): string | null {
    const hq = this.sim.structures.get(this.botHqId);
    if (!hq) return null;
    const bay = this.firstFreeShipBay(hq, "attack");
    if (bay < 0) return null;
    const id = `bot-${this.botSeq++}`;
    const ship = this.sim.addShip(id, hq, BOT_OWNER, "attack");
    this.bots.set(id, makeBotState());
    ship.bay = bay;
    this.dockAtBay(ship, hq);
    ship.ammo = BOT_AMMO;
    ship.grenadeAmmo = 0;
    this.state.ships.set(id, this.mirrorSpawn(ship));
    console.log(`[room] QG dos bots produziu ${id} (${this.bots.size}/${this.botFleetMax})`);
    return id;
  }

  /** Um bot a cada BOT_BUILD_INTERVAL, enquanto o QG existir e a frota não estiver cheia. */
  private stepBotProduction(dt: number): void {
    if (!this.botHqId || this.bots.size >= this.botFleetMax) {
      this.botBuildTimer = BOT_BUILD_INTERVAL;
      return;
    }
    this.botBuildTimer -= dt;
    if (this.botBuildTimer > 0) return;
    this.botBuildTimer = BOT_BUILD_INTERVAL;
    this.spawnBot();
  }

  /**
   * ATAQUE EM ONDA: com BOT_WAVE_SIZE bots prontos no QG (atracados,
   * recarregados e armados) e algo a atacar, os primeiros BOT_WAVE_SIZE saem
   * juntos. Os demais prontos esperam o próximo grupo.
   */
  private launchWave(): void {
    const hq = this.sim.structures.get(this.botHqId);
    if (!hq) return;
    const ready: Array<[string, ShipState, BotState]> = [];
    for (const [id, bot] of this.bots) {
      const s = this.sim.ships.get(id);
      if (!s || bot.phase !== "reload" || bot.reload > 0) continue;
      if (!s.anchored || s.hqId !== hq.id || s.ammo < BOT_AMMO || s.hp < SHIP_HP_MAX) continue;
      ready.push([id, s, bot]);
    }
    if (ready.length < BOT_WAVE_SIZE || !(this.botWormTarget(ready[0][1]) || this.raidTargetOf(ready[0][1]))) return;
    ready.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [, s, bot] of ready.slice(0, BOT_WAVE_SIZE)) {
      this.liftOff(s);
      bot.phase = "raid";
    }
    console.log(`[room] QG dos bots lançou um grupo de ${BOT_WAVE_SIZE}`);
  }

  /**
   * A estrutura `st` é alvo de quem é `attacker`? As inimigas, sim; as RUÍNAS
   * de jogadores eliminados, só dos bots (que as caçam como qualquer outra).
   */
  private hostileStructure(attacker: string, st: Structure): boolean {
    if (st.owner === attacker) return false;
    return st.owner !== RUIN_OWNER || attacker === BOT_OWNER;
  }

  /** Estrutura de jogador (ou ruína) mais perto do bot (em qualquer ponto da arena). */
  private raidTargetOf(ship: ShipState): Structure | null {
    let best: Structure | null = null;
    let bd = Infinity;
    for (const st of this.sim.structures.values()) {
      if (!this.hostileStructure(ship.owner, st)) continue;
      const d = dist(ship, st);
      if (d < bd) { bd = d; best = st; }
    }
    return best;
  }

  /** Gomo exposto mais perto de qualquer minhoca fora da toca (o alvo prioritário do bot), ou null. */
  private botWormTarget(ship: ShipState): WorldPos | null {
    let best: WorldPos | null = null;
    let bd = Infinity;
    for (const w of this.worms.values()) {
      if (w.den >= 0) continue;
      const i = this.nearestExposedSeg(w, ship);
      if (i < 0) continue;
      const d = dist(ship, w.segs[i]);
      if (d < bd) { bd = d; best = w.segs[i]; }
    }
    return best;
  }

  /**
   * Bot caçando a minhoca: em cruzeiro, chega a uma distância segura do gomo
   * exposto, encara e dispara com a mira assentada nela.
   */
  private wormRaidInput(id: string, ship: ShipState, bot: BotState, seg: WorldPos): ShipInput {
    const { dx, dy } = relVec(ship, seg);
    const facing = Math.atan2(dy, dx);
    if (ship.layerTo) return faceInput(ship, facing);
    if (ship.layer !== "cruise") {
      this.leaveAttack(id, ship);
      return { thrust: false, turn: 0, mine: false };
    }
    // a CABEÇA perto: recua (a nave de ataque é mais rápida que a minhoca) —
    // parada à distância de tiro, ela era engolida uma atrás da outra
    for (const worm of this.worms.values()) {
      if (worm.den >= 0) continue;
      const h = relVec(worm, ship);
      const dh = Math.hypot(h.dx, h.dy);
      if (dh < BOT_WORM_FLEE && dh > 1) {
        const away = { sx: ship.sx, sy: ship.sy, x: ship.x + (h.dx / dh) * 5000, y: ship.y + (h.dy / dh) * 5000 };
        return seekInput(ship, away, { arriveRadius: 0 });
      }
    }
    if (Math.hypot(dx, dy) > BOT_WORM_STANDOFF) return seekInput(ship, seg, { arriveRadius: BOT_WORM_STANDOFF * 0.8 });
    const w = this.weaponOf(id);
    const tp = w.target.startsWith(WORM_PREFIX) ? this.targetPos(w.target) : null;
    if (tp) {
      const err = Math.abs(desiredOffset(ship, { id: w.target, pos: tp, vx: 0, vy: 0 }, "missile") - w.offset);
      if (err < BOT_AIM_TOLERANCE && this.elapsed >= bot.nextShot && ship.fireCooldown <= 0) {
        this.fireShip(id);
        bot.nextShot = this.elapsed + BOT_FIRE_INTERVAL;
      }
    }
    return faceInput(ship, facing);
  }

  /** Sai do modo ataque (sobe ao cruzeiro). */
  private leaveAttack(id: string, ship: ShipState): void {
    if (ship.layer !== "cruise" || ship.layerTo) beginLayerChange(ship, "cruise");
    this.attackTargets.delete(id);
  }

  /** IA de um bot: o ciclo ataque → retorno → recarga (ver bots.ts). */
  private botInput(id: string, ship: ShipState, bot: BotState, dt: number): ShipInput {
    const idle: ShipInput = { thrust: false, turn: 0, mine: false };
    const hq = this.sim.structures.get(this.botHqId);
    // pousando no QG: a sala conduz a animação
    if (ship.landingPhase !== "") return idle;

    if (bot.phase === "reload") {
      if (!ship.anchored || !hq || ship.hqId !== hq.id) {
        // largado fora do QG (o QG caiu): ataca com o que tiver
        bot.phase = ship.ammo > 0 ? "raid" : "return";
      } else {
        // recarrega e espera na vaga — quem decide a saída é launchWave
        bot.reload = Math.max(0, bot.reload - dt);
        if (bot.reload <= 0) ship.ammo = BOT_AMMO;
        ship.hp = Math.min(SHIP_HP_MAX, ship.hp + (SHIP_HP_MAX / BOT_REPAIR_TIME) * dt);
        return idle;
      }
    }

    if (bot.phase === "raid") {
      // a MINHOCA é o alvo prioritário dos bots
      const worm = ship.ammo > 0 ? this.botWormTarget(ship) : null;
      if (worm) return this.wormRaidInput(id, ship, bot, worm);
      const target = ship.ammo > 0 ? this.raidTargetOf(ship) : null;
      if (!target) {
        this.leaveAttack(id, ship);
        bot.phase = "return";
      } else {
        return this.raidInput(id, ship, bot, target);
      }
    }

    // "return": volta ao QG e pousa numa vaga livre
    if (!hq) return computeBotInput(ship, this.sim, bot, dt); // sem QG: vagueia
    if (ship.layerTo) return idle;
    if (ship.layer !== "cruise") {
      this.leaveAttack(id, ship);
      return idle;
    }
    if (dist(ship, hq) <= DOCK_RANGE && this.landAtBay(ship, hq)) {
      bot.phase = "reload";
      bot.reload = BOT_RELOAD_TIME;
      return idle;
    }
    return seekInput(ship, hq, { arriveRadius: DOCK_RANGE * 0.5 });
  }

  /**
   * Fase de ataque: voa em cruzeiro até o alvo, desce ao MODO ATAQUE dentro
   * da zona dele, encara o prédio e dispara (a mira automática acerta).
   */
  private raidInput(id: string, ship: ShipState, bot: BotState, target: Structure): ShipInput {
    const radius = this.siteRadius(target) ?? 400;
    const d = dist(ship, target);
    const { dx, dy } = relVec(ship, target);
    const facing = Math.atan2(dy, dx);
    if (ship.layerTo) return faceInput(ship, facing);
    if (ship.layer === "cruise") {
      if (d <= radius + ATTACK_ZONE_MARGIN * 0.5) {
        beginLayerChange(ship, "attack");
        this.attackTargets.set(id, { structId: target.id, radius });
        return faceInput(ship, facing);
      }
      return seekInput(ship, target, { arriveRadius: radius + ATTACK_ZONE_MARGIN * 0.3 });
    }
    if (ship.layer === "attack") {
      if (!this.attackTargets.has(id)) this.attackTargets.set(id, { structId: target.id, radius });
      // circula a estação de nariz travado nela (mesma tradução do jogador)
      const orbit = attackModeInput(ship, target, this.attackHoldRadius(radius), {
        thrust: false, turn: bot.orbitDir, mine: false,
      });
      // só atira com a mira ASSENTADA no alvo: com 2 mísseis por saída, um
      // disparo no instante em que a mira ainda gira é um míssil perdido
      const w = this.weaponOf(id);
      const aimErr = w.target === target.id
        ? Math.abs(desiredOffset(ship, { id: target.id, pos: target, vx: 0, vy: 0 }, "missile") - w.offset)
        : Infinity;
      if (aimErr < BOT_AIM_TOLERANCE && this.elapsed >= bot.nextShot && ship.fireCooldown <= 0) {
        this.fireShip(id);
        bot.nextShot = this.elapsed + BOT_FIRE_INTERVAL;
      }
      return orbit;
    }
    this.leaveAttack(id, ship);
    return { thrust: false, turn: 0, mine: false };
  }

  /** Estado do armamento da nave (criado com mísseis selecionados). */
  private weaponOf(shipId: string): WeaponState {
    let w = this.weapons.get(shipId);
    if (!w) {
      w = { weapon: "missile", offset: 0, target: "", locked: false, offset2: 0, locked2: false };
      this.weapons.set(shipId, w);
    }
    return w;
  }

  /** Seleciona a arma da nave ativa (teclas 1, 2 e 3). A mira recomeça no nariz. */
  private trySelectWeapon(sessionId: string, weapon?: WeaponKind): void {
    const shipId = this.activeShip.get(sessionId);
    const ship = this.activeShipOf(sessionId);
    if (!shipId || !ship || ship.kind !== "attack") return;
    if (!weapon || !WEAPON_KINDS.includes(weapon)) return;
    const w = this.weaponOf(shipId);
    if (w.weapon === weapon) return;
    w.weapon = weapon;
    w.offset = 0;
    w.target = "";
    w.locked = false;
    w.offset2 = 0;
    w.locked2 = false;
  }

  /**
   * Alvos possíveis do computador de tiro de `ship`: naves inimigas no mesmo
   * nível de combate e, no nível das estações, as estruturas inimigas.
   */
  private aimCandidates(ship: ShipState, level: CombatLevel): AimTarget[] {
    const out: AimTarget[] = [];
    for (const [id, s] of this.sim.ships) {
      if (s.owner === ship.owner || hittableLevel(s) !== level) continue;
      out.push({ id, pos: s, vx: s.vx, vy: s.vy });
    }
    if (level === "surface") {
      for (const st of this.sim.structures.values()) {
        if (!this.hostileStructure(ship.owner, st)) continue;
        out.push({ id: st.id, pos: st, vx: 0, vy: 0 });
      }
    }
    // minas no buraco da toca: alvo dos mísseis para tapá-la
    if (level === "surface") {
      for (const [pid, p] of this.projectiles) if (p.inHole) out.push({ id: MINE_PREFIX + pid, pos: p, vx: 0, vy: 0 });
    }
    // minhocas: o gomo exposto mais perto, em qualquer nível
    for (const [id, w] of this.worms) {
      const i = this.nearestExposedSeg(w, ship);
      if (i >= 0) out.push({ id: `${WORM_PREFIX}${id}:${i}`, pos: w.segs[i], vx: 0, vy: 0 });
    }
    // drones de ração inimigos em voo (cruzeiro)
    if (level === "cruise") {
      for (const [id, d] of this.drones) {
        if (d.owner === ship.owner || d.phase === "home") continue;
        out.push({ id: DRONE_PREFIX + id, pos: d, vx: 0, vy: 0 });
      }
    }
    return out;
  }

  /** Posição atual de um alvo (nave ou estrutura), ou null se sumiu. */
  private targetPos(id: string): (WorldPos & { vx: number; vy: number }) | null {
    if (id.startsWith(MINE_PREFIX)) {
      const m = this.projectiles.get(id.slice(MINE_PREFIX.length));
      return m ? { sx: m.sx, sy: m.sy, x: m.x, y: m.y, vx: 0, vy: 0 } : null;
    }
    if (id.startsWith(WORM_PREFIX)) {
      const seg = this.wormSegOf(id);
      return seg ? { sx: seg.sx, sy: seg.sy, x: seg.x, y: seg.y, vx: 0, vy: 0 } : null;
    }
    if (id.startsWith(DRONE_PREFIX)) {
      const d = this.drones.get(id.slice(DRONE_PREFIX.length));
      return d ? { sx: d.sx, sy: d.sy, x: d.x, y: d.y, vx: 0, vy: 0 } : null;
    }
    const s = this.sim.ships.get(id);
    if (s) return s;
    const st = this.sim.structures.get(id);
    return st ? { sx: st.sx, sy: st.sy, x: st.x, y: st.y, vx: 0, vy: 0 } : null;
  }

  /**
   * COMPUTADOR DE TIRO (weapons.ts), um passo por tick para cada nave de
   * ataque de jogador: escolhe o alvo mais perto da linha do nariz e gira a
   * mira até ele no ritmo da arma; sem alvo, a mira volta ao nariz. O laser
   * TRAVA quando a mira chega ao alvo — e só travado ele dispara.
   */
  private updateAim(dt: number): void {
    const aiming = [...this.activeShip.values(), ...this.raiders.keys()];
    for (const id of this.bots.keys()) aiming.push(id);
    for (const shipId of aiming) {
      const ship = this.sim.ships.get(shipId);
      if (!ship || ship.kind !== "attack") continue;
      const w = this.weaponOf(shipId);
      const { gimbal, slew } = gimbalOf(w.weapon);
      let target: AimTarget | null = null;
      if (w.weapon !== "mine" && canFire(ship)) {
        const range = w.weapon === "laser" ? LASER_RANGE : MISSILE_RANGE;
        target = pickTarget(ship, this.aimCandidates(ship, levelOfLayer(ship.layer)), range);
      }
      w.target = target?.id ?? "";
      if (w.weapon !== "laser") {
        const desired = target ? desiredOffset(ship, target, w.weapon) : 0;
        w.offset = gimbal > 0 ? slewAim(w.offset, desired, gimbal, slew, dt) : 0;
        w.locked = false;
        w.offset2 = 0;
        w.locked2 = false;
        continue;
      }
      // LASER DUPLO: cada canhão mira do PRÓPRIO ponto da asa, gira no próprio
      // ritmo e trava sozinho
      const gun = (i: number, offset: number): [number, boolean] => {
        if (!target) return [slewAim(offset, 0, gimbal, LASER_SLEWS[i], dt), false];
        const m = laserMount(ship.angle, i);
        const from = { ...ship, x: ship.x + m.dx, y: ship.y + m.dy };
        const desired = desiredOffset(from, target, "laser");
        const next = slewAim(offset, desired, gimbal, LASER_SLEWS[i], dt);
        return [next, Math.abs(desired) <= gimbal && Math.abs(desired - next) <= LASER_LOCK_TOLERANCE];
      };
      [w.offset, w.locked] = gun(0, w.offset);
      [w.offset2, w.locked2] = gun(1, w.offset2);
    }
  }

  /**
   * Dispara a arma SELECIONADA da nave de ataque ativa:
   * - míssil: projétil balístico na direção da mira (nariz + desvio);
   * - laser: só com a mira travada — acerto instantâneo, com traço ao alvo;
   * - mina: lançada pelo nariz; arma quando para (ver o laço de projéteis).
   */
  private tryFire(sessionId: string): void {
    const shipId = this.activeShip.get(sessionId);
    if (shipId) this.fireShip(shipId);
  }

  /** Dispara a arma selecionada da nave `shipId` (jogador ou bot atacante). */
  private fireShip(shipId: string): void {
    const ship = this.sim.ships.get(shipId);
    const owner = ship?.owner ?? "";
    // pousada, guardada ou em transição de camada não atira (combat.ts)
    if (!ship || ship.kind !== "attack" || !canFire(ship)) return;
    const w = this.weaponOf(shipId);
    const level = levelOfLayer(ship.layer);
    if (w.weapon === "laser") {
      // cada canhão TRAVADO dispara o seu feixe, da sua asa
      const guns = [w.locked, w.locked2];
      if (!guns.some(Boolean) || ship.fireCooldown > 0) return;
      const tp = this.targetPos(w.target);
      if (!tp) return;
      ship.fireCooldown = LASER_COOLDOWN;
      const on = this.sim.ships.has(w.target) ? "ship" as const
        : w.target.startsWith(WORM_PREFIX) ? undefined : "structure" as const;
      guns.forEach((locked, i) => {
        if (!locked) return;
        const m = laserMount(ship.angle, i);
        const from = { sx: ship.sx, sy: ship.sy, x: ship.x + m.dx, y: ship.y + m.dy };
        normalizePos(from);
        this.broadcast(MSG_FX, {
          kind: "laser", ...from,
          tsx: tp.sx, tsy: tp.sy, tx: tp.x, ty: tp.y, src: shipId, on, id: w.target,
        } satisfies FxEvent);
        const victim = this.sim.ships.get(w.target);
        if (victim) this.damageShip([w.target, victim], LASER_DAMAGE, false, owner);
        else if (w.target.startsWith(DRONE_PREFIX)) this.damageDrone(w.target.slice(DRONE_PREFIX.length), LASER_DAMAGE);
        else if (w.target.startsWith(WORM_PREFIX)) this.damageWorm(w.target.split(":")[1], LASER_DAMAGE, undefined, shipId);
        else {
          const st = this.sim.structures.get(w.target);
          if (st) this.damageStructure(st, LASER_DAMAGE, false, owner);
        }
      });
      return;
    }
    let speed: number;
    let dir: number;
    if (w.weapon === "missile") {
      if (ship.ammo <= 0 || ship.fireCooldown > 0) return;
      ship.ammo--;
      ship.fireCooldown = MISSILE_COOLDOWN;
      speed = MISSILE_SPEED;
      dir = ship.angle + w.offset;
    } else {
      if (ship.grenadeAmmo <= 0 || ship.grenadeCooldown > 0) return;
      ship.grenadeAmmo--;
      ship.grenadeCooldown = MINE_COOLDOWN;
      speed = MINE_SPEED;
      dir = ship.angle;
    }
    const id = `pr-${this.projSeq++}`;
    const proj: Projectile = {
      kind: w.weapon,
      owner,
      shooter: shipId,
      level,
      sx: ship.sx, sy: ship.sy,
      x: ship.x + Math.cos(dir) * 30,
      y: ship.y + Math.sin(dir) * 30,
      vx: ship.vx + Math.cos(dir) * speed,
      vy: ship.vy + Math.sin(dir) * speed,
      traveled: 0,
    };
    if (proj.kind === "mine") {
      proj.origin = { sx: proj.sx, sy: proj.sy, x: proj.x, y: proj.y };
      proj.armed = false;
      proj.age = 0;
    }
    this.projectiles.set(id, proj);
    const ps = new ProjectileSchema();
    ps.kind = proj.kind; ps.owner = owner;
    ps.sx = proj.sx; ps.sy = proj.sy;
    ps.x = proj.x; ps.y = proj.y;
    ps.vx = proj.vx; ps.vy = proj.vy;
    ps.traveled = 0;
    ps.level = proj.level;
    this.state.projectiles.set(id, ps);
  }

  /**
   * Rocha (asteroide ou Ceres) em que a mina em voo bateu, com o ponto de
   * contato na superfície — ou null. A mina anda ~75 u por tick e a menor
   * rocha tem raio bem maior: não atravessa.
   */
  private mineContact(proj: Projectile): WorldPos | null {
    const onSurface = (c: WorldPos, r: number): WorldPos | null => {
      const { dx, dy } = relVec(c, proj);
      const d = Math.hypot(dx, dy);
      if (d > r) return null;
      const k = d > 1e-6 ? r / d : 0;
      const p = { sx: c.sx, sy: c.sy, x: c.x + dx * k, y: c.y + dy * k };
      normalizePos(p);
      return p;
    };
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (const a of sectorAsteroids(this.sim.seed, proj.sx + ox, proj.sy + oy)) {
          const hit = onSurface(a, a.radius);
          if (hit) return hit;
        }
      }
    }
    return onSurface(ceresPosition(this.sim.seed), CERES_RADIUS);
  }

  /**
   * Carga/descarga do transporte pousado numa vaga da estrutura. O contexto
   * decide a operação (uma por aperto de [E]):
   * - com RAÇÕES a bordo e estrutura que recebe rações (QG/estação/base):
   *   descarrega no estoque da estrutura;
   * - com MINÉRIO a bordo na base inicial: descarrega → credita a carteira
   *   (o minério "é enviado à Terra");
   * - vazio na estação com minério em estoque: carrega minério;
   * - vazio na base inicial com rações em estoque: carrega rações.
   */
  private tryCargo(sessionId: string): void {
    const ship = this.activeShipOf(sessionId);
    if (ship?.kind === "builder") {
      this.loadBuilderOre(sessionId, ship);
      return;
    }
    // nave de mineração atracada: descarrega o porão no buffer da estrutura
    if (ship?.kind === "mining") {
      this.unloadOre(sessionId, ship);
      return;
    }
    if (!ship || ship.kind !== "transport" || !ship.anchored) return;
    const struct = this.sim.structures.get(ship.hqId);
    if (!struct || struct.owner !== sessionId) return;

    // descarrega rações em qualquer estrutura própria
    if (ship.cargoKind === "rations" && ship.cargoAmount > 0) {
      const space = RATION_STORE_CAP - struct.rationStore;
      const moved = Math.min(ship.cargoAmount, Math.max(0, space));
      if (moved <= 0) return;
      struct.rationStore += moved;
      ship.cargoAmount -= moved;
      if (ship.cargoAmount <= 0) { ship.cargoKind = ""; ship.cargoAmount = 0; }
      console.log(`[room] ${sessionId} descarregou ${Math.round(moved)} rações em ${struct.id}`);
      return;
    }

    // descarrega minério na base inicial → credita a carteira (envio à Terra)
    if (ship.cargoKind === "ore" && ship.cargoAmount > 0) {
      if (struct.type === "initialBase" || struct.type === "hq") {
        const moved = Math.min(ship.cargoAmount, Math.max(0, STRUCTURE_ORE_CAP - struct.oreStore));
        if (moved <= 0) return;
        struct.oreStore += moved;
        ship.cargoAmount -= moved;
        console.log(`[room] ${sessionId} entregou ${Math.round(moved)} de minério em ${struct.id}`);
        if (ship.cargoAmount <= 0) { ship.cargoKind = ""; ship.cargoAmount = 0; }
      } else if (struct.type === "miningStation") {
        // devolve ao estoque da estação (desistiu da viagem)
        const space = stationOreCap(struct.level) - struct.oreStore;
        const moved = Math.min(ship.cargoAmount, Math.max(0, space));
        if (moved <= 0) return;
        struct.oreStore += moved;
        ship.cargoAmount -= moved;
        if (ship.cargoAmount <= 0) { ship.cargoKind = ""; ship.cargoAmount = 0; }
      }
      return;
    }

    // porão vazio: carrega o que a estrutura oferece
    if (struct.type === "miningStation" && struct.oreStore > 0) {
      const moved = Math.min(TRANSPORT_CARGO_CAP, struct.oreStore);
      struct.oreStore -= moved;
      ship.cargoKind = "ore";
      ship.cargoAmount = moved;
      console.log(`[room] ${sessionId} carregou ${Math.round(moved)} de minério em ${struct.id}`);
      return;
    }
    if (struct.type === "initialBase" && struct.rationStore > 0) {
      const moved = Math.min(TRANSPORT_CARGO_CAP, struct.rationStore);
      struct.rationStore -= moved;
      ship.cargoKind = "rations";
      ship.cargoAmount = moved;
      console.log(`[room] ${sessionId} carregou ${Math.round(moved)} rações na base`);
    }
  }

  /**
   * Requisita um táxi: despacha uma nave guardada no hangar próprio mais
   * próximo para a estrutura onde o jogador está ancorado, se houver vaga lá.
   */
  private tryTaxi(sessionId: string, shipId?: string): void {
    // destino: a estação onde o piloto espera sem nave, ou a estrutura própria
    // em que a nave dele está atracada
    const waiting = this.sim.structures.get(this.waitingAt.get(sessionId) ?? "");
    const active = this.activeShipOf(sessionId);
    const dest = waiting ?? (active?.anchored
      ? this.sim.structures.get(active.hqId) ?? this.nearestOwnStructure(sessionId, active, DOCK_RANGE)
      : undefined);
    if (!dest || dest.owner !== sessionId) return;

    let best: { id: string; ship: ShipState; src: { id: string; sx: number; sy: number; x: number; y: number } } | null = null;

    // nave escolhida pelo jogador — guardada em QUALQUER hangar próprio
    if (shipId) {
      const s = this.sim.ships.get(shipId);
      const src = s ? this.sim.structures.get(s.hqId) : undefined;
      if (s && src && src.id !== dest.id && s.owner === sessionId && s.stored) {
        best = { id: shipId, ship: s, src };
      }
    }

    // fallback: nave guardada no hangar mais próximo da estação
    if (!best) {
      let bestDist = Infinity;
      for (const [id, s] of this.sim.ships) {
        if (s.owner !== sessionId || !s.stored) continue;
        const src = this.sim.structures.get(s.hqId);
        if (!src || src.id === dest.id) continue;
        const d = dist(src, dest);
        if (d < bestDist) {
          bestDist = d;
          best = { id, ship: s, src };
        }
      }
    }
    if (!best) return; // nenhuma nave guardada em outro hangar
    // vaga no destino compatível com a CLASSE da nave
    if (this.firstFreeShipBay(dest, best.ship.kind) < 0) return;

    // despacha: spawna DO hangar (posição do QG) e voa reto até a estação
    best.ship.stored = false;
    best.ship.anchored = false;
    best.ship.taxiTo = dest.id;
    best.ship.sx = best.src.sx;
    best.ship.sy = best.src.sy;
    best.ship.x = best.src.x;
    best.ship.y = best.src.y;
    best.ship.vx = 0;
    best.ship.vy = 0;
    console.log(`[room] ${sessionId} táxi: ${best.ship.kind} de ${best.src.id} → ${dest.id} (2x, sem colisão)`);
  }

  /**
   * Primeira vaga LIVRE da estrutura (-1 = cheio). Ocupa a vaga quem está
   * guardado nela (stored), quem está pousado sobre a placa dela (anchored) e
   * quem está a caminho dela (animação de pouso).
   * `kind` decide QUAIS vagas a nave pode ocupar:
   * - vagas EXPANDIDAS (índices 0..expandedBays-1): qualquer classe;
   * - vagas NORMAIS (índices expandedBays..shipBays-1): SOMENTE ataque e
   *   transporte.
   * Builder e mineração, portanto, só cabem nas expandidas; ataque/transporte
   * preferem as normais e TRANSBORDAM para as expandidas quando as normais
   * estão cheias, sem impedir builder/mineração de guardar (ver ordem abaixo).
   */
  private firstFreeShipBay(struct: Structure, kind: ShipKind): number {
    const taken = new Set<number>();
    for (const s of this.sim.ships.values()) {
      if (s.hqId !== struct.id || s.bay < 0) continue;
      if (s.stored || s.anchored || s.landingPhase === "landing") taken.add(s.bay);
    }
    const normalOnly = kind === "attack" || kind === "transport";
    if (normalOnly) {
      // ataque/transporte: normais primeiro, expandidas como transbordo
      for (let i = struct.expandedBays; i < struct.shipBays; i++) {
        if (!taken.has(i)) return i;
      }
      for (let i = 0; i < struct.expandedBays; i++) {
        if (!taken.has(i)) return i;
      }
    } else {
      // builder/mineração: SOMENTE expandidas
      for (let i = 0; i < struct.expandedBays; i++) {
        if (!taken.has(i)) return i;
      }
    }
    return -1;
  }


  /**
   * Tira uma nave do hangar e a pousa na placa da PRÓPRIA vaga — a guardada
   * já ocupa uma vaga, então sair do hangar não disputa lugar com ninguém.
   */
  private deployFromHangar(ship: ShipState, struct: Structure): void {
    if (ship.bay < 0) ship.bay = this.firstFreeShipBay(struct, ship.kind);
    ship.stored = false;
    this.dockAtBay(ship, struct);
  }

  /**
   * Assenta a nave, parada, no centro da sua vaga (`ship.bay`), na superfície,
   * de nariz para o CENTRO da estrutura — o prédio fica à frente do cockpit. Sem vaga válida, fica no centro da
   * estrutura — não deveria acontecer: toda estrutura tem vaga expandida.
   */
  private dockAtBay(ship: ShipState, struct: Structure): void {
    const p = ship.bay >= 0 ? this.bayPosOf(struct, ship.bay) : struct;
    ship.anchored = true;
    ship.hqId = struct.id;
    ship.anchoredAsteroidId = "";
    ship.landingPhase = "";
    ship.sx = p.sx;
    ship.sy = p.sy;
    ship.x = p.x;
    ship.y = p.y;
    ship.vx = 0;
    ship.vy = 0;
    ship.av = 0;
    const { dx, dy } = relVec(p, struct);
    ship.angle = dx === 0 && dy === 0 ? struct.angle + Math.PI : Math.atan2(dy, dx);
    ship.mining = false;
    setLayer(ship, "surface");
    // RECARGA: a nave de ataque que pousa numa vaga do próprio QG enche de
    // mísseis e minas (o laser não gasta munição)
    if (struct.type === "hq" && ship.kind === "attack" && struct.owner === ship.owner && !this.bots.has(this.shipIdOf(ship))) {
      ship.ammo = MISSILE_AMMO_MAX;
      ship.grenadeAmmo = MINE_AMMO_MAX;
    }
  }

  /** Estrutura própria MAIS PRÓXIMA (opcionalmente de um tipo) dentro de `range`. */
  private nearestOwnStructure(
    sessionId: string,
    from: ShipState,
    range: number,
    type?: "hq" | "miningStation" | "initialBase",
  ) {
    let best: ReturnType<typeof this.sim.structures.get> = undefined;
    let bestD = range;
    for (const st of this.sim.structures.values()) {
      if (st.owner !== sessionId) continue;
      if (type && st.type !== type) continue;
      const d = dist(from, st);
      if (d <= bestD) {
        bestD = d;
        best = st;
      }
    }
    return best ?? null;
  }

  /**
   * Valida e constrói uma estrutura DENTRO do asteroide mais próximo.
   * O asteroide hospedeiro deixa de colidir e só comporta uma estrutura.
   */
  private tryBuild(sessionId: string, type?: BuildCommand["type"]): void {
    const ship = this.activeShipOf(sessionId);
    if (!ship || !type) return;
    // só o builder pode construir
    if (ship.kind !== "builder") return;
    const spec = STRUCTURE_SPECS[type];
    if (!spec || !this.hasKits(ship, spec.cost)) return;

    const ast = this.sim.nearestAsteroid(ship, BUILD_ASTEROID_RANGE);
    if (!ast) return;

    // 1 estrutura por asteroide (de qualquer jogador)
    for (const st of this.sim.structures.values()) {
      if (st.asteroidId === ast.id) return;
    }

    // a estrutura vive no CENTRO do asteroide; orientação base voltada à nave
    const { dx, dy } = relVec(ast, ship);
    const angle = Math.atan2(dy, dx);

    const cls = asteroidClassOf(ast.radius);
    // vagas fixas: QG tem 2 expandidas + 4 normais; estação tem 2 expandidas
    const shipBays = type === "hq" ? HQ_SHIP_BAYS : STATION_SHIP_BAYS;
    const expandedBays = type === "hq" ? HQ_EXPANDED_BAYS : STATION_EXPANDED_BAYS;
    const spiderBays = type === "miningStation" ? STATION_SPIDER_BAYS[cls] : 0;

    this.spendKits(ship, spec.cost);
    const id = `st-${this.structSeq++}`;
    this.sim.addStructure({
      id,
      type,
      owner: sessionId,
      sx: ast.sx,
      sy: ast.sy,
      x: ast.x,
      y: ast.y,
      angle,
      asteroidId: ast.id,
      asteroidClass: cls,
      shipBays,
      expandedBays,
      spiderBays,
      nextShipBay: 0,
      nextSpiderBay: 0,
      oreStore: 0,
      rationStore: 0,
    });

    const ss = new StructureSchema();
    ss.stype = type;
    ss.owner = sessionId;
    ss.sx = ast.sx;
    ss.sy = ast.sy;
    ss.x = ast.x;
    ss.y = ast.y;
    ss.angle = angle;
    ss.asteroidId = ast.id;
    ss.asteroidClass = cls;
    ss.shipBays = shipBays;
    ss.expandedBays = expandedBays;
    ss.spiderBays = spiderBays;
    ss.nextShipBay = 0;
    ss.nextSpiderBay = 0;
    this.state.structures.set(id, ss);

    // o builder pousa na vaga livre da estrutura recém-construída (a
    // mineração na estação liga só via toggle explícito, depois)
    this.settleAfterBuild(ship, id);
    this.onBuilt(sessionId, id);
    console.log(
      `[room] ${sessionId} construiu ${type} em asteroide ${cls} (naves:${shipBays} aranhas:${spiderBays})`,
    );
  }

  /**
   * Fabrica uma nave no hangar do QG mais próximo, respeitando a capacidade.
   * Basta estar ancorado em QUALQUER estrutura própria (ex.: numa estação de
   * mineração, a nave é construída no QG mais próximo dela).
   */
  private tryProduce(sessionId: string, kind?: ProduceCommand["kind"]): void {
    if (!kind) return;
    const spec = SHIP_PRODUCTION[kind];
    if (!spec) return;
    // no QG: atracado numa nave, ou a pé (esperando nele)
    const waiting = this.sim.structures.get(this.waitingAt.get(sessionId) ?? "");
    const pilot = this.activeShipOf(sessionId);
    let hq: Structure | undefined;
    if (waiting) hq = waiting.type === "hq" ? waiting : undefined;
    else if (pilot?.anchored) hq = this.nearestOwnStructure(sessionId, pilot, Infinity, "hq") ?? undefined;
    if (!hq) return;

    // a nave é paga com o minério do BUFFER do QG
    if (hq.oreStore < spec.cost) return;
    // sem rações, o QG não fabrica (cada nave consome RATIONS_PER_SHIP)
    if (hq.rationStore < RATIONS_PER_SHIP) return;
    // capacidade = vagas de nave do QG compatíveis com a classe produzida
    const bay = this.firstFreeShipBay(hq, kind);
    if (bay < 0) return; // hangar cheio ou sem vaga compatível

    hq.oreStore -= spec.cost;
    const id = `sh-${this.shipSeq++}`;
    const ship = this.spawnShip(id, hq, sessionId, kind);
    ship.hqId = hq.id;
    ship.stored = true;
    ship.bay = bay; // vaga calculada por firstFreeShipBay
    this.state.ships.set(id, this.mirrorSpawn(ship));
    hq.rationStore -= RATIONS_PER_SHIP;
    this.stat(sessionId).produced[kind] = (this.stat(sessionId).produced[kind] ?? 0) + 1;
    this.addScore(sessionId, SCORE_POINTS.shipProduced);
    console.log(`[room] ${sessionId} fabricou ${kind} — vaga ${ship.bay} do QG ${hq.id}`);
  }

  /** Expande a arena para o próximo tamanho: 8 → 20 → 50 setores. */
  // TODO: esta função vai para a configuração ao criar a sala
  // private expandMap(): void {
  //   const cur = Math.round(this.state.mapRadius / SECTOR_SIZE);
  //   const next = cur < 20 ? 20 : cur < 50 ? 50 : 0;
  //   if (!next) return;
  //   const radiusUnits = next * SECTOR_SIZE;
  //   this.sim.setBoundary(this.arenaCenter, radiusUnits);
  //   this.state.mapRadius = radiusUnits;
  //   console.log(`[room] arena expandida: ${cur} → ${next} setores`);
  // }

  /**
   * Nave inimiga que o projétil atinge (dentro de `reach`), no mesmo nível de
   * combate dele. Em transição, guardada ou aranha: nada a atinge.
   */
  private shipHitBy(proj: Projectile, reach: number): [string, ShipState] | null {
    for (const [id, s] of this.sim.ships) {
      if (s.owner === proj.owner || hittableLevel(s) !== proj.level) continue;
      if (dist(proj, s) <= reach) return [id, s];
    }
    return null;
  }

  /**
   * Estrutura inimiga que o projétil atinge: só do nível das estações, e
   * contra o corpo do prédio (raio do tipo), não contra o asteroide inteiro.
   */
  private structureHitBy(proj: Projectile, reach: number): Structure | null {
    if (proj.level !== "surface") return null;
    for (const st of this.sim.structures.values()) {
      if (!this.hostileStructure(proj.owner, st)) continue;
      if (dist(proj, st) <= STRUCTURE_SPECS[st.type].radius + reach) return st;
    }
    return null;
  }

  /**
   * Explosão numa nave: onde ela está, ou — guardada no hangar — na placa da
   * vaga dela (é ali que o cliente desenha a silhueta da guardada).
   */
  private fxOnShip(kind: FxKind, id: string, s: ShipState): void {
    if (s.stored) {
      const st = this.sim.structures.get(s.hqId);
      const p = st && s.bay >= 0 ? this.bayPosOf(st, s.bay) : null;
      if (st && p) this.fx(kind, p, { on: "bay", id: st.id, bay: s.bay });
      return;
    }
    this.fx(kind, s, { on: "ship", id });
  }

  /**
   * Raio da parede macia da órbita do modo ataque: a borda da rocha atacada
   * (folga de metade da margem antes de a zona expulsar a nave).
   */
  private attackHoldRadius(siteRadius: number): number {
    return siteRadius + ATTACK_ZONE_MARGIN * 0.25;
  }

  /**
   * MODO ATAQUE dos jogadores: troca, a cada tick, o comando cru pela
   * tradução de attackModeInput (nariz travado na estação, A/D circulam).
   * Vale desde a descida (`layerTo` = "attack"). Os bots já pedem a
   * tradução na IA deles.
   */
  private applyAttackMode(): void {
    for (const [id, target] of this.attackTargets) {
      if (this.bots.has(id) || this.raiders.has(id)) continue;
      const ship = this.sim.ships.get(id);
      const st = this.attackSitePos(target.structId);
      if (!ship || !st) continue;
      const raw = this.rawInputs.get(id) ?? { thrust: false, turn: 0, mine: false };
      this.sim.setInput(id, attackModeInput(ship, st, this.attackHoldRadius(target.radius), raw));
    }
    // a nave PILOTADA que saiu do modo ataque volta ao comando cru (a que
    // deixou de ser pilotada fica com o que a sala lhe deu — ex.: neutro na troca)
    const piloted = new Set(this.activeShip.values());
    for (const [id, raw] of this.rawInputs) {
      if (piloted.has(id) && !this.attackTargets.has(id)) this.sim.setInput(id, raw);
    }
  }

  /** Anuncia um efeito visual aos clientes (MSG_FX) — não muda o jogo. */
  private fx(kind: FxKind, p: WorldPos, on?: Pick<FxEvent, "on" | "id" | "bay">): void {
    const ev: FxEvent = { kind, sx: p.sx, sy: p.sy, x: p.x, y: p.y, ...on };
    this.broadcast(MSG_FX, ev);
  }

  /** Explosão da mina: dano decrescente com a distância, no nível dela. */
  private detonate(proj: Projectile): void {
    this.fx("blast", proj);
    const falloff = (d: number) => MINE_DAMAGE * (1 - d / MINE_BLAST_RADIUS);
    for (const [id, s] of [...this.sim.ships]) {
      if (s.owner === proj.owner || hittableLevel(s) !== proj.level) continue;
      const d = dist(proj, s);
      if (d <= MINE_BLAST_RADIUS) this.damageShip([id, s], falloff(d), true, proj.owner);
    }
    for (const [id, d] of [...this.drones]) {
      if (proj.level !== "cruise" || d.owner === proj.owner || d.phase === "home") continue;
      const r = dist(proj, d);
      if (r <= MINE_BLAST_RADIUS) this.damageDrone(id, falloff(r), true);
    }
    // minhocas: pelo gomo exposto mais perto da explosão
    for (const [id, w] of [...this.worms]) {
      const i = this.nearestExposedSeg(w, proj);
      if (i < 0) continue;
      const r = Math.max(0, dist(proj, w.segs[i]) - wormRadiusAt(i));
      if (r <= MINE_BLAST_RADIUS) this.damageWorm(id, falloff(r), undefined, proj.shooter);
    }
    if (proj.level !== "surface") return;
    for (const st of [...this.sim.structures.values()]) {
      if (!this.hostileStructure(proj.owner, st)) continue;
      const d = Math.max(0, dist(proj, st) - STRUCTURE_SPECS[st.type].radius);
      if (d <= MINE_BLAST_RADIUS) this.damageStructure(st, falloff(d), true, proj.owner);
    }
  }

  /**
   * Tira HP da nave; em zero, ela explode. `explode`: anuncia a explosão do
   * impacto NELA (na vaga, se está guardada no hangar).
   */
  private damageShip([id, s]: [string, ShipState], damage: number, explode = false, by = ""): void {
    if (!this.sim.ships.has(id) || !(damage > 0)) return;
    if (explode) this.fxOnShip("hit", id, s);
    s.hp = Math.max(0, s.hp - damage);
    if (s.hp > 0) return;
    if (by && by !== s.owner) this.addScore(by, SCORE_POINTS.enemyShipKilled);
    this.destroyShip(id);
  }

  /**
   * Dano de um projétil numa estrutura: sorteado entre ela e as naves
   * GUARDADAS no hangar dela (`splitDamage`, com o gerador semeado da sala).
   * Nave do hangar que zera explode sozinha; estrutura que zera explode com
   * todas as que sobraram no hangar.
   */
  private damageStructure(st: Structure, damage: number, explode = false, by = ""): void {
    if (!this.sim.structures.has(st.id) || !(damage > 0)) return;
    const hangar = [...this.sim.ships]
      .filter(([, s]) => s.stored && s.hqId === st.id)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const split = splitDamage(damage, hangar.length, this.combatRng);
    // a explosão aparece em QUEM o sorteio atingiu: no prédio e/ou nas vagas
    if (explode && split.station > 0) this.fx("hit", st, { on: "structure", id: st.id });
    hangar.forEach((entry, i) => this.damageShip(entry, split.ships[i], explode, by));
    st.hp = Math.max(0, st.hp - split.station);
    if (st.hp > 0) return;
    if (by && by !== st.owner && st.owner !== RUIN_OWNER) this.addScore(by, SCORE_POINTS.enemyStructureKilled);
    this.destroyStructure(st.id);
  }

  /**
   * Estrutura destruída: explodem junto as naves guardadas no hangar e as
   * aranhas dela; as pousadas nas vagas (ou a caminho delas) decolam de volta
   * ao cruzeiro. O asteroide fica livre — sólido na superfície para todos — e
   * as naves em modo ataque sobre ele sobem sozinhas (superviseAttackMode).
   */
  private destroyStructure(id: string): void {
    const st = this.sim.structures.get(id);
    if (!st) return;
    const piloted = new Set(this.activeShip.values());
    const doomed = new Set(
      [...this.sim.ships]
        .filter(([sid, s]) =>
          (s.stored && s.hqId === id) || (s.autoMining && s.stationId === id) ||
          // a nave PILOTADA atracada nela explode junto: o jogador sai num pod
          (piloted.has(sid) && s.hqId === id && (s.anchored || s.landingPhase === "landing")))
        .map(([sid]) => sid),
    );
    this.fx("structureDown", st, { on: "structure", id: st.id });
    this.sim.structures.delete(id);
    this.state.structures.delete(id);
    this.droneUpgrades.delete(id);
    this.droneRebuild.delete(id);
    for (const [did, d] of [...this.drones]) if (d.center === id) this.removeDrone(did);
    this.turrets.delete(id);
    this.turretJobs.delete(id);
    this.repairJobs.delete(id);
    if (id === this.botHqId) this.botHqId = "";
    this.turretCooldowns.delete(id);
    // a estrutura sai ANTES das naves: se o controle de um jogador passar a
    // outra nave condenada, ela só sai do hangar (não há mais para onde
    // atracar) e explode na volta seguinte, que o passa adiante de novo — ele
    // termina numa nave que sobrevive, ou em nenhuma
    for (const sid of doomed) this.destroyShip(sid);
    // quem esperava a pé nela é expelido num escape pod
    for (const [sid, at] of [...this.waitingAt]) {
      if (at !== id) continue;
      this.waitingAt.delete(sid);
      this.ejectPlayer(sid, st);
    }
    for (const s of this.sim.ships.values()) {
      if (s.hqId === id && !s.stored && (s.anchored || s.landingPhase === "landing")) this.liftOff(s);
    }
    console.log(`[room] estrutura ${id} (${st.type}) de ${st.owner} destruída — ${doomed.size} nave(s) junto`);
  }

  /** Destrói uma nave (remove do mundo; se for a nave ativa de um jogador, passa o controle a outra dele). */
  private destroyShip(shipId: string): void {
    const ship = this.sim.ships.get(shipId);
    if (!ship) return;
    // a guardada explode na VAGA dela, dentro do hangar
    this.fxOnShip("shipDown", shipId, ship);
    // a vaga dela fica livre já: o builder de reposição pode nascer nela
    ship.bay = -1;
    ship.anchored = false;
    ship.stored = false;
    for (const [sid, active] of this.activeShip) {
      if (active === shipId) {
        // o jogador é EXPELIDO num escape pod, que voa sozinho até um QG
        // (ou um builder guardado); sem destino, fim de jogo — ver ejectPlayer
        if (ship.kind !== "pod") this.ejectPlayer(sid, ship);
        break;
      }
    }
    this.sim.removeShip(shipId);
    this.spiders.delete(shipId);
    this.attackTargets.delete(shipId);
    this.weapons.delete(shipId);
    this.bots.delete(shipId);
    this.rawInputs.delete(shipId);
    this.freighters.delete(shipId);
    this.state.ships.delete(shipId);
    console.log(`[room] nave ${shipId} destruída`);
  }

  // ── entrega automática dos transportes ─────────────────────────────

  /**
   * [G] no transporte atracado: entra em ENTREGA AUTOMÁTICA, em laço —
   *  - numa estação de mineração: minério da estação → base inicial (que o
   *    credita na carteira);
   *  - na base inicial: rações da base → central de rações.
   * O piloto desembarca: vai para a próxima nave do hangar dali, ou fica a pé.
   */
  private tryAutoTransport(sessionId: string): void {
    const shipId = this.activeShip.get(sessionId);
    const ship = this.activeShipOf(sessionId);
    if (!shipId || !ship || ship.kind !== "transport" || !ship.anchored) return;
    const st = this.sim.structures.get(ship.hqId);
    if (!st || st.owner !== sessionId) return;
    const own = [...this.sim.structures.values()].filter((x) => x.owner === sessionId);
    const nearestOf = (type: StructureType) => own.filter((x) => x.type === type)
      .sort((a, b) => dist(st, a) - dist(st, b))[0];
    let mode: Freighter["mode"];
    let dest: Structure | undefined;
    if (st.type === "miningStation") { mode = "ore"; dest = nearestOf("hq") ?? nearestOf("initialBase"); }
    else if (st.type === "initialBase") { mode = "rations"; dest = nearestOf("rationCenter"); }
    else return;
    if (!dest) return;
    this.freighters.set(shipId, { mode, pickup: st.id, dest: dest.id, leg: "load" });
    // o piloto desembarca: próxima nave do hangar daqui, ou a pé
    this.activeShip.delete(sessionId);
    const here = [...this.sim.ships]
      .filter(([, x]) => x.owner === sessionId && x.hqId === st.id && x.stored)
      .sort(([, a], [, b]) => a.bay - b.bay);
    if (here.length > 0) this.boardShip(sessionId, here[0][0], here[0][1], st);
    else this.waitingAt.set(sessionId, st.id);
    console.log(`[room] ${sessionId} transporte ${shipId} em entrega automática de ${mode}: ${st.id} ⇄ ${dest.id}`);
  }

  /**
   * Um passo das rotas: atracado no ponto de coleta, carrega o que houver
   * (até TRANSPORT_CARGO_CAP) e decola; no destino, descarrega e volta;
   * de volta, atraca numa vaga livre e recomeça. Destino perdido: volta e
   * PARA no ponto de coleta. Ponto de coleta perdido: a rota acaba ali.
   * Voa pelo corredor do táxi (sem colisão, 2×).
   */
  private stepFreighters(): void {
    for (const [id, f] of [...this.freighters]) {
      const ship = this.sim.ships.get(id);
      const pickup = this.sim.structures.get(f.pickup);
      if (!ship || !pickup || pickup.owner !== ship.owner) {
        if (ship) ship.taxiTo = "";
        this.freighters.delete(id);
        continue;
      }
      const dest = this.sim.structures.get(f.dest);
      const destOk = !!dest && dest.owner === ship.owner;
      if (f.leg === "load") {
        if (!destOk) {
          this.freighters.delete(id); // para aqui, atracado
          continue;
        }
        const avail = Math.floor(f.mode === "ore" ? pickup.oreStore : pickup.rationStore);
        if (avail < 1 || !ship.anchored) continue; // espera carga
        const amount = Math.min(TRANSPORT_CARGO_CAP, avail);
        if (f.mode === "ore") pickup.oreStore -= amount;
        else pickup.rationStore -= amount;
        ship.cargoKind = f.mode;
        ship.cargoAmount = amount;
        this.liftOff(ship);
        ship.taxiTo = dest!.id;
        f.leg = "out";
        continue;
      }
      if (f.leg === "out") {
        if (!destOk) {
          f.leg = "back";
          ship.taxiTo = pickup.id;
          continue;
        }
        if (dist(ship, dest!) > DOCK_RANGE) {
          this.sim.setInput(id, computeTaxiInput(ship, dest!));
          continue;
        }
        if (f.mode === "ore") dest!.oreStore = Math.min(STRUCTURE_ORE_CAP, dest!.oreStore + ship.cargoAmount);
        else dest!.rationStore = Math.min(RATION_STORE_CAP, dest!.rationStore + ship.cargoAmount);
        ship.cargoKind = "";
        ship.cargoAmount = 0;
        f.leg = "back";
        ship.taxiTo = pickup.id;
        continue;
      }
      // volta ao ponto de coleta
      if (dist(ship, pickup) > DOCK_RANGE) {
        this.sim.setInput(id, computeTaxiInput(ship, pickup));
        continue;
      }
      const bay = this.firstFreeShipBay(pickup, ship.kind);
      if (bay < 0) {
        this.sim.setInput(id, { thrust: false, turn: 0, mine: false }); // espera vaga
        continue;
      }
      ship.taxiTo = "";
      ship.bay = bay;
      this.dockAtBay(ship, pickup);
      // carga que não chegou (destino perdido) volta ao estoque
      if (ship.cargoAmount > 0) {
        if (f.mode === "ore") pickup.oreStore += ship.cargoAmount;
        else pickup.rationStore = Math.min(RATION_STORE_CAP, pickup.rationStore + ship.cargoAmount);
        ship.cargoKind = "";
        ship.cargoAmount = 0;
      }
      f.leg = "load";
      if (!destOk) this.freighters.delete(id);
    }
  }

  // ── jogadores-bot (playerBot.ts) ─────────────────────────────────

  /** O que o jogador-bot pode fazer: as ações das teclas e os atalhos de frota. */
  private botHost(): PlayerBotHost {
    return {
      sim: this.sim,
      elapsed: () => this.elapsed,
      active: (sid) => {
        const id = this.activeShip.get(sid);
        const ship = id ? this.sim.ships.get(id) : undefined;
        return id && ship ? { id, ship } : null;
      },
      anchor: (sid) => this.tryToggleAnchor(sid),
      landAction: (sid, action) => this.tryLandAction(sid, action),
      refine: (sid) => this.tryCargo(sid),
      transfer: (sid, item, dir) => this.tryTransfer(sid, item, dir),
      produce: (sid, kind) => this.tryProduce(sid, kind),
      turret: (sid) => this.tryBuildTurret(sid),
      input: (sid, input) => {
        const id = this.activeShip.get(sid);
        if (!id) return;
        this.rawInputs.set(id, input);
        this.sim.setInput(id, input);
      },
      startFreighter: (shipId, mode, pickupId, destId) => this.startFreighter(shipId, mode, pickupId, destId),
      freighterMode: (shipId) => this.freighters.get(shipId)?.mode ?? null,
      launchRaid: (sid, shipIds, targetId, seconds) => this.launchRaid(sid, shipIds, targetId, seconds),
      isRaiding: (shipId) => this.raiders.has(shipId),
      turrets: (structId) => (this.turrets.get(structId) ?? 0) + (this.turretJobs.has(structId) ? 1 : 0),
      turretInProgress: (structId) => this.turretJobs.has(structId),
      upgrade: (sid) => this.tryUpgrade(sid),
      droneUpgrade: (sid, track) => this.tryDroneUpgrade(sid, track),
      droneLevels: (centerId) => this.droneUpgrades.get(centerId) ?? { drones: 0, speed: 0, cargo: 0 },
      repair: (sid) => this.tryRepair(sid),
      isRepairing: (structId) => this.repairJobs.has(structId),
      sendSpider: (shipId, stationId) => this.sendSpider(shipId, stationId),
      isBusyMiner: (shipId) => this.ferries.has(shipId) || !!this.sim.ships.get(shipId)?.autoMining,
      hole: () => (this.hole ? { padId: this.hole.padId, seal: this.hole.seal } : null),
      quakeStation: () => this.quake?.stationId ?? "",
      wormsOut: () => [...this.worms.values()].filter((w) => w.den < 0).length,
      wormDistance: (p) => Math.min(Infinity, ...[...this.worms.values()].filter((w) => w.den < 0).map((w) => dist(w, p))),
      launchMission: (sid, shipIds, kind, seconds) => this.launchMission(sid, shipIds, kind, seconds),
      mission: (shipId) => this.raiders.get(shipId)?.kind ?? null,
      wormKills: (sid) => this.state.players.get(sid)?.wormKills ?? 0,
      waitingAt: (sid) => this.waitingAt.get(sid) ?? "",
      board: (sid) => this.trySwap(sid),
      isHuman: (owner) => this.state.players.has(owner) && !this.playerBots.some((b) => b.sid === owner),
      log: (msg) => console.log(`[pbot] ${msg}`),
    };
  }

  /**
   * Põe um transporte numa rota automática sem ser a nave ativa (o [G] do
   * jogador exige pilotá-lo até o ponto de coleta): sai do hangar, decola e
   * vai pelo corredor do táxi até o ponto de coleta, onde a rota começa.
   */
  private startFreighter(shipId: string, mode: Freighter["mode"], pickupId: string, destId: string): boolean {
    const ship = this.sim.ships.get(shipId);
    const pickup = this.sim.structures.get(pickupId);
    const dest = this.sim.structures.get(destId);
    if (!ship || ship.kind !== "transport" || !pickup || !dest || this.freighters.has(shipId)) return false;
    if (ship.anchored && !ship.stored && ship.hqId === pickupId) {
      this.freighters.set(shipId, { mode, pickup: pickupId, dest: destId, leg: "load" });
      return true;
    }
    const host = this.sim.structures.get(ship.hqId);
    if (ship.stored && host) this.deployFromHangar(ship, host);
    if (ship.anchored) this.liftOff(ship);
    ship.taxiTo = pickupId;
    this.freighters.set(shipId, { mode, pickup: pickupId, dest: destId, leg: "back" });
    return true;
  }

  /**
   * Manda uma nave de mineração do jogador-bot virar aranha numa estação: sai
   * do hangar, voa pelo corredor do táxi e, chegando, vira aranha (stepFerries).
   */
  private sendSpider(shipId: string, stationId: string): boolean {
    const ship = this.sim.ships.get(shipId);
    const station = this.sim.structures.get(stationId);
    if (!ship || ship.kind !== "mining" || ship.autoMining || this.ferries.has(shipId)) return false;
    if (!station || station.type !== "miningStation" || station.owner !== ship.owner) return false;
    if (station.nextSpiderBay >= station.spiderBays) return false;
    const host = this.sim.structures.get(ship.hqId);
    if (ship.stored && host) this.deployFromHangar(ship, host);
    if (ship.anchored) this.liftOff(ship);
    ship.taxiTo = stationId;
    this.ferries.set(shipId, stationId);
    return true;
  }

  private stepFerries(): void {
    for (const [id, stationId] of [...this.ferries]) {
      const ship = this.sim.ships.get(id);
      const station = this.sim.structures.get(stationId);
      if (!ship || !station || station.owner !== ship.owner) {
        if (ship) ship.taxiTo = "";
        this.ferries.delete(id);
        continue;
      }
      if (dist(ship, station) > DOCK_RANGE) {
        this.sim.setInput(id, computeTaxiInput(ship, station));
        continue;
      }
      this.ferries.delete(id);
      if (!this.makeSpider(id, ship, station)) {
        ship.taxiTo = "";
        if (!this.landAtBay(ship, station)) this.sim.setInput(id, { thrust: false, turn: 0, mine: false });
      }
    }
  }

  /**
   * Missões das naves de ataque do jogador-bot além da incursão: caçar a
   * minhoca que está fora da toca ("worm") ou tapar a toca ("seal": minas no
   * buraco e um míssil nelas). Voltam ao QG ao fim (stepRaiders).
   */
  private launchMission(ownerSid: string, shipIds: string[], kind: "worm" | "seal", seconds: number): void {
    for (const id of shipIds) {
      const ship = this.sim.ships.get(id);
      if (!ship || ship.owner !== ownerSid || ship.kind !== "attack" || this.raiders.has(id)) continue;
      const home = this.sim.structures.get(ship.hqId);
      if (!home) continue;
      if (ship.stored) this.deployFromHangar(ship, home);
      this.liftOff(ship);
      const bot = makeBotState();
      bot.phase = "raid";
      this.raiders.set(id, { bot, target: "", until: this.elapsed + seconds, home: home.id, kind });
    }
  }

  /**
   * TAPAR A TOCA (missão "seal"): chega à toca em cruzeiro, desce ao modo
   * ataque sobre ela, lança minas até o buraco ter as que faltam e dispara um
   * míssil nelas com a mira assentada. null = missão acabou (toca tapada,
   * sem munição ou sem tempo).
   */
  private sealInput(id: string, ship: ShipState, r: { bot: BotState; until: number }): ShipInput | null {
    const idle: ShipInput = { thrust: false, turn: 0, mine: false };
    const hole = this.hole;
    if (!hole || this.elapsed >= r.until) return null;
    if (ship.layerTo) return idle;
    if (ship.layer === "cruise") {
      if (dist(ship, hole.pos) <= hole.radius + ATTACK_ZONE_MARGIN * 0.5) {
        beginLayerChange(ship, "attack");
        this.attackTargets.set(id, { structId: WORM_HOLE_ID, radius: hole.radius });
        return idle;
      }
      return seekInput(ship, hole.pos, { arriveRadius: hole.radius * 0.8 });
    }
    if (!this.attackTargets.has(id)) this.attackTargets.set(id, { structId: WORM_HOLE_ID, radius: hole.radius });
    const input = attackModeInput(ship, hole.pos, this.attackHoldRadius(hole.radius), idle);
    const w = this.weaponOf(id);
    const mines = [...this.projectiles.values()];
    const inHole = mines.filter((p) => p.inHole).length;
    const flying = mines.some((p) => p.kind === "mine" && p.shooter === id && !p.armed);
    if (inHole + (flying ? 1 : 0) < WORM_HOLE_SEAL_MINES - hole.seal) {
      if (ship.grenadeAmmo <= 0) return null;
      w.weapon = "mine";
      if (!flying && ship.grenadeCooldown <= 0) this.fireShip(id);
      return input;
    }
    if (flying) return input; // espera a última mina parar no buraco
    if (w.weapon !== "missile") {
      w.weapon = "missile";
      w.offset = 0;
    }
    if (ship.ammo <= 0) return null;
    const tp = w.target.startsWith(MINE_PREFIX) ? this.targetPos(w.target) : null;
    if (tp && this.elapsed >= r.bot.nextShot && ship.fireCooldown <= 0) {
      const err = Math.abs(desiredOffset(ship, { id: w.target, pos: tp, vx: 0, vy: 0 }, "missile") - w.offset);
      if (err < BOT_AIM_TOLERANCE * 2) {
        this.fireShip(id);
        r.bot.nextShot = this.elapsed + 1.5;
      }
    }
    return input;
  }

  /** Lança as naves de ataque do jogador-bot contra a estrutura `targetId` por `seconds` s. */
  private launchRaid(ownerSid: string, shipIds: string[], targetId: string, seconds: number): void {
    for (const id of shipIds) {
      const ship = this.sim.ships.get(id);
      if (!ship || ship.owner !== ownerSid || ship.kind !== "attack" || this.raiders.has(id)) continue;
      const home = this.sim.structures.get(ship.hqId);
      if (!home) continue;
      if (ship.stored) this.deployFromHangar(ship, home);
      this.liftOff(ship);
      const bot = makeBotState();
      bot.phase = "raid";
      this.raiders.set(id, { bot, target: targetId, until: this.elapsed + seconds, home: home.id, kind: "raid" });
    }
  }

  /**
   * Incursões: cada nave voa até o alvo, desce ao modo ataque e dispara (a
   * mesma pilotagem dos bots, raidInput); vencido o prazo, sem munição ou sem
   * alvo, volta ao QG, pousa numa vaga (e recarrega lá) e sai da incursão.
   */
  private stepRaiders(): void {
    const idle: ShipInput = { thrust: false, turn: 0, mine: false };
    for (const [id, r] of [...this.raiders]) {
      const ship = this.sim.ships.get(id);
      const home = this.sim.structures.get(r.home);
      if (!ship || !home || home.owner !== ship.owner) {
        this.raiders.delete(id);
        continue;
      }
      if (ship.landingPhase !== "") {
        this.sim.setInput(id, idle);
        continue;
      }
      if (ship.anchored) {
        // pousou de volta no QG (e recarregou): incursão encerrada
        if (r.bot.phase !== "raid") this.raiders.delete(id);
        continue;
      }
      if (r.bot.phase === "raid" && r.kind === "worm") {
        const seg = ship.ammo > 0 && this.elapsed < r.until ? this.botWormTarget(ship) : null;
        if (seg) {
          this.sim.setInput(id, this.wormRaidInput(id, ship, r.bot, seg));
          continue;
        }
      } else if (r.bot.phase === "raid" && r.kind === "seal") {
        const input = this.sealInput(id, ship, r);
        if (input) {
          this.sim.setInput(id, input);
          continue;
        }
      } else {
        const target = this.sim.structures.get(r.target);
        if (r.bot.phase === "raid" && this.elapsed < r.until && ship.ammo > 0 && target && this.hostileStructure(ship.owner, target)) {
          this.sim.setInput(id, this.raidInput(id, ship, r.bot, target));
          continue;
        }
      }
      // volta ao QG
      r.bot.phase = "return";
      if (ship.layerTo) {
        this.sim.setInput(id, idle);
        continue;
      }
      if (ship.layer !== "cruise") {
        this.leaveAttack(id, ship);
        this.sim.setInput(id, idle);
        continue;
      }
      if (dist(ship, home) <= DOCK_RANGE && this.landAtBay(ship, home)) {
        this.sim.setInput(id, idle);
        continue;
      }
      this.sim.setInput(id, seekInput(ship, home, { arriveRadius: DOCK_RANGE * 0.5 }));
    }
  }

  // ── drones de ração (logistics.ts) ───────────────────────────────

  private spawnDrone(center: Structure): void {
    const id = `dr-${this.droneSeq++}`;
    this.drones.set(id, {
      id, owner: center.owner, center: center.id,
      sx: center.sx, sy: center.sy, x: center.x, y: center.y, angle: 0,
      phase: "home", target: "", cargo: 0, hp: DRONE_HP,
    });
  }

  private removeDrone(id: string): void {
    this.drones.delete(id);
    this.state.drones.delete(id);
  }

  /** Drone inimigo (em voo, no cruzeiro) ao alcance do projétil. */
  private droneHitBy(proj: Projectile, reach: number): string | null {
    if (proj.level !== "cruise") return null;
    for (const [id, d] of this.drones) {
      if (d.owner === proj.owner || d.phase === "home") continue;
      if (dist(proj, d) <= reach) return id;
    }
    return null;
  }

  /** Dano num drone; abatido, a carga se perde e a central o repõe depois. */
  private damageDrone(id: string, damage: number, explode = false): void {
    const d = this.drones.get(id);
    if (!d || !(damage > 0)) return;
    if (explode) this.fx("hit", d);
    d.hp -= damage;
    if (d.hp > 0) return;
    this.fx("shipDown", d);
    this.removeDrone(id);
    console.log(`[room] drone ${id} de ${d.center} abatido`);
  }

  /**
   * [1]/[2]/[3] com o builder atracado na central de rações própria: compra
   * o próximo nível de uma melhoria dos drones (número, velocidade, carga),
   * pagando kits do porão.
   */
  private tryDroneUpgrade(sessionId: string, track?: DroneTrack): void {
    if (!track || !DRONE_TRACKS.includes(track)) return;
    const ship = this.activeShipOf(sessionId);
    if (!ship || ship.kind !== "builder" || !ship.anchored) return;
    const st = this.sim.structures.get(ship.hqId);
    if (!st || st.owner !== sessionId || st.type !== "rationCenter") return;
    const lv = this.droneUpgrades.get(st.id) ?? { drones: 0, speed: 0, cargo: 0 };
    const cost = droneUpgradeCost(lv[track]);
    if (cost === null || !this.spendKits(ship, cost)) return;
    lv[track]++;
    this.droneUpgrades.set(st.id, lv);
    if (track === "drones") this.spawnDrone(st); // o drone novo sai na hora
    console.log(`[room] ${sessionId} melhorou ${track} dos drones de ${st.id} → nível ${lv[track]}`);
  }

  /**
   * Frota de drones de cada central: em casa, carrega e sai para a estação
   * ou QG do dono mais necessitado (menos rações, contando o que já está a
   * caminho); entrega e volta. Voa reto, no cruzeiro, na velocidade da
   * melhoria. A central repõe um drone abatido após DRONE_REBUILD_TIME.
   */
  private stepDrones(dt: number): void {
    // reposição
    for (const [id, center] of this.sim.structures) {
      if (center.type !== "rationCenter" || center.owner === RUIN_OWNER) continue;
      const lv = this.droneUpgrades.get(id) ?? { drones: 0, speed: 0, cargo: 0 };
      if (!this.droneUpgrades.has(id)) this.droneUpgrades.set(id, lv);
      const have = [...this.drones.values()].filter((d) => d.center === id).length;
      if (have >= droneStats(lv).count) {
        this.droneRebuild.delete(id);
        continue;
      }
      const t = (this.droneRebuild.get(id) ?? DRONE_REBUILD_TIME) - dt;
      if (t > 0) this.droneRebuild.set(id, t);
      else {
        this.droneRebuild.delete(id);
        this.spawnDrone(center);
      }
    }
    const incoming = new Map<string, number>();
    for (const d of this.drones.values()) if (d.phase === "out") incoming.set(d.target, (incoming.get(d.target) ?? 0) + d.cargo);
    for (const [id, d] of [...this.drones]) {
      const center = this.sim.structures.get(d.center);
      if (!center || center.owner !== d.owner) {
        this.removeDrone(id);
        continue;
      }
      const stats = droneStats(this.droneUpgrades.get(center.id) ?? { drones: 0, speed: 0, cargo: 0 });
      if (d.phase === "home") {
        Object.assign(d, { sx: center.sx, sy: center.sy, x: center.x, y: center.y });
        if (center.rationStore < 1) continue;
        let best: Structure | null = null;
        let need = Infinity;
        for (const st of this.sim.structures.values()) {
          if (st.owner !== d.owner || (st.type !== "miningStation" && st.type !== "hq")) continue;
          const level = st.rationStore + (incoming.get(st.id) ?? 0);
          if (level >= RATION_STORE_CAP) continue;
          if (level < need) { need = level; best = st; }
        }
        if (!best) continue;
        d.cargo = Math.min(stats.cargo, center.rationStore, RATION_STORE_CAP - need);
        if (d.cargo <= 0) continue;
        center.rationStore -= d.cargo;
        d.target = best.id;
        d.phase = "out";
        incoming.set(best.id, need + d.cargo);
        continue;
      }
      // em voo: para o alvo (ida) ou para casa (volta)
      const dest = d.phase === "out" ? this.sim.structures.get(d.target) : center;
      if (!dest || dest.owner !== d.owner) {
        d.phase = "back";
        continue;
      }
      const { dx, dy } = relVec(d, dest);
      const r = Math.hypot(dx, dy);
      const step = stats.speed * dt;
      if (r > step) {
        d.x += (dx / r) * step;
        d.y += (dy / r) * step;
        d.angle = Math.atan2(dy, dx);
        normalizePos(d);
        continue;
      }
      if (d.phase === "out") {
        dest.rationStore = Math.min(RATION_STORE_CAP, dest.rationStore + d.cargo);
        d.cargo = 0;
        d.phase = "back";
      } else {
        // em casa: o que sobrou (alvo perdido no caminho) volta ao estoque
        center.rationStore = Math.min(RATION_STORE_CAP, center.rationStore + d.cargo);
        d.cargo = 0;
        d.phase = "home";
      }
    }
    // espelho: só os drones em voo aparecem
    for (const [id, d] of this.drones) {
      if (d.phase === "home") {
        this.state.drones.delete(id);
        continue;
      }
      let ds = this.state.drones.get(id);
      if (!ds) {
        ds = new DroneSchema();
        ds.owner = d.owner;
        ds.center = d.center;
        this.state.drones.set(id, ds);
      }
      ds.sx = d.sx; ds.sy = d.sy; ds.x = d.x; ds.y = d.y;
      ds.angle = d.angle;
      ds.cargo = d.cargo;
    }
  }

  // ── minhocas gigantes (shared/worms.ts) ───────────────────────────

  /**
   * Tremores (stepQuake) e, com a TOCA aberta (breachNest), uma minhoca nova a
   * cada WORM_SPAWN_INTERVAL (até WORM_MAX vivas — morta ou recolhida uma, a
   * próxima espera o intervalo inteiro).
   */
  private stepWorms(dt: number): void {
    this.stepQuake(dt);
    if (this.hole) {
      if (this.worms.size >= WORM_MAX) this.nestTimer = WORM_SPAWN_INTERVAL;
      else if ((this.nestTimer -= dt) <= 0) {
        this.spawnWorm();
        this.nestTimer = WORM_SPAWN_INTERVAL;
      }
    }
    this.state.wormHole = this.hole?.padId ?? "";
    this.state.wormHoleSeal = this.hole?.seal ?? 0;
    for (const [id, t] of [...this.wormBodyHits]) {
      if (t - dt <= 0) this.wormBodyHits.delete(id);
      else this.wormBodyHits.set(id, t - dt);
    }
    for (const [id, w] of [...this.worms]) this.stepWorm(id, w, dt);
    // espelho: só as que estão fora da toca
    for (const id of [...this.state.worms.keys()]) if (!(this.worms.get(id)?.den === -1)) this.state.worms.delete(id);
    for (const [id, w] of this.worms) {
      if (w.den >= 0) continue;
      let ws = this.state.worms.get(id);
      if (!ws) {
        ws = new WormSchema();
        this.state.worms.set(id, ws);
      }
      ws.sx = w.sx; ws.sy = w.sy; ws.x = w.x; ws.y = w.y;
      ws.angle = w.angle; ws.hp = w.hp;
      ws.breach = w.breach; ws.mouth = w.mouth;
      for (let i = 1; i < w.segs.length; i++) {
        const { dx, dy } = relVec(w, w.segs[i]);
        const k = (i - 1) * 2;
        if (ws.segs.length <= k) ws.segs.push(dx, dy);
        else { ws.segs[k] = dx; ws.segs[k + 1] = dy; }
      }
    }
  }

  /** O ninho ACORDA com o nível WORM_WAKE_LEVEL numa estação de Ceres: começam os tremores. */
  private startQuake(st: Structure): void {
    this.quake = { stationId: st.id, padId: st.asteroidId, owner: st.owner, t: 0 };
    console.log(`[room] o ninho de Ceres acordou sob ${st.id}: tremores`);
  }

  /**
   * Tremores: alerta ao dono em WORM_QUAKE_WARN_TIME e WORM_QUAKE_DANGER_TIME;
   * em WORM_QUAKE_BREACH_TIME a minhoca rompe a cratera (breachNest).
   */
  private stepQuake(dt: number): void {
    const q = this.quake;
    if (!q) return;
    const t0 = q.t;
    q.t += dt;
    const crossed = (at: number) => t0 < at && q.t >= at;
    if (crossed(WORM_QUAKE_WARN_TIME)) {
      this.alert(q.owner, { text: "Sua estação de mineração em Ceres sente tremores", level: "warn" });
    }
    if (crossed(WORM_QUAKE_DANGER_TIME)) {
      this.alert(q.owner, { text: "A estação de mineração está em perigo! Evacuar", level: "danger" });
    }
    if (q.t >= WORM_QUAKE_BREACH_TIME) this.breachNest(q);
  }

  /** Alerta a um jogador (faixa no centro da tela e alarme). */
  private alert(sessionId: string, ev: AlertEvent): void {
    for (const c of this.clients ?? []) if (c.sessionId === sessionId) c.send(MSG_ALERT, ev);
  }

  /**
   * A minhoca ROMPE a cratera: a estação explode com as naves do hangar (e a
   * que ficou atracada nela — o alerta mandou evacuar), a cratera fica como a
   * TOCA e a primeira minhoca sai dela na hora.
   */
  private breachNest(q: { stationId: string; padId: string }): void {
    this.quake = null;
    const pad = ceresPlatforms(this.sim.seed).find((p) => p.id === q.padId);
    if (!pad) return;
    if (this.sim.structures.has(q.stationId)) this.destroyStructure(q.stationId);
    this.hole = { padId: pad.id, pos: ceresPlatformPos(this.sim.seed, pad), radius: pad.radius, seal: 0 };
    this.spawnWorm();
    this.nestTimer = WORM_SPAWN_INTERVAL;
    console.log(`[room] a minhoca rompeu a cratera em ${pad.id}: a toca está aberta`);
  }

  /** Mina parada no buraco da toca ao alcance do míssil. */
  private holeMineHitBy(proj: Projectile): boolean {
    if (proj.level !== "surface") return false;
    for (const p of this.projectiles.values()) if (p.inHole && dist(proj, p) <= MISSILE_RADIUS + 60) return true;
    return false;
  }

  /**
   * Detonação no buraco da toca: uma mina leva todas as que estão nele, e
   * cada uma conta para tapá-lo; somadas WORM_HOLE_SEAL_MINES, a toca desaba.
   */
  private blastHole(): void {
    let n = 0;
    for (const [pid, p] of [...this.projectiles]) {
      if (!p.inHole) continue;
      this.projectiles.delete(pid);
      this.state.projectiles.delete(pid);
      this.detonate(p);
      n++;
    }
    const hole = this.hole;
    if (!hole || n === 0) return;
    hole.seal += n;
    console.log(`[room] ${n} mina(s) detonada(s) na toca (${hole.seal}/${WORM_HOLE_SEAL_MINES})`);
    if (hole.seal < WORM_HOLE_SEAL_MINES) return;
    // TAPADA: nenhuma minhoca sai mais; as de fora se enterram em Ceres ao fim
    // da ronda, e a plataforma volta a aceitar construção
    this.fx("structureDown", hole.pos);
    this.hole = null;
    this.nestTimer = 0;
    console.log(`[room] a toca das minhocas em ${hole.padId} foi tapada`);
  }

  /** Uma minhoca sai da toca (ou do núcleo de Ceres, sem toca), num rumo qualquer. */
  spawnWorm(): string {
    const id = `worm-${this.wormSeq++}`;
    const w = makeWorm(this.hole?.pos ?? ceresPosition(this.sim.seed), this.combatRng() * Math.PI * 2);
    this.worms.set(id, w);
    console.log(`[room] minhoca ${id} saiu do ninho de Ceres`);
    return id;
  }

  private removeWorm(id: string): void {
    this.worms.delete(id);
    this.state.worms.delete(id);
  }

  /** Nave que a minhoca pode engolir: no mundo (não guardada) e não um pod. */
  private wormEdible(s: ShipState): boolean {
    return !s.stored && s.kind !== "pod";
  }

  /** O alvo `id` da minhoca (nave ou estrutura), com o raio do corpo dele, ou null se sumiu. */
  private wormTarget(id: string): { pos: WorldPos; radius: number; struct?: Structure } | null {
    const s = this.sim.ships.get(id);
    if (s) return this.wormEdible(s) ? { pos: s, radius: SHIP_RADIUS } : null;
    const st = this.sim.structures.get(id);
    if (st && st.owner !== RUIN_OWNER) return { pos: st, radius: STRUCTURE_SPECS[st.type].radius, struct: st };
    return null;
  }

  /** Presa mais perto da cabeça, ao alcance do faro: estruturas e naves de jogadores e dos bots. */
  private wormPickTarget(w: Worm): string {
    // VINGANÇA: quem a feriu há pouco, o mais perto
    let best = "";
    let bd = Infinity;
    for (const [aid, at] of [...w.attackers]) {
      if (this.elapsed - at > WORM_REVENGE_MEMORY) {
        w.attackers.delete(aid);
        continue;
      }
      const t = this.wormTarget(aid);
      if (!t) continue;
      const d = dist(w, t.pos);
      if (d < bd) { bd = d; best = aid; }
    }
    if (best) return best;
    bd = WORM_SENSE_RANGE;
    for (const [id, s] of this.sim.ships) {
      if (!this.wormEdible(s)) continue;
      const d = dist(w, s);
      if (d < bd) { bd = d; best = id; }
    }
    for (const [id, st] of this.sim.structures) {
      if (st.owner === RUIN_OWNER || w.besieged.has(id)) continue;
      const d = dist(w, st);
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }

  /**
   * Um passo da minhoca: durante a ronda (WORM_ROAM_TIME) caça a presa mais
   * perto (reavaliada a cada 1 s) — desacelera perto dela e quando ela está
   * para trás, para fazer a curva — e, sem presa ao alcance, vagueia; acabada
   * a ronda, volta para a toca e entra. Estrutura ela CERCA (circula raspando
   * por WORM_SIEGE_TIME); a CABEÇA engole a nave que alcança; o CORPO EXPOSTO
   * fere quem bate nele.
   */
  private stepWorm(id: string, w: Worm, dt: number): void {
    const seed = this.sim.seed;
    // DENTRO DA TOCA: descansa; tapada a toca, fica presa lá para sempre
    if (w.den >= 0) {
      if (!this.hole) {
        this.removeWorm(id);
        return;
      }
      w.den -= dt;
      if (w.den <= 0) this.emergeWorm(w, this.hole.pos);
      return;
    }
    w.bite = Math.max(0, w.bite - dt);
    w.roam -= dt;
    w.retarget -= dt;
    if (w.roam <= 0) w.target = "";
    // cercando, mantém o alvo (o afastamento entre investidas não é desistência;
    // só a vingança — damageWorm — ou o alvo sumir interrompem)
    else if ((w.retarget <= 0 && w.siege < 0) || !this.wormTarget(w.target)) {
      const next = this.wormPickTarget(w);
      if (next !== w.target) {
        w.siege = -1;
        w.pass = "in";
      }
      w.target = next;
      w.retarget = 1;
    }
    const tp = this.wormTarget(w.target);
    let near = false;
    if (tp) {
      // caçando: a excursão em curso perde o sentido
      w.route = [];
      w.back = [];
      w.away = false;
    }
    if (tp?.struct) {
      // INVESTIDAS: vai na estrutura, TOCA nela (dano sorteado entre o prédio
      // e o hangar), passa direto e se afasta; a WORM_RAM_RETREAT dá a volta e
      // investe de novo — enquanto durar o cerco
      const st = tp.struct;
      const d = dist(w, st);
      near = d < tp.radius + 1500;
      if (w.pass === "out") {
        moveWorm(w, null, WORM_SPEED, dt); // segue reto, afastando-se
        if (d >= tp.radius + WORM_RAM_RETREAT) w.pass = "in";
      } else {
        moveWorm(w, st, WORM_SPEED, dt);
        if (dist(w, st) <= tp.radius + WORM_HEAD_RADIUS) {
          this.damageStructure(st, WORM_RAM_DAMAGE, true);
          w.pass = "out";
        }
      }
      // o cerco conta a partir da primeira aproximação
      if (w.siege < 0 && d < tp.radius + WORM_RAM_RETREAT + 1500) w.siege = WORM_SIEGE_TIME;
      if (w.siege >= 0) {
        w.siege -= dt;
        if (w.siege <= 0) {
          // cerco acabou: procura outra presa
          w.besieged.add(st.id);
          w.target = "";
          w.retarget = 0;
          w.siege = -1;
        }
      }
    } else if (tp) {
      // NAVE: persegue e engole — desacelera perto dela e quando ela está para trás
      const { dx, dy } = relVec(w, tp.pos);
      const d = Math.hypot(dx, dy);
      near = d < WORM_MOUTH_RADIUS + tp.radius + 1500;
      const ahead = Math.cos(Math.atan2(dy, dx) - w.angle);
      const speed = WORM_SPEED * Math.min(1, Math.max(0.25, d / 3000)) * (0.4 + 0.6 * Math.max(0, ahead));
      moveWorm(w, tp.pos, speed, dt);
    } else if (w.roam <= 0) {
      // fim da ronda: volta para a toca (pelo caminho da excursão, se estava
      // fora) e entra para descansar; tapada a toca, enterra-se em Ceres
      if (w.away) {
        w.route = w.back;
        w.back = [];
        w.away = false;
      }
      const home = this.hole?.pos ?? ceresPosition(seed);
      if (w.route.length > 0 && dist(w, w.route[0]) < 1200) w.route.shift();
      if (this.hole && dist(w, home) < 800) {
        this.enterDen(id, w);
        return;
      }
      if (!this.hole && dist(w, home) < CERES_RADIUS - 3000) {
        this.removeWorm(id);
        return;
      }
      moveWorm(w, w.route[0] ?? home, WORM_SPEED, dt);
    } else {
      // sem presa ao alcance: EXCURSÃO — da borda de Ceres salta para a rocha
      // mais próxima e volta pelo mesmo caminho; depois, outra
      if (w.route.length > 0 && dist(w, w.route[0]) < 1200) w.route.shift();
      if (w.route.length === 0) {
        if (w.away) {
          w.route = w.back;
          w.back = [];
          w.away = false;
        } else {
          const plan = this.wormExcursion();
          w.route = plan.out;
          w.back = plan.back;
          w.away = true;
        }
      }
      moveWorm(w, w.route[0], WORM_SPEED * 0.6, dt);
    }
    const k = 1 - Math.exp(-4 * dt);
    w.mouth += ((near ? 1 : 0) - w.mouth) * k;
    w.breach += ((near ? 1 : 0) - w.breach) * k;
    for (let i = 0; i < w.segs.length; i++) {
      w.exposed[i] = (i <= 2 && w.breach > 0.5) || !wormBodyAt(seed, w.segs[i]);
    }

    // a CABEÇA engole inteira a nave que alcança
    for (const [sid, s] of [...this.sim.ships]) {
      if (!this.wormEdible(s) || dist(w, s) > WORM_MOUTH_RADIUS + SHIP_RADIUS) continue;
      this.fx("shipDown", s);
      console.log(`[room] minhoca ${id} engoliu ${s.kind} ${sid} de ${s.owner || "bots"}`);
      this.destroyShip(sid);
    }
    // o CORPO exposto fere quem bate nele
    for (const [sid, s] of [...this.sim.ships]) {
      if (!this.wormEdible(s) || this.wormBodyHits.has(sid)) continue;
      if (dist(w, s) > w.segs.length * WORM_SPACING + WORM_MOUTH_RADIUS) continue;
      for (let i = 1; i < w.segs.length; i++) {
        if (!w.exposed[i] || dist(w.segs[i], s) > wormRadiusAt(i) + SHIP_RADIUS) continue;
        this.wormBodyHits.set(sid, WORM_BODY_COOLDOWN);
        this.damageShip([sid, s], WORM_BODY_DAMAGE, true);
        break;
      }
    }
  }

  /**
   * Uma excursão a partir da toca: o ponto da BORDA de Ceres numa direção
   * sorteada perto da da toca e a rocha mais próxima dele lá fora (sem rocha
   * à vista, um salto no vácuo). Volta pelo mesmo caminho: borda → toca.
   */
  private wormExcursion(): { out: WorldPos[]; back: WorldPos[] } {
    const seed = this.sim.seed;
    const c = ceresPosition(seed);
    const home = this.hole?.pos ?? c;
    const { dx, dy } = relVec(c, home);
    const base = Math.hypot(dx, dy) > 1 ? Math.atan2(dy, dx) : this.combatRng() * Math.PI * 2;
    const a = base + (this.combatRng() - 0.5) * 1.4;
    const at = (r: number) => {
      const p = { sx: c.sx, sy: c.sy, x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r };
      normalizePos(p);
      return p;
    };
    const edge = at(CERES_RADIUS - 900);
    const look = at(CERES_RADIUS + 3000);
    let rock: WorldPos = at(CERES_RADIUS + 4000);
    let bd = Infinity;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        for (const r of sectorAsteroids(seed, look.sx + ox, look.sy + oy)) {
          const d = dist(edge, r);
          if (d < bd && dist(c, r) > CERES_RADIUS + r.radius) { bd = d; rock = { sx: r.sx, sy: r.sy, x: r.x, y: r.y }; }
        }
      }
    }
    return { out: [edge, rock], back: [edge, home] };
  }

  /** Fim da ronda: entra na toca e descansa WORM_DEN_TIME (some do mapa). */
  private enterDen(id: string, w: Worm): void {
    w.den = WORM_DEN_TIME;
    w.exposed.fill(false);
    w.mouth = 0;
    w.breach = 0;
    this.state.worms.delete(id);
  }

  /** Volta à superfície pela toca para uma nova ronda (a corrente sai encolhida do buraco). */
  private emergeWorm(w: Worm, at: WorldPos): void {
    Object.assign(w, { sx: at.sx, sy: at.sy, x: at.x, y: at.y, angle: this.combatRng() * Math.PI * 2 });
    for (const s of w.segs) Object.assign(s, { sx: at.sx, sy: at.sy, x: at.x, y: at.y });
    Object.assign(w, { den: -1, roam: WORM_ROAM_TIME, target: "", retarget: 0, siege: -1, route: [], back: [], away: false });
    w.besieged.clear();
    w.attackers.clear();
  }

  /** Índice do gomo EXPOSTO mais perto de `p` (−1 = toda enterrada). */
  private nearestExposedSeg(w: Worm, p: WorldPos): number {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < w.segs.length; i++) {
      if (!w.exposed[i]) continue;
      const d = dist(p, w.segs[i]);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** Gomo apontado por um alvo de mira "worm:<id>:<i>" (null se a minhoca morreu). */
  private wormSegOf(target: string): WorldPos | null {
    const [, id, i] = target.split(":");
    return this.worms.get(id)?.segs[Number(i)] ?? null;
  }

  /** Minhoca cujo corpo exposto o projétil toca (qualquer nível, qualquer dono). */
  private wormHitBy(proj: WorldPos, reach: number): string | null {
    for (const [id, w] of this.worms) {
      for (let i = 0; i < w.segs.length; i++) {
        if (w.exposed[i] && dist(proj, w.segs[i]) <= reach + wormRadiusAt(i)) return id;
      }
    }
    return null;
  }

  /** Gomo exposto de alguma minhoca ao alcance de `from` (o mais perto). */
  private wormInRange(from: WorldPos, range: number): { id: string; worm: Worm; seg: number } | null {
    let out: { id: string; worm: Worm; seg: number } | null = null;
    let bd = range;
    for (const [id, w] of this.worms) {
      const i = this.nearestExposedSeg(w, from);
      if (i < 0) continue;
      const d = dist(from, w.segs[i]) - wormRadiusAt(i);
      if (d <= bd) { bd = d; out = { id, worm: w, seg: i }; }
    }
    return out;
  }

  /**
   * Dano numa minhoca (`at`: onde o impacto explode); a zero, ela morre.
   * `attacker` (nave ou estrutura da turreta): durante a ronda ela se volta
   * contra o atacante mais perto (wormPickTarget, vingança).
   */
  private damageWorm(id: string, damage: number, at?: WorldPos, attacker?: string): void {
    const w = this.worms.get(id);
    if (!w || !(damage > 0)) return;
    if (at) this.fx("hit", at);
    w.hp -= damage;
    if (attacker && w.roam > 0 && this.wormTarget(attacker)) {
      w.attackers.set(attacker, this.elapsed);
      w.besieged.delete(attacker);
      const next = this.wormPickTarget(w);
      if (next !== w.target) {
        w.siege = -1;
        w.pass = "in";
      }
      w.target = next;
      w.retarget = 1;
    }
    if (w.hp > 0) return;
    this.fx("structureDown", w);
    for (let i = 4; i < w.segs.length; i += 6) if (w.exposed[i]) this.fx("shipDown", w.segs[i]);
    this.removeWorm(id);
    const killer = attacker ? this.sim.ships.get(attacker)?.owner ?? this.sim.structures.get(attacker)?.owner ?? "" : "";
    const kp = killer ? this.state.players.get(killer) : undefined;
    if (kp && !this.state.finished) kp.wormKills++;
    if (killer) this.addScore(killer, SCORE_POINTS.wormKilled);
    console.log(`[room] minhoca ${id} morreu${killer ? ` (abatida por ${killer})` : ""}`);
  }

  // ── partida: placar e vitória (shared/match.ts) ───────────────────

  /** Soma pontos ao placar de um jogador (bots da frota e ruínas não pontuam; partida encerrada, não muda). */
  private addScore(sessionId: string, points: number): void {
    if (this.state.finished || !(points > 0)) return;
    const p = this.state.players.get(sessionId);
    if (p) p.score += Math.round(points);
  }

  /**
   * Fim da partida, por modo: com tempo, ao acabar o tempo vence o primeiro
   * do placar (minhocas mortas e, no empate, pontos; ou só pontos); no ÚLTIMO
   * DE PÉ, quando só sobra um jogador (com 2 ou mais na sala) — ou nenhum.
   */
  private stepMatch(): void {
    const st = this.state;
    st.clock = this.elapsed;
    if (st.finished) return;
    const players = [...st.players.entries()];
    if (players.length === 0) return;
    if (st.timeLimit > 0 && this.elapsed >= st.timeLimit) {
      const rank = players.sort(([, a], [, b]) =>
        st.victory === "worms" ? b.wormKills - a.wormKills || b.score - a.score : b.score - a.score);
      this.finishMatch(rank[0][0]);
      return;
    }
    if (st.victory === "lastStand") {
      const alive = players.filter(([, p]) => !p.eliminated);
      if (alive.length === 0) this.finishMatch("");
      else if (alive.length === 1 && players.length >= 2) this.finishMatch(alive[0][0]);
    }
  }

  private finishMatch(winner: string): void {
    this.state.finished = true;
    this.state.winner = winner;
    const name = winner ? this.state.players.get(winner)?.name ?? winner : "ninguém";
    console.log(`[room] partida encerrada (${this.state.victory}) — vencedor: ${name}`);
  }

  // ── escape pod e fim de jogo ──────────────────────────────────────

  private stat(sessionId: string): PlayerStats {
    let s = this.stats.get(sessionId);
    if (!s) this.stats.set(sessionId, (s = freshStats(this.elapsed)));
    return s;
  }

  /**
   * Estrutura recém-construída: conta para o resumo do jogador; estação de
   * mineração e QG nascem com STRUCTURE_START_RATIONS; a central de rações
   * nasce com a sua frota de drones.
   */
  private onBuilt(sessionId: string, id: string): void {
    const st = this.sim.structures.get(id);
    if (!st) return;
    const s = this.stat(sessionId);
    s.built[st.type] = (s.built[st.type] ?? 0) + 1;
    this.addScore(sessionId, STRUCTURE_SPECS[st.type].cost);
    if (st.type === "miningStation" || st.type === "hq") st.rationStore = Math.max(st.rationStore, STRUCTURE_START_RATIONS);
    if (st.type === "rationCenter") {
      this.droneUpgrades.set(id, { drones: 0, speed: 0, cargo: 0 });
      for (let k = 0; k < droneStats(this.droneUpgrades.get(id)!).count; k++) this.spawnDrone(st);
    }
  }

  /**
   * Para onde o escape pod vai: a estrutura PRÓPRIA mais próxima de `from`
   * (qualquer tipo). Lá o piloto espera a pé. null = não sobrou nenhuma:
   * fim de jogo.
   */
  private recoveryTarget(sessionId: string, from: WorldPos, skip = ""): Structure | null {
    let best: Structure | null = null;
    let bd = Infinity;
    for (const st of this.sim.structures.values()) {
      if (st.owner !== sessionId || st.id === skip) continue;
      const d = dist(from, st);
      if (d < bd) { bd = d; best = st; }
    }
    return best;
  }

  /** O piloto (a pé em `st`) embarca na nave `shipId` do hangar dela. */
  private boardShip(sessionId: string, shipId: string, ship: ShipState, st: Structure): void {
    this.deployFromHangar(ship, st);
    this.activeShip.set(sessionId, shipId);
    this.waitingAt.delete(sessionId);
    console.log(`[room] ${sessionId} embarcou em ${ship.kind} (${shipId}) em ${st.id}`);
  }

  /**
   * FIM DE JOGO por falta de meios: sem nenhum QG (para fabricar) e sem
   * nenhum builder (para construir um), não há como se reerguer — mesmo com
   * estações e outras naves de pé. Checado a cada tick.
   */
  private checkEliminations(): void {
    for (const [sid, p] of this.state.players) {
      if (p.eliminated) continue;
      const hasHq = [...this.sim.structures.values()].some((st) => st.owner === sid && st.type === "hq");
      const hasBuilder = [...this.sim.ships.values()].some((s) => s.owner === sid && s.kind === "builder");
      if (!hasHq && !hasBuilder) this.eliminatePlayer(sid);
    }
  }

  /**
   * O jogador perdeu a nave (ou a estação em que estava atracado): é
   * EXPELIDO num escape pod no lugar da explosão, que voa sozinho até o
   * destino de recoveryTarget. Sem destino, fim de jogo.
   */
  private ejectPlayer(sessionId: string, at: WorldPos): void {
    this.waitingAt.delete(sessionId);
    const target = this.recoveryTarget(sessionId, at);
    if (!target) {
      this.eliminatePlayer(sessionId);
      return;
    }
    const id = `pod-${this.shipSeq++}`;
    const pod = this.sim.addShip(id, { sx: at.sx, sy: at.sy, x: at.x, y: at.y }, sessionId, "pod");
    setLayer(pod, "cruise");
    pod.taxiTo = target.id;
    this.state.ships.set(id, this.mirrorSpawn(pod));
    this.activeShip.set(sessionId, id);
    console.log(`[room] ${sessionId} expelido num escape pod (${id}) → ${target.id} (${target.type})`);
  }

  /** Um passo do escape pod: voa (como o táxi) e, ao chegar, entrega o piloto. */
  private stepPod(id: string, pod: ShipState): void {
    let dest = this.sim.structures.get(pod.taxiTo);
    if (!dest || dest.owner !== pod.owner) {
      // o destino caiu no caminho: procura outro
      const next = this.recoveryTarget(pod.owner, pod);
      if (!next) {
        this.removePod(id);
        this.eliminatePlayer(pod.owner);
        return;
      }
      pod.taxiTo = next.id;
      dest = next;
    }
    if (dist(pod, dest) > DOCK_RANGE) {
      this.sim.setInput(id, computeTaxiInput(pod, dest));
      return;
    }
    // chegou: o piloto desce e espera a pé na estrutura
    const owner = pod.owner;
    this.removePod(id);
    this.activeShip.delete(owner);
    this.waitingAt.set(owner, dest.id);
    console.log(`[room] ${owner} chegou de escape pod em ${dest.id} — esperando a pé`);
  }

  private removePod(id: string): void {
    this.sim.removeShip(id);
    this.state.ships.delete(id);
    this.weapons.delete(id);
    this.rawInputs.delete(id);
  }

  /**
   * FIM DE JOGO do jogador: sem nave e sem como se reerguer. A frota que
   * sobrou some, as estruturas viram RUÍNAS (RUIN_OWNER: ninguém ataca, nada
   * produz, o asteroide continua ocupado) e o cliente mostra a tela de fim —
   * tempo de sobrevivência e o que foi construído —, com as opções de
   * assistir ou recomeçar (MSG_RESTART).
   */
  private eliminatePlayer(sessionId: string): void {
    for (const [id, s] of [...this.sim.ships]) {
      if (s.owner !== sessionId) continue;
      this.sim.removeShip(id);
      this.state.ships.delete(id);
      this.spiders.delete(id);
      this.attackTargets.delete(id);
      this.weapons.delete(id);
      this.rawInputs.delete(id);
    }
    for (const [did, d] of [...this.drones]) if (d.owner === sessionId) this.removeDrone(did);
    let ruins = 0;
    for (const st of this.sim.structures.values()) {
      if (st.owner !== sessionId) continue;
      st.owner = RUIN_OWNER;
      this.turrets.delete(st.id);
      this.turretJobs.delete(st.id);
      this.turretCooldowns.delete(st.id);
      ruins++;
    }
    this.activeShip.delete(sessionId);
    this.waitingAt.delete(sessionId);
    const stats = this.stat(sessionId);
    const p = this.state.players.get(sessionId);
    if (p) {
      p.eliminated = true;
      p.survival = this.elapsed - stats.joinedAt;
      p.summary = JSON.stringify({ built: stats.built, produced: stats.produced, turrets: stats.turrets, ruins });
    }
    console.log(`[room] ${sessionId} ENCERRADO — ${Math.round(this.elapsed - stats.joinedAt)} s de partida, ${ruins} ruína(s)`);
  }

  /** Jogador encerrado recomeça: builder e base inicial novos num lugar aleatório. */
  private restartPlayer(sessionId: string): void {
    const p = this.state.players.get(sessionId);
    if (!p?.eliminated) return;
    p.eliminated = false;
    p.survival = 0;
    p.summary = "";
    this.stats.set(sessionId, freshStats(this.elapsed));
    this.waitingAt.delete(sessionId);
    const base = this.spawns[Math.floor(Math.random() * this.spawns.length)];
    const id = `p${this.shipSeq++}`;
    const ship = this.spawnShip(id, base, sessionId, "builder");
    ship.kits = STARTING_KITS;
    this.state.ships.set(id, this.mirrorSpawn(ship));
    this.activeShip.set(sessionId, id);
    this.grantInitialBase(sessionId, ship);
    console.log(`[room] ${sessionId} recomeçou em (${ship.sx}, ${ship.sy})`);
  }

  private mirrorSpawn(ship: ShipState): ShipSchema {
    const s = new ShipSchema();
    s.sx = ship.sx;
    s.sy = ship.sy;
    s.x = ship.x;
    s.y = ship.y;
    s.owner = ship.owner;
    s.kind = ship.kind;
    s.anchored = ship.anchored;
    s.stored = ship.stored;
    s.hqId = ship.hqId;
    s.autoMining = ship.autoMining;
    s.stationId = ship.stationId;
    s.taxiTo = ship.taxiTo;
    s.bay = ship.bay;
    s.landingPhase = ship.landingPhase;
    s.landingProgress = ship.landingProgress;
    s.landingTargetX = ship.landingTargetX;
    s.landingTargetY = ship.landingTargetY;
    s.landingOriginX = ship.landingOriginX;
    s.landingOriginY = ship.landingOriginY;
    s.landingAsteroidSpin = ship.landingAsteroidSpin;
    s.cargoKind = ship.cargoKind;
    s.cargoAmount = ship.cargoAmount;
    s.hp = ship.hp;
    s.ammo = ship.ammo;
    s.grenadeAmmo = ship.grenadeAmmo;
    s.layer = ship.layer;
    s.layerTo = ship.layerTo;
    s.layerProgress = ship.layerProgress;
    return s;
  }

  private tick(dt: number) {
    this.elapsed += dt;
    // Animação de pouso/decolagem do builder
    for (const [, ship] of this.sim.ships) {
      if (ship.landingPhase === "landing") {
        ship.landingProgress = Math.min(1, ship.landingProgress + dt / LAND_DURATION);
        const t = ship.landingProgress;
        // o alvo não precisa ser recalculado: é o centro de um asteroide vazio
        // (o eixo do giro dele) ou uma vaga de estrutura, e asteroide com
        // estrutura não gira
        ship.x = ship.landingOriginX + (ship.landingTargetX - ship.landingOriginX) * t;
        ship.y = ship.landingOriginY + (ship.landingTargetY - ship.landingOriginY) * t;
        ship.vx = 0; ship.vy = 0;
        if (t >= 1) {
          const struct = ship.hqId ? this.sim.structures.get(ship.hqId) : undefined;
          if (struct) {
            // pouso em estrutura própria: assenta na vaga reservada
            this.dockAtBay(ship, struct);
          } else if (ship.hqId) {
            // a estrutura sumiu durante o pouso: volta ao cruzeiro
            this.liftOff(ship);
          } else {
            // pouso em asteroide vazio: fica no estado "landed"
            ship.landingPhase = "landed";
            ship.angle = 0;
            setLayer(ship, "surface");
          }
        }
      } else if (ship.landingPhase === "liftoff") {
        // fase removida: decolagem é instantânea via tryToggleAnchor
        ship.landingPhase = "";
        ship.anchored = false;
        ship.anchoredAsteroidId = "";
      }
    }
    this.superviseAttackMode();
    // IA da frota dos bots: primeiro a saída do grupo, depois cada bot
    this.launchWave();
    for (const [id, bot] of this.bots) {
      const ship = this.sim.ships.get(id);
      if (!ship) continue;
      this.sim.setInput(id, this.botInput(id, ship, bot, dt));
    }
    this.stepBotProduction(dt);
    this.stepTurretJobs(dt);
    this.stepTurrets(dt);
    // BUILDER minerando na estação: enche o estoque LOCAL da estação —
    // logística física: o transporte leva até a base inicial, e só a
    // descarga lá credita a carteira
    for (const ship of this.sim.ships.values()) {
      if (!ship.anchored || !ship.mining || ship.kind !== "builder") continue;
      const station = this.sim.structures.get(ship.hqId);
      if (!station || station.type !== "miningStation") continue;
      const cap = stationOreCap(station.level);
      if (station.oreStore >= cap) { ship.mining = false; continue; }
      const rate = MINING_RATE_BY_KIND["builder"] * this.testSpeed;
      station.oreStore = Math.min(cap, station.oreStore + rate * dt);
    }
    // BROCA de toda estação de mineração: DRILL_BASE_RATE minério/s por nível,
    // para o buffer local; parada sem rações, e cada DRILL_CYCLE_ORE escavado
    // consome RATIONS_PER_MINING_CYCLE
    for (const st of this.sim.structures.values()) {
      if (st.type !== "miningStation" || st.owner === RUIN_OWNER || st.owner === BOT_OWNER) continue;
      if (st.rationStore <= 0) continue;
      const room = stationOreCap(st.level) - st.oreStore;
      if (room <= 0) continue;
      const mined = Math.min(room, DRILL_BASE_RATE * st.level * dt * this.testSpeed);
      st.oreStore += mined;
      let acc = (this.drillCycle.get(st.id) ?? 0) + mined;
      while (acc >= DRILL_CYCLE_ORE) {
        acc -= DRILL_CYCLE_ORE;
        st.rationStore = Math.max(0, st.rationStore - RATIONS_PER_MINING_CYCLE);
      }
      this.drillCycle.set(st.id, acc);
    }
    // ARANHAS mineradoras → caminham pelo asteroide e descarregam no
    // estoque LOCAL da estação (param quando ele está cheio)
    for (const [id, spider] of this.spiders) {
      const ship = this.sim.ships.get(id);
      const station = ship ? this.sim.structures.get(ship.stationId) : undefined;
      if (!ship || !station) {
        this.spiders.delete(id);
        continue;
      }
      if (station.oreStore >= stationOreCap(station.level)) {
        ship.mining = false;
        continue;
      }
      // sem rações para o próximo ciclo, a máquina para
      if (station.rationStore < RATIONS_PER_MINING_CYCLE) {
        ship.mining = false;
        continue;
      }
      const unloaded = stepSpider(ship, station, spider, dt, this.testSpeed);
      if (unloaded > 0) {
        // fim de um ciclo de coleta: a equipe consome rações
        station.rationStore = Math.max(0, station.rationStore - RATIONS_PER_MINING_CYCLE);
        station.oreStore = Math.min(stationOreCap(station.level), station.oreStore + unloaded);
      }
    }
    // transportes em entrega automática
    this.stepFreighters();
    // escape pods: voam sozinhos até a estrutura própria mais próxima
    for (const [id, ship] of [...this.sim.ships]) if (ship.kind === "pod") this.stepPod(id, ship);
    // IA do táxi → voa até o destino; ao chegar, estaciona na 1ª vaga livre
    for (const [id, ship] of this.sim.ships) {
      if (!ship.taxiTo || ship.kind === "pod" || this.freighters.has(id)) continue;
      const dest = this.sim.structures.get(ship.taxiTo);
      if (!dest) {
        ship.taxiTo = "";
        continue;
      }
      if (dist(ship, dest) <= DOCK_RANGE) {
        const freeBay = this.firstFreeShipBay(dest, ship.kind);
        ship.stored = true;
        ship.hqId = ship.taxiTo;
        ship.taxiTo = "";
        ship.anchored = false;
        ship.bay = freeBay >= 0 ? freeBay : 0;
        ship.vx = 0;
        ship.vy = 0;
        this.sim.setInput(id, { thrust: false, turn: 0, mine: false });
        console.log(`[room] táxi chegou: ${ship.kind} na vaga ${ship.bay} de ${ship.hqId}`);
        // o dono esperava ali, a pé: embarca
        if (this.waitingAt.get(ship.owner) === dest.id) this.boardShip(ship.owner, id, ship, dest);
      } else {
        this.sim.setInput(id, computeTaxiInput(ship, dest));
      }
    }
    // PROJÉTEIS: move, colide, expira. Um tiro só atinge o que está no MESMO
    // nível de combate em que foi disparado (combat.ts) — cruzeiro com
    // cruzeiro; superfície e modo ataque com o nível das estações
    for (const [id, proj] of [...this.projectiles]) {
      if (!this.projectiles.has(id)) continue; // detonada em cadeia neste tick (blastHole)
      let hit = false;
      if (proj.kind === "mine" && proj.armed) {
        // MINA ARMADA: parada; detona com nave inimiga por perto, ou some
        // sozinha depois de MINE_LIFETIME
        proj.age = (proj.age ?? 0) + dt;
        if (this.shipHitBy(proj, MINE_TRIGGER_RADIUS) || this.droneHitBy(proj, MINE_TRIGGER_RADIUS) || this.wormHitBy(proj, MINE_TRIGGER_RADIUS)) {
          // no buraco da toca, uma mina leva todas
          if (proj.inHole) {
            this.blastHole();
            continue;
          }
          this.detonate(proj);
          hit = true;
        } else if (!proj.inHole && proj.age >= MINE_LIFETIME) hit = true; // no buraco, espera o míssil
      } else {
        const step = Math.hypot(proj.vx, proj.vy) * dt;
        proj.x += proj.vx * dt;
        proj.y += proj.vy * dt;
        normalizePos(proj);
        proj.traveled += step;
        if (proj.kind === "missile") {
          if (proj.traveled >= MISSILE_RANGE) {
            hit = true; // expira por distância
          } else {
            const ship = this.shipHitBy(proj, MISSILE_RADIUS + SHIP_RADIUS);
            const struct = ship ? null : this.structureHitBy(proj, MISSILE_RADIUS);
            const drone = ship || struct ? null : this.droneHitBy(proj, MISSILE_RADIUS + DRONE_RADIUS);
            const worm = ship || struct || drone ? null : this.wormHitBy(proj, MISSILE_RADIUS);
            const holeMine = ship || struct || drone || worm ? false : this.holeMineHitBy(proj);
            hit = !!(ship || struct || drone || worm || holeMine);
            if (ship) this.damageShip(ship, MISSILE_DAMAGE, true, proj.owner);
            else if (struct) this.damageStructure(struct, MISSILE_DAMAGE, true, proj.owner);
            else if (drone) this.damageDrone(drone, MISSILE_DAMAGE, true);
            else if (worm) this.damageWorm(worm, MISSILE_DAMAGE, proj, proj.shooter);
            else if (holeMine) this.blastHole();
          }
        } else {
          // MINA EM VOO: inerte (só arma parada). Bate numa rocha → fixa-se
          // na superfície dela, no nível das estações; chega a
          // MINE_MAX_DISTANCE do lançamento → para e fica flutuando
          // na zona da toca a mina voa até o buraco e para DENTRO dele
          const hole = this.hole;
          const holeZone = !!hole && proj.level === "surface" && dist(proj, hole.pos) <= hole.radius + ATTACK_ZONE_MARGIN;
          const inHole = holeZone && dist(proj, hole!.pos) <= WORM_HOLE_RADIUS;
          const contact = holeZone ? null : this.mineContact(proj);
          const far = !contact && proj.origin && dist(proj.origin, proj) >= MINE_MAX_DISTANCE;
          if (contact || far || inHole) {
            if (inHole) proj.inHole = true;
            if (contact) {
              proj.sx = contact.sx; proj.sy = contact.sy;
              proj.x = contact.x; proj.y = contact.y;
              proj.level = "surface";
            }
            proj.vx = 0;
            proj.vy = 0;
            proj.armed = true;
            proj.age = 0;
            const ps = this.state.projectiles.get(id);
            if (ps) {
              ps.armed = true;
              ps.vx = 0;
              ps.vy = 0;
              ps.level = proj.level;
            }
          }
        }
      }

      if (hit) {
        this.projectiles.delete(id);
        this.state.projectiles.delete(id);
      } else {
        const ps = this.state.projectiles.get(id);
        if (ps) {
          ps.sx = proj.sx; ps.sy = proj.sy;
          ps.x = proj.x; ps.y = proj.y;
          ps.traveled = proj.traveled;
        }
      }
    }
    this.updateAim(dt);
    // cooldowns de disparo
    for (const ship of this.sim.ships.values()) {
      if (ship.fireCooldown > 0) ship.fireCooldown = Math.max(0, ship.fireCooldown - dt);
      if (ship.grenadeCooldown > 0) ship.grenadeCooldown = Math.max(0, ship.grenadeCooldown - dt);
    }
    // drones de ração e refinarias de bordo
    this.stepMatch();
    for (const pb of this.playerBots) pb.step(dt);
    this.stepRaiders();
    this.stepFerries();
    this.stepDrones(dt);
    this.stepWorms(dt);
    this.stepRefine(dt);
    this.stepRepair(dt);
    this.applyAttackMode();
    this.sim.tick(dt);
    // DANO DE COLISÃO: o impulso que o solver acumulou neste tick vira dano
    // (combat.ts) e zera — quem converte e zera é o servidor. Os bots são
    // imunes: sem desviar de outras naves, eles se chocavam de frente a
    // milhares de u/s e 28 de 30 morriam em dois minutos. Continuam batendo e
    // ricocheteando (a física é a mesma); só não perdem HP no choque — tiro
    // ainda os atinge.
    for (const [id, s] of [...this.sim.ships]) {
      const dmg = this.bots.has(id) ? 0 : collisionDamage(s);
      s.hullImpulse = 0;
      if (dmg > 0) this.damageShip([id, s], dmg);
    }
    this.checkEliminations();
    // espelha sim-core → schema
    for (const [id, ship] of this.sim.ships) {
      const s = this.state.ships.get(id);
      if (!s) continue;
      s.sx = ship.sx;
      s.sy = ship.sy;
      s.x = ship.x;
      s.y = ship.y;
      s.vx = ship.vx;
      s.vy = ship.vy;
      s.angle = ship.angle;
      s.av = ship.av;
      s.mining = ship.mining;
      s.anchored = ship.anchored;
      s.stored = ship.stored;
      s.hqId = ship.hqId;
      s.anchoredAsteroidId = ship.anchoredAsteroidId;
      s.autoMining = ship.autoMining;
      s.stationId = ship.stationId;
      s.taxiTo = ship.taxiTo;
      s.bay = ship.bay;
      s.landingPhase = ship.landingPhase;
      s.landingProgress = ship.landingProgress;
      s.landingTargetX = ship.landingTargetX;
      s.landingTargetY = ship.landingTargetY;
      s.landingOriginX = ship.landingOriginX;
      s.landingOriginY = ship.landingOriginY;
      s.landingAsteroidSpin = ship.landingAsteroidSpin;
      s.cargoKind = ship.cargoKind;
      s.cargoAmount = ship.cargoAmount;
      s.hp = ship.hp;
      s.ammo = ship.ammo;
      s.grenadeAmmo = ship.grenadeAmmo;
      s.layer = ship.layer;
      s.layerTo = ship.layerTo;
      s.layerProgress = ship.layerProgress;
      const rf = this.refine.get(id);
      s.refineQueue = rf?.queue ?? 0;
      s.kits = ship.kits;
      s.rations = ship.rations;
      s.refineProgress = rf ? Math.min(1, rf.t / REFINE_TIME) : 0;
      const at = this.attackTargets.get(id);
      s.attackTarget = at?.structId ?? "";
      s.attackRadius = at ? this.attackHoldRadius(at.radius) : 0;
      const w = this.weapons.get(id);
      if (w) {
        s.weapon = w.weapon;
        s.aimOffset = w.offset;
        s.aimTarget = w.target;
        s.aimLocked = w.locked;
        s.aimOffset2 = w.offset2;
        s.aimLocked2 = w.locked2;
      }
    }
    // estruturas
    for (const [id, st] of this.sim.structures) {
      const s = this.state.structures.get(id);
      if (!s) continue;
      s.stype = st.type;
      s.owner = st.owner;
      s.sx = st.sx;
      s.sy = st.sy;
      s.x = st.x;
      s.y = st.y;
      s.angle = st.angle;
      s.asteroidId = st.asteroidId;
      s.asteroidClass = st.asteroidClass;
      s.shipBays = st.shipBays;
      s.expandedBays = st.expandedBays;
      s.spiderBays = st.spiderBays;
      s.nextShipBay = st.nextShipBay;
      s.nextSpiderBay = st.nextSpiderBay;
      s.oreStore = st.oreStore;
      s.rationStore = st.rationStore;
      s.hp = st.hp;
      s.maxHp = structureMaxHp(st.type, st.level);
      s.level = st.level;
      s.turrets = this.turrets.get(id) ?? 0;
      const job = this.turretJobs.get(id);
      s.turretBuild = job ? s.turrets : -1;
      s.turretProgress = job?.progress ?? 0;
      s.turretBuilder = job?.shipId ?? "";
      s.repairing = this.repairJobs.has(id);
      s.kitStore = st.kitStore;
      const lv = this.droneUpgrades.get(id);
      s.droneLv = lv?.drones ?? 0;
      s.speedLv = lv?.speed ?? 0;
      s.cargoLv = lv?.cargo ?? 0;
    }
    // nave ativa e estado do jogador
    for (const [sid, p] of this.state.players) {
      p.activeShip = this.activeShip.get(sid) ?? "";
      p.station = this.waitingAt.get(sid) ?? "";
    }
  }
}
