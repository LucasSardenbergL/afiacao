# Foto RFB do Radar perto do teto (27m43s de 30 min em 17/11/2026) → aplicação em fatias

**Migration:** `supabase/migrations/20261120170000_radar_situacao_em_fatias.sql` · **Prova:**
`db/test-radar-situacao-fatias.sh` · **Fixture:** `db/fixtures/radar-situacao-pendente-prod-20261120.sql` (corpos
vivos, md5 `a99fd7db…` da pendente e `3b99d4dd…` da função de aplicação) · **Medição em prod:**
`db/2026-11-20-radar-situacao-tick-medido.sql` (só `--ensaio`).

## O sinal

O cron `radar-aplicar-situacao-diario` (06:05 UTC, `SET statement_timeout = '30min'`) roda em ~0,05 s todo dia. No
dia seguinte a cada lote mensal novo ele faz o trabalho de verdade. Em 17/11, com o lote 2026-11 (fechado em 16/11
21:30), levou **27m43s** e ficou a 92% do teto, no porte Mini. Foi o próximo job do Radar a chegar perto de estourar,
depois do score (`radar-score-timeout-fatias.md`).

## O que os 27 minutos regravam

Medido em prod, só leitura (psql-ro, 20/11):

| Medida | Valor |
|---|---:|
| Linhas de `radar_empresas` | 584.587 |
| Fotos regravadas em 17/11 (`fotos_atualizadas`) | 573.026 |
| Das quais mudaram situação ou data (2026-10 → 2026-11) | **9.924** |
| Só trocaram o rótulo `rfb_situacao_lote` (+ `updated_at`) | ~563.100 |
| Leads descartados / clientes alertados no mesmo lote | 6.233 / 59 |
| Índices de `radar_empresas` | 25 (1,48 GB com o heap de 731 MB) |
| `updated_at` indexado · fillfactor | sim · 100 |
| Reconciliação (o join inteiro do passo (a), só leitura) | 7,9 s |

O rótulo da foto aparece na tela, no selo RFB (`seloRfb`: "dump 2026-11"). A guarda que impede regredir para um lote
mais velho também lê esse rótulo, linha a linha. Pular as linhas que só mudam o rótulo mudaria o que o vendedor vê.
Como toda UPDATE ali troca `updated_at`, que é indexado, nenhuma é HOT e cada uma mexe nos 25 índices. No Mini isso
custa ~3 ms por linha num comando sequencial e ~5–6 ms em fatias (medido no score). Por isso não há teto que segure
um comando só.

## A decisão

Havia dois caminhos:

1. **Gravar só o que muda de situação** (`IS DISTINCT FROM` sem o rótulo). Cortaria ~98% da escrita, mas o selo da
   tela passaria a mostrar o dump em que a situação mudou pela última vez, não o mais novo. Isso muda o resultado.
2. **Fatias retomáveis com o mesmo resultado.** Foi o escolhido, no molde do score.

A `radar_aplicar_situacao` de prod fica **intacta** (sem DDL: as provas antigas e o tripwire de
`db/test-radar-situacao-contato-por-cnpj.sh` continuam valendo). Só a `radar_aplicar_situacao_pendente`, chamada
pelo cron, muda:

- **Faixas.** Uma passada percorre `radar_empresas` por faixas físicas de páginas (TID Range Scan). Cada faixa roda o
  passo (a) da função de prod recortado nela, com o mesmo `SET` e o mesmo predicado. A faixa é adaptativa (250
  páginas no início, mira 1–4 s), o orçamento é ~45 s por chamada e o cursor fica em `radar_situacao_passada`
  (1 linha, RLS, fechada).
- **Conclusão.** Quando o cursor chega ao fim, a chamada seguinte roda a função de prod inteira, como antes. O
  passo (a) dela vira a reconciliação: relê o join e grava só o que as faixas não cobriram (linha que outro escritor
  moveu para trás do cursor, linha inserida no meio). Depois vêm os descartes e o alerta, sem mudança. A marca em
  `radar_ingest_state` e o ledger `radar.aplicar_situacao` só saem aí. `fotos_atualizadas` soma faixas e
  reconciliação. Os leitores da marca (`radar_avisar_lote`, `cliente_situacao_receita`) não mudam.
- **Parcial** não marca nada e registra em `radar.aplicar_situacao_parcial` (fail-open).
- **Recomeço.** Passada de outro lote, de outro fechamento ou de outro arquivo físico recomeça do zero. Lote mais
  velho pendente continua superado, sem efeito.
- **Travas.** `lock_timeout 5s`: faixa ou conclusão que não pega a trava encerra a chamada com o que já fez, sem
  erro. Rodada concorrente → `adiado` (`pg_try_advisory_xact_lock`). Até 60 faixas com escrita por chamada (o
  limite de subtransações).
- **Cron.** De 5 em 5 min nos minutos 2, 7, …, 57, das 00 às 05 e das 07 às 10 UTC (21:00–02:57 e 04:00–07:57
  BRT). São as horas do `radar-score-recalcular-continua`, 2 min depois dele. `SET statement_timeout = '5min'`.
  Sem lote pendente, o tick lê só `radar_ingest_state` e não registra nada.

**O que muda de fato, e é só de tempo:** `updated_at` é o relógio de cada chamada, não um único das 06:05. No meio
da passada, as linhas já gravadas mostram a foto nova antes de os descartes saírem na conclusão. É de madrugada, e
o score e o agregado não leem `rfb_*`.

## Folga

- Por chamada: ≤ ~45 s de faixas, num teto de 5 min (~15%). A conclusão é a reconciliação (~8 s) mais os descartes.
  Num mês como novembro (6.233 descartes), ela fica perto de 1 min (~20% do teto).
- Por lote: ~573 mil linhas a ~5–6 ms ≈ 50–60 min de escrita ≈ 70–80 chamadas. A janela tem ~120 chamadas por dia,
  então o lote fecha numa madrugada. O aviso do lote (11:05 UTC) espera a marca. Se a passada não fechar em 30 h,
  ele sai assim mesmo, dizendo que a situação não foi aplicada (como antes).

## Prova

`db/test-radar-situacao-fatias.sh`, PG17, nos dois locales, 29 asserts e 14 sabotagens com controle verde na mesma
invocação. Ela parte dos corpos de prod (A0, md5), roda a predecessora numa chamada só numa cópia do banco e a passada
em fatias (10 páginas por chamada, orçamento 0) noutra. Depois compara componente por componente: fotos e
`updated_at`, contatos, alerta, `alertado_em`, marca e ledger (A1/A2b). Também cobre:

- a linha inserida depois das faixas, que só a conclusão vê (A5);
- o parcial que não marca (A3) e o no-op depois de aplicado (A4);
- o lote novo no meio, com o velho superado e a passada recomeçando (B7);
- trava de rodada (B9), de linha na faixa (B10), de linha na conclusão (B11) e da linha do lote via SKIP LOCKED (B13);
- o job (C1), a RLS e a ACL (D1/D2), o TID Range Scan via auto_explain (E1) e a PRE das duas funções (F1/F2).

## Quando medir de verdade

A próxima execução real é o lote 2026-12. Query (psql-ro):

```sql
SELECT acao, count(*), max(finalizado_em - iniciado_em) AS maior_chamada,
       sum((detalhes->>'fotos_nesta_rodada')::bigint) AS fotos_em_faixas
  FROM acoes_execucoes
 WHERE acao IN ('radar.aplicar_situacao', 'radar.aplicar_situacao_parcial') AND iniciado_em > now() - interval '3 days'
 GROUP BY acao;
SELECT start_time, end_time - start_time, status FROM cron.job_run_details d JOIN cron.job j USING (jobid)
 WHERE j.jobname = 'radar-aplicar-situacao-diario' ORDER BY start_time DESC LIMIT 20;
```

Sinal de que está bom: toda chamada abaixo de ~60 s, nenhuma `failed`, e a conclusão no mesmo dia do fechamento ou
no seguinte. Se ficar mais lento, o próximo corte é o caminho 1 (decisão de produto: o selo mostraria o dump da
última mudança).
