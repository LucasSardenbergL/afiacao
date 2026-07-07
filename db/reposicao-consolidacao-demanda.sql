-- ============================================================================
-- Consolidação de demanda de reposição (N→1) — de-para de SKU no cálculo.
-- MONEY-PATH (reposição/compras). NÃO aplicar sem: prova PG17 (falsificação) +
-- Codex challenge (xhigh) + pré-flight pg_get_viewdef da PROD.
-- Spec:  docs/superpowers/specs/2026-07-05-reposicao-consolidacao-demanda-substituicao-design.md
-- Plano: docs/superpowers/plans/2026-07-05-reposicao-consolidacao-demanda-substituicao.md
--
-- Ideia: uma view de indireção reescreve venda_items_history.sku_codigo_omie do
-- ANTIGO para o DESTINO (via sku_substituicao status='aplicada'). As 5 views-fonte
-- de demanda trocam SÓ o FROM → herdam a soma. O de-para vive em UM lugar.
--
-- APLICAÇÃO: bloco idempotente (tudo CREATE OR REPLACE). Colar no SQL Editor do
-- Lovable → Run. NÃO vai em supabase/migrations/ (snapshot é fonte DR; ver
-- docs/agent/database.md §2-§3). Cada CREATE OR REPLACE VIEW preserva a ORDEM
-- EXATA de colunas da PROD (senão "cannot change name of view column").
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. View de indireção (o ÚNICO ponto de de-para).
--    COALESCE(mapa.novo, original) reescreve o SKU; LEFT JOIN → sem mapa é passthrough.
--    Mantém o MESMO nome de coluna (sku_codigo_omie) → as views-fonte só trocam o FROM.
-- ⚠️ Confirmar no pré-flight (Task 0) a lista/ordem REAL de colunas de
--    venda_items_history e ajustar o SELECT se a prod divergir deste.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_venda_items_history_efetivo AS
SELECT
  v.id, v.empresa, v.nfe_chave_acesso, v.nfe_numero, v.nfe_serie, v.data_emissao,
  v.cliente_codigo_omie, v.cliente_razao_social, v.cliente_cnpj_cpf, v.cliente_uf, v.cliente_cidade,
  COALESCE(s.sku_codigo_novo::bigint, v.sku_codigo_omie) AS sku_codigo_omie,  -- reescrito p/ o destino
  v.sku_codigo, v.sku_descricao, v.sku_ncm, v.sku_unidade,
  v.quantidade, v.valor_unitario, v.valor_total, v.cfop, v.raw_data, v.created_at
FROM venda_items_history v
LEFT JOIN sku_substituicao s
  ON s.empresa = v.empresa
 AND s.sku_codigo_antigo = v.sku_codigo_omie::text
 AND s.status = 'aplicada'
 -- ISOLA dos mapas da feature antiga (registrar_substituicao_sku grava
 -- acao_parametros='transferir'/etc.): o de-para SÓ age nos mapas explicitamente
 -- cadastrados como consolidação de demanda. Precisão>recall — resolve o achado
 -- "todo aplicada consolidaria" de forma ESTRUTURAL (não só pelo gate manual).
 AND s.acao_parametros = 'consolidar_demanda'
 -- guard defensivo: só reescreve se o destino for numérico (senão ::bigint aborta
 -- o recompute inteiro). O cadastro também valida (função abaixo), isto é cinto+suspensório.
 AND s.sku_codigo_novo ~ '^\d+$';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. REDIRECTS das views-fonte (verbatim da PROD via psql-ro 2026-07-05; único
--    delta = `FROM venda_items_history` → `FROM v_venda_items_history_efetivo
--    venda_items_history` (alias remapeia o nome → referências qualificadas
--    seguem válidas; ZERO mudança de agregação/GROUP BY/colunas).
--
--    v_sku_parametros_sugeridos NÃO é recriada: a demanda dela vem de
--    v_sku_classificacao_abc_xyz (→ v_sku_demanda_estatisticas, herda daqui); a
--    ÚNICA leitura direta que ela tem é a CTE precos_venda, que é PREÇO — e o
--    custo/preço deve ser do SKU REAL, não misturar os antigos (money-path:
--    ausente≠fabricar). Idem funções outlier/simulação: fora do de-para.
-- ─────────────────────────────────────────────────────────────────────────────

-- 2.1 — v_sku_demanda_estatisticas (90d) · CTE vendas_por_ordem
CREATE OR REPLACE VIEW v_sku_demanda_estatisticas AS
 WITH vendas_por_ordem AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie,
            max(venda_items_history.sku_descricao) AS sku_descricao,
            max(venda_items_history.sku_unidade) AS sku_unidade,
            venda_items_history.nfe_chave_acesso,
            venda_items_history.data_emissao,
            sum(venda_items_history.quantidade) AS qtde_ordem,
            sum(venda_items_history.valor_total) AS valor_ordem
           FROM v_venda_items_history_efetivo venda_items_history
          WHERE venda_items_history.data_emissao >= (CURRENT_DATE - '90 days'::interval)
          GROUP BY venda_items_history.empresa, venda_items_history.sku_codigo_omie, venda_items_history.nfe_chave_acesso, venda_items_history.data_emissao
        ), stats AS (
         SELECT vendas_por_ordem.empresa,
            vendas_por_ordem.sku_codigo_omie,
            max(vendas_por_ordem.sku_descricao) AS sku_descricao,
            max(vendas_por_ordem.sku_unidade) AS sku_unidade,
            count(DISTINCT vendas_por_ordem.nfe_chave_acesso) AS num_ordens,
            sum(vendas_por_ordem.qtde_ordem) AS demanda_total_90d,
            sum(vendas_por_ordem.valor_ordem) AS valor_total_90d,
            round(avg(vendas_por_ordem.qtde_ordem), 4) AS qtde_media_por_ordem,
            round(stddev(vendas_por_ordem.qtde_ordem), 4) AS qtde_desvio_por_ordem,
            max(vendas_por_ordem.data_emissao) AS ultima_venda_data,
            round(sum(vendas_por_ordem.qtde_ordem) / 90.0, 4) AS demanda_media_diaria,
                CASE
                    WHEN avg(vendas_por_ordem.qtde_ordem) > 0::numeric AND count(*) >= 2 THEN round(stddev(vendas_por_ordem.qtde_ordem) / avg(vendas_por_ordem.qtde_ordem), 4)
                    ELSE NULL::numeric
                END AS coef_variacao_ordem
           FROM vendas_por_ordem
          GROUP BY vendas_por_ordem.empresa, vendas_por_ordem.sku_codigo_omie
        )
 SELECT empresa, sku_codigo_omie, sku_descricao, sku_unidade, num_ordens,
    demanda_total_90d, valor_total_90d, qtde_media_por_ordem, qtde_desvio_por_ordem,
    demanda_media_diaria, coef_variacao_ordem, ultima_venda_data
   FROM stats;

-- 2.2 — v_sku_sigma_demanda (180d) · CTE vendas_diarias
CREATE OR REPLACE VIEW v_sku_sigma_demanda AS
 WITH datas AS (
         SELECT generate_series(CURRENT_DATE - '180 days'::interval, CURRENT_DATE - '1 day'::interval, '1 day'::interval)::date AS dt
        ), vendas_diarias AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie::text AS sku_codigo_omie,
            venda_items_history.data_emissao AS dt,
            sum(venda_items_history.quantidade) AS qtde
           FROM v_venda_items_history_efetivo venda_items_history
          WHERE venda_items_history.data_emissao >= (CURRENT_DATE - '180 days'::interval)
          GROUP BY venda_items_history.empresa, (venda_items_history.sku_codigo_omie::text), venda_items_history.data_emissao
        ), serie AS (
         SELECT v.empresa,
            v.sku_codigo_omie,
            d.dt,
            COALESCE(sum(vd.qtde), 0::numeric) AS qtde
           FROM ( SELECT DISTINCT vendas_diarias.empresa,
                    vendas_diarias.sku_codigo_omie
                   FROM vendas_diarias) v
             CROSS JOIN datas d
             LEFT JOIN vendas_diarias vd ON vd.empresa = v.empresa AND vd.sku_codigo_omie = v.sku_codigo_omie AND vd.dt = d.dt
          GROUP BY v.empresa, v.sku_codigo_omie, d.dt
        )
 SELECT empresa, sku_codigo_omie,
    round(stddev_samp(qtde), 4) AS sigma_demanda_diaria,
    round(avg(qtde), 4) AS media_demanda_diaria
   FROM serie
  GROUP BY empresa, sku_codigo_omie;

-- 2.3 — v_sku_demanda_rajada (180d) · CTEs skus_ativos + vendas_diarias
CREATE OR REPLACE VIEW v_sku_demanda_rajada AS
 WITH datas_serie AS (
         SELECT generate_series(CURRENT_DATE - '179 days'::interval, CURRENT_DATE::timestamp without time zone, '1 day'::interval)::date AS dt
        ), skus_ativos AS (
         SELECT DISTINCT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie,
            max(venda_items_history.sku_descricao) AS sku_descricao,
            max(venda_items_history.sku_unidade) AS sku_unidade
           FROM v_venda_items_history_efetivo venda_items_history
          WHERE venda_items_history.data_emissao >= (CURRENT_DATE - '180 days'::interval)
          GROUP BY venda_items_history.empresa, venda_items_history.sku_codigo_omie
        ), vendas_diarias AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie,
            venda_items_history.data_emissao AS dt,
            sum(venda_items_history.quantidade) AS qtde_dia,
            sum(venda_items_history.valor_total) AS valor_dia
           FROM v_venda_items_history_efetivo venda_items_history
          WHERE venda_items_history.data_emissao >= (CURRENT_DATE - '180 days'::interval)
          GROUP BY venda_items_history.empresa, venda_items_history.sku_codigo_omie, venda_items_history.data_emissao
        ), serie_completa AS (
         SELECT s.empresa,
            s.sku_codigo_omie,
            s.sku_descricao,
            s.sku_unidade,
            d.dt,
            COALESCE(v.qtde_dia, 0::numeric) AS qtde_dia,
            COALESCE(v.valor_dia, 0::numeric) AS valor_dia
           FROM skus_ativos s
             CROSS JOIN datas_serie d
             LEFT JOIN vendas_diarias v ON s.empresa = v.empresa AND s.sku_codigo_omie = v.sku_codigo_omie AND d.dt = v.dt
        )
 SELECT empresa,
    sku_codigo_omie,
    max(sku_descricao) AS sku_descricao,
    max(sku_unidade) AS sku_unidade,
    round(avg(qtde_dia), 4) AS demanda_media_diaria,
    round(stddev(qtde_dia), 4) AS demanda_desvio_diario,
    round(percentile_cont(0.90::double precision) WITHIN GROUP (ORDER BY (qtde_dia::double precision))::numeric, 2) AS p90_diario,
    round(percentile_cont(0.95::double precision) WITHIN GROUP (ORDER BY (qtde_dia::double precision))::numeric, 2) AS p95_diario,
    round(percentile_cont(0.99::double precision) WITHIN GROUP (ORDER BY (qtde_dia::double precision))::numeric, 2) AS p99_diario,
    round(percentile_cont(0.90::double precision) WITHIN GROUP (ORDER BY (qtde_dia::double precision)) FILTER (WHERE qtde_dia > 0::numeric)::numeric, 2) AS p90_quando_vende,
    round(percentile_cont(0.95::double precision) WITHIN GROUP (ORDER BY (qtde_dia::double precision)) FILTER (WHERE qtde_dia > 0::numeric)::numeric, 2) AS p95_quando_vende,
    max(qtde_dia) AS pico_maximo_dia,
    count(*) FILTER (WHERE qtde_dia > 0::numeric) AS dias_com_movimento,
    sum(qtde_dia) AS qtde_total_180d,
    round(sum(valor_dia), 2) AS valor_total_180d
   FROM serie_completa
  GROUP BY empresa, sku_codigo_omie;

-- 2.4 — v_sku_candidatos_primeira_compra (180d) · CTE recorrencia_180d (alias vih)
CREATE OR REPLACE VIEW v_sku_candidatos_primeira_compra AS
 WITH recorrencia_180d AS (
         SELECT vih.empresa,
            vih.sku_codigo_omie,
            count(DISTINCT vih.nfe_chave_acesso) AS nfs_180d,
            count(DISTINCT to_char(vih.data_emissao::timestamp with time zone, 'YYYY-MM'::text)) AS meses_180d,
            count(DISTINCT vih.cliente_cnpj_cpf) AS clientes_180d,
            CURRENT_DATE - max(vih.data_emissao) AS dias_desde_ultima
           FROM v_venda_items_history_efetivo vih
          WHERE vih.data_emissao >= (CURRENT_DATE - '180 days'::interval) AND vih.quantidade > 0::numeric
          GROUP BY vih.empresa, vih.sku_codigo_omie
        ), elegiveis AS (
         SELECT v.empresa,
            v.sku_codigo_omie,
            v.sku_descricao,
            v.fornecedor_nome,
            v.fornecedor_habilitado,
            sp.habilitado_reposicao_automatica AS ja_habilitado,
            v.classe_abc_proposta,
            v.classe_xyz_proposta,
            v.classe_consolidada,
            v.demanda_media_diaria AS d,
            v.lead_time_medio AS lt,
            v.lt_total_teorico_dias_uteis,
            v.demanda_sigma_diario,
            v.coef_variacao_ordem,
            v.dias_com_movimento,
            v.lead_time_desvio,
            v.lt_p95_dias,
            v.fonte_leadtime,
            v.z_aplicado,
            v.preco_item_eoq,
            v.preco_compra_real,
            v.preco_venda_medio,
            v.fonte_preco,
            v.custo_pedido_aplicado,
            v.custo_capital_efetivo_perc,
            v.valor_total_90d,
            v.valor_total_180d,
            v.calculado_em,
            r.nfs_180d,
            r.meses_180d,
            r.clientes_180d,
            r.dias_desde_ultima,
                CASE v.classe_abc_proposta
                    WHEN 'A'::text THEN 30
                    WHEN 'B'::text THEN 21
                    ELSE 14
                END AS cap_dias,
                CASE
                    WHEN v.preco_item_eoq > 0::numeric AND v.custo_capital_efetivo_perc > 0::numeric AND v.demanda_media_diaria > 0::numeric THEN ceil(sqrt(2.0 * (v.demanda_media_diaria * 252::numeric) * v.custo_pedido_aplicado / (v.custo_capital_efetivo_perc / 100.0 * v.preco_item_eoq)))
                    ELSE 1::numeric
                END AS qc_eoq
           FROM v_sku_parametros_sugeridos v
             JOIN recorrencia_180d r ON r.empresa = v.empresa AND r.sku_codigo_omie = v.sku_codigo_omie
             JOIN sku_parametros sp ON sp.empresa = v.empresa AND sp.sku_codigo_omie = v.sku_codigo_omie
             LEFT JOIN omie_products op ON op.omie_codigo_produto::text = v.sku_codigo_omie::text AND op.account = lower(v.empresa)
          WHERE v.status_sugestao = 'AGUARDANDO_SEGUNDA_ORDEM'::text AND v.demanda_media_diaria > 0::numeric AND v.lead_time_medio IS NOT NULL AND v.fornecedor_nome IS NOT NULL AND v.fornecedor_habilitado IS TRUE AND v.preco_item_eoq > 0::numeric AND v.classe_abc_proposta IS NOT NULL AND (v.grupo_codigo IS NOT NULL OR v.fornecedor_nome <> 'RENNER SAYERLACK S/A'::text) AND r.meses_180d >= 2 AND r.nfs_180d >= 2 AND r.dias_desde_ultima <= 60 AND sp.ponto_pedido IS NULL AND sp.estoque_maximo IS NULL AND COALESCE(op.tipo_produto, op.metadata ->> 'tipo_produto'::text, ''::text) <> '04'::text
        ), calc AS (
         SELECT elegiveis.empresa,
            elegiveis.sku_codigo_omie,
            elegiveis.sku_descricao,
            elegiveis.fornecedor_nome,
            elegiveis.fornecedor_habilitado,
            elegiveis.ja_habilitado,
            elegiveis.classe_abc_proposta,
            elegiveis.classe_xyz_proposta,
            elegiveis.classe_consolidada,
            elegiveis.d,
            elegiveis.lt,
            elegiveis.lt_total_teorico_dias_uteis,
            elegiveis.demanda_sigma_diario,
            elegiveis.coef_variacao_ordem,
            elegiveis.dias_com_movimento,
            elegiveis.lead_time_desvio,
            elegiveis.lt_p95_dias,
            elegiveis.fonte_leadtime,
            elegiveis.z_aplicado,
            elegiveis.preco_item_eoq,
            elegiveis.preco_compra_real,
            elegiveis.preco_venda_medio,
            elegiveis.fonte_preco,
            elegiveis.custo_pedido_aplicado,
            elegiveis.custo_capital_efetivo_perc,
            elegiveis.valor_total_90d,
            elegiveis.valor_total_180d,
            elegiveis.calculado_em,
            elegiveis.nfs_180d,
            elegiveis.meses_180d,
            elegiveis.clientes_180d,
            elegiveis.dias_desde_ultima,
            elegiveis.cap_dias,
            elegiveis.qc_eoq,
            ceil(elegiveis.d * elegiveis.cap_dias::numeric) AS cap_cobertura,
            ceil(elegiveis.d * elegiveis.lt) AS dem_lt
           FROM elegiveis
        )
 SELECT empresa,
    sku_codigo_omie,
    sku_descricao,
    fornecedor_nome,
    fornecedor_habilitado,
    classe_abc_proposta,
    classe_xyz_proposta,
    classe_consolidada,
    d AS demanda_media_diaria,
    lt AS lead_time_medio,
    lt_total_teorico_dias_uteis,
    demanda_sigma_diario,
    coef_variacao_ordem,
    dias_com_movimento,
    lead_time_desvio,
    lt_p95_dias,
    fonte_leadtime,
    z_aplicado,
    preco_item_eoq,
    preco_compra_real,
    preco_venda_medio,
    fonte_preco,
    valor_total_90d,
    valor_total_180d,
    calculado_em,
    'CANDIDATO_PRIMEIRA_COMPRA'::text AS status_sugestao,
    nfs_180d AS recorrencia_nfs_180d,
    meses_180d AS recorrencia_meses_180d,
    clientes_180d AS recorrencia_clientes_180d,
    dias_desde_ultima AS dias_desde_ultima_venda,
    cap_dias AS primeira_compra_cap_dias,
    GREATEST(1::numeric, LEAST(GREATEST(qc_eoq, 1::numeric), cap_cobertura)) AS primeira_compra_qtde,
    GREATEST(1::numeric, LEAST(dem_lt, cap_cobertura)) AS primeira_compra_ponto_pedido,
    GREATEST(1::numeric, LEAST(dem_lt, cap_cobertura)) + GREATEST(1::numeric, LEAST(GREATEST(qc_eoq, 1::numeric), cap_cobertura)) AS primeira_compra_estoque_maximo,
    ja_habilitado
   FROM calc;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Cadastro do de-para (ponto único: chamado pela UX/Frente C; NO HANDOFF manual
--    use INSERT/UPDATE direto — SECURITY DEFINER gateada dá 42501 no SQL Editor,
--    ver database.md §5). Valida (barra auto-ref e cadeia), grava o mapa 'aplicada'
--    e descontinua o antigo. NÃO copia parâmetros numéricos — a demanda dimensiona.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION consolidar_demanda_sku(
  p_empresa text, p_sku_antigo text, p_sku_novo text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_antigo bigint;
  v_novo   bigint;
  v_n      int;
BEGIN
  -- Gate de staff (⚠️ confirmar o helper canônico no pré-flight — provável is_staff()/has_role).
  IF NOT (
    auth.role() = 'service_role'
    OR EXISTS (SELECT 1 FROM public.user_roles ur
                WHERE ur.user_id = auth.uid() AND ur.role IN ('employee','master'))
  ) THEN
    RAISE EXCEPTION 'não autorizado' USING ERRCODE = '42501';
  END IF;

  -- [Codex P2] numérico + TAMANHO ≤18 díg. (evita overflow do ::bigint abortar o recompute).
  IF p_sku_antigo !~ '^\d{1,18}$' OR p_sku_novo !~ '^\d{1,18}$' THEN
    RAISE EXCEPTION 'código de SKU deve ser numérico ≤18 díg. (antigo=%, novo=%)', p_sku_antigo, p_sku_novo
      USING ERRCODE = 'ZR003';
  END IF;

  -- [Codex P1] CANONICALIZA (leading zeros): a view casa por v.sku_codigo_omie::text (canônico).
  -- Gravar '08040' não casaria '8040' (demanda não consolida) MAS descontinuaria o 8040 → RUPTURA.
  v_antigo := p_sku_antigo::bigint;
  v_novo   := p_sku_novo::bigint;

  -- [Codex P1] serializa cadastros por empresa → o guard de cadeia vê estado consistente (concorrência).
  PERFORM pg_advisory_xact_lock(hashtext('consolidar_demanda:'||p_empresa));

  IF v_antigo = v_novo THEN
    RAISE EXCEPTION 'auto-referência: antigo = novo (%)', v_antigo USING ERRCODE = 'ZR001';
  END IF;

  -- Cadeia transitiva (1 nível; o trigger estrutural abaixo é o backstop p/ INSERT direto).
  -- Só considera mapas de consolidação (o de-para filtra acao_parametros='consolidar_demanda').
  IF EXISTS (SELECT 1 FROM public.sku_substituicao
              WHERE empresa = p_empresa AND status = 'aplicada' AND acao_parametros = 'consolidar_demanda'
                AND (sku_codigo_antigo = v_novo::text OR sku_codigo_novo = v_antigo::text)) THEN
    RAISE EXCEPTION 'cadeia transitiva envolvendo % → % (multi-nível fora de escopo)', v_antigo, v_novo
      USING ERRCODE = 'ZR002';
  END IF;

  -- [Codex P1] DESTINO precisa ser comprável, senão a demanda vai p/ SKU que o motor não compra.
  IF NOT EXISTS (SELECT 1 FROM public.sku_parametros
                  WHERE empresa = p_empresa AND sku_codigo_omie = v_novo
                    AND ativo = true AND COALESCE(tipo_reposicao,'') <> 'descontinuado') THEN
    RAISE EXCEPTION 'destino % inexistente/inativo/descontinuado em sku_parametros', v_novo
      USING ERRCODE = 'ZR004';
  END IF;

  INSERT INTO public.sku_substituicao
    (empresa, sku_codigo_antigo, sku_codigo_novo, acao_parametros, status, aplicado_em, data_substituicao)
  VALUES
    (p_empresa, v_antigo::text, v_novo::text, 'consolidar_demanda', 'aplicada', now(), CURRENT_DATE)
  ON CONFLICT (empresa, sku_codigo_antigo, status)
  -- [Codex P1] REIVINDICA um mapa legado ('transferir') p/ o de-para (senão a linha segue invisível
  -- mas o antigo é descontinuado): força acao_parametros + destino + datas.
  DO UPDATE SET sku_codigo_novo   = EXCLUDED.sku_codigo_novo,
                acao_parametros   = 'consolidar_demanda',
                data_substituicao = CURRENT_DATE,
                aplicado_em       = now();

  -- Descontinua o antigo — os DOIS campos (espelho do reativarPayload; motor barra por tipo).
  UPDATE public.sku_parametros
     SET tipo_reposicao = 'descontinuado',
         habilitado_reposicao_automatica = false
   WHERE empresa = p_empresa AND sku_codigo_omie = v_antigo;
  GET DIAGNOSTICS v_n = ROW_COUNT;   -- [Codex P1] o antigo TEM de existir (senão descontinuou nada)
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'antigo % não encontrado em sku_parametros (linhas afetadas=%)', v_antigo, v_n
      USING ERRCODE = 'ZR005';
  END IF;
END $$;

REVOKE ALL ON FUNCTION consolidar_demanda_sku(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION consolidar_demanda_sku(text, text, text) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Backstop ESTRUTURAL [Codex P1]: guard em QUALQUER writer de sku_substituicao
--    (o handoff usa INSERT direto e bypassaria a função). Só age nos mapas de
--    consolidação aplicados; canonicaliza, barra auto-ref e cadeia (1 nível).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_sku_substituicao_consolidacao_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status = 'aplicada' AND NEW.acao_parametros = 'consolidar_demanda' THEN
    IF NEW.sku_codigo_antigo !~ '^\d{1,18}$' OR NEW.sku_codigo_novo !~ '^\d{1,18}$' THEN
      RAISE EXCEPTION 'consolidação: códigos numéricos ≤18 díg. (%, %)', NEW.sku_codigo_antigo, NEW.sku_codigo_novo USING ERRCODE='ZR003';
    END IF;
    NEW.sku_codigo_antigo := NEW.sku_codigo_antigo::bigint::text;   -- canonicaliza (leading zeros)
    NEW.sku_codigo_novo   := NEW.sku_codigo_novo::bigint::text;
    IF NEW.sku_codigo_antigo = NEW.sku_codigo_novo THEN
      RAISE EXCEPTION 'consolidação: auto-referência (%)', NEW.sku_codigo_antigo USING ERRCODE='ZR001';
    END IF;
    IF EXISTS (SELECT 1 FROM public.sku_substituicao
                WHERE empresa = NEW.empresa AND status='aplicada' AND acao_parametros='consolidar_demanda'
                  AND (sku_codigo_antigo = NEW.sku_codigo_novo OR sku_codigo_novo = NEW.sku_codigo_antigo)
                  AND id IS DISTINCT FROM NEW.id) THEN
      RAISE EXCEPTION 'consolidação: cadeia transitiva (% → %)', NEW.sku_codigo_antigo, NEW.sku_codigo_novo USING ERRCODE='ZR002';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS sku_substituicao_consolidacao_guard ON sku_substituicao;
CREATE TRIGGER sku_substituicao_consolidacao_guard
  BEFORE INSERT OR UPDATE ON sku_substituicao
  FOR EACH ROW EXECUTE FUNCTION trg_sku_substituicao_consolidacao_guard();

-- Índice parcial [Codex P3] p/ o JOIN do de-para (poucos mapas, mas evita seq scan).
CREATE INDEX IF NOT EXISTS idx_sku_subst_consolidacao_ativa
  ON sku_substituicao (empresa, sku_codigo_antigo)
  WHERE status = 'aplicada' AND acao_parametros = 'consolidar_demanda';
