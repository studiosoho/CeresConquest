import {
  MINING_RATE,
  SPIDER_MINING_MULT,
  SPIDER_SPEED,
  SPIDER_MINE_TIME,
  normalizePos,
  type WorldPos,
} from "@ceres/shared";
import type { ShipState } from "@ceres/sim-core";

/**
 * Robô-aranha de mineração: a mineradora "transformada" que caminha pelo
 * asteroide da estação — vai a um ponto aleatório, minera por um tempo e
 * volta para descarregar na estação (que fica no centro do asteroide).
 */
export interface SpiderState {
  phase: "toSite" | "mine" | "toStation" | "unload";
  /** posição polar atual relativa ao centro do asteroide */
  angle: number;
  r: number;
  /** destino do passeio */
  targetAngle: number;
  targetR: number;
  timer: number;
  cargo: number;
  /** raio do asteroide hospedeiro */
  astRadius: number;
}

export function makeSpiderState(astRadius: number): SpiderState {
  return {
    phase: "toSite",
    angle: Math.random() * Math.PI * 2,
    r: astRadius * 0.15,
    targetAngle: Math.random() * Math.PI * 2,
    targetR: astRadius * 0.8,
    timer: 0,
    cargo: 0,
    astRadius,
  };
}

const SPIDER_RATE = MINING_RATE * SPIDER_MINING_MULT;

/**
 * Avança a aranha um passo. Posiciona a nave diretamente (sem física) e
 * devolve o minério descarregado neste tick (para creditar o dono).
 */
export function stepSpider(
  ship: ShipState,
  station: WorldPos,
  st: SpiderState,
  dt: number,
): number {
  let unloaded = 0;
  ship.mining = false;

  const step = SPIDER_SPEED * dt;
  const angStep = step / Math.max(st.r, 80);

  switch (st.phase) {
    case "toSite": {
      const dAng = Math.atan2(Math.sin(st.targetAngle - st.angle), Math.cos(st.targetAngle - st.angle));
      st.angle += Math.abs(dAng) <= angStep ? dAng : Math.sign(dAng) * angStep;
      st.r += Math.min(step, Math.max(-step, st.targetR - st.r));
      if (Math.abs(dAng) < 0.05 && Math.abs(st.targetR - st.r) < 10) {
        st.phase = "mine";
        st.timer = SPIDER_MINE_TIME;
      }
      break;
    }
    case "mine": {
      st.timer -= dt;
      st.cargo += SPIDER_RATE * dt;
      ship.mining = true;
      if (st.timer <= 0) st.phase = "toStation";
      break;
    }
    case "toStation": {
      st.r += Math.min(step, Math.max(-step, st.astRadius * 0.12 - st.r));
      if (st.r <= st.astRadius * 0.14) {
        st.phase = "unload";
        st.timer = 1.0;
      }
      break;
    }
    case "unload": {
      st.timer -= dt;
      if (st.timer <= 0) {
        unloaded = st.cargo;
        st.cargo = 0;
        st.targetAngle = Math.random() * Math.PI * 2;
        st.targetR = st.astRadius * (0.55 + Math.random() * 0.35);
        st.phase = "toSite";
      }
      break;
    }
  }

  // posiciona a aranha na polar (centro do asteroide = posição da estação)
  const prevX = ship.x;
  const prevY = ship.y;
  ship.sx = station.sx;
  ship.sy = station.sy;
  ship.x = station.x + Math.cos(st.angle) * st.r;
  ship.y = station.y + Math.sin(st.angle) * st.r;
  normalizePos(ship);
  ship.angle = Math.atan2(ship.y - prevY, ship.x - prevX) || ship.angle;
  ship.vx = 0;
  ship.vy = 0;
  return unloaded;
}
