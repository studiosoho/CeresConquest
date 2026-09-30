import { Room, updateLobby, type Client } from "../colyseus";
import {
  MSG_INPUT,
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
  MSG_FX,
  MSG_UPGRADE,
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
  CERES_STATION_ORE_RATE_PER_LEVEL,
  ceresStationUpgradeCost,
  structureMaxHp,
  stationOreCap,
  RATION_STORE_CAP,
  RATION_DRONE_RANGE,
  RATION_DRONE_AMOUNT,
  RATION_DRONE_INTERVAL,
  RATION_CENTER_SHIP_BAYS,
  RATION_CENTER_EXPANDED_BAYS,
  TRANSPORT_CARGO_CAP,
  DOCK_RANGE,
  BUILD_ASTEROID_RANGE,
  MINING_RATE_BY_KIND,
  BULLET_SPEED,
  BULLET_RANGE,
  BULLET_RADIUS,
  BULLET_DAMAGE,
  BULLET_COOLDOWN,
  GRENADE_SPEED,
  GRENADE_PROX_RADIUS,
  GRENADE_BLAST_RADIUS,
  GRENADE_DAMAGE,
  GRENADE_COOLDOWN,
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
  type BuildCommand,
  type ProduceCommand,
  type TaxiCommand,
  type LandActionCommand,
  type FireCommand,
  type FxEvent,
  type FxKind,
  type WorldPos,
} from "@ceres/shared";
import {
  SimWorld,
  findClearSpawn,
  sectorAsteroids,
  beginLayerChange,
  setLayer,
  type Asteroid,
  type ShipState,
  type Structure,
} from "@ceres/sim-core";
import { MatchState, ShipSchema, StructureSchema, PlayerSchema, ProjectileSchema } from "../schema/State";
import { canFire, collisionDamage, hittableLevel, levelOfLayer, splitDamage, type CombatLevel } from "../combat";
import { mapSpawns, type SpawnStrategy } from "../spawn";
import { computeBotInput, computeTaxiInput, makeBotState, type BotState } from "../bots";
import { makeSpiderState, stepSpider, type SpiderState } from "../spiders";

/** Projétil em voo; `level` é o nível de combate em que foi disparado (combat.ts). */
interface Projectile {
  kind: "bullet" | "grenade";
  owner: string;
  level: CombatLevel;
  sx: number; sy: number; x: number; y: number;
  vx: number; vy: number;
  traveled: number;
}

/** Nº de jogadores-teste autônomos (bots) por padrão. */
const DEFAULT_BOTS = 30;

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
  private projectiles = new Map<string, Projectile>();
  /**
   * Sorteios do combate (divisão do dano entre estação e hangar), semeados
   * pela semente do mundo: a partida continua reproduzível.
   */
  private combatRng: () => number = Math.random;
  /** timer por centro de distribuição (structId → segundos até próximo drone) */
  private rationDroneTimers = new Map<string, number>();
  /**
   * Naves em modo ataque (ou descendo para ele) → a estação atacada e o raio
   * do asteroide dela: a zona fora da qual a nave sobe sozinha ao cruzeiro.
   */
  private attackTargets = new Map<string, { structId: string; radius: number }>();

  onCreate(options: MatchOptions = {}) {
    this.maxClients = options.maxPlayers ?? 12;
    const botCount = options.bots ?? DEFAULT_BOTS;
    const radiusSectors = options.mapSize === "large" ? 50
      : options.mapSize === "medium" ? 20 : 8;
    const seed = options.worldSeed ?? (Math.random() * 0xffffffff) >>> 0;

    this.sim = new SimWorld(seed);
    this.combatRng = mulberry32((seed ^ 0x5eedc0b7) >>> 0);
    // spawns em setores distintos do cinturão dentro da arena do mapa
    this.spawns = mapSpawns(seed, radiusSectors, this.maxClients + botCount);

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

    // popula a partida com jogadores-teste autônomos (attack neutros)
    for (let i = 0; i < botCount; i++) {
      const id = `bot-${i}`;
      const ship = this.spawnShip(id, this.spawns[this.maxClients + i], "", "attack");
      this.state.ships.set(id, this.mirrorSpawn(ship));
      this.bots.set(id, makeBotState());
    }

    this.onMessage(MSG_INPUT, (client: Client, input: ShipInput) => {
      const active = this.activeShip.get(client.sessionId);
      if (active) this.sim.setInput(active, input);
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

    this.onMessage(MSG_FIRE, (client: Client, cmd: FireCommand) => {
      this.tryFire(client.sessionId, cmd?.kind);
    });

    this.onMessage(MSG_UPGRADE, (client: Client) => {
      this.tryUpgrade(client.sessionId);
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
    const base = this.spawns[this.spawnIndex++ % this.spawns.length];
    const id = `p${this.shipSeq++}`;
    const ship = this.spawnShip(id, base, client.sessionId, "builder"); // default: builder
    this.activeShip.set(client.sessionId, id);
    // espelha a posição de spawn JÁ no join — o primeiro estado que o
    // cliente recebe precisa ser real, não os defaults do schema
    this.state.ships.set(id, this.mirrorSpawn(ship));
    const p = new PlayerSchema();
    p.activeShip = id;
    p.name = sanitizeLabel(options.name, "Piloto", 20);
    this.state.players.set(client.sessionId, p);
    this.sim.playerOre.set(client.sessionId, 0);
    // o jogador RECEBE a Base Inicial no asteroide livre mais próximo do spawn
    this.grantInitialBase(client.sessionId, ship);
    // atualiza a contagem de jogadores exibida no lobby
    void updateLobby(this);
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
    this.state.players.delete(client.sessionId);
    this.sim.playerOre.delete(client.sessionId);
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
      if (built?.owner === sessionId && this.landAtBay(ship, built)) return;
      if (!built && (ship.kind === "builder" || ship.kind === "mining")) {
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
    if (!st.asteroidId.startsWith(CERES_PLATFORM_PREFIX)) return;
    if (st.level >= CERES_STATION_MAX_LEVEL) return;
    const cost = ceresStationUpgradeCost(st.level);
    if (this.sim.getOre(sessionId) < cost) return;
    this.sim.spendOre(sessionId, cost);
    const oldMax = structureMaxHp(st.type, st.level);
    st.level += 1;
    st.spiderBays += CERES_STATION_SPIDER_BAYS_PER_LEVEL;
    st.hp += structureMaxHp(st.type, st.level) - oldMax;
    console.log(`[room] ${sessionId} evoluiu a estação ${st.id} para o nível ${st.level}`);
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
    for (const st of this.sim.structures.values()) {
      if (st.owner === sessionId) continue;
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
      const struct = this.sim.structures.get(target.structId);
      if (!struct || dist(ship, struct) > target.radius + ATTACK_ZONE_MARGIN) {
        beginLayerChange(ship, "cruise");
        this.attackTargets.delete(id);
      }
    }
  }

  /** Troca a nave ativa por uma do hangar da estrutura ancorada. */
  private trySwap(sessionId: string): void {
    const active = this.activeShipOf(sessionId);
    if (!active || !active.anchored) return;
    const struct = this.sim.structures.get(active.hqId) ?? this.nearestOwnStructure(sessionId, active, DOCK_RANGE);
    if (!struct || struct.owner !== sessionId) return;

    // naves guardadas no hangar desta estrutura
    let pick: [string, ShipState] | null = null;
    for (const [id, s] of this.sim.ships) {
      if (s.owner === sessionId && s.hqId === struct.id && s.stored) {
        pick = [id, s];
        break;
      }
    }
    if (!pick) return; // hangar vazio

    // cada nave fica na PRÓPRIA vaga: a ativa, pousada na dela, entra no
    // hangar ali mesmo; a escolhida sai do hangar para a placa da vaga dela
    const [nid, next] = pick;
    active.stored = true;
    active.anchored = false;
    active.hqId = struct.id;
    if (active.bay < 0) active.bay = this.firstFreeShipBay(struct, active.kind);
    this.sim.setInput(this.activeShip.get(sessionId)!, { thrust: false, turn: 0, mine: false });

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
    if (!active || active.kind !== "mining" || !active.anchored) return;
    const station = this.nearestOwnStructure(sessionId, active, DOCK_RANGE, "miningStation");
    if (!station) return;

    // vagas de aranha da estação (2/4/6 pela classe do asteroide)
    if (station.nextSpiderBay >= station.spiderBays) return;

    // raio do asteroide hospedeiro (para a aranha caminhar na superfície)
    const astRadius = this.siteRadius(station) ?? 400;

    // transfere o controle para outra nave ANTES de largar a mineradora
    const activeId = this.activeShip.get(sessionId)!;
    if (!this.transferControl(sessionId, activeId)) return; // não pode ficar sem nave

    active.autoMining = true;
    active.stationId = station.id;
    active.anchored = false;
    active.bay = -1; // libera a vaga de nave — a aranha usa vaga de aranha
    active.hqId = "";
    this.spiders.set(activeId, makeSpiderState(astRadius));
    station.nextSpiderBay += 1;
    console.log(`[room] ${sessionId} aranha mineradora ativa em ${station.id} (${station.nextSpiderBay}/${station.spiderBays})`);
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
      if (this.sim.getOre(sessionId) < spec.cost) return;

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

      this.sim.spendOre(sessionId, spec.cost);
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
      console.log(`[room] ${sessionId} construiu miningStation (via pouso) em ${cls} — builder a caminho da vaga`);
    }

    // em Ceres só se constrói estação de mineração (ver CERES_STATION_MAX_LEVEL)
    const onCeres = ship.anchoredAsteroidId.startsWith(CERES_PLATFORM_PREFIX);

    if (action === "buildhq" && ship.kind === "builder" && !onCeres) {
      const spec = STRUCTURE_SPECS["hq"];
      if (this.sim.getOre(sessionId) < spec.cost) return;
      // o local em que o builder pousou: asteroide vazio ou plataforma de Ceres
      const ast = this.landedSite(ship);
      if (!ast) return;
      for (const st of this.sim.structures.values()) {
        if (st.asteroidId === ast.id) return;
      }
      const { angle, cls } = ast;
      const shipBays = HQ_SHIP_BAYS;
      const expandedBays = HQ_EXPANDED_BAYS;
      this.sim.spendOre(sessionId, spec.cost);
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
      console.log(`[room] ${sessionId} construiu hq (via pouso) em ${cls}`);
    }

    if (action === "buildration" && ship.kind === "builder" && !onCeres) {
      const spec = STRUCTURE_SPECS["rationCenter"];
      if (this.sim.getOre(sessionId) < spec.cost) return;
      // o local em que o builder pousou: asteroide vazio ou plataforma de Ceres
      const ast = this.landedSite(ship);
      if (!ast) return;
      for (const st of this.sim.structures.values()) {
        if (st.asteroidId === ast.id) return;
      }
      const { angle, cls } = ast;
      this.sim.spendOre(sessionId, spec.cost);
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
      this.rationDroneTimers.set(id, RATION_DRONE_INTERVAL);
      // o builder sai do centro do asteroide e pousa na vaga livre da estrutura nova
      this.settleAfterBuild(ship, id);
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
    if (!station || station.type !== "miningStation") return;
    ship.mining = !ship.mining;
  }

  /** Dispara um projétil da nave de ataque (perfurante ou granada). */
  private tryFire(sessionId: string, kind?: "bullet" | "grenade"): void {
    const ship = this.activeShipOf(sessionId);
    // pousada, guardada ou em transição de camada não atira (combat.ts)
    if (!ship || ship.kind !== "attack" || !canFire(ship)) return;
    if (!kind) return;
    if (kind === "bullet") {
      if (ship.ammo <= 0 || ship.fireCooldown > 0) return;
      ship.ammo--;
      ship.fireCooldown = BULLET_COOLDOWN;
    } else {
      if (ship.grenadeAmmo <= 0 || ship.grenadeCooldown > 0) return;
      ship.grenadeAmmo--;
      ship.grenadeCooldown = GRENADE_COOLDOWN;
    }
    const speed = kind === "bullet" ? BULLET_SPEED : GRENADE_SPEED;
    const id = `pr-${this.projSeq++}`;
    const proj: Projectile = {
      kind,
      owner: sessionId,
      level: levelOfLayer(ship.layer),
      sx: ship.sx, sy: ship.sy,
      x: ship.x + Math.cos(ship.angle) * 30,
      y: ship.y + Math.sin(ship.angle) * 30,
      vx: ship.vx + Math.cos(ship.angle) * speed,
      vy: ship.vy + Math.sin(ship.angle) * speed,
      traveled: 0,
    };
    this.projectiles.set(id, proj);
    const ps = new ProjectileSchema();
    ps.kind = kind; ps.owner = sessionId;
    ps.sx = proj.sx; ps.sy = proj.sy;
    ps.x = proj.x; ps.y = proj.y;
    ps.vx = proj.vx; ps.vy = proj.vy;
    ps.traveled = 0;
    ps.level = proj.level;
    this.state.projectiles.set(id, ps);
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
      if (struct.type === "initialBase") {
        this.sim.addOre(sessionId, ship.cargoAmount);
        console.log(`[room] ${sessionId} entregou ${Math.round(ship.cargoAmount)} de minério na base`);
        ship.cargoKind = "";
        ship.cargoAmount = 0;
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
    const active = this.activeShipOf(sessionId);
    if (!active || !active.anchored) return;
    // táxi disponível ancorado numa ESTAÇÃO DE MINERAÇÃO ou BASE INICIAL
    // próprias (ex.: da base, solicitar um transporte de um QG próximo)
    const dest =
      this.nearestOwnStructure(sessionId, active, DOCK_RANGE, "miningStation") ??
      this.nearestOwnStructure(sessionId, active, DOCK_RANGE, "initialBase");
    if (!dest) return;

    let best: { id: string; ship: ShipState; src: { id: string; sx: number; sy: number; x: number; y: number } } | null = null;

    // nave escolhida pelo jogador — precisa estar guardada num QG
    if (shipId) {
      const s = this.sim.ships.get(shipId);
      const src = s ? this.sim.structures.get(s.hqId) : undefined;
      if (s && src && src.type === "hq" && s.owner === sessionId && s.stored) {
        best = { id: shipId, ship: s, src };
      }
    }

    // fallback: nave guardada no QG mais próximo da estação
    if (!best) {
      let bestDist = Infinity;
      for (const [id, s] of this.sim.ships) {
        if (s.owner !== sessionId || !s.stored) continue;
        const src = this.sim.structures.get(s.hqId);
        if (!src || src.type !== "hq") continue;
        const d = dist(src, dest);
        if (d < bestDist) {
          bestDist = d;
          best = { id, ship: s, src };
        }
      }
    }
    if (!best) return; // nenhuma nave em QG
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

  /** Passa o controle do jogador para outra nave própria (prefere um builder). */
  private transferControl(sessionId: string, excludeId: string): boolean {
    let target: [string, ShipState] | null = null;
    for (const [id, s] of this.sim.ships) {
      if (id === excludeId || s.owner !== sessionId || s.autoMining) continue;
      if (!target || (s.kind === "builder" && target[1].kind !== "builder")) target = [id, s];
    }
    if (!target) return false;
    const [tid, ts] = target;
    if (ts.stored) {
      const struct = ts.hqId ? this.sim.structures.get(ts.hqId) : undefined;
      if (struct) this.deployFromHangar(ts, struct);
      else ts.stored = false;
    }
    this.activeShip.set(sessionId, tid);
    return true;
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
    if (!spec || this.sim.getOre(sessionId) < spec.cost) return;

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

    this.sim.spendOre(sessionId, spec.cost);
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
    const pilot = this.activeShipOf(sessionId);
    if (!pilot || !kind) return;
    const spec = SHIP_PRODUCTION[kind];
    if (!spec || this.sim.getOre(sessionId) < spec.cost) return;
    if (!pilot.anchored) return; // precisa estar ancorado numa estrutura

    const hq = this.nearestOwnStructure(sessionId, pilot, Infinity, "hq");
    if (!hq) return;

    // capacidade = vagas de nave do QG compatíveis com a classe produzida
    const bay = this.firstFreeShipBay(hq, kind);
    if (bay < 0) return; // hangar cheio ou sem vaga compatível

    this.sim.spendOre(sessionId, spec.cost);
    const id = `sh-${this.shipSeq++}`;
    const ship = this.spawnShip(id, hq, sessionId, kind);
    ship.hqId = hq.id;
    ship.stored = true;
    ship.bay = bay; // vaga calculada por firstFreeShipBay
    this.state.ships.set(id, this.mirrorSpawn(ship));
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
      if (st.owner === proj.owner) continue;
      if (dist(proj, st) <= STRUCTURE_SPECS[st.type].radius + reach) return st;
    }
    return null;
  }

  /** Anuncia um efeito visual aos clientes (MSG_FX) — não muda o jogo. */
  private fx(kind: FxKind, p: WorldPos): void {
    const ev: FxEvent = { kind, sx: p.sx, sy: p.sy, x: p.x, y: p.y };
    this.broadcast(MSG_FX, ev);
  }

  /** Explosão da granada: dano decrescente com a distância, no nível dela. */
  private detonate(proj: Projectile): void {
    this.fx("blast", proj);
    const falloff = (d: number) => GRENADE_DAMAGE * (1 - d / GRENADE_BLAST_RADIUS);
    for (const [id, s] of [...this.sim.ships]) {
      if (s.owner === proj.owner || hittableLevel(s) !== proj.level) continue;
      const d = dist(proj, s);
      if (d <= GRENADE_BLAST_RADIUS) this.damageShip([id, s], falloff(d));
    }
    if (proj.level !== "surface") return;
    for (const st of [...this.sim.structures.values()]) {
      if (st.owner === proj.owner) continue;
      const d = Math.max(0, dist(proj, st) - STRUCTURE_SPECS[st.type].radius);
      if (d <= GRENADE_BLAST_RADIUS) this.damageStructure(st, falloff(d));
    }
  }

  /** Tira HP da nave; em zero, ela explode. */
  private damageShip([id, s]: [string, ShipState], damage: number): void {
    if (!this.sim.ships.has(id) || !(damage > 0)) return;
    s.hp = Math.max(0, s.hp - damage);
    if (s.hp <= 0) this.destroyShip(id);
  }

  /**
   * Dano de um projétil numa estrutura: sorteado entre ela e as naves
   * GUARDADAS no hangar dela (`splitDamage`, com o gerador semeado da sala).
   * Nave do hangar que zera explode sozinha; estrutura que zera explode com
   * todas as que sobraram no hangar.
   */
  private damageStructure(st: Structure, damage: number): void {
    if (!this.sim.structures.has(st.id) || !(damage > 0)) return;
    const hangar = [...this.sim.ships]
      .filter(([, s]) => s.stored && s.hqId === st.id)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const split = splitDamage(damage, hangar.length, this.combatRng);
    hangar.forEach((entry, i) => this.damageShip(entry, split.ships[i]));
    st.hp = Math.max(0, st.hp - split.station);
    if (st.hp <= 0) this.destroyStructure(st.id);
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
    const doomed = new Set(
      [...this.sim.ships]
        .filter(([, s]) => (s.stored && s.hqId === id) || (s.autoMining && s.stationId === id))
        .map(([sid]) => sid),
    );
    this.fx("structureDown", st);
    this.sim.structures.delete(id);
    this.state.structures.delete(id);
    this.rationDroneTimers.delete(id);
    // a estrutura sai ANTES das naves: se o controle de um jogador passar a
    // outra nave condenada, ela só sai do hangar (não há mais para onde
    // atracar) e explode na volta seguinte, que o passa adiante de novo — ele
    // termina numa nave que sobrevive, ou em nenhuma
    for (const sid of doomed) this.destroyShip(sid);
    for (const s of this.sim.ships.values()) {
      if (s.hqId === id && !s.stored && (s.anchored || s.landingPhase === "landing")) this.liftOff(s);
    }
    console.log(`[room] estrutura ${id} (${st.type}) de ${st.owner} destruída — ${doomed.size} nave(s) junto`);
  }

  /** Destrói uma nave (remove do mundo; se for a nave ativa de um jogador, passa o controle a outra dele). */
  private destroyShip(shipId: string): void {
    const ship = this.sim.ships.get(shipId);
    if (!ship) return;
    // a guardada explode dentro do hangar: quem aparece é a da estrutura
    if (!ship.stored) this.fx("shipDown", ship);
    for (const [sid, active] of this.activeShip) {
      if (active === shipId) {
        this.transferControl(sid, shipId);
        break;
      }
    }
    this.sim.removeShip(shipId);
    this.spiders.delete(shipId);
    this.attackTargets.delete(shipId);
    this.state.ships.delete(shipId);
    console.log(`[room] nave ${shipId} destruída`);
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
    const LAND_DURATION = 1.5;
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
    // IA dos bots neutros
    for (const [id, bot] of this.bots) {
      const ship = this.sim.ships.get(id);
      if (ship) this.sim.setInput(id, computeBotInput(ship, this.sim, bot, dt));
    }
    // BUILDER minerando na estação: enche o estoque LOCAL da estação —
    // logística física: o transporte leva até a base inicial, e só a
    // descarga lá credita a carteira
    for (const ship of this.sim.ships.values()) {
      if (!ship.anchored || !ship.mining || ship.kind !== "builder") continue;
      const station = this.sim.structures.get(ship.hqId);
      if (!station || station.type !== "miningStation") continue;
      const cap = stationOreCap(station.level);
      if (station.oreStore >= cap) { ship.mining = false; continue; }
      const rate = MINING_RATE_BY_KIND["builder"];
      station.oreStore = Math.min(cap, station.oreStore + rate * dt);
    }
    // ESTAÇÕES DE CERES EVOLUÍDAS: as instalações de cada nível acima do 1
    // extraem minério sozinhas, para o estoque LOCAL (o transporte leva à base)
    for (const st of this.sim.structures.values()) {
      if (st.level <= 1 || st.type !== "miningStation") continue;
      const rate = CERES_STATION_ORE_RATE_PER_LEVEL * (st.level - 1);
      st.oreStore = Math.min(stationOreCap(st.level), st.oreStore + rate * dt);
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
      const unloaded = stepSpider(ship, station, spider, dt);
      if (unloaded > 0) {
        station.oreStore = Math.min(stationOreCap(station.level), station.oreStore + unloaded);
      }
    }
    // IA do táxi → voa até o destino; ao chegar, estaciona na 1ª vaga livre
    for (const [id, ship] of this.sim.ships) {
      if (!ship.taxiTo) continue;
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
      } else {
        this.sim.setInput(id, computeTaxiInput(ship, dest));
      }
    }
    // PROJÉTEIS: move, colide, expira. Um tiro só atinge o que está no MESMO
    // nível de combate em que foi disparado (combat.ts) — cruzeiro com
    // cruzeiro; superfície e modo ataque com o nível das estações
    for (const [id, proj] of [...this.projectiles]) {
      const step = Math.hypot(proj.vx, proj.vy) * dt;
      proj.x += proj.vx * dt;
      proj.y += proj.vy * dt;
      normalizePos(proj);
      proj.traveled += step;

      let hit = false;
      if (proj.kind === "bullet") {
        if (proj.traveled >= BULLET_RANGE) {
          hit = true; // expira por distância
        } else {
          const ship = this.shipHitBy(proj, BULLET_RADIUS + SHIP_RADIUS);
          const struct = ship ? null : this.structureHitBy(proj, BULLET_RADIUS);
          hit = !!(ship || struct);
          if (hit) this.fx("hit", proj);
          if (ship) this.damageShip(ship, BULLET_DAMAGE);
          else if (struct) this.damageStructure(struct, BULLET_DAMAGE);
        }
      } else {
        // granada: detona por proximidade com nave ou estrutura inimiga
        if (this.shipHitBy(proj, GRENADE_PROX_RADIUS) || this.structureHitBy(proj, GRENADE_PROX_RADIUS)) {
          this.detonate(proj);
          hit = true;
        }
        // expira por distância (2× alcance do perfurante)
        if (proj.traveled >= BULLET_RANGE * 2) hit = true;
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
    // cooldowns de disparo
    for (const ship of this.sim.ships.values()) {
      if (ship.fireCooldown > 0) ship.fireCooldown = Math.max(0, ship.fireCooldown - dt);
      if (ship.grenadeCooldown > 0) ship.grenadeCooldown = Math.max(0, ship.grenadeCooldown - dt);
    }
    // CENTRO DE DISTRIBUIÇÃO DE RAÇÕES: a cada RATION_DRONE_INTERVAL s,
    // entrega RATION_DRONE_AMOUNT rações a cada estrutura própria dentro do alcance
    for (const [id, center] of this.sim.structures) {
      if (center.type !== "rationCenter") continue;
      if (center.rationStore <= 0) continue;
      let timer = this.rationDroneTimers.get(id) ?? RATION_DRONE_INTERVAL;
      timer -= dt;
      if (timer <= 0) {
        timer = RATION_DRONE_INTERVAL;
        for (const target of this.sim.structures.values()) {
          if (target.id === id || target.owner !== center.owner) continue;
          if (target.type === "rationCenter") continue;
          const { dx, dy } = relVec(center, target);
          if (Math.hypot(dx, dy) > RATION_DRONE_RANGE) continue;
          const delivered = Math.min(RATION_DRONE_AMOUNT, center.rationStore);
          if (delivered <= 0) break;
          const space = RATION_STORE_CAP - target.rationStore;
          const moved = Math.min(delivered, Math.max(0, space));
          if (moved <= 0) continue;
          target.rationStore += moved;
          center.rationStore -= moved;
          console.log(`[room] drone de rações: ${Math.round(moved)} de ${id} → ${target.id}`);
        }
      }
      this.rationDroneTimers.set(id, timer);
    }
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
    }
    // minério e nave ativa por jogador
    for (const [sid, p] of this.state.players) {
      p.ore = this.sim.getOre(sid);
      p.activeShip = this.activeShip.get(sid) ?? "";
    }
  }
}
