# `provas-sql` com escopo por PR (E1 + CI-GIT do plano v5, lote 8)

**Data:** 2026-11-04 · **Plano:** `docs/superpowers/plans/2026-11-03-plano-melhoria-v5/README.md` §2 "E. Dev e CI" · **Sem banco, sem Publish.**

## Problema

O `provas-sql` roda as 171 provas de `db/nucleo-ci.txt` em 6 partes de ~16 min. Isso vale para **todo** PR, inclusive os que não tocam nada que uma prova lê.

Linha de base, medida no PR #3583 (só `docs/historico/tint-purge-staging-io.md`, run 41813445293, soma de `completedAt − startedAt` por job):

| | runner-min |
|---|---|
| `provas-sql` (6 partes) + união | **102,9** |
| run inteiro | 141,0 |
| parede do run | 20,4 min |

Ou seja, 73% do runner de um PR só de docs ia para provas que não tinham o que medir, e elas eram o caminho crítico da parede. Isso vira fila no plano Free, que tem 20 jobs simultâneos.

## O mapa: o que as provas leem fora de `db/`

O mapa foi levantado por subagente (grep sem comentário + seguimento transitivo de `source`, `bash`, `bun`, imports TS) e conferido por um fecho de imports independente:

- **`supabase/`**: `migrations/**` por glob e `find` (~155 provas, a cadeia inteira via `db/lib/corpo-vivo.sh` e `data-health-vivo.sh`), `schema-snapshot.sql`, `schema-extensions-prelude.sql`, `config.toml`, e `functions/**` (`scripts/sonda-versao-sql.ts` enumera TODAS as edges para a canária).
- **`scripts/`**: `db-aplicar.sh` (executado), `sonda-*.ts`, `canaria-*.ts`, `lib/transporte-nuvem.ts`, `venda-*-esperado.ts`. Alguns são sabotados em `git worktree add HEAD`.
- **`src/`**: `lib/financeiro/saldo-contas.ts` (o `grep` de `db/test-projecao-13s-saldo-fresco.sh:290`), mais os que chegam por import: `lib/farmer/universo-pedidos.ts`, `lib/whatsapp/route-city.ts` e `route-schedule.ts`, `lib/gates/limpeza-fonte.ts` e `passos.ts`, `lib/erro-mensagem.ts`, `lib/venda-cliente/recompra.ts`. O subagente listou 5; o fecho de imports achou 3 a mais, e é por isso que o desenho calcula em vez de listar.
- **`.claude/`**: `skills/cfo-colacor/assets/sql/01-caixa-13-semanas.sql` (`db/test-cfo-caixa-90d-otica.sh:83`).
- **Raiz**: `tsconfig.json`, `package.json` e `bunfig.toml` (resolução do `bun`).
- **Histórico git** por SHA/blob fixo (`git show 1851416fc:…`, `git cat-file blob c4f6a31…`, em 9 provas). Por isso o `provas-sql` **mantém** o `fetch-depth: 0`.
- **`docs/` e `public/`**: nenhuma leitura. Os `public/anon/…` são roles SQL, e os ~100 `docs/…` estão em comentários.

## O desenho

O desenho segue o padrão do `mutcheck-escopo`: um job novo, `provas-sql-escopo` (checkout `fetch-depth: 2`, bun, sem `bun install`), roda `scripts/provas-sql-escopo.ts` e emite `roda=true|false`.

- **Allowlist do INERTE, não lista do que se lê.** O PR só pula se TODO arquivo do diff (merge commit pai 1 → HEAD, `--no-renames`) cai em `docs/`, `src/`, `public/` ou `.claude/`, e fora do que as provas leem lá dentro. Qualquer outra coisa roda: `db/`, `supabase/`, `scripts/`, `.github/`, arquivo de raiz, diretório novo.
- **As exceções são CALCULADAS a cada run**, sobre a árvore do PR, e não mantidas à mão. Entram (1) todo caminho sob `src/`, `public/` e `.claude/` citado em qualquer arquivo de `db/`, comentário incluído, e (2) o fecho de imports TS (`@/`, relativos, `import()`, `require`) a partir de todo `.ts` de `db/` e de todo `scripts/*.ts` citado em `db/`. Assim, uma prova nova que passe a ler `src/x` entra sozinha, sem lista para apodrecer e sem gate cobrando lista (regra de máquina-meta).
- **Concessão: `docs/` não entra na citação.** `db/` cita ~100 docs em comentário e nenhuma prova lê nenhum. Contá-los devolveria ao núcleo justamente o PR só de docs.
- **Fail-closed nas três pontas.** (1) O script nunca sai ≠ 0 e todo erro vira `roda=true`; evento fora de PR, diff ilegível, diff vazio ou mapa ilegível também rodam. (2) O `provas-sql` e a união têm `if: !cancelled() && needs.provas-sql-escopo.outputs.roda != 'false'`, então saída vazia roda. (3) O `validate` só aceita `skipped` nesses dois jobs com `evento=pull_request` + escopo `success` + `roda == 'false'` lidos juntos. O escopo entra no `needs` e no denominador (7 → 8), com guarda nominal própria.
- **A rede é a main.** Fora de PR roda tudo, e o auto-merge dispara um CI na main a cada merge. Uma leitura que escape do cálculo (caminho montado em variável, `find src/`) aparece no run da main e abre `ci-main-red`.

Na simulação sobre os 100 PRs mergeados até 2026-11-04 (árvore de hoje), **49 pulam**. Nenhum dos que tocavam só os prefixos inertes foi barrado por uma exceção calculada; os 51 que rodam tocam `db/`, `supabase/`, `scripts/`, `.github/` ou a raiz.

### Dois tropeços da entrega

- **O regex de citação nascia cego à forma mais comum.** A 1ª versão exigia que o caractere antes de `src/` não fosse `/`, e as provas citam caminho como `"$REPO_ROOT/src/…"`, justamente com `/` antes. A âncora sobre a árvore real passou mesmo assim, porque os mesmos arquivos também aparecem em prosa ou por import em outros lugares; foi o caso unitário com `$REPO_ROOT` que ficou vermelho, no local e no CI. Agora a âncora aceita `$VAR/`, `${VAR}/` e `$(…)/`, e vale também para `scripts/…` citado assim, que entra no fecho. Lição: âncora sobre a árvore real prova o CONJUNTO, não o MECANISMO; cada forma de citar precisa do seu caso.
- **O escopo é step OPACO de propósito.** Com nome no `package.json` (`provas-sql:escopo`) ele virou "gate novo" para o `exclusividade` (`GATE_NOVO_SEM_EXCLUSIVIDADE`: exigiria medição contra defeitos de algo que não reprova conteúdo). Ele é invocado como `bun ./scripts/provas-sql-escopo.ts …`, fora do censo de gates, e fica visível nos contadores de bloqueantes-sem-script dos dois gates, como o `bash db/roda-nucleo-ci.sh`.

## CI-GIT

O job `typecheck` passou para checkout raso. Ele só instala e roda os 2 `tsc` (`tsconfig.app.json` e `scripts:typecheck`), e nenhum dos dois lê git. O `fetch-depth: 0` existia pelo `sonda:bump`, que mora no `edges-e-build` desde o fan-out. O comentário no job explica o motivo dos outros jobs e diz que um step novo que leia git precisa devolver o `fetch-depth: 0`.

## Prova

- O script, sobre commits reais da main (`--base c^ --head c`): `4b218c8f5` (#3583, só docs) → `roda=false`; `fdbda4d9d` (#3580, `db/`+`supabase/`+`scripts/`) → `roda=true`; `7673f391b` (#3581, `vite.config.ts`) → `roda=true`.
- O step do `validate`, extraído do `ci.yml` real e rodado sob 14 cenários de `needs`: 2 controles positivos saem 0 (PR de docs pulado pelo escopo; PR de db com tudo `success`). Os outros 12 saem 1: escopo `failure`/`cancelled`/`skipped`, saída vazia, `roda=true` com provas puladas, `FALSE` em caixa alta, `roda=false` forjado em `push` e `workflow_dispatch`, provas vermelhas, união vermelha, e outro job pulado.
- Teste: `scripts/provas-sql-escopo.test.ts`, que inclui uma âncora sobre a árvore real (o cálculo acha as leituras que o mapa achou à mão).
- CI real: seção "Depois" abaixo.

## 2ª opinião (Codex)

Rodada única, focada em verde-falso: `scripts/codex-async.sh`, gpt-6-astra max, 299 s, 103.938 tokens, cota em 3%. **Veredito: APROVAR COM AJUSTES.**

1. **Verde-falso real no resolvedor de imports. Corrigido.** O resolvedor escolhia o 1º candidato e `.ts` ganhava de `.tsx`, mas o Bun prefere `.tsx`. Um PR que acrescentasse `src/lib/whatsapp/route-city.tsx` ao lado do `.ts` mudaria o que o oráculo de `db/test-venda-gerador.sh` carrega, e o escopo dava `roda=false`; o Codex reproduziu a decisão em memória. O conserto não escolhe candidato: o lido é a **base sem extensão** (casa `.ts`/`.tsx`/`.mts`/`.js`/`.json`, e `base/…` se for diretório), e o fecho segue **todos** os candidatos existentes. Há regressão no teste para o cenário dele e para o fecho por mais de um candidato.
2. **`validate`: sem bypass.** O Codex executou o shell real com 48 combinações de evento × resultado × saída; só a combinação autorizada aceitou os dois skipped. Re-run parcial preserva SHA e ref, e um `merge_group` futuro não autoriza o skip.
3. **Diff pai 1 → HEAD: não subestima.** As duas árvores são comparadas inteiras, com NUL e `--no-renames`; com merge de main dentro do PR, o checkout segue sendo o merge de teste.
4. **Concessão de `docs/`: aceita na árvore atual.** Ela precisa ser revista quando uma prova passar a consumir docs, e o Codex observa que a main roda depois do merge, não antes. O cabeçalho do script já prescreve isso.

## Depois (medido em PR real, pós-merge do #3585)

Mesmo método da linha de base (soma de `completedAt − startedAt` por job, `gh run view --json jobs`):

| PR só de docs | antes: #3583, run 41813445293 | depois: #3589, run 41831969943 |
|---|---|---|
| `provas-sql` + união | 102,9 runner-min (6 partes + união) | **0** (skipped; escopo 0,2 min) |
| run inteiro | 141,0 runner-min | **40,8** (−71%) |
| parede do run | 20,4 min | **8,4 min** (caminho crítico: `testes`) |

O log do `validate` no run 41831969943 diz `escopo das provas SQL: evento=pull_request resultado=success roda=false`, depois `⏭️ provas-sql` e `⏭️ provas-sql-uniao` pulados pelo escopo e `✅ os 8 jobs…`.

O lado que RODA, também em PR real pós-merge: #3588 (lote 10, `db/` + `supabase/migrations/`), run 41831842385. O escopo listou os 5 arquivos que as provas podem ler (`db/nucleo-ci.txt`, `db/test-fornecedores-classificacao.sh`, a migration, …), decidiu `RODA o núcleo inteiro` e as 6 partes rodaram. O próprio #3585 (`scripts/` + `.github/`) também rodou o núcleo.

Ressalva de método: são duas amostras, e o runner do GitHub varia ~45% (`medir-ganho-de-ci-sob-ruido.md`). O que esta tabela prova é estrutural, não estatístico: 6 jobs de ~16 min deixam de existir. A parede de 8,4 min tem o ruído normal do `testes`.
