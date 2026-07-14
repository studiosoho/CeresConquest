# Plano de migração: Phaser 3 → Babylon.js (client-web)

> **Status: ✅ migração concluída** — os 6 marcos abaixo estão implementados,
> validados contra o servidor real e `phaser` foi removido do projeto.
>
> Escopo: apenas `client-web`. `sim-core`, `shared` e `server` permanecem intactos.
> Motivação: melhoria gráfica (glow neon real, linhas antialiasadas com largura estável)
> e adoção de câmera ortográfica 3D como degrau para uma futura migração a Godot.
> Estimativa de esforço: ~150k–300k tokens de trabalho agêntico (~2–4 h de sessão focada).

## Decisões de arquitetura (resolver antes de qualquer renderer)

### 1. Coordenadas — um único módulo de conversão

Phaser é Y-down, Babylon é Y-up. Criar `render/coords.ts` com:

- `toScene(x, y)` → `(x, -y, 0)`
- `toSceneAngle(a)` → `-a`

**Todos** os renderers e o unproject do mouse passam por ele. O plano do jogo vira o
plano XY do Babylon com a câmera olhando ao longo de Z. Sim-core e rede continuam nas
coordenadas atuais — a negação existe só na fronteira de render.

### 2. Câmera ortográfica

Uma `FreeCamera` com `camera.mode = ORTHOGRAPHIC_CAMERA`. Zoom e enquadramento viram
atualização de `orthoLeft/Right/Top/Bottom` a cada frame a partir do tamanho do canvas
e do zoom — substitui `cameras.main.setZoom()` e `centerOn()` (posição da câmera =
posição da nave). O unproject do ponteiro vira aritmética linear com os bounds ortho —
não precisa de `scene.pick`.

### 3. HUD em overlay DOM, não em cena

O `HudRenderer` (painéis, texto, minimap com mask) sai do engine: `<div>` absoluto
sobre o canvas com texto monospace + um `<canvas>` 2D para o minimap (o problema do
geometry mask desaparece — `clip()` ou `border-radius` resolvem). Elimina a segunda
câmera (`uiCam`) e o `cameras.main.ignore()`. É o pedaço que transfere de graça para
o Godot (que teria seu próprio Control/CanvasLayer de qualquer forma).

### 4. Naves como malhas de linha, não texturas

O pipeline `ProceduralGraphics → RenderTexture → sprite` do TextureCache morre. Cada
tipo de nave vira uma malha template `CreateGreasedLine` construída uma vez, clonada
por entidade (clone com material próprio para o tint por dono). `GlowLayer` na cena dá
o halo neon de graça — a margem de textura para o glow não ser cortado deixa de existir.

## Mapeamento arquivo a arquivo

| Arquivo | Mudança |
|---|---|
| `src/main.ts` | Reescrito: `Engine` + `Scene` + resize listener + `runRenderLoop` chamando `gameScene.update(dt)` |
| `src/scenes/GameScene.ts` | Deixa de herdar `Phaser.Scene` (vira classe comum). ~80% intacto. Trocar: `add.container` → `TransformNode`; `input.keyboard.addKeys` → mapa keydown/keyup no DOM; `input.on(wheel/pointer)` → eventos do canvas; `this.time.now` → `performance.now()`; `Phaser.Math.Clamp` → clamp local; `starGfx` → `PointsCloudSystem` ou line system estático por setor |
| `src/shapes.ts`, `src/render/Palette.ts` | **Zero mudança** — geometria e cores puras |
| `src/render/ProceduralGraphics.ts` | Deixa de desenhar em `Graphics`; devolve arrays de pontos (`Vector3[][]`) por tipo de nave, consumidos pelo factory |
| `src/render/TextureCache.ts` | Vira `MeshFactory`: template GreasedLine por `ShipKind`, `clone()` por instância |
| `src/render/ShipRenderer.ts` | Mesma estrutura (Map por id, create/update/remove). `setPosition/setRotation/setTint/setVisible` → `position` (via coords), `rotation.z`, cor do material, `setEnabled()`. `destroy()` → `dispose()` |
| `src/render/AsteroidRenderer.ts`, `PlanetRenderer.ts`, `StructureRenderer.ts` | Polígonos de `Graphics` → malhas GreasedLine construídas uma vez por entidade, só transform por frame |
| `src/render/EffectsRenderer.ts` | Lasers/explosões → pool de GreasedLine updatable (`setPoints`) |
| `src/render/HudRenderer.ts` | Reescrito como overlay DOM + canvas 2D (ver decisão 3) |

## Dependências

```sh
npm remove phaser
npm install @babylonjs/core
```

(Com o PATH prefixado pelo Node 22 portátil.) **Importar por subpath**
(`@babylonjs/core/Meshes/...`) — o barrel puxa o engine inteiro para o bundle.
Não precisa de `@babylonjs/gui` com HUD em DOM.

## Ordem de implementação (marcos verificáveis)

1. **Protótipo de validação** (~1 arquivo): boot + câmera ortho + `coords.ts` + um
   triângulo GreasedLine com GlowLayer, zoom por scroll. Valida Y-flip, zoom e glow —
   as três coisas que mais custam se descobertas erradas depois.
   **✅ Concluído** — `proto.html` + `src/proto/main.ts` + `src/render/coords.ts`
   (definitivo). Y-flip, sentido de rotação, zoom ortho, unproject linear, glow e
   largura estável validados. Descobertas:
   - O construtor do `Engine` **não** sincroniza o drawing buffer com o tamanho CSS
     do canvas — chamar `engine.resize()` uma vez no boot.
   - Glow em GreasedLine exige `glowLayer.referenceMeshToUseItsOwnMaterial(mesh)`.
   - `sizeAttenuation: true` funcionou bem com câmera ortho (largura constante em px
     de tela em todo o range de zoom); o fallback `largura/zoom` também foi
     implementado e alterna em runtime via setter do material (tecla T no proto).
   - Shaders compilam em paralelo (assíncrono): os primeiros ~frames não desenham
     nada — irrelevante no jogo, mas confunde testes automatizados de pixel.
2. **Nave própria voando**: MeshFactory + ShipRenderer + input DOM + câmera seguindo.
   **✅ Concluído** — reescrita in-place: `main.ts` (boot Babylon em index.html),
   `GameScene` como classe comum (~80% intacto de fato: rede, predição e HUD-data
   idênticos), `input.ts` (KeyInput DOM com semântica de consumo do JustDown),
   `ProceduralGraphics` devolvendo pontos puros, `TextureCache` → `MeshFactory`
   (contorno + detalhes por instância, tint via cor do material), `ShipRenderer`
   com a mesma API. Renderers de mundo/efeitos/HUD viraram stubs com as interfaces
   preservadas — marcos 3–5 preenchem. Validado contra o servidor real: input →
   predição → envio 30 Hz → blend autoritativo convergindo a divergência 0, câmera
   colada na nave, zoom por wheel/teclas, 12 naves em cena com tint por dono.
   Descobertas:
   - Naves com `sizeAttenuation` (contorno 2 px, detalhes 1,5 px, cor ×0,62) —
     o `redrawStrokes`/`setStrokeWidth` só sobrevive para os renderers do marco 3
     decidirem; provável remoção.
   - `bringToTop` virou deslocamento em Z (−1 para a nave própria) — profundidade
     resolve ordem de desenho de graça na câmera ortho.
   - Bundle: 370 kB gzip com imports por subpath (GreasedLine+GlowLayer puxam
     StandardMaterial e pós-processos); Phaser já sai por tree-shaking no build.
3. **Mundo**: asteroides, Ceres, estruturas, estrelas.
   **✅ Concluído** — `lineUtils.ts` (novo): helper `createLineBundle` que junta várias
   polilinhas coloridas (cor por ponto via `useColors`) numa única malha GreasedLine —
   1 draw call por "camada" de uma entidade em vez de 1 por traço, essencial com
   ~90–160 asteroides no grid 3×3. `AsteroidRenderer`/`PlanetRenderer`/
   `StructureRenderer` reimplementados de fato (saíram do estado de stub), cada um
   com 2–3 meshes por entidade (contorno, detalhes/crateras, hangar). Estrelas viraram
   `PointsCloudSystem` (gl.POINTS, tamanho constante em px) instanciado em `GameScene`
   diretamente — mesmo padrão determinístico por setor do Phaser original, alpha
   pré-multiplicado na cor (fundo é preto puro, dispensa blending). Janelas/indicadores
   que eram `fillRect`/`fillCircle` (preenchidos) no Phaser viraram contornos finos —
   ajuste deliberado, mais consistente com o resto do jogo (wireframe puro).
   Descobertas:
   - **Remoção confirmada**: `setStrokeWidth`/`invalidateAll`/`redrawStrokes` e o
     gatilho de redesenho por variação de zoom (~8%) no `GameScene.update()` saíram —
     com `sizeAttenuation` em naves, estruturas e asteroides, a largura já é constante
     em pixels de tela; recalcular geometria a cada zoom virou custo sem função.
   - `PointsCloudSystem.buildMeshAsync()` é assíncrono; um token descarta builds
     obsoletos se o jogador trocar de setor de novo antes do anterior terminar.
   - Depuração de câmera: mover `camera.position` manualmente por script só "gruda"
     enquanto o render loop real (`engine.runRenderLoop`) está parado — do contrário
     o próximo frame de verdade recentra a câmera na nave via `GameScene.draw()`
     antes do screenshot. Para inspecionar um ponto arbitrário da cena,
     `engine.stopRenderLoop()` primeiro, mexer na câmera, `scene.render()` manual,
     depois restaurar o loop.
4. **Efeitos**: projéteis, mineração, explosões.
   **✅ Concluído** — `EffectsRenderer` reimplementado com um `LinePool` interno
   (contagem de pontos fixa por slot, sempre) que reaproveita malhas via
   `mesh.setPoints()` em vez de dispose/recriar a cada frame: uma pool por
   categoria de contagem variável (jato, bala, granada), com `begin()`/`next()`/
   `end()` — `end()` só desabilita os slots não usados no frame, não descarta.
   Feixe de mineração, zona de pouso e fronteira viraram singletons: feixe
   atualiza pontos todo frame (posições mudam), zona de pouso só reconstrói
   geometria quando o raio muda (troca de asteroide-alvo) e gira via
   `TransformNode.rotation` (sem repor pontos), fronteira constrói uma vez (raio
   fixo por partida) e só reposiciona. `zoom` saiu da assinatura de
   `drawMiningBeam`/`drawBullet`/`drawGrenade`/`drawLandZone`/`drawBoundary` —
   mesma razão do marco 3 (`sizeAttenuation` já dá largura constante em px).
   Simplificações deliberadas: pulsos de alpha (brilho piscando) do Phaser
   viraram pulsos de raio/geometria ou `setEnabled()` binário — mexer em cor por
   vértice a cada frame custaria uma textura de cor nova a cada chamada.
   Descobertas:
   - Pool por índice de ordem de chamada (sem id estável) é seguro para efeitos
     puramente cosméticos e transitórios (jato, bala, granada) — ao contrário de
     naves/estruturas, um frame ocasional de "slot trocado" é imperceptível.
   - Validado por leitura de pixel (`gl.readPixels`) em vez de screenshot: a
     pane de preview às vezes mostra um recorte em proporção diferente da
     resolução real do canvas (`engine.getRenderWidth/Height`) — não confiar no
     tamanho do screenshot para calcular coordenadas de tela, sempre ler
     `engine.getRenderWidth()/getRenderHeight()` direto.
5. **HUD**: overlay DOM + minimap canvas.
   **✅ Concluído** — `HudRenderer` saiu do engine por completo (decisão 3 do
   plano): um `<div>` (`position:fixed;pointer-events:none`) com o painel de
   status em DOM/CSS (texto via `textContent` + `white-space:pre-line`, barras
   de HP/munição como pares de `<div>` outer/fill reaproveitados entre frames,
   nunca recriados) e um `<canvas>` 2D dedicado só para o minimapa. O painel
   ancora via `left`/`right` em CSS em vez de recalcular a largura a partir de
   `screenW` — por isso `screenW`/`screenH` saíram das assinaturas de
   `drawStatus`/`drawMinimap` (mesmo raciocínio do `zoom` no marco 4) e os `sw`/
   `sh` correspondentes saíram do `GameScene.draw()`. O minimapa ganhou de graça
   o clip que o Phaser resolvia com geometry mask: é só um `<canvas>` do
   tamanho exato do radar, então tudo que sai do retângulo já não é desenhado —
   e as coordenadas ficam relativas ao próprio canvas (`cx=size/2`), sem os
   offsets `x0,y0` que o Phaser precisava por desenhar num Graphics de tela
   cheia. Escala por `devicePixelRatio` aplicada uma vez no canvas do minimapa
   para não borrar em telas HiDPI.
   Descobertas:
   - `engine.getRenderWidth()/getRenderHeight()` retornam o drawing buffer
     (pixels físicos, ajustado por DPR) — errado para posicionar DOM, que vive
     em pixels CSS. Trocado por `canvas.clientWidth/clientHeight` no
     `GameScene.draw()` antes mesmo de existir qualquer HUD para consumir, já
     que os dois só coincidem quando `devicePixelRatio === 1` (verdade no
     ambiente de teste, não necessariamente no de um usuário real).
   - `pointer-events:none` no `<div>` raiz confirmado por
     `document.elementFromPoint` — o wheel de zoom continua chegando no canvas
     mesmo sob a área visual do painel de status.
6. **Limpeza**: remover `phaser` do package.json e qualquer resíduo.
   **✅ Concluído** — `npm remove phaser -w client-web` (saiu de
   `package.json`, `package-lock.json` e `node_modules`); nenhum `import ...
   from "phaser"` restava no código (confirmado por grep antes da remoção —
   os stubs dos marcos 2–5 já tinham eliminado todos). `docs/ARCHITECTURE.md`
   atualizado: as três menções a "Phaser" que descreviam o cliente web como
   estado ATUAL (tabela de decisões, árvore de diretórios, diagrama de
   renderer trocável, invariante de dependências do `sim-core`) viraram
   "Babylon.js" — as menções a "Phaser" que sobram no código (`client-web/src/**`)
   e neste próprio arquivo são histórico intencional ("mesma regra do Phaser
   original" etc.), não resíduo. `TextureCache.ts` (morto desde o marco 2)
   confirmado ausente do disco. Typecheck dos 4 workspaces e `vite build`
   limpos após a remoção; app testado ao vivo (dev server + `proto.html`) sem
   erros de console.
   Descobertas:
   - Nenhuma — a limpeza já tinha sido feita incrementalmente a cada marco
     (stubs sem import, `redrawStrokes`/params de zoom removidos nos
     marcos 3–5); marco 6 foi confirmação, não trabalho novo.

## Pegadinhas conhecidas

- **Largura de linha × zoom**: GreasedLine tem `sizeAttenuation: true` (largura
  constante em pixels de tela) — testar primeiro; se o comportamento com câmera ortho
  não agradar, cair para largura em unidades de mundo compensada por `1/zoom`, que é a
  lógica que o GameScene já tem hoje (`sw = 4/zoom` clampado).
- **Sinal do ângulo**: ao negar Y, o sentido de rotação inverte junto — por isso
  `toSceneAngle` nega o ângulo. Se as naves girarem ao contrário, é isso.
- **Tint por instância**: `InstancedMesh` compartilha material — para cor por dono usar
  `clone()` (naves são poucas; custo irrelevante) ou cores por vértice no GreasedLine.
- **Disciplina de dispose**: todo `remove()` de renderer precisa de `mesh.dispose()`
  (e do material clonado), senão vaza GPU a cada nave que sai.
- **`window.__game`**: trocar o handle de debug por `{ engine, scene }` — o Inspector
  do Babylon (`scene.debugLayer.show()`) substitui a inspeção do Phaser no console.

## Ganho gráfico esperado (ordem de impacto no visual Asteroids)

1. **GlowLayer** — wireframe branco vira neon com halo real, sem gambiarras de textura.
2. **GreasedLine** — linhas antialiasadas com largura estável em qualquer zoom.
3. **Profundidade sutil** — asteroides com rotação 3D leve e paralaxe nas estrelas,
   mantendo a leitura 2D da câmera ortográfica.

## Pós-migração: asteroides 3D com plataforma de construção

O item 3 acima foi além do planejado: `asteroidVerts()` (silhueta 2D em
`shapes.ts`) foi substituído por `render/AsteroidMeshGenerator.ts`, que gera
deterministicamente da `shapeSeed` uma malha 3D facetada (icosfera + ruído
cossenoidal + flat shading) com uma **plataforma retangular** integrada à
geometria — sempre voltada à câmera (azimute livre, inclinação limitada) e
larga o suficiente para o QG. O `AsteroidRenderer` monta por rocha: malha
sólida (material compartilhado + `HemisphericLight` própria — só afeta
materiais standard), contorno da silhueta (fecho convexo da projeção XY,
GreasedLine com glow) e o retângulo da plataforma. `getBuildFace(id)` expõe
root + quadro ortonormal para anexar nós via `parent`.

Decisões e descobertas:
- **Orçamento de profundidade**: a rocha inteira vive em z > 0 (atrás do plano
  de jogo) — naves/estruturas/efeitos em z ≤ 0 continuam por cima sem mudança
  de layer (em câmera orto, z é só ordem de desenho). `camera.maxZ` foi a 4000
  para cobrir o dorso da maior rocha (raio 2000, achatada em z).
- **Invariante de colisão preservada**: silhueta XY máxima = `radius`, como na
  versão 2D.
- **Plataforma encara a câmera**: o servidor posiciona estruturas no CENTRO do
  asteroide girando em sincronia (rotação só em Z); direção 3D irrestrita
  esconderia a plataforma metade das vezes.
- **Silhueta por fecho convexo**, não por binning radial de vértices — o
  binning criava espículas em rochas low-poly (bins vazios).
- **Reuso entre grids 3×3**: ao cruzar setor, 6 dos 9 setores persistem —
  `rebuild()` reusa entradas por id e só reposiciona.
- **Rotação nos 3 eixos**: cada rocha tem velocidade angular POR SEED em X e
  Y (integrada por frame, ±0.11 rad/s, pose inicial espalhada) além do spin
  em Z, que segue contínuo, absoluto e SINCRONIZADO com o servidor (naves
  pousadas giram junto). Rochas ENGAJADAS — hospedeiras de estrutura, alvo de
  pouso em andamento/pousado de qualquer nave, ou alvo da zona de pouso da
  nave própria — têm X/Y decaídos exponencialmente ao plano (caminho curto
  pelo ângulo equivalente, sem desenrolar revoluções) e retomam o tombo ao
  serem liberadas: tombamento fora do plano dessincronizaria o pouso
  servidor-síncrono e viraria a plataforma (com as estruturas parentadas)
  para o lado oculto. A malha é CENTRADA e o root recua em
  z = raioEnvolvente − ROCK_FRONT_REACH: sob qualquer rotação nenhum ponto
  avança além de −300, e naves/efeitos moram numa CAMADA DE VOO à frente
  (`render/layers.ts`, fonte única do orçamento de Z; far plane da câmera em
  5000 cobre o dorso). O contorno-silhueta gira em 3D junto com o corpo —
  em rochas tombadas lê-se como um anel pintado na superfície, aceito.
- **Vite dev**: subpaths NOVOS de `@babylonjs/core` (`Meshes/mesh`,
  `mesh.vertexData`, `Materials/standardMaterial`, `Lights/hemisphericLight`)
  exigem reiniciar o dev server (504 "Outdated Optimize Dep" até reotimizar).

## Pós-migração: naves modulares 3D (módulos do visualizador)

As naves deixaram de ser silhuetas 2D (`ProceduralGraphics.ts` foi removido;
`shapes.shipVerts` segue vivo só para as miniaturas das vagas de hangar no
`StructureRenderer`) e viraram MONTAGENS
DE MÓDULOS 3D COMUNS em `render/ShipMeshGenerator.ts`: cabine, spine
leve/pesada, motores 2×/4×, broca, guindaste, braços mecânicos, asas
armadas, carga, containers, deck e radar — formas e layout capturados do
protótipo de arte `docs/visualizador_de_naves_modulares.html` (números
preservados; chamas de motor ficam com o EffectsRenderer). Cada classe é um
manifesto de montagem (módulos + offsets); classe nova = composição nova.

Pipeline por classe (uma vez, cacheado): montar triângulos no quadro do
protótipo → converter ao quadro de cena (+X nariz, −Z câmera) normalizando
o alcance em planta para o footprint da silhueta antiga (coerente com a
colisão) e ACHATANDO a profundidade para ±2,5 unidades (na câmera orto
top-down a altura não aparece na projeção, só no depth test — o achatamento
mantém a nave dentro da camada de voo de `layers.ts`) → extrair ARESTAS DE
FEIÇÃO (bordas abertas + vincos por ângulo diedro ≥30°, com solda de
vértices por quantização) → SIMPLIFICAÇÃO DE PLANTA. O `MeshFactory`
desenha os segmentos numa única GreasedLine por nave com cor uniforme do
dono — 1 malha, 1 material, 1 draw call e 1 referência de glow por nave
(eram 2 de cada na era 2D); `setTint` é só trocar a cor do material.

Descobertas:
- Wireframe de triângulos + GlowLayer = BORRÃO: renderizar a malha 3D com
  `material.wireframe` satura (diagonais de face + arestas empilhadas +
  bloom aditivo). Duas reduções resolveram: (1) arestas de feição em vez de
  todas as arestas; (2) simplificação de PLANTA — como a câmera é top-down
  FIXA, aresta quase vertical projeta num ponto (descartada) e pares
  topo/fundo projetam no mesmo traço (deduplicados por quantização XY), e o
  corte de comprimento mínimo (~2,2 unidades) poda micro-feições que em
  zoom de jogo viram ruído de glow. Builder: 544 tris → 46 segmentos.
- No shader do GreasedLine, cor uniforme (`GREASED_LINE_HAS_COLOR`) e cores
  por ponto (`useColors`) são mutuamente exclusivas — com cor uniforme o
  tint por dono é um set de `material.color`, sem textura.
- Validação ao vivo com a pane oculta (`document.hidden`): `__game.step()`
  bombeia frames; captura visual por `canvas.toDataURL` postado num
  receptor HTTP efêmero (o sandbox mata listeners de background entre
  turnos — subir o receptor e postar na sequência imediata). As 4 classes
  foram instanciadas lado a lado via `gameScene.meshFactory.createShip`
  direto no console para conferência visual única.

## Pós-migração: estruturas como arquitetura 3D na plataforma

`structureVerts` (silhuetas 2D) morreu; `render/StructureMeshGenerator.ts`
gera arquitetura low-poly por tipo (cúpula com portal e antena; tronco de
pirâmide com hangar e caixas de teto; galpão com torres cilíndricas; silo com
abóbadas quonset) — sólido facetado + wireframe branco + destaques com glow
na cor do dono + quads pretos nas aberturas. As vagas de hangar viram placas
3D com dígitos de 7 segmentos e cantoneiras âmbar nas expandidas.

Decisões e descobertas:
- **Parent de verdade**: o nó da estrutura é filho do root do asteroide,
  posicionado/orientado pelo quadro do `getBuildFace` — sem transform por
  frame no renderer (o `tick` de estruturas foi removido do `GameScene`).
- **Headroom**: prédios se erguem da plataforma em direção à câmera mas nunca
  cruzam z=0 — altura comprimida via `scaling.z` quando a plataforma é rasa;
  o quantil do plano da plataforma subiu de 0.2 para 0.45 pelo mesmo motivo.
- **Dispose sem recursão**: `root.dispose(true)` no AsteroidRenderer — o
  default recursivo destruiria as estruturas parentadas na troca de grid; o
  upsert do frame seguinte reassenta cada estrutura no root novo (validado ao
  vivo com deslocamento de origem de 3 setores).
- Estrutura cujo asteroide está fora do grid 3×3 fica oculta e desanexada
  (não referencia root descartado).
