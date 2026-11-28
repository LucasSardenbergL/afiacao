-- ENVELOPE: reativa a compra de 5 SKUs Oben suspensos que entraram em RISCO DE FALTA (medição 2026-11-28, psql-ro).
-- Decisão do founder no chat (2026-11-28): "Sim, reative os 5".
--
-- Por quê: o lote bc8635a1 (2026-11-01, 156 SKUs, cobertura >= 180d pelo consumo de 12 meses) segurou a compra; em 27
-- dias 3 desses SKUs zeraram o estoque vendendo, e 2 ficaram com cobertura recente < 60 dias. A suspensão impedia o
-- motor de repor. Reativar só devolve a decisão ao motor (parâmetros normais); os outros 151 seguem suspensos.
--
--   8689966291  TINGIDOR UNIVERSAL CEDRO 100ML      saldo 0, 5 vendidas em 30d
--   11921548964 F ACAB FL20.6468.00LT               saldo 0, 1 vendida em 30d
--   12098385775 BASE BRIL 40 ACETINADO TRANSP WF     saldo 0, 2 vendidas em 30d (o motor segurou 4 un em 161 runs)
--   8689717622  FAPIX 423 SPRAY 14KG                saldo 3, 10 vendidas em 30d (~25d de cobertura)
--   8689966887  VERNIZ PU BRIL FB.6120.00L5         saldo 1, 2 vendidas em 30d (~45d)
--
-- Como rodar: bun run db:aplicar db/reativar-compra-suspensa-oben-risco-falta.sql [--ensaio]
--   (sem BEGIN/COMMIT: a transação é do executor). Re-aplicar aborta na PRE (os 5 já não estão ativos).
DO $env$
DECLARE
  v_alvo   constant bigint[] := ARRAY[8689966291, 11921548964, 12098385775, 8689717622, 8689966887]::bigint[];
  v_motivo constant text := 'risco de falta (medição 2026-11-28: estoque zerado ou cobertura recente < 60d com venda em 30d) — founder: "Sim, reative os 5"';
  v_ativas_alvo int; v_outras_antes int; v_outras_depois int; v_reativados int; v_ok int := 0; r record;
BEGIN
  SELECT count(*) INTO v_ativas_alvo FROM public.reposicao_compra_suspensa
   WHERE empresa = 'OBEN' AND reativado_em IS NULL AND sku_codigo_omie = ANY (v_alvo);
  IF v_ativas_alvo <> cardinality(v_alvo) THEN
    RAISE EXCEPTION 'PRE FALHOU: esperava % suspensões ATIVAS no alvo, achei % — algo já mudou (reativado na tela?)', cardinality(v_alvo), v_ativas_alvo;
  END IF;
  SELECT count(*) INTO v_outras_antes FROM public.reposicao_compra_suspensa
   WHERE empresa = 'OBEN' AND reativado_em IS NULL AND NOT (sku_codigo_omie = ANY (v_alvo));

  FOR r IN SELECT * FROM public.reposicao_compra_reativar('OBEN', v_alvo, v_motivo) LOOP
    RAISE NOTICE 'REATIVAR %|reativado=%|impedimento=%', r.sku_codigo_omie, r.reativado, coalesce(r.impedimento, '-');
    IF r.reativado THEN v_ok := v_ok + 1; END IF;
  END LOOP;

  -- PÓS: os 5 reativados com ESTE motivo, nenhum do alvo ainda ativo, e as outras suspensões intactas.
  SELECT count(*) INTO v_reativados FROM public.reposicao_compra_suspensa
   WHERE empresa = 'OBEN' AND sku_codigo_omie = ANY (v_alvo) AND reativado_em IS NOT NULL AND motivo_reativacao = v_motivo;
  IF v_ok <> cardinality(v_alvo) OR v_reativados <> cardinality(v_alvo) THEN
    RAISE EXCEPTION 'POS FALHOU: RPC reativou %, banco mostra % com o motivo, esperado %', v_ok, v_reativados, cardinality(v_alvo);
  END IF;
  IF EXISTS (SELECT 1 FROM public.reposicao_compra_suspensa WHERE empresa = 'OBEN' AND reativado_em IS NULL AND sku_codigo_omie = ANY (v_alvo)) THEN
    RAISE EXCEPTION 'POS FALHOU: SKU do alvo segue com suspensão ativa';
  END IF;
  SELECT count(*) INTO v_outras_depois FROM public.reposicao_compra_suspensa
   WHERE empresa = 'OBEN' AND reativado_em IS NULL AND NOT (sku_codigo_omie = ANY (v_alvo));
  IF v_outras_depois <> v_outras_antes THEN
    RAISE EXCEPTION 'POS FALHOU: suspensões fora do alvo mudaram (% -> %)', v_outras_antes, v_outras_depois;
  END IF;
  RAISE NOTICE 'COMPRA-SUSPENSA-REATIVAR-OK % reativados; % seguem suspensos', v_reativados, v_outras_depois;
END
$env$;
