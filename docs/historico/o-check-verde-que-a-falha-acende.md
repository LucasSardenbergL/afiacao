# `return <mensagem afirmativa>` — o terceiro front, medido antes de varrido (2026-09-06)

A varredura de 2026-08-22 (`fase-sem-sinal.md` §"A CLASSE, varrida e gateada") gateou a
**auto-ocultação total** (`return null` guardado pela leitura). A medição de 2026-09-06
(`a-forma-que-some-e-a-forma-que-mente.md`) inventariou os 93 sítios de `{data && <X/>}` e, no
achado 3, registrou uma **terceira** forma que nem o gate nem aquela varredura enxergam:

```tsx
// src/pages/ToolHistory.tsx:173
if (!tool || !healthMetrics) return ( … <p>Ferramenta não encontrada</p> … );
```

Não é `null` (o gate exige `ehSilencio`: null/undefined/fragmento vazio) e não é `&&`. É a mais
afirmativa das três: em vez de sumir, **mente com especificidade**. Esta entrada é a medição desse
front. **Não é uma varredura**: nada de produção foi alterado, nenhuma baseline foi tocada.

Reprodução (cópia de trabalho do detector, forma `return-afirmativo` acrescentada ao mesmo ponto
fixo de taint; `contarAutoOcultacao` e a baseline do gate intactos):

```ts
// if (toca(cond)) { return <JSX com JsxText não-vazio> }  — sobre src/**, filtro de fontes do gate
```

**13 ocorrências · 13 arquivos** (1.472 fontes — mesmo denominador de fontes da medição anterior).
Deduplicadas por `(arquivo, linha)`: um mesmo `return` é taintado por N hooks do componente, e
contar por hook inflaria (`ToolHistory:174` é UM sítio, não dois).

Dois eixos vizinhos foram medidos junto e vieram **zero**, o que é informação e não silêncio:
`return <EmptyState title="…"/>` (texto por atributo, sem JsxText) = **0**; ternário com ramo
afirmativo = **0**. O critério estrito não estava escondendo fatia nenhuma.

## O que a medição encontrou

### 1. O pior sítio acende um ✓ VERDE quando a leitura falha

```tsx
// src/components/knowledge-base/CompletudeSection.tsx:24
if (!data || data.length === 0) return (
  <Card …><CheckCircle2 className="… text-status-success" />
    Todas as fichas aprovadas estão completas nos dados importantes.</Card>
);
```

`useCompletude` faz `if (error) throw error` sobre `kb_product_specs`. Quando a leitura falha,
`isLoading` é false, `data` é `undefined`, e a tela **afirma saúde com semáforo verde**.

Medido em prod: **119 fichas aprovadas, 116 com campo importante faltando, 295 campos ao todo**.
O estado NORMAL dessa tela é uma lista de 116 pendências de trabalho. A falha de leitura substitui
essas 116 linhas por um check verde. Nas outras duas formas a ausência afirma segurança *por
omissão*; aqui ela afirma segurança **com ícone de sucesso e uma frase universal** ("Todas as
fichas… estão completas"). É o dano máximo da classe, e é a única correção que esta medição
considera urgente.

### 2. 13 de 13 LANÇAM — não há sítio inerte neste front

No 2º front, 21 dos 93 sítios eram *inalcançáveis*: o hook engolia o erro (`return data ?? []`), a
query ficava `success` com `[]`, e trocar o `&&` por `estadoDeLeitura` seria **fix inerte** — diff
plausível, zero mudança de comportamento. Aqui **todos os 13 hooks fazem `if (error) throw error`**.
Cada sítio medido é alcançável; nenhum fix seria decorativo. Esta é a diferença estrutural entre os
dois fronts, e ela **inverte a economia**: 13 sítios, 13 úteis.

### 3. Em 4 sítios a distinção EXISTE no dado e é jogada fora

O pedido pedia separar "não achei ESTE id" de "não consegui ler". O eixo que decide não está no
componente — está no hook:

| terminador | não-achado | falha de leitura | o `if (!data)` … |
|---|---|---|---|
| **`.maybeSingle()`** (4 sítios) | `data === null` | `data === undefined` (throw) | **descarta** informação que tem |
| **`.single()`** (3 sítios) | LANÇA (PGRST116) | LANÇA | não pode distinguir sem `error.code` |
| lista (6 sítios) | `[]` | `undefined` (throw) | `!data \|\| length === 0` **colapsa à mão** |

`useUserToolDetail` é o caso exemplar: `.maybeSingle()` → `if (error) throw error` →
`return (data ?? null)`. Em sucesso, `null` significa *não existe esta ferramenta*; `undefined` só
acontece em loading ou erro. O componente escreve `if (!tool)` e **apaga a diferença que o hook
preservou**. Não é limitação do dado — é descarte. O fix é barato e local (`data === null` →
"não encontrada"; `undefined` + `error` → "não consegui ler").

Os 3 de `.single()` são o caso oposto: PGRST116 e queda de rede chegam idênticos, e "não encontrado"
é a única frase possível sem inspecionar `error.code`. **Legítimo por construção, mentiroso na
falha** — e o fix é diferente (ler o código do erro), o que importa porque um fix só serve a um
grupo.

Nas 6 listas, `!data || data.length === 0` escreve o colapso **à mão, com `||`**. No 2º front esse
mesmo colapso vinha de graça, pelo default no binding (`data: x = []`); aqui alguém o digitou.

### 4. Os dois falsos positivos previstos têm contagem ZERO — medida, não presumida

- **`return <p>Não encontrado</p>` guardado por id de rota inválido:** 0 sítios. Nenhum dos 13 é
  guardado por um id puro; as 2 condições que tocam um identificador derivado de rota
  (`!isNew && !campanha`, `!grupo`) tocam-no *junto com* o dado, e `!isNew` só protege o modo de
  criação — no modo edição a frase segue mentindo.
- **Protegido por early return de `isError` acima:** 0 sítios. Nenhum dos 13 arquivos desestrutura
  `error`/`isError` de hook nenhum.

O segundo mereceu conferência manual, porque um grep de `error` acusa **17 ocorrências** nesses
arquivos. Todas as 17 são `toast.error` de *mutação* ou `console.error`. É exatamente o falso
negativo que o cabeçalho do gate documenta ("um grep de `error` casa `text-status-error` e o arquivo
passa"), aparecendo de novo com outra fachada: **`toast.error` prova tratamento de ESCRITA e nada
diz sobre a LEITURA.**

### 5. A armadilha de medição desta rodada: colisão de NOME de hook

Resolver o hook pelo nome deu a tabela errada. Existem **dois `useCompletude`** exportados
(`src/hooks/useCompletude.ts` → `kb_product_specs`; `src/hooks/useEndividamento.ts` →
`fin_divida_completude`), e o mapa por nome entregou o segundo. O denominador teria saído do
financeiro para um sítio de knowledge-base — plausível, e errado. **Resolver por `import`, não por
nome.** É a irmã da armadilha do doc anterior (`orders` × `sales_orders`): lá o nome plausível deu o
zero plausível, aqui o nome plausível deu a tabela plausível.

E o caso inverso também apareceu: `OrderDetail:166` lê `orders`, que tem **0 linhas** enquanto
`sales_orders` tem 31.248. Desta vez o zero é **verdade** — o escritor confirma
(`OrderDetail.tsx:123` faz `.from('orders').update(...)`), então é a tela que está viva em código e
morta em dados, não a medição que errou de tabela. A regra que separou os dois casos é a mesma:
**denominador só vale com a fonte confirmada pelo escritor.**

## Denominadores (psql-ro, 2026-09-06)

| sítio | fonte | linhas | terminador |
|---|---|---|---|
| `CompletudeSection:24` | `kb_product_specs` aprovadas | **119 · 116 com faltante · 295 campos** | lista |
| `AdminKnowledgeBaseDetail:59` | `kb_documents` | **297** | `.single()` |
| `RecebimentoConferencia:466` | `nfe_recebimentos` | **47** | `.single()` |
| `AdminReposicaoPromocaoDetail:401` | `promocao_campanha` | **17** | `.single()` |
| `ToolHistory:174` · `ToolReports:157` · `ToolPublicHistory:39` | `user_tools` (·`tool_events`=0) | **4** | `.maybeSingle()` / RPC |
| `ProvasParaAuditar:244` | `v_tarefas_estado` (`requer_auditoria`) | **0** | lista |
| `CustomerCallsTab:16` | `farmer_calls` | **0** | lista |
| `CustomerVisitsTab:26` | `route_visits` | **0** | lista |
| `GrupoCliente360:42` | `cliente_grupos` | **0** | lista |
| `OrderDetail:166` | `orders` (≠ `sales_orders`=31.248) | **0** | `.maybeSingle()` |
| `AdminStandardProcessDetail:45` | `standard_processes` | **0** | `.maybeSingle()` |

**7 sítios com fonte viva, 6 com fonte zerada.** O denominador de gente segue o de 2026-08-22:
`user_roles` = 5.664 customer · **2 employee · 1 master** — as telas admin (knowledge base,
recebimento, promoções) são vistas por 3 pessoas, o que torna o argumento mais forte e não mais
fraco: um alerta perdido é um terço da operação.

## Ordem de correção, por dano medido

1. **`CompletudeSection.tsx:24`.** Único item urgente. 116 pendências reais viram ✓ verde de
   "tudo completo". Superfície de saúde, afirmação positiva, ícone de sucesso — a combinação que a
   classe inteira existe para impedir. O `isLoading` já está lá; falta o ramo de erro.
2. **Os 3 de `.single()`** (`kb_documents` 297, `nfe_recebimentos` 47, `promocao_campanha` 17).
   Fonte viva, e "não encontrado" cobre também "o banco caiu". Fix = ramificar por
   `error.code === 'PGRST116'`. `RecebimentoConferencia` é o mais sensível dos três: a conferência
   de NF-e é passo de recebimento, e "NF-e não encontrada" durante uma falha manda o operador
   procurar um documento que existe.
3. **Os 3 de ferramenta** (`user_tools` = 4). Dano baixo pelo denominador, mas o fix é o mais barato
   de todos — o hook **já devolve `null` vs `undefined`** e o componente só precisa parar de
   descartar. `ToolPublicHistory` merece nota: o texto acrescenta uma causa inventada
   ("O QR code pode estar desatualizado") a um estado que pode ser falha de rede.
4. **Dano hoje ZERO ⇒ chip com gatilho, não correção agora** (mesmo perfil do `carteira_coverage`):
   `ProvasParaAuditar:244`, `CustomerCallsTab:16`, `CustomerVisitsTab:26`, `GrupoCliente360:42`,
   `OrderDetail:166`, `AdminStandardProcessDetail:45`. Corrigir **antes da primeira linha** —
   `ProvasParaAuditar` é o mais perigoso da lista quando encher, porque "Nenhuma prova aguardando
   auditoria" é uma afirmação de controle: a auditoria some no dia em que a leitura falhar.

## Gateado em 2026-09-06 (passo 4 do `matar-classe`)

Esta forma era a **melhor candidata a gate das três**, e o motivo é aritmético: 93 sítios de `jsx-&&`
fariam a baseline crescer por motivo benigno em idioma legítimo — o argumento que manteve aquela
forma fora do gate em 2026-08-22 e que a medição de 2026-09-06 confirmou. Aqui são **13**, e
**13 de 13 são alcançáveis** (achado 2): não há a fatia inerte que tornaria a baseline ruído.

O recorte NÃO é "todo `return` com texto" — isso pegaria empty state legítimo guardado por outra
coisa. É o que foi medido: **`return` com JsxText não-vazio, guardado por condição que toca o `data`
de um hook cuja desestruturação NÃO liga `error`**. A forma foi promovida ao mesmo ponto fixo de
taint de `src/lib/gates/erro-colapsado-em-vazio.ts` (`contarRetornoAfirmativo`), e o gate ganhou
`BASELINE_AFIRMATIVO` **própria, por contagem** — por caminho, um 2º sítio no mesmo arquivo passaria
calado.

**Reprodução do número, sobre a mesma árvore:** 1.472 fontes · **13 sítios / 13 arquivos** ·
auto-ocultação **inalterada em 44/34**. Os `(arquivo, linha)` são os 13 da tabela de denominadores.

### A unidade das duas baselines é diferente — e isso é de propósito

`contarAutoOcultacao` conta **bindings de hook** que colapsam; `contarRetornoAfirmativo` conta
**linhas**. Não são somáveis. O caso que obriga a distinção apareceu nos dois lados:
`Training.tsx:150` é UM ternário contado **2 vezes** pela 1ª (dois hooks o guardam, e a baseline
diz 2), enquanto `ToolHistory:174` é UM `return` taintado por `useUserToolDetail` **e**
`useToolEvents` e a 2ª o conta **1 vez**. Contar por hook infla; o gate deduplica por
`(arquivo, linha)` e o walker continua devolvendo os dois hooks, porque quem investiga quer saber
quais leituras tocam a guarda.

### O eixo vizinho que quase virou falso achado

Os dois eixos vizinhos foram re-medidos e seguem **zero** — mas o do ternário só deu zero depois de
uma correção de **predicado**, não de código. A primeira passada acusou **1**
(`Training.tsx:150`) e a leitura fácil seria "alguém introduziu um sítio novo". O arquivo está
intocado desde 2026-07-07: o defeito era meu. Meu predicado aceitava *qualquer* ramo com texto, e
ali o ramo do colapso é `null` — é `ternario-null`, **já gateado e já na baseline de cima**.
Contá-lo seria contar o mesmo sítio duas vezes, em duas baselines.

A regra que sobra: **eixo vizinho de uma forma já gateada precisa EXCLUIR a forma gateada**, senão
a medição do vizinho é, em parte, um eco da baseline que já existe. É a irmã da armadilha de
contagem do achado 5 — lá o nome plausível deu a tabela plausível, aqui o predicado plausível deu
o achado plausível.

### Falsificação (5 camadas, uma por vez, controle verde na MESMA invocação)

O laço roda o **controle antes do 1º `sed`** e aborta se ele não estiver verde — sempre-vermelha
aprova tudo. Cada camada restaura com `git checkout --` e o restauro é conferido **byte-exato**
(`git diff --quiet`), não por "ficou verde de novo".

| camada | sabotagem | o que provaria estar morto |
|---|---|---|
| L1 | 2º sítio no arquivo que **já** está na baseline (1→2) | é a única camada que a baseline por CAMINHO deixaria passar |
| L2 | sítio em arquivo **fora** da baseline (0→1) | o ramo `reintroducoes` |
| L3 | sítio **removido** (ligar `error` em `CompletudeSection`) | o ramo `quitados` — a baseline só encolhe registrada |
| L4 | **detector cego** (predicado de texto sempre falso) | 13→0: um gate cego passaria verde para sempre |
| L5 | **dedup quebrada** (contar por hook) | `ToolHistory` 1→2: a dedup é load-bearing em dado real, não só na fixture |


## Quitação da fatia de fonte ZERADA (2026-09-07, PR desta sessão)

O item 4 acima previa **chip com gatilho**. O que foi feito em vez disso: **correção agora**,
pelo motivo que o próprio item dá — "corrigir ANTES da primeira linha". Com a tabela vazia não há
comportamento observável a regredir, o fix é o mais barato que vai ficar, e quando a fonte encher o
defeito já não existe. Chip com gatilho só teria valor se o fix fosse caro; ele não é.

Os 6, com a forma e o mecanismo do colapso:

| sítio | fonte (linhas) | como o colapso era escrito | fix |
|---|---|---|---|
| `ProvasParaAuditar:244` | `v_tarefas_estado` (0) | default `= []` no binding | `estadoDeLeitura` |
| `CustomerCallsTab:16` | `farmer_calls` (0) | `!data \|\| length === 0` | `estadoDeLeitura` |
| `CustomerVisitsTab:26` | `route_visits` (0) | `!data \|\| length === 0` | `estadoDeLeitura` |
| `GrupoCliente360:42` | `cliente_grupos` (0) | derivada: `!grupo` de `grupos?.find()` | `estadoDeLeitura` |
| `OrderDetail:166` | `orders` (0) | `!order` sobre `.maybeSingle()` | `estadoDeRegistro` |
| `AdminStandardProcessDetail:45` | `standard_processes` (0) | `!data` sobre `.maybeSingle()` | `estadoDeRegistro` |

**`ProvasParaAuditar` não era a forma que a medição registrou.** A tabela do achado 3 o classificou
como lista `!data || data.length === 0`; o código escreve `const { data: provas = [], isLoading }` e
`if (provas.length === 0)`. O colapso vinha do **default no binding** — a forma do 2º front — e não
do `||` digitado à mão. O erro de classificação não muda o veredito (o hook lança, o sítio é
alcançável) mas muda o FIX: não há `!data` para desdobrar, e a query precisa ser lida por
`estadoDeLeitura` antes do `data` já achatado em `[]`.

### O que a medição provou, e o que ela não provaria sozinha

`contarRetornoAfirmativo` foi de **9 para 3**. Zero, porém, é o que a CEGUEIRA também produz: o
detector só rastreia desestruturação direta (`const {…} = useX(…)`), e um `const q = useX()` faria
os 6 sumirem sem conserto nenhum. A prova de que lado veio o zero: **apagar a chave de erro de cada
binding e re-medir** — 6/6 voltaram a contar 1, isto é, o detector VÊ o tratamento e segue vigiando
os arquivos. Um sítio cegado teria ficado em zero nas duas medições.

Falsificação: **18/18 sabotagens pegas** (3 camadas × 6 sítios), com controle verde (24/24) na mesma
invocação **antes do 1º `sed`** — guard morto, guard estreitado a `'erro'` só (o 4º estado volta a
mentir), e aviso incondicional (que prova que o teste também exige o SILÊNCIO quando a leitura deu
certo — senão "sempre avisa" passaria como fix).

O controle pagou o próprio custo na 1ª execução: **abortou sem sabotar nada**, porque um dos 5
arquivos estava vermelho (o mock de `supabase` não tinha `channel`, e o `<OrderChat>` do caminho
feliz derrubava a árvore). Sem ele, as 18 sabotagens teriam dado "vermelho" contra uma suíte já
quebrada e eu teria reportado 18/18 com um teste morto no meio — a falsificação sem linha de base
que `falsificacao-sem-linha-de-base.md` descreve.

Nota de ambiente, porque custou duas execuções: `heavy` **aborta com exit 1** quando esgota os 1800s
de fila, e o exit 1 do laço starvado é indistinguível do exit 1 de "sabotagem passou verde" se você
olhar só o código. O sinal que separa os dois é textual (`heavy: timeout (1800s)` vs `VEREDITO:`).
Laço longo em máquina saturada precisa que o monitor vigie **a tomada do slot**, não só o veredito.

### Resíduo da classe, medido

Sobram **3** na `BASELINE_AFIRMATIVO`: `CompletudeSection` — em voo no PR #2305 — e
`ToolHistory`/`ToolReports`, resíduo já documentado na própria baseline (a query IRMÃ `useToolEvents`
ainda engole o erro no default `= []`; `tool_events` tem 0 linhas).
