/**
 * shipAB — chaves de A/B de CUSTO das naves, para isolar no jogo (com o timer
 * de GPU) cada candidato a custo sem editar código. No console do navegador:
 *
 *   __ceresShipAB.get()                    // estado atual
 *   __ceresShipAB.set({ trails: false })   // desliga um suspeito
 *
 * Todas nascem `true` (= o jogo como ele é). O que cada uma isola:
 *   perCameraScale  a troca de escala por câmera (recalcula matriz de mundo e
 *                   reenvia o buffer de instâncias no passe do cockpit); false
 *                   = o cockpit vê as naves infladas, sem troca
 *   hull / livery   cada camada instanciada (visibilidade das instâncias)
 *   trails          a malha única de jatos (EffectsRenderer/ShipTrails)
 *   trailHeads      só as cabeças quentes dos jatos
 *
 * R4: `lights`, `glowLights` e `lightsAdditive` saíram junto com a camada de
 * luzes que elas mediam (0,86 + 0,98 + 0,08 ms no A/B da R3). R5: `trim`
 * (a fita-contorno) virou `livery` (a divisa pintada no dorso).
 */

export const ShipAB = {
  perCameraScale: true,
  hull: true,
  livery: true,
  trails: true,
  trailHeads: true,
  /** incrementa a cada `set` — quem aplica compara com a última versão vista */
  version: 0,
};

type Flags = Omit<typeof ShipAB, "version">;

(globalThis as unknown as { __ceresShipAB: unknown }).__ceresShipAB = {
  get: (): Flags => {
    const { version: _v, ...flags } = ShipAB;
    void _v;
    return flags;
  },
  set: (patch: Partial<Flags>): void => {
    Object.assign(ShipAB, patch);
    ShipAB.version++;
  },
};
