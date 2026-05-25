-- ============================================================
-- P1 RLS fix (Fase 1) — gate de autorização no corpo de 4 RPCs SECURITY DEFINER financeiras
-- ============================================================
-- Problema: estas 4 funções são SECURITY DEFINER (bypassam RLS) e estavam
-- concedidas a `authenticated` SEM gate de role no corpo → qualquer customer
-- logado podia ler DRE consolidado / estoque / confiabilidade das 3 empresas
-- chamando supabase.rpc() direto. (anon já estava revogado em migrations anteriores.)
--
-- Fix: adiciona gate como PRIMEIRA instrução do corpo. Matriz (revisada via codex):
--   * por-empresa (categorias_sem_mapping, estimar_estoque_omie):
--       service_role OR fin_user_can_access(p_company)   -- granular por empresa
--   * cross-company / escrita (consolidado_intercompany, calcular_confiabilidade):
--       service_role OR staff (employee/master)          -- sem permissão granular
--
-- Notas de segurança:
--   * service_role é permitido porque fin-suggest-mapping (edge) chama
--     fin_categorias_sem_mapping como service_role, e calcular_confiabilidade
--     é job batch. Sem isso, sync/cron quebra.
--   * COALESCE(..., false) em cada termo: auth.role() pode ser NULL → sem
--     COALESCE o IF NOT (NULL) NÃO entra no THEN = fail-open.
--   * #variable_conflict use_column (antes do BEGIN) nas 3 convertidas de
--     LANGUAGE sql → plpgsql, por causa de OUT params homônimos das colunas.
--   * NÃO mexe em GRANTs (snapshot --no-privileges não confirma estado real;
--     re-grant à toa reabriria superfície). Só CREATE OR REPLACE do corpo.
--   * Idempotente: CREATE OR REPLACE preservando assinatura e RETURNS TABLE.
-- ============================================================

-- ------------------------------------------------------------
-- 1) fin_calcular_confiabilidade(text,int,int) — plpgsql, ESCREVE. Gate: service_role OR staff.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_calcular_confiabilidade(p_company text, p_ano integer, p_mes integer)
RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_inicio date;
  v_fim date;
  v_result jsonb;
  v_total_cr integer;
  v_total_cp integer;
  v_total_mov integer;
  v_cr_sem_cat integer;
  v_cp_sem_cat integer;
  v_pct_conciliado numeric;
  v_mov_sem_titulo integer;
  v_dre_mapped integer;
  v_dre_heuristic integer;
  v_dre_total integer;
  v_pct_valor_map numeric;
  v_fech_status text;
  v_fech_versao integer;
  v_ultimo_sync timestamptz;
BEGIN
  IF NOT (
    COALESCE(auth.role() = 'service_role', false)
    OR COALESCE(public.has_role(auth.uid(), 'employee'::public.app_role), false)
    OR COALESCE(public.has_role(auth.uid(), 'master'::public.app_role), false)
  ) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;

  v_inicio := make_date(p_ano, p_mes, 1);
  v_fim := v_inicio + interval '1 month';

  -- Contagens
  SELECT COUNT(*) INTO v_total_cr FROM fin_contas_receber
    WHERE company = p_company AND data_vencimento >= v_inicio AND data_vencimento < v_fim;
  SELECT COUNT(*) INTO v_total_cp FROM fin_contas_pagar
    WHERE company = p_company AND data_vencimento >= v_inicio AND data_vencimento < v_fim;
  SELECT COUNT(*) INTO v_total_mov FROM fin_movimentacoes
    WHERE company = p_company AND data_movimento >= v_inicio AND data_movimento < v_fim;

  -- Sem categoria
  SELECT COUNT(*) INTO v_cr_sem_cat FROM fin_contas_receber
    WHERE company = p_company AND data_vencimento >= v_inicio AND data_vencimento < v_fim
    AND (categoria_codigo IS NULL OR categoria_codigo = '');
  SELECT COUNT(*) INTO v_cp_sem_cat FROM fin_contas_pagar
    WHERE company = p_company AND data_vencimento >= v_inicio AND data_vencimento < v_fim
    AND (categoria_codigo IS NULL OR categoria_codigo = '');

  -- Conciliação
  SELECT COALESCE(
    100.0 * COUNT(*) FILTER (WHERE conciliado) / NULLIF(COUNT(*), 0), 0
  ) INTO v_pct_conciliado FROM fin_movimentacoes
    WHERE company = p_company AND data_movimento >= v_inicio AND data_movimento < v_fim;

  SELECT COUNT(*) INTO v_mov_sem_titulo FROM fin_movimentacoes
    WHERE company = p_company AND data_movimento >= v_inicio AND data_movimento < v_fim
    AND omie_codigo_lancamento IS NULL;

  -- DRE mapping coverage
  SELECT
    COUNT(*) FILTER (WHERE m.id IS NOT NULL),
    COUNT(*) FILTER (WHERE m.id IS NULL),
    COUNT(*)
  INTO v_dre_mapped, v_dre_heuristic, v_dre_total
  FROM (
    SELECT DISTINCT categoria_codigo FROM fin_contas_receber
      WHERE company = p_company AND data_vencimento >= v_inicio AND data_vencimento < v_fim AND categoria_codigo != ''
    UNION
    SELECT DISTINCT categoria_codigo FROM fin_contas_pagar
      WHERE company = p_company AND data_vencimento >= v_inicio AND data_vencimento < v_fim AND categoria_codigo != ''
  ) cats
  LEFT JOIN fin_categoria_dre_mapping m
    ON (m.company = p_company OR m.company = '_default') AND m.omie_codigo = cats.categoria_codigo;

  -- Valor mapeado vs total
  WITH vals AS (
    SELECT categoria_codigo, SUM(valor_documento) AS val FROM fin_contas_receber
      WHERE company = p_company AND data_vencimento >= v_inicio AND data_vencimento < v_fim GROUP BY 1
    UNION ALL
    SELECT categoria_codigo, SUM(valor_documento) AS val FROM fin_contas_pagar
      WHERE company = p_company AND data_vencimento >= v_inicio AND data_vencimento < v_fim GROUP BY 1
  )
  SELECT COALESCE(
    100.0 * SUM(CASE WHEN m.id IS NOT NULL THEN v.val ELSE 0 END) / NULLIF(SUM(v.val), 0), 0
  ) INTO v_pct_valor_map
  FROM vals v
  LEFT JOIN fin_categoria_dre_mapping m
    ON (m.company = p_company OR m.company = '_default') AND m.omie_codigo = v.categoria_codigo;

  -- Fechamento
  SELECT status, versao INTO v_fech_status, v_fech_versao
  FROM fin_fechamentos
  WHERE company = p_company AND ano = p_ano AND mes = p_mes
  ORDER BY versao DESC LIMIT 1;

  -- Último sync
  SELECT MAX(completed_at) INTO v_ultimo_sync FROM fin_sync_log
  WHERE p_company = ANY(companies) AND status = 'complete';

  -- Upsert
  INSERT INTO fin_confiabilidade (
    company, ano, mes,
    total_cr, total_cp, total_mov,
    cr_sem_categoria, cp_sem_categoria,
    pct_mov_conciliado, mov_sem_titulo,
    dre_categorias_mapeadas, dre_categorias_heuristica, dre_categorias_total,
    pct_valor_mapeado,
    fechamento_status, fechamento_versao,
    ultimo_sync, calculated_at
  ) VALUES (
    p_company, p_ano, p_mes,
    v_total_cr, v_total_cp, v_total_mov,
    v_cr_sem_cat, v_cp_sem_cat,
    v_pct_conciliado, v_mov_sem_titulo,
    v_dre_mapped, v_dre_heuristic, v_dre_total,
    v_pct_valor_map,
    COALESCE(v_fech_status, 'sem_fechamento'), COALESCE(v_fech_versao, 0),
    v_ultimo_sync, now()
  )
  ON CONFLICT (company, ano, mes) DO UPDATE SET
    total_cr = EXCLUDED.total_cr,
    total_cp = EXCLUDED.total_cp,
    total_mov = EXCLUDED.total_mov,
    cr_sem_categoria = EXCLUDED.cr_sem_categoria,
    cp_sem_categoria = EXCLUDED.cp_sem_categoria,
    pct_mov_conciliado = EXCLUDED.pct_mov_conciliado,
    mov_sem_titulo = EXCLUDED.mov_sem_titulo,
    dre_categorias_mapeadas = EXCLUDED.dre_categorias_mapeadas,
    dre_categorias_heuristica = EXCLUDED.dre_categorias_heuristica,
    dre_categorias_total = EXCLUDED.dre_categorias_total,
    pct_valor_mapeado = EXCLUDED.pct_valor_mapeado,
    fechamento_status = EXCLUDED.fechamento_status,
    fechamento_versao = EXCLUDED.fechamento_versao,
    ultimo_sync = EXCLUDED.ultimo_sync,
    calculated_at = now();

  RETURN jsonb_build_object(
    'company', p_company, 'ano', p_ano, 'mes', p_mes,
    'total_cr', v_total_cr, 'total_cp', v_total_cp, 'total_mov', v_total_mov,
    'pct_conciliado', v_pct_conciliado,
    'pct_valor_mapeado', v_pct_valor_map,
    'categorias_heuristica', v_dre_heuristic,
    'fechamento', COALESCE(v_fech_status, 'sem_fechamento')
  );
END;
$$;

-- ------------------------------------------------------------
-- 2) fin_categorias_sem_mapping(text,date,date) — sql→plpgsql. Gate: service_role OR fin_user_can_access(p_company).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_categorias_sem_mapping(p_company text, p_start date, p_end date)
RETURNS TABLE(omie_codigo text, categoria_nome text, valor_periodo numeric)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
#variable_conflict use_column
BEGIN
  IF NOT (
    COALESCE(auth.role() = 'service_role', false)
    OR COALESCE(public.fin_user_can_access(p_company), false)
  ) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil financeiro' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
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
END;
$$;

-- ------------------------------------------------------------
-- 3) fin_consolidado_intercompany(int,int) — sql→plpgsql, CROSS-company. Gate: service_role OR staff.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_consolidado_intercompany(p_ano integer, p_mes integer)
RETURNS TABLE(conta text, total_bruto numeric, eliminacoes numeric, total_consolidado numeric)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
#variable_conflict use_column
BEGIN
  IF NOT (
    COALESCE(auth.role() = 'service_role', false)
    OR COALESCE(public.has_role(auth.uid(), 'employee'::public.app_role), false)
    OR COALESCE(public.has_role(auth.uid(), 'master'::public.app_role), false)
  ) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH dre_all AS (
    SELECT 'receita_bruta'::text AS conta, COALESCE(SUM(receita_bruta), 0) AS total
      FROM fin_dre_snapshots
     WHERE ano = p_ano AND mes = p_mes AND regime = 'competencia'
    UNION ALL
    SELECT 'cmv', COALESCE(SUM(cmv), 0)
      FROM fin_dre_snapshots
     WHERE ano = p_ano AND mes = p_mes AND regime = 'competencia'
    UNION ALL
    SELECT 'despesas_operacionais', COALESCE(SUM(despesas_operacionais), 0)
      FROM fin_dre_snapshots
     WHERE ano = p_ano AND mes = p_mes AND regime = 'competencia'
    UNION ALL
    SELECT 'resultado_liquido', COALESCE(SUM(resultado_liquido), 0)
      FROM fin_dre_snapshots
     WHERE ano = p_ano AND mes = p_mes AND regime = 'competencia'
  ),
  ic_elim AS (
    SELECT COALESCE(SUM(CASE WHEN status IN ('auto_matched','manual_matched') THEN valor_origem ELSE 0 END), 0) AS valor_elim
      FROM fin_ic_matches m
      JOIN fin_contas_receber cr ON cr.id = m.cr_id
     WHERE EXTRACT(YEAR FROM cr.data_emissao) = p_ano
       AND EXTRACT(MONTH FROM cr.data_emissao) = p_mes
  )
  SELECT
    d.conta,
    d.total AS total_bruto,
    CASE
      WHEN d.conta = 'receita_bruta' THEN -(SELECT valor_elim FROM ic_elim)
      WHEN d.conta = 'cmv'           THEN  (SELECT valor_elim FROM ic_elim)
      ELSE 0
    END AS eliminacoes,
    d.total + CASE
      WHEN d.conta = 'receita_bruta' THEN -(SELECT valor_elim FROM ic_elim)
      WHEN d.conta = 'cmv'           THEN  (SELECT valor_elim FROM ic_elim)
      ELSE 0
    END AS total_consolidado
  FROM dre_all d;
END;
$$;

-- ------------------------------------------------------------
-- 4) fin_estimar_estoque_omie(text) — sql→plpgsql. Gate: service_role OR fin_user_can_access(p_company).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_estimar_estoque_omie(p_company text)
RETURNS TABLE(valor_estimado numeric, cobertura_pct numeric, skus_total integer, skus_com_custo integer)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
#variable_conflict use_column
BEGIN
  IF NOT (
    COALESCE(auth.role() = 'service_role', false)
    OR COALESCE(public.fin_user_can_access(p_company), false)
  ) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil financeiro' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH est AS (
    SELECT s.sku_codigo_omie, s.estoque_fisico,
           pc.cost_price AS custo
      FROM sku_estoque_atual s
      LEFT JOIN product_costs pc ON pc.product_id::text = s.sku_codigo_omie
     WHERE s.empresa = p_company AND COALESCE(s.estoque_fisico,0) > 0
  )
  SELECT
    COALESCE(SUM(CASE WHEN custo > 0 THEN estoque_fisico * custo ELSE 0 END), 0) AS valor_estimado,
    CASE WHEN COUNT(*) = 0 THEN 0
         ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE custo > 0) / COUNT(*), 2) END AS cobertura_pct,
    COUNT(*)::int AS skus_total,
    COUNT(*) FILTER (WHERE custo > 0)::int AS skus_com_custo
  FROM est;
END;
$$;
