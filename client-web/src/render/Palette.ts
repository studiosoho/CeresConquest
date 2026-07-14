/**
 * Palette — identidade visual centralizada do jogo.
 * Estilo retrô vetorial (Asteroids/Atari): linhas fosforescentes sobre preto,
 * sem preenchimentos. Poucas cores, todas em tom de "fósforo de CRT".
 */

export const Palette = {
  /** cor base de todo traço wireframe (fósforo branco-azulado) */
  wire: 0xf2f6ff,

  ship: {
    /** naves são desenhadas em branco puro; o tint do sprite dá a cor final */
    line: 0xffffff,
  },

  asteroid: {
    line:   0xc9d4e0,   // contorno da rocha
    fill:   0x232c38,   // faces do corpo 3D (rocha escura, lida por luz)
    pad:    0x9fe0d8,   // retângulo da plataforma de construção
  },

  ceres: {
    body:   0xe0b34c,   // dourado — marco do mapa
    crater: 0xc99a38,
    core:   0xffe066,
  },

  structure: {
    own:    0x4dffa6,   // verde-fósforo (minhas estruturas)
    other:  0xffb85c,   // âmbar (estruturas alheias)
    hangar: 0x6a90b0,   // vagas de hangar
    fleet:  0x7dff7d,   // minhas naves guardadas/frota
    fill:   0x39434f,   // corpo dos prédios 3D (um tom acima da rocha)
  },

  fx: {
    beam:       0xaaddff,
    jet:        0xffffff,   // chama do motor — linhas brancas piscantes
    landZone:   0xffee66,
    boundary:   0xff5544,
    bullet:     0xffffff,
    grenade:    0xff8833,
  },

  ui: {
    text:         0xd8e8f8,
    minimapBg:    0x000000,
    minimapBorder:0x9fb8cc,
    minimapGrid:  0x20303f,
    starBright:   0xffffff,
    starDim:      0x66788e,
  },
} as const;
