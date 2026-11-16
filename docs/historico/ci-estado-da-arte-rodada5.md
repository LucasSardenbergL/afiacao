# CI/merge: estado da arte e encerramento da otimização (rodada 5, 2026-11-14)

**Só medição e decisão, sem mudança de CI.** Quinta e última rodada (Fable + Codex, com o mesmo
briefing) do programa "push→merge mais rápido sem perder cobertura" (#3804 … #3876, #3867, #3892).
Os dois pareceres concluíram, de forma independente: **com fila vazia o desenho já está no piso
físico, e nada grátis de 2025-26 se aplica.** O que sobra é capacidade em rajada.

## Medido (gh API, 14/11)

| Recorte | N | push→validate |
|---|---|---|
| Com provas, depois do #3892, fila ≤ 4 s | 2 (#3892, #3893) | 351 s, 358 s |
| Com provas, fila ≤ 19 s (#3862-#3893) | 6 | 351-409 s |
| Com provas, rajada (fila máx 51-718 s) | 12 | 437-1.139 s, mediana ~550 |
| Sem provas, só docs | 7 | 137-274 s (137-174 sem fila) |
| verde → squash | 26 | mediana 12 s (3-136) |

- **Job-min por run:** 108-120 com provas (36 jobs); 163-184 se toca `ci.yml` (39 jobs, com o
  mutation-check fora do `validate`); 2-3 em PR só de docs.
- **Um PR com provas ocupa 36 jobs:** dois PRs simultâneos já saturam o teto de 40.
- **Após o #3892:** N=2, abaixo do ruído de runner (60-130 s). Não dá para afirmar ganho; o
  objetivo do pin é evitar bloqueio (19,6 h no #3877), não acelerar o verde.

## Piso físico

Unidade indivisível `rls-has-role-initplan-classe` (279 s) + setup (~20 s) + escopo, agendamento e
`validate` (~30-60 s, estimado) ≈ **330-360 s** até o `validate`, mais os 12 s até o squash. O
medido (351-358 s) está a ~15-25 s disso. Sem provas, o piso é ~140 s.

**Referências publicadas:**
- [Linear, set/2026](https://linear.app/now/ci-bottleneck-reworked): espera de CI pouco acima de 5 min.
- [CircleCI 2025](https://circleci.com/landing-pages/assets/2025-state-of-software-delivery-report.pdf): mediana de workflow 2m43s, p75 8m07s.
- [Plaid](https://plaid.com/blog/merge-queue): fila de merge com mediana ~6 min.

O repo está na mesma ordem de grandeza, e o verde→squash de 12 s é melhor que qualquer merge
queue publicada. São workloads diferentes; isso não é ranking.

## Técnicas de ponta × repo

| Técnica | Veredito |
|---|---|
| Merge queue, batching, CI especulativo | Exige organização ([GitHub docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)) e somaria +6-7 min onde hoje há 12 s. Rejeição de [ci-merge-queue-bloqueada-repo-pessoal.md](ci-merge-queue-bloqueada-repo-pessoal.md) mantida. |
| Seleção preditiva / test impact | Troca completude por velocidade ([Develocity](https://docs.gradle.com/develocity/predictive-test-selection), [Stripe](https://stripe.dev/blog/selective-test-execution-at-stripe-fast-ci-for-a-50m-line-ruby-monorepo)). Viola "toda cobertura antes do merge"; o escopo conservador (`provas-sql` só com SQL, docs pulam 7 jobs) é o equivalente admissível. |
| Remote cache (Bazel, Nx) | O gargalo é a execução do PG, não o build. Rejeitado. |
| Banco por template ou snapshot | Já existe (#3863, [ci-provas-sql-initdb-template.md](ci-provas-sql-initdb-template.md)); snapshot carregado sem ganho ([ci-provas-sql-medicao-preparacao.md](ci-provas-sql-medicao-preparacao.md)). |
| Quarentena de testes flaky | Neutraliza falhas ([Trunk](https://docs.trunk.io/flaky-tests/quarantining)) e reduz proteção. Incompatível. |
| `concurrency` com `queue: max` (mai/2026) | Aceita 100 pendências ([changelog](https://github.blog/changelog/2026-05-07-github-actions-concurrency-groups-now-allow-larger-queues/)), sem slot nem prioridade a mais. Não resolve; "ceder a vez" segue vetado (#3865). |
| `tsgo` / toolchain nativa | Fora do caminho crítico, que é o SQL. Não agora. |
| Runner mais rápido / snapshot de VM | Único item que baixa o piso. Pago, e o ganho é estimado: um núcleo 1,5-1,9× mais rápido daria 279 s → ~150-200 s, se for CPU-bound. |

Fatiar a `rls-has-role-initplan-classe` daria no máximo 30-45 s, porque as partes seguintes já
estão em 265-295 s, e exige refazer a falsificação de uma prova de RLS. Não fazer sem incidente.

## Decisão

**Encerrada a otimização grátis.** Ordem do que resta (ganhos estimados):
1. **Grátis:** ticket ao GitHub Support pedindo teto 40→60 ([limites](https://docs.github.com/en/actions/reference/limits)). Cenário de −3 a −6 min em rajada, zero com fila vazia. É com o founder.
2. **Pago:** [Namespace](https://namespace.so/pricing.md), mantendo a conta pessoal. O plano
   Developer não tem mensalidade, mas **como capacidade fixa não é barato** (corrigido na rodada 7,
   abaixo: R$2-7 mil/mês no volume real); só um piloto de medição cabe em ~R$100. Fable propõe piloto só nas provas-sql
   de PR; Codex propõe capacidade complementar para o CI pós-merge (64 vCPU no Team = 16 runners de
   4 vCPU, que não substituem os 40). Medir antes de assinar.
3. **Pago:** GitHub Team (60 slots, US$4/usuário/mês). Risco alto na transferência: Lovable,
   secrets e apps. Só se o ticket for negado e o Namespace descartado.

## Gatilhos para reabrir (mensuráveis)

- Mediana push→validate com provas > 480 s em 20 PRs seguidos **com fila ≤ 10 s**, ou p50 sem fila > 8 min.
- Mais de 40% dos PRs com provas com fila máx > 120 s numa semana, ou p90 da maior espera > 460 s
  após ≥ 7 dias e ≥ 300 runs depois do #3892.
- Unidade indivisível > 330 s.
- O GitHub liberar merge queue ou larger runners para conta pessoal.

Para adotar qualquer mudança: melhora ≥ 10% no p90 push→validate, cobertura idêntica e intervalo p90
entre vereditos da main ≤ 65 min. Base da simulação de fila: [ci-fila-actions-decisao-nao-mexer.md](ci-fila-actions-decisao-nao-mexer.md).

## Rodada 6 (2026-11-16): merge em menos de 1 minuto?

**Não para todo PR.** O fixo do GitHub (agendar + `validate` + squash) já é 25-45 s, e o job que
manda em cada classe executa 87 s (docs, vitest de 122 arquivos), 215-243 s (sem SQL,
`falsificacao (1)`) e 269 s (com SQL). Recibo por tree-hash e cache geral são máquina meta sem
incidente; 100+ jobs curtos e runners maiores custam R$4-15 mil/mês sem chegar à meta. Só restou o
caminho rápido de PR só de docs (alvo ~55-65 s, em sessão própria) e a prática draft verde → ready
(`docs/agent/worktrees.md` §Disciplina de push, item 6).

## Rodada 7 (2026-11-16): inventário do que é grátis ou quase

Fable e Codex cruzaram todas as propostas das rodadas 1-6 com a `main`. Tudo com ganho comprovado
está feito; o `mutation-check` fora do `validate.needs` é decisão documentada (incidente #2380), não
lacuna. Decisões que faltavam escrever:

| Proposta | Decisão | Por quê (estimado) | Reabrir se |
|---|---|---|---|
| Imagem do CI pré-montada no GHCR (PG17, pgvector, locales) | **Não fazer** | −12 a +18 s com fila vazia (pode piorar); o risco de PGDG que ela cobria já foi coberto pelo pin do #3892; apt saudável custa 10-14 s ([ci-e20-apt-so-pgdg.md](ci-e20-apt-so-pgdg.md)) | apt passar de 60 s ou novo incidente de repositório com o pin ativo |
| Consolidar jobs com steps paralelos internos (`parallel`/`wait-all`, jun/2026) | **Não agora** | 0-18 s com fila vazia; em rajada ataca a mesma fila que o ticket 40→60, sem mexer no CI; risco médio de isolamento e propagação de falha | ticket negado **e** gatilho de fila acima disparado |
| Reduzir as ~179 mil chamadas `psql` por run ([medição](ci-provas-sql-medicao-preparacao.md)) | **Não fazer sem perfil novo** | 0-30 s com fila vazia, sem ganho comprovado; 3-7 dias; risco alto para transações, roles e asserts | unidade indivisível > 330 s com perfil mostrando o harness como causa |
| Namespace Developer como capacidade | **Não é "muito baixo custo"** | volume medido 09-16/11: 43.577 job-min em 7 dias (≈201 mil/mês). A US$0,006-0,012/min ([preços](https://namespace.so/pricing.md), lidos em 16/11): só provas-sql de PR ≈ R$2.000-4.000/mês; todo o CI ≈ R$6.650-13.300/mês. Teto de 32 vCPU = 8 runners de 4 vCPU | piloto de medição de até ~R$100 (10-40 runs) é compra: decisão do founder |
| Ticket ao Support 40→60 | **Enviado em 2026-11-14** pelo founder | — | registrar aqui a resposta |
