/**
 * Lighting — o rig que desenha TODA a geometria sólida do jogo (rochas,
 * estruturas, detritos de fundo).
 *
 * DECISÃO CENTRAL DA RODADA 2: a chave deixou de ser DirectionalLight e virou
 * PointLight a distância FINITA. Uma direcional é literalmente "um valor no
 * shader": `ndl = dot(N, −dir)` não depende de ONDE a rocha está, então o
 * terminador cai no mesmo lugar em todas as 250 rochas e o campo inteiro lê
 * como um decalque repetido em várias escalas. Com uma pontual logo fora do
 * canto superior esquerdo do quadro:
 *   - a DIREÇÃO da luz varia ~90° entre a rocha do canto superior esquerdo e a
 *     do canto inferior direito — cada rocha ganha o próprio terminador;
 *   - a ATENUAÇÃO (no StandardMaterial é linear: `1 − d/range`) cria um
 *     gradiente de brilho atravessando o quadro, que é leitura de escala e de
 *     profundidade de graça;
 *   - a fonte passa a ter POSIÇÃO, e o disco solar do Backdrop é colocado
 *     exatamente nela — sob ortográfica a projeção de tela é a própria coordenada
 *     XY, então "mesma posição" é literal, sem divisão perspectiva no meio.
 *
 * RODADA 3 — o mecanismo estava certo e a DOSAGEM estava errada, e isso só
 * apareceu medindo a captura em vez de olhar para ela. Na rodada 2 a razão
 * entre faceta iluminada e faceta de sombra era de 1.26:1: o preenchimento a
 * 0.75 e o rim a 1.05 preenchiam o lado escuro quase até o nível do lado
 * claro, e a pontual — que de fato girava a direção da luz ~130° pelo quadro —
 * girava um terminador que praticamente não existia. Daí o veredito "todos os
 * terminadores no mesmo ângulo, lado escuro em marrom chapado, zero bounce":
 * não faltava variação, faltava AMPLITUDE para a variação aparecer. Esta
 * rodada corta preenchimento e rim, satura o rebote frio, lateraliza a chave e
 * encurta o alcance. Nenhuma luz nova: o orçamento continua em 4.
 *
 * O resto da profundidade — o que a luz não consegue dar porque a câmera é
 * ortográfica — vem de Aerial.ts, e é ele quem liga `scene.ambientColor`.
 *
 * A luz é parenteada à câmera principal e reposicionada em `resize()` a partir
 * da meia-altura ortográfica: assim ela ocupa sempre o mesmo ponto da tela que
 * o flare, em qualquer zoom. As unidades têm PISO (`MIN_UNIT`) porque no zoom
 * máximo a meia-altura cai para ~130 unidades e a fonte entraria dentro do
 * campo de rochas; com o piso, ela apenas se comporta como uma direcional
 * distante quando o enquadramento é pequeno, que é o comportamento correto.
 *
 * Geometria da cena (ver layers.ts): câmera ortográfica em −Z olhando +Z,
 * +X à direita da tela, +Y para cima.
 *
 * ORÇAMENTO: chave (pontual) + rim (pontual desde a rodada 7) + preenchimento
 * (hemisférica) + farol da nave = 4, exatamente o `maxSimultaneousLights` padrão do
 * StandardMaterial. Uma quinta luz sumiria do shader sem erro nenhum — e a
 * primeira a cair seria o farol, que é o que ilumina a vista do cockpit.
 */

import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Palette } from "./Palette";
import { c3 } from "./lineUtils";

/**
 * Posição do sol NA TELA, em meias-alturas de viewport (x é corrigido pela
 * proporção pelo chamador). Fonte única: o Backdrop coloca o disco aqui e o
 * rig coloca a luz aqui. Não há como divergirem.
 */
export const SUN_SCREEN = { x: -0.66, y: 0.60 };
/**
 * Recuo do sol em direção à câmera, em meias-alturas.
 *
 * MEDIDO NA RODADA 2 e corrigido aqui. As rochas vivem em z LOCAL à câmera
 * entre ~900 (a menor) e ~2840 (a maior) — o renderer recua cada root pelo
 * raio envolvente. Com o sol em 0.55 meias-alturas À FRENTE da câmera, a
 * separação em Z entre fonte e rocha chegava a ~4200 unidades contra um
 * deslocamento lateral de ~3000: a luz caía quase de frente, uma faceta
 * virada para a câmera recebia 0.81 da chave e o terminador ficava EMPURRADO
 * para fora da silhueta visível. Daí "todos os terminadores no mesmo ângulo":
 * não é que a pontual não varie, é que quase não havia terminador para variar.
 *
 * Em 0.32 a luz fica bem mais LATERAL: a faceta frontal recebe ~0.86 junto ao
 * sol e ~0.52 no canto oposto, então o terminador entra na silhueta e a
 * inclinação dele muda de verdade de uma rocha para a outra. Valores abaixo de
 * ~0.2 foram simulados e descartados: a luz vira rasante demais, o terço
 * direito do quadro (o mais longe da fonte) cai para ndl ~0.22 e as rochas de
 * lá viram lama escura — troca-se um defeito por outro.
 */
const SUN_DEPTH = 0.32;
/** piso/teto da unidade de posicionamento — ver nota do cabeçalho */
const MIN_UNIT = 1600;
const MAX_UNIT = 9000;
/**
 * Alcance da chave. Encurtou (era 4.0·u + 8000) para a atenuação linear
 * `1 − d/range` virar um gradiente LEGÍVEL e não um platô: agora vai de ~0.77
 * no miolo a ~0.59 no canto oposto ao sol. Junto com a queda do `ndl` lateral,
 * a mesma rocha grande sai em 174,143,102 perto do sol e em 86,74,57 no canto
 * oposto — é a "escala" que faltava atravessando o quadro, e custa exatamente
 * nada porque já estava no shader.
 */
const RANGE_FACTOR = 3.4;
const RANGE_BASE = 7000;

/**
 * ─────────────────────────────────────────────────────────────────────────
 * RODADA 7 — O KICKER FRIO VIROU PONTUAL, e a medição que decidiu isso.
 *
 * Quarta rodada com "terminador idêntico entre as rochas ocres". A hipótese
 * era que a chave, longe demais do enquadramento a zoom 0.12, se comportasse
 * como direcional. MEDIDO no quadro da rodada 6 (direção sombra→luz de cada
 * rocha ocre isolada, centroide do terço claro menos o do terço escuro,
 * contra a direção que a pontual prevê para aquele ponto da tela):
 *     rocha      medido   previsto   Lz      lum p10 / p90
 *     (763,245)   176°     168°    −0.60      31 / 130
 *     (515,387)   127°     121°    −0.74      34 / 141
 *     (950,540)   150°     146°    −0.40      24 /  94
 *     (355,401)    47°      85°    −0.77      32 / 154
 *     (624,475)    60°     128°    −0.59      38 / 158
 * A hipótese CAI: a chave gira 83° entre as rochas do campo (130° medidos,
 * com o tombo somando) e Lz vai de −0.40 a −0.77 — isso não é direcional. O
 * que é idêntico está na última coluna: o lado ACESO varia de 94 a 158, o
 * lado de SOMBRA fica preso entre 24 e 38. E o lado de sombra é pintado só
 * por DIRECIONAIS — este rim e a hemisférica —, que por definição acendem as
 * mesmas facetas com o mesmo valor em toda rocha. O terminador é a fronteira
 * entre a chave e o lado escuro; com o lado escuro carimbado, ele lê igual.
 *
 * A correção é dar posição ao kicker: uma pontual fria fora do canto inferior
 * direito, oposta ao sol e NA PROFUNDIDADE DAS ROCHAS (z local fixo, não
 * escalado com o zoom — as rochas não escalam), com alcance curto. Medido por
 * simulação no mesmo enquadramento: a direção dela varia de −8° a −75° entre
 * as rochas do campo e a atenuação de 0.32 (junto ao sol, onde a chave manda)
 * a 0.85 (canto oposto). Cada rocha recebe outra mistura quente/fria no lado
 * de sombra, e o terminador deixa de ser carimbo. Custo: nenhuma luz a mais
 * (continuam 4), só a atenuação por fragmento — nas 88 rochas, ruído.
 *
 * Lz continua ≈ +0.03 (fonte ligeiramente ATRÁS do plano das rochas): num
 * sólido fechado, luz de trás só acende facetas rasantes — o rim continua
 * sendo rim, e não uma segunda chave.
 */
const RIM_SCREEN = { x: 1.95, y: -1.25 };
/** profundidade LOCAL fixa da fonte: meio da faixa das rochas (~900..2840) */
const RIM_Z = 1800;
/** alcance em meias-alturas — de ~0.85 junto à fonte a ~0.3 no canto do sol */
const RIM_RANGE_FACTOR = 5.0;
/** "céu" da hemisférica: o lado que a chave abandonou */
export const FILL_DIR = new Vector3(0.72, -0.66, -0.22).normalize();

/** compensa a atenuação média (~0.70) para a chave manter o brilho projetado */
const KEY_INTENSITY = 2.20;
/**
 * O rim caiu de 1.05 para 0.60. Ele ERA direcional: acendia exatamente as mesmas
 * facetas em todas as ~250 rochas, então cada décimo que ele ganhava era um
 * décimo de "campo uniforme" somado ao quadro. A 0.60 ele ainda desenha a
 * borda fria contra o céu e já não compete com o rebote.
 */
/**
 * RODADA 7: 0.60 → 0.95 junto com a troca para pontual. Multiplicado pela
 * atenuação (0.32..0.85) dá 0.30..0.81 — MÉDIA ~0.55, a mesma do rim
 * direcional aprovado; o que muda é que agora ela se DISTRIBUI pelo quadro.
 */
const RIM_INTENSITY = 0.95;
/**
 * O preenchimento caiu de 0.75 para 0.42. Era ele o responsável pelo defeito
 * central medido na rodada 2: a razão entre faceta iluminada e faceta de
 * sombra estava em 1.26:1 — praticamente nenhuma modelagem, e é por isso que
 * as rochas liam como adesivo. Com 0.42 e o rebote saturado da Palette, a
 * rocha de perto abre ~5.5:1 e a de longe fecha em ~2.2:1 (o fechamento vem do
 * piso de névoa de Aerial.ts, não daqui).
 */
const FILL_INTENSITY = 0.42;

export class SpaceLightRig {
  readonly key: PointLight;
  readonly rim: PointLight;
  readonly fill: HemisphericLight;

  constructor(scene: Scene, camera: Camera) {
    // HABILITA O PISO DE NÉVOA DE Aerial.ts. No StandardMaterial o termo
    // `vAmbientColor` é `scene.ambientColor * material.ambientColor`; com a
    // cena em preto (o padrão) o `ambientColor` de qualquer material é
    // multiplicado por zero e some. Ligar a cena em branco NÃO acende nada
    // sozinho: todo material nasce com `ambientColor` preto, então só quem
    // pede piso recebe piso. É o canal aditivo que o GlowLayer não enxerga —
    // ver a nota longa em Aerial.ts sobre por que não pode ser emissivo.
    scene.ambientColor = Color3.White();

    this.key = new PointLight("keyLight", Vector3.Zero(), scene);
    this.key.parent = camera;
    this.key.diffuse = c3(Palette.light.key);
    this.key.specular = Color3.Black();
    this.key.intensity = KEY_INTENSITY;

    this.rim = new PointLight("rimLight", Vector3.Zero(), scene);
    this.rim.parent = camera;
    this.rim.diffuse = c3(Palette.light.rim);
    this.rim.specular = Color3.Black();
    this.rim.intensity = RIM_INTENSITY;

    this.fill = new HemisphericLight("fillLight", FILL_DIR.clone(), scene);
    this.fill.diffuse = c3(Palette.light.fillSky);
    this.fill.groundColor = c3(Palette.light.fillGround);
    this.fill.specular = Color3.Black();
    this.fill.intensity = FILL_INTENSITY;
  }

  /** Reposiciona a chave para o enquadramento atual (chamado por updateOrtho). */
  resize(halfW: number, halfH: number): void {
    void halfW;
    const u = Math.min(MAX_UNIT, Math.max(MIN_UNIT, halfH));
    this.key.position.set(SUN_SCREEN.x * u, SUN_SCREEN.y * u, -SUN_DEPTH * u);
    this.key.range = RANGE_FACTOR * u + RANGE_BASE;
    this.rim.position.set(RIM_SCREEN.x * u, RIM_SCREEN.y * u, RIM_Z);
    this.rim.range = RIM_RANGE_FACTOR * u;
  }

  dispose(): void {
    this.key.dispose();
    this.rim.dispose();
    this.fill.dispose();
  }
}
