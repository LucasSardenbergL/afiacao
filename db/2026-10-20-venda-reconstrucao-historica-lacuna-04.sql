-- Venda por cliente (Task 4) — reconstrução histórica da linha de base, LACUNA 04: 2025-12-19 .. 2026-01-07 (20 dias).
-- Trecho sem prova de sync da Oben (sem vendas_sync_cursor): os desfechos fecham pela PROVA POR DADOS
-- (private.venda_mes_completo_por_dados — 100% dos pedidos com itens + volume ≥ 70% da mediana de 12 meses).
-- Aplicar SÓ DEPOIS de supabase/migrations/20261020194332_venda_cliente_historico_prova_dados.sql:
--   bun run db:aplicar db/2026-10-20-venda-reconstrucao-historica-lacuna-04.sql
-- Envelope: idempotente (ON CONFLICT DO NOTHING), transação do executor, postcondição abaixo (aborta sem a prova).
DO $pre$
BEGIN
  IF to_regprocedure('private.venda_mes_completo_por_dados(text,date)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: prova por dados ausente — aplique 20261020194332 antes (senão a lacuna fecha nao_medivel para sempre)';
  END IF;
END
$pre$;

SELECT public.venda_reconstruir_historico(DATE '2025-12-19', DATE '2026-01-07');

DO $post$
DECLARE
  v_dias int;
  v_div  int;
BEGIN
  SELECT count(*) INTO v_dias FROM public.venda_gerador_execucao
   WHERE fase = 'historico' AND dia_referencia BETWEEN DATE '2025-12-19' AND DATE '2026-01-07';
  IF v_dias IS DISTINCT FROM 20 THEN
    RAISE EXCEPTION 'R1 FALHOU: % de 20 dias do lote registrados em venda_gerador_execucao', v_dias;
  END IF;
  SELECT count(*) INTO v_div FROM public.venda_gerador_execucao e
   WHERE e.fase = 'historico' AND e.dia_referencia BETWEEN DATE '2025-12-19' AND DATE '2026-01-07'
     AND e.linhas <> (SELECT count(*) FROM public.venda_sugestao s
                       WHERE s.fase = 'historico' AND s.tipo = 'recompra' AND s.dia_referencia = e.dia_referencia);
  IF v_div IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'R2 FALHOU: % dias com contagem registrada diferente das linhas gravadas', v_div;
  END IF;
  RAISE NOTICE 'lacuna 04 OK: 20 dias';
END
$post$;
