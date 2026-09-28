/**
 * AsteroidRenderer — asteroides como malhas 3D SÓLIDAS (AsteroidMeshGenerator)
 * com flat shading facetado. Sem NENHUMA linha sobre o corpo.
 *
 * O wireframe de faceta saiu na rodada 2. Ele era lido de fora como "malha
 * crua à mostra": desenhar a aresta de cada faceta destrói justamente o que
 * caracteriza low poly de última geração, que é a faceta CHAPADA lida pela
 * diferença de valor entre vizinhas. Com o rig de luz atual essa diferença
 * existe, então a linha só competia com ela. De quebra, sumiram ~250
 * GreasedLine por frame — o orçamento que paga a luz nova. A identidade
 * vetorial retrô continua inteira onde ela sempre pertenceu: naves, efeitos e
 * HUD.
 *
 * A rocha inteira vive em z > 0 (atrás do plano de jogo): naves, estruturas e
 * efeitos continuam em z ≤ 0 e são desenhados por cima sem mudança de layer.
 * A iluminação vem do rig de Lighting.ts, hoje instanciado pela GameScene
 * (ele precisa do enquadramento ortográfico a cada frame para reposicionar a
 * chave); luzes no Babylon são globais da cena, então quem recebe são TODOS
 * os materiais standard. As GreasedLine do resto do jogo têm shader próprio e
 * seguem imunes a luz.
 *
 * rebuild() reusa as entradas cujos ids persistem entre grids 3×3 (ao cruzar
 * um setor, 6 dos 9 setores são os mesmos — só reposiciona, sem regenerar).
 *
 * RODADA 3: o material deixou de ser UM. O veredito cego foi que "todo
 * asteroide, do canto inferior esquerdo ao canto superior direito, sai no
 * mesmo tan, mesma saturação, mesmo valor de sombra" — e com um único
 * StandardMaterial isso era garantido por construção, nenhum rig de luz
 * poderia consertar. Entrou uma grade de 15 materiais compartilhados (5
 * degraus de perspectiva atmosférica × 3 litologias), com o degrau vindo do
 * TAMANHO da rocha — o único sinal de distância que sobrevive a uma câmera
 * ortográfica.
 *
 * RODADA 5: a grade compartilhada CAIU, e o renderer passou a receber a
 * CÂMERA. O veredito foi que "os asteroides distantes atrás do halo do sol são
 * pintados em azul mais escuro e saturado que o fundo alaranjado daquele
 * quadrante — o mais longe pesa mais que o próximo", ou seja perspectiva
 * atmosférica invertida LOCALMENTE. A causa é que a névoa convergia para um
 * alvo GLOBAL marinho enquanto o céu tem um halo quente ocupando um quadrante:
 * "converge para o céu" só está certo se o céu for lido NO PONTO DA TELA em
 * que a rocha está. Com a câmera em mãos a projeção sai de uma subtração (sob
 * ortográfica a posição de tela É a coordenada XY relativa à câmera) e o alvo
 * vem de `Aerial.hazeField`, a subamostra da própria imagem do céu.
 *
 * O piso de névoa é uniforme de MATERIAL, então névoa local implica material
 * por região. A primeira tentativa foi um material por rocha e ela REPROVOU no
 * orçamento: medido, 155 materiais para 155 malhas custaram +1,84 ms (15,26 →
 * 17,10 ms, 58 fps contra o requisito de 60). O Babylon ordena os opacos por
 * `material.uniqueId`, então material compartilhado por N malhas paga UM bloco
 * de uniformes e material por malha paga N.
 *
 * A GRADE VOLTOU, com um eixo a mais e um a menos:
 *   5 degraus de profundidade × 6 ZONAS DE NÉVOA = 30 materiais no máximo,
 *   criados sob demanda.
 * As zonas não são retângulos de tela: são grupos de COR do próprio céu
 * (k-means na LUT, ver Aerial), o que põe resolução onde o céu varia — o halo
 * — e economiza no campo marinho chapado. A rocha só troca de material quando
 * cruza a fronteira de uma zona, e trocar material é uma atribuição.
 *
 * O eixo que SAIU da grade é a litologia: ela desceu para a COR DE VÉRTICE,
 * junto com o ruído mineral, como um multiplicador `lith / REF_ALBEDO`. O
 * shader multiplica `baseColor.rgb` no resultado inteiro, então a névoa também
 * é tingida pelo mineral da rocha — medido no pior caso (rocha fria e
 * distante, k = 0.43) isso vale 5/255 no azul, abaixo do limiar que a rodada 3
 * já mediu como invisível. Em troca, a grade não multiplica por 3. (Rodada 7:
 * com as litologias separadas em VALOR esse tingimento deixou de ser pequeno,
 * e o desvio passou a ser atenuado por (1 − k) — ver `grainColors`.)
 */

import type { Scene } from "@babylonjs/core/scene";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { GlowLayer } from "@babylonjs/core/Layers/glowLayer";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { asteroidSpinRate, mulberry32 } from "@ceres/shared";
import type { WorldPos } from "@ceres/shared";
import { ROCK_FRONT_REACH } from "./layers";
import { generateAsteroidMesh, type AsteroidBuildFace } from "./AsteroidMeshGenerator";
import { Palette } from "./Palette";
import { aerialDiffuse, hazeAt, hazeField, rockDepth, ROCK_T_MIN, ROCK_T_MAX } from "./Aerial";
import { toScene, toSceneAngle } from "./coords";

/** Dados de um asteroide para o renderer. */
export interface AsteroidRenderData extends WorldPos {
  /** id estável (`sx:sy:i`) — nomeia a malha da instância */
  id: string;
  shapeSeed: number;
  radius: number;
  asteroidClass: "small" | "medium" | "large";
}

// const OUTLINE_PX = 2;
// const PAD_PX = 1.6;
// /** atenuação da cor da plataforma (linha secundária, como as crateras eram) */
// const PAD_DIM = 0.8;
// /** afastamento da linha da plataforma ao longo da normal (evita z-fight) */
// const PAD_LIFT = 3;
/** sal da RNG do tombamento — sequência independente da forma e do spin Z */
const TUMBLE_SEED_XOR = 0x7c3a9e51;
/** velocidade angular máxima em X/Y (rad/s) — mesma ordem do spin Z (0.12) */
const TUMBLE_RATE_MAX = 0.11;
/** taxa do decaimento exponencial dos ângulos X/Y ao travar (≈1 s até ~0) */
const LOCK_DECAY = 3;
/** sal da RNG de litologia e ruído mineral — independente de forma e tombo */
const MATTER_SEED_XOR = 0x1d3f5a97;

/**
 * As três litologias, na ordem de sorteio. Repetir o regolito quente é o
 * peso: ele sai em ~50 % das rochas e continua sendo a identidade do jogo; as
 * outras duas existem para que nenhuma vizinhança do quadro tenha um matiz só.
 */
const LITHOLOGY = [
  Palette.asteroid.fill,
  Palette.asteroid.fillNeutral,
  Palette.asteroid.fill,
  Palette.asteroid.fillCool,
];
/**
 * RODADA 7 — amplitude do ruído mineral POR LITOLOGIA, na ordem de LITHOLOGY.
 * Valor separa as três (ver Palette), TEXTURA termina o serviço: regolito é
 * granulado, basalto um pouco menos, gelo/metal é quase liso. Uma rocha clara
 * e de faceta uniforme lê como gelo; uma escura e granulada, como basalto —
 * sem material novo, é só o multiplicador que `grainColors` já aplica.
 */
const LITH_GRAIN = [1.0, 0.8, 1.0, 0.5];

/**
 * DEGRAUS DE PROFUNDIDADE da grade. Cinco é o número que a rodada 3 já usou e
 * que sobreviveu a dois julgamentos sem ninguém apontar faixa tonal por
 * tamanho — e não sobrevive por sorte: as rochas de um mesmo degrau estão
 * ESPALHADAS pelo quadro (o degrau vem do tamanho, não da posição) e o jitter
 * de ±0.08 que `rockDepth` aplica por semente embaralha as fronteiras, então
 * duas rochas de tamanho vizinho não caem sistematicamente no mesmo degrau.
 */
const ROCK_TIERS = 5;
/**
 * Albedo de REFERÊNCIA da grade: a média das litologias, PONDERADA pelo
 * sorteio (o regolito conta duas vezes). O material carrega `REF·(1−k)` e a
 * cor de vértice carrega `lith/REF`, de modo que o produto devolve o albedo
 * verdadeiro de cada rocha (ver o cabeçalho).
 *
 * RODADA 7: CALCULADA, não escrita. Era a constante 0x6e6860 da rodada 4,
 * quando as três litologias diferiam ±17 %; com a separação de valor a média
 * andou e o hex ficou para trás — e uma referência fora da média é desvio
 * gratuito somado a todas as rochas.
 */
const REF_ALBEDO = (() => {
  const ch = (sh: number) =>
    Math.round(LITHOLOGY.reduce((s, h) => s + ((h >> sh) & 0xff), 0) / LITHOLOGY.length);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
})();

/** degrau de uma profundidade contínua */
const tierOf = (t: number): number => {
  const u = (t - ROCK_T_MIN) / (ROCK_T_MAX - ROCK_T_MIN);
  return Math.min(ROCK_TIERS - 1, Math.max(0, Math.floor(u * ROCK_TIERS)));
};
/** profundidade representativa de um degrau (o meio dele) */
const tierT = (i: number): number =>
  ROCK_T_MIN + ((i + 0.5) / ROCK_TIERS) * (ROCK_T_MAX - ROCK_T_MIN);

/**
 * Amplitude do RUÍDO MINERAL por faceta (fração do albedo). O veredito da
 * rodada 4 foi que "cada asteroide tem exatamente a mesma quebra de dois tons
 * — claro chapado / azul chapado — e leem como facetas coloridas, não como
 * rocha", e a instrumentação explicou por quê: medindo a distribuição de valor
 * PONDERADA PELA ÁREA na tela, as facetas que ocupam área são justamente as
 * viradas para a câmera, todas com `ndl` parecido. A amplitude de `ndl` existe
 * (6–9× entre p10 e p90) mas mora nas facetas rasantes, que quase não têm
 * pixel. Mexer no ângulo da chave não resolve: medido, variar SUN_DEPTH de
 * 0.32 a 0.12 muda a fração iluminada em 5 % e o ângulo do terminador em nada,
 * porque o z próprio das rochas domina a geometria.
 *
 * O que falta não é luz, é MATÉRIA: rocha real não tem albedo uniforme. Um
 * multiplicador por faceta quebra os dois patamares em dezenas de degraus sem
 * tocar em nenhuma luz. Entra por cor de vértice, que o StandardMaterial
 * multiplica em `baseColor.rgb` — os vértices já vêm desagrupados por face do
 * gerador (flat shading), então "por faceta" é literalmente os 3 vértices do
 * triângulo. Custo por frame: zero. Custo de memória: 4 floats por vértice.
 */
const GRAIN = 0.17;
/** parcela do ruído que vai para a TEMPERATURA e não para o valor */
const GRAIN_WARM = 0.4;

/** Tombamento contínuo em X/Y: velocidades por seed + ângulos integrados. */
interface Tumble {
  rateX: number;
  rateY: number;
  angleX: number;
  angleY: number;
}

interface AsteroidEntry {
  root: TransformNode;
  solid: Mesh;
  /** profundidade encenada pelo tamanho (contínua) */
  t: number;
  /** degrau corrente — de `t`, ou o degrau 0 se esta é a rocha em foco */
  tier: number;
  /** zona de névoa em que a rocha estava; −1 = ainda não classificada */
  zone: number;
  buildFace: AsteroidBuildFace;
  spin: number;
  tumble: Tumble;
  /** primeira atualização: se já nascer travado, começa plano (sem pop) */
  fresh: boolean;
}

export class AsteroidRenderer {
  /** posições de render para o minimapa */
  readonly nearbyPositions: Array<{ rx: number; ry: number; asteroidClass: string }> = [];

  private scene: Scene;
  private glow: GlowLayer;
  private camera: Camera;
  private entries = new Map<string, AsteroidEntry>();
  /** grade [degrau][zona], criada sob demanda — ver o cabeçalho */
  private rockMats: Array<Array<StandardMaterial | undefined>> = [];
  /** meia-extensão ortográfica corrente — vem de updateOrtho */
  private halfW = 1;
  private halfH = 1;
  /** rocha que o jogo destacou (zona de pouso); null = nenhuma */
  private focusId: string | null = null;

  constructor(scene: Scene, glow: GlowLayer, camera: Camera) {
    this.scene = scene;
    this.glow = glow;
    this.camera = camera;
  }

  /** Enquadramento ortográfico do frame (chamado por updateOrtho). */
  setFrame(halfW: number, halfH: number): void {
    this.halfW = halfW;
    this.halfH = halfH;
  }

  /**
   * Rocha que o jogo elegeu como alvo (zona de pouso). O veredito foi que "o
   * objeto-alvo só é localizável pelo círculo tracejado amarelo: a arte não o
   * hierarquiza, o HUD faz o trabalho da luz". Um alvo tem que se impor por
   * contraste, então ele é tratado como o objeto MAIS PRÓXIMO do quadro:
   * névoa quase zero, cor local cheia, sombra funda. Não é um destaque
   * arbitrário — é a mesma escada de profundidade, com o alvo no degrau da
   * frente, que é exatamente onde a atenção deve estar.
   */
  setFocus(id: string | null): void {
    if (id === this.focusId) return;
    const prev = this.focusId;
    this.focusId = id;
    for (const key of [prev, id]) {
      if (!key) continue;
      const e = this.entries.get(key);
      if (e) this.applyDepth(e, key);
    }
  }

  /** (Re)classifica uma rocha no degrau de profundidade e reata o material. */
  private applyDepth(e: AsteroidEntry, id: string): void {
    const tier = tierOf(id === this.focusId ? ROCK_T_MIN : e.t);
    if (tier === e.tier) return;
    e.tier = tier;
    if (e.zone >= 0) e.solid.material = this.matFor(tier, e.zone);
  }

  /**
   * Material da célula (degrau, zona) da grade, criado na primeira vez que
   * alguma rocha cai nela. Sob demanda e não em bloco porque nem toda
   * combinação existe: o campo tem os degraus que os tamanhos sorteados
   * produziram e as zonas que a parte VISÍVEL do céu contém.
   */
  private matFor(tier: number, zone: number): StandardMaterial {
    const row = (this.rockMats[tier] ??= []);
    const cached = row[zone];
    if (cached) return cached;

    const t = tierT(tier);
    const mat = new StandardMaterial(`rock_t${tier}_z${zone}`, this.scene);
    // a álgebra da rodada 4, intocada: o objeto DESAPARECE no difuso e a névoa
    // TOMA O LUGAR dele no ambiente. O que mudou é só de onde vem a cor da
    // névoa — da zona, e não mais de um alvo global marinho.
    mat.diffuseColor = aerialDiffuse(REF_ALBEDO, t);
    mat.ambientColor = new Color3(0, 0, 0);
    hazeField.zoneColorTo(zone, mat.ambientColor, hazeAt(t));
    // realce especular em faceta chapada vira um lampejo que denuncia
    // polígono; a estética aqui é valor de faceta, não brilho
    mat.specularColor = Color3.Black();
    // normais do gerador apontam para fora; sem culling não há como errar o
    // winding — as faces do dorso perdem no teste de profundidade
    mat.backFaceCulling = false;
    row[zone] = mat;
    return mat;
  }

  /** Reconstrói/reusa as malhas para o grid 3×3 de setores. */
  rebuild(asteroids: AsteroidRenderData[], toRender: (p: WorldPos) => { x: number; y: number }): void {
    const next = new Map<string, AsteroidEntry>();
    this.nearbyPositions.length = 0;

    for (const a of asteroids) {
      const pos = toRender(a);
      let entry = this.entries.get(a.id);
      if (entry) {
        // mesmo asteroide, possivelmente nova origem flutuante: só reposiciona
        this.entries.delete(a.id);
        const p = toScene(pos.x, pos.y);
        entry.root.position.x = p.x;
        entry.root.position.y = p.y;
      } else {
        entry = this.buildEntry(a, pos);
      }
      next.set(a.id, entry);
      this.nearbyPositions.push({ rx: pos.x, ry: pos.y, asteroidClass: a.asteroidClass });
    }

    for (const e of this.entries.values()) this.disposeEntry(e);
    this.entries = next;
  }

  /**
   * Rotação nos 3 eixos a cada frame (tt = tempo absoluto em segundos, dt =
   * passo do frame):
   * - Z: spin contínuo, SINCRONIZADO com o servidor (naves pousadas e
   *   estruturas giram junto) — ângulo absoluto, intocável;
   * - X/Y: velocidade angular contínua por seed, INTEGRADA por frame. Rochas
   *   em `locked` (com estrutura, pouso em andamento/pousado, ou alvo da
   *   zona de pouso) têm os ângulos X/Y decaídos suavemente a zero — o
   *   tombamento fora do plano dessincronizaria o pouso servidor-síncrono e
   *   viraria a plataforma (com as estruturas parentadas) para o lado oculto.
   *   Ao liberar, o tombo retoma de onde o decaimento deixou, sem pop.
   * O Euler do Babylon compõe Y·X·Z (Z primeiro): o spin do plano do jogo
   * roda primeiro e o tombo inclina o conjunto por cima, em eixos do mundo —
   * a projeção XY continua girando rigidamente com o servidor.
   */
  tick(tt: number, dt: number, locked: ReadonlySet<string>): void {
    for (const [id, e] of this.entries) {
      const t = e.tumble;
      if (locked.has(id)) {
        if (e.fresh) {
          t.angleX = 0;
          t.angleY = 0;
        } else {
          // decai o ângulo EQUIVALENTE (-π..π]: volta ao plano pelo caminho
          // curto, sem desenrolar revoluções acumuladas
          const k = Math.min(1, dt * LOCK_DECAY);
          t.angleX = wrapAngle(t.angleX) * (1 - k);
          t.angleY = wrapAngle(t.angleY) * (1 - k);
        }
      } else {
        t.angleX += t.rateX * dt;
        t.angleY += t.rateY * dt;
      }
      e.fresh = false;
      const r = e.root.rotation;
      r.x = t.angleX;
      r.y = t.angleY;
      r.z = toSceneAngle(e.spin * tt);

      this.updateZone(e);
    }
  }

  /**
   * Reclassifica a rocha na zona de névoa do ponto da TELA onde ela está.
   *
   * Sob ortográfica a posição de tela é a própria coordenada XY relativa à
   * câmera, então o UV sai de uma subtração e duas divisões, e a zona é uma
   * indexação em tabela. O caso comum de um frame é NADA acontecer: só quando
   * a rocha cruza a fronteira de uma zona é que o material é reatado, e reatar
   * material é uma atribuição — nenhuma escrita de uniforme, nenhuma alocação.
   */
  private updateZone(e: AsteroidEntry): void {
    const u = 0.5 + (e.root.position.x - this.camera.position.x) / (2 * this.halfW);
    const v = 0.5 - (e.root.position.y - this.camera.position.y) / (2 * this.halfH);
    const zone = hazeField.zoneOf(u, v);
    if (zone === e.zone) return;
    e.zone = zone;
    e.solid.material = this.matFor(e.tier, zone);
  }

  /**
   * Plataforma de construção de um asteroide em cena (quadro local + root).
   * Anexar qualquer nó é `node.parent = root` + transformar pelo buildFace —
   * o spin do asteroide passa a valer de graça para o nó anexado.
   */
  getBuildFace(id: string): { root: TransformNode; face: AsteroidBuildFace } | null {
    const entry = this.entries.get(id);
    return entry ? { root: entry.root, face: entry.buildFace } : null;
  }

  destroy(): void {
    for (const e of this.entries.values()) this.disposeEntry(e);
    this.entries.clear();
    this.nearbyPositions.length = 0;
    for (const row of this.rockMats) for (const m of row) m?.dispose();
    this.rockMats.length = 0;
  }

  private buildEntry(a: AsteroidRenderData, pos: { x: number; y: number }): AsteroidEntry {
    const data = generateAsteroidMesh(a.shapeSeed, a.radius, a.asteroidClass);

    const root = new TransformNode(`ast_${a.id}`, this.scene);
    const scenePos = toScene(pos.x, pos.y);
    root.position.x = scenePos.x;
    root.position.y = scenePos.y;

    // MATÉRIA da rocha: litologia e ruído mineral saem da MESMA sequência,
    // salgada em separado da forma e do tombo — trocar a amplitude do ruído
    // não pode remexer a silhueta de nenhuma rocha já aprovada no quadro.
    const mrng = mulberry32((a.shapeSeed ^ MATTER_SEED_XOR) >>> 0);
    const li = (mrng() * LITHOLOGY.length) | 0;
    const t = rockDepth(a.radius, a.shapeSeed);

    // corpo sólido facetado. A cor de vértice carrega DUAS coisas: o desvio da
    // litologia sorteada em relação ao albedo de referência da grade, e o
    // ruído mineral por faceta.
    const solid = new Mesh(`ast_${a.id}_rock`, this.scene);
    const vd = new VertexData();
    vd.positions = flatten3(data.vertices);
    vd.normals = flatten3(data.normals);
    vd.indices = data.triangles;
    // k do DEGRAU (o mesmo que o material da grade usa), não o t contínuo
    vd.colors = grainColors(
      data.vertices.length, mrng, LITHOLOGY[li], LITH_GRAIN[li], hazeAt(tierT(tierOf(t))),
    );
    vd.applyToMesh(solid);
    solid.isPickable = false;
    solid.parent = root;
    // ORÇAMENTO: fora do GlowLayer. O EffectLayer não pergunta se o material
    // tem emissivo — `_shouldRenderMesh` devolve só `hasMesh()`, então TODA
    // malha ativa era desenhada no mapa de glow, e ~160 rochas de emissivo
    // preto pagavam um draw call por frame para escrever preto. Excluí-las é
    // a maior economia disponível aqui e não muda um pixel: nada que brilhe
    // fica ATRÁS de uma rocha (naves e efeitos vivem em z ≤ −318, rochas em
    // z ≥ 700), então não há oclusão de glow a preservar.
    this.glow.addExcludedMesh(solid);

    // quadro da plataforma de construção (as estruturas se parenteiam nele);
    // já não é desenhado — nem contorno, nem retângulo, nem wireframe. A rocha
    // é só o sólido facetado, e é a luz que a descreve.
    const f = data.buildFace;

    // recuo do orçamento de profundidade: sob QUALQUER rotação, nenhum ponto
    // da rocha avança além de −ROCK_FRONT_REACH (ver layers.ts)
    root.position.z = data.boundingRadius - ROCK_FRONT_REACH;

    // velocidades angulares por seed (sinal e módulo por eixo); ângulos
    // iniciais espalhados — cada rocha entra em cena numa pose própria
    const trng = mulberry32((a.shapeSeed ^ TUMBLE_SEED_XOR) >>> 0);
    const rate = () => (trng() * 2 - 1) * TUMBLE_RATE_MAX;
    const tumble: Tumble = {
      rateX: rate(),
      rateY: rate(),
      angleX: trng() * Math.PI * 2,
      angleY: trng() * Math.PI * 2,
    };

    const entry: AsteroidEntry = {
      root, solid, t, tier: tierOf(t), zone: -1, buildFace: f,
      spin: asteroidSpinRate(a.shapeSeed), tumble, fresh: true,
    };
    // uma rocha pode NASCER em foco (o grid 3×3 é reconstruído com a zona de
    // pouso já escolhida) — sem isto ela entraria em cena no degrau errado e
    // só pularia para o da frente na próxima troca de alvo
    if (a.id === this.focusId) this.applyDepth(entry, a.id);
    // classifica a zona AGORA e não no primeiro tick: a malha precisa nascer
    // com material, senão o frame em que ela entra a desenha com o material
    // padrão do Babylon (branco liso) e o campo pisca a cada troca de setor
    this.updateZone(entry);
    return entry;
  }

  private disposeEntry(e: AsteroidEntry): void {
    // tira da lista de exclusão do glow: ela guarda uniqueId e cresceria sem
    // limite conforme o jogador atravessa setores
    this.glow.removeExcludedMesh(e.solid);
    e.solid.dispose(false, false); // material é da GRADE — não descartar aqui
    // doNotRecurse: ESTRUTURAS são parentadas a este root pelo
    // StructureRenderer — elas sobrevivem à troca de grid e se reassentam
    // no root novo no upsert do frame seguinte
    e.root.dispose(true);
  }
}

/**
 * COR DE VÉRTICE = litologia da rocha × ruído mineral da faceta.
 *
 * O canal existe porque a grade de materiais tem orçamento apertado (ver o
 * cabeçalho) e porque o StandardMaterial multiplica `baseColor.rgb` no
 * resultado inteiro: qualquer variação PURAMENTE MULTIPLICATIVA sai daqui de
 * graça, sem um material a mais e sem uma escrita de uniforme por frame.
 *
 * 1) LITOLOGIA, como desvio `lith / REF_ALBEDO`. O material carrega a média
 *    das três; esta razão devolve a verdadeira.
 *
 *    RODADA 7 — O DESVIO É ATENUADO PELA NÉVOA: `1 + (lith/REF − 1)·(1 − k)`.
 *    Com a separação de valor a razão passou a ir de 0.63 (basalto, vermelho)
 *    a 1.60 (gelo, azul), e o shader multiplica a cor de vértice também sobre
 *    `vAmbientColor` — a NÉVOA. Sem atenuar, a névoa de uma rocha distante de
 *    basalto sairia 37 % mais escura que a zona do céu atrás dela e a de gelo
 *    60 % mais azul: cada litologia convergiria para um céu diferente, que é a
 *    quebra da regra "névoa converge para o valor do céu". Atenuado, o erro na
 *    névoa vale `k·(1−k)·desvio`: ≤ 0.24 do desvio no degrau mais longe das
 *    rochas (k = 0.42), ou seja ≤ 9 % no basalto e ≤ 14 % no azul do gelo — e o
 *    azul é a direção do próprio céu. Exato só com plugin de shader; a
 *    aproximação é também a física certa: litologia é contraste LOCAL, e
 *    contraste é a primeira coisa que o ar come.
 *
 * 2) RUÍDO MINERAL por faceta. Ver a nota de GRAIN: é a resposta ao "cada
 *    asteroide tem exatamente a mesma quebra de dois tons". Valor e
 *    temperatura saem de DOIS sorteios independentes, e é isso que o separa de
 *    um simples ganho de brilho — se a temperatura viesse do mesmo número,
 *    faceta clara seria sempre a mais quente e o resultado seria a rampa da
 *    chave repetida com outro nome. Independentes, aparecem facetas claras e
 *    frias (quartzo, gelo) e escuras e quentes (regolito), que é o que faz uma
 *    superfície ler como MATÉRIA e não como poliedro pintado.
 *
 * Os vértices vêm desagrupados por face do gerador (3 consecutivos por
 * triângulo), então o laço anda de 3 em 3 e escreve o mesmo valor nos três —
 * o interpolador devolve a constante e a faceta sai chapada, que é a estética.
 * Alfa fixo em 1 de propósito: `VertexData.hasVertexAlpha` fica como está
 * (falso) e a malha continua no passe OPACO; qualquer alfa aqui a jogaria no
 * passe transparente, com ordenação por distância e sem escrita de
 * profundidade — 250 rochas a mais no caminho errado do renderer.
 */
function grainColors(
  vertexCount: number,
  rng: () => number,
  lith: number,
  grain: number,
  k: number,
): number[] {
  const out = new Array<number>(vertexCount * 4);
  const ampV = GRAIN * grain * (1 - GRAIN_WARM);
  const ampT = GRAIN * grain * GRAIN_WARM;
  const dev = (sh: number) =>
    1 + (((lith >> sh) & 0xff) / ((REF_ALBEDO >> sh) & 0xff) - 1) * (1 - k);
  const lr = dev(16);
  const lg = dev(8);
  const lb = dev(0);
  for (let v = 0; v < vertexCount; v += 3) {
    const nv = (rng() * 2 - 1) * ampV; // valor
    const nt = (rng() * 2 - 1) * ampT; // temperatura (+quente / −frio)
    const r = lr * (1 + nv + nt);
    const g = lg * (1 + nv);
    const b = lb * (1 + nv - nt);
    for (let k = 0; k < 3 && v + k < vertexCount; k++) {
      const o = (v + k) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 1;
    }
  }
  return out;
}

const flatten3 = (vs: Vector3[]): number[] => {
  const out = new Array<number>(vs.length * 3);
  for (let i = 0; i < vs.length; i++) {
    out[i * 3] = vs[i].x;
    out[i * 3 + 1] = vs[i].y;
    out[i * 3 + 2] = vs[i].z;
  }
  return out;
};

/** normaliza um ângulo para (-π, π] */
const wrapAngle = (a: number): number => {
  const w = (a + Math.PI) % (Math.PI * 2);
  return (w < 0 ? w + Math.PI * 2 : w) - Math.PI;
};
