# psql local sem `-X` lê o `~/.psqlrc` — e a prova aprova o SQL que errou

**2026-09-30.** O psql lê `~/.psqlrc` (ou o arquivo de `$PSQLRC`) **depois** das opções de linha de
comando. Um `\set ON_ERROR_STOP off` pessoal anula o `-v ON_ERROR_STOP=1` do helper `P()`: o script
lido de `-f`/stdin segue depois do erro e sai 0, o `set -e` não dispara, e a prova aprova. `\x`,
`\pset` e `\timing` mudam a saída que os asserts comparam. A classe é **latente**: esta máquina e o
runner do CI não têm psqlrc nenhum (`~/.psqlrc` ausente, `PSQLRC` vazio, nada em
`$(pg_config --sysconfdir)`) — quem tiver um, julga errado. Medida pela 1ª vez no #2642 (fase 5 dos
parciais de `db/`): com `PSQLRC` hostil, o juiz antigo do `test-authz-private-execute-fecho` aprovou
uma chamada abortada (22012) como `EXECUTOU`.

**Passo 0 — instância única ou classe? Classe:** o mesmo helper `P()` copiado em 286 provas, vindo
do template da skill `prove-sql-money-path`.

## A reprodução, antes de consertar

Alvo vivo, do núcleo do CI: `db/test-sales_orders_omie_hash_unique.sh` (idempotência do sync de
pedidos). Cópia-sombra no scratchpad; a migration sabotada é uma CÓPIA (+ `GRANT SELECT ON
public.tabela_que_nao_existe TO PUBLIC;` → `42P01`), `supabase/migrations/` intocado. Expectativa
declarada antes; resultado idêntico em `LC_ALL=C` e `pt_BR.UTF-8`:

| variante | psqlrc | exit | recibo |
|---|---|---|---|
| íntegra, sem `-X` | nenhum | 0 | `5 ok / 0 fail` |
| sabotada, sem `-X` | nenhum | **3** | — (o `set -e` pega o exit do psql) |
| sabotada, sem `-X` | `\set ON_ERROR_STOP off` | **0** | **`5 ok / 0 fail`** — com `ERROR: relation "public.tabela_que_nao_existe" does not exist` no log |
| sabotada, **com `-X`** | `\set ON_ERROR_STOP off` | **3** | — |
| íntegra, com `-X` | `\set ON_ERROR_STOP off` | 0 | `5 ok / 0 fail` |
| íntegra, sem `-X` | `\x on` + `\timing on` | 1 | `4 ok / 1 fail` (A1 leu "Expanded display is on") |
| íntegra, com `-X` | `\x on` + `\timing on` | 0 | `5 ok / 0 fail` |

A 3ª linha é o dano: em prod o SQL Editor roda a migration numa transação e ela ABORTA inteira — o
índice único não existiria, e a prova diria verde.

## A varredura

Assinatura calibrada (casa `P() { "$PGBIN/psql" -p … }`, não casa a mesma linha com `-X`):
`grep -nE '"\$PGBIN/psql"' db/*.sh | grep -vE '^[^:]*:[0-9]+:\s*#' | grep -vE -- ' -X( |$)'` →
**381 linhas em 287 arquivos** (eram 379/286 em 27/09: a classe crescia). As formas variantes (86
linhas com `psql` fora dessa forma, spawns em TS, workflows) foram classificadas por subagente e
**conferidas contra o gate**, que achou os mesmos sítios por outro método:

| território | afetado → consertado | já-correto / isento | falso-positivo |
|---|---|---|---|
| `db/*.sh` (`"$PGBIN/psql"`) | 372 linhas | 27 com `-X` canônico; 3 fakes com `env PSQLRC=…` explícito (imitam o wrapper); 6 com `-X` empacotado (`-qtAX`, viraram `-X -qtAX` — redundante, inócuo) | — |
| `db/*.sh` (outras formas) | 2 com `-X` fora da posição canônica (`test-tint-promocao-assincrona:70`, `test-tint-promote-tombstone-fase5:40`) — normalizadas | 2 fakes por `echo "exec env PSQLRC=/dev/null $PGBIN/psql …"` (`test-db-aplicar:180,385`); a função `psql()` de `test-fu4f-fase3-afinidade-reaplica:33` (13 chamadas, herdam o `-X` dela) | 1 prosa em mensagem (`test-db-aplicar:994`, reescrita sem o token) |
| `.claude/` | **o TEMPLATE** (`skills/prove-sql-money-path/references/harness-template.sh:38` — toda prova nova nasce dele) + 3 em evals (`lovable-deploy-verify/evals/{edges-pendentes-sql,sonda-veredito-401}-eval.sh`) | — | dado de teste de hooks em aspas simples |
| `scripts/`, `connector/` | nenhum psql local | — | nomes (`psql-ro`, `psql-fake`, `psql-stub`…) |
| TS (`db/`, `scripts/`) | nenhum spawn de psql LOCAL | os 11 `execFileSync(PSQL…)` são todos o `psql-ro` | — |
| `.github/workflows/ci.yml` | — | 3 com `"$bin/psql" -X` | — |
| `db/psql-rw.template` | — | `PSQLRC=/dev/null` explícito (linha continuada) | — |

**O `psql-ro` NUNCA leva `-X`:** o wrapper faz `exec env PSQLRC=…/psqlrc-ro psql …`, e é o
`psqlrc-ro` que impõe `SESSION … READ ONLY` + `statement_timeout 30s` — um `-X` ali desligaria a trava.

A erradicação é estritamente mecânica: `"$PGBIN/psql" ` → `"$PGBIN/psql" -X ` por ENDEREÇO de linha
(só as linhas da varredura), conferida por comando — cada linha `+` do diff é a `-` com ` -X`
inserido depois do binário (378/378), `bash -n` limpo nos arquivos tocados.

**A classe reincidiu DURANTE o PR — cinco vezes.** Enquanto ele rodava, entraram na `main` cinco
provas novas, todas copiadas do template antigo: `test-des-desconto-total-maximo` (3 chamadas,
#2670), `test-expandir-promocao-item` (2, #2683), `test-hoje-sp-sete-funcoes` (2, #2659),
`test-hoje-sp-views-defaults` (3, #2685) e `test-data-health-vendas-empurradas` (1, #2698 — vista
na varredura dos PRs abertos, ainda em draft, e mergeada antes deste PR: a corrida do `strict:
false`). O gate as acusou no 1º rodar depois de cada rebase/merge; mesma troca mecânica (11/11).
Duas entregas do mesmo período — as provas do canal WhatsApp revividas e a nova
`test-hoje-sp-data-ciclo` (#2705) — já vieram com `-X`. Os conflitos do rebase foram re-derivados, não editados
à mão: pega-se a versão da `main` e re-aplica-se a troca (as 2 provas de data-health reescritas no
`bf449e5c8` já não tinham chamada sem `-X`; a 3ª, `test-familia-ausente-lista-email`, a `main` apagou).

## O gate — `scripts/psql-local-X-gate.ts`

Teste que lê fonte (vitest, `psql-local-X-gate.test.ts`), sobre o stripper COMPARTILHADO
(`removerComentariosShell`) e o MESMO universo do irmão `shell-variavel-colada-gate` (walker,
raízes `db`·`scripts`·`.claude`·`connector`, os quatro alarmes do stripper e os pisos por raiz,
importados): todo token que termina em `/psql` seguido de fronteira — `"$PGBIN/psql"`,
`${PGBIN}/psql`, `"$PGBIN"/psql`, caminho absoluto — exige ` -X` logo depois, na mesma linha. A
única isenção é `PSQLRC=` no MESMO comando (o fake que lê um psqlrc de propósito). Piso: a forma
certa vista em `db/` (≥350; medido 419), porque se o detector cegar as violações zeram junto.
A falsificação é permanente no teste: um arquivo REAL do núcleo com o `-X` tirado em memória tem de
virar violação na linha do `P()`, e só nela.

**O que o texto não alcança, de propósito:** `psql` nu em posição de comando (hoje nenhum sítio
real — os crus são a função `psql()` e DADO de teste; uma regra de palavra nua acusaria esses e não
pegaria nada); `-X` empacotado ou `--no-psqlrc` (só a forma canônica conta — um formato, um grep);
comando continuado por `\` (o `-X` tem de estar na linha do binário); TS, YAML e `.template` (sem
sítio local hoje); e o INVERSO — `-X` passado ao `psql-ro` — que é outra regra, só documentada aqui.
