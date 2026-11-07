# fin-cashflow-engine: uma carga de dados para os 3 cenários (plano v7, lote 1 — D10)

**Data:** 2026-11-05 · **Edge:** `fin-cashflow-engine` v2.2 → **v2.3-carga-unica-cenarios** · **Migration:** `20261105160000_fin_cashflow_cron_carga_unica.sql`

## O incidente

Em 05/11 o snapshot de caixa da colacor saiu **sem o cenário realista** (`fin_projecao_snapshots`:
otimista + pessimista). `net._http_response` das 10:05Z: HTTP 500
`Leitura de fin_titulo_baixas_cr_mapa falhou (código 57014)`. Cada job do cron disparava **3
chamadas por empresa** (uma por cenário), e cada chamada fazia a carga inteira — CR/CP paginados,
prazos, estoque e o mapa de baixas (~3,9 s com spill de temp na colacor, sob o `statement_timeout`
de 8 s). Três mapas concorrentes por empresa. Recorrência: 10 dias com menos de 3 cenários entre
10 e 20/10 (antes do escalonamento por empresa, `20261020120100`) e de novo em 05/11.
`_shared/baixas-cr.ts` falhou fechado, como devia (ausente ≠ zero): o cenário sumiu, não saiu errado.

## O que mudou

- **Edge (v2.3):** novo input `cenarios: [...]`, exclusivo com `cenario` e validado antes de
  qualquer leitura (vazio, repetido, desconhecido ou misturado → 400 sem efeito). A carga é
  **uma** por invocação (preguiçosa, memoizada) e cada cenário roda o MESMO `calcularComDados` do
  caminho de cenário único, em série, cada um no seu `comRegistro` — a série de `acoes_execucoes`
  continua com 1 registro por combo. Falha isolada por cenário (um INSERT recusado não leva os
  outros); qualquer falha → HTTP 500 com o detalhe por cenário. **Sem retry:** a persistência é
  INSERT. O caminho `cenario` único (usado pela tela) não mudou.
- **Cron:** os 3 jobs (mesmos nomes e horários) fazem **1 chamada por empresa** com os 3 cenários.
  A migration tem **pré-condição de ordem**: a atestação mais recente da edge em
  `deploy_atestacoes` tem de ser a v2.3 — a v2.2 ignora `cenarios` e gravaria só o realista com
  HTTP 200.
- **Cortado (plano):** cache do mapa por empresa/dia (frescor e invalidação num caminho
  financeiro). `work_mem` local segue experimento, não causa provada.

## Provas

- **Paridade pelo HANDLER** (`supabase/functions/fin-cashflow-engine/multi-cenario_test.ts`): um
  PostgREST falso serve a MESMA fixture (700 CR, 260 CP, mapa de baixas, eventos, alertas ativos)
  às 3 chamadas de cenário único (o caminho de antes) e a 1 chamada `cenarios`. Iguais: resposta
  de cada cenário, linha gravada em `fin_projecao_snapshots` por cenário e a SEQUÊNCIA completa
  de escritas (registro, snapshot, INSERT/UPDATE/dismiss de alerta). A fixture se prova não
  trivial antes (os 3 cenários divergem, há curva calibrada, rodam os ramos INSERT e UPDATE de
  alerta). Carga: cada leitura sai 1× na multi contra 3× nas 3 chamadas (o mapa de baixas, 1×).
  `deno test` da edge: **50 passed, 0 failed, RC=0**.
- **Falsificação da edge** (controle verde e uma sabotagem por vez na mesma invocação): carga sem
  memo, cálculo que muta `dados`, cenário errado no laço, `cenario`+`cenarios` aceito, laço que
  para no 1º cenário falho — cada uma deixa a suíte vermelha.
- **PG17 da migration** (`db/test-fin-cashflow-cron-carga-unica.sh --falsificar`): 7 casos (sem
  atestação, v2.2, v2.3 aplica, idempotência, v2.2 por cima da v2.3, rollback só na janela viva,
  empate de `observado_em` decidido por `request_id`) e 6 sabotagens vermelhas —
  `FALSIFICACAO_OK`, exit 0.
- **Codex** (`scripts/codex-async.sh`, high): sem mutação de `dados` e paridade válida. **APROVAR
  COM AJUSTES**, todos aplicados: (1) a fixture usava `saldo_data` com hora (o classificador exige
  `YYYY-MM-DD`; a suíte caía antes de registrar os casos); (2) a pré-condição lia só o ledger e
  aceitaria uma v2.3 antiga logo depois de um rollback ainda não coletado → agora ledger + janela
  viva, com desempate por `request_id` (a mesma leitura de `scripts/pendencias-deploy.ts`); (3) o
  isolamento estava descrito como total: carga e morte da invocação passaram a ser falhas
  COMPARTILHADAS entre os cenários — é o preço da carga única, e está escrito no código.
- Fora do escopo (o Codex mediu, sem provar risco): CPU/wall-clock da invocação multi na colacor.
  Os 3 cálculos são lineares (sem CR×CP), e a carga pesada passa a sair 1×. A medida vem do 1º
  ciclo: `Server-Timing` da resposta e a duração em `acoes_execucoes`.

## Deploy (conferido por `psql-ro` em 2026-11-06 14:25Z)

1. **Merge** do #3646 em 2026-11-06 05:05Z (`eafa6b21f`).
2. **Edge v2.3 no ar:** `bun run pendencias:deploy` → `fin-cashflow-engine` **CONFERE**. A sonda
   atestou `v2.3-carga-unica-cenarios` em 11:37Z, com a fonte (`e166b1bd…`) igual à da main.
3. **Migration do cron:** `db_aplicacoes` #915, `aplicada` às 12:17Z, pelo `db:aplicar`, depois da
   atestação (a PRE exige isso). O sha256 (`6bf63202…`) bate com o arquivo da main. Conferência
   por fora: os 3 jobs com `company` certa, os 3 cenários, `timeout_milliseconds := 120000` e
   nenhum `FOREACH`.
4. **Ciclo de 06/11:** rodou ANTES do deploy (10:00–10:10Z, v2.2, 9 chamadas, 9 sucessos) e
   tem os 3 cenários nas 3 empresas. Não prova o caminho novo.
5. **1º ciclo pelo caminho novo: 07/11, 10:00/10:05/10:10Z.** Pronto quando a query abaixo
   der 3 empresas × 3 cenários, 9 registros `sucesso` e 3 respostas HTTP 200 da v2.3 com
   `resultados` (uma por empresa):

```sql
select company, string_agg(cenario, ',' order by cenario), count(*)
  from fin_projecao_snapshots
 where (snapshot_at at time zone 'America/Sao_Paulo')::date = date '2026-11-07'
 group by 1 order by 1;
select status, count(*) from acoes_execucoes
 where acao = 'fin_cashflow.snapshot_diario' and iniciado_em >= '2026-11-07 10:00Z' group by 1;
select status_code, content::jsonb->>'versao', content::jsonb ? 'resultados', length(content::text)
  from net._http_response where created >= '2026-11-07 10:00Z' and created < '2026-11-07 10:20Z'
   and content::text like '%"versao":"v2.%' order by created;
```

## 1º ciclo pelo caminho novo — 07/11 ✅ (conferido por `psql-ro` às 12:30Z, exit 0)

- `fin_projecao_snapshots`: 3 empresas × 3 cenários (`otimista,pessimista,realista`, 3 cada).
- `acoes_execucoes`: 9 `sucesso`, 0 `erro`, um registro por combo como antes.
- `net._http_response`: **3** respostas (eram 9), HTTP 200, `v2.3-carga-unica-cenarios`, com
  `resultados`. O `cron.job_run_details` dos 3 jobs: `succeeded`.
- Coerência: NCG e tesouraria IGUAIS nos 3 cenários de cada empresa (não dependem de cenário). O
  saldo da semana 13 fica em otimista > realista > pessimista nas 3. O NCG contra 06/11:
  colacor −0,2%, colacor_sc +4,5%, oben +5,2%.
- A carga única medida: o 1º cenário de cada empresa leva a carga (colacor **6,9 s**, oben 1,8 s,
  colacor_sc 0,9 s) e os outros dois, ~0,1 s cada. Antes eram 3 cargas concorrentes de ~7 s por
  empresa.

**Pendente fora desta entrega:** o realista da colacor de 05/11 segue ausente. Pelo plano, ele é
refeito só para o cenário que falta, sem re-rodar o cron em lote.
