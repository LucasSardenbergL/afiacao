-- M-09 (plano 2026-09-05, Lote D): INSERT dos 2 logs do motor de reposição deixa de ser WITH CHECK (true)
--
-- Achado (segurança A1 · banco B09): reposicao_motor_run e reposicao_estoque_nao_confirmado_log têm
-- policy INSERT TO authenticated WITH CHECK (true) — qualquer customer logado (5.664 cadastros) pode
-- inserir pela API. reposicao_motor_run é a ÂNCORA da fila de atenção em /admin/reposicao/pedidos
-- (o "último recálculo"); um run forjado com run_id novo esvazia a fila de exceções e some com o aviso
-- "N fora da compra". Escrita forjada em sinal money-path.
--
-- Medido via psql-ro (2026-10-11):
--   * policies: *_ins = INSERT TO authenticated WITH CHECK (true); *_sel = cap_compras_ler (master).
--   * único writer em prod: public.gerar_pedidos_sugeridos_ciclo, SECURITY INVOKER — chamada pelo app
--     (AdminReposicaoPedidos, como o usuário logado) e pela edge gerar-pedidos-diario (service_role,
--     BYPASSRLS — não depende de policy). Por isso NÃO dá para só remover a policy: o recálculo pelo
--     app precisa dela.
--   * o 3º log da mesma RPC (reposicao_teto_cobertura_log) já exige private.cap_compras_ler no INSERT;
--     cap_compras_ler e cap_compras_escrever têm hoje o MESMO corpo (master-only, md5 86052d07…).
--
-- O que muda: o WITH CHECK passa a ser private.cap_compras_escrever(auth.uid()) — a capacidade de
-- ESCRITA em compras (FU4-E, 20260719120000). Master recalcula como antes; employee/customer passam a
-- receber 42501 ao inserir direto. Employee já não LIA estes logs (SELECT = cap_compras_ler), então o
-- recálculo pelo app nunca foi um fluxo de employee.
--
-- Aplicar: SQL Editor do Lovable (o arquivo traz a transação). Idempotente: DROP POLICY IF EXISTS +
-- CREATE. Reversão: recriar as 2 policies com WITH CHECK (true).
-- Prova: db/test-reposicao-logs-insert-cap-compras.sh (PG17, RLS sob SET ROLE authenticated + falsificação).

BEGIN;

DROP POLICY IF EXISTS reposicao_motor_run_ins ON public.reposicao_motor_run;
CREATE POLICY reposicao_motor_run_ins ON public.reposicao_motor_run
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.cap_compras_escrever((SELECT auth.uid()))));

DROP POLICY IF EXISTS estoque_nao_confirmado_log_ins ON public.reposicao_estoque_nao_confirmado_log;
CREATE POLICY estoque_nao_confirmado_log_ins ON public.reposicao_estoque_nao_confirmado_log
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.cap_compras_escrever((SELECT auth.uid()))));

-- Pós-condição: nenhuma policy INSERT/ALL permissiva com WITH CHECK (true) sobra nas 2 tabelas, e as
-- 2 policies novas citam a capacidade de escrita.
DO $post$
DECLARE v_abertas int; v_novas int;
BEGIN
  SELECT count(*) INTO v_abertas FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('reposicao_motor_run', 'reposicao_estoque_nao_confirmado_log')
     AND cmd IN ('INSERT', 'ALL') AND permissive = 'PERMISSIVE'
     AND (with_check IS NULL OR btrim(with_check) = 'true');
  SELECT count(*) INTO v_novas FROM pg_policies
   WHERE schemaname = 'public'
     AND policyname IN ('reposicao_motor_run_ins', 'estoque_nao_confirmado_log_ins')
     AND cmd = 'INSERT' AND with_check LIKE '%cap_compras_escrever%';
  IF v_abertas <> 0 OR v_novas <> 2 THEN
    RAISE EXCEPTION 'M09_POS_FALHOU abertas=% novas=%', v_abertas, v_novas;
  END IF;
END
$post$;

COMMIT;
