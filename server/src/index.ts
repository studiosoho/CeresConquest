import { Server } from "colyseus";
import { DEFAULT_PORT } from "@ceres/shared";
import { MatchRoom } from "./rooms/MatchRoom";

const port = Number(process.env.PORT ?? DEFAULT_PORT);

const gameServer = new Server();
gameServer.define("match", MatchRoom);

gameServer.listen(port).then(() => {
  console.log(`[server] CeresConquest ouvindo em ws://localhost:${port}`);
});
