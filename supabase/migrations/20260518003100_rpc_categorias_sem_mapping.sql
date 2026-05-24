CREATE OR REPLACE FUNCTION public.fin_categorias_sem_mapping(
  p_company text, p_start date, p_end date
) RETURNS TABLE (omie_codigo text, categoria_nome text, valor_periodo numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH cat AS (
    SELECT categoria_codigo AS omie_codigo,
           categoria_descricao AS categoria_nome,
           SUM(COALESCE(valor_documento,0)) AS valor
      FROM fin_contas_receber
     WHERE company = p_company AND data_emissao BETWEEN p_start AND p_end
       AND categoria_codigo IS NOT NULL
     GROUP BY 1, 2
    UNION ALL
    SELECT categoria_codigo, categoria_descricao, SUM(COALESCE(valor_documento,0))
      FROM fin_contas_pagar
     WHERE company = p_company AND data_emissao BETWEEN p_start AND p_end
       AND categoria_codigo IS NOT NULL
     GROUP BY 1, 2
  ), aggregated AS (
    SELECT omie_codigo, MAX(categoria_nome) AS categoria_nome, SUM(valor) AS valor_periodo
      FROM cat GROUP BY omie_codigo
  )
  SELECT a.omie_codigo, a.categoria_nome, a.valor_periodo
    FROM aggregated a
    LEFT JOIN fin_categoria_dre_mapping m
      ON (m.company = p_company OR m.company = '_default')
     AND m.omie_codigo = a.omie_codigo
   WHERE m.id IS NULL
     AND a.valor_periodo > 0
   ORDER BY a.valor_periodo DESC;
$$;

GRANT EXECUTE ON FUNCTION public.fin_categorias_sem_mapping(text, date, date)
  TO authenticated, service_role;
