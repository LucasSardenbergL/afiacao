# 289 provas SQL, zero executadas no merge — e o que foi preciso para executar 13

**Data:** 2026-09-07 · **Substrato:** `.github/workflows/ci.yml`, `db/` · **Domínio:** CI / money-path

## O buraco, medido

| medida | valor |
|---|---|
| `ls db/test-*.sh \| wc -l` | **289** |
| menções a `db/test-` no `ci.yml` | **1 — e é COMENTÁRIO** (linha 465) |
| `services:` / postgres no `ci.yml` | **0** |

O comentário que já estava lá dizia, sobre esses arquivos: *"é onde moram as PROVAS EXECUTADAS
do SQL de risco"*. O CI sabia o que eram e não rodava nenhuma.

Ficavam sem gate justamente as classes que **só um banco de verdade pega**, e que são as caras:

- **TOCTOU / guard fora da escrita** — 10 fixes no histórico, 100% money-path;
- **PL/pgSQL late-bound** — o `CREATE` passa e a função só quebra em RUNTIME;
- **`security_invoker` omitido num `CREATE OR REPLACE VIEW`** — a opção RESETA, a view passa a
  ler como OWNER e bypassa RLS. Falha **ABERTA**, que nenhum gate textual enxerga.

## Por que NÃO foi `services: postgres:17`

Era o desenho pedido, e está errado para este acervo. As 289 provas não conectam a um servidor
externo: cada uma faz o seu `initdb` + `pg_ctl` numa porta própria, cria fixtures, aplica a
migration REAL do repo e destrói o cluster no `trap EXIT`.

Um `services:` roda em container à parte, não compartilha o socket unix do runner, e obrigaria a
reescrever a conexão das 289 — criando a divergência "roda no laptop / roda no CI" que o gate do
shellcheck, dez linhas acima no mesmo arquivo, existiu para fechar.

O parecer do Codex (gpt-6-astra · max) corrigiu dois argumentos meus e sustentou a conclusão:
`services:` **aceita** bind mount de socket, então a separação de `/tmp` é default e não
impossibilidade. A objeção decisiva é outra: **um database por prova separa `CREATE SCHEMA`, mas
não separa `CREATE ROLE`/`ALTER ROLE` — roles são do CLUSTER.** E 130 das provas rodam sob
`SET ROLE authenticated`.

A saída foi instalar o **binário** do PGDG no runner e extrair `db/lib/pg-harness.sh`, que resolve
o `PGBIN` por plataforma com conferência **positiva** da major. A prova roda no CI exatamente como
no laptop.

## O que foi entregue

| arquivo | papel |
|---|---|
| `db/lib/pg-harness.sh` | resolve PGBIN (macOS Homebrew / Linux PGDG), fail-CLOSED |
| `db/nucleo-ci.txt` | manifesto: 13 provas, 4 eixos, **mínimo de asserts por prova** |
| `db/roda-nucleo-ci.sh` | executor com sonda de ambiente e recibo |
| `db/falsifica-nucleo-ci.sh` | sabota e exige vermelho **pela marca** |
| `ci.yml` job `provas-sql` | paralelo, no `needs:` do `validate` |

Eixos, na ordem de dano: **autorização** (4) · **finitude monetária** (3) · **atomicidade** (3) ·
**concorrência/TOCTOU** (3).

## As duas armadilhas que quase passaram

### 1. O fechamento das provas aceita `PASS=0`

Achado do Codex, conferido no repo: as provas terminam em

```bash
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
```

`FAIL=0` é verdadeiro para uma prova que **não asseriu nada**. Uma prova truncada — ou substituída
por `exit 0` — sai zero e o gate aprova. Por isso cada linha do manifesto carrega o mínimo de
asserts, e o runner exige `pass ≥ mínimo`. Encolher a prova reprova até alguém baixar o número no
manifesto, e aí a perda de cobertura fica **no diff**.

### 2. Sabotar comentário não é sabotar

A primeira tentativa de falsificar a classe `security_invoker` removeu a primeira ocorrência de
`WITH (security_invoker = on)` do arquivo. O teste seguiu **verde** — e a leitura ingênua seria
"o gate não tem dente". A ocorrência estava na **linha 23, dentro de um comentário SQL**.

É a mesma classe de [gates-textuais-cegos.md](gates-textuais-cegos.md), do outro lado: lá o gate
mede comentário como se fosse código; aqui o *falsificador* sabota comentário e conclui coisa
errada sobre o gate. Por isso toda sabotagem em `db/falsifica-nucleo-ci.sh` **aborta se não mudar
o que disse que ia mudar** — sabotagem que não aplicou é falsificação INVÁLIDA, não gate sem dente.

## A falsificação: 19 asserts, 0 falhas

Controle verde na **mesma invocação**, antes do primeiro `sed` — sem ele, uma suíte
sempre-vermelha aprovaria tudo ([falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md)).
Cada sabotagem declara a **marca** que o vermelho precisa conter: `exit != 0` sozinho aceitaria
falha de ambiente como se fosse captura.

| defeito restaurado | marca exigida | natureza |
|---|---|---|
| #2285 — allowlist de status sai do `WHERE` que grava | `[CLAIM-GUARD-FORA-DO-UPDATE]` | a migration se auto-verifica em runtime |
| #2306 — `disparado_simulado` sai do predicado do trigger | `[GUARD-CEGO]` | idem |
| `security_invoker` removido de UMA view | `customer NÃO lê v_sku_sigma_demanda` | **assert**: o vazamento de RLS acontece |

Nada disso toca `supabase/migrations/` (DR do Lovable, com hook de imutabilidade): a falsificação
monta um **espelho** em tmpdir e sabota lá. As provas resolvem `REPO_ROOT` a partir do próprio
caminho, então rodá-las de dentro do espelho as faz ler as migrations do espelho.

O executor também é falsificado — manifesto vazio, caminho inexistente, mínimo 0, duplicata, prova
esvaziada, prova encolhida e Postgres ausente. Os sete reprovam pela marca certa.

## Custo

Job **próprio e paralelo**, de propósito fora do `gates-e-falsificacao` (gargalo atual, mediana
357s). Não precisa de bun, de deno nem de `fetch-depth: 0`.

⚠️ **Nenhum número de ganho/perda de tempo é afirmado aqui.** O runner do GitHub varia 45% e a
normalização por step de referência exige que o relógio esteja no MESMO job
([medir-ganho-de-ci-sob-ruido.md](medir-ganho-de-ci-sob-ruido.md)) — um job novo não tem passado
com que se comparar. O que se sabe: no laptop (sob carga de 8 worktrees) o núcleo custa ~150s, e
o caminho crítico só cresce se o job passar do gargalo.

## O que este PR NÃO entrega

Precisão sobre o alcance, porque a tentação de ler mais do que está aqui é grande:

- **13 de 289.** As outras 276 seguem fora do merge. Ampliar = rodar o candidato local, confirmar
  que é autocontido, e acrescentar ao `db/nucleo-ci.txt` com o mínimo de asserts.
- **Rodar um núcleo não cobre toda migration nova** (Codex): uma migration B que redefina uma
  função cuja prova só aplica A deixa o job verde sem exercer B. Vincular migration↔prova é
  frente própria.
- **Serial.** Paralelizar exige antes migrar as provas para socket em diretório exclusivo com
  `listen_addresses=''` — 70 das 289 trazem porta fixa sem override, e isolamento por porta é
  frágil por desenho. A ~15s de núcleo (laptop ocioso), serial paga.
- **A minor do Postgres não é pinada**, e é deliberado: o PGDG remove pacotes antigos do índice e
  um pin exato viraria vermelho por AMBIENTE — o que ensina a tratar o job como flaky, que é como
  um gate morre. Em vez disso há **piso** (170006 = o 17.6 de produção) e a versão real vai para
  o log a cada run.
