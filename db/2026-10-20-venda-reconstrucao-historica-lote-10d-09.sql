-- Venda por cliente (Task 4) — reconstrução histórica da linha de base, lote 10d-09: 2026-08-30 .. 2026-09-08 (10 dias).
-- Gera a lista D-1 de cada dia passado com fase='historico' (só pedidos anteriores ao dia) e fecha os desfechos.
-- Aplicar: bun run db:aplicar db/2026-10-20-venda-reconstrucao-historica-lote-10d-09.sql
-- Envelope: idempotente (ON CONFLICT DO NOTHING na chave da espinha), transação do executor, postcondição abaixo.
-- Pré-requisito: supabase/migrations/20261020181743_venda_cliente_gerador.sql aplicada (recibo #597).
-- Lote de 10 dias: os de 20 dias subiram de 196 s a 246 s (teto do db:aplicar: 300 s) conforme o volume.
-- Trecho 2026-01-22 em diante: janelas 100% cobertas pelo sync de vendas das duas empresas (a lacuna de
-- prova da Oben, 2025-07-01 → 2026-01-21, fica para depois da decisão do founder sobre o backfill).
SELECT public.venda_reconstruir_historico(DATE '2026-08-30', DATE '2026-09-08');

DO $post$
DECLARE
  v_dias int;
  v_div  int;
BEGIN
  SELECT count(*) INTO v_dias FROM public.venda_gerador_execucao
   WHERE fase = 'historico' AND dia_referencia BETWEEN DATE '2026-08-30' AND DATE '2026-09-08';
  IF v_dias IS DISTINCT FROM 10 THEN
    RAISE EXCEPTION 'R1 FALHOU: % de 10 dias do lote registrados em venda_gerador_execucao', v_dias;
  END IF;
  SELECT count(*) INTO v_div FROM public.venda_gerador_execucao e
   WHERE e.fase = 'historico' AND e.dia_referencia BETWEEN DATE '2026-08-30' AND DATE '2026-09-08'
     AND e.linhas <> (SELECT count(*) FROM public.venda_sugestao s
                       WHERE s.fase = 'historico' AND s.tipo = 'recompra' AND s.dia_referencia = e.dia_referencia);
  IF v_div IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'R2 FALHOU: % dias com contagem registrada diferente das linhas gravadas', v_div;
  END IF;
  RAISE NOTICE 'lote 10d-09 OK: 10 dias';
END
$post$;
