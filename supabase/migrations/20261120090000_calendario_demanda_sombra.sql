-- =====================================================================================================================
-- Calendário de operação — Etapa 2: a demanda média do motor (OBEN) desconsidera os dias FECHADOS declarados.
-- Spec: docs/superpowers/specs/2026-11-18-calendario-operacao-design.md §6.4/§7-E2 · Plano: docs/superpowers/plans/
-- 2026-11-18-calendario-operacao-etapa2.md · Prova: db/test-calendario-demanda.sh · Depende de 20261119100000.
--
-- ⚠️ MIGRATION MANUAL (nome custom: o Lovable NÃO aplica). Vai pelo `bun run db:aplicar`, que fornece a transação e
--    recusa envelope — por isso SEM BEGIN/COMMIT. Idempotente: TRAVA → PRE → CREATE OR REPLACE → PÓS.
--
-- Fórmula (Fable 5.2 + Codex convergentes, aprovada pelo founder): na MESMA janela do numerador do legado
--   ([hojeSP − 90, hojeSP], divisor 90), U = dias seg–sex (peso base 1), W = os mesmos dias com peso efetivo
--   (sem linha / aberto / meia_equipe = 1 · fechado = 0), pendente_dado SAI de U e de W. fator = U/W;
--   d_calendario = round(d × fator, 4). Sem exceção na janela ⇒ fator = 1 ⇒ d do legado BIT A BIT (o CASE devolve
--   a própria coluna, sem aritmética). Guardas: W/U < 0,6 (ou U = 0) ⇒ fator 1 + baixa_confianca (nunca extrapola
--   janela quase toda fechada, nunca zera); teto do fator 1,35. Pesos só 0/1 (meia_equipe = 1) nesta entrega.
--   `d` já vem arredondado a 4 casas do legado: round(round(S/90,4) × fator, 4) difere de round(S/90 × fator, 4)
--   em no máximo 1 unidade da 4ª casa — a precisão da própria coluna; escolhido para não ler a cadeia 2× (Codex P2:
--   na borda isso pode mover um PP em 1 unidade, para cima ou para baixo — aceito e registrado).
--   EOQ intacto: qc_eoq usa o d CRU (d_legado); o d ajustado alimenta SS/PP/máximo/cobertura.
--
-- Onde entra (ponto ÚNICO): CTE `base` de v_sku_parametros_sugeridos. v_sku_demanda_estatisticas fica CRUA e só ganha
--   `fator_calendario` no fim. NÃO muda: sigma (inclusive o fallback d × 0,5, que segue no d cru), rajada, EOQ, LT,
--   dias_uteis_entre, classe ABC/XYZ (ranqueia por valor_total_90d — um fator único por empresa não reordena).
--   Só OBEN (único histórico de venda): demais empresas têm fator NULL e d intocado.
--
-- Chave (reversível na hora): company_config.key = 'reposicao_demanda_calendario_oben_ativa'. 'true' = VALENDO
--   (o d ajustado alimenta PP/SS/máximo/EOQ e o atualizador grava); ausente ou outro valor = SOMBRA (fail-closed,
--   padrão de reposicao_teto_cobertura_oben_ativa). Nasce DESLIGADA: esta migration não grava a chave.
--   GUC `reposicao.demanda_calendario_forcar` ∈ {sombra, valendo} sobrepõe a chave NA SESSÃO (outro valor é
--   ignorado) — é como o job de sombra lê os dois modos com a MESMA fórmula. Quem chega pelo PostgREST não a define:
--   não há SET de sessão, e o public.set_config (SECURITY DEFINER) da prod só libera o namespace `fin.%`. O
--   atualizador (omie-cron-diario) não a define. Por esse public.set_config, as chamadas aqui são pg_catalog.set_config.
--
-- Sombra: reposicao_demanda_calendario_sombra recebe por dia, por SKU, d/SS/PP/máximo nos dois modos (job diário
--   reposicao_demanda_calendario_sombra_registrar, owner-only, cron 10:20 UTC). Não alimenta nada.
--
-- Predecessores (md5 do pg_get_viewdef na PROD, psql-ro 2026-11-18): v_sku_parametros_sugeridos
--   cb7f8b8b2286ca815c0a76ea8aa412de · v_sku_demanda_estatisticas f05c5621d0254b746c6ada8cb0c9d22a.
-- =====================================================================================================================

-- TRAVA, antes de ler: ALTER sem efeito (a opção VIVA) nas duas views que a PRE guarda, na ordem dos LEITORES
-- (parametros → abc → estatisticas): um CREATE concorrente espera esta transação e lê o estado novo.
SET LOCAL lock_timeout = '10s';   -- leitor em ordem inversa (estatisticas → parametros) não segura o apply: falha e reaplica
ALTER VIEW public.v_sku_parametros_sugeridos SET (security_invoker = on);
ALTER VIEW public.v_sku_demanda_estatisticas SET (security_invoker = on);

-- PRE: md5 EXATO de cada view viva ∈ {predecessor revisado, este}. Outro ABORTA (apply manual diverge do repo).
DO $pre$
DECLARE
  v_par text := md5(pg_get_viewdef('public.v_sku_parametros_sugeridos'::regclass, true));
  v_est text := md5(pg_get_viewdef('public.v_sku_demanda_estatisticas'::regclass, true));
BEGIN
  IF v_par NOT IN ('cb7f8b8b2286ca815c0a76ea8aa412de', 'cec8b64723d20a5400deace2ea34838c') THEN
    RAISE EXCEPTION 'PRE FALHOU: v_sku_parametros_sugeridos viva (md5 %) nao e a predecessora revisada nem esta', v_par;
  END IF;
  IF v_est NOT IN ('f05c5621d0254b746c6ada8cb0c9d22a', '5cc2c267e2ecbe64c393f15e531a770a') THEN
    RAISE EXCEPTION 'PRE FALHOU: v_sku_demanda_estatisticas viva (md5 %) nao e a predecessora revisada nem esta', v_est;
  END IF;
  IF to_regclass('public.calendario_operacao_empresa') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: calendario_operacao_empresa ausente (aplique 20261119100000 antes)';
  END IF;
END
$pre$;

-- ── Fator do calendário: 1 linha por chamada; STRICT (data NULL → nenhuma linha → o LEFT JOIN da view dá NULL e o
--    d fica o legado). SECURITY INVOKER: a RLS do calendário vale para quem lê (quem não o enxerga cai no legado).
CREATE OR REPLACE FUNCTION public.calendario_fator_demanda(p_empresa text, p_data_fim date)
RETURNS TABLE (
  janela_inicio   date,
  janela_fim      date,
  dias_base       integer,
  dias_efetivos   integer,
  dias_pendentes  integer,
  fator_bruto     numeric,
  fator           numeric,
  baixa_confianca boolean
)
LANGUAGE sql
STABLE
STRICT
SECURITY INVOKER
SET search_path = public, pg_catalog
AS $fn$
  WITH dias AS (
    SELECT g::date AS dia
      FROM generate_series((p_data_fim - 90)::timestamp, p_data_fim::timestamp, interval '1 day') AS g
     WHERE extract(isodow FROM g) < 6
  ), agg AS (
    SELECT count(*) FILTER (WHERE c.status IS DISTINCT FROM 'pendente_dado')::integer                 AS u,
           count(*) FILTER (WHERE c.status IS NULL OR c.status IN ('aberto', 'meia_equipe'))::integer AS w,
           count(*) FILTER (WHERE c.status = 'pendente_dado')::integer                                AS p
      FROM dias d
      LEFT JOIN public.calendario_operacao_empresa c ON c.data = d.dia AND c.empresa = p_empresa
  )
  SELECT p_data_fim - 90,
         p_data_fim,
         a.u,
         a.w,
         a.p,
         CASE WHEN a.w > 0 THEN a.u::numeric / a.w END,
         CASE WHEN a.u = 0 OR a.w::numeric / a.u < 0.6 THEN 1::numeric
              ELSE LEAST(a.u::numeric / a.w, 1.35) END,
         (a.u = 0 OR a.w::numeric / a.u < 0.6)
    FROM agg a
$fn$;

REVOKE ALL ON FUNCTION public.calendario_fator_demanda(text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calendario_fator_demanda(text, date) TO authenticated, service_role;
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_ro') THEN
    GRANT EXECUTE ON FUNCTION public.calendario_fator_demanda(text, date) TO claude_ro;
  END IF;
END
$g$;

-- ── v_sku_demanda_estatisticas: CRUA (demanda_media_diaria = sum/90 como antes) + fator_calendario no fim.
CREATE OR REPLACE VIEW public.v_sku_demanda_estatisticas WITH (security_invoker = on) AS
 WITH calendario_fator AS (
         SELECT 'OBEN'::text AS empresa_cal,
            f.fator,
            f.baixa_confianca
           FROM calendario_fator_demanda('OBEN'::text, (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date) f(janela_inicio, janela_fim, dias_base, dias_efetivos, dias_pendentes, fator_bruto, fator, baixa_confianca)
        ), vendas_por_ordem AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie,
            max(venda_items_history.sku_descricao) AS sku_descricao,
            max(venda_items_history.sku_unidade) AS sku_unidade,
            venda_items_history.nfe_chave_acesso,
            venda_items_history.data_emissao,
            sum(venda_items_history.quantidade) AS qtde_ordem,
            sum(venda_items_history.valor_total) AS valor_ordem
           FROM v_sku_demanda_efetiva venda_items_history
          WHERE venda_items_history.data_emissao >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '90 days'::interval)
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
 SELECT empresa,
    sku_codigo_omie,
    sku_descricao,
    sku_unidade,
    num_ordens,
    demanda_total_90d,
    valor_total_90d,
    qtde_media_por_ordem,
    qtde_desvio_por_ordem,
    demanda_media_diaria,
    coef_variacao_ordem,
    ultima_venda_data,
    fcal.fator AS fator_calendario
   FROM stats
     LEFT JOIN calendario_fator fcal ON fcal.empresa_cal = stats.empresa;

-- ── v_sku_parametros_sugeridos: d efetivo pela chave (CTE base) + 5 colunas no fim.
CREATE OR REPLACE VIEW public.v_sku_parametros_sugeridos WITH (security_invoker = on) AS
 WITH minimo_operacional AS (
         SELECT 'A'::text AS letra_abc,
            2 AS min_op
        UNION ALL
         SELECT 'B'::text AS text,
            1
        UNION ALL
         SELECT 'C'::text AS text,
            0
        ), config_efetiva AS (
         SELECT empresa_configuracao_custos.empresa,
            (empresa_configuracao_custos.selic_anual + empresa_configuracao_custos.spread_oportunidade + empresa_configuracao_custos.armazenagem_fisica) / 100.0 AS cm_anual,
                CASE
                    WHEN empresa_configuracao_custos.modo_pedido = 'api'::text THEN empresa_configuracao_custos.custo_pedido_api
                    ELSE empresa_configuracao_custos.custo_pedido_manual
                END AS cp,
            empresa_configuracao_custos.z_classe_a,
            empresa_configuracao_custos.z_classe_b,
            empresa_configuracao_custos.z_classe_c,
            empresa_configuracao_custos.modo_pedido
           FROM empresa_configuracao_custos
        ), precos_compra AS (
         SELECT v_sku_leadtime_efetivo.empresa::text AS empresa,
            v_sku_leadtime_efetivo.sku_codigo_omie::text AS sku_codigo_omie,
            avg(v_sku_leadtime_efetivo.valor_total / NULLIF(v_sku_leadtime_efetivo.quantidade_recebida, 0::numeric)) AS preco_compra_real,
            count(*) AS n_compras
           FROM v_sku_leadtime_efetivo
          WHERE v_sku_leadtime_efetivo.quantidade_recebida > 0::numeric AND v_sku_leadtime_efetivo.valor_total > 0::numeric
          GROUP BY (v_sku_leadtime_efetivo.empresa::text), (v_sku_leadtime_efetivo.sku_codigo_omie::text)
        ), precos_venda AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie::text AS sku_codigo_omie,
            avg(venda_items_history.valor_total / NULLIF(venda_items_history.quantidade, 0::numeric)) AS preco_venda_medio
           FROM venda_items_history
          WHERE venda_items_history.data_emissao >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval) AND venda_items_history.quantidade > 0::numeric
          GROUP BY venda_items_history.empresa, (venda_items_history.sku_codigo_omie::text)
        ), precos_cmc AS (
         SELECT DISTINCT ON (m.empresa, m.sku_codigo_omie) m.empresa,
            m.sku_codigo_omie,
            m.cmc
           FROM ( SELECT
                        CASE
                            WHEN ip.account = ANY (ARRAY['vendas'::text, 'oben'::text]) THEN 'OBEN'::text
                            WHEN ip.account = ANY (ARRAY['colacor_vendas'::text, 'colacor'::text]) THEN 'COLACOR'::text
                            WHEN ip.account = ANY (ARRAY['servicos'::text, 'colacor_sc'::text]) THEN 'COLACOR_SC'::text
                            ELSE NULL::text
                        END AS empresa,
                    ip.omie_codigo_produto::text AS sku_codigo_omie,
                    ip.cmc,
                    ip.synced_at
                   FROM inventory_position ip
                  WHERE ip.cmc > 0::numeric) m
          WHERE m.empresa IS NOT NULL
          ORDER BY m.empresa, m.sku_codigo_omie, (m.cmc > 0::numeric) DESC, m.synced_at DESC NULLS LAST
        ), calendario_chave AS (
         SELECT
                CASE
                    WHEN current_setting('reposicao.demanda_calendario_forcar'::text, true) = ANY (ARRAY['sombra'::text, 'valendo'::text]) THEN current_setting('reposicao.demanda_calendario_forcar'::text, true)
                    WHEN COALESCE(( SELECT lower(btrim(cc.value)) = 'true'::text
                       FROM company_config cc
                      WHERE cc.key = 'reposicao_demanda_calendario_oben_ativa'::text
                     LIMIT 1), false) THEN 'valendo'::text
                    ELSE 'sombra'::text
                END AS modo
        ), calendario_fator AS (
         SELECT 'OBEN'::text AS empresa_cal,
            f.fator,
            f.baixa_confianca
           FROM calendario_fator_demanda('OBEN'::text, (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date) f(janela_inicio, janela_fim, dias_base, dias_efetivos, dias_pendentes, fator_bruto, fator, baixa_confianca)
        ), base AS (
         SELECT c.empresa,
            c.sku_codigo_omie,
            c.sku_descricao,
            c.valor_total_90d,
            c.num_ordens,
                CASE
                    WHEN cch.modo = 'valendo'::text AND fcal.fator IS NOT NULL AND fcal.fator <> 1::numeric THEN round(c.demanda_media_diaria * fcal.fator, 4)
                    ELSE c.demanda_media_diaria
                END AS d,
            c.qtde_media_por_ordem,
            c.qtde_desvio_por_ordem,
            c.coef_variacao_ordem,
            c.classe_abc_proposta,
            c.classe_xyz_proposta,
            c.classe_consolidada_proposta AS classe,
            r.p90_diario,
            r.p95_diario,
            r.p99_diario,
            r.p90_quando_vende,
            r.p95_quando_vende,
            r.pico_maximo_dia,
            r.dias_com_movimento,
            r.valor_total_180d,
            COALESCE(sd.sigma_demanda_diaria, c.demanda_media_diaria * 0.5) AS sigma_d,
            GREATEST(lts.lt_total_teorico_dias_uteis::numeric, lt.lt_medio_dias_uteis) AS lt,
            COALESCE(lt.lt_desvio_padrao_dias, lt.lt_fornecedor_desvio, COALESCE(lts.lt_total_teorico_dias_uteis, 10::bigint)::numeric * 0.3) AS sigma_lt,
            lts.lt_total_teorico_dias_uteis,
            lt.lt_medio_dias_uteis AS lt_historico_medio,
                CASE
                    WHEN lts.lt_total_teorico_dias_uteis IS NULL AND lt.lt_medio_dias_uteis IS NULL THEN 'sem_dados'::text
                    WHEN lts.lt_total_teorico_dias_uteis IS NULL THEN 'historico_medio'::text
                    WHEN lt.lt_medio_dias_uteis IS NULL THEN 'sla_teorico'::text
                    WHEN lt.lt_medio_dias_uteis > lts.lt_total_teorico_dias_uteis::numeric THEN 'historico_sobrepos_teorico'::text
                    ELSE 'sla_teorico'::text
                END AS fonte_lt,
            lts.grupo_codigo,
            lt.lt_p95_dias,
            lt.fonte_leadtime,
            COALESCE(lt.fornecedor_nome, fgp.fornecedor_nome) AS fornecedor_nome,
                CASE
                    WHEN lt.fornecedor_nome IS NOT NULL THEN 'historico_compras'::text
                    WHEN fgp.fornecedor_nome IS NOT NULL THEN 'grupo_producao'::text
                    ELSE NULL::text
                END AS fonte_fornecedor,
            pv.preco_venda_medio,
            pc.preco_compra_real,
            pc.n_compras,
            COALESCE(NULLIF(( SELECT pcc.cmc
                   FROM precos_cmc pcc
                  WHERE pcc.empresa = c.empresa AND pcc.sku_codigo_omie = c.sku_codigo_omie::text), 0::numeric), pc.preco_compra_real, pv.preco_venda_medio * 0.55) AS preco_item_eoq,
                CASE
                    WHEN NULLIF(( SELECT pcc.cmc
                       FROM precos_cmc pcc
                      WHERE pcc.empresa = c.empresa AND pcc.sku_codigo_omie = c.sku_codigo_omie::text), 0::numeric) IS NOT NULL THEN 'cmc'::text
                    WHEN pc.preco_compra_real IS NOT NULL THEN 'compra_real'::text
                    WHEN pv.preco_venda_medio IS NOT NULL THEN 'venda_estimado'::text
                    ELSE 'sem_preco'::text
                END AS fonte_preco,
            COALESCE(fh.habilitado, false) AS fornecedor_habilitado,
            cfg.cm_anual,
            cfg.cp,
            cfg.z_classe_a,
            cfg.z_classe_b,
            cfg.z_classe_c,
            cfg.modo_pedido,
            mop.min_op AS minimo_operacional,
                CASE c.classe_abc_proposta
                    WHEN 'A'::text THEN cfg.z_classe_a
                    WHEN 'B'::text THEN cfg.z_classe_b
                    ELSE cfg.z_classe_c
                END AS z_aplicado,
            c.demanda_media_diaria AS d_legado,
                CASE
                    WHEN fcal.fator IS NULL THEN NULL::numeric
                    WHEN fcal.fator = 1::numeric THEN c.demanda_media_diaria
                    ELSE round(c.demanda_media_diaria * fcal.fator, 4)
                END AS d_calendario,
            fcal.fator AS fator_calendario,
            fcal.baixa_confianca AS calendario_baixa_confianca,
                CASE
                    WHEN fcal.fator IS NULL THEN NULL::text
                    ELSE cch.modo
                END AS calendario_modo
           FROM v_sku_classificacao_abc_xyz c
             LEFT JOIN v_sku_demanda_rajada r ON c.empresa = r.empresa AND c.sku_codigo_omie = r.sku_codigo_omie
             LEFT JOIN v_sku_leadtime_estatisticas lt ON c.empresa = lt.empresa AND c.sku_codigo_omie = lt.sku_codigo_omie
             LEFT JOIN v_sku_lt_teorico lts ON c.empresa = lts.empresa AND c.sku_codigo_omie::text = lts.sku_codigo_omie
             LEFT JOIN v_sku_sigma_demanda sd ON c.empresa = sd.empresa AND c.sku_codigo_omie::text = sd.sku_codigo_omie
             LEFT JOIN precos_venda pv ON c.empresa = pv.empresa AND c.sku_codigo_omie::text = pv.sku_codigo_omie
             LEFT JOIN precos_compra pc ON c.empresa = pc.empresa AND c.sku_codigo_omie::text = pc.sku_codigo_omie
             LEFT JOIN config_efetiva cfg ON c.empresa = cfg.empresa
             LEFT JOIN minimo_operacional mop ON c.classe_abc_proposta = mop.letra_abc
             LEFT JOIN fornecedor_grupo_producao fgp ON fgp.empresa = c.empresa AND fgp.grupo_codigo = lts.grupo_codigo
             LEFT JOIN fornecedor_habilitado_reposicao fh ON c.empresa = fh.empresa AND fh.fornecedor_nome = COALESCE(lt.fornecedor_nome, fgp.fornecedor_nome)
             LEFT JOIN calendario_fator fcal ON fcal.empresa_cal = c.empresa
             CROSS JOIN calendario_chave cch
        ), com_calculos AS (
         SELECT base.empresa,
            base.sku_codigo_omie,
            base.sku_descricao,
            base.valor_total_90d,
            base.num_ordens,
            base.d,
            base.qtde_media_por_ordem,
            base.qtde_desvio_por_ordem,
            base.coef_variacao_ordem,
            base.classe_abc_proposta,
            base.classe_xyz_proposta,
            base.classe,
            base.p90_diario,
            base.p95_diario,
            base.p99_diario,
            base.p90_quando_vende,
            base.p95_quando_vende,
            base.pico_maximo_dia,
            base.dias_com_movimento,
            base.valor_total_180d,
            base.sigma_d,
            base.lt,
            base.sigma_lt,
            base.lt_total_teorico_dias_uteis,
            base.lt_historico_medio,
            base.fonte_lt,
            base.grupo_codigo,
            base.lt_p95_dias,
            base.fonte_leadtime,
            base.fornecedor_nome,
            base.fonte_fornecedor,
            base.preco_venda_medio,
            base.preco_compra_real,
            base.n_compras,
            base.preco_item_eoq,
            base.fonte_preco,
            base.fornecedor_habilitado,
            base.cm_anual,
            base.cp,
            base.z_classe_a,
            base.z_classe_b,
            base.z_classe_c,
            base.modo_pedido,
            base.minimo_operacional,
            base.z_aplicado,
            sqrt(COALESCE(base.lt, 10::numeric) * power(COALESCE(base.sigma_d, 0::numeric), 2::numeric) + power(COALESCE(base.d, 0::numeric), 2::numeric) * power(COALESCE(base.sigma_lt, 0::numeric), 2::numeric)) AS sigma_lt_d,
                CASE
                    WHEN base.num_ordens < 2 THEN 'AGUARDANDO_SEGUNDA_ORDEM'::text
                    WHEN base.lt IS NULL THEN 'SEM_LEADTIME_DEFINIDO'::text
                    WHEN base.fornecedor_nome IS NULL THEN 'SEM_FORNECEDOR_IDENTIFICADO'::text
                    WHEN NOT base.fornecedor_habilitado THEN 'AGUARDANDO_HABILITACAO_FORNECEDOR'::text
                    WHEN base.grupo_codigo IS NULL AND base.fornecedor_nome = 'RENNER SAYERLACK S/A'::text THEN 'AGUARDANDO_CLASSIFICACAO_GRUPO'::text
                    WHEN base.preco_item_eoq IS NULL OR base.preco_item_eoq = 0::numeric THEN 'SEM_PRECO'::text
                    ELSE 'OK'::text
                END AS status_sugestao,
            base.d_legado,
            base.d_calendario,
            base.fator_calendario,
            base.calendario_baixa_confianca,
            base.calendario_modo
           FROM base
        ), com_formulas AS (
         SELECT com_calculos.empresa,
            com_calculos.sku_codigo_omie,
            com_calculos.sku_descricao,
            com_calculos.valor_total_90d,
            com_calculos.num_ordens,
            com_calculos.d,
            com_calculos.qtde_media_por_ordem,
            com_calculos.qtde_desvio_por_ordem,
            com_calculos.coef_variacao_ordem,
            com_calculos.classe_abc_proposta,
            com_calculos.classe_xyz_proposta,
            com_calculos.classe,
            com_calculos.p90_diario,
            com_calculos.p95_diario,
            com_calculos.p99_diario,
            com_calculos.p90_quando_vende,
            com_calculos.p95_quando_vende,
            com_calculos.pico_maximo_dia,
            com_calculos.dias_com_movimento,
            com_calculos.valor_total_180d,
            com_calculos.sigma_d,
            com_calculos.lt,
            com_calculos.sigma_lt,
            com_calculos.lt_total_teorico_dias_uteis,
            com_calculos.lt_historico_medio,
            com_calculos.fonte_lt,
            com_calculos.grupo_codigo,
            com_calculos.lt_p95_dias,
            com_calculos.fonte_leadtime,
            com_calculos.fornecedor_nome,
            com_calculos.fonte_fornecedor,
            com_calculos.preco_venda_medio,
            com_calculos.preco_compra_real,
            com_calculos.n_compras,
            com_calculos.preco_item_eoq,
            com_calculos.fonte_preco,
            com_calculos.fornecedor_habilitado,
            com_calculos.cm_anual,
            com_calculos.cp,
            com_calculos.z_classe_a,
            com_calculos.z_classe_b,
            com_calculos.z_classe_c,
            com_calculos.modo_pedido,
            com_calculos.minimo_operacional,
            com_calculos.z_aplicado,
            com_calculos.sigma_lt_d,
            com_calculos.status_sugestao,
            ceil(com_calculos.z_aplicado * com_calculos.sigma_lt_d) AS ss_calculado,
            ceil(COALESCE(com_calculos.d, 0::numeric) * COALESCE(com_calculos.lt, 10::numeric) + com_calculos.z_aplicado * com_calculos.sigma_lt_d) AS pp_calculado,
                CASE
                    WHEN com_calculos.preco_item_eoq > 0::numeric AND com_calculos.cm_anual > 0::numeric AND com_calculos.d_legado > 0::numeric THEN ceil(sqrt(2.0 * (COALESCE(com_calculos.d_legado, 0::numeric) * 252::numeric) * com_calculos.cp / (com_calculos.cm_anual * com_calculos.preco_item_eoq)))
                    ELSE 1::numeric
                END AS qc_eoq,
            com_calculos.d_legado,
            com_calculos.d_calendario,
            com_calculos.fator_calendario,
            com_calculos.calendario_baixa_confianca,
            com_calculos.calendario_modo
           FROM com_calculos
        )
 SELECT empresa,
    sku_codigo_omie,
    sku_descricao,
    fornecedor_nome,
    fornecedor_habilitado,
    fonte_fornecedor,
    grupo_codigo,
    classe_abc_proposta,
    classe_xyz_proposta,
    classe AS classe_consolidada,
    num_ordens,
    d AS demanda_media_diaria,
    qtde_media_por_ordem,
    qtde_desvio_por_ordem,
    coef_variacao_ordem,
    p90_diario,
    p95_diario,
    p99_diario,
    p90_quando_vende,
    p95_quando_vende,
    pico_maximo_dia,
    dias_com_movimento,
    valor_total_180d,
    sigma_d AS demanda_sigma_diario,
    lt AS lead_time_medio,
    lt_total_teorico_dias_uteis,
    lt_historico_medio,
    fonte_lt,
    sigma_lt AS lead_time_desvio,
    lt_p95_dias,
    fonte_leadtime,
    sigma_lt_d,
    z_aplicado,
    minimo_operacional,
    preco_venda_medio,
    preco_compra_real,
    preco_item_eoq,
    fonte_preco,
    n_compras,
    cm_anual * 100::numeric AS custo_capital_efetivo_perc,
    cp AS custo_pedido_aplicado,
    modo_pedido,
    status_sugestao,
        CASE
            WHEN status_sugestao = 'OK'::text THEN GREATEST(ss_calculado, COALESCE(minimo_operacional, 0)::numeric)
            ELSE NULL::numeric
        END AS estoque_minimo_sugerido,
        CASE
            WHEN status_sugestao = 'OK'::text THEN GREATEST(pp_calculado, GREATEST(ss_calculado, COALESCE(minimo_operacional, 0)::numeric) + 1::numeric)
            ELSE NULL::numeric
        END AS ponto_pedido_sugerido,
        CASE
            WHEN status_sugestao = 'OK'::text THEN GREATEST(qc_eoq, 1::numeric)
            ELSE NULL::numeric
        END AS qtde_compra_ciclo_sugerida,
        CASE
            WHEN status_sugestao = 'OK'::text THEN GREATEST(pp_calculado, GREATEST(ss_calculado, COALESCE(minimo_operacional, 0)::numeric) + 1::numeric) + GREATEST(qc_eoq, 1::numeric)
            ELSE NULL::numeric
        END AS estoque_maximo_sugerido,
        CASE
            WHEN status_sugestao = 'OK'::text AND d > 0::numeric THEN ceil(GREATEST(qc_eoq, 1::numeric) / d)::integer
            ELSE NULL::integer
        END AS cobertura_alvo_dias,
    COALESCE(valor_total_90d, valor_total_180d) AS valor_total_90d,
    (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date AS calculado_em,
        CASE
            WHEN status_sugestao = 'OK'::text THEN ss_calculado
            ELSE NULL::numeric
        END AS estoque_seguranca_sugerido,
    d_legado AS demanda_media_diaria_legado,
    d_calendario AS demanda_media_diaria_calendario,
    fator_calendario,
    calendario_baixa_confianca,
    calendario_modo
   FROM com_formulas
  ORDER BY (
        CASE status_sugestao
            WHEN 'OK'::text THEN 1
            WHEN 'AGUARDANDO_CLASSIFICACAO_GRUPO'::text THEN 2
            WHEN 'AGUARDANDO_HABILITACAO_FORNECEDOR'::text THEN 3
            WHEN 'SEM_LEADTIME_DEFINIDO'::text THEN 4
            WHEN 'SEM_PRECO'::text THEN 5
            ELSE 6
        END), valor_total_180d DESC NULLS LAST;

-- ── Sombra: d/SS/PP/máximo nos dois modos, por dia. Só o job escreve; staff lê pela policy. SEM custo/preço na
--    tabela: o job lê como dono (cmc incluso) e a policy não carrega o cap_custo_ler — o capital (ΔPP × custo) é
--    calculado na hora, por quem pode ler custo (sonda psql-ro), nunca gravado aqui.
CREATE TABLE IF NOT EXISTS public.reposicao_demanda_calendario_sombra (
  data_ref                   date        NOT NULL,
  empresa                    text        NOT NULL,
  sku_codigo_omie            bigint      NOT NULL,
  fator_calendario           numeric,
  calendario_baixa_confianca boolean,
  status_sugestao            text,
  demanda_legado             numeric,
  demanda_calendario         numeric,
  ss_legado                  numeric,
  ss_calendario              numeric,
  pp_legado                  numeric,
  pp_calendario              numeric,
  max_legado                 numeric,
  max_calendario             numeric,
  registrado_em              timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (data_ref, empresa, sku_codigo_omie)
);
ALTER TABLE public.reposicao_demanda_calendario_sombra ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reposicao_demanda_calendario_sombra_sel ON public.reposicao_demanda_calendario_sombra;
CREATE POLICY reposicao_demanda_calendario_sombra_sel ON public.reposicao_demanda_calendario_sombra
  FOR SELECT TO authenticated
  USING ((SELECT public.has_role(auth.uid(), 'master'::public.app_role)) OR (SELECT public.has_role(auth.uid(), 'employee'::public.app_role)));

-- Job (owner-only, sem gate de JWT: pg_cron roda sem auth.uid). Lê a view DUAS vezes com o modo FORÇADO pela GUC — a
-- mesma fórmula nos dois lados — e só grava o SKU que (a) tem exatamente 1 linha em cada leitura (a view herda
-- ambiguidade de cadastro, ex.: grupo de produção com 2 fornecedores) e (b) tem os MESMOS insumos nas duas (d cru,
-- σ, LT, σ_LT, z): em READ COMMITTED cada instrução tem snapshot próprio, e uma NF entre as leituras viraria "efeito
-- do calendário". O resto é descartado e contado no NOTICE — nunca aborta o dia. A GUC volta a '' no fim (sem SET no
-- cabeçalho: no Supabase o postgres não é superusuário e o PG15+ recusa GUC customizada em CREATE FUNCTION … SET —
-- 42501 no ensaio de 2026-11-18); erro aborta a transação inteira.
CREATE OR REPLACE FUNCTION public.reposicao_demanda_calendario_sombra_registrar(p_empresa text DEFAULT 'OBEN')
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_hoje  date;   -- o dia que a VIEW calculou (calculado_em), não um relógio à parte
  v_n     integer;
  v_lidos integer;
BEGIN
  IF p_empresa IS DISTINCT FROM 'OBEN' THEN
    RAISE EXCEPTION 'sombra do calendario: so OBEN tem historico de venda (empresa %)', p_empresa USING ERRCODE = '22023';
  END IF;

  IF to_regclass('pg_temp.sombra_calendario_legado') IS NOT NULL THEN DROP TABLE pg_temp.sombra_calendario_legado; END IF;
  PERFORM pg_catalog.set_config('reposicao.demanda_calendario_forcar', 'sombra', true);
  CREATE TEMP TABLE sombra_calendario_legado ON COMMIT DROP AS
    SELECT v.sku_codigo_omie, v.demanda_media_diaria, v.demanda_sigma_diario, v.lead_time_medio, v.lead_time_desvio,
           v.z_aplicado, v.estoque_seguranca_sugerido, v.ponto_pedido_sugerido, v.estoque_maximo_sugerido,
           v.status_sugestao, v.fator_calendario, v.calendario_baixa_confianca, v.calculado_em,
           count(*) OVER (PARTITION BY v.sku_codigo_omie) AS n_linhas
      FROM public.v_sku_parametros_sugeridos v
     WHERE v.empresa = p_empresa;
  SELECT count(DISTINCT sku_codigo_omie), max(calculado_em) INTO v_lidos, v_hoje FROM pg_temp.sombra_calendario_legado;

  PERFORM pg_catalog.set_config('reposicao.demanda_calendario_forcar', 'valendo', true);
  INSERT INTO public.reposicao_demanda_calendario_sombra AS s (
    data_ref, empresa, sku_codigo_omie, fator_calendario, calendario_baixa_confianca, status_sugestao,
    demanda_legado, demanda_calendario, ss_legado, ss_calendario, pp_legado, pp_calendario, max_legado, max_calendario)
  SELECT v_hoje, p_empresa, l.sku_codigo_omie, l.fator_calendario, l.calendario_baixa_confianca, l.status_sugestao,
         l.demanda_media_diaria, v.demanda_media_diaria, l.estoque_seguranca_sugerido, v.estoque_seguranca_sugerido,
         l.ponto_pedido_sugerido, v.ponto_pedido_sugerido, l.estoque_maximo_sugerido, v.estoque_maximo_sugerido
    FROM pg_temp.sombra_calendario_legado l
    JOIN (SELECT x.*, count(*) OVER (PARTITION BY x.sku_codigo_omie) AS n_linhas
            FROM public.v_sku_parametros_sugeridos x
           WHERE x.empresa = p_empresa) v
      ON v.sku_codigo_omie = l.sku_codigo_omie
   WHERE l.n_linhas = 1 AND v.n_linhas = 1
     AND v.calculado_em = v_hoje AND l.calculado_em = v_hoje
     AND v.demanda_media_diaria_legado IS NOT DISTINCT FROM l.demanda_media_diaria
     AND v.demanda_sigma_diario        IS NOT DISTINCT FROM l.demanda_sigma_diario
     AND v.lead_time_medio             IS NOT DISTINCT FROM l.lead_time_medio
     AND v.lead_time_desvio            IS NOT DISTINCT FROM l.lead_time_desvio
     AND v.z_aplicado                  IS NOT DISTINCT FROM l.z_aplicado
     AND v.fator_calendario            IS NOT DISTINCT FROM l.fator_calendario
  ON CONFLICT (data_ref, empresa, sku_codigo_omie) DO UPDATE SET
    fator_calendario           = EXCLUDED.fator_calendario,
    calendario_baixa_confianca = EXCLUDED.calendario_baixa_confianca,
    status_sugestao            = EXCLUDED.status_sugestao,
    demanda_legado             = EXCLUDED.demanda_legado,
    demanda_calendario         = EXCLUDED.demanda_calendario,
    ss_legado                  = EXCLUDED.ss_legado,
    ss_calendario              = EXCLUDED.ss_calendario,
    pp_legado                  = EXCLUDED.pp_legado,
    pp_calendario              = EXCLUDED.pp_calendario,
    max_legado                 = EXCLUDED.max_legado,
    max_calendario             = EXCLUDED.max_calendario,
    registrado_em              = clock_timestamp();
  GET DIAGNOSTICS v_n = ROW_COUNT;

  PERFORM pg_catalog.set_config('reposicao.demanda_calendario_forcar', '', true);
  IF to_regclass('pg_temp.sombra_calendario_legado') IS NOT NULL THEN DROP TABLE pg_temp.sombra_calendario_legado; END IF;
  IF v_n < v_lidos THEN
    RAISE NOTICE 'sombra do calendario: % de % SKU(s) gravados; o resto foi descartado (linha duplicada na view ou insumo mudou entre as leituras)', v_n, v_lidos;
  END IF;
  RETURN v_n;
END
$fn$;

-- ACL por ALLOWLIST (default ACL do public dá EXECUTE/INSERT a service_role e sandbox_exec_<ref>, com BYPASSRLS —
-- db/aplicar-sql-acl-allowlist.sql): job só do dono; tabela: escrita só do dono, SELECT só authenticated (policy) e
-- claude_ro. PUBLIC vai pelo nome (grantee 0 no aclexplode).
DO $acl$
DECLARE
  r record;
BEGIN
  REVOKE ALL ON FUNCTION public.reposicao_demanda_calendario_sombra_registrar(text) FROM PUBLIC;
  REVOKE ALL ON public.reposicao_demanda_calendario_sombra FROM PUBLIC;
  FOR r IN
    SELECT DISTINCT a.grantee::regrole AS papel
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE p.oid = 'public.reposicao_demanda_calendario_sombra_registrar(text)'::regprocedure
       AND a.grantee <> 0 AND a.grantee <> p.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.reposicao_demanda_calendario_sombra_registrar(text) FROM %s', r.papel);
  END LOOP;
  FOR r IN
    SELECT DISTINCT a.grantee::regrole AS papel
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.oid = 'public.reposicao_demanda_calendario_sombra'::regclass
       AND a.grantee <> 0 AND a.grantee <> c.relowner
  LOOP
    EXECUTE format('REVOKE ALL ON public.reposicao_demanda_calendario_sombra FROM %s', r.papel);
  END LOOP;
  GRANT SELECT ON public.reposicao_demanda_calendario_sombra TO authenticated;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_ro') THEN
    GRANT SELECT ON public.reposicao_demanda_calendario_sombra TO claude_ro;
  END IF;
END
$acl$;

DO $cron$
BEGIN
  IF to_regprocedure('cron.schedule(text, text, text)') IS NOT NULL THEN
    PERFORM cron.schedule('reposicao-demanda-calendario-sombra', '20 10 * * *',
                          $c$SELECT public.reposicao_demanda_calendario_sombra_registrar('OBEN');$c$);
  END IF;
END
$cron$;

-- PÓS: o estado ficou o pretendido? Qualquer falta ABORTA a transação inteira.
DO $post$
DECLARE
  v_fn  regprocedure := to_regprocedure('public.calendario_fator_demanda(text, date)');
  v_job regprocedure := to_regprocedure('public.reposicao_demanda_calendario_sombra_registrar(text)');
  v_n   bigint;
  v_papeis text;
BEGIN
  IF v_fn IS NULL OR v_job IS NULL THEN
    RAISE EXCEPTION 'POS FALHOU: funcao ausente (fator % / job %)', v_fn, v_job;
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = v_fn AND a.grantee = 0) THEN
    RAISE EXCEPTION 'POS FALHOU [POS_ACL_ANON]: calendario_fator_demanda executavel por anon/PUBLIC';
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: calendario_fator_demanda sem EXECUTE para authenticated/service_role (a view quebraria)';
  END IF;
  IF has_function_privilege('authenticated', v_job, 'EXECUTE') OR has_function_privilege('anon', v_job, 'EXECUTE')
     OR has_function_privilege('service_role', v_job, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: job da sombra executavel fora do owner';
  END IF;
  IF (SELECT count(*) FROM pg_class
       WHERE oid IN ('public.v_sku_parametros_sugeridos'::regclass, 'public.v_sku_demanda_estatisticas'::regclass)
         AND 'security_invoker=on' = ANY (reloptions)) <> 2 THEN
    RAISE EXCEPTION 'POS FALHOU: security_invoker=on ausente numa das views (bypass de RLS)';
  END IF;
  IF md5(pg_get_viewdef('public.v_sku_parametros_sugeridos'::regclass, true)) IS DISTINCT FROM 'cec8b64723d20a5400deace2ea34838c'
     OR md5(pg_get_viewdef('public.v_sku_demanda_estatisticas'::regclass, true)) IS DISTINCT FROM '5cc2c267e2ecbe64c393f15e531a770a' THEN
    RAISE EXCEPTION 'POS FALHOU: texto das views nao e o deste arquivo (par % / est %)',
      md5(pg_get_viewdef('public.v_sku_parametros_sugeridos'::regclass, true)),
      md5(pg_get_viewdef('public.v_sku_demanda_estatisticas'::regclass, true));
  END IF;
  -- Allowlist medida pelo has_*_privilege (enxerga herança): fora o dono, ninguém executa o job nem escreve a sombra.
  SELECT string_agg(r.rolname, ', ') INTO v_papeis
    FROM pg_roles r
   WHERE NOT r.rolsuper AND r.rolname NOT LIKE 'pg\_%'
     AND r.oid <> (SELECT proowner FROM pg_proc WHERE oid = v_job)
     AND (has_function_privilege(r.oid, v_job, 'EXECUTE')
          OR has_table_privilege(r.oid, 'public.reposicao_demanda_calendario_sombra', 'INSERT, UPDATE, DELETE, TRUNCATE'));
  IF v_papeis IS NOT NULL THEN
    RAISE EXCEPTION 'POS FALHOU [POS_ACL_SOMBRA]: job/sombra executavel ou gravavel por %', v_papeis;
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.reposicao_demanda_calendario_sombra'::regclass) THEN
    RAISE EXCEPTION 'POS FALHOU: RLS desligada na tabela da sombra';
  END IF;
  -- Neutralidade da SOMBRA: com o modo sombra, o d servido é o legado em TODA linha.
  PERFORM pg_catalog.set_config('reposicao.demanda_calendario_forcar', 'sombra', true);
  SELECT count(*) INTO v_n FROM public.v_sku_parametros_sugeridos
   WHERE demanda_media_diaria IS DISTINCT FROM demanda_media_diaria_legado;
  PERFORM pg_catalog.set_config('reposicao.demanda_calendario_forcar', '', true);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'POS FALHOU [POS_SOMBRA]: em sombra % linha(s) servem d diferente do legado', v_n;
  END IF;
  IF to_regprocedure('cron.schedule(text, text, text)') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reposicao-demanda-calendario-sombra') THEN
    RAISE EXCEPTION 'POS FALHOU: cron da sombra nao agendado';
  END IF;
  RAISE NOTICE 'POST calendario demanda OK';
END
$post$;
