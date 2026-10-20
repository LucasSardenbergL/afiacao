# Radar: carga mensal automática + recruzamento diário de `ja_cliente` (bloco 1 do brainstorm, 2026-10-18)

**Problema:** o radar era uma foto de maio/2026 — um único lote (carga manual em 2026-06-11, 526.176 empresas), sem cron, sem GitHub Action, e `ja_cliente` só era recruzado no `finalize` de um lote. Cliente cadastrado no Omie fora do radar ficava na fila de prospecção como lead → duplicado no ERP.

**Prova de que mordia:** a 1ª execução do tick em prod (2026-10-19 02:23 UTC, 11 s) marcou **8** empresas que já eram clientes e estavam em `a_contatar` (ledger: `marcados=8`, `candidatos_antes=523.183`, `ja_cliente_total=3.001`).

## O que entrou

1. **Recruzamento diário (migration `20261019093000_radar_recruzamento_diario_cron.sql`, aplicada em prod).** `radar_recruzar_ja_cliente_tick()` (SECURITY DEFINER, ACL só postgres/service_role) chama a função original — que NÃO foi tocada: o `finalize` da edge continua chamando-a direto — e grava UMA linha em `acoes_execucoes` (slug `radar.recruzar_ja_cliente`, origem `automatica`) com denominador. Cron `radar-recruzar-ja-cliente-diario`, `15 6 * * *` = **03:15 BRT** (jobid 213). Erro da função original **propaga** (job_run_details `failed` com a mensagem real; a linha do ledger não sobrevive ao rollback — ausência de `sucesso` recente é o sinal); só a gravação do ledger é fail-open. Por que um tick e não `SELECT radar_recruzar_ja_cliente()` direto no cron: num cron SQL-local o `return_message` de um SELECT é só `1 row` — a contagem sumiria.
2. **Carga automática (`.github/workflows/radar-carga-mensal.yml`).** SONDA semanal (segunda 03:00 BRT), CARGA no máximo 1 mês por rodada. `scripts/radar/mes-alvo.ts` decide: janela `[M-2, M-1, M]` em Brasília, do mais antigo para o mais novo; **nunca regride** (mês ≤ último `complete` é descartado, mesmo com `forcar`); lote `running` com < 8 h não é atropelado (carga local em andamento); HEAD 404 em `Cnaes.zip` = não publicado, qualquer outro ≠ 200 = **erro** (nunca vira "nada a fazer" verde). `carga.ts` ganhou `RADAR_WORK_DIR` (o runner tem ~14 GB em `/`; o trabalho vai para `/mnt` com guarda de ≥ 40 GB livres), `RADAR_APAGAR_ZIPS=1` e `temp_directory` do DuckDB no diretório de trabalho (o spill ia para `.tmp` no cwd). Token/bases da RFB foram para `scripts/radar/rfb.ts` (compartilhado).
3. **Sensor na Sentinela: DESENHADO aqui, INSTALADO em 2026-10-20** — [radar-sentinela-lote-idade-e-recruzamento.md](radar-sentinela-lote-idade-e-recruzamento.md) (migration `20261020101636`; a referência do lote mudou para o ÚLTIMO dia do mês, ver lá).

## Camadas de deploy (quem faz o quê)

| Camada | Estado | Quem |
| --- | --- | --- |
| Migration do cron diário | ✅ aplicada pelo canal `postgres` (MCP), validada por `psql-ro` (2ª testemunha) | sessão |
| 1ª execução do tick | ✅ rodada em prod (8 marcados) | sessão |
| Secret `RADAR_CRON_SECRET` no GitHub (Settings → Secrets → Actions; valor = `CRON_SECRET` do Vault) | ⏳ | **founder** (o valor não passa pela sessão) |
| Workflow no default branch | ⏳ nasce no merge (o `workflow_dispatch` só existe depois disso) | auto-merge |
| 1ª carga em prod (`gh workflow run radar-carga-mensal.yml`) | ⏳ depois do secret + merge; ou a segunda-feira seguinte | founder ou sessão |
| Publish do Lovable | não precisa (zero mudança em `src/`) | — |

## Cadência da RFB (medida em 2026-10-18, PROPFIND no share público)

Pasta `YYYY-MM` aparece na 2ª semana do próprio mês: 2026-08 em 09/08, 2026-09 em 14/09, 2026-10 em 13/10. Dump de 2026-10: ~7,4 GB comprimidos (Estabelecimentos0 sozinho 2,1 GB; os outros nove ~330 MB; Empresas ~1,3 GB; Socios ~0,7 GB). Sonda ao vivo: `2026-10` → 200, `2026-11` → 404.

## Cabe no runner? (estimativa feita antes da 1ª execução — medição real na seção seguinte)

Repo público → ubuntu-latest 4 vCPU / 16 GB RAM / 6 h. Disco é o gargalo: o maior CSV descompactado passa de 10 GB e o saneamento (iconv + awk) faz cópia transitória → pico ~25 GB, impossível em `/` (~14 GB), ok em `/mnt` (~60 GB, **não garantido pela spec** → guarda `df` fail-closed antes de baixar). Tempo: download de 7,4 GB + 10 passadas de DuckDB + 527 POSTs — estimado em 2-4 h; `timeout-minutes: 350`. RAM: `final.jsonl` (526k linhas) é lido inteiro em memória (como no laptop). Se a 1ª execução estourar, a alternativa desenhada é um runner self-hosted/maior ou processar Empresas/Socios por partição (parecer Codex P0-5/P1-7).

## 1ª execução real — medida (run 39262699046, 2026-10-19 13:44 → 16:42 UTC, 2h58 de um teto de 5h50)

Secret `RADAR_CRON_SECRET` cadastrado pelo founder às 13:34 UTC; dispatch manual às 13:44. O seletor escolheu **2026-08** (o mais antigo pendente da janela, com só 2026-05 `complete`). Runner: 145 GB de disco, **86 GB livres** (`/mnt` é o mesmo filesystem de `/` nesse runner; a guarda de 40 GB passou com folga).

| Fase | Duração |
| --- | --- |
| Download + filtro de Estabelecimentos0 (2,1 GB) | 48 min |
| Os 10 zips de Estabelecimentos filtrados | 2h00 acumuladas |
| Empresas + Socios + join + normalização | 47 min |
| 502 POSTs (municípios + chunks + finalize) | 9m28s |

Resultado: lote **2026-08 `complete`**, `total_recebido=501.380`, `novos=27.466` (`primeira_vista_em` de hoje). 14 linhas com aspas desbalanceadas descartadas no saneamento (como na 1ª carga manual). `ja_cliente` 3.001 → 3.007: o `finalize` recruzou 6 empresas novas que já eram clientes.

**52.262 empresas ficaram com `ultimo_lote=2026-05`** (saíram do dump: fechadas ou mudaram de CNAE principal) e **continuam na fila de prospecção** — a lista não filtra por lote vigente. É o card "inéditos do lote"/foto vigente do bloco 2, e vale ser o próximo passo de produto: 1 em cada 10 leads da fila é foto velha.

Com o writer rodado 1× em prod, o check da Sentinela abaixo está **desbloqueado**.

## Falha visível

Job vermelho + e-mail do GitHub ao autor do último commit do schedule + `radar_ingest_state.status='error'`/`erro` quando a falha é na edge. **Não cobre ausência de execução** (schedule desativado após 60 dias sem commit, runner morto) — é o check da Sentinela abaixo.

## Sensor desenhado (instalado na parte 2, [radar-sentinela-lote-idade-e-recruzamento.md](radar-sentinela-lote-idade-e-recruzamento.md) — com a referência do lote no ÚLTIMO dia do mês)

`_data_health_compute` é arquivo QUENTE multi-sessão e exige recriar **duas** funções (`data_health_watchdog` + `fin_sync_heartbeat`, IN-list de sources) com pré-flight `pg_get_functiondef`. A regra "check de marcador só nasce DEPOIS do writer existir e ter rodado 1× em prod" vale para a carga mensal: o writer (a Action) só existe após o merge e ainda não rodou. Dois checks, para a próxima entrega:

- `radar_lote_idade` — `now() - to_date(max(mes_referencia) FILTER (WHERE status='complete'), 'YYYY-MM')` > 60 dias ⇒ degradado. Idade pela **referência do dump**, não por `finalizado_em` (reprocessar maio hoje faria a foto velha parecer nova — Codex P1-9).
- `radar_recruzamento_tick` — sem linha `sucesso` do slug `radar.recruzar_ja_cliente` nas últimas 48 h ⇒ degradado (cobre o erro propagado E o cron parado).

## Idempotência (confirmada no código da edge)

`chunk` faz upsert só com colunas cadastrais + `ultimo_lote` + `updated_at` (não toca `primeira_vista_em`/`ja_cliente`/`prospeccao_status`); `begin_lote` em re-run preserva `iniciado_em` → `novos` não regride; `finalize` recomputa por `count`. Rodar o mesmo mês 2× não duplica.

## Codex (desenho `max`, 223 s, 105k tokens) — o que mudou o desenho e o que ficou como follow-up

Mudaram: regressão de mês barrada no seletor; sonda semanal em ordem crescente (dia 20 + fallback de 2 meses pulava mês em silêncio); erro de sonda ≠ "nada a fazer"; guarda de disco medida em vez de assumir `/mnt`; `temp_directory` do DuckDB; lote `running` vivo não atropelado; propagação do erro mantida com o ledger como observador.

Follow-ups (fora deste bloco, pré-existentes ao desenho da ingestão): **CNPJ alfanumérico** (RFB emite desde jul/2026; CHECK `^[0-9]{14}$` na tabela, regex da edge e `montarCnpj` descartam — hoje 0 ocorrências nas fontes de cliente, medido); foto parcial/mistura de lotes (chunks escrevem direto, sem staging + publicação atômica); `complete` sem reconciliação de rejeitados; empresa que sai do dump fica na fila (a lista não filtra por `ultimo_lote` vigente — é o card "inéditos do lote" do bloco 2); concorrência SQL tick × finalize sem lock compartilhado (mesmo conjunto de linhas, row-lock espera; medir antes de serializar).

## Codex (código `max`, 192 s, 100k tokens) — 6 achados, 5 corrigidos no PR

Corrigidos: (P1) lote `running` vivo em QUALQUER mês bloqueia a seleção inteira (antes só o próprio mês — dois escritores disputariam `ultimo_lote`); (P1) timeout/5xx/429 na sonda sem nenhum 200 é ERRO, só "todas 404" vira "não publicado"; (P1) régua de regressão = lote mais NOVO conhecido de qualquer status (o `status` devolve só 3 lotes, e um `error` novo já tem chunks no acervo); (P2) sonda preguiçosa — só meses que passaram pelas guardas, parando no 1º disponível; (P2) `inputs.mes`/`forcar` entram por `env`, não interpolados no `run` (injeção de shell com o segredo no ambiente). Ficou documentado: (P2) retomada local recente preserva `iniciado_em` antigo → a guarda de 8 h a trata como órfã; corrigir exige um `atualizado_em` no `radar_ingest_state` (edge) — fora deste bloco.

## Provas

- `db/test-radar-recruzamento-diario.sh` (no `nucleo-ci.txt`, 13 asserts, `--falsificar` 8/8 vermelhas com controle verde; duas sabotagens são pegas pela própria postcondição da migration e as variantes `_sem_post` provam que o assert da suíte pega sozinho).
- `scripts/radar/mes-alvo.test.ts` (17) e `scripts/radar/carga-mensal-workflow.test.ts` (8, invariantes do YAML).
