# CeresConquest — Documento de Arquitetura

> Versão 0.3 — 2026-10-04
> Status: protótipo jogável — partida completa com economia, combate, minhocas
> de Ceres, jogadores-bot e modos de vitória (fases 1–3; fase 4 em aberto)

## 1. Visão geral do jogo

RTS espacial multiplayer ambientado no cinturão de asteroides, onde se encontra Ceres.
Jogadores colonizam asteroides, constroem estruturas, formam equipes e disputam a
conquista de Ceres, que abriga em seu núcleo uma grande fonte de um mineral valioso.

Características que definem a arquitetura:

- O jogador **pilota uma única unidade por vez** (nave), trocando de nave pelos
  hangares. Não há comando de enxames.
- Unidades autônomas: a **economia** (aranhas de mineração, transportes em rota
  automática, táxi de frota, drones de ração), a **frota neutra de Ceres**
  (bots que atacam todos), as **minhocas gigantes** do núcleo de Ceres e os
  **jogadores-bot** (pilotam só o builder; as naves de ataque deles agem sozinhas).
- Ritmo **rápido** (tempo real, resposta imediata ao pilotar).
- Número de unidades **escala sem teto fixo**; o teto prático vem do tempo de partida.
- Dois modos: **partida com início/fim** (implementado, com três modos de
  vitória) e **universo persistente com save** (fase 4).
- Jogadores por sessão: **configurável no servidor** (protótipo: 10).
- Mapa em **escala 1:10 do sistema solar real**; gameplay concentrado no cinturão.
- Arte **low poly facetada** em Babylon.js, com vista de cima e **vista de
  cockpit** em primeira pessoa (com painel de radar, carga e refino).
- Protótipo **web** com simulação planar; o eixo Z é apresentação (camadas de
  voo, profundidade das rochas, minhocas subindo e mergulhando).

## 2. Decisões de arquitetura (resumo)

| # | Decisão | Escolha | Alternativa rejeitada e motivo |
|---|---------|---------|--------------------------------|
| 1 | Netcode | **State sync com servidor autoritativo** | Lockstep determinístico — inviável para persistência/save e para determinismo cross-platform (JS × C#) |
| 2 | Stack do protótipo | **Node + Colyseus (servidor), Babylon.js + TS (cliente web)** | Engines visuais — menor afinidade com desenvolvimento code-first |
| 3 | Cliente final desktop | **Godot 4 consumindo o MESMO servidor** (SDK colyseus-godot) | Reescrever backend — desnecessário; servidor não conhece engine de cliente |
| 4 | Simulação | **Planar (2D), `sim-core` puro sem engine/rede** | Gameplay volumétrico 3D — divergiria web × desktop |
| 5 | 3D no desktop | **Apenas apresentação** (renderer trocável) | 3D de gameplay — quebraria o reuso do sim-core |
| 6 | Coordenadas | **Setor (int64) + posição local (float)** | Float global — imprecisão catastrófica na escala 1:10 |
| 7 | Mundo | **Procgen determinística por semente, por quadrante/setor** | Mundo armazenado — inviável no tamanho do mapa |
| 8 | Persistência | **Semente + deltas** (só o que jogadores mudaram) | Snapshot completo — caro e desnecessário |
| 9 | Banda | **Interest management por setor** | Broadcast global — não escala com entidades "infinitas" |
| 10 | Planetas/Sol | **Decorativos, calculados no cliente por tempo** (banda zero) | Sincronizar corpos celestes — desperdício |
| 11 | Spawn | **Estratégia plugável configurável** (`neighboring` → `random`) | Hardcode — sem custo tornar configurável desde já |
| 12 | Arte | **Geometria vetorial derivada de semente, gerada no cliente** | Sprites — não migram para 3D; wireframe migra |

## 3. Estrutura do repositório

```
CeresConquest/
├── docs/           # este documento e futuros ADRs/design docs
├── shared/         # contrato do protocolo + tipos (neutro; consumível pelo cliente desktop)
├── sim-core/       # simulação pura do jogo — SEM engine, SEM Colyseus, SEM I/O
├── server/         # Colyseus: sala da partida, bots, jogadores-bot, minhocas, ciclo de vida
└── client-web/     # Babylon.js + TypeScript: lobby, vista de cima, cockpit, HUD, som 8 bits
```

### 3.1 Rodando localmente

Node 22. Em terminais separados:

```bash
cd server && npm run dev        # Colyseus em ws://localhost:2567
cd client-web && npm run dev    # Vite em http://localhost:5173
```

Abrir `http://localhost:5173/?server=ws://localhost:2567`. Parâmetros de teste
na URL: `&playerBots=N` (jogadores-bot na sala criada), `&testSpeed=4`
(mineração, broca e refino acelerados) e `&fov=110` (FOV horizontal do cockpit).
Testes: `npx vitest run` em `sim-core/`, `server/` e `client-web/`.

Regras de dependência (estritas, verificáveis por lint):

```
server     ──► sim-core ──► shared
client-web ──► sim-core ──► shared
```

- `sim-core` e `shared` **nunca** importam de `server` ou `client-*`.
- `sim-core` não importa nada de rede, engine ou filesystem. É uma função pura:
  `(estado, comandos, dt) → novo estado + eventos`. Testável isolada.
- O cliente **também** roda o `sim-core` (predição local da nave própria e
  procgen determinística de asteroides) — o servidor permanece a autoridade;
  o cliente apenas prediz e é corrigido.
- O cliente desktop (futuro `client-desktop/` em Godot) consome o protocolo
  definido em `shared/` e porta o subconjunto determinístico do `sim-core`
  necessário para predição/procgen (kinemática da nave, RNG, procgen).

## 4. Netcode

### 4.1 Modelo

**Servidor autoritativo + state sync** via Colyseus (`@colyseus/schema` para
delta-encoding automático do estado). O cliente **nunca** decide estado de jogo;
envia apenas *intents* (input de pilotagem, ordens de construção).

- **Nave do próprio jogador:** client-side prediction + reconciliação com o
  servidor (necessário pelo ritmo rápido de pilotagem).
- **Entidades remotas:** interpolação entre snapshots.
- **Economia autônoma** (mineração, manutenção, scouts): roda exclusivamente no
  servidor dentro do tick do `sim-core`; clientes só observam.

### 4.2 Transporte

WebSocket (padrão Colyseus) para web **e** desktop. A camada de transporte fica
isolada atrás de interface; se o desktop um dia exigir UDP, troca-se só essa
camada, sem tocar em lógica. Para o perfil do jogo (1 nave/jogador + economia
lenta), WebSocket atende.

### 4.3 Interest management

O servidor envia a cada cliente apenas as entidades dos **setores próximos** à
sua nave e ao seu território (área de interesse por grid de setores — o mesmo
grid da procgen, ver §5). Perfil de tráfego favorável:

| Categoria | Frequência de update | Exemplos |
|-----------|----------------------|----------|
| Alta | por tick | nave pilotada de cada jogador; projéteis (mísseis, laser, minas); minhocas |
| Baixa | por evento/segundos | naves autônomas (táxi, aranhas), cargas, produção |
| Estática | on-change | estações, QG, centros de distribuição |
| Zero (não sincronizada) | — | asteroides intactos (procgen), planetas/Sol (função do tempo) |

## 5. Mundo e coordenadas

### 5.1 Escala e precisão

Mapa em escala 1:10 do sistema solar (~450 milhões de km de raio útil). Float32
global é inviável nessa escala. Sistema adotado:

```
posição = setor(x, y : int64) + local(x, y : float64 no servidor / float no render)
```

- O mundo é uma grade de **setores** de tamanho fixo (constante em `shared/`,
  a calibrar; ordem de grandeza: dezenas de milhares de km por setor).
- Coordenadas locais permanecem pequenas → física estável e idêntica entre
  plataformas.
- Operações entre setores (distância, transição de borda) vivem em `shared/`
  como utilitário único usado por servidor e clientes.

O grid de setores cumpre **três papéis** com um só conceito: unidade de procgen,
unidade de interest management e unidade futura de sharding.

### 5.2 Geração procedural

- Conteúdo de um setor = `f(seedDoMundo, setorX, setorY)` — **determinística,
  nunca armazenada**. Gerada sob demanda quando um jogador se aproxima;
  descartável da memória quando ninguém observa.
- **Densidade por região:** denso no anel do cinturão (raio interno/externo
  definidos em `shared/`), esparso/vazio fora. A massa de asteroides é
  deliberadamente maior que a real para permitir saltos entre asteroides.
- Ceres tem posição fixa e especial no cinturão (objetivo do jogo).

### 5.3 Persistência (modo universo persistente)

```
estado_do_mundo = semente + deltas
```

Persiste-se apenas o que divergiu da procgen: estruturas construídas,
asteroides minerados/exauridos, território, inventários, posições de jogadores.
Asteroides intocados não ocupam um byte de banco.

### 5.4 Corpos celestes decorativos

Planetas, Sol e órbitas são **apresentação**: posição = função determinística do
tempo de jogo (época compartilhada na config da sessão). Calculados localmente
em cada cliente; cores fortes, tamanho aumentado e órbitas visíveis, conforme
direção de arte do protótipo. Banda de rede: zero.

## 6. Modos de jogo

Ambos os modos usam **o mesmo `sim-core` e o mesmo servidor**; muda apenas o
ciclo de vida da sala e a camada de persistência.

| | Partida (início/fim) | Universo persistente |
|---|---|---|
| Sala | efêmera | contínua, apoiada em banco |
| Estado ao fim | descartado (placar opcional) | salvo (semente + deltas) |
| Teto de crescimento | tempo de partida | operacional (custo de servidor) |
| Protótipo | **fase 1** | fase posterior |

Escala futura do modo persistente (sharding por região do cinturão, um processo
por zona) é **habilitada** pelo grid de setores, mas **não implementada** no
protótipo — 10 jogadores rodam em um único processo Colyseus.

## 7. Configuração de sessão

Definida ao criar a sala; exemplo do protótipo:

```jsonc
{
  "maxPlayers": 10,
  "mode": "match",              // "match" | "persistent"
  "matchDurationMin": 60,        // só em mode=match
  "worldSeed": "auto",           // ou fixa, para reprodutibilidade
  "spawn": {
    "strategy": "neighboring",  // "neighboring" | "scattered" | "random"
    "minDistanceKm": 500,
    "maxDistanceKm": 2000,
    "keepTeamsTogether": true,
    "beltOnly": true
  }
}
```

Estratégias de spawn são plugáveis (`SpawnStrategy` em `server/`): recebem a
config e o grid, devolvem coordenadas. `neighboring` posiciona jogadores em
quadrantes adjacentes (protótipo); `scattered`/`random` entram depois sem
refatoração.

O bloco acima é a intenção de longo prazo. No protótipo, as opções da sala
(`MatchOptions` em `server/src/rooms/MatchRoom.ts`) vêm da janela **Criar sala**
do lobby:

| Opção | Efeito |
|-------|--------|
| `title` | nome da sala no lobby |
| `testSpeed` | velocidade do jogo: 1×, 2× ou 4× (mineração, broca e refino) |
| `playerBots` | quantos jogadores-bot entram ao criar a sala |
| `victory` | `worms` (mais minhocas mortas no tempo), `lastStand` (último de pé, sem tempo) ou `score` (maior pontuação no tempo) — `shared/src/match.ts` |
| `timeLimit` | tempo-limite em minutos dos modos com tempo (10–45) |
| `spectate` | quem cria a sala entra **assistindo** e começa a jogar com **[R]** |

"Jogar já" cria uma sala `lastStand` sem jogadores-bot. A pontuação
(`SCORE_POINTS`) conta kits refinados, turretas, naves produzidas, ruínas
tomadas, naves e estruturas inimigas destruídas e minhocas mortas.

## 8. Entidades de gameplay

| Entidade | Controle | Notas |
|----------|----------|-------|
| Nave builder | pilotável pelo jogador | constrói QG (250 kits), estação de mineração (150) e centro de rações (100); minera ao pousar em asteroide vazio ou atracado na estação ([ESP]); **refina** minério em kits a bordo (50 → 10, [E] liga/desliga o refino automático); conserta estruturas próprias e toma ruínas ([G]); constrói turretas ([B]); evolui estação e drones ([U]); porão de minério, kits (até 250, em placas) e rações ([J]); vaga expandida |
| Nave de ataque | pilotável pelo jogador | mísseis, laser duplo e minas ([1]/[2]/[3]); **modo ataque** sobre uma estação ([F]); vaga normal |
| Nave de mineração | pilotável pelo jogador | minera ao pousar; na estação vira **aranha** (mineração automática); vaga expandida |
| Nave de transporte | pilotável ou em rota automática | leva minério da estação à base e rações da base às estruturas; **pousa** na origem e no destino, com 15 s de carga/descarga; vaga normal |
| Estação de mineração | autônoma (economia) | construída em asteroide (ou numa plataforma de Ceres); hangares; aranhas; níveis (o nível 2 em Ceres acorda o ninho das minhocas) |
| Centro de distribuição de rações | autônomo (economia) | lança drones de ração em linha reta até as estruturas próximas; recebe rações do builder ([J]) |
| Base inicial | estática | concedida no asteroide mais próximo do spawn; recebe rações da Terra e credita o minério entregue |
| Quartel-general | estático | fabrica todas as naves; hangar; **conserta** as naves próprias pousadas ou guardadas (5 HP/s) |
| Turreta | autônoma | construída pelo builder numa estrutura própria; atira em naves inimigas e nas minhocas |
| Ruína | estática | o que sobra das estruturas de um jogador eliminado; sem energia; o builder a toma com [G] gastando kits do porão |
| Frota de Ceres | bots neutros | QG em Ceres; naves de ataque que atacam todos os jogadores e caçam as minhocas |
| Minhoca gigante | autônoma | sai do ninho no núcleo de Ceres (§8.4) |
| Asteroide | procgen | minerável, colonizável; estado só persiste se alterado |
| Ceres | fixo | objetivo de conquista; plataformas para colônias de jogadores; ninho das minhocas no núcleo |

Equipes: jogadores podem se aliar; `keepTeamsTogether` afeta spawn; regras de
vitória em equipe são design de jogo (fase posterior a este documento).

No `sim-core`, entidades carregam apenas dados de gameplay (posição, raio de
colisão, tipo, dono, HP, carga). **Nenhuma geometria de renderização** vive na
simulação ou trafega pela rede.

### 8.1 Economia física (logística)

O minério **não** credita a carteira no local de mineração. O fluxo é físico e
depende de transporte, o que dá papel real às estruturas e às naves de carga:

```
mineração (aranhas/builder) → oreStore LOCAL da estação
oreStore → nave de transporte (cap TRANSPORT_CARGO_CAP)
transporte → descarrega na base inicial → credita a carteira ("envio à Terra")
```

Rações fluem no sentido inverso, alimentando o interior do cinturão:

```
Terra → base inicial (BASE_RATION_INCOME contínuo, até RATION_STORE_CAP)
base → transporte OU drones do centro de distribuição
→ rationStore das estruturas próprias no alcance
```

Estados sincronizados que sustentam o loop: `oreStore`/`rationStore` por
estrutura e `cargoKind`/`cargoAmount` por nave. O comando de carga/descarga
(`MSG_CARGO`) é sem payload — o **contexto** (classe da estrutura ancorada e o
que está no porão) decide a operação. Os drones de ração são lançados pelo
servidor em linha reta sem colisão; não são naves com IA.

Os **kits de construção** saem do minério: o builder refina a bordo
(`REFINE_ORE` 50 → `REFINE_KITS` 10, em lotes; [E] liga o refino automático,
lote após lote). Kits pagam estruturas, turretas, evoluções, consertos ([G]) e
a tomada de ruínas.

> **Consumo de rações** (estação/QG "necessitam ração para funcionar") e a
> **conquista de colônias em Ceres** ainda são intenção de design — os estados
> existem, mas nenhuma regra os consome. A derrota hoje é perder as estruturas
> (modo `lastStand`) ou o placar no fim do tempo (§7).

### 8.2 Combate

A nave de ataque tem **mísseis** (guiados ao alvo focado), **laser duplo** e
**minas**, sincronizados como entidades próprias (mapa `projectiles`). HP,
munição e cooldowns vivem no `sim-core`; a autoridade de colisão e destruição é
do servidor. Ao destruir a nave ativa de um jogador, o controle é transferido
para outra nave da frota (mesma lógica de `onLeave`/táxi); sem estruturas, o
jogador é eliminado e assiste como espectador ([V] vista, [F] camada, [R]
recomeça).

### 8.3 Camadas de voo

A simulação é planar, mas cada nave está numa **camada** (`shared/layers.ts`),
trocada com [F] numa transição de `LAYER_TRANSITION_TIME`:

- **cruzeiro** — por cima das rochas; o voo normal entre asteroides;
- **superfície** — rente às rochas, para pousar e atracar;
- **modo ataque** — sobre uma estação inimiga, no nível dela.

O combate só acontece entre quem está no mesmo nível (`server/src/combat.ts`:
`hittableLevel`): naves em cruzeiro atingem naves em cruzeiro; estruturas,
naves pousadas e em modo ataque estão no nível da superfície. No cockpit, o
olho sobe com a nave em cruzeiro e as naves em cruzeiro aparecem na linha do
horizonte.

### 8.4 Minhocas de Ceres

O núcleo de Ceres é um **ninho** (`shared/worms.ts`, `server/src/worms.ts`,
`MatchRoom.stepWorm`):

- Evoluir uma estação de mineração **em Ceres** ao nível 2 acorda o ninho:
  alertas de tremor aos 40 s e 60 s; aos 70 s a cratera rompe, destrói a
  estação e o hangar, e a primeira minhoca sai. O buraco vira a **toca**.
- A minhoca faz **rondas** (150 s): caça estruturas e naves ao alcance do faro
  e, sem presa, faz excursões da borda de Ceres às rochas próximas, voltando
  pelo mesmo caminho. Fim da ronda: volta à toca e descansa 50 s.
- **Duas camadas.** Ela navega no **fundo**, na profundidade do centro dos
  asteroides: entra pela lateral da rocha e a atravessa pelo miolo. Ali ela
  alcança o nível das estruturas. Perto do **centro de uma rocha** ela decide:
  seguir para a estação ou sair na **diagonal**, subindo ao **cruzeiro**, atrás
  das naves de ataque que voam por perto (`WORM_CHASE_*`; certeza se uma delas
  a feriu). No cruzeiro persegue por até 20 s e depois **mergulha** de volta.
- **Investidas:** numa estrutura ela passa **raspando** pela lateral
  (`WORM_RAM_DAMAGE`, sorteado entre o prédio e o hangar), afasta-se, dá a volta
  e investe de novo durante o cerco; 1 em 10 investidas é **crítica**: vai no
  centro e destrói a estrutura inteira.
- A cabeça **engole** a nave inteira; o corpo exposto fere quem bate nele. Quem
  a fere (nave ou turreta) vira o alvo.
- Ela morre com dano (`WORM_HP`). A toca é **tapada** com 3 minas jogadas no
  buraco e detonadas por mísseis focados nelas ([F] no buraco).

### 8.5 Jogadores-bot e frota de Ceres

- **Jogador-bot** (`server/src/playerBot.ts`): um jogador de verdade da sala
  que pilota **só o builder** — expande bases (inclusive em Ceres), minera,
  refina, constrói turretas, evolui estação e drones, conserta, transforma naves
  de mineração em aranhas e põe transportes na rota.
- **Ala de ataque** (`AttackWing`): as naves de ataque do jogador-bot agem
  sozinhas. Prioridades: defender as próprias estruturas das naves inimigas →
  caçar a minhoca e tapar a toca → atacar a estrutura ou nave inimiga mais
  próxima. Jogadores-bot se enfrentam entre si e contra os humanos.
- **Frota de Ceres** (`server/src/bots.ts`): bots neutros com QG em Ceres que
  atacam todos os jogadores, recarregam e se consertam no QG e têm a minhoca
  como alvo prioritário.

### 8.6 Controles principais

| Tecla | Ação |
|-------|------|
| W/↑, A/D | acelerar, girar |
| [F] | trocar de camada, pousar/decolar, modo ataque, focar alvo |
| [V] | vista de cima ↔ cockpit |
| [C] / [T] | embarcar numa nave do hangar / trocar a seleção |
| [ESP] | atirar ou minerar (builder) |
| [1] [2] [3] | mísseis, laser, minas; no builder pousado, construir estação, QG ou centro de rações |
| [E] | carga e descarga; no builder, refino automático |
| [J] | carregar/descarregar rações |
| [G] | consertar estrutura própria / tomar ruína |
| [U] / [B] | evoluir estação / construir turreta |
| [R] | iniciar (espectador) ou recomeçar |
| [N] | som liga/desliga |

## 9. Renderização e arte

### 9.1 Estilo

**Low poly facetado**, com cores por vértice (a direção original era
wireframe estilo Asteroids). Os assets continuam sendo **geometria gerada em
código** — naves, estruturas, rochas, minhocas e a toca são malhas montadas
no cliente (`client-web/src/render/`), sem pipeline de sprites/texturas. O som
também é sintetizado (8 bits, Web Audio).

Duas vistas: a **de cima** (câmera ortográfica) e o **cockpit** (perspectiva,
FOV horizontal 110° por padrão, painel com radar, dashboard de carga com as
placas de kits e a esteira do refino). Ajustes por câmera (altura das naves e
das minhocas em cruzeiro no cockpit) são feitos em
`onBeforeCameraRenderObservable`.

### 9.2 Derivação de formas

- **Asteroides:** polígono irregular gerado deterministicamente da semente do
  asteroide, **no cliente**. Mesma semente → mesma silhueta em web e desktop.
- **Naves e estruturas:** formas definidas à mão (poucos vértices) em uma
  biblioteca de shapes versionada junto ao cliente.
- Efeitos (bloom "monitor vetorial", espessura, cor) são pós-processo do
  renderer; não afetam nada acima.

### 9.3 Renderer trocável

```
sim-core (estado planar) ──► client-web  : Babylon.js, vista de cima + cockpit
                        └──► client-desktop (futuro): Godot, câmera 3D,
                             wireframe 3D; eixo Z puramente decorativo
                             (altura de asteroides, inclinação do cinturão)
```

O gameplay é idêntico nas duas versões; muda somente a apresentação.

No `client-web`, a apresentação já é modular: `GameScene` orquestra a cena e o
netcode, mas delega o desenho a renderers dedicados em `client-web/src/render/`
(um por família de entidade — nave, asteroide, estrutura, planeta, drone,
minhoca — mais HUD, interior do cockpit, efeitos e paleta). A cena não conhece detalhe de desenho;
isso mantém a fronteira lógica × apresentação nítida e antecipa a troca por um
renderer 3D no desktop.

## 10. Roteiro de implementação

1. **Fase 1 — esqueleto do modo partida** (valida o netcode):
   monorepo + `shared/` (coordenadas por setor, protocolo) + `sim-core`
   (tick, movimento de nave, mineração mínima) + `server/` (sala Colyseus,
   spawn `neighboring`, interest management básico) + `client-web/`
   (pilotar nave wireframe, ver asteroides procgen, 2+ jogadores sincronizados).
2. **Fase 2 — economia e construção** (implementada): estruturas (QG, estação,
   base inicial, centro de rações), produção no QG, logística física de minério
   e rações (§8.1) com drones e naves de transporte, mineradores autônomos
   (aranhas) na estação.
3. **Fase 3 — combate, ameaças e partida** (em grande parte implementada):
   nave de ataque com mísseis, laser e minas; camadas de voo e modo ataque
   (§8.3); turretas; frota neutra de Ceres; minhocas de Ceres com ninho, toca e
   duas camadas (§8.4); ruínas; jogadores-bot com ala de ataque (§8.5); janela
   de criação de sala, espectador e três modos de vitória com placar (§7).
   **Faltam** alianças, consumo de rações e a conquista de Ceres como vitória.
4. **Fase 4 — universo persistente**: banco de dados, save/load
   (semente + deltas), sala contínua, status de players online e bots online, janela com estatistica dos players e bots.
5. **Fase 5 — cliente desktop 3D** (Godot + colyseus-godot), consumindo o
   servidor existente sem alterações de backend.

## 11. Riscos e mitigações

| Risco | Mitigação |
|-------|-----------|
| Imprecisão de float na escala do mapa | coordenadas setor+local desde o 1º commit (§5.1) |
| Banda com "entidades infinitas" | interest management por setor; maioria das entidades é estática ou lenta (§4.3) |
| Custo do universo persistente | fase 4, não paga no protótipo; sharding habilitado pelo grid mas adiado |
| Divergência de gameplay web × desktop | simulação planar única no `sim-core`; 3D só apresentação (§9.3) |
| Acoplamento acidental sim ↔ engine | regras de dependência do §3, verificáveis por lint |
| Latência na pilotagem (ritmo rápido) | prediction + reconciliação para a nave própria (§4.1) |
