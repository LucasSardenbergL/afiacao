# Foto RFB do Radar perto do teto (27m43s de 30 min em 17/11/2026) → aplicação em fatias

**Migrations:** `supabase/migrations/20261120170000_radar_situacao_em_fatias.sql` (recibo db:aplicar #1224) e
`20261120180000_radar_situacao_fatias_guc.sql` (a correção abaixo) · **Prova:**
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

- **Fatias por CNPJ.** Uma passada percorre os CNPJs do próprio lote em `radar_situacao_cadastral`, pelo PK
  `(cnpj, lote)` e em ordem. Cada fatia roda o passo (a) da função de prod recortado nela, com o mesmo `SET` e o
  mesmo predicado. O cursor é o último CNPJ feito, e não a posição física (ver o parecer do Codex abaixo). A fatia é
  adaptativa (1.000 CNPJs no início, mira 1–4 s), o orçamento é ~45 s por chamada e o cursor fica em
  `radar_situacao_passada` (1 linha, RLS, fechada). Medido em prod: 5.000 CNPJs lidos em 2,7 s a frio, com nested
  loop nos dois PKs (~0,55 ms por linha de leitura, contra 3–6 ms da escrita).
- **Conclusão.** Quando o cursor chega ao fim, a chamada seguinte roda a função de prod inteira, como antes. O
  passo (a) dela vira a reconciliação: relê o join (7,9 s em prod) e grava só a linha que entrou em `radar_empresas`
  depois de o cursor passar pelo CNPJ dela. Depois vêm os descartes e o alerta, sem mudança. A marca em
  `radar_ingest_state` e o ledger `radar.aplicar_situacao` só saem aí, e `fotos_atualizadas` soma fatias e
  reconciliação. Os leitores da marca (`radar_avisar_lote`, `cliente_situacao_receita`) não mudam.
- **Parcial** não marca nada e registra em `radar.aplicar_situacao_parcial` (fail-open).
- **A passada termina no lote dela.** Se um lote mais novo fecha no meio, ele espera. O resultado é o da predecessora
  rodada quando a passada começou, seguida do lote novo. Sem passada, a regra é a de antes: só o lote complete mais
  novo é aplicado e o pendente mais velho é superado, sem efeito. O "mais novo" é lido no mesmo snapshot das linhas
  pendentes. Passada cujo lote foi re-finalizado recomeça.
- **Travas.** `lock_timeout 5s`: fatia ou conclusão que não pega a trava encerra a chamada com o que já fez, sem
  erro. Rodada concorrente → `adiado` (`pg_try_advisory_xact_lock`). Linha do lote da passada travada (SKIP LOCKED)
  → a passada fica e nenhuma outra abre. Até 60 fatias com escrita por chamada (o limite de subtransações).
- **Cron.** De 5 em 5 min nos minutos 2, 7, …, 57, das 00 às 05 e das 07 às 10 UTC (21:00–02:57 e 04:00–07:57
  BRT). São as horas do `radar-score-recalcular-continua`, 2 min depois dele. `SET statement_timeout = '5min'`.
  Sem lote pendente, o tick lê só `radar_ingest_state` e não registra nada.

**O que muda de fato, e é só de tempo:** `updated_at` é o relógio de cada chamada, não um único das 06:05. No meio
da passada, as linhas já gravadas mostram a foto nova antes de os descartes saírem na conclusão. Os descartes e o
alerta leem o estado do instante da conclusão (já-cliente, status do lead), como a predecessora leria se rodasse
naquele instante. É de madrugada, e o score e o agregado não leem `rfb_*`.

## Parecer do Codex (challenge, gpt-6.2-astra, 115 s)

A 1ª versão usava cursor físico (TID Range Scan, como o score). O parecer achou dois ALTOs reais, e ela foi refeita:

| Achado | Veredito | O que mudou |
|---|---|---|
| ALTO 1: lote novo no meio da passada → a passada era abandonada e parte das empresas ficava com a foto do lote velho, um estado que a predecessora nunca produz | aceito | a passada termina no lote dela; prova B7b contra a predecessora aplicando os dois lotes em sequência, com CNPJs ausentes do lote novo dos dois lados do cursor |
| ALTO 5: o score regrava ~500 mil linhas nas mesmas madrugadas, e o UPDATE não-HOT dele move linhas para trás do cursor físico. A reconciliação herdaria dezenas de milhares de linhas e estouraria o teto em toda tentativa | aceito | cursor por CNPJ: movimento físico não importa. Prova A5: um escritor move TODAS as linhas ainda não feitas no meio da passada, e a conclusão grava só 1 linha |
| ALTO 2 (herdado): `max(mes_referencia)` lido antes do `FOR` → lote que fechasse entre os dois comandos era marcado superado por um mais velho, sem efeito | aceito | o "mais novo" sai do mesmo snapshot do `FOR`. Sem prova: não há como forçar a corrida de forma determinística |
| MÉDIO 3: VACUUM FULL zerava a contagem | resolvido | sem cursor físico, não há `filenode` |
| MÉDIO 4: descartes e alerta leem o estado da conclusão | aceito como semântica | documentado acima |
| MÉDIO 6: trava persistente vira parcial repetida | aceito, sem mudança | cada parcial fica no ledger `radar.aplicar_situacao_parcial`, e o aviso de 30 h continua de rede |
| MÉDIO 7: `service_role` executa a função de aplicação direto, fora da trava | herdado, sem mudança | nenhum chamador direto em prod (a edge deixou de chamar em 27/10) |
| MÉDIO 8: os 2 min de defasagem não isolam do score | aceito, sem mudança | sobreposição custa no máximo outra passada de score (só leitura) ou uma trava de 5 s, nunca um resultado errado |
| MÉDIO 9: B10b/B11b fracos | aceito | B10b exige 0 linha pendente nas fatias feitas; B11c compara o estado inteiro com a predecessora |
| BAIXO 10: GUC enorme estoura `integer` | aceito | GUC limitada a 1–100.000 |

## A medição em prod pegou o que a prova não via

Logo depois do apply da 20261120170000, o `db/2026-11-20-radar-situacao-tick-medido.sql` em ensaio (ROLLBACK)
mostrou **40.578 fatias numa chamada de 45 s**, uma por CNPJ. A trava da GUC de tamanho (Codex BAIXO 10) era
`LEAST(100000, GREATEST(1, NULLIF(…)::integer))`. Sem a GUC, que é o caso do cron, isso dá **1**, porque `GREATEST` e
`LEAST` ignoram NULL. A fatia ficava fixa em 1 e não adaptava. A prova definia a GUC em toda chamada, então o caminho
de prod ficou fora dela. Não houve efeito: nenhum lote pendente entre os dois applies. A 20261120180000 troca só essa
linha por um `CASE` (ausente → NULL → adaptativo). A prova ganhou G1, uma chamada sem a GUC em que a 1ª fatia tem
1.000 CNPJs, e a sabotagem que devolve a expressão velha fica vermelha nela.

**Lição:** a prova tem de exercer o caminho EXATO do chamador de prod. Aqui é o cron sem GUC, e não só a GUC que
facilita o teste. `GREATEST`/`LEAST` com argumento possivelmente NULL é fabricação silenciosa, da família de
`Number(null) === 0`.

## Folga

- Por chamada: ≤ ~45 s de fatias, num teto de 5 min (~15%). A conclusão é a reconciliação (~8 s) mais os descartes.
  Num mês como novembro (6.233 descartes), ela fica perto de 1 min (~20% do teto).
- Por lote: ~573 mil linhas a ~5–6 ms ≈ 50–60 min de escrita, mais ~5 min de leitura ≈ 70–90 chamadas. A janela tem
  ~120 chamadas por dia, então o lote fecha numa madrugada. O aviso do lote (11:05 UTC) espera a marca. Se a passada
  não fechar em 30 h, ele sai assim mesmo, dizendo que a situação não foi aplicada (como antes).

## Prova

`db/test-radar-situacao-fatias.sh`, PG17, nos dois locales, 34 asserts e 17 sabotagens com controle verde na mesma
invocação. Ela parte dos corpos de prod (A0, md5), roda a predecessora numa chamada só numa cópia do banco e a passada
em fatias (100 CNPJs por chamada, orçamento 0) noutra, com um escritor que move de página todas as linhas ainda não
feitas. Depois compara componente por componente: fotos e `updated_at`, contatos, alerta, `alertado_em`, marca e
ledger (A1/A2b). Também cobre:

- a linha inserida depois de o cursor passar, que só a conclusão vê (A5);
- o parcial que não marca (A3) e o no-op depois de aplicado (A4);
- o lote novo no meio: a passada termina no dela, e o estado é o da predecessora com os dois lotes em sequência
  (B7a/B7b); sem passada, o mais velho é superado (B8);
- trava de rodada (B9), de linha na fatia (B10), da linha do lote via SKIP LOCKED (B13/B13b) e de linha na
  conclusão (B11), com o estado final igual ao da predecessora (B11c);
- o job (C1), a RLS e a ACL (D1/D2), o PK do cursor via auto_explain (E1) e a PRE das duas funções (F1/F2).

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
