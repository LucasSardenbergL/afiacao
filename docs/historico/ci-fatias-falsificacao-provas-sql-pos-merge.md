# CI: pós-merge que calava, fatias da falsificação e do núcleo SQL (J0–J3 do plano v2) — 2026-10-18

Item 3 do [plano de melhoria v2](../superpowers/plans/2026-10-18-plano-melhoria-v2/README.md) (§2, J0–J3).
Arquivos quentes: `.github/workflows/ci.yml`, `.github/workflows/auto-merge.yml`, `package.json`.
Mudança em CI não é money-path — Codex opcional, não consultado (`Codex: desenho=n/a · código=? · extra=nenhum`).

## Baseline (medida ANTES, runs de PR de 2026-10-18 — `gh run view --json jobs`)

| Job | 39169562475 (sem fila) | 39167870221 | 39169583037 (com fila) |
|---|---|---|---|
| `falsificacao` | 14,9 min | 15,0 | 16,3 (fila 8 min) |
| `provas-sql (1..4)` | 11,3 / 12,6 / 8,4 / 10,9 | 10,2 / 15,3 / 8,9 / 11,2 | 11,0 / 15,3 / 7,0 / 10,8 |
| `testes` · `edges-e-build` · `gates-e-falsificacao` | 6,9 · 4,5 · 4,9 | 5,3 · 6,1 · 5,9 | 6,9 · 5,7 · 5,2 |
| **`validate` verde (desde o início do run)** | **15,7 min** | **16,0** | **25,6** |

Dentro do `falsificacao` (log por cabeçalho de suíte, run 39169583037): `codex-async` **5,4 min**,
`fecho-edges-pendentes` **4,1 min**, `read-contexto-nudge` 52 s, `setup-contrato`+`medir-footprint`+`pr-watch` 47 s,
`claude-mem-reanimar` 40 s, `codex-prompt-paginacao` 33 s, `claude-mem-saude` 32 s; os outros 20 alvos + `sonda-cron-prova`
somam ~3 min. Dentro do `provas-sql` (duração impressa por prova, 146 unidades): núcleo 10,1 / 12,1 / 7,8 / 10,4 min;
preâmbulo (checkout + PGDG) ~30 s por parte; a prova mais cara é `test-hoje-sp-views-defaults --falsificar` (310 s).

## J0 — pós-merge dependia do workflow INTEIRO

`ci-na-main-pos-merge` exigia `workflow_run.conclusion == 'success'`. `mutation-check` é informativo (fora de
`validate.needs`, abre Issue), mas um vermelho dele deixa o workflow `failure`: o auto-merge mergeia (só espera o
required `validate`) e o pós-merge era PULADO — sem CI na main justamente no PR em que algo falhou.
**Correção:** o `if` aceita `success` **ou** `failure` (cancelled/skipped seguem fora: não há `validate` verde a
procurar), e o step lê pela API a conclusão do **job `validate`** do run (`gh api .../runs/$RUN_ID/jobs`),
exigindo `success` positivo — ausente/`null`/outro = "não disparo", com notice. A query foi exercitada à mão:
run 39169583037 → `success`, run 39174194051 → `failure`.
**Prova pendente (só pós-merge):** o `workflow_run` usa o `auto-merge.yml` da **main**, então a mudança só vale depois
do merge. Nos 55 últimos runs de PR com `conclusion=failure` nenhum tinha `validate=success` (sem exemplar histórico
do laço). A prova é o 1º run futuro com `mutation-check=failure` + `validate=success` cujo `ci-na-main-pos-merge`
termine `success` — `gh run list --workflow auto-merge.yml --event workflow_run`.

## J1 — `provas-sql`: 4 → 6 partes (medido e simulado, não "a olho")

O round-robin do `db/roda-nucleo-ci.sh` é por POSIÇÃO; o custo não. Simulação com os custos medidos sobre a ordem do
manifesto: N=4 → MAX 12,1 min · **N=5 → 14,6** (as caras se alinham) · **N=6 → 6,4 / 6,8 / 8,9 / 7,5 / 2,6 / 8,1 (MAX 8,9)**
· N=7 → 11,3. Reordenar `db/nucleo-ci.txt` para balancear foi descartado: a ordem lá é a dos **eixos** (ordem de dano).
Conteúdo dos `db/test-*.sh` intocado. Custo: +2 runners de ~30 s de preâmbulo por run.

## J2 — `falsificacao` em 3 fatias ESTÁTICAS, todas obrigatórias

`test:falsificacao:1` (codex-async + codex-async-nuvem + 3 leves ≈ 5,8 min) · `:2` (fecho-edges-pendentes +
read-contexto-nudge + codex-prompt-paginacao + 2 leves ≈ 5,7) · `:3` (os 18 leves + `sonda-cron-prova` ≈ 4,4).
Estática porque duas peças pesadas e muitas leves não se balanceiam por posição. O job `falsificacao` vira matriz
`parte: [1,2,3]` com UM step por fatia (`if: matrix.parte == k` → `bun run test:falsificacao:k`); nome do job e
`validate.needs` iguais (o guard `viu_falsificacao` segue valendo; `esperados=7` idem). NÃO foi para main/schedule.

- `test:falsificacao` (laço inteiro) **continua**: é o que se roda no laptop, o que `falsificar-exige-assert-gate.ts`
  (`ROTEIRO`) e `falsificacao-cobertura.test.ts` leem, e a **definição** da partição.
- `scripts/falsificacao-cobertura.test.ts` ganhou o bloco "fatias do CI": união das fatias = roteiro, nenhum alvo em
  duas, o comando fora do laço em exatamente uma, e `ci.yml` com matriz 1..N e `if` casado com o script da fatia.
  Parte que não roda não reprova nada — aqui a prova é estática. **Falsificado** (controle verde 17/17; 5 sabotagens,
  cada uma vermelha na asserção que declara: alvo fora das fatias · alvo em duas · `if` trocado · matriz sem a 3ª ·
  `sonda-cron-prova` fora; controle final verde).
- **Por que nomes novos e não `env:`** — o `exclusividade` assina argv+env literal e exige UMA assinatura por gate
  (`AMBIGUA` com duas; `NAO-REPRODUZIVEL` com `${{ }}`). As 3 fatias entram em `exclusividade-matriz.json` como
  `dispensados` (motivo: fatias do `test:falsificacao`, medido em 8 linhas; a união é a invocação medida) e no censo
  de `docs/agent/deploy.md` (33 → 35 gates). `bun run exclusividade` e `gates:frescura` verdes localmente.

## J3 — medido NO PR (preencher no corpo do PR)

Pronto = `validate` ≤ 12 min no PR. Projeção sem fila: caminho crítico `provas-sql` 8,9 + 0,5 (preâmbulo) + união ≈
10 min; `falsificacao` ≈ 6,5. Jobs por run: 15 → 18 (fila sob o teto de 20 simultâneos do plano Free é o risco a medir).
