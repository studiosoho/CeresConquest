import { createRequire } from "node:module";

/**
 * Ponte para os pacotes do Colyseus, que são CommonJS.
 *
 * O servidor roda como ESM (`"type": "module"` no package.json) para que
 * sim-core e shared carreguem como ESM nativo. No modo CommonJS o tsx converte
 * cada import entre módulos num getter, e a colisão com rocha — que chama
 * relVec, SECTOR_SIZE e sectorAsteroids milhares de vezes por tick — ficava ~8×
 * mais cara: 62 ms de tick contra 7,5 ms com 60 naves prensadas numa rocha
 * (orçamento 50 ms a 20 Hz).
 *
 * Os dois pacotes do Colyseus entram pelo `require`, não por `import`:
 *  - `colyseus` reexporta @colyseus/core de um jeito que o ESM não enxerga como
 *    export nomeado — Room, Server e LobbyRoom chegariam undefined;
 *  - `@colyseus/schema` tem um build ESM separado. Importado por `import`, o
 *    estado seria de uma CÓPIA diferente da que o serializador do core carrega
 *    por `require`, e os `instanceof Schema` dele falhariam.
 * Pelo `require`, tudo é a mesma instância que o core usa.
 */
const require = createRequire(import.meta.url);

export const { Server, LobbyRoom, Room, updateLobby } = require("colyseus") as typeof import("colyseus");
export type { Client } from "colyseus";

export const { Schema, MapSchema, type } = require("@colyseus/schema") as typeof import("@colyseus/schema");
