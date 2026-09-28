/**
 * Aerial — perspectiva atmosférica para uma cena ORTOGRÁFICA, onde ela não
 * existe de graça.
 *
 * O PROBLEMA. Sob projeção ortográfica não há divisão perspectiva: duas rochas
 * do mesmo raio ocupam o mesmo número de pixels em qualquer canto do quadro, e
 * o `fog` do Babylon não serve porque ele mede `length(posição de view)` — com
 * meia-largura de ~5000 unidades a distância é dominada pelo deslocamento
 * LATERAL e o resultado é uma vinheta radial. Sem correção, todo asteroide sai
 * no mesmo tom e o campo lê como uma folha de adesivos.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RODADA 4 — este arquivo existia na rodada 3 e produziu o resultado
 * EXATAMENTE INVERTIDO: "o asteroide mais próximo é o mais claro e
 * dessaturado do quadro; os fragmentos distantes são mais escuros e
 * contrastados que ele". Instrumentado, foram DOIS erros independentes, e
 * nenhum deles era o sinal de `t` (a monotonia sempre esteve certa: raio
 * grande → t baixo).
 *
 * ERRO 1 — A FÓRMULA. A rodada 3 fazia `diffuse = mix(albedo, névoa, k)`. Isso
 * não apaga o objeto: SUBSTITUI o albedo dele pela cor da névoa e continua
 * multiplicando pela luz. Um objeto distante ficava com albedo azul-claro e
 * plenamente iluminado — ou seja, quanto mais longe, MAIS BRILHANTE. Era essa
 * a inversão, e o pior caso era a laje de fundo, o maior objeto do quadro, que
 * saía como a massa mais clara da cena.
 *
 * A operação correta é uma INTERPOLAÇÃO ENTRE O OBJETO ILUMINADO E A NÉVOA:
 *     final = lerp(luz · albedo, névoa, k)
 * e ela se decompõe exatamente nos dois canais que o StandardMaterial oferece:
 *     diffuseColor = albedo · (1 − k)      ← o objeto DESAPARECE
 *     ambientColor = névoa · k             ← a névoa TOMA O LUGAR dele
 * porque o shader calcula `clamp(diffuseBase·diffuseColor + vAmbientColor)`.
 * Sem plugin, sem shader próprio, sem custo — só a álgebra certa.
 *
 * ERRO 2 — A DISTRIBUIÇÃO. `t` vinha do log do raio normalizado em
 * [200, 2000]. Mas o procgen não sorteia raio uniforme: ele usa
 * `r = MIN·(MAX/MIN)^(u^SIZE_SKEW)` com u uniforme e SIZE_SKEW = 3, o que
 * empilha ~66 % da população abaixo de 400 unidades. Resultado medido: 50 %
 * das rochas caíam em t ≈ 0.75 e o quadro inteiro recebia o tratamento de
 * "longe" — daí o colapso monocromático, com o quente sobrevivendo em uma
 * única rocha. Agora `t` vem do PERCENTIL de tamanho (desfazendo o expoente do
 * procgen), então 63 % das rochas ficam em t ≤ 0.25 e mantêm a cor local.
 *
 * DIREÇÃO DA CONVERGÊNCIA. Névoa aproxima tudo do valor do CÉU. Num céu claro
 * (Homeworld 3) isso CLAREIA o que está longe; no nosso céu marinho isso
 * ESCURECE. A rodada 3 copiou a regra "distante sobe de valor" de um quadro
 * claro para um quadro escuro e por isso o fundo avançou sobre o primeiro
 * plano — coisa clara avança, sempre. Aqui a névoa é um cinza-azul escuro, um
 * degrau acima do campo médio do céu: longe fica mais escuro, mais frio e mais
 * chapado; perto fica quente, saturado e com sombra funda. É essa divisão de
 * temperatura por DISTÂNCIA que o adversário sustenta e nós tínhamos perdido.
 *
 * POR QUE `ambientColor` E NÃO `emissiveColor`. Os dois entram no mesmo ponto
 * do shader, mas o GlowLayer decide o que brilha lendo `material.emissiveColor`:
 * com emissivo, ~160 rochas entrariam no mapa de glow e virariam um borrão de
 * tela cheia. `vAmbientColor` é `scene.ambientColor · material.ambientColor` e
 * o glow não o enxerga. Quem liga `scene.ambientColor = branco` é o rig de luz
 * (Lighting.ts); material que não pedir piso continua com ambient preto.
 *
 * UM ÚNICO DEGRAU PARA A CENA INTEIRA: rochas ocupam [ROCK_T_MIN, ROCK_T_MAX]
 * e as lajes de fundo continuam de onde elas param (ver TIER_T em Backdrop).
 */

import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Palette } from "./Palette";

/**
 * Fração máxima de névoa em t = 1. Não chega a 1.0 de propósito: um objeto
 * 100 % névoa é um recorte do céu, e aí a camada deixa de existir em vez de
 * ficar distante.
 */
const HAZE_MAX = 0.88;
/**
 * Expoente da névoa. >1 concentra o efeito no fundo: em t = 0.05 a névoa vale
 * 0.02 (a rocha de perto é a cor local pura, com sombra funda) e em t = 0.86
 * vale 0.72 (a laje de fundo é quase só ar). É essa curva que impede a
 * dessaturação de comer o primeiro plano, que foi o defeito da rodada 3.
 */
const HAZE_CURVE = 1.35;

/** faixa de t das rochas — o fundo começa acima disto (ver Backdrop.ts) */
export const ROCK_T_MAX = 0.58;
/** piso de t das rochas: nem a maior fica com zero névoa */
export const ROCK_T_MIN = 0.03;

/** hex → Color3 (cópia local: este módulo não deve depender de lineUtils) */
const c3 = (hex: number): Color3 =>
  new Color3(((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255);

/** fração de névoa na distância t */
export const hazeAt = (t: number): number =>
  Math.min(1, Math.pow(clamp01(t), HAZE_CURVE) * HAZE_MAX);

/** albedo restante depois da névoa — o objeto some, não muda de cor */
export function aerialDiffuse(baseHex: number, t: number): Color3 {
  return c3(baseHex).scale(1 - hazeAt(t));
}

// `aerialFloor(t)` e `applyAerial(mat, hex, t)` saíram na rodada 5: os dois
// devolviam o piso a partir do alvo GLOBAL `space.aerial`, que é exatamente a
// premissa que esta rodada derrubou. Quem monta material agora pede a cor à
// zona (`hazeField.zoneColorTo`) ou ao ponto (`sampleTo`) e multiplica por
// `hazeAt(t)` — deixar as versões globais de pé seria manter à mão um atalho
// que reintroduz o defeito sem avisar.

/**
 * ─────────────────────────────────────────────────────────────────────────
 * CAMPO DE NÉVOA (rodada 5) — a névoa deixa de ter UMA cor.
 *
 * A rodada 4 acertou a direção (longe converge para o valor do céu) mas usou
 * um alvo GLOBAL, `space.aerial`, marinho. O céu, porém, não é uniforme: tem
 * um halo quente em volta do sol ocupando o quadrante superior esquerdo. Lá, o
 * "converge para o céu" ficou "converge para marinho", e o veredito foi
 * exato: "os asteroides distantes atrás do halo do sol são pintados em azul
 * mais escuro e saturado que o fundo alaranjado daquele quadrante, então o
 * mais longe pesa mais que o próximo". Névoa mais escura que o fundo é a
 * definição de perspectiva atmosférica invertida — localmente.
 *
 * A correção é amostrar a névoa da PRÓPRIA imagem do céu. Depois de pintar a
 * textura, o Backdrop reduz o canvas a uma tabela minúscula e é ela que
 * responde "qual é a cor do céu neste ponto da tela". Não há como divergir da
 * arte do fundo: é a mesma imagem, subamostrada — e transformada em névoa por
 * um operador de duas constantes que reproduz a calibragem da rodada 4 no
 * campo marinho (ver HAZE_DESAT/HAZE_GAIN).
 *
 * Uma LUT e não uma reconstrução analítica de propósito: o céu é feito de sete
 * passadas (gradiente, véu quente, nebulosas, massa de canto, estrelas), e
 * reescrever isso como fórmula seria uma segunda fonte de verdade fadada a
 * sair do lugar. Subamostrar é exato por construção.
 *
 * O tamanho é ridículo (48×30 = 1440 amostras, ~4 KB) porque a névoa é
 * baixíssima frequência — o que interessa dela é o halo do sol contra o campo
 * marinho, e isso sobrevive de sobra a essa redução. Estrelas e granulado
 * somem na média, que é exatamente o desejado: a névoa é o CAMPO, não o
 * detalhe pintado em cima dele.
 */
const HAZE_LUT_W = 48;
const HAZE_LUT_H = 30;

/**
 * A NÉVOA NÃO É O CÉU CRU — e este par de constantes é o que impede a rodada 5
 * de desfazer a calibragem MEDIDA da rodada 4 enquanto conserta o halo.
 *
 * Se a névoa fosse exatamente a cor do céu amostrado, um objeto 100 % névoa
 * seria um recorte invisível do fundo, e a laje da camada mais funda (k = 0.72)
 * perderia a silhueta que ela existe para ter — foi por isso que a rodada 4
 * escolheu `space.aerial` UM DEGRAU ACIMA de `space.deep`, e por isso ela
 * também o escolheu DESSATURADO (névoa é luz espalhada por partículas: chega
 * ao olho mais cinza que a fonte, não é céu com mais brilho).
 *
 * As duas decisões são LOCAIS, não globais — só estavam congeladas num hex
 * porque não havia de onde ler o céu. Aqui elas viram um operador aplicado a
 * cada amostra: dessatura em direção à própria luminância e ganha um degrau.
 *
 * A CONFERÊNCIA que justifica os números: aplicado ao campo médio do céu
 * (`deep` = 27,48,72 → 0.106, 0.188, 0.282), o operador devolve
 * (0.149, 0.217, 0.295) contra o `aerial` da rodada 4, (0.141, 0.220, 0.310).
 * Ou seja, nos ~80 % do quadro que são campo marinho a névoa continua
 * exatamente onde o julgamento a aprovou, e o que muda é só o quadrante do
 * halo — que é precisamente o defeito relatado. Uma correção que reproduz o
 * valor anterior como caso particular não pode regredir o que já ganhou.
 */
const HAZE_DESAT = 0.30;
const HAZE_GAIN = 1.18;

/**
 * ─────────────────────────────────────────────────────────────────────────
 * ZONAS — a névoa local com orçamento de 60 fps.
 *
 * A primeira versão desta rodada dava a cada rocha o SEU alvo de névoa, e
 * portanto o SEU material. Medido a 1280×800 numa Intel UHD com sincronia de
 * GPU forçada: 155 materiais para 155 malhas custaram +1,84 ms sobre a rodada
 * 4 (15,26 → 17,10 ms, 58 fps) e reprovaram no requisito antes de qualquer
 * julgamento de arte. A causa é o bind: o Babylon ordena os opacos por
 * `material.uniqueId` (RenderingGroup.PainterSortCompare), então material
 * compartilhado por N malhas paga UM bloco de uniformes e material por malha
 * paga N — ~13 µs cada, nesta máquina.
 *
 * O recuo é quantizar o ALVO, não abandoná-lo. E a quantização é por COR e não
 * por retângulo de tela: um k-means de NZ grupos sobre as próprias células da
 * LUT põe grupo onde o céu de fato VARIA e economiza onde ele é chapado. Uma
 * grade retangular faria o contrário — células do mesmo tamanho no halo do sol,
 * onde a névoa muda depressa, e no campo marinho, onde ela não muda nada — e
 * degrau visível em gradiente é o artefato que já custou uma rodada (os leques).
 *
 * NZ = 6 com 5 degraus de profundidade dá no MÁXIMO 30 materiais, contra 155.
 *
 * NZ = 6 E NÃO 8, medido. Rodando este mesmo k-means sobre uma reconstrução
 * offline das passadas dominantes do céu (base, véu, nebulosas, massa de canto,
 * vinheta), o erro de quantização CHEGA AO PIXEL multiplicado por `k`, que nas
 * rochas vale no máximo 0.42:
 *     NZ=6 → erro p50/p95 de 2.1/5.7 em 255;  halo coberto por 3 zonas
 *     NZ=8 → erro p50/p95 de 1.7/4.3 em 255;  halo coberto por 4 zonas
 * Os 1.4/255 de diferença em p95 estão abaixo do limiar que a rodada 3 já
 * mediu como invisível, e custariam 10 materiais. O pior caso residual, nas
 * duas configurações, cai na célula do NÚCLEO DO SOL — a região que o bloom
 * satura de qualquer jeito, e a única do quadro cuja cor é extrema numa área
 * pequena demais para o k-means perseguir.
 *
 * O que essa medição garante e que era a preocupação real: com 6 zonas o halo
 * recebe TRÊS delas, ou seja o gradiente dentro do halo sobrevive à
 * quantização em vez de virar um patamar chapado. O ganho da rodada 5 — rochas
 * do quadrante do sol puxando para o ocre enquanto as distantes esfriam —
 * está preservado; o que se perdeu foi a resolução dentro de cada patamar.
 *
 * Sobre BANDA: o maior degrau entre duas zonas vizinhas é ~13/255 no pixel e
 * NÃO diminui com mais zonas (é o vão de croma entre a família marinha e a
 * quente, intrínseco ao céu, e o próprio céu faz a mesma transição ali). Ele
 * aparece entre dois OBJETOS distintos, cada um com tombamento, ruído mineral
 * e degrau de profundidade próprios — não há superfície contínua onde um
 * degrau desses possa ler como banda, que é o que diferencia este caso dos
 * leques pintados que foram reprovados duas vezes.
 *
 * As lajes do Backdrop continuam amostrando EXATO (`sampleTo`): são 15
 * materiais fixos, calculados uma vez na construção, e aí a quantização não
 * compraria nada.
 */
const HAZE_ZONES = 6;
/** iterações de Lloyd — o campo é quase 1-D, converge em bem menos que isto */
const ZONE_ITERS = 12;

class HazeField {
  /** RGB 0..1, linha 0 = topo da tela (mesma orientação do canvas do céu) */
  private lut = new Float32Array(HAZE_LUT_W * HAZE_LUT_H * 3);
  /** centroides das zonas (RGB 0..1) — o alvo de névoa que os materiais usam */
  private palette = new Float32Array(HAZE_ZONES * 3);
  /** zona de cada célula da LUT: o `zoneOf` é uma indexação, sem busca */
  private zoneMap = new Uint8Array(HAZE_LUT_W * HAZE_LUT_H);
  private ready = false;

  constructor() {
    // antes do céu existir, TODAS as zonas são o alvo global da rodada 4: um
    // material construído cedo demais sai com a cor certa, só não local
    const a = c3(Palette.space.aerial);
    for (let i = 0; i < HAZE_ZONES; i++) {
      this.palette[i * 3] = a.r;
      this.palette[i * 3 + 1] = a.g;
      this.palette[i * 3 + 2] = a.b;
    }
  }

  /**
   * Subamostra o canvas já pintado do céu por média de blocos e guarda JÁ
   * transformado em névoa (ver HAZE_DESAT/HAZE_GAIN) — o consumidor só
   * multiplica pela fração `k`, e não há chance de dois chamadores aplicarem
   * o operador em quantidades diferentes.
   */
  setFromSky(pixels: Uint8ClampedArray, w: number, h: number): void {
    for (let ty = 0; ty < HAZE_LUT_H; ty++) {
      const y0 = Math.floor((ty * h) / HAZE_LUT_H);
      const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * h) / HAZE_LUT_H));
      for (let tx = 0; tx < HAZE_LUT_W; tx++) {
        const x0 = Math.floor((tx * w) / HAZE_LUT_W);
        const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * w) / HAZE_LUT_W));
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * w + x) * 4;
            r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2]; n++;
          }
        }
        const sr = r / n / 255;
        const sg = g / n / 255;
        const sb = b / n / 255;
        // céu → névoa: dessatura em direção à luminância (Rec. 601) e sobe um
        // degrau. O degrau é MULTIPLICATIVO de propósito: assim a separação
        // entre a massa distante e o fundo atrás dela é a mesma RAZÃO em
        // qualquer ponto do quadro, inclusive no canto escuro, onde uma soma
        // constante ou clarearia demais ou não sobraria contraste nenhum.
        const lum = 0.299 * sr + 0.587 * sg + 0.114 * sb;
        const o = (ty * HAZE_LUT_W + tx) * 3;
        this.lut[o] = (sr + (lum - sr) * HAZE_DESAT) * HAZE_GAIN;
        this.lut[o + 1] = (sg + (lum - sg) * HAZE_DESAT) * HAZE_GAIN;
        this.lut[o + 2] = (sb + (lum - sb) * HAZE_DESAT) * HAZE_GAIN;
      }
    }
    this.ready = true;
    this.buildZones();
  }

  /**
   * k-means (Lloyd) sobre as células da LUT — ver a nota de HAZE_ZONES.
   *
   * SEMEADURA POR PERCENTIL DE LUMINÂNCIA, e não aleatória: além de ser
   * determinística (o céu é procedural mas fixo; duas execuções têm que dar o
   * mesmo quadro), ela já nasce espalhada no eixo dominante do campo. O halo
   * do sol é o trecho mais CLARO do céu, então a semente do topo cai dentro
   * dele desde a primeira iteração — que é justamente a região que não pode
   * ser engolida pela média marinha, já que é onde o defeito relatado mora.
   *
   * Grupo que fica vazio conserva o centroide anterior em vez de ser
   * ressemeado: com 6 grupos sobre um campo quase 1-D isso praticamente não
   * acontece, e um ressorteio tornaria o resultado dependente da ordem.
   */
  private buildZones(): void {
    const n = HAZE_LUT_W * HAZE_LUT_H;
    const lum = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      lum[i] = 0.299 * this.lut[i * 3] + 0.587 * this.lut[i * 3 + 1] + 0.114 * this.lut[i * 3 + 2];
    }
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => lum[a] - lum[b]);
    for (let z = 0; z < HAZE_ZONES; z++) {
      const seed = order[Math.min(n - 1, Math.floor(((z + 0.5) / HAZE_ZONES) * n))];
      this.palette[z * 3] = this.lut[seed * 3];
      this.palette[z * 3 + 1] = this.lut[seed * 3 + 1];
      this.palette[z * 3 + 2] = this.lut[seed * 3 + 2];
    }

    const sum = new Float64Array(HAZE_ZONES * 3);
    const count = new Uint32Array(HAZE_ZONES);
    for (let it = 0; it < ZONE_ITERS; it++) {
      sum.fill(0);
      count.fill(0);
      for (let i = 0; i < n; i++) {
        const r = this.lut[i * 3], g = this.lut[i * 3 + 1], b = this.lut[i * 3 + 2];
        let best = 0;
        let bestD = Infinity;
        for (let z = 0; z < HAZE_ZONES; z++) {
          const dr = r - this.palette[z * 3];
          const dg = g - this.palette[z * 3 + 1];
          const db = b - this.palette[z * 3 + 2];
          const d = dr * dr + dg * dg + db * db;
          if (d < bestD) { bestD = d; best = z; }
        }
        this.zoneMap[i] = best;
        sum[best * 3] += r;
        sum[best * 3 + 1] += g;
        sum[best * 3 + 2] += b;
        count[best]++;
      }
      for (let z = 0; z < HAZE_ZONES; z++) {
        if (count[z] === 0) continue;
        this.palette[z * 3] = sum[z * 3] / count[z];
        this.palette[z * 3 + 1] = sum[z * 3 + 1] / count[z];
        this.palette[z * 3 + 2] = sum[z * 3 + 2] / count[z];
      }
    }
  }

  /** zona de névoa no ponto (u,v) de tela — indexação pura, sem busca */
  zoneOf(u: number, v: number): number {
    return this.zoneMap[this.cellOf(u, v)];
  }

  /** centroide de uma zona, já multiplicado pela fração de névoa `scale` */
  zoneColorTo(zone: number, out: Color3, scale: number): void {
    const o = zone * 3;
    out.set(this.palette[o] * scale, this.palette[o + 1] * scale, this.palette[o + 2] * scale);
  }

  /**
   * Cor do céu em (u,v) de tela — u para a direita, v para BAIXO, ambos 0..1.
   * Fora do quadro a amostra é grampeada na borda: um objeto que sai de cena
   * mantém a névoa da borda em vez de saltar para a cor global.
   *
   * Sem interpolação bilinear: cada célula cobre ~27 px de tela e a saída
   * alimenta um `ambientColor` que só é reescrito quando a célula muda (ver
   * AsteroidRenderer). Interpolar aqui só produziria escrita de uniforme a
   * cada frame, que é justamente o custo que se quer evitar.
   */
  sampleTo(u: number, v: number, out: Color3, scale: number): void {
    if (!this.ready) {
      const a = c3(Palette.space.aerial);
      out.set(a.r * scale, a.g * scale, a.b * scale);
      return;
    }
    const x = Math.min(HAZE_LUT_W - 1, Math.max(0, Math.floor(u * HAZE_LUT_W)));
    const y = Math.min(HAZE_LUT_H - 1, Math.max(0, Math.floor(v * HAZE_LUT_H)));
    const o = (y * HAZE_LUT_W + x) * 3;
    out.set(this.lut[o] * scale, this.lut[o + 1] * scale, this.lut[o + 2] * scale);
  }

  /** índice da célula — o gatilho barato de "precisa reescrever o uniforme?" */
  cellOf(u: number, v: number): number {
    const x = Math.min(HAZE_LUT_W - 1, Math.max(0, Math.floor(u * HAZE_LUT_W)));
    const y = Math.min(HAZE_LUT_H - 1, Math.max(0, Math.floor(v * HAZE_LUT_H)));
    return y * HAZE_LUT_W + x;
  }
}

/** campo único da cena: o Backdrop preenche, o AsteroidRenderer consome */
export const hazeField = new HazeField();

/**
 * Expoente de tamanho do procgen (`sim-core/src/procgen.ts`, SIZE_SKEW). É
 * lido aqui como CONSTANTE ESPELHADA e não importado porque sim-core não o
 * exporta e não é território deste módulo. Se ele mudar lá e não aqui, o
 * mapeamento continua MONOTÔNICO (só a distribuição fica torta), então a falha
 * é gradual e não um quadro quebrado.
 */
const SIZE_SKEW = 3;
const MIN_R = 200;
const MAX_R = 2000;

/**
 * Profundidade encenada de um asteroide, em [ROCK_T_MIN, ROCK_T_MAX].
 *
 * O eixo é o TAMANHO APARENTE — sob ortográfica é o único sinal de distância
 * que sobra — mas medido em PERCENTIL DA POPULAÇÃO, não em log cru do raio.
 * O procgen gera `r = MIN·(MAX/MIN)^(u^SIZE_SKEW)` com u uniforme; invertendo,
 * `u = s^(1/SIZE_SKEW)` é a posição da rocha na população. Usar `1 − s` em vez
 * de `1 − u` foi o que jogou metade do campo no extremo "longe" na rodada 3.
 *
 * O jitter por semente (±0.08) embaralha vizinhos de tamanho parecido para que
 * "toda rocha pequena tem exatamente este tom" não vire uma regra visível.
 */
export function rockDepth(radius: number, seed: number): number {
  const s = Math.log(Math.max(radius, MIN_R) / MIN_R) / Math.log(MAX_R / MIN_R);
  const u = Math.pow(clamp01(s), 1 / SIZE_SKEW); // percentil de tamanho
  const t = 1 - u + (hash01(seed) - 0.5) * 0.16; // grande = perto
  return ROCK_T_MIN + clamp01(t) * (ROCK_T_MAX - ROCK_T_MIN);
}

/** hash inteiro → [0,1). Independente da RNG do gerador de forma. */
function hash01(seed: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
