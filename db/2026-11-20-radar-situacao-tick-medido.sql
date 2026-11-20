-- Medição em PRODUÇÃO das duas chamadas da passada em fatias (20261120170000), para rodar SÓ em ensaio:
--   bun run db:aplicar db/2026-11-20-radar-situacao-tick-medido.sql --ensaio
-- Dentro da transação do ensaio (ROLLBACK no fim, nada fica gravado), o lote complete mais novo volta a ficar
-- pendente. A 1ª chamada faz as fatias sobre os CNPJs REAIS do lote; como o lote já foi aplicado, elas gravam 0
-- linha e medem a leitura e o orçamento. A 2ª chamada faz a conclusão inteira: a função de prod relê o
-- join (reconciliação), descarta e alerta (0 linhas: tudo já aplicado). Pós-condição: as duas chamadas não foram
-- adiadas, a 1ª ficou abaixo de 60 s, a 2ª concluiu sem gravar foto e abaixo de 120 s.
-- Rodar fora dos minutos :02–:03 das horas 00–05 e 07–10 UTC (o cron). docs/historico/radar-situacao-timeout-fatias.md
SET LOCAL statement_timeout = '5min';
DO $tick$
DECLARE
  v_lote text;
  v_t0   timestamptz;
  r1     jsonb;
  r2     jsonb;
  d1     interval;
  d2     interval;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc
       WHERE oid = to_regprocedure('public.radar_aplicar_situacao_pendente(timestamptz)'))
     IS DISTINCT FROM '02af26b119ebda4f9bacfe32b42a3349' THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_aplicar_situacao_pendente vivo não é o da 20261120170000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.radar_situacao_passada) THEN
    RAISE EXCEPTION 'PRE FALHOU: há passada real em curso — medir agora misturaria com ela';
  END IF;
  SELECT max(mes_referencia) INTO v_lote FROM public.radar_ingest_state WHERE status = 'complete';
  UPDATE public.radar_ingest_state SET situacao_aplicada_fechamento = NULL
   WHERE mes_referencia = v_lote AND status = 'complete';

  v_t0 := clock_timestamp();
  r1 := public.radar_aplicar_situacao_pendente();
  d1 := clock_timestamp() - v_t0;
  v_t0 := clock_timestamp();
  r2 := public.radar_aplicar_situacao_pendente();
  d2 := clock_timestamp() - v_t0;
  RAISE NOTICE 'MEDIDO fatias: % em % · conclusão: % em %', r1, d1, r2, d2;

  IF r1 ? 'adiado' OR r2 ? 'adiado' THEN
    RAISE EXCEPTION 'MEDIÇÃO FALHOU: chamada adiada (% / %)', r1->>'adiado', r2->>'adiado';
  END IF;
  IF NOT (r1 ? 'parcial') OR d1 > interval '60 seconds' THEN
    RAISE EXCEPTION 'MEDIÇÃO FALHOU: 1ª chamada não foi parcial ou passou de 60 s (%, %)', r1, d1;
  END IF;
  IF (r2->>'aplicados') IS DISTINCT FROM '1' AND (r2 #>> '{parcial,interrompido}') IS DISTINCT FROM 'orcamento' THEN
    RAISE EXCEPTION 'MEDIÇÃO FALHOU: 2ª chamada nem concluiu nem continuou as faixas (%)', r2;
  END IF;
  IF (r2->>'aplicados') = '1' AND ((r2 #>> '{lotes,0,passada,fotos_nas_fatias}') IS DISTINCT FROM '0'
                                   OR (r2 #>> '{lotes,0,passada,fotos_na_conclusao}') IS DISTINCT FROM '0') THEN
    RAISE EXCEPTION 'MEDIÇÃO FALHOU: a re-aplicação de um lote já aplicado gravou foto (%)', r2;
  END IF;
  IF d2 > interval '120 seconds' THEN
    RAISE EXCEPTION 'MEDIÇÃO FALHOU: 2ª chamada levou %', d2;
  END IF;
END
$tick$;
