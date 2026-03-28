-- ============================================================
-- MÓDULO FINANCEIRO v3: Backend analítico + transparência
-- ============================================================

-- ═══════════════ SYNC ROBUSTO (Ponto 12) ═══════════════

-- Checkpoints por empresa/entidade para retomada após falha
CREATE TABLE IF NOT EXISTS fin_sync_checkpoint (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL,
  entidade text NOT NULL, -- 'categorias','contas_correntes','contas_pagar','contas_receber','movimentacoes'
  ultima_pagina integer DEFAULT 0,
  total_paginas integer,
  total_synced integer DEFAULT 0,
  filtro_data_de text,
  filtro_data_ate text,
  status text DEFAULT 'idle' CHECK (status IN ('idle','running','complete','error','stale')),
  lock_id text, -- UUID do sync em execução, para evitar concorrência
  lock_expires_at timestamptz,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz DEFAULT now(),
  UNIQUE(company, entidade)
);

-- ═══════════════ DRE COMPETÊNCIA (Ponto 4) ═══════════════

-- View de resultado por competência (baseado em data_emissao, não pagamento)
CREATE OR REPLACE VIEW fin_dre_competencia_base AS
WITH cr_competencia AS (
  SELECT
    company,
    EXTRACT(YEAR FROM data_emissao)::integer AS ano,
    EXTRACT(MONTH FROM data_emissao)::integer AS mes,
    categoria_codigo,
    categoria_descricao,
    SUM(valor_documento) AS valor_total,
    COUNT(*) AS qtd
  FROM fin_contas_receber
  WHERE data_emissao IS NOT NULL
    AND status_titulo NOT IN ('CANCELADO')
  GROUP BY company, EXTRACT(YEAR FROM data_emissao), EXTRACT(MONTH FROM data_emissao),
    categoria_codigo, categoria_descricao
),
cp_competencia AS (
  SELECT
    company,
    EXTRACT(YEAR FROM data_emissao)::integer AS ano,
    EXTRACT(MONTH FROM data_emissao)::integer AS mes,
    categoria_codigo,
    categoria_descricao,
    SUM(valor_documento) AS valor_total,
    COUNT(*) AS qtd
  FROM fin_contas_pagar
  WHERE data_emissao IS NOT NULL
    AND status_titulo NOT IN ('CANCELADO')
  GROUP BY company, EXTRACT(YEAR FROM data_emissao), EXTRACT(MONTH FROM data_emissao),
    categoria_codigo, categoria_descricao
)
SELECT 'CR' AS origem, * FROM cr_competencia
UNION ALL
SELECT 'CP' AS origem, * FROM cp_competencia;

-- ═══════════════ TRANSPARÊNCIA DO NÚMERO (Ponto 22) ═══════════════

-- Metadata de confiabilidade para cada visão/período
CREATE TABLE IF NOT EXISTS fin_confiabilidade (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL,
  ano integer NOT NULL,
  mes integer NOT NULL,
  -- Cobertura de dados
  total_cr integer DEFAULT 0,
  total_cp integer DEFAULT 0,
  total_mov integer DEFAULT 0,
  cr_sem_categoria integer DEFAULT 0,
  cp_sem_categoria integer DEFAULT 0,
  -- Conciliação
  pct_mov_conciliado numeric(5,2) DEFAULT 0,
  mov_sem_titulo integer DEFAULT 0,
  titulo_sem_mov integer DEFAULT 0,
  -- DRE
  dre_regime text, -- 'caixa', 'competencia', 'ambos'
  dre_categorias_mapeadas integer DEFAULT 0,
  dre_categorias_heuristica integer DEFAULT 0,
  dre_categorias_total integer DEFAULT 0,
  pct_valor_mapeado numeric(5,2) DEFAULT 0, -- % do valor total com mapping explícito
  -- Fechamento
  fechamento_status text DEFAULT 'sem_fechamento',
  fechamento_versao integer DEFAULT 0,
  -- Sync
  ultimo_sync timestamptz,
  sync_status text,
  -- Timestamps
  calculated_at timestamptz DEFAULT now(),
  UNIQUE(company, ano, mes)
);

CREATE INDEX idx_fin_conf_periodo ON fin_confiabilidade(company, ano, mes);

-- ═══════════════ RPC: Calcular confiabilidade (Ponto 22) ═══════════════

CREATE OR REPLACE FUNCTION fin_calcular_confiabilidade(
  p_company text,
  p_ano integer,
  p_mes integer
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
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

-- ═══════════════ RPC: Projeção 13 semanas (Ponto 14) ═══════════════

CREATE OR REPLACE FUNCTION fin_projecao_13_semanas(
  p_company text DEFAULT NULL, -- NULL = consolidado
  p_saldo_inicial numeric DEFAULT NULL -- NULL = buscar do CC
)
RETURNS TABLE (
  semana_inicio date,
  semana_fim date,
  semana_label text,
  entradas_previstas numeric,
  saidas_previstas numeric,
  fluxo_liquido numeric,
  saldo_projetado numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
DECLARE
  v_saldo numeric;
  v_week_start date;
  v_week_end date;
BEGIN
  -- Saldo inicial
  IF p_saldo_inicial IS NOT NULL THEN
    v_saldo := p_saldo_inicial;
  ELSE
    IF p_company IS NOT NULL THEN
      SELECT COALESCE(SUM(saldo_atual), 0) INTO v_saldo
      FROM fin_contas_correntes WHERE company = p_company AND ativo;
    ELSE
      SELECT COALESCE(SUM(saldo_atual), 0) INTO v_saldo
      FROM fin_contas_correntes WHERE ativo;
    END IF;
  END IF;

  -- Gerar 13 semanas
  FOR i IN 0..12 LOOP
    v_week_start := date_trunc('week', CURRENT_DATE)::date + (i * 7);
    v_week_end := v_week_start + 6;

    -- Entradas previstas (CR abertos com vencimento na semana)
    SELECT COALESCE(SUM(saldo), 0) INTO entradas_previstas
    FROM fin_contas_receber
    WHERE (p_company IS NULL OR company = p_company)
      AND data_vencimento BETWEEN v_week_start AND v_week_end
      AND status_titulo IN ('ABERTO','PARCIAL','VENCIDO');

    -- Saídas previstas (CP abertos com vencimento na semana)
    SELECT COALESCE(SUM(saldo), 0) INTO saidas_previstas
    FROM fin_contas_pagar
    WHERE (p_company IS NULL OR company = p_company)
      AND data_vencimento BETWEEN v_week_start AND v_week_end
      AND status_titulo IN ('ABERTO','PARCIAL','VENCIDO');

    fluxo_liquido := entradas_previstas - saidas_previstas;
    v_saldo := v_saldo + fluxo_liquido;

    semana_inicio := v_week_start;
    semana_fim := v_week_end;
    semana_label := to_char(v_week_start, 'DD/MM') || '-' || to_char(v_week_end, 'DD/MM');
    saldo_projetado := v_saldo;

    RETURN NEXT;
  END LOOP;
END;
$$;

-- ═══════════════ RPC: Consolidado com eliminações (Ponto 13) ═══════════════

CREATE OR REPLACE FUNCTION fin_consolidado_intercompany(
  p_ano integer,
  p_mes integer
)
RETURNS TABLE (
  dre_linha text,
  valor_bruto numeric,
  eliminacoes numeric,
  valor_liquido numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  WITH bruto AS (
    SELECT
      unnest(ARRAY[
        'receita_bruta','deducoes','receita_liquida','cmv','lucro_bruto',
        'despesas_operacionais','despesas_administrativas','despesas_comerciais',
        'despesas_financeiras','receitas_financeiras','resultado_operacional',
        'impostos','resultado_liquido'
      ]) AS linha,
      unnest(ARRAY[
        SUM(receita_bruta), SUM(deducoes), SUM(receita_liquida), SUM(cmv), SUM(lucro_bruto),
        SUM(despesas_operacionais), SUM(despesas_administrativas), SUM(despesas_comerciais),
        SUM(despesas_financeiras), SUM(receitas_financeiras), SUM(resultado_operacional),
        SUM(impostos), SUM(resultado_liquido)
      ]) AS val
    FROM fin_dre_snapshots
    WHERE ano = p_ano AND mes = p_mes
  ),
  elim AS (
    SELECT
      COALESCE(SUM(valor_eliminado), 0) AS total_elim
    FROM fin_eliminacoes_log
    WHERE ano = p_ano AND mes = p_mes
  )
  SELECT
    b.linha AS dre_linha,
    COALESCE(b.val, 0) AS valor_bruto,
    CASE WHEN b.linha = 'receita_bruta' THEN -e.total_elim
         WHEN b.linha = 'cmv' THEN e.total_elim -- espelhamento
         ELSE 0 END AS eliminacoes,
    COALESCE(b.val, 0) +
      CASE WHEN b.linha = 'receita_bruta' THEN -e.total_elim
           WHEN b.linha = 'cmv' THEN e.total_elim
           ELSE 0 END AS valor_liquido
  FROM bruto b
  CROSS JOIN elim e;
END;
$$;

-- ═══════════════ RLS ═══════════════

ALTER TABLE fin_sync_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_confiabilidade ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fin_sync_ckpt_service" ON fin_sync_checkpoint FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "fin_sync_ckpt_user" ON fin_sync_checkpoint FOR SELECT USING (fin_user_can_access(company));
CREATE POLICY "fin_conf_service" ON fin_confiabilidade FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "fin_conf_user" ON fin_confiabilidade FOR SELECT USING (fin_user_can_access(company));
