# As 4 execuções cobradas por invocação não eram duplicata — eram subagentes que o modelo abriu

> **A classe (2026-09-20):** o rastro de uma cópia é igual ao rastro de um FILHO. Quatro arquivos
> de rollout, mesmo prompt, mesmo minuto, mesmo `cwd` — o formato do sintoma dizia "o transporte
> está disparando quatro vezes", e a investigação foi direto para o laço de retry do wrapper. Mas o
> mesmo desenho no disco também descreve **um pai e três filhos**: o modelo tinha uma ferramenta de
> delegação que ninguém no repo sabia que existia, e a usava exatamente nos prompts do ritual.
>
> A regra que fica: **antes de caçar quem chamou N vezes, pergunte ao registro QUEM É CADA UM.**
> O `session_meta` do 1º byte de cada rollout carrega `thread_source`, `parent_thread_id` e
> `forked_from_id` — três campos que separam "chamei de novo" de "ele se multiplicou", e que o
> agrupamento por (cwd, minuto, hash do prompt) apaga de propósito. Agrupar é o gesto que produz o
> número; **ler um membro do grupo** é o gesto que produz a causa.
>
> A segunda regra, mais cara: **config aceita ≠ config em vigor.** `--disable multi_agent` é aceito,
> aparece como `false` em `codex features list` — e não muda absolutamente nada no `codex exec`.
> Só uma leitura do pedido REAL separa as duas coisas.

Parente do *"ausente ≠ zero"* (`docs/agent/money-path.md`) e de
[cota-codex-medida-em-tokens.md](cota-codex-medida-em-tokens.md): ali a unidade da medição estava
errada; aqui a medição estava certa e a **atribuição** estava errada.

## O sintoma, como chegou

Medição do founder sobre `~/.codex/sessions/2026/09/*/*.jsonl`: 21 grupos, 34 sessões duplicadas,
~19% do consumo do mês. Um `tool_use` do wrapper na transcrição (com `tentativa 1` e UM cabeçalho
`PARECER CODEX`) → **4 arquivos de rollout**, mesmo prompt, mesmo minuto, mesmo `cwd`, pareceres com
md5 DIFERENTES. Suspeita registrada: o `&` + `wait "$pid"` do laço de tentativas, ou o próprio CLI
abrindo threads.

Duas coisas nesse enunciado já apontavam para fora do wrapper, e nenhuma foi decisiva sozinha:
os backoffs são **sequenciais** (não produzem paralelo), e pareceres **distintos** não são o que uma
duplicata de transporte produz — a mesma chamada repetida produz respostas diferentes, sim, mas
quatro *respostas diferentes sobre eixos diferentes* é outra coisa.

## A causa, com o registro na mão

O 1º byte de um dos "duplicados" (10/09, worktree `busy-hawking-729b81`):

```
"forked_from_id":"01a08dd0-…","parent_thread_id":"01a08dd0-…",
"thread_source":"subagent","agent_nickname":"Socrates","agent_path":"/root/adversarial_total",
"source":{"subagent":{"thread_spawn":{"depth":1,…}}}
```

E o pai (`01a08dd0-…`, iniciado às 21:14:34 — **um minuto antes**, que é por que o agrupamento por
minuto nunca o mostrava junto):

```
$ jq -r 'select(.type=="response_item") | .payload.type+" | "+(.payload.name//"-")' <pai> | sort | uniq -c
   3 function_call | spawn_agent      ← aqui
   9 custom_tool_call | exec
```

Argumento de um `spawn_agent`: `{"task_name":"adversarial_total","fork_turns":"all", …}`.
**`fork_turns:"all"` = o contexto INTEIRO do pai replicado no filho** (no caso medido, ~120k tokens
de input por thread). Os três filhos são `adversarial_total`, `window_write`, `tests_regressions` —
o modelo abriu a revisão por EIXO, que é exatamente o que os prompts do ritual pedem em prosa.

De onde vem a ferramenta: o codex-cli 0.153.4 injeta um bloco `developer` chamado
`<multi_agent_role>` em **toda** sessão `codex exec`, com `spawn_agent`/`followup_task`/`wait_agent`
e a frase que dá o "4" do sintoma:

> There are 4 available concurrency slots, meaning that up to 4 agents can be active at once,
> including you.

4 slots = o pai + **3** filhos. A distribuição medida bate no teto e nunca o ultrapassa:

| filhos numa consulta | 1 | 2 | 3 |
|---|---|---|---|
| nº de consultas | 15 | 5 | 5 |

⚠️ O CLI **já manda** um segundo bloco, `<multi_agent_mode>`, dizendo *"Do not spawn sub-agents
unless the user or applicable AGENTS.md/skill instructions explicitly ask for sub-agents, delegation,
or parallel agent work"* — e o modelo delegou assim mesmo. Não há `AGENTS.md` neste repo nem em
`~/.codex`: o que o modelo leu como "pedido explícito de trabalho paralelo" foi o **próprio prompt
adversarial do ritual**. Instrução em prosa não é gate.

## A medição (04–18/09, 207 rollouts — o dia 19/20 fica fora por conter os experimentos)

| threads | rollouts | tokens | fatia |
|---|---|---|---|
| raiz (`thread_source:"user"`) | 167 | 136.505.469 | 77,6% |
| **SUBAGENTE** | **40** | **39.500.083** | **22,4%** |

Os 40 filhos vieram de **25 consultas** — 15% das 167. Reproduzir:

```bash
for f in $(find ~/.codex/sessions/2026/09 -name 'rollout-*.jsonl'); do
  head -1 "$f" | jq -r '.payload.thread_source // "root"'; done | sort | uniq -c
```

## Os levers — três dos quatro são inertes, e o inerte se disfarça de aplicado

Sonda barata: `codex debug prompt-input` renderiza o pedido **sem gastar chamada**. Cuidado, porque
ela quase enganou: ela lista os *itens de input*, **não a lista de tools**, e o bloco
`<multi_agent_role>` aparece nela em TODAS as configurações. O que discrimina é a **linha dos
slots** — e essa foi confirmada idêntica no pedido real gravado no rollout.

| config | slots anunciados | veredito |
|---|---|---|
| (nada) | 4 | controle |
| `--disable multi_agent` (= `features.multi_agent=false`) | **4** | **INERTE** — `codex features list` mostra `false`, o `exec` ignora |
| `-c agents.max_depth=0` | **4** | **INERTE** |
| `-c agents.max_concurrent_threads_per_session=1` | 2 | parcial — ainda cabe 1 filho (`0` é recusado) |
| `-c features.multi_agent_v2.max_concurrent_threads_per_session=1` | **1** | **fecha** (`0` é recusado) |

### A prova ao vivo (20/09, com controle na mesma leva)

Mesmo prompt, exigindo `spawn_agent` explicitamente, `gpt-6-astra`/`low`:

| braço | slots | rollouts raiz | rollouts SUBAGENTE | resposta do modelo |
|---|---|---|---|---|
| controle | 4 | 1 | **2** | "OK" (delegou) |
| `features.multi_agent_v2.max_concurrent_threads_per_session=1` | 1 | 1 | **0** | "Não foi possível criar os sub-agentes: o limite de agentes foi atingido." |

Quem recusa é o próprio CLI/servidor, não o modelo se comportando — é gate, não pedido.

## A correção, em duas camadas que não se cobrem

1. **`-c features.multi_agent_v2.max_concurrent_threads_per_session=1`** na invocação do
   `scripts/codex-async.sh`. Fecha a porta.
2. **Sensor por FORA do flag** (`subagentes_desta_rodada()`): conta rollouts com
   `thread_source:"subagent"` **e o `cwd` desta worktree** criados durante a tentativa, e leva o
   número ao `stderr` e ao cabeçalho que vai pro PR. Existe porque a camada 1 é **específica de
   versão**: uma chave de config que o CLI não conhece é ignorada **em silêncio** (sem
   `--strict-config`), então um upgrade pode reabrir a porta sem nenhum sinal. Olhar só o flag não
   veria; o rastro em disco vê. Três estados, todos com caso na suíte: `0` (silêncio), `N>0`
   (alarme) e `?` (sem `sessions/` → **diz que não mediu**, não finge zero).

O filtro por `cwd` não é decoração: `~/.codex/sessions` é **compartilhado** entre as ~30 worktrees
paralelas — sem ele o alarme acusaria o vizinho.

`bash scripts/test-codex-async.sh --falsificar` sabota as três camadas **uma por vez**, nos dois
locales, exigindo vermelho pela **marca ASCII** certa (`FAIL [teto-ausente]`,
`FAIL [fanout-silencioso]`, `FAIL [fanout-cwd-alheia]`) e abortando se o CONTROLE não estiver verde.

## O que isto NÃO resolve

- **Não é o sensor de saldo (#2516, exit 79).** Aquele evita chamada MORTA (cota já estourada);
  este evita chamada VIVA que ninguém pediu. São despesas diferentes e se somam.
- **Não muda política do ritual.** O corte de 4→2 estágios rendeu −7% a −9%
  ([ritual-codex-dois-estagios.md](ritual-codex-dois-estagios.md)); este conserto devolve ~22% sem
  tocar em nenhuma decisão de método.
- **Não cobre o `-r ultra`**, que o catálogo define como *"Maximum reasoning with automatic task
  delegation"* — delegação é o que o nível É. Segue fora do ritual (ver `money-path.md`).
