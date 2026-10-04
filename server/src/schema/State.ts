import { Schema, MapSchema, ArraySchema, type } from "../colyseus";

/**
 * Estado sincronizado por rede. Espelho do sim-core — só o que os clientes
 * precisam ver. Asteroides intactos NÃO entram aqui (procgen determinística
 * no cliente, banda zero).
 */
export class ShipSchema extends Schema {
  @type("int32") sx = 0;
  @type("int32") sy = 0;
  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("float32") vx = 0;
  @type("float32") vy = 0;
  @type("float32") angle = 0;
  /**
   * Velocidade angular (rad/s). Sincronizada porque o contato DEPENDE dela: o
   * atrito age sobre a velocidade da casca, que leva ω×r junto (ver
   * collision.ts). Sem este campo a predição do cliente resolveria um raspão
   * contra uma nave que ele acha parada de rotação.
   */
  @type("float32") av = 0;
  @type("boolean") mining = false;
  @type("boolean") anchored = false;
  @type("boolean") stored = false;
  @type("boolean") autoMining = false;
  @type("string") owner = "";
  @type("string") kind = "builder";
  @type("string") hqId = "";
  @type("string") stationId = "";
  @type("string") anchoredAsteroidId = "";
  /**
   * Estrutura de destino em taxiamento ("" = não está taxiando). Sincronizado
   * porque a PREDIÇÃO precisa: o servidor deixa naves em táxi fora dos contatos
   * nave × nave (corredor de trânsito, ver SimWorld.tick), e o cliente só
   * consegue repetir essa regra se souber quem está taxiando.
   */
  @type("string") taxiTo = "";
  @type("int8") bay = -1;
  @type("string") landingPhase = "";
  @type("float32") landingProgress = 0;
  @type("float32") landingTargetX = 0;
  @type("float32") landingTargetY = 0;
  @type("float32") landingOriginX = 0;
  @type("float32") landingOriginY = 0;
  @type("float32") landingAsteroidSpin = 0;
  /** porão de carga (transporte): "" | "ore" | "rations" + quantidade */
  @type("string") cargoKind = "";
  @type("float32") cargoAmount = 0;
  @type("float32") hp = 100;
  @type("uint8") ammo = 0;
  @type("uint8") grenadeAmmo = 0;
  /**
   * Armamento (shared/weapons.ts): arma selecionada; desvio da mira em volta
   * do nariz (rad), alvo do computador de tiro (id de nave ou estrutura, ou
   * "") e se a mira está TRAVADA (laser).
   */
  @type("string") weapon = "missile";
  @type("float32") aimOffset = 0;
  @type("string") aimTarget = "";
  @type("boolean") aimLocked = false;
  /** segundo canhão do laser (o primeiro usa aimOffset/aimLocked) */
  @type("float32") aimOffset2 = 0;
  /** refinaria do builder: lotes na fila e progresso do lote atual (0..1) */
  @type("uint8") refineQueue = 0;
  /** kits de construção a bordo (builder) — o porão de minério é cargoKind/cargoAmount */
  @type("uint16") kits = 0;
  /** refino automático do builder ligado ([E]) */
  @type("boolean") autoRefine = false;
  /** rações a bordo (builder) */
  @type("uint16") rations = 0;
  @type("float32") refineProgress = 0;
  @type("boolean") aimLocked2 = false;
  /**
   * Modo ataque: a estrutura atacada e o raio da parede macia da órbita
   * (sim-core attackModeInput). A predição do cliente traduz os comandos
   * com eles, igual ao servidor. "" = fora do modo ataque.
   */
  @type("string") attackTarget = "";
  @type("float32") attackRadius = 0;
  /**
   * Camada de voo (shared/layers.ts): "cruise" | "surface" | "attack". Em
   * transição, `layerTo` é o destino e `layerProgress` vai de 0 a 1; parada
   * numa camada, `layerTo` é "". A predição do cliente precisa dos três para
   * saber contra o que a nave colide.
   */
  @type("string") layer = "cruise";
  @type("string") layerTo = "";
  @type("float32") layerProgress = 0;
}

export class ProjectileSchema extends Schema {
  /** "missile" | "mine" */
  @type("string") kind = "missile";
  @type("string") owner = "";
  @type("int32") sx = 0;
  @type("int32") sy = 0;
  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("float32") vx = 0;
  @type("float32") vy = 0;
  /** distância percorrida (para expirar o míssil) */
  @type("float32") traveled = 0;
  /** nível de combate: "cruise" ou "surface" (o das estações) — só atinge o mesmo */
  @type("string") level = "cruise";
  /** mina parada e ARMADA (pisca em vermelho; detona por proximidade) */
  @type("boolean") armed = false;
}

export class PlayerSchema extends Schema {
  /** id da nave que o jogador pilota */
  @type("string") activeShip = "";
  /** nome de jogador informado no lobby (join option) */
  @type("string") name = "";
  /**
   * Fim de jogo: o jogador perdeu a nave sem ter para onde o escape pod ir
   * (nenhum QG útil, nenhum builder em hangar). `survival` = segundos de
   * partida; `summary` = JSON com o que ele construiu e fabricou.
   */
  /**
   * Estrutura em que o piloto ESPERA, sem nave ("" = está numa nave): pôs a
   * mineradora para autominerar, ou chegou de escape pod. Dali pede táxi,
   * embarca numa nave do hangar ([C]) ou, num QG, fabrica.
   */
  @type("string") station = "";
  @type("boolean") eliminated = false;
  @type("float32") survival = 0;
  @type("string") summary = "";
  /** placar da partida (shared/match.ts): pontos e minhocas mortas */
  @type("uint32") score = 0;
  @type("uint16") wormKills = 0;
  /** jogador-bot (servidor) */
  @type("boolean") bot = false;
  /** ainda só ASSISTINDO (entrou como espectador): [R] o põe em jogo */
  @type("boolean") spectator = false;
}

export class StructureSchema extends Schema {
  @type("string") stype = "";
  @type("string") owner = "";
  @type("int32") sx = 0;
  @type("int32") sy = 0;
  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("float32") angle = 0;
  @type("string") asteroidId = "";
  @type("string") asteroidClass = "";
  @type("uint8") shipBays = 0;
  @type("uint8") expandedBays = 0;
  @type("uint8") spiderBays = 0;
  @type("uint8") nextShipBay = 0;
  @type("uint8") nextSpiderBay = 0;
  /** minério LOCAL da estação (aguardando transporte) */
  @type("float32") oreStore = 0;
  /** rações em estoque (base recebe da Terra; QG/estação recebem por transporte) */
  @type("float32") rationStore = 0;
  /** pontos de vida e o máximo do tipo; em zero a estrutura é destruída */
  @type("float32") hp = 0;
  @type("float32") maxHp = 0;
  /** nível (a estação de mineração de Ceres evolui; as demais ficam em 1) */
  @type("uint8") level = 1;
  /** turretas prontas (turrets.ts) */
  @type("uint8") turrets = 0;
  /** obra em curso: índice do lugar (−1 = nenhuma), progresso 0..1 e o builder que constrói */
  @type("int8") turretBuild = -1;
  @type("float32") turretProgress = 0;
  @type("string") turretBuilder = "";
  /** um builder está consertando esta estrutura ([G]) */
  @type("boolean") repairing = false;
  /** kits de construção guardados no buffer da estrutura */
  @type("uint16") kitStore = 0;
  /** central de rações: níveis das melhorias dos drones (logistics.ts) */
  @type("uint8") droneLv = 0;
  @type("uint8") speedLv = 0;
  @type("uint8") cargoLv = 0;
}

/** Drone de ração em voo entre a central e as estações (logistics.ts). */
export class DroneSchema extends Schema {
  @type("string") owner = "";
  @type("string") center = "";
  @type("int32") sx = 0;
  @type("int32") sy = 0;
  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("float32") angle = 0;
  /** rações a bordo */
  @type("uint8") cargo = 0;
}

/** Minhoca gigante (shared/worms.ts): a cabeça e o corpo, em offsets dela. */
export class WormSchema extends Schema {
  @type("int32") sx = 0;
  @type("int32") sy = 0;
  @type("float32") x = 0;
  @type("float32") y = 0;
  @type("float32") angle = 0;
  @type("float32") hp = 0;
  /** 0..1 — cabeça erguida para fora do chão; boca aberta */
  @type("float32") breach = 0;
  @type("float32") mouth = 0;
  /** gomos 1.. como pares (dx, dy) a partir da cabeça */
  @type(["float32"]) segs = new ArraySchema<number>();
  /** altura de cada gomo (0 = cabeça): 0 = fundo (centro das rochas) .. 255 = camada de cruzeiro */
  @type(["uint8"]) lift = new ArraySchema<number>();
}

export class MatchState extends Schema {
  @type("uint32") worldSeed = 0;
  /** PARTIDA (shared/match.ts): modo de vitória, tempo-limite (s, 0 = sem), relógio (s) e o fim */
  @type("string") victory = "lastStand";
  @type("float32") timeLimit = 0;
  @type("float32") clock = 0;
  @type("boolean") finished = false;
  /** sessionId do vencedor ("" = ninguém) */
  @type("string") winner = "";
  /** velocidade do jogo (mineração, broca e refino) */
  @type("uint8") speed = 1;
  // fronteira circular do mapa (arena): centro em setores + raio em unidades
  @type("int32") mapCenterSx = 0;
  @type("int32") mapCenterSy = 0;
  @type("float32") mapRadius = 0;
  @type({ map: ShipSchema }) ships = new MapSchema<ShipSchema>();
  @type({ map: StructureSchema }) structures = new MapSchema<StructureSchema>();
  @type({ map: PlayerSchema }) players = new MapSchema<PlayerSchema>();
  @type({ map: ProjectileSchema }) projectiles = new MapSchema<ProjectileSchema>();
  @type({ map: DroneSchema }) drones = new MapSchema<DroneSchema>();
  @type({ map: WormSchema }) worms = new MapSchema<WormSchema>();
  /** toca aberta das minhocas: id da plataforma de Ceres ("" = nenhuma) e minas já detonadas nela */
  @type("string") wormHole = "";
  @type("uint8") wormHoleSeal = 0;
}
