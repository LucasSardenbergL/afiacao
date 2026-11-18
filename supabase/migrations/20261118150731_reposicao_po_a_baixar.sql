-- ============================================================
-- reposicao_po_a_baixar — fila "PO a baixar no Omie" (Fase 1 da baixa automática; SÓ LEITURA, nada vai ao Omie)
-- Spec: docs/superpowers/specs/2026-09-26-baixa-pedido-compra-nf-concluida-design.md §19.
--
-- Pedido do founder (2026-11-18): a NF de entrada é lançada (no Omie ou no app) e a equipe esquece de baixar o
-- pedido de compra (PO) no Omie. A API do Omie não encerra PO (§14); a Fase 1 é uma FILA ASSISTIDA, com dois tipos:
--
--   po_contado_com_nf — o motor de reposição CONTOU o PO como "a caminho" no último run válido
--                       (reposicao_po_observado_*, contribuição > 0) e o espelho já casou NF recebida a ele
--                       (purchase_orders_tracking.t4_data_recebimento). É o caso money-path: mercadoria que já
--                       entrou segue contada como pendente → o motor deixa de comprar. Pode ser parcial legítimo
--                       (o espelho guarda 1 NF por PO): a tela diz isso e a decisão é humana.
--   nf_pendente       — NF ainda pendente no Omie com proposta da sombra (associavel/ambigua/orfa) e SEM NF
--                       recebida no espelho. Ação: ao concluir no Omie, associar aos POs sugeridos.
--                       `evidencia_desatualizada` = a sombra não relê a NF há > 36 h (o cron só revisita ~3 dias
--                       — medido em 2026-11-18: 14 de 20 "pendentes" já estavam concluídas no espelho, por isso o
--                       espelho manda e a linha velha vem marcada, nunca afirmada como atual).
--
-- Fonte do "aberto" = o conjunto que o motor CONTOU, não o espelho: 201 POs de 2025 seguem "abertos" no espelho
-- só porque ninguém os relê (fora da janela da pesquisa) — ruído, não esquecimento.
-- Gate cron-or-staff NULL-aware, igual a reposicao_pos_candidatos (uid presente exige cap_compras_ler).
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.reposicao_po_a_baixar(p_empresa text)
RETURNS TABLE(
  tipo text,
  empresa text,
  numero_pedido text,
  omie_codigo_pedido bigint,
  fornecedor_nome text,
  unidades_contadas numeric,
  numero_nfe text,
  nid_receb bigint,
  nf_recebida_em timestamptz,
  classe text,
  motivos text[],
  pedidos_sugeridos text[],
  evidencia_em timestamptz,
  evidencia_desatualizada boolean,
  run_iniciado_em timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_empresa text := upper(btrim(coalesce(p_empresa, '')));
BEGIN
  -- ⚠️ IS NOT TRUE (não NOT(...)): NULL vira negado — fail-closed (ver reposicao_pos_candidatos).
  IF (SELECT auth.uid()) IS NOT NULL
     AND (SELECT private.cap_compras_ler((SELECT auth.uid()))) IS NOT TRUE THEN
    RAISE EXCEPTION 'reposicao_po_a_baixar: acesso negado' USING ERRCODE = '42501';
  END IF;
  IF v_empresa NOT IN ('OBEN', 'COLACOR') THEN
    RAISE EXCEPTION 'reposicao_po_a_baixar: empresa invalida (%)', p_empresa USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH run AS (
    SELECT r.run_id, r.iniciado_em
      FROM public.reposicao_po_observado_run r
     WHERE r.empresa = v_empresa AND r.varredura_completa AND r.pendente_aplicado
     ORDER BY r.iniciado_em DESC
     LIMIT 1
  ), contado AS (
    SELECT i.omie_codigo_pedido AS cod, max(i.numero_pedido) AS num, sum(i.contribuicao) AS unidades
      FROM run JOIN public.reposicao_po_observado_item i ON i.run_id = run.run_id
     WHERE i.exclusao IS NULL
     GROUP BY i.omie_codigo_pedido
    HAVING sum(i.contribuicao) > 0
  )
  SELECT 'po_contado_com_nf'::text, v_empresa,
         coalesce(p.numero_pedido, c.num), c.cod, p.fornecedor_nome, c.unidades,
         p.nfe_numero, p.nid_receb, p.t4_data_recebimento,
         NULL::text, NULL::text[], NULL::text[],
         run.iniciado_em, false, run.iniciado_em
    FROM contado c
    CROSS JOIN run
    JOIN public.purchase_orders_tracking p
      ON p.empresa::text = v_empresa AND p.omie_codigo_pedido = c.cod
   WHERE p.t4_data_recebimento IS NOT NULL
  UNION ALL
  SELECT 'nf_pendente'::text, v_empresa,
         NULL::text, NULL::bigint, NULL::text, NULL::numeric,
         s.numero_nfe, s.nid_receb, NULL::timestamptz,
         s.classe, s.motivos,
         (SELECT coalesce(array_agg(DISTINCT po.numero_pedido ORDER BY po.numero_pedido), ARRAY[]::text[])
            FROM public.purchase_orders_tracking po
           WHERE po.empresa::text = v_empresa
             AND po.omie_codigo_pedido > 0
             AND po.encerrado_omie_em IS NULL
             AND po.numero_contrato_fornecedor = ANY (s.contratos)),
         s.observado_em, s.observado_em < now() - interval '36 hours', NULL::timestamptz
    FROM public.recebimento_associacao_sombra s
   WHERE s.empresa = v_empresa
     AND s.estado_nf = 'pendente'
     AND s.classe IN ('associavel', 'ambigua', 'orfa')
     AND NOT EXISTS (SELECT 1 FROM public.purchase_orders_tracking pr
                      WHERE pr.empresa::text = v_empresa
                        AND pr.nid_receb = s.nid_receb
                        AND pr.t4_data_recebimento IS NOT NULL);
END
$fn$;

COMMENT ON FUNCTION public.reposicao_po_a_baixar(text) IS
  'Fila "PO a baixar no Omie" (só leitura): po_contado_com_nf (motor conta a caminho PO cuja NF já entrou) e nf_pendente (NF pendente no Omie com proposta da sombra). Spec baixa-pedido-compra §19.';

REVOKE ALL ON FUNCTION public.reposicao_po_a_baixar(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reposicao_po_a_baixar(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.reposicao_po_a_baixar(text) TO authenticated, service_role;

DO $post$
DECLARE
  v_fn oid := to_regprocedure('public.reposicao_po_a_baixar(text)');
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: reposicao_po_a_baixar(text) nao existe';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: reposicao_po_a_baixar sem SECURITY DEFINER (staff veria 0 linhas por RLS)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn
                   AND proconfig @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: reposicao_po_a_baixar sem search_path fixo (SECURITY DEFINER sequestravel)';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: anon tem EXECUTE em reposicao_po_a_baixar';
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: authenticated sem EXECUTE em reposicao_po_a_baixar (a tela quebraria)';
  END IF;
  RAISE NOTICE 'POSTCONDICAO OK: reposicao_po_a_baixar SECURITY DEFINER, search_path fixo, anon sem EXECUTE';
END
$post$;

COMMIT;
