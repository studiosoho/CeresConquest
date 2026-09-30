/**
 * Palette — identidade visual centralizada do jogo.
 * Herança retrô vetorial (Asteroids/Atari) nas LINHAS: traços fosforescentes,
 * poucas cores, tudo em tom de fósforo de CRT.
 *
 * Os SÓLIDOS, porém, não são mais "linha sobre preto": desde a passada de
 * iluminação eles seguem a regra de matte painting que o Homeworld usa —
 * divisão de temperatura (chave quente / sombra fria) sobre um fundo que
 * nunca é preto chapado. Por isso os blocos `space` e `light` abaixo: eles
 * são a INTENÇÃO tonal da cena, e as três luzes de Lighting.ts, o céu de
 * Backdrop.ts e o albedo das rochas são todos derivados deles. Mexer num
 * valor daqui muda o quadro inteiro de forma coerente — é o ponto.
 *
 * Ordem de valor pretendida (do mais escuro ao mais claro), medida no
 * quadro final: sombra da rocha PERTO < canto do céu < campo do céu < sombra
 * da rocha LONGE < detrito distante < névoa perto do sol < faceta com chave <
 * rim frio < disco solar. A sombra da rocha de perto ficar ABAIXO do céu é o
 * que produz silhueta; a sombra da rocha de longe ficar ACIMA dele é o que
 * produz DISTÂNCIA. Essa inversão é o eixo inteiro da rodada 3 e quem a
 * executa é Aerial.ts — aqui ficam só os extremos da escada.
 */

export const Palette = {
  /** cor base de todo traço wireframe (fósforo branco-azulado) */
  wire: 0xf2f6ff,

  ship: {
    /** naves são desenhadas em branco puro; o tint do sprite dá a cor final */
    line: 0xffffff,
    /**
     * CASCO SÓLIDO (ver ShipMeshGenerator). É o DIFUSO do material de casco;
     * as peças levam só a razão sobre ele na cor de vértice. Cinza-aço MÉDIO,
     * na faixa de valor das rochas (faceta acesa de regolito ~0x6b6459), e
     * NEUTRO para todo dono — a identidade do dono vive na divisa pintada (R5).
     *
     * RODADA 2: a rodada 1 saiu "retângulo branco, sem lado de sombra" com
     * 0x848a92 × tint branco × clamp do shader × névoa do glow. Medido na
     * sonda offline (álgebra exata do StandardMaterial, luzes nas posições
     * reais a zoom 0.12, 8 proas, só o casco principal, faces voltadas para a
     * câmera, luminância sRGB): faceta clara ~154–172, escura ~28–34, razão
     * MEDIANA 5,4:1 (caça) a 6,8:1 (construtora) — a ordem das rochas boas. A
     * água acesa fecha abaixo do limiar do bloom; a de sombra fica ABAIXO do
     * céu médio (`space.deep`, lum ~45), que é o que faz silhueta.
     */
    hull: 0x6e737b,
    /** nacelas, braços, mastros — a massa mecânica, um degrau abaixo */
    hullDark: 0x464b53,
    /** cabines e pontes de comando: pálido e quente, lê como "habitado".
     *  R5: 0xa0977f → 0x938a74 — sob a chave cheia a cabine clampava em
     *  branco e era metade dos pixels de casco acima do limiar de bloom */
    trim: 0x938a74,
    /** faixa de segurança das ferramentas (broca, garras, lança) — o amarelo
     *  industrial dos coletores do Homeworld; só em peças de trabalho */
    hazard: 0xa88532,
    /** vidro de canopy (fosco; sem especular no rig) */
    glass: 0x1e2a3a,
    /** contêineres/tremonhas: ferrugem, azul-petróleo, ocre — dessaturados
     *  para não competirem com o tint de dono */
    cargo: [0x7a4e33, 0x445e66, 0x8a7446],
    // R4: luzes de navegação (vermelho/verde) e frestas de janela SAÍRAM —
    // lidas como interface pelo cego e ~1,8 ms de GPU no GlowLayer (A/B).
    /**
     * CORPO do jato (ShipTrails): azul SATURADO, a leitura dos caças de
     * Homeworld 3. Saturado de propósito, e não só por gosto: a luminância de
     * um azul puro é baixa (o canal que pesa, o verde, está a ~0,5), então o
     * corpo pode ir a quase ganho cheio sem cruzar o limiar 0,80 do bloom —
     * presença por croma, não por estouro.
     */
    trail: 0x2b86ff,
    /**
     * Tinta da DIVISA do dono (R5): albedo claro, multiplicado pela cor do
     * dono. Na água da chave a divisa da nave própria vai a branco; na de
     * sombra ela cai junto com o casco — é pintura sob a luz da cena.
     */
    livery: 0xb8bcc2,
    /**
     * Piso aditivo FRIO do casco e da divisa (canal de ambiente): o "tom do
     * ambiente" que faltava à água de sombra — petróleo, não cinza neutro.
     * Pequeno de propósito: soma ~(5,11,14) e não leva a sombra ao valor do
     * céu (a separação do fundo é do flanco realçado, EDGE_BOOST no gerador).
     */
    ambient: 0x050b0e,
    /** CABEÇA do jato, no bocal: ciano quase branco. É o único ponto que pode
     *  passar do limiar do bloom, e é pequeno (o "ponto quente" de referência) */
    trailHot: 0xd6f3ff,
  },

  /** o volume onde a cena acontece (céu procedural + detritos de fundo) */
  space: {
    /** canto mais escuro do céu — azul-marinho, NUNCA 0,0,0. Ainda sobrevive
     *  às DUAS vinhetas (a pintada no céu e a do pós) sem virar preto.
     *  Medido no quadro da rodada 2, o canto inferior direito saía em
     *  (0,5,10): as duas vinhetas somadas comiam o valor inteiro. Subiu um
     *  degrau, e as duas vinhetas foram afrouxadas junto (ver GameScene). */
    void: 0x121e32,
    /** campo médio do céu — é contra este valor que a sombra da rocha,
     *  MAIS ESCURA que ele, produz silhueta */
    deep: 0x1b3048,
    /** névoa fria no extremo oposto ao canto escuro */
    haze: 0x2d4d6b,
    /**
     * COR DE CONVERGÊNCIA da perspectiva atmosférica (ver Aerial.ts): é para
     * ela que o albedo de TODA superfície caminha com a distância, e é dela
     * que sai o piso aditivo que levanta a sombra do que está longe.
     *
     * Fica um degrau ACIMA de `deep` (o campo médio do céu) de propósito: se
     * fosse igual, a massa distante se dissolveria no fundo e a camada
     * sumiria; um degrau acima, ela continua sendo uma silhueta legível — que
     * é a diferença entre "camada de profundidade" e "borrão de lente".
     *
     * DESSATURADO em relação ao céu, de propósito. Névoa não é céu com mais
     * brilho — é luz espalhada por partículas, e chega ao olho mais CINZA que a
     * fonte. Convergindo para um azul saturado, as lajes de fundo saíam num
     * azul-piscina que gritava mais que as rochas do primeiro plano; com este
     * cinza-azul elas leem como massa de pedra vista através de ar.
     *
     * RODADA 4 — ESCURECEU (era 0x3b5068). Névoa aproxima tudo do valor do
     * CÉU, e o nosso céu é marinho: aqui distância ESCURECE. Com a névoa mais
     * clara que o céu, a laje de fundo virava a massa mais brilhante do quadro
     * e avançava sobre o primeiro plano — coisa clara avança, sempre. Este
     * valor fica um degrau acima de `deep` (o campo médio do céu): longe
     * escurece e achata sem sumir.
     */
    aerial: 0x24384f,
    /** véu quente na vizinhança do sol. Pintado em SOURCE-OVER e não em
     *  composição aditiva: somado sobre um campo azul, qualquer quente vira
     *  cinza neutro e a divisão de temperatura do fundo se perde. */
    warmHaze: 0x6f5a44,
    /** banda de nebulosa fria (aditiva sobre o campo) */
    nebulaCold: 0x1d5a7a,
    /** banda de nebulosa quente-arroxeada (aditiva) */
    nebulaWarm: 0x53385c,
    // `dustLane` foi removida na rodada 4 junto com as faixas que ela pintava:
    // banda escura em diagonal sobre um plano de fundo não tem profundidade,
    // não é ocluída por nada e foi reprovada duas vezes como "artefato de
    // shader". Estrutura no vazio passou a ser trabalho da geometria (as três
    // camadas de detrito), não da textura do céu.
    /** massa que oclui um canto do céu (também em multiply/alpha) */
    occluder: 0x080d16,
    /** núcleo do disco solar — o único ponto acima do limiar do bloom */
    sunCore: 0xfffaee,
    /** halo do disco solar */
    sunGlow: 0xffd696,
    /**
     * Albedo ÚNICO das lajes de detrito. Os seis valores por camada saíram:
     * as três camadas agora são o MESMO material de pedra passado por
     * `Aerial.applyAerial` com t diferente, e é a função que decide albedo e
     * piso. Camada de fundo não é "outra rocha", é a mesma rocha com mais ar
     * na frente — e escrever isso como uma função em vez de seis constantes é
     * o que garante que a escada não saia do lugar quando a paleta mudar.
     *
     * Ardósia fria e ESCURA: as lajes ocupam um terço do quadro e o piso de
     * névoa já as levanta bastante; com albedo claro elas engoliriam a cena.
     */
    debrisRock: 0x353c47,
    /**
     * RODADA 7 — albedo da camada 0, o PRIMEIRO PLANO. A rodada tirou das
     * lajes pálidas a linguagem de perto (corte de borda, escala) e a deu às
     * massas da camada 0; mas elas vestiam `debrisRock`, ardósia FRIA, e com
     * t ≈ 0 a face acesa saía num cinza-azul a poucos degraus do céu — de novo
     * posição de perto com cor de longe, só que invertido. A regra do quadro é
     * "perto é quente, saturado e com sombra funda": este é o regolito das
     * rochas (`asteroid.fill`) a ~60 % do valor e com o croma um pouco acima, de
     * modo que a massa cortada pela borda lê como a pedra MAIS PRÓXIMA da
     * mesma família, e escura o bastante para não roubar o assunto. O lado de
     * sombra (rebote azul × este albedo) cai em ~(6,9,10): abaixo do canto do
     * céu, que é o que faz silhueta.
     */
    debrisNear: 0x4b3c2c,
  },

  /** rig de luz (ver Lighting.ts) — as cores, não as direções */
  light: {
    /** chave: sol distante, âmbar-branco */
    key: 0xffdfb3,
    /** kicker frio que rasa a silhueta */
    rim: 0x4d94ff,
    /**
     * "Céu" da hemisférica: o REBOTE FRIO, e é ele que pinta o lado escuro.
     * Subiu de 0x33506e (cinza-azulado) para um azul saturado porque a queixa
     * medida era "lado escuro em marrom chapado, zero bounce": com um rebote
     * dessaturado, uma faceta de `ndl` baixo continuava dominada pela sobra da
     * chave âmbar e saía marrom-fosco. Com o rebote saturado, a mesma faceta
     * vira ardósia azul e o terminador passa a SEPARAR duas temperaturas em
     * vez de dois brilhos do mesmo âmbar.
     */
    fillSky: 0x2f5c9c,
    /** piso da hemisférica — o valor mínimo de qualquer faceta visível */
    fillGround: 0x151d33,
    /** farol da nave própria (lâmpada fria contra o sol quente) */
    headlight: 0xb3d9ff,
  },

  asteroid: {
    line: 0xc9d4e0,   // contorno da rocha
    /**
     * TRÊS litologias, não uma. "Todo asteroide, do canto inferior esquerdo ao
     * canto superior direito, sai no mesmo tan" era metade problema de
     * profundidade e metade problema de VARIEDADE: um único albedo em ~250
     * corpos garante que nenhum tratamento de luz vai salvar o campo. As três
     * ficam na mesma família de valor (a silhueta continua legível contra o
     * céu) e divergem só em temperatura, que é o eixo que a chave âmbar e o
     * rebote azul já exploram.
     *
     * `fill` continua sendo o regolito quente e continua sendo o dominante —
     * é a identidade do jogo, as outras duas são o contraponto.
     *
     * RODADA 4: as três se aproximaram. O quadro colapsou em monocromático e
     * parte da culpa era ter uma litologia FRIA competindo com o azul do
     * fundo — variedade de albedo não pode custar a divisão de temperatura.
     * A divisão agora vem da LUZ (chave âmbar × rebote azul), e as litologias
     * só variam o quanto de quente cada rocha aceita.
     */
    /**
     * RODADA 7 — SEPARADAS EM VALOR, e não só em matiz. O julgamento disse
     * "os asteroides ocres são todos o mesmo ocre, nenhum lê como gelo, metal
     * ou rocha diferente", e medindo as três da rodada 5 o motivo salta: os
     * VALORES MÉDIOS eram 103, 105 e 103. Elas divergiam só em temperatura, e
     * matiz sozinho não lê como litologia — lê como a mesma pedra sob luz um
     * pouco diferente, que é precisamente a frase do veredito.
     *
     * Litologia de verdade separa em ALBEDO: regolito ~0.15, basalto ~0.07,
     * gelo/metal muito acima. Os valores médios agora são 67, 103 e 134: o
     * basalto metade do gelo, o regolito no meio — uma escada de TRÊS degraus
     * de valor, não três matizes num degrau só.
     *
     * O TETO É O BLOOM, mas ele é de LUMINÂNCIA LINEAR, não de canal sRGB. A
     * primeira versão desta separação travou o gelo em 125 no canal mais
     * claro achando que 205/255 estava "logo abaixo" do limiar de 0.80 — não
     * está: o extrator do Babylon compara `dot(lum, rgb)` no alvo linear, e a
     * faceta de regolito mais clara (205,152,90 sRGB) dá 0.36 ali. E a chave é
     * ÂMBAR (255,223,179): o canal azul de uma litologia fria recebe só 70 % da
     * luz que o vermelho recebe. Refeita a conta para o gelo abaixo, a faceta
     * mais clara possível dele (junto ao sol, chave cheia) sai em ~(200,192,168)
     * → 0.53 linear. Folga de sobra; o gelo sobe e o basalto fica onde estava.
     */
    fill: 0x7d6a4e,          // regolito quente — 125,106,78  (média 103)
    fillNeutral: 0x46443f,   // basalto escuro — 70,68,63     (média 67)
    fillCool: 0x7a8692,      // gelo/metal claro — 122,134,146 (média 134)
  },

  ceres: {
    // cinza de regolito — o corpo 3D tem o próprio tom (CeresMeshGenerator);
    // este é o do marcador no minimapa
    body: 0xa9a6a0,
  },

  structure: {
    own: 0x4dffa6,   // verde-fósforo (minhas estruturas)
    other: 0xffb85c,   // âmbar (estruturas alheias)
    hangar: 0x6a90b0,   // vagas de hangar
    fleet: 0x7dff7d,   // minhas naves guardadas/frota
    /** corpo dos prédios 3D — segue acima da rocha (casco fabricado reflete
     *  mais que regolito), acompanhando o novo albedo do asteroide */
    fill: 0x787468,
  },

  fx: {
    beam: 0xaaddff,
    jet: 0xffffff,   // chama do motor — linhas brancas piscantes
    landZone: 0xffee66,
    boundary: 0xff5544,
    bullet: 0xffffff,
    grenade: 0xff8833,
    /** anel da nave em modo ataque de estação */
    attackRing: 0xff3344,
    /** barra de HP das estruturas: fundo, própria, inimiga */
    hpBack: 0x2a3644,
    hpOwn: 0x55ee88,
    hpEnemy: 0xff5566,
    /** explosões de acerto e destruição */
    explosion: 0xffaa44,
  },

  ui: {
    text: 0xd8e8f8,
    minimapBg: 0x000000,
    minimapBorder: 0x9fb8cc,
    minimapGrid: 0x20303f,
    starBright: 0xffffff,
    starDim: 0x66788e,
  },
} as const;
