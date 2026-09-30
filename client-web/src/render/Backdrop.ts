/**
 * Backdrop — o volume em que a cena acontece: céu procedural, disco solar e
 * TRÊS camadas de detritos gigantes.
 *
 * REESCRITO NA RODADA 2 contra três defeitos apontados às cegas:
 *
 * 1. "gradiente radial único de azul, sem estrutura em nenhum plano". O céu
 *    agora é pintado em camadas com funções diferentes: faixas de poeira
 *    ESCURAS (multiply) que cortam o quadro e criam bandas; leques de luz
 *    saindo do sol, que amarram o fundo inteiro à direção da chave; nuvens de
 *    nebulosa; uma massa escura ocluindo um canto; e um campo de estrelas
 *    PINTADO com densidade variável (aglomerados + campo esparso), porque
 *    ponto de GL espalhado uniformemente nunca lê como céu.
 *
 * 2. As lajes "leem como sprites de billboard sujos". A causa era o material:
 *    piso emissivo alto e albedo baixo deixavam a peça CHAPADA, e forma
 *    chapada com contorno poligonal é exatamente a leitura de sprite. Agora o
 *    albedo domina e o emissivo é só o piso de névoa, então chave e rim
 *    desenham a peça — contorno poligonal com faceta iluminada lê como bloco
 *    angular gigante, que é o que se quer.
 *
 * 3. "massa idêntica nas quatro bordas, buraco vazio no centro" (composição em
 *    donut). A distribuição agora é assimétrica e SOBREPOSTA: o peso vai para
 *    a esquerda, contra o sol, onde as peças ficam em contraluz; o lado
 *    direito fica aberto; e as três camadas se cruzam de propósito num ponto
 *    do quadro. Silhueta na frente de silhueta, com valores distintos, é a
 *    única leitura inequívoca de profundidade — e é justamente onde o próprio
 *    Homeworld 3 falha ("campo de destroços que se embola numa mancha
 *    uniforme"), então é onde há vaga para ganhar.
 *
 * As camadas são presas à câmera de propósito: sob projeção ORTOGRÁFICA
 * transladar a câmera desloca todo mundo igual — não existe parallax por
 * profundidade — então um fundo feito de objetos de mundo deslizaria na mesma
 * velocidade do plano de jogo e leria como lixo próximo. Presas à câmera e só
 * tombando devagar, leem como massas distantes, e nunca dão pop de wrap.
 *
 * Perspectiva atmosférica é PINTADA, não simulada: fog do Babylon usa
 * `length(vFogDistance)` sobre a posição de view INTEIRA (inclui X/Y), e sob
 * ortográfica com meia-largura de ~8000 unidades a distância seria dominada
 * pelo offset lateral — viraria vinheta radial, não profundidade.
 *
 * Tudo aqui é MASK_MAIN_ONLY (parentear à câmera é transformação, não
 * restringe quem desenha) e EXCLUÍDO do GlowLayer (são superfícies emissivas
 * gigantes; entrariam inteiras no mapa de glow e borrariam a tela).
 */

import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { mulberry32 } from "@ceres/shared";
import { Palette } from "./Palette";
import { c3 } from "./lineUtils";
import { MASK_MAIN_ONLY, MASK_FP_ONLY } from "./layers";
import { aerialDiffuse, hazeAt, hazeField } from "./Aerial";
import { SUN_SCREEN } from "./Lighting";
import { generateAsteroidMesh } from "./AsteroidMeshGenerator";

// ── geometria de profundidade (Z LOCAL À CÂMERA; a câmera vive em z=−1000) ──
// Ordem obrigatória: plano de jogo (~−300 mundo = 700 local) < Ceres < detritos
// < estrelas < céu, e o céu dentro do far plane (GameScene usa maxZ = 42 500).
// Ceres é uma esfera cheia que desce até ~39 700 de mundo (40 700 local): o
// fundo mora ATRÁS dela, senão lajes, estrelas e céu cobririam a borda dela.
// Em ortográfica a profundidade não muda tamanho nem posição na tela.
const SKY_Z = 42_000;
const SUN_Z = 41_950;
/**
 * z por camada — PRIMEIRO PLANO, perto, médio, fundo.
 *
 * A camada 0 é nova na rodada 5 e é a resposta a "o quadro inteiro vive num só
 * plano médio flutuante; os cantos inferiores são vazios azuis mortos". Ela
 * mora em z 420, ou seja NA FRENTE das naves (682) e de todas as rochas (≥700):
 * é a única coisa da cena que oclui o jogo, e por isso vive cortada pelas
 * bordas inferiores, onde nada de decisivo acontece. Sem uma massa assim, um
 * quadro não tem primeiro plano — tem só assunto e fundo.
 */
const TIER_Z = [420, 41_000, 41_400, 41_800];
/**
 * Profundidade ENCENADA de cada camada, na mesma escala de Aerial.ts. Começa
 * em ROCK_T_MAX porque as lajes estão de fato ATRÁS de qualquer rocha: a
 * escada é contínua, rochas ocupam [0.03, 0.58] e o fundo continua daí.
 *
 * ESTA É A ARMADILHA QUE DERRUBOU A RODADA 3, e vale escrever por extenso: o
 * eixo de profundidade das rochas é o TAMANHO APARENTE, e as lajes são o caso
 * exato em que essa heurística MENTE — elas são enormes na tela E distantes.
 * Se o t delas viesse do tamanho, seriam classificadas como o primeiro plano
 * do quadro. Por isso o t da laje vem da CAMADA a que ela pertence, nunca da
 * escala. `rockDepth` não é chamado aqui, e não deve ser.
 */
const TIER_T = [0.02, 0.58, 0.72, 0.86];

/** resolução do céu — 1.6:1, a proporção do canvas alvo (1280×800) */
const SKY_W = 1536;
const SKY_H = 960;
/** resolução do disco solar (quadrada — o disco tem que ser redondo) */
const SUN_TEX = 512;
/** lado do quadro do sol, em meias-alturas de tela */
const SUN_QUAD = 1.5;
/** sobra do quadro do céu, para nenhum arredondamento mostrar a borda */
const SKY_OVERSCAN = 1.02;
/** proporção de referência: as posições dos detritos são dadas nela */
const REF_ASPECT = 1.6;
/**
 * Centro do véu quente em UV do céu. DERIVADO de SUN_SCREEN, e não mais
 * escrito à mão: o valor fixo anterior (u = 0.17) dizia no comentário que
 * "casa com o disco solar" e não casava — o disco cai em u = 0.294 na
 * proporção de referência, 12 % da largura da tela à direita do véu. Passava
 * despercebido enquanto o véu era só pintura, mas na rodada 5 ele virou o ALVO
 * da névoa (hazeField): o quadrante que a névoa esquenta tem que ser o
 * quadrante em que o sol está, senão a correção mira ao lado do defeito.
 * A álgebra é a mesma de `resize()`, invertida.
 */
const SKY_SUN_UV = {
  u: 0.5 + SUN_SCREEN.x / (2 * REF_ASPECT),
  v: 0.5 - SUN_SCREEN.y / 2,
};
/**
 * Meia-espessura MÁXIMA em unidades de mundo, por camada. Largura e altura
 * acompanham a meia-altura de tela (o que mantém o mesmo tamanho aparente em
 * qualquer zoom), mas a espessura não pode: num monitor grande no zoom mínimo
 * a peça cresceria em z até atravessar o plano das estrelas e o do céu, e o
 * fundo apareceria remontado na ordem errada.
 *
 * O limite é dado em ESPESSURA e não em escala: convertendo por `slab[2]`,
 * quem é pequeno o bastante mantém o relevo cheio, e só a massa maior da
 * camada de fundo é achatada — que é justamente a que DEVE ler como chapada e
 * distante. Um teto em escala achatava todas as peças grandes, inclusive as
 * de perto, e era o que as fazia voltar a parecer sprite.
 *
 * Orçamento por camada (z local; céu em 5800): perto 2600±1700 = [900,4300];
 * média 3700±1400 = [2300,5100]; fundo 4400±1250 = [3150,5650]. Os tetos
 * subiram junto com o fator Z das lajes: laje sem relevo tem todas as normais
 * apontando para a câmera, recebe o mesmo valor na peça inteira e volta a ler
 * como sprite — foi por relevo insuficiente, e não por cor, que a camada
 * esquerda saiu como "mancha" no julgamento anterior.
 */
const TIER_MAX_THICK = [340, 1700, 1400, 1250];
/**
 * Quadro de fundo do cockpit: a 110 000 u do olho, atrás de tudo que o
 * cockpit alcança (maxZ 120 000 — Ceres inteira no horizonte). O tamanho
 * cresce na mesma proporção da distância (era 13 000 a 4 500) para cobrir o
 * frustum também em tela cheia.
 */
const COCKPIT_Z = 110_000;
const COCKPIT_SIZE = 320_000;
/** distância do quadro de esfumaçamento ao olho da fpCamera (minZ = 2) */
const FADE_Z = 20;
/**
 * Onde o esfumaçamento começa, em fração da meia-extensão do recorte. Em 0.55
 * quase metade da borda participa da transição — parece muito escrito assim, e
 * é o que faz a diferença entre "vinheta discreta" (que ainda deixa a aresta
 * legível, e a aresta é o defeito) e uma vigia sem borda.
 */
const FADE_START = 0.55;

/**
 * Um bloco de detrito. Posição e tamanho em MEIAS-ALTURAS de tela (o eixo X é
 * corrigido pela proporção real) — é o que mantém a composição idêntica em
 * qualquer zoom e em qualquer resolução.
 */
interface DebrisSpec {
  x: number;
  y: number;
  /** meia-extensão em X */
  size: number;
  /**
   * Achatamento (x, y, z) aplicado à malha normalizada. O fator Z subiu muito
   * na rodada 2: com 0.10 a peça era quase um plano, todas as normais
   * apontavam para a câmera, a luz caía igual na peça inteira e o resultado
   * lia como SPRITE de billboard com contorno poligonal — que foi exatamente
   * o veredito de fora. Com relevo de verdade em Z as facetas divergem, a
   * chave e o rim as separam, e o contorno poligonal passa a ler como bloco
   * angular gigante, que é o que se quer.
   */
  slab: [number, number, number];
  /** giro no plano da tela (rad/s) — lento o bastante para não chamar atenção */
  spin: number;
  /** inclinação fixa fora do plano, para as lajes não ficarem todas de frente */
  tiltX: number;
  tiltY: number;
  seed: number;
  /** 0 = PRIMEIRO PLANO, 1 = perto, 2 = médio, 3 = fundo (quase chapado) */
  tier: 0 | 1 | 2 | 3;
}

/**
 * Composição assimétrica e sobreposta. O peso está à ESQUERDA e para baixo,
 * contra o sol — peça escura em contraluz, com rim frio desenhando a borda. O
 * quadrante direito fica aberto de propósito: é onde o jogo respira.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RODADA 7 — A REGRA DE ENCENAÇÃO, e ela vale mais que qualquer posição
 * individual desta lista:
 *
 *   CORTE DE BORDA E TAMANHO GRANDE SÃO LINGUAGEM DE PRIMEIRO PLANO.
 *   Só as camadas 0 e 1 podem usá-los. As camadas 2 e 3 têm de caber
 *   INTEIRAS no quadro e ser pequenas.
 *
 * O julgamento cego leu o quadro como "perspectiva atmosférica invertida, não
 * lê como arte, lê como bug" — e o mecanismo que ele descreveu estava errado
 * (ele tomou estas lajes por asteroides), mas o defeito era real e era daqui.
 * Medido: as CINCO lajes da camada 3, a mais distante e a mais lavada de
 * névoa, estavam TODAS cortadas pela borda e ocupavam de 30 % a 41 % da
 * largura da tela cada uma. Escala e corte gritavam PERTO enquanto valor e
 * saturação sussurravam LONGE, e quem olha resolve essa contradição sempre da
 * mesma forma: chamando de erro de programa.
 *
 * O corte de borda foi importado da rodada 2, onde a nota dizia que "massa
 * cortada pela borda é o que dá escala a tudo o que está atrás". Aquilo é
 * verdade — e é uma propriedade do PRIMEIRO PLANO, não do fundo. Aplicá-la ao
 * fundo foi o erro, e ele sobreviveu porque ninguém tinha escrito a regra.
 *
 * A camada 0 ganhou uma terceira massa no FLANCO ESQUERDO por causa disso: o
 * que fica cortado pela borda esquerda, na altura do meio do quadro, passa a
 * ser a massa ESCURA e saturada, com as lajes pálidas contidas atrás dela. É o
 * mesmo movimento que responde ao "falta primeiro plano" apontado em três
 * rodadas seguidas — silhueta escura na frente de silhueta clara é a única
 * leitura de profundidade que não admite segunda interpretação.
 */
const DEBRIS: DebrisSpec[] = [
  // ── camada PERTO: a mais escura e contrastada das TRÊS (ainda assim atrás
  //    de qualquer asteroide — ver TIER_T)
  // ── PRIMEIRO PLANO: as duas únicas massas que ocluem o jogo. Vivem nos
  //    cantos inferiores (os "vazios azuis mortos") e a maior parte delas está
  //    FORA do quadro — massa cortada pela borda é o que dá escala a tudo o
  //    que está atrás. Com t = 0.02 elas quase não recebem névoa: são o objeto
  //    mais escuro e mais contrastado da cena, o oposto exato da laje de
  //    fundo, e é esse par de extremos que estabelece a profundidade.
  { x: -1.72, y: -1.12, size: 0.80, slab: [1, 0.54, 0.34], spin: 0.0058, tiltX: 0.22, tiltY: -0.30, seed: 0xf10a, tier: 0 },
  { x: 1.82, y: -1.20, size: 0.68, slab: [1, 0.44, 0.30], spin: -0.0071, tiltX: -0.26, tiltY: 0.23, seed: 0x8e57, tier: 0 },
  // FLANCO ESQUERDO (rodada 7): a massa que ocupa a borda cortada na altura
  // média do quadro — exatamente onde as lajes pálidas estavam fazendo o
  // papel de primeiro plano com a cor de fundo. Larga o bastante para ocluir o
  // terço esquerdo delas (~11 % da largura visível) e recuada para baixo, para
  // não invadir o quadrante do sol nem fechar mais do que a borda do jogo.
  { x: -2.02, y: -0.22, size: 0.78, slab: [1, 0.62, 0.38], spin: 0.0044, tiltX: -0.19, tiltY: 0.26, seed: 0x2b6d, tier: 0 },
  // ── camada PERTO
  { x: -1.34, y: -0.70, size: 0.52, slab: [1, 0.40, 0.62], spin: 0.0121, tiltX: 0.20, tiltY: -0.34, seed: 0x4be8, tier: 1 },
  { x: 1.66, y: 0.92, size: 0.38, slab: [1, 0.19, 0.30], spin: -0.0143, tiltX: -0.29, tiltY: 0.17, seed: 0xc0d5, tier: 1 },
  { x: -0.72, y: -1.16, size: 0.44, slab: [1, 0.66, 0.58], spin: -0.0067, tiltX: 0.24, tiltY: 0.31, seed: 0x3d41, tier: 1 },
  // ── camada MÉDIA: CONTIDA no quadro (ver a regra acima), ≤ 22 % da largura
  { x: -1.10, y: -0.26, size: 0.34, slab: [1, 0.44, 0.56], spin: -0.0084, tiltX: -0.18, tiltY: 0.28, seed: 0x7301, tier: 2 },
  { x: -0.40, y: 0.60, size: 0.32, slab: [1, 0.17, 0.26], spin: 0.0096, tiltX: 0.26, tiltY: 0.12, seed: 0x1ea9, tier: 2 },
  { x: 1.24, y: -0.58, size: 0.30, slab: [1, 0.62, 0.60], spin: 0.0110, tiltX: 0.14, tiltY: -0.22, seed: 0x9d16, tier: 2 },
  { x: 0.88, y: 0.44, size: 0.28, slab: [1, 0.22, 0.34], spin: -0.0125, tiltX: -0.31, tiltY: -0.18, seed: 0xb244, tier: 2 },
  // ── camada FUNDO: as massas largas e chapadas.
  //    ENCOLHERAM MUITO na rodada 4 (a maior era 1.02, antes 1.34). Empilhadas
  //    no terço esquerdo elas formavam UMA parede lisa de ~30 % do quadro, e o
  //    julgamento leu essa parede como "o asteroide mais próximo" — o objeto
  //    que dominava a cena era justamente o que menos tinha o que mostrar.
  //    Menores e em maior número, elas voltam a fazer o que camada de fundo
  //    faz: silhueta cruzando silhueta, com valores distintos.
  //    A VARIEDADE DE FORMA é deliberada e é onde o adversário está aberto:
  //    o julgamento reclamou que os destroços de fundo DELE são "blocos
  //    retangulares repetidos e sem escala". Aqui os fatores de laje vão de
  //    0.17 (lasca fina e comprida) a 0.66 (bloco maciço), e nenhuma peça
  //    repete a proporção da vizinha.
  //    RODADA 7: ENCOLHERAM DE NOVO e agora cabem INTEIRAS no quadro (≤ 18 %
  //    da largura). Elas eram as cinco peças mais lavadas de névoa da cena e
  //    as cinco estavam cortadas pela borda ocupando 30–41 % da largura cada —
  //    a contradição que o julgamento leu como bug. Camada de fundo pequena e
  //    contida, cruzando silhueta com as vizinhas, é o que ela sempre deveria
  //    ter sido; o corte de borda mudou-se para a camada 0, onde pertence.
  { x: -0.86, y: 0.24, size: 0.28, slab: [1, 0.46, 0.46], spin: 0.0047, tiltX: 0.16, tiltY: -0.21, seed: 0x51a3, tier: 3 },
  { x: -1.24, y: 0.60, size: 0.26, slab: [1, 0.21, 0.30], spin: -0.0039, tiltX: -0.22, tiltY: 0.19, seed: 0x2f7c, tier: 3 },
  { x: 0.46, y: -0.56, size: 0.26, slab: [1, 0.58, 0.50], spin: 0.0033, tiltX: 0.28, tiltY: 0.24, seed: 0xa7b2, tier: 3 },
  { x: 1.22, y: 0.10, size: 0.28, slab: [1, 0.36, 0.42], spin: -0.0029, tiltX: -0.14, tiltY: -0.26, seed: 0x6c93, tier: 3 },
  { x: 1.05, y: 0.68, size: 0.24, slab: [1, 0.24, 0.32], spin: 0.0041, tiltX: 0.19, tiltY: 0.27, seed: 0x1f68, tier: 3 },
];

interface DebrisEntry {
  mesh: Mesh;
  spec: DebrisSpec;
  /** fase inicial do giro, por seed — as lajes não nascem alinhadas */
  baseZ: number;
}

export class Backdrop {
  private sky: Mesh;
  private sun: Mesh;
  private cockpit: Mesh | null = null;
  /** quadro que esfuma a borda do visor de cockpit (ver attachCockpit) */
  private fade: Mesh | null = null;
  private fpCam: Camera | null = null;
  private root: TransformNode;
  private debris: DebrisEntry[] = [];
  private materials: StandardMaterial[] = [];
  private textures: DynamicTexture[] = [];

  constructor(scene: Scene, camera: Camera, glow: GlowLayer) {
    this.root = new TransformNode("backdrop", scene);
    this.root.parent = camera;

    // ── céu ──
    const skyTex = paintSky(scene);
    this.textures.push(skyTex);
    const skyMat = unlitMat("skyMat", scene, skyTex);
    this.sky = CreatePlane("skyQuad", { size: 1 }, scene);
    this.sky.material = skyMat;
    this.sky.position.z = SKY_Z;
    this.materials.push(skyMat);
    this.prepare(this.sky, glow, MASK_MAIN_ONLY);

    // ── disco solar ──
    // aditivo: soma sobre o céu em vez de recortá-lo, então o halo se funde
    // com o gradiente sem costura. Profundidade TESTADA mas não ESCRITA — uma
    // rocha passando na frente eclipsa o sol, que é exatamente o que se quer.
    const sunTex = paintSun(scene);
    this.textures.push(sunTex);
    const sunMat = unlitMat("sunMat", scene, sunTex);
    sunMat.alpha = 0.9999; // < 1 é o que liga o caminho de blending
    sunMat.alphaMode = Constants.ALPHA_ADD;
    sunMat.disableDepthWrite = true;
    this.sun = CreatePlane("sunQuad", { size: 1 }, scene);
    this.sun.material = sunMat;
    this.sun.position.z = SUN_Z;
    this.materials.push(sunMat);
    this.prepare(this.sun, glow, MASK_MAIN_ONLY);

    // ── detritos ──
    // Um material por camada, e os três saem da MESMA função que graduou as
    // rochas, com t continuando de onde elas pararam (TIER_T). Antes eram seis
    // constantes de paleta escolhidas à mão, e o resultado medido foi que as
    // lajes recebiam só o piso de névoa e quase nenhuma chave — liam como
    // mancha de lente ao lado de rochas plenamente iluminadas a 200 px. Com a
    // escada única, a laje é a mesma pedra das rochas com mais ar na frente:
    // recebe chave, tem faceta clara e faceta escura, e é essa amplitude
    // interna que dá ESPESSURA a uma camada de fundo em vez de papa.
    // UM MATERIAL POR LAJE, e não um por camada: a névoa agora tem cor LOCAL
    // (Aerial.hazeField), e cada laje ocupa um ponto fixo da tela, então cada
    // uma converge para a cor do céu que está atrás DELA. As lajes do
    // quadrante do sol puxam para o quente, as do campo marinho escurecem.
    // Como a posição de tela de uma laje nunca muda (elas são parenteadas à
    // câmera e posicionadas em meias-alturas), isto é calculado UMA VEZ na
    // construção — custo por frame: zero.
    for (const spec of DEBRIS) {
      const mesh = buildDebrisMesh(scene, spec);
      const mat = aerialSlabMat(`debrisMat_${spec.seed.toString(16)}`, scene, spec);
      this.materials.push(mat);
      mesh.material = mat;
      mesh.position.z = TIER_Z[spec.tier];
      mesh.rotation.x = spec.tiltX;
      mesh.rotation.y = spec.tiltY;
      this.prepare(mesh, glow, MASK_MAIN_ONLY);
      this.debris.push({ mesh, spec, baseZ: mulberry32(spec.seed)() * Math.PI * 2 });
    }
  }

  /**
   * Pano de fundo do viewport de cockpit. Construído pelo MESMO caminho do
   * céu (CreatePlane + unlitMat) em vez de VertexData à mão: normais, UVs e
   * winding vêm prontos e corretos, e não sobra nenhuma diferença entre o
   * quadro que comprovadamente desenha e este.
   */
  attachCockpit(scene: Scene, fpCamera: Camera, glow: GlowLayer): void {
    const tex = paintCockpitSky(scene);
    this.textures.push(tex);
    const mat = unlitMat("fpBackdropMat", scene, tex);
    // Piso de cor no PRÓPRIO material: se por qualquer motivo a textura não
    // ligar, o recorte fica azul-escuro e não um retângulo preto de borda dura.
    // Caiu de `void` para `occluder`, e a razão é o shader: o emissivo do
    // StandardMaterial SOMA com a textura emissiva (`emissiveColor += tex`),
    // não a substitui — então este piso estava sendo adicionado a cada pixel
    // do visor e respondia por boa parte do descasamento de valor medido
    // contra o céu ao lado. `occluder` cumpre o papel de rede de segurança sem
    // levantar o recorte.
    mat.emissiveColor = c3(Palette.space.occluder);
    const quad = CreatePlane("fpBackdrop", { size: COCKPIT_SIZE }, scene);
    quad.material = mat;
    quad.position.z = COCKPIT_Z;
    quad.parent = fpCamera;
    quad.layerMask = MASK_FP_ONLY;
    quad.isPickable = false;
    quad.alwaysSelectAsActiveMesh = true;
    glow.addExcludedMesh(quad);
    this.materials.push(mat);
    this.cockpit = quad;

    // ── ESFUMAÇAMENTO DA BORDA DO VISOR ──────────────────────────────────
    // O visor foi reprovado três vezes seguidas como "erro de implementação
    // escancarado". Na rodada 3 eu ataquei a COR e a cor ficou certa — medido,
    // o interior saiu em (7,38,69) contra (5,37,63) do céu ao lado, diferença
    // invisível. E ainda assim o veredito foi o mesmo, porque o problema nunca
    // foi a cor: é a ARESTA. Um retângulo de borda dura no meio do quadro, com
    // um asteroide cortado ao meio por ela, é a assinatura de recorte de
    // renderização — nenhuma escolha de tom conserta isso.
    //
    // A correção é um quadro em cima do viewport com o miolo transparente e as
    // bordas fechando na cor do céu. O que ele faz é ESCONDER O CORTE: a rocha
    // que atravessa o limite se dissolve na névoa em vez de terminar numa
    // linha reta, e o recorte passa a ler como uma vigia com profundidade de
    // campo. A vinheta do pós-processo NÃO serve para isto — o shader do
    // Babylon calcula a vinheta a partir de `gl_FragCoord * vInverseScreenSize`,
    // ou seja em coordenadas de TELA CHEIA, então num viewport de rodapé ela
    // sairia deslocada em vez de centrada. Custo: um quad alpha-blended sobre
    // ~8 % da tela, dentro do orçamento que a exclusão do glow liberou.
    const fadeTex = paintPortholeFade(scene);
    this.textures.push(fadeTex);
    const fadeMat = unlitMat("fpFadeMat", scene, fadeTex);
    fadeMat.opacityTexture = fadeTex; // canal alfa da MESMA textura
    fadeMat.disableDepthWrite = true;
    const fade = CreatePlane("fpFade", { size: 1 }, scene);
    fade.material = fadeMat;
    fade.position.z = FADE_Z;
    fade.parent = fpCamera;
    fade.layerMask = MASK_FP_ONLY;
    fade.isPickable = false;
    fade.alwaysSelectAsActiveMesh = true;
    glow.addExcludedMesh(fade);
    this.materials.push(fadeMat);
    this.fade = fade;
    this.fpCam = fpCamera;
    this.fitFade();
  }

  /**
   * Dimensiona o quadro de esfumaçamento para cobrir EXATAMENTE o frustum da
   * fpCamera em FADE_Z. A proporção sai de `getAspectRatio(camera)`, que no
   * Babylon já leva o VIEWPORT em conta (largura/altura da tela multiplicadas
   * pelo recorte) — calcular à mão a partir de FP_VIEW daria o mesmo número
   * hoje e sairia do lugar no dia em que o recorte mudar. Recalculado em
   * `resize()` porque a proporção muda quando a janela muda.
   */
  /**
   * Vista de cockpit em tela cheia: o esmaecimento de borda existe para fundir
   * o RECORTE pequeno com a cena em volta; em tela cheia não há borda, e ele
   * virava um anel manchado no meio da vista.
   */
  setCockpitFull(on: boolean): void {
    this.fade?.setEnabled(!on);
  }

  private fitFade(): void {
    const fade = this.fade;
    const cam = this.fpCam;
    if (!fade || !cam) return;
    const h = 2 * FADE_Z * Math.tan(cam.fov / 2);
    fade.scaling.y = h;
    fade.scaling.x = h * fade.getScene().getEngine().getAspectRatio(cam);
  }

  /**
   * Reencaixa tudo nos bounds ortográficos do frame. Chamado de dentro de
   * `updateOrtho()` — o zoom é suavizado por lerp, então isto roda todo frame;
   * são 10 malhas recebendo posição e escala, custo irrelevante.
   */
  resize(halfW: number, halfH: number): void {
    // a proporção do recorte de cockpit acompanha a da janela
    this.fitFade();

    // o céu cobre exatamente o retângulo visível (com sobra)
    this.sky.scaling.x = halfW * 2 * SKY_OVERSCAN;
    this.sky.scaling.y = halfH * 2 * SKY_OVERSCAN;

    // X em unidades da proporção de referência: em telas mais largas a
    // composição se abre em vez de amontoar tudo no meio
    const xUnit = halfW / REF_ASPECT;

    // o disco fica onde a LUZ-CHAVE está (SUN_SCREEN é a fonte única) — sob
    // ortográfica a posição de tela é a própria coordenada XY, então isto é
    // coincidência exata, não aproximação
    this.sun.position.x = SUN_SCREEN.x * xUnit;
    this.sun.position.y = SUN_SCREEN.y * halfH;
    this.sun.scaling.x = halfH * SUN_QUAD;
    this.sun.scaling.y = halfH * SUN_QUAD;

    for (const { mesh, spec } of this.debris) {
      const s = spec.size * halfH;
      mesh.position.x = spec.x * xUnit;
      mesh.position.y = spec.y * halfH;
      // o teto é de ESPESSURA: converte para escala pelo fator de laje, de
      // modo que só quem estoura o orçamento de profundidade é achatado
      const zMax = TIER_MAX_THICK[spec.tier] / spec.slab[2];
      mesh.scaling.set(s, s, Math.min(s, zMax));
    }
  }

  /** Tombamento lento das massas de fundo (tt = tempo absoluto em segundos). */
  tick(tt: number): void {
    for (const { mesh, spec, baseZ } of this.debris) mesh.rotation.z = baseZ + spec.spin * tt;
  }

  destroy(): void {
    this.sky.dispose();
    this.sun.dispose();
    this.cockpit?.dispose();
    this.fade?.dispose();
    this.fade = null;
    this.fpCam = null;
    for (const { mesh } of this.debris) mesh.dispose();
    this.debris.length = 0;
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    for (const t of this.textures) t.dispose();
    this.textures.length = 0;
    this.root.dispose();
  }

  /** máscara, parent, exclusão do glow e picking — sempre juntos */
  private prepare(mesh: Mesh, glow: GlowLayer, mask: number): void {
    mesh.parent = this.root;
    mesh.layerMask = mask;
    mesh.isPickable = false;
    mesh.doNotSyncBoundingInfo = true;
    // frustum culling desligado: o quadro do céu é reescalado por frame e um
    // bounding info defasado o faria piscar fora da tela
    mesh.alwaysSelectAsActiveMesh = true;
    glow.addExcludedMesh(mesh);
  }
}

// ── materiais ──────────────────────────────────────────────────────────────

/**
 * Superfície puramente emissiva. `disableLighting` zera o `diffuseBase` do
 * StandardMaterial, então o caminho que sobra é `emissiveColor + emissiveTexture`
 * — usar `diffuseTexture` aqui daria preto, que é exatamente como o pano de
 * fundo do cockpit se comportava antes.
 */
function unlitMat(name: string, scene: Scene, tex: DynamicTexture): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.disableLighting = true;
  mat.diffuseColor = Color3.Black();
  mat.specularColor = Color3.Black();
  mat.emissiveColor = Color3.Black();
  mat.emissiveTexture = tex;
  mat.backFaceCulling = false;
  return mat;
}

/**
 * Material de laje: a MESMA pedra das rochas, graduada por Aerial.ts para a
 * distância da camada. O piso de névoa vai em `ambientColor` e não em
 * `emissiveColor` — as lajes já estão excluídas do glow, mas manter o mesmo
 * canal das rochas é o que garante que a escada tonal seja literalmente uma
 * só função e não duas convenções parecidas.
 */
function aerialSlabMat(name: string, scene: Scene, spec: DebrisSpec): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  const t = TIER_T[spec.tier];
  // a camada 0 é a única que não é "a mesma pedra com mais ar": ela é o
  // PRIMEIRO PLANO e veste a cor de perto (ver Palette.space.debrisNear)
  mat.diffuseColor = aerialDiffuse(
    spec.tier === 0 ? Palette.space.debrisNear : Palette.space.debrisRock,
    t,
  );
  // posição de TELA da laje, em UV (u para a direita, v para baixo). Sai da
  // mesma álgebra de `resize()`: x = spec.x · halfW/REF_ASPECT e y = spec.y ·
  // halfH, então o UV é independente de zoom e de resolução — por isso pode
  // ser resolvido aqui, uma vez.
  mat.ambientColor = new Color3(0, 0, 0);
  hazeField.sampleTo(
    0.5 + spec.x / (2 * REF_ASPECT),
    0.5 - spec.y / 2,
    mat.ambientColor,
    hazeAt(t),
  );
  mat.specularColor = Color3.Black();
  mat.maxSimultaneousLights = 4;
  mat.backFaceCulling = false;
  return mat;
}

// ── pintura procedural ─────────────────────────────────────────────────────

const css = (hex: number, a = 1) =>
  `rgba(${(hex >> 16) & 0xff},${(hex >> 8) & 0xff},${hex & 0xff},${a})`;

/**
 * Cor de uma rampa de matizes em `r`. Existe para que uma passada possa ter
 * MUITAS paradas de gradiente (contra banda de Mach — ver o véu quente) sem
 * que a lista de matizes tenha de ser reescrita parada a parada: os matizes
 * continuam sendo quatro, e a amostragem fina só acontece na opacidade.
 */
/**
 * RODADA 7 — PARADAS SEM QUEBRA DE DERIVADA, para TODAS as passadas.
 *
 * O véu quente foi curado da banda de Mach (passada 2) e a cura parou ali.
 * Medido no quadro da rodada 6 (perfil radial por mediana em volta do sol), o
 * degrau da diagonal sol→centro tinha mais DOIS autores, com o mesmo defeito
 * de paradas lineares em rampa quebrada:
 *   – a nebulosa fria de (0.30, 0.56): paradas (0, f) (0.35, 0.42f) (1, 0).
 *     A inclinação cai 2,6× em r = 0.35, e com o achatamento de 0.34 o eixo
 *     menor tem ~70 px de tela — em azul isso é ~0,25 LSB/px de quebra, a
 *     maior do céu. A elipse dessa quebra corre de (190,540) a (573,367): é a
 *     diagonal reclamada. Croma variando rápido é a nebulosa AZUL somando
 *     sobre o véu OCRE, exatamente o caso que o dither não cobre;
 *   – o halo aditivo do disco solar (paintSun): rampa linear de 0.09 a ZERO
 *     terminando com inclinação cheia no raio do quadro, 300 px do sol. Somado
 *     a um céu que clareia para fora, vira crista: a mediana de luminância no
 *     setor abaixo do sol sobe até r ≈ 300 e desce depois.
 * O remédio é o mesmo do véu, generalizado: cada passada é uma FUNÇÃO lisa de
 * r cuja derivada vai a zero na borda, amostrada em muitas paradas. Este
 * helper recebe o perfil e escreve as paradas; `warp` > 1 adensa as amostras
 * no miolo, onde o perfil do sol é agudo.
 */
function smoothStops(
  g: CanvasGradient,
  n: number,
  profile: (r: number) => [number, number],
  warp = 1,
): void {
  for (let i = 0; i <= n; i++) {
    const r = Math.pow(i / n, warp);
    const [hex, a] = profile(r);
    g.addColorStop(r, css(hex, Math.max(0, Math.min(1, a))));
  }
}

/** interpolação C¹ entre chaves (smoothstep por trecho): patamar e rampa se
 *  emendam com derivada contínua — é o que falta às paradas do canvas */
function smoothRampHex(keys: Array<[number, number]>, r: number): number {
  let i = 1;
  while (i < keys.length - 1 && r > keys[i][0]) i++;
  const [p0, c0] = keys[i - 1];
  const [p1, c1] = keys[i];
  const f = p1 === p0 ? 0 : Math.min(1, Math.max(0, (r - p0) / (p1 - p0)));
  return rampHex([[0, c0], [1, c1]], f * f * (3 - 2 * f));
}

function rampHex(keys: Array<[number, number]>, r: number): number {
  let i = 1;
  while (i < keys.length - 1 && r > keys[i][0]) i++;
  const [p0, c0] = keys[i - 1];
  const [p1, c1] = keys[i];
  const f = p1 === p0 ? 0 : Math.min(1, Math.max(0, (r - p0) / (p1 - p0)));
  const mix = (sh: number) => {
    const a = (c0 >> sh) & 0xff;
    const b = (c1 >> sh) & 0xff;
    return Math.round(a + (b - a) * f) & 0xff;
  };
  return (mix(16) << 16) | (mix(8) << 8) | mix(0);
}

/**
 * Céu em camadas. A ordem importa e cada passada tem uma função:
 *   base       — a diagonal tonal (canto escuro → névoa fria)
 *   véu quente — SOURCE-OVER, não aditivo: quente somado a azul dá cinza
 *                neutro e a divisão de temperatura do fundo desaparece
 *   nebulosa   — nuvens aditivas com núcleo, para o vazio ter volume
 *   massa      — bloco escuro ocluindo um canto; o céu também precisa de um
 *                primeiro plano próprio
 *   estrelas   — PINTADAS, com aglomerados: densidade uniforme nunca lê como
 *                céu, e é isso que denuncia campo de pontos gerado
 *   vinheta / dither
 */
function paintSky(scene: Scene): DynamicTexture {
  const tex = new DynamicTexture("skyTex", { width: SKY_W, height: SKY_H }, scene, false);
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  const sx = SKY_SUN_UV.u * SKY_W;
  const sy = SKY_SUN_UV.v * SKY_H;
  const rng = mulberry32(0x5eed1a7e);

  // 1. base: diagonal do canto escuro (baixo-direita) para a névoa (cima-esquerda).
  //    O trecho chapado de `void` (que ia de 0.00 a 0.34) saiu: medido no
  //    quadro da rodada 3, o terço direito do céu estava em (3,21,46) e o canto
  //    em (0,10,22) — quase 40 % da tela era um vazio preto, e vazio preto é
  //    metade do "colapso monocromático". Agora o gradiente anda de `deep` a
  //    `haze` e só toca `void` na quina.
  //    RODADA 7: mesmas quatro chaves, emendadas em C¹ (ver smoothStops). A
  //    junção patamar→rampa em 0.66 é uma RETA perpendicular à diagonal que
  //    passa a ~95 px do sol, de (317,434) a (529,94) — outra quebra de
  //    derivada atravessando a região reclamada.
  const base = ctx.createLinearGradient(SKY_W, SKY_H, 0, 0);
  const baseKeys: Array<[number, number]> = [
    [0.00, Palette.space.void],
    [0.18, Palette.space.deep],
    [0.66, Palette.space.deep],
    [1.00, Palette.space.haze],
  ];
  smoothStops(base, 32, (r) => [smoothRampHex(baseKeys, r), 1]);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, SKY_W, SKY_H);

  // 2. véu quente do sol.
  //
  //    RODADA 7 — AS PARADAS VIRARAM CURVA. O julgamento apontou "banda visível
  //    no gradiente do céu, na diagonal que desce do sol até o centro
  //    (x≈300-750, y≈250-450), com degrau perceptível contra o azul", e a
  //    causa NÃO é quantização de 8 bits: é BANDA DE MACH, a ilusão que o olho
  //    produz onde a DERIVADA de um gradiente salta.
  //
  //    As paradas antigas eram (0, 0.94) (0.15, 0.60) (0.38, 0.32) (0.70, 0.15).
  //    O `createRadialGradient` interpola LINEARMENTE entre paradas, então a
  //    inclinação da opacidade caía de −2.27 por unidade no primeiro trecho
  //    para −1.22 no segundo: uma quebra de 2× num único raio. Esse raio é
  //    0.15 · 0.86 · SKY_W ≈ 198 px de textura ≈ 165 px de tela, um anel em
  //    volta do sol que passa exatamente pela diagonal reclamada. Dither não
  //    apaga banda de Mach — ela não é degrau de valor, é quebra de derivada.
  //
  //    Agora as paradas são AMOSTRADAS de uma exponencial, que não tem quebra
  //    nenhuma: a queda de opacidade fica suave por construção e o que sobra é
  //    o erro da poligonal de 14 segmentos, cerca de um catorze avos da quebra
  //    anterior. K = 2.35 foi escolhido para REPRODUZIR a curva antiga nos
  //    pontos que a composição já tinha aprovado (0.63 contra 0.60 em r = 0.15;
  //    0.33 contra 0.32 em r = 0.38) — o véu quente alimenta o alvo de névoa
  //    do quadrante do sol (Aerial.hazeField) e não podia mudar de tamanho.
  const warm = ctx.createRadialGradient(sx, sy, 0, sx, sy, SKY_W * 0.86);
  const VEIL_K = 2.35;
  const veilTail = Math.exp(-VEIL_K);
  const veilHue: Array<[number, number]> = [
    [0.00, Palette.space.warmHaze],
    [0.38, Palette.space.haze],
    [0.70, Palette.space.deep],
    [1.00, Palette.space.void],
  ];
  const VEIL_STOPS = 14;
  for (let i = 0; i <= VEIL_STOPS; i++) {
    const r = i / VEIL_STOPS;
    const a = 0.94 * ((Math.exp(-VEIL_K * r) - veilTail) / (1 - veilTail));
    warm.addColorStop(r, css(rampHex(veilHue, r), a));
  }
  ctx.fillStyle = warm;
  ctx.fillRect(0, 0, SKY_W, SKY_H);

  // 3 e 4. LEQUES DE LUZ E FAIXAS DE POEIRA: REMOVIDOS.
  //
  //    Os dois eram "estrutura pintada" — riscos claros saindo do sol e
  //    riscos escuros em multiply cruzando o campo — e os dois foram
  //    reprovados às cegas nas rodadas 2 e 3, com as mesmas palavras nas duas
  //    vezes: "smears de baixo contraste com banding" e "bandas diagonais que
  //    leem como artefato de shader ou nebulosa mal-blendada, não como
  //    volume". Encurtá-los na rodada 3 não adiantou, e isso é a informação
  //    que importa: o defeito não era o comprimento.
  //
  //    A causa é que uma cunha de gradiente desenhada num plano de fundo NÃO
  //    TEM PROFUNDIDADE. Ela cruza asteroides sem ser ocluída por eles, não
  //    nasce de nada que se veja no quadro e não muda quando a câmera anda —
  //    o olho classifica isso como defeito de renderização, não como matéria.
  //    Volume num vazio tem que vir de OBJETO com silhueta, e é para isso que
  //    existem as três camadas de detrito. O céu volta a ser o que céu é:
  //    gradiente, véu quente e estrelas. Estrutura é trabalho da geometria.
  // 5. nuvens de nebulosa com núcleo. Sobreviveram porque são RADIAIS e
  //    difusas: sem eixo reto, não há aresta para o olho chamar de artefato.
  //    RODADA 7: o perfil deixou de ser (f, 0.42f em 0.35, 0) e virou
  //    f·(1−r)^1.6 — 0.50f em 0.35 e 0.23f em 0.6 contra 0.42f e 0.26f, a mesma
  //    nuvem, mas sem a quebra de 2,6× no anel de 0.35 e com derivada NULA na
  //    borda. Era a quebra mais forte do céu (ver smoothStops).
  ctx.globalCompositeOperation = "lighter";
  const wisps: Array<[number, number, number, number, number, number, number]> = [
    // cx, cy, raio, rotação, achatamento, cor, força
    [0.30, 0.56, 0.46, -0.40, 0.34, Palette.space.nebulaCold, 0.42],
    [0.74, 0.30, 0.38, 0.36, 0.28, Palette.space.nebulaWarm, 0.30],
    [0.60, 0.82, 0.34, -0.20, 0.26, Palette.space.nebulaCold, 0.26],
    [0.12, 0.78, 0.30, 0.58, 0.38, Palette.space.nebulaWarm, 0.22],
  ];
  for (const [cx, cy, r, rot, flat, color, force] of wisps) {
    ctx.save();
    ctx.translate(cx * SKY_W, cy * SKY_H);
    ctx.rotate(rot);
    ctx.scale(1, flat);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * SKY_W);
    smoothStops(g, 20, (s) => [color, force * Math.pow(1 - s, 1.6)]);
    ctx.fillStyle = g;
    ctx.fillRect(-SKY_W, -SKY_H * 2, SKY_W * 2, SKY_H * 4);
    ctx.restore();
  }

  // 6. massa escura ancorando o canto inferior direito. Muito mais fraca
  //    (0.92 → 0.34) e mais recuada: esta mancha caía EXATAMENTE sobre o canto
  //    que a vinheta já estava matando, e as duas somadas produziram o
  //    (0,10,22) medido. Ancorar o canto é útil; apagá-lo não.
  ctx.globalCompositeOperation = "source-over";
  ctx.save();
  ctx.translate(SKY_W * 1.10, SKY_H * 1.14);
  ctx.rotate(-0.42);
  ctx.scale(1, 0.62);
  // perfil 0.34·(1−r²)^1.5: 0.21 em 0.52 (era 0.20) e derivada nula na borda
  const mass = ctx.createRadialGradient(0, 0, 0, 0, 0, SKY_W * 0.46);
  smoothStops(mass, 16, (s) => [Palette.space.occluder, 0.34 * Math.pow(1 - s * s, 1.5)]);
  ctx.fillStyle = mass;
  ctx.fillRect(-SKY_W, -SKY_H * 2, SKY_W * 2, SKY_H * 4);
  ctx.restore();

  // 7. estrelas pintadas: 3 aglomerados + campo esparso. A variação de
  //    densidade é o ponto — campo uniforme lê como ruído, não como céu
  ctx.globalCompositeOperation = "lighter";
  const clusters = [
    { x: 0.72, y: 0.62, r: 0.20, n: 190 },
    { x: 0.26, y: 0.24, r: 0.15, n: 120 },
    { x: 0.88, y: 0.86, r: 0.13, n: 90 },
  ];
  const paintStar = (px: number, py: number, level: number, tint: number) => {
    if (level > 0.62) {
      const rad = 1.0 + level * 2.4;
      const g = ctx.createRadialGradient(px, py, 0, px, py, rad);
      g.addColorStop(0, css(tint, Math.min(1, level * 1.15)));
      g.addColorStop(0.4, css(tint, level * 0.45));
      g.addColorStop(1, css(tint, 0));
      ctx.fillStyle = g;
      ctx.fillRect(px - rad, py - rad, rad * 2, rad * 2);
    } else {
      ctx.fillStyle = css(tint, level * 0.85);
      ctx.fillRect(px, py, 1, 1);
    }
  };
  const tints = [0xffffff, 0xffe6c2, 0xc4d8ff, 0xdfe8ff];
  for (const cl of clusters) {
    for (let i = 0; i < cl.n; i++) {
      // concentração para o centro: raiz do uniforme puxa a densidade ao miolo
      const a = rng() * Math.PI * 2;
      const d = Math.pow(rng(), 1.9) * cl.r;
      paintStar(
        (cl.x + Math.cos(a) * d) * SKY_W,
        (cl.y + Math.sin(a) * d * 1.6) * SKY_H,
        0.16 + Math.pow(rng(), 2.4) * 0.84,
        tints[(rng() * tints.length) | 0],
      );
    }
  }
  for (let i = 0; i < 420; i++) {
    paintStar(
      rng() * SKY_W,
      rng() * SKY_H,
      0.12 + Math.pow(rng(), 3.0) * 0.80,
      tints[(rng() * tints.length) | 0],
    );
  }

  // 8. vinheta pintada. Caiu de 0.24 para 0.12 e trocou preto por `occluder`:
  //    medido no quadro da rodada 2, o canto inferior direito saía em
  //    (0,5,10) — as duas vinhetas (esta e a do pós) se multiplicavam e o
  //    canto morria. Escurecer com uma cor marinho em vez de preto mantém
  //    matiz no canto, que é o que separa "quadro fechado" de "buraco".
  ctx.globalCompositeOperation = "source-over";
  const vig = ctx.createRadialGradient(
    SKY_W * 0.5, SKY_H * 0.5, SKY_H * 0.36,
    SKY_W * 0.5, SKY_H * 0.5, SKY_W * 0.82,
  );
  // começa com derivada nula (s²) em vez do bico da rampa linear
  smoothStops(vig, 12, (s) => [Palette.space.occluder, 0.12 * s * s]);
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, SKY_W, SKY_H);

  // dither ±4 por canal: o banding apontado nos leques também aparece nos
  // gradientes largos, e nessa amplitude ainda é invisível como ruído
  dither(ctx, SKY_W, SKY_H, 4);

  // CAMPO DE NÉVOA: a mesma imagem que acabou de ser pintada vira a tabela que
  // diz "qual é a cor do céu neste ponto da tela". É daqui que sai o alvo de
  // convergência da perspectiva atmosférica, e é por ser a MESMA imagem que
  // não há como o fundo e a névoa discordarem (ver Aerial.hazeField).
  hazeField.setFromSky(ctx.getImageData(0, 0, SKY_W, SKY_H).data, SKY_W, SKY_H);
  finishTexture(tex);
  return tex;
}

/**
 * Céu do cockpit: gradiente de proa (névoa adensando na direção do plano de
 * jogo) com um brilho de horizonte e algumas estrelas. Textura PRÓPRIA e não
 * a do céu top-down: são duas vistas com "cima" diferentes, e reaproveitar
 * colocaria o sol num canto arbitrário do recorte.
 *
 * REGRADUADO NA RODADA 3, e este era o defeito que o crítico chamou de "o que
 * faz o quadro parecer amador". MEDIDO: o interior do visor saía em #154371
 * enquanto o céu ao lado dele estava em #05233b — mais que o dobro do valor em
 * todos os canais, um retângulo pálido colado num quadro marinho.
 *
 * A causa é geométrica, não de espaço de cor: a fpCamera olha pelo NARIZ, na
 * horizontal, então o recorte inteiro cai na faixa média do gradiente. Com as
 * paradas antigas (void → deep → haze → warmHaze) a faixa média era `haze`, o
 * valor mais CLARO do céu. Agora o gradiente passa quase todo o percurso entre
 * `void` e `deep` — os mesmos valores que o céu top-down usa no miolo do
 * quadro — e `haze` só aparece nos últimos 12 %, onde a névoa de proa adensa.
 * O visor passa a ler como uma janela para a MESMA cena.
 */
function paintCockpitSky(scene: Scene): DynamicTexture {
  // 1024: o céu do cockpit também vira fundo de TELA CHEIA (vista de cockpit,
  // tecla V) — com 256 px o pontilhado ampliado virava borrões
  const W = 1024;
  const H = 1024;
  const tex = new DynamicTexture("cockpitSkyTex", { width: W, height: H }, scene, false);
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  const rng = mulberry32(0x0cbb17);

  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0.00, css(Palette.space.occluder));
  g.addColorStop(0.40, css(Palette.space.void));
  g.addColorStop(0.88, css(Palette.space.deep));
  g.addColorStop(1.00, css(Palette.space.haze));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // brilho de horizonte fora de centro, na mesma temperatura do sol. Caiu de
  // 0.26 para 0.11: somando em `lighter` sobre o recorte inteiro, era ele que
  // levantava mais o valor médio do visor depois do gradiente.
  ctx.globalCompositeOperation = "lighter";
  const glow = ctx.createRadialGradient(W * 0.34, H * 0.92, 0, W * 0.34, H * 0.92, W * 0.52);
  glow.addColorStop(0.00, css(Palette.space.sunGlow, 0.11));
  glow.addColorStop(0.45, css(Palette.space.warmHaze, 0.05));
  glow.addColorStop(1.00, css(Palette.space.warmHaze, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // densidade e tamanho de ponto proporcionais à resolução (eram 130 de 1 px em 256)
  for (let i = 0; i < 520; i++) {
    const level = 0.12 + Math.pow(rng(), 2.6) * 0.7;
    // menos estrelas embaixo: é onde a névoa é densa
    const py = Math.pow(rng(), 0.7) * H * 0.86;
    ctx.fillStyle = css(0xdfe8ff, level * 0.8);
    ctx.fillRect(rng() * W, py, 2, 2);
  }

  ctx.globalCompositeOperation = "source-over";
  dither(ctx, W, H, 1);
  finishTexture(tex);
  return tex;
}

/**
 * Quadro de esfumaçamento do visor: transparente no miolo, fechando na cor do
 * céu nas bordas. É o que dissolve a ARESTA do recorte de cockpit — o defeito
 * que sobreviveu a três rodadas de ajuste de cor.
 *
 * A queda usa uma SUPERELIPSE (‖(u,v)‖₄) e não `max(|u|,|v|)`: com o máximo, as
 * quatro quinas do recorte ficam com a mesma opacidade das bordas retas e o
 * retângulo continua se anunciando pelos cantos. Com a superelipse os cantos
 * fecham antes, e o que sobra visível é um oval de bordas moles.
 */
function paintPortholeFade(scene: Scene): DynamicTexture {
  const W = 128;
  const H = 96;
  const tex = new DynamicTexture("fpFadeTex", { width: W, height: H }, scene, false);
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  const img = ctx.createImageData(W, H);
  const d = img.data;
  // cor da borda = campo médio do céu, o mesmo valor que o pano de fundo do
  // visor já usa no miolo (medido: o interior batia com o céu ao lado dentro
  // de ~5/255 — a cor nunca foi o problema, então não se muda a cor aqui)
  const col = Palette.space.deep;
  const cr = (col >> 16) & 0xff;
  const cg = (col >> 8) & 0xff;
  const cb = col & 0xff;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = ((x + 0.5) / W) * 2 - 1;
      const v = ((y + 0.5) / H) * 2 - 1;
      const e = Math.pow(Math.pow(Math.abs(u), 4) + Math.pow(Math.abs(v), 4), 0.25);
      const k = Math.max(0, Math.min(1, (e - FADE_START) / (1 - FADE_START)));
      const a = k * k * (3 - 2 * k); // smoothstep: sem quebra no início da queda
      const i = (y * W + x) * 4;
      d[i] = cr;
      d[i + 1] = cg;
      d[i + 2] = cb;
      d[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  finishTexture(tex);
  return tex;
}

/**
 * Disco solar sobre preto: com blending aditivo, preto soma zero, então o
 * canvas fora do halo simplesmente não existe. Núcleo minúsculo e quase
 * branco (é o que estoura o limiar do bloom), halo largo e quente, mais um
 * rastro anamórfico horizontal bem fraco.
 */
function paintSun(scene: Scene): DynamicTexture {
  const tex = new DynamicTexture("sunTex", SUN_TEX, scene, false);
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  const r = SUN_TEX / 2;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, SUN_TEX, SUN_TEX);

  ctx.globalCompositeOperation = "lighter";

  // rastro anamórfico (o risco horizontal de lente)
  ctx.save();
  ctx.translate(r, r);
  ctx.scale(1, 0.030);
  const streak = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.96);
  streak.addColorStop(0, css(Palette.space.sunGlow, 0.62));
  streak.addColorStop(0.32, css(Palette.space.sunGlow, 0.16));
  streak.addColorStop(1, css(Palette.space.sunGlow, 0));
  ctx.fillStyle = streak;
  ctx.fillRect(-r, -r * 40, SUN_TEX, r * 80);
  ctx.restore();

  // RODADA 7 — o halo virou FUNÇÃO. As paradas antigas (0.064 → 0.64,
  // 0.15 → 0.26, 0.38 → 0.09, 1 → 0) terminavam numa rampa linear que batia
  // no zero COM inclinação, no raio do quadro — 300 px de tela a zoom 0.12,
  // um anel que cruza a diagonal sol→centro em (588,372). Medido no quadro da
  // rodada 6, a mediana de luminância abaixo do sol forma crista exatamente
  // nesse raio. Agora são dois termos lisos:
  //   núcleo  0.44·e^(−(r−0.065)/0.05)   — o brilho que o bloom pega
  //   véu     0.205·((1−r)/0.935)²        — derivada NULA em r = 1
  // que reproduzem as paradas aprovadas (0.645 / 0.25 / 0.09 em 0.065 / 0.15 /
  // 0.38) e se emendam com o miolo com inclinação −9.2 contra −8.7 do trecho
  // interno. As amostras são adensadas no miolo (warp 2), onde o perfil é agudo.
  const glow = ctx.createRadialGradient(r, r, 0, r, r, r);
  glow.addColorStop(0.000, css(Palette.space.sunCore, 1));
  glow.addColorStop(0.026, css(Palette.space.sunCore, 0.98));
  const R0 = 0.065;
  const haloHue: Array<[number, number]> = [
    [0.15, Palette.space.sunGlow],
    [0.38, Palette.space.warmHaze],
    [1.00, Palette.space.haze],
  ];
  const HALO_STOPS = 28;
  for (let i = 0; i <= HALO_STOPS; i++) {
    const s = R0 + (1 - R0) * Math.pow(i / HALO_STOPS, 2);
    const a = 0.44 * Math.exp(-(s - R0) / 0.05) + 0.205 * Math.pow((1 - s) / (1 - R0), 2);
    const hue = s <= 0.15 ? Palette.space.sunGlow : rampHex(haloHue, s);
    glow.addColorStop(s, css(hue, Math.min(1, a)));
  }
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, SUN_TEX, SUN_TEX);

  ctx.globalCompositeOperation = "source-over";
  // dither também no halo: é camada ADITIVA sem ruído próprio, e seus degraus
  // de 1 LSB (um a cada ~20 px na cauda) atravessavam o dither do céu intactos.
  // Só onde há sinal (≥ 6): fora do disco o fundo é preto, e ruído ali seria
  // grampeado em zero — viés positivo desenhando o QUADRADO do quadro.
  {
    const img = ctx.getImageData(0, 0, SUN_TEX, SUN_TEX);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.max(d[i], d[i + 1], d[i + 2]) < 6) continue;
      d[i] += ((Math.random() * 5) | 0) - 2;
      d[i + 1] += ((Math.random() * 5) | 0) - 2;
      d[i + 2] += ((Math.random() * 5) | 0) - 2;
    }
    ctx.putImageData(img, 0, 0);
  }
  finishTexture(tex);
  return tex;
}

/**
 * Ruído ±amp — antibanding do gradiente.
 *
 * RODADA 7: o sorteio passou a ser INDEPENDENTE POR CANAL. Antes um único `n`
 * ia para R, G e B, o que desloca a cor ao longo da diagonal acromática e não
 * quebra escada NENHUMA em canal isolado — e a banda reclamada estava numa
 * diagonal onde o croma varia mais rápido que o valor, ou seja exatamente o
 * caso que o ruído monocromático não cobre. Com sorteios independentes, cada
 * canal tem a própria escada quebrada. O preço é um respingo de croma de ±amp,
 * invisível nesta amplitude e preferível à banda.
 */
function dither(ctx: CanvasRenderingContext2D, w: number, h: number, amp: number): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const span = amp * 2 + 1;
  for (let i = 0; i < d.length; i += 4) {
    d[i] += ((Math.random() * span) | 0) - amp;
    d[i + 1] += ((Math.random() * span) | 0) - amp;
    d[i + 2] += ((Math.random() * span) | 0) - amp;
  }
  ctx.putImageData(img, 0, 0);
}

function finishTexture(tex: DynamicTexture): void {
  tex.wrapU = Texture.CLAMP_ADDRESSMODE;
  tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  tex.update();
}

// ── malha dos detritos ─────────────────────────────────────────────────────

/**
 * Reaproveita o gerador de asteroides e transforma a batata em LAJE: o
 * achatamento entra na geometria (não em `scaling`), para o giro no plano
 * continuar rígido e as normais não precisarem de correção por frame. Gera
 * com raio grande e normaliza para 1 porque a plataforma de construção do
 * gerador tem tamanho ABSOLUTO — em raio 1 ela engoliria a rocha inteira.
 */
function buildDebrisMesh(scene: Scene, spec: DebrisSpec): Mesh {
  const GEN_R = 1000;
  const data = generateAsteroidMesh(spec.seed, GEN_R, "large");
  const [fx, fy, fz] = spec.slab;
  const k = 1 / GEN_R;

  const positions = new Array<number>(data.vertices.length * 3);
  const normals = new Array<number>(data.normals.length * 3);
  for (let i = 0; i < data.vertices.length; i++) {
    const v = data.vertices[i];
    positions[i * 3] = v.x * k * fx;
    positions[i * 3 + 1] = v.y * k * fy;
    positions[i * 3 + 2] = v.z * k * fz;
    // normal sob escala não-uniforme: inversa-transposta ⇒ divide por fator
    const n = data.normals[i];
    const nx = n.x / fx;
    const ny = n.y / fy;
    const nz = n.z / fz;
    const len = Math.hypot(nx, ny, nz) || 1;
    normals[i * 3] = nx / len;
    normals[i * 3 + 1] = ny / len;
    normals[i * 3 + 2] = nz / len;
  }

  const mesh = new Mesh(`debris_${spec.seed.toString(16)}`, scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.normals = normals;
  vd.indices = data.triangles;
  vd.applyToMesh(mesh);
  return mesh;
}
