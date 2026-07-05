import { Schema, MapSchema, type } from "@colyseus/schema";

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
  @type("boolean") mining = false;
  @type("boolean") anchored = false;
  @type("boolean") stored = false;
  @type("boolean") autoMining = false;
  @type("string") owner = "";
  @type("string") kind = "builder";
  @type("string") hqId = "";
  @type("string") stationId = "";
  @type("string") anchoredAsteroidId = "";
  @type("int8") bay = -1;
  @type("string") landingPhase = "";
  @type("float32") landingProgress = 0;
  @type("float32") landingTargetX = 0;
  @type("float32") landingTargetY = 0;
  @type("float32") landingOriginX = 0;
  @type("float32") landingOriginY = 0;
  @type("float32") landingAsteroidSpin = 0;
}

export class PlayerSchema extends Schema {
  @type("float32") ore = 0;
  /** id da nave que o jogador pilota */
  @type("string") activeShip = "";
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
}

export class MatchState extends Schema {
  @type("uint32") worldSeed = 0;
  // fronteira circular do mapa (arena): centro em setores + raio em unidades
  @type("int32") mapCenterSx = 0;
  @type("int32") mapCenterSy = 0;
  @type("float32") mapRadius = 0;
  @type({ map: ShipSchema }) ships = new MapSchema<ShipSchema>();
  @type({ map: StructureSchema }) structures = new MapSchema<StructureSchema>();
  @type({ map: PlayerSchema }) players = new MapSchema<PlayerSchema>();
}
