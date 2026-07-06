# CeresConquest — Documento de Arquitetura

> Versão 0.1 — 2026-07-03
> Status: fundação aprovada, pré-implementação

## 1. Visão geral do jogo

RTS espacial multiplayer ambientado no cinturão de asteroides, onde se encontra Ceres.
Jogadores colonizam asteroides, constroem estruturas, formam equipes e disputam a
conquista de Ceres, que abriga em seu núcleo uma grande fonte de um mineral valioso.

Características que definem a arquitetura:

- O jogador **pilota uma única unidade por vez** (nave). Não há comando de enxames.
- Unidades autônomas existem apenas para **manutenção, mineração, transporte de cargas e ronda tática (fighter)**.
- Ritmo **rápido** (tempo real, resposta imediata ao pilotar).
- Número de unidades **escala sem teto fixo**; o teto prático vem do tempo de partida.
- Dois modos: **partida com início/fim** e **universo persistente com save**.
- Jogadores por sessão: **configurável no servidor** (protótipo: 10).
- Mapa em **escala 1:10 do sistema solar real**; gameplay concentrado no cinturão.
- Arte **geométrica vazada, somente linhas** (estilo Asteroids).
- Protótipo **web 2D topdown**; versão final **desktop 3D** (mesma simulação planar).

## 2. Decisões de arquitetura (resumo)

| # | Decisão | Escolha | Alternativa rejeitada e motivo |
|---|---------|---------|--------------------------------|
| 1 | Netcode | **State sync com servidor autoritativo** | Lockstep determinístico — inviável para persistência/save e para determinismo cross-platform (JS × C#) |
| 2 | Stack do protótipo | **Node + Colyseus (servidor), Phaser 3 + TS (cliente web)** | Engines visuais — menor afinidade com desenvolvimento code-first |
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
├── sim-core/       # simulação pura do jogo — SEM Phaser, SEM Colyseus, SEM I/O
├── server/         # Colyseus: salas, interest management, persistência, ciclo de vida
└── client-web/     # Phaser 3 + TypeScript: renderer 2D topdown do protótipo
```

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
| Alta | por tick | nave pilotada de cada jogador |
| Baixa | por evento/segundos | scouts em ronda, cargas, produção |
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

## 8. Entidades de gameplay

| Entidade | Controle | Notas |
|----------|----------|-------|
| Nave builder | pilotável pelo jogador | construção de QG; Estação de Mineração; Mineração ao pousar em Asteroide vazio; fabricada no QG; Ocupa vaga Expandida |
| Nave de ataque | pilotável pelo jogador | unidade com movimento autônomo de ronda entre dois asteroides próximos fabricada no QG; Ocupa vaga Normal |
| Nave de Mineração | pilotável pelo jogador | Mineração ao pousar em Asteroide vazio; fabricada no QG; Auto-Mineração na Estação de Mineração; Ocupa vaga Expandida |
| Nave de Transporte | pilotável pelo jogador | fabricada no QG; Ocupa vaga normal Carregamento de Minerio entre Estação de Mineração e Base Inicial; Carregamento de Rações entre Base Inicial e QG; Carregamento de Rações entre Base Inicial e Estação de Mineração |
| Estação de mineração | autônoma (economia) | estática; construída em asteroide; Possui dois Hangares expandidos |
| Centro de distribuição de rações | autônomo (economia) | estática; construída em asteroide; Hangar com 1 Vaga Expandida; Lança drones de ração em direção reta sem colisão até as estruturas próximas |
| Base inicial | estática | Player recebe essa Base no Asteroide mais proximo ao local de spawn inicial do player; recebe/envia cargas à Terra; recebe/envia cargas às estruturas; Hangar com 1 Vaga Expandida e 2 Vagas Normais |
| Quartel-general | estático | fabrica todos os tipos de Naves; Hangar com 2 Vagas Expandidas e 4 Vagas normais; Pode Taxiar naves do Hangar para o local do Jogador |
| Asteroide | procgen | minerável, colonizável; estado só persiste se alterado |
| Ceres | fixo | objetivo de conquista; fonte do mineral no núcleo |

Equipes: jogadores podem se aliar; `keepTeamsTogether` afeta spawn; regras de
vitória em equipe são design de jogo (fase posterior a este documento).

No `sim-core`, entidades carregam apenas dados de gameplay (posição, raio de
colisão, tipo, dono, HP, carga). **Nenhuma geometria de renderização** vive na
simulação ou trafega pela rede.

## 9. Renderização e arte

### 9.1 Estilo

Geometria **vazada, somente linhas** (estilo Asteroids). Consequência
arquitetural: assets são **listas de vértices**, não imagens — a mesma
definição de forma é desenhada como linha 2D (Phaser) e como wireframe 3D
(Godot). Não há pipeline de sprites/texturas no protótipo.

### 9.2 Derivação de formas

- **Asteroides:** polígono irregular gerado deterministicamente da semente do
  asteroide, **no cliente**. Mesma semente → mesma silhueta em web e desktop.
- **Naves e estruturas:** formas definidas à mão (poucos vértices) em uma
  biblioteca de shapes versionada junto ao cliente.
- Efeitos (bloom "monitor vetorial", espessura, cor) são pós-processo do
  renderer; não afetam nada acima.

### 9.3 Renderer trocável

```
sim-core (estado planar) ──► client-web  : Phaser, câmera topdown 2D
                        └──► client-desktop (futuro): Godot, câmera 3D,
                             wireframe 3D; eixo Z puramente decorativo
                             (altura de asteroides, inclinação do cinturão)
```

O gameplay é idêntico nas duas versões; muda somente a apresentação.

## 10. Roteiro de implementação

1. **Fase 1 — esqueleto do modo partida** (valida o netcode):
   monorepo + `shared/` (coordenadas por setor, protocolo) + `sim-core`
   (tick, movimento de nave, mineração mínima) + `server/` (sala Colyseus,
   spawn `neighboring`, interest management básico) + `client-web/`
   (pilotar nave wireframe, ver asteroides procgen, 2+ jogadores sincronizados).
2. **Fase 2 — economia e construção**: estruturas, produção no QG, envio de cargas 
   com drones e naves de transporte, mineradores autônomos na estação de mineração,
   naves de ataque autônomos em ronda.
3. **Fase 3 — combate e equipes**: naves de ataque, dano, alianças, condição
   de vitória (conquista de Ceres).
4. **Fase 4 — universo persistente**: banco de dados, save/load
   (semente + deltas), sala contínua.
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
