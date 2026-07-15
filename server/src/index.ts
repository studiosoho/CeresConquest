import { Server, LobbyRoom } from "colyseus";
import { DEFAULT_PORT } from "@ceres/shared";
import { MatchRoom } from "./rooms/MatchRoom";

const port = Number(process.env.PORT ?? DEFAULT_PORT);

const gameServer = new Server();

// sala de lobby embutida do Colyseus: mantém a lista de salas em tempo real
// para o cliente (nome, jogadores conectados/limite). Ver:
// https://docs.colyseus.io/room/built-in/lobby
gameServer.define("lobby", LobbyRoom);

// enableRealtimeListing: cada "match" aparece no lobby e o notifica ao ser
// criada, ter metadata alterada ou ser descartada; join/leave chamam
// updateLobby() dentro da sala para refletir a contagem de jogadores.
gameServer.define("match", MatchRoom).enableRealtimeListing();

gameServer.listen(port).then(() => {
  console.log(`[server] CeresConquest ouvindo em ws://localhost:${port}`);
});
