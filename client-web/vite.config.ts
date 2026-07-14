import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  // GitHub Pages de projeto serve em /<repo>/, não na raiz do domínio.
  // Só se aplica ao build; o dev server continua na raiz.
  base: command === "build" ? "/CeresConquest/" : "/",
  server: {
    port: 5173,
  },
}));
