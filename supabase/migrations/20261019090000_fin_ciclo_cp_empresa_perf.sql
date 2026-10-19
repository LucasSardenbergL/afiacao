-- ============================================================
-- Ciclo financeiro — frente 4, follow-up de performance: fin_ciclo_cp_empresa() sem varreduras redundantes.
-- Prova: db/test-fin-ciclo-fornecedor.sh (PG17, controle verde + falsificação, 2 locales) — aplica a
-- 20261018150000 e ESTA por cima.
--
-- Medido em prod (2026-10-19, psql-ro, \timing por CTE; RPC inteira ~2,25-4,2 s sob authenticated+master):
--   - `empresas` varria v_titulo_baixas (CP) só para DISTINCT company (~0,8 s) e `eng` varria DE NOVO (~0,75 s);
--   - `vol` passava pelo v_ciclo_fornecedor_resumo inteiro (títulos+nomes+pagas+abertos, ~0,5 s) só para
--     somar compras_12m.
-- Mudança (resultado IDÊNTICO, só o caminho):
--   - `vol` soma direto de fin_contas_pagar × v_ciclo_cp_compras_categorias com o MESMO filtro do CTE
--     `volume` do resumo (Σ por fornecedor = Σ por empresa: cada chave do `volume` aparece uma vez em `chaves`);
--   - `eng` faz UMA varredura do CP inteiro: o prazo NULL sai pelo FILTER (não pelo WHERE), então a linha
--     da empresa existe mesmo sem prazo — e `empresas` = fin_contas_pagar ∪ eng, o mesmo conjunto de antes.
-- CREATE OR REPLACE preserva o ACL (REVOKE PUBLIC/anon da 20261018150000); a postcondição re-confere.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fin_ciclo_cp_empresa()
RETURNS TABLE(company text, pmp_compras_pond numeric, compras_12m numeric, rs_por_dia numeric,
              pmp_engine_controle numeric, n_fora_lista int, valor_fora_lista numeric,
              n_sem_categoria int, valor_sem_categoria numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._fin_ciclo_gate_master();
  RETURN QUERY
  WITH hoje AS (SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS h),
  -- Uma varredura do CP: a linha existe para toda empresa com baixa CP (é o lado v_titulo_baixas de
  -- `empresas`); o controle só pondera as baixas com prazo.
  eng AS (
    SELECT b.company,
           round(sum(b.prazo_ponderado_dias * b.valor_baixado) FILTER (WHERE b.prazo_ponderado_dias IS NOT NULL)
                 / nullif(sum(b.valor_baixado) FILTER (WHERE b.prazo_ponderado_dias IS NOT NULL), 0)) AS pmp_engine_controle
      FROM public.v_titulo_baixas b
     WHERE b.tipo = 'CP'
     GROUP BY b.company
  ),
  empresas AS (
    SELECT DISTINCT p.company FROM public.fin_contas_pagar p
    UNION SELECT eng.company FROM eng
  ),
  pmp AS (
    SELECT t.company,
           sum(t.valor_documento * t.prazo_real_dias) / nullif(sum(t.valor_documento), 0) AS pmp_compras_pond
      FROM public.v_ciclo_cp_titulos t
     WHERE t.situacao = 'paga' AND t.data_baixa_confiavel
     GROUP BY t.company
  ),
  -- Mesmo filtro do CTE `volume` do resumo por fornecedor (competência por EMISSÃO, base válida, universo).
  vol AS (
    SELECT p.company, sum(p.valor_documento) AS compras_12m
      FROM public.fin_contas_pagar p
      JOIN public.v_ciclo_cp_compras_categorias l
        ON l.company = p.company AND l.categoria_codigo = p.categoria_codigo
      CROSS JOIN hoje
     WHERE p.status_titulo IS DISTINCT FROM 'CANCELADO'
       AND p.valor_documento IS NOT NULL AND p.valor_documento <> 'NaN'
       AND p.valor_documento < 'Infinity' AND p.valor_documento > 0
       AND p.data_emissao IS NOT NULL AND p.data_vencimento IS NOT NULL
       AND p.omie_codigo_cliente_fornecedor IS NOT NULL
       AND p.data_emissao >= hoje.h - 365 AND p.data_emissao < hoje.h
     GROUP BY p.company
  ),
  sensor AS (
    SELECT p.company,
           count(*) FILTER (WHERE p.categoria_codigo LIKE '2.01.%' AND l.categoria_codigo IS NULL)::int AS n_fora_lista,
           -- Título com valor NULL no conjunto → soma desconhecida (NULL), nunca R$ 0; conjunto vazio → 0.
           CASE WHEN bool_or(p.valor_documento IS NULL) FILTER (WHERE p.categoria_codigo LIKE '2.01.%' AND l.categoria_codigo IS NULL) THEN NULL
                ELSE coalesce(sum(p.valor_documento) FILTER (WHERE p.categoria_codigo LIKE '2.01.%' AND l.categoria_codigo IS NULL), 0) END AS valor_fora_lista,
           count(*) FILTER (WHERE nullif(btrim(p.categoria_codigo), '') IS NULL)::int AS n_sem_categoria,
           CASE WHEN bool_or(p.valor_documento IS NULL) FILTER (WHERE nullif(btrim(p.categoria_codigo), '') IS NULL) THEN NULL
                ELSE coalesce(sum(p.valor_documento) FILTER (WHERE nullif(btrim(p.categoria_codigo), '') IS NULL), 0) END AS valor_sem_categoria
      FROM public.fin_contas_pagar p
      LEFT JOIN public.v_ciclo_cp_compras_categorias l
        ON l.company = p.company AND l.categoria_codigo = p.categoria_codigo
      CROSS JOIN hoje
     WHERE p.status_titulo IS DISTINCT FROM 'CANCELADO'
       AND p.data_emissao >= hoje.h - 365 AND p.data_emissao < hoje.h
     GROUP BY p.company
  )
  SELECT e.company, pmp.pmp_compras_pond, vol.compras_12m,
         CASE WHEN vol.compras_12m > 0 THEN vol.compras_12m / 365 END,
         eng.pmp_engine_controle,
         -- sem linha no sensor = nenhum título em 12 m → 0 legítimo; com linha, o NULL do sensor é preservado.
         coalesce(s.n_fora_lista, 0), CASE WHEN s.company IS NULL THEN 0 ELSE s.valor_fora_lista END,
         coalesce(s.n_sem_categoria, 0), CASE WHEN s.company IS NULL THEN 0 ELSE s.valor_sem_categoria END
    FROM empresas e
    LEFT JOIN pmp    ON pmp.company = e.company
    LEFT JOIN vol    ON vol.company = e.company
    LEFT JOIN eng    ON eng.company = e.company
    LEFT JOIN sensor s ON s.company = e.company
   WHERE public.fin_user_can_access(e.company);
END
$$;

-- Postcondição: o REPLACE não pode ter mexido no ACL nem no SECURITY DEFINER.
DO $post$
DECLARE f constant text := 'public.fin_ciclo_cp_empresa()';
BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure) THEN
    RAISE EXCEPTION 'postcondicao: % sem SECURITY DEFINER', f;
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: anon executa %', f;
  END IF;
  IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: authenticated nao executa %', f;
  END IF;
  IF position('v_ciclo_fornecedor_resumo' IN pg_get_functiondef(f::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'postcondicao: % ainda passa pelo resumo', f;
  END IF;
  RAISE NOTICE 'CICLO-CP-EMPRESA-PERF-OK';
END
$post$;

COMMIT;
