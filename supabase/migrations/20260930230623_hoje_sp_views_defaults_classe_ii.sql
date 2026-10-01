-- 20260930230623_hoje_sp_views_defaults_classe_ii.sql
-- ============================================================
-- O "hoje" de 18 views e de 6 DEFAULTs de coluna passa a ser o dia de SÃO PAULO, seja qual for o
-- TimeZone da sessão — a fase 2 da classe (ii) do fuso da sessão (o dia lido NU).
-- ============================================================
-- A classe (docs/agent/money-path.md, "Prova que depende da HORA"): a prod roda sessões em UTC
-- (arquivo de configuração; 0 overrides em pg_db_role_setting — remedido via psql-ro em 2026-09-30),
-- e o PostgREST herda. CURRENT_DATE, now()::date e o instante que vira data por ::date usam o fuso da
-- SESSÃO: das 21:00 às 23:59 BRT dão o dia SEGUINTE ao de São Paulo. A fase 1 (20260929001651)
-- consertou 7 funções e as skills e criou o gate scripts/relogio-nu-da-sessao-gate.ts; esta é a das
-- views, matviews e DEFAULTs, que nenhum gate textual vê quando vivem só na prod.
--
-- A varredura (prod, 2026-09-30, com a assinatura do próprio gate — detectarNoSql — sobre
-- pg_get_viewdef/pg_get_expr): 84 views → 20 casam; 5 matviews → 2; 1.570 DEFAULTs → 10; 424 CHECKs,
-- 749 policies e 99 crons → 0. E um universo que a varredura por prosrc não lia: DEFAULT de PARÂMETRO
-- de função (proargdefaults) — 91 funções com default, 4 casam, todas `p_data_ciclo date DEFAULT
-- CURRENT_DATE` (a família data_ciclo, abaixo).
--
-- Consertadas aqui (o veredito de cada uma no PR; a tabela inteira, inclusive o que fica):
--   · fin_aging_pagar / fin_aging_receber: o título que vence hoje virava "vencido 1-30" às 21h
--     (financeiro, cockpit, dashboard, alerta de 90+) — em 30/09, 17 títulos a receber (R$ 8.511,52) e
--     6 a pagar (R$ 34.372,97) venciam no dia;
--   · v_grupo_contas_receber / _por_doc / v_grupo_comercial: o mesmo aging e a recência do grupo
--     (v_grupo_comercial pareia so.created_at::date com o hoje: os DOIS lados mudam juntos; 0 grupos
--     cadastrados hoje);
--   · v_caca_candidatos / v_caca_compradores: recência +1 (a fronteira "dormente" da Caça) — e o
--     `(now() - '6 mons')::date` do ativo_6m, a forma que a assinatura do gate não casava;
--   · v_sku_parametros_sugeridos e as que a alimentam (v_sku_sigma_demanda, v_sku_demanda_rajada,
--     v_sku_demanda_estatisticas, v_sku_leadtime_estatisticas, v_fornecedor_lt_logistica_total):
--     as janelas de 90/180 dias sobre data_emissao (dia de SP, do Omie) andavam um dia às 21h, e o
--     "ontem" da série de sigma virava o hoje de SP. Quem GRAVA a partir delas: a classificação
--     ABC/XYZ roda a cada 2h (omie-cron-diario, também 21:15 e 23:15 BRT) e adiantava a janela em
--     ~4h; os parâmetros numéricos têm trava de 1 run por dia de negócio de SP (115 de 118 runs à
--     01:xx BRT; 1 caiu na janela, 2026-07-02);
--   · v_sku_candidatos_primeira_compra, v_sku_aumento_vigente, v_sugestao_negociacao_ativa,
--     v_desconto_flat_condicional_ativo, fin_fluxo_caixa_diario: recência, prazos e janelas de
--     exibição (as 4 últimas sem dado ou sem consumidor hoje — consertadas pelo mesmo custo);
--   · DEFAULTs de priority_score_log.score_date (46.328 linhas de 8 execuções manuais noturnas com o
--     dia de amanhã), sugestao_negociacao_paralela.data_geracao/valido_ate,
--     fornecedor_cadeia_logistica.valido_desde, sku_embalagem_equivalencia.vigente_desde e
--     farmer_agenda.agenda_date — carimbos cujo leitor, quando existe, é de SP.
--
-- Fora, medido, com dono:
--   · v_oportunidade_economica_hoje e v_promocao_avaliacao_hoje: o "hoje" delas decide quais
--     promoções entram num pedido cujo data_ciclo nasce UTC (o DEFAULT de parâmetro das 4 funções de
--     ciclo e o edge gerar-pedidos-diario) — trocar só a view descasaria os dois lados num disparo
--     manual noturno. Vão com a família data_ciclo (0 ciclos de oportunidade na janela; 0 campanhas
--     ativas hoje);
--   · pedido_compra_sugerido.data_ciclo (DEFAULT nunca exercido: todo escritor passa a data) e os 4
--     DEFAULTs de parâmetro — a família data_ciclo, junto com o edge;
--   · route_visits.visit_date: leitores MISTOS (o planner e os KPIs de 30 dias leem o hoje UTC; o MTD
--     e a positivação, o mês de SP) — trocar o DEFAULT sozinho move a divergência de lugar; vai com a
--     classe irmã no TypeScript (0 linhas hoje);
--   · reposicao_param_fila_log/limbo_log.medido_em: UTC contra UTC (os sensores passam CURRENT_DATE
--     explícito e releem o próprio carimbo; crons 08:30/08:45 BRT);
--   · as 2 matviews: private.mv_oportunidade_badge (o calculado_em não tem leitor; a contagem vem de
--     v_oportunidade_economica_hoje) e private.mv_sku_ranking_negociacao_paralela (dormente; refresh
--     segunda 07:00 BRT). Consertá-las exigiria DROP + CREATE.
--
-- Conserto: o fuso ESCRITO. O dia de SP é (now() AT TIME ZONE 'America/Sao_Paulo')::date; o instante
-- que vira data, (col AT TIME ZONE 'America/Sao_Paulo')::date. A borda contra TIMESTAMPTZ segue o tipo: em
-- v_sku_leadtime_estatisticas, t2_data_faturamento é timestamptz, e `dia - '180 days'` é timestamp SEM
-- fuso — compará-los converte no fuso da SESSÃO (sob UTC, a borda caía às 21:00 BRT de D-181, o dia
-- inteiro). Lá a borda passa a ser o INSTANTE da meia-noite de SP: (dia_sp - '180 days') AT TIME ZONE
-- 'America/Sao_Paulo'. Os outros 74 sítios comparam date com date/timestamp — sem fuso no meio. Cada view abaixo é o texto VIVO da prod
-- (pg_get_viewdef(oid, true), 2026-09-30) com o relógio trocado e nada mais — gerada por troca exata
-- com contagem conferida, e ponto fixo do deparse (o que o Postgres devolve depois de instalada é o
-- mesmo texto). security_invoker repetido com o literal de cada uma (on/true): omiti-lo num replace
-- RESETA a opção e a view passa a ler como dono, sem RLS (database.md §4). CREATE OR REPLACE preserva
-- o ACL e os dependentes (as 4 views e as 6 funções que leem v_sku_parametros_sugeridos); a pós-
-- condição confere o ACL contra a foto tirada na pré. As colunas, a ordem e os tipos não mudam.
--
-- Identidade (PRE e POS): md5 EXATO do pg_get_viewdef(oid, true) e o pg_get_expr literal do DEFAULT,
-- medidos na prod sob o search_path do executor (o de public.aplicar_sql: pg_catalog, public,
-- pg_temp — e o do claude_ro dá os mesmos 22 md5).
--
-- Prova: db/test-hoje-sp-views-defaults.sh (PG17 com o schema-snapshot da prod e as predecessoras
-- EXATAS da fixture db/fixtures/hoje-sp-views-defaults-predecessoras-prod-20260930.sql; relógio
-- controlado cruzando 21:00 BRT sob TimeZone=UTC E America/Sao_Paulo) e o mesmo script com
-- --falsificar. Aplicação: bun run db:aplicar — a transação é do executor, por isso não há
-- BEGIN/COMMIT aqui. Reverter depois do commit = migration compensatória nova.


-- Trava ANTES da pré-condição (o achado do Codex na 20260927202603): sem ela, outra transação
-- podia recriar uma destas views (ou trocar um destes DEFAULTs) entre a conferência e a troca, e
-- esta migration apagaria a mudança dela em silêncio. O ALTER VIEW sem efeito prende a view até o
-- fim da transação; o LOCK das tabelas dos DEFAULTs (SHARE UPDATE EXCLUSIVE: leitura e escrita de
-- linha seguem, DDL concorrente espera) faz o mesmo pelo catálogo da coluna. A ORDEM das views é a
-- dos LEITORES (medida: o rewriter trava a view lida e depois as de dentro) — outra ordem abre deadlock
-- com uma tela ou um cron lendo a cadeia de reposição no mesmo instante.
DO $trava$
BEGIN
  IF to_regclass('public.v_sku_candidatos_primeira_compra') IS NOT NULL THEN
    ALTER VIEW public.v_sku_candidatos_primeira_compra SET (security_invoker = on);
  END IF;
  IF to_regclass('public.v_sku_aumento_vigente') IS NOT NULL THEN
    ALTER VIEW public.v_sku_aumento_vigente SET (security_invoker = on);
  END IF;
  IF to_regclass('public.v_sku_parametros_sugeridos') IS NOT NULL THEN
    ALTER VIEW public.v_sku_parametros_sugeridos SET (security_invoker = on);
  END IF;
  IF to_regclass('public.v_sku_demanda_rajada') IS NOT NULL THEN
    ALTER VIEW public.v_sku_demanda_rajada SET (security_invoker = on);
  END IF;
  IF to_regclass('public.v_sku_leadtime_estatisticas') IS NOT NULL THEN
    ALTER VIEW public.v_sku_leadtime_estatisticas SET (security_invoker = on);
  END IF;
  IF to_regclass('public.v_sku_sigma_demanda') IS NOT NULL THEN
    ALTER VIEW public.v_sku_sigma_demanda SET (security_invoker = on);
  END IF;
  IF to_regclass('public.v_sku_demanda_estatisticas') IS NOT NULL THEN
    ALTER VIEW public.v_sku_demanda_estatisticas SET (security_invoker = on);
  END IF;
  IF to_regclass('public.v_fornecedor_lt_logistica_total') IS NOT NULL THEN
    ALTER VIEW public.v_fornecedor_lt_logistica_total SET (security_invoker = on);
  END IF;
  IF to_regclass('public.fin_aging_pagar') IS NOT NULL THEN
    ALTER VIEW public.fin_aging_pagar SET (security_invoker = on);
  END IF;
  IF to_regclass('public.fin_aging_receber') IS NOT NULL THEN
    ALTER VIEW public.fin_aging_receber SET (security_invoker = on);
  END IF;
  IF to_regclass('public.fin_fluxo_caixa_diario') IS NOT NULL THEN
    ALTER VIEW public.fin_fluxo_caixa_diario SET (security_invoker = on);
  END IF;
  IF to_regclass('public.v_caca_candidatos') IS NOT NULL THEN
    ALTER VIEW public.v_caca_candidatos SET (security_invoker = on);
  END IF;
  IF to_regclass('public.v_caca_compradores') IS NOT NULL THEN
    ALTER VIEW public.v_caca_compradores SET (security_invoker = on);
  END IF;
  IF to_regclass('public.v_desconto_flat_condicional_ativo') IS NOT NULL THEN
    ALTER VIEW public.v_desconto_flat_condicional_ativo SET (security_invoker = on);
  END IF;
  IF to_regclass('public.v_grupo_comercial') IS NOT NULL THEN
    ALTER VIEW public.v_grupo_comercial SET (security_invoker = true);
  END IF;
  IF to_regclass('public.v_grupo_contas_receber') IS NOT NULL THEN
    ALTER VIEW public.v_grupo_contas_receber SET (security_invoker = true);
  END IF;
  IF to_regclass('public.v_grupo_contas_receber_por_doc') IS NOT NULL THEN
    ALTER VIEW public.v_grupo_contas_receber_por_doc SET (security_invoker = true);
  END IF;
  IF to_regclass('public.v_sugestao_negociacao_ativa') IS NOT NULL THEN
    ALTER VIEW public.v_sugestao_negociacao_ativa SET (security_invoker = on);
  END IF;
  IF to_regclass('public.farmer_agenda') IS NOT NULL THEN
    LOCK TABLE public.farmer_agenda IN SHARE UPDATE EXCLUSIVE MODE;
  END IF;
  IF to_regclass('public.fornecedor_cadeia_logistica') IS NOT NULL THEN
    LOCK TABLE public.fornecedor_cadeia_logistica IN SHARE UPDATE EXCLUSIVE MODE;
  END IF;
  IF to_regclass('public.priority_score_log') IS NOT NULL THEN
    LOCK TABLE public.priority_score_log IN SHARE UPDATE EXCLUSIVE MODE;
  END IF;
  IF to_regclass('public.sku_embalagem_equivalencia') IS NOT NULL THEN
    LOCK TABLE public.sku_embalagem_equivalencia IN SHARE UPDATE EXCLUSIVE MODE;
  END IF;
  IF to_regclass('public.sugestao_negociacao_paralela') IS NOT NULL THEN
    LOCK TABLE public.sugestao_negociacao_paralela IN SHARE UPDATE EXCLUSIVE MODE;
  END IF;
END
$trava$;

-- Pré-condição: cada view viva tem de ser a PREDECESSORA revisada (o texto da prod em 2026-09-30)
-- ou JÁ esta (re-aplicar é seguro); cada DEFAULT, o antigo ou já o novo. Qualquer outro é mudança
-- concorrente que este replace apagaria — aborta. Objeto ausente (ambiente novo) segue. E o ACL de
-- cada view é fotografado aqui: a pós-condição exige que o replace o tenha deixado IGUAL.
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.predecessor, x.este,
           (SELECT md5(pg_catalog.pg_get_viewdef(c.oid, true))
              FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('public.' || x.alvo)) AS vivo
      FROM (VALUES
        ('fin_aging_pagar', '2d02bd1acd7a9a8aa48f18d0ee6691f3', 'fc866c3e79b281b50a9348bc72c0c005'),
        ('fin_aging_receber', '28e6654b9a0f7b4a1b35ab9bd906afa3', 'cbdbef687d520889236a948144a48675'),
        ('fin_fluxo_caixa_diario', '33398b163ad8d20a8380f23776d27fe3', '226717ab7773079782316aa0bacced7e'),
        ('v_caca_candidatos', 'b90a93708c25bc47179d858a729256d0', '24af34211e33745ac90b36c559561dbe'),
        ('v_caca_compradores', 'cd931d3bc04ed42f8c9d6b2650121b90', '41cce289721d3631b1bd518e55dc048f'),
        ('v_desconto_flat_condicional_ativo', 'ead12cfd33d772255eb6e5b23704b2e8', '494a8aa614db6c8a5299fa6bb4e5f29b'),
        ('v_fornecedor_lt_logistica_total', 'ed557e9f9f59fb99f73eddfdec42b131', '1405d96cc9817129839f73a64fb647c6'),
        ('v_grupo_comercial', '4f46e679984cc08fe923a29fc10f1932', '73de52bd7737a62d2828589f97661e9a'),
        ('v_grupo_contas_receber', '0eabf4bd91c081fb9145bb1ff7ccbd38', 'b05ddadaa94d946e3e84184cee2b97ed'),
        ('v_grupo_contas_receber_por_doc', '7cc116d7e46519514a2ec5dfce2f9aa3', 'ab437b5db3d7f3f914c7d31c0783133f'),
        ('v_sku_aumento_vigente', '1030e9629dca90d57b9a01c442ef8068', '3d12ee0c70206f5cd2fe47cab60e0779'),
        ('v_sku_candidatos_primeira_compra', 'e7e0fe5a21deb5f8a57bc92a94fb5add', '0cd9b6439b4bb72a84bf9d6acea9e4b3'),
        ('v_sku_demanda_estatisticas', 'c7709f8bf2895a3d5fa3d27fb1cf3392', 'f05c5621d0254b746c6ada8cb0c9d22a'),
        ('v_sku_demanda_rajada', '0b33fed6f59248e67fe4f69e827d4385', '91fce84224800a53021d3022d297aac2'),
        ('v_sku_leadtime_estatisticas', 'c79f588df7d2730bed30538a42990824', '3dc951377dd8c0da5d23a95a7ea3deef'),
        ('v_sku_parametros_sugeridos', '7ab48641a711d5a335ae88941a1537e5', 'cb7f8b8b2286ca815c0a76ea8aa412de'),
        ('v_sku_sigma_demanda', 'f6070e0a25bce59593ee5e00cfa5814b', '7be1b6b1f09c0943ed20b70a91f49ea4'),
        ('v_sugestao_negociacao_ativa', 'd65d940ac9384ddf86c4c8d6987eb704', '031084feabb96a7f903eda803cb24ffd')
      ) AS x(alvo, predecessor, este)
  LOOP
    IF r.vivo IS NOT NULL AND r.vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: a view % viva (md5 %) não é a predecessora revisada nem esta — outra mudança chegou antes; reconcilie antes de aplicar', r.alvo, r.vivo;
    END IF;
  END LOOP;
  FOR r IN
    SELECT x.tabela, x.coluna, x.antigo, x.novo,
           (SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid)
              FROM pg_catalog.pg_attrdef d
              JOIN pg_catalog.pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
             WHERE d.adrelid = to_regclass('public.' || x.tabela) AND a.attname = x.coluna) AS vivo
      FROM (VALUES
        ('farmer_agenda', 'agenda_date', 'CURRENT' || '_DATE', '((now() AT TIME ZONE ''America/Sao_Paulo''::text))::date'),
        ('fornecedor_cadeia_logistica', 'valido_desde', 'CURRENT' || '_DATE', '((now() AT TIME ZONE ''America/Sao_Paulo''::text))::date'),
        ('priority_score_log', 'score_date', 'CURRENT' || '_DATE', '((now() AT TIME ZONE ''America/Sao_Paulo''::text))::date'),
        ('sku_embalagem_equivalencia', 'vigente_desde', 'CURRENT' || '_DATE', '((now() AT TIME ZONE ''America/Sao_Paulo''::text))::date'),
        ('sugestao_negociacao_paralela', 'data_geracao', 'CURRENT' || '_DATE', '((now() AT TIME ZONE ''America/Sao_Paulo''::text))::date'),
        ('sugestao_negociacao_paralela', 'valido_ate', '(' || 'CURRENT' || '_DATE' || ' + ''14 days''::interval)', '(((now() AT TIME ZONE ''America/Sao_Paulo''::text))::date + ''14 days''::interval)')
      ) AS x(tabela, coluna, antigo, novo)
  LOOP
    IF to_regclass('public.' || r.tabela) IS NOT NULL AND r.vivo IS DISTINCT FROM r.antigo AND r.vivo IS DISTINCT FROM r.novo THEN
      RAISE EXCEPTION 'PRE FALHOU: o DEFAULT de %.% vivo (%) não é o antigo nem o desta migration — reconcilie antes de aplicar', r.tabela, r.coluna, r.vivo;
    END IF;
  END LOOP;
  CREATE TEMP TABLE hoje_sp_acl_antes ON COMMIT DROP AS
    SELECT c.relname::text AS alvo, c.relacl::text AS acl
      FROM pg_catalog.pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'v'
       AND c.relname = ANY (ARRAY[
         'fin_aging_pagar',
         'fin_aging_receber',
         'fin_fluxo_caixa_diario',
         'v_caca_candidatos',
         'v_caca_compradores',
         'v_desconto_flat_condicional_ativo',
         'v_fornecedor_lt_logistica_total',
         'v_grupo_comercial',
         'v_grupo_contas_receber',
         'v_grupo_contas_receber_por_doc',
         'v_sku_aumento_vigente',
         'v_sku_candidatos_primeira_compra',
         'v_sku_demanda_estatisticas',
         'v_sku_demanda_rajada',
         'v_sku_leadtime_estatisticas',
         'v_sku_parametros_sugeridos',
         'v_sku_sigma_demanda',
         'v_sugestao_negociacao_ativa']);
END
$pre$;

-- As 18 views: o texto VIVO da prod com o relógio trocado, e nada mais (gerado por troca exata com
-- contagem conferida; cada texto abaixo é ponto fixo do deparse — o que o Postgres devolve depois
-- de instalado é este mesmo texto, e é por isso que a pós-condição o confere por md5).

CREATE OR REPLACE VIEW public.fin_aging_pagar
  WITH (security_invoker = on)
  AS
 SELECT company,
    count(*) FILTER (WHERE data_vencimento >= (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date) AS a_vencer_qtd,
    COALESCE(sum(saldo) FILTER (WHERE data_vencimento >= (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date), 0::numeric) AS a_vencer_valor,
    count(*) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) >= 1 AND ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) <= 30) AS vencido_1_30_qtd,
    COALESCE(sum(saldo) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) >= 1 AND ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) <= 30), 0::numeric) AS vencido_1_30_valor,
    count(*) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) >= 31 AND ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) <= 60) AS vencido_31_60_qtd,
    COALESCE(sum(saldo) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) >= 31 AND ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) <= 60), 0::numeric) AS vencido_31_60_valor,
    count(*) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) >= 61 AND ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) <= 90) AS vencido_61_90_qtd,
    COALESCE(sum(saldo) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) >= 61 AND ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) <= 90), 0::numeric) AS vencido_61_90_valor,
    count(*) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) > 90) AS vencido_90_plus_qtd,
    COALESCE(sum(saldo) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) > 90), 0::numeric) AS vencido_90_plus_valor
   FROM fin_contas_pagar
  WHERE status_titulo <> ALL (ARRAY['PAGO'::text, 'CANCELADO'::text])
  GROUP BY company;

CREATE OR REPLACE VIEW public.fin_aging_receber
  WITH (security_invoker = on)
  AS
 SELECT company,
    count(*) FILTER (WHERE data_vencimento >= (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date) AS a_vencer_qtd,
    COALESCE(sum(saldo) FILTER (WHERE data_vencimento >= (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date), 0::numeric) AS a_vencer_valor,
    count(*) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) >= 1 AND ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) <= 30) AS vencido_1_30_qtd,
    COALESCE(sum(saldo) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) >= 1 AND ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) <= 30), 0::numeric) AS vencido_1_30_valor,
    count(*) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) >= 31 AND ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) <= 60) AS vencido_31_60_qtd,
    COALESCE(sum(saldo) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) >= 31 AND ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) <= 60), 0::numeric) AS vencido_31_60_valor,
    count(*) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) >= 61 AND ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) <= 90) AS vencido_61_90_qtd,
    COALESCE(sum(saldo) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) >= 61 AND ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) <= 90), 0::numeric) AS vencido_61_90_valor,
    count(*) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) > 90) AS vencido_90_plus_qtd,
    COALESCE(sum(saldo) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - data_vencimento) > 90), 0::numeric) AS vencido_90_plus_valor
   FROM fin_contas_receber
  WHERE status_titulo <> ALL (ARRAY['RECEBIDO'::text, 'CANCELADO'::text])
  GROUP BY company;

CREATE OR REPLACE VIEW public.fin_fluxo_caixa_diario
  WITH (security_invoker = on)
  AS
 WITH datas AS (
         SELECT d_1.d::date AS data
           FROM generate_series((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '90 days'::interval, (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date + '90 days'::interval, '1 day'::interval) d_1(d)
        ), empresas AS (
         SELECT DISTINCT fin_contas_receber.company
           FROM fin_contas_receber
        UNION
         SELECT DISTINCT fin_contas_pagar.company
           FROM fin_contas_pagar
        ), cr_agg AS (
         SELECT fin_contas_receber.company,
            fin_contas_receber.data_vencimento AS data,
            sum(
                CASE
                    WHEN fin_contas_receber.status_titulo = ANY (ARRAY['ABERTO'::text, 'PARCIAL'::text, 'VENCIDO'::text]) THEN fin_contas_receber.valor_documento
                    ELSE 0::numeric
                END) AS entradas_previstas,
            0::numeric AS entradas_realizadas
           FROM fin_contas_receber
          WHERE fin_contas_receber.data_vencimento IS NOT NULL
          GROUP BY fin_contas_receber.company, fin_contas_receber.data_vencimento
        UNION ALL
         SELECT fin_contas_receber.company,
            fin_contas_receber.data_recebimento AS data,
            0::numeric AS entradas_previstas,
            sum(fin_contas_receber.valor_recebido) AS entradas_realizadas
           FROM fin_contas_receber
          WHERE fin_contas_receber.data_recebimento IS NOT NULL AND (fin_contas_receber.status_titulo = ANY (ARRAY['RECEBIDO'::text, 'LIQUIDADO'::text, 'PARCIAL'::text]))
          GROUP BY fin_contas_receber.company, fin_contas_receber.data_recebimento
        ), cp_agg AS (
         SELECT fin_contas_pagar.company,
            fin_contas_pagar.data_vencimento AS data,
            sum(
                CASE
                    WHEN fin_contas_pagar.status_titulo = ANY (ARRAY['ABERTO'::text, 'PARCIAL'::text, 'VENCIDO'::text]) THEN fin_contas_pagar.valor_documento
                    ELSE 0::numeric
                END) AS saidas_previstas,
            0::numeric AS saidas_realizadas
           FROM fin_contas_pagar
          WHERE fin_contas_pagar.data_vencimento IS NOT NULL
          GROUP BY fin_contas_pagar.company, fin_contas_pagar.data_vencimento
        UNION ALL
         SELECT fin_contas_pagar.company,
            fin_contas_pagar.data_pagamento AS data,
            0::numeric AS saidas_previstas,
            sum(fin_contas_pagar.valor_pago) AS saidas_realizadas
           FROM fin_contas_pagar
          WHERE fin_contas_pagar.data_pagamento IS NOT NULL AND (fin_contas_pagar.status_titulo = ANY (ARRAY['PAGO'::text, 'LIQUIDADO'::text, 'PARCIAL'::text]))
          GROUP BY fin_contas_pagar.company, fin_contas_pagar.data_pagamento
        )
 SELECT e.company,
    d.data,
    COALESCE(sum(cr.entradas_previstas), 0::numeric) AS entradas_previstas,
    COALESCE(sum(cr.entradas_realizadas), 0::numeric) AS entradas_realizadas,
    COALESCE(sum(cp.saidas_previstas), 0::numeric) AS saidas_previstas,
    COALESCE(sum(cp.saidas_realizadas), 0::numeric) AS saidas_realizadas
   FROM datas d
     CROSS JOIN empresas e
     LEFT JOIN cr_agg cr ON cr.company = e.company AND cr.data = d.data
     LEFT JOIN cp_agg cp ON cp.company = e.company AND cp.data = d.data
  GROUP BY e.company, d.data;

CREATE OR REPLACE VIEW public.v_caca_candidatos
  WITH (security_invoker = on)
  AS
 WITH cli AS (
         SELECT p.user_id,
            p.name,
            p.phone,
            p.cnae,
                CASE
                    WHEN length(regexp_replace(COALESCE(p.document, ''::text), '\D'::text, ''::text, 'g'::text)) = ANY (ARRAY[11, 14]) THEN regexp_replace(COALESCE(p.document, ''::text), '\D'::text, ''::text, 'g'::text)
                    WHEN length(regexp_replace(COALESCE(p.cnpj, ''::text), '\D'::text, ''::text, 'g'::text)) = ANY (ARRAY[11, 14]) THEN regexp_replace(COALESCE(p.cnpj, ''::text), '\D'::text, ''::text, 'g'::text)
                    ELSE NULL::text
                END AS documento
           FROM profiles p
          WHERE COALESCE(p.is_employee, false) = false
        ), cli_valid AS (
         SELECT DISTINCT ON (cli.user_id) cli.user_id,
            cli.documento,
            cli.name,
            cli.phone,
            cli.cnae
           FROM cli
          WHERE cli.documento IS NOT NULL
          ORDER BY cli.user_id, cli.documento
        ), cli_doc AS (
         SELECT DISTINCT ON (cli_valid.documento) cli_valid.documento,
            cli_valid.user_id,
            cli_valid.name,
            cli_valid.phone,
            cli_valid.cnae
           FROM cli_valid
          ORDER BY cli_valid.documento, cli_valid.user_id
        ), so_ok AS (
         SELECT so.id,
            so.account,
            so.total,
            COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo'::text)::date) AS dt,
            cv.documento
           FROM sales_orders so
             JOIN cli_valid cv ON cv.user_id = so.customer_user_id
          WHERE so.deleted_at IS NULL AND (so.status <> ALL (ARRAY['cancelado'::text, 'rascunho'::text])) AND (so.account = ANY (ARRAY['oben'::text, 'colacor'::text]))
        ), ativ AS (
         SELECT so_ok.documento,
            so_ok.account,
            max(so_ok.dt) >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text) - '6 mons'::interval)::date AS ativo_6m
           FROM so_ok
          GROUP BY so_ok.documento, so_ok.account
        ), grupo AS (
         SELECT so_ok.documento,
            max(so_ok.dt) AS ultima_grupo,
            sum(so_ok.total) AS volume_grupo,
            count(*) AS pedidos_grupo
           FROM so_ok
          GROUP BY so_ok.documento
        ), oi_dedup AS (
         SELECT DISTINCT ON (oi.sales_order_id, oi.omie_codigo_produto) oi.sales_order_id,
            oi.product_id
           FROM order_items oi
          ORDER BY oi.sales_order_id, oi.omie_codigo_produto, oi.id
        ), fam_grupo AS (
         SELECT s.documento,
            array_agg(DISTINCT op.familia) FILTER (WHERE op.familia IS NOT NULL AND op.familia <> ''::text) AS familias
           FROM so_ok s
             JOIN oi_dedup d ON d.sales_order_id = s.id
             JOIN omie_products op ON op.id = d.product_id AND op.account = s.account
          GROUP BY s.documento
        ), cid AS (
         SELECT DISTINCT ON (addresses.user_id) addresses.user_id,
            (addresses.city || '-'::text) || addresses.state AS cidade_uf
           FROM addresses
          WHERE COALESCE(addresses.city, ''::text) <> ''::text AND COALESCE(addresses.state, ''::text) <> ''::text
          ORDER BY addresses.user_id, addresses.is_default DESC NULLS LAST, addresses.created_at DESC NULLS LAST
        ), optout_doc AS (
         SELECT DISTINCT cv.documento
           FROM whatsapp_conversations wc
             JOIN cli_valid cv ON cv.user_id = wc.customer_user_id
          WHERE wc.opt_in_status = 'opt_out'::text
        UNION
         SELECT DISTINCT cv.documento
           FROM whatsapp_conversations wc
             JOIN cli_valid cv ON "right"(regexp_replace(COALESCE(cv.phone, ''::text), '\D'::text, ''::text, 'g'::text), 11) = "right"(regexp_replace(COALESCE(wc.phone_e164, wc.phone_key, ''::text), '\D'::text, ''::text, 'g'::text), 11)
          WHERE wc.opt_in_status = 'opt_out'::text AND length(regexp_replace(COALESCE(cv.phone, ''::text), '\D'::text, ''::text, 'g'::text)) >= 10
        ), alvos AS (
         SELECT unnest(ARRAY['oben'::text, 'colacor'::text]) AS empresa_alvo
        ), cand AS (
         SELECT cd.documento,
            a.empresa_alvo,
            cd.user_id,
            cd.name,
            cd.phone,
            cd.cnae
           FROM cli_doc cd
             CROSS JOIN alvos a
          WHERE NOT (EXISTS ( SELECT 1
                   FROM ativ av
                  WHERE av.documento = cd.documento AND av.account = a.empresa_alvo AND av.ativo_6m)) AND NOT (EXISTS ( SELECT 1
                   FROM optout_doc oo
                  WHERE oo.documento = cd.documento))
        )
 SELECT cand.documento,
    cand.empresa_alvo,
    cid.cidade_uf,
    cand.cnae AS ramo,
        CASE
            WHEN g.pedidos_grupo > 0 THEN round(g.volume_grupo / g.pedidos_grupo::numeric, 2)
            ELSE NULL::numeric
        END AS ticket_faixa,
    COALESCE(fg.familias, ARRAY[]::text[]) AS familias,
    (EXISTS ( SELECT 1
           FROM ativ av2
          WHERE av2.documento = cand.documento AND av2.account <> cand.empresa_alvo AND av2.ativo_6m)) AS compra_em_outra_empresa,
        CASE
            WHEN g.ultima_grupo IS NOT NULL THEN (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - g.ultima_grupo
            ELSE NULL::integer
        END AS ultima_compra_grupo_dias,
    cand.name AS nome,
    cand.phone AS telefone,
    cand.user_id AS cliente_user_id
   FROM cand
     LEFT JOIN grupo g ON g.documento = cand.documento
     LEFT JOIN fam_grupo fg ON fg.documento = cand.documento
     LEFT JOIN cid ON cid.user_id = cand.user_id;

CREATE OR REPLACE VIEW public.v_caca_compradores
  WITH (security_invoker = on)
  AS
 WITH cli AS (
         SELECT p.user_id,
            p.name,
            p.phone,
            p.cnae,
                CASE
                    WHEN length(regexp_replace(COALESCE(p.document, ''::text), '\D'::text, ''::text, 'g'::text)) = ANY (ARRAY[11, 14]) THEN regexp_replace(COALESCE(p.document, ''::text), '\D'::text, ''::text, 'g'::text)
                    WHEN length(regexp_replace(COALESCE(p.cnpj, ''::text), '\D'::text, ''::text, 'g'::text)) = ANY (ARRAY[11, 14]) THEN regexp_replace(COALESCE(p.cnpj, ''::text), '\D'::text, ''::text, 'g'::text)
                    ELSE NULL::text
                END AS documento
           FROM profiles p
          WHERE COALESCE(p.is_employee, false) = false
        ), cli_valid AS (
         SELECT DISTINCT ON (cli.user_id) cli.user_id,
            cli.documento,
            cli.name,
            cli.phone,
            cli.cnae
           FROM cli
          WHERE cli.documento IS NOT NULL
          ORDER BY cli.user_id, cli.documento
        ), cli_doc AS (
         SELECT DISTINCT ON (cli_valid.documento) cli_valid.documento,
            cli_valid.user_id,
            cli_valid.name,
            cli_valid.phone,
            cli_valid.cnae
           FROM cli_valid
          ORDER BY cli_valid.documento, cli_valid.user_id
        ), so_ok AS (
         SELECT so.id,
            so.account,
            so.total,
            COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo'::text)::date) AS dt,
            cv.documento
           FROM sales_orders so
             JOIN cli_valid cv ON cv.user_id = so.customer_user_id
          WHERE so.deleted_at IS NULL AND (so.status <> ALL (ARRAY['cancelado'::text, 'rascunho'::text])) AND (so.account = ANY (ARRAY['oben'::text, 'colacor'::text]))
        ), compras AS (
         SELECT so_ok.documento,
            so_ok.account,
            count(*) AS n_pedidos,
            sum(so_ok.total) AS volume,
            max(so_ok.dt) AS ultima
           FROM so_ok
          GROUP BY so_ok.documento, so_ok.account
        ), oi_dedup AS (
         SELECT DISTINCT ON (oi.sales_order_id, oi.omie_codigo_produto) oi.sales_order_id,
            oi.product_id,
            oi.quantity,
            oi.unit_price
           FROM order_items oi
          ORDER BY oi.sales_order_id, oi.omie_codigo_produto, oi.id
        ), itens AS (
         SELECT s.documento,
            s.account,
            d.quantity,
            d.unit_price,
            op.familia,
            COALESCE(
                CASE
                    WHEN pc.custo_producao_status = 'ok'::text THEN pc.custo_producao
                    ELSE NULL::numeric
                END, NULLIF(pc.cmc, 0::numeric)) AS custo_efetivo
           FROM so_ok s
             JOIN oi_dedup d ON d.sales_order_id = s.id
             JOIN omie_products op ON op.id = d.product_id AND op.account = s.account
             LEFT JOIN product_costs pc ON pc.product_id = op.id
        ), fam AS (
         SELECT itens.documento,
            itens.account,
            array_agg(DISTINCT itens.familia) FILTER (WHERE itens.familia IS NOT NULL AND itens.familia <> ''::text) AS familias
           FROM itens
          GROUP BY itens.documento, itens.account
        ), luc AS (
         SELECT itens.documento,
            itens.account,
            sum(itens.quantity * itens.unit_price - itens.quantity * itens.custo_efetivo) FILTER (WHERE itens.custo_efetivo > 0::numeric) AS lucro_com_custo,
            sum(itens.quantity * itens.unit_price) AS receita,
            sum(itens.quantity * itens.unit_price) FILTER (WHERE itens.custo_efetivo > 0::numeric) AS receita_com_custo
           FROM itens
          GROUP BY itens.documento, itens.account
        ), cid AS (
         SELECT DISTINCT ON (addresses.user_id) addresses.user_id,
            (addresses.city || '-'::text) || addresses.state AS cidade_uf
           FROM addresses
          WHERE COALESCE(addresses.city, ''::text) <> ''::text AND COALESCE(addresses.state, ''::text) <> ''::text
          ORDER BY addresses.user_id, addresses.is_default DESC NULLS LAST, addresses.created_at DESC NULLS LAST
        )
 SELECT c.documento,
    c.account AS empresa,
    cid.cidade_uf,
    cd.cnae AS ramo,
        CASE
            WHEN c.n_pedidos > 0 THEN round(c.volume / c.n_pedidos::numeric, 2)
            ELSE NULL::numeric
        END AS ticket_faixa,
    COALESCE(f.familias, ARRAY[]::text[]) AS familias,
    c.volume,
    c.n_pedidos,
    (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - c.ultima AS recencia_dias,
        CASE
            WHEN l.lucro_com_custo IS NOT NULL THEN round(l.lucro_com_custo, 2)
            ELSE NULL::numeric
        END AS lucro_proxy,
        CASE
            WHEN COALESCE(l.receita, 0::numeric) > 0::numeric THEN round(COALESCE(l.receita_com_custo, 0::numeric) / l.receita, 2)
            ELSE 0::numeric
        END AS lucro_cobertura
   FROM compras c
     JOIN cli_doc cd ON cd.documento = c.documento
     LEFT JOIN fam f ON f.documento = c.documento AND f.account = c.account
     LEFT JOIN luc l ON l.documento = c.documento AND l.account = c.account
     LEFT JOIN cid ON cid.user_id = cd.user_id;

CREATE OR REPLACE VIEW public.v_desconto_flat_condicional_ativo
  WITH (security_invoker = on)
  AS
 SELECT id AS campanha_id,
    empresa,
    fornecedor_nome,
    nome,
    tipo_origem,
    estado,
    data_inicio,
    data_fim,
    data_corte_pedido,
    responsavel_oferta_nome,
    responsavel_oferta_email,
    canal_oferta,
    data_oferta,
    volume_minimo_condicional,
    volume_minimo_unidade,
    status_aceite,
    observacoes_negociacao,
    ( SELECT count(*) AS count
           FROM promocao_item pi
          WHERE pi.campanha_id = pc.id AND pi.ativo) AS qtd_itens,
    data_fim - (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date AS dias_restantes,
        CASE
            WHEN data_fim < (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date THEN 'expirada'::text
            WHEN (data_fim - (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date) <= 3 THEN 'urgente'::text
            WHEN (data_fim - (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date) <= 7 THEN 'atencao'::text
            ELSE 'confortavel'::text
        END AS urgencia
   FROM promocao_campanha pc
  WHERE tipo_origem = 'desconto_flat_condicional'::text AND (estado = ANY (ARRAY['negociando'::text, 'ativa'::text, 'rascunho'::text]));

CREATE OR REPLACE VIEW public.v_fornecedor_lt_logistica_total
  WITH (security_invoker = on)
  AS
 SELECT empresa,
    fornecedor_nome,
    count(*) AS num_etapas,
    sum(
        CASE lt_unidade
            WHEN 'uteis'::text THEN lt_dias
            WHEN 'corridos'::text THEN ceil(lt_dias::numeric * 0.7)::integer
            ELSE lt_dias
        END) AS lt_logistica_total_dias_uteis,
    string_agg(parceiro_nome, ' → '::text ORDER BY ordem) AS cadeia_descricao
   FROM fornecedor_cadeia_logistica
  WHERE ativo = true AND (valido_ate IS NULL OR valido_ate >= (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date)
  GROUP BY empresa, fornecedor_nome;

CREATE OR REPLACE VIEW public.v_grupo_comercial
  WITH (security_invoker = true)
  AS
 WITH ped AS (
         SELECT regexp_replace(COALESCE(p.cnpj, p.document, ''::text), '\D'::text, ''::text, 'g'::text) AS doc,
            (so.created_at AT TIME ZONE 'America/Sao_Paulo'::text)::date AS data,
            COALESCE(so.total, ( SELECT sum(((it.value ->> 'quantity'::text)::numeric) * ((it.value ->> 'unit_price'::text)::numeric)) AS sum
                   FROM jsonb_array_elements(so.items) it(value))) AS valor
           FROM sales_orders so
             JOIN profiles p ON p.user_id = so.customer_user_id
          WHERE (so.status = ANY (ARRAY['faturado'::text, 'importado'::text, 'separacao'::text, 'enviado'::text])) AND so.deleted_at IS NULL
        )
 SELECT m.grupo_id,
    count(DISTINCT ped.doc) FILTER (WHERE ped.doc IS NOT NULL) AS documentos_com_compra,
    count(ped.data) AS qtd_pedidos,
    max(ped.data) AS ultima_compra,
    (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - max(ped.data) AS dias_desde_ultima,
    COALESCE(sum(ped.valor), 0::numeric) AS faturamento_total,
    COALESCE(sum(ped.valor) FILTER (WHERE ped.data > ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - 90)), 0::numeric) AS fat_90d,
    COALESCE(sum(ped.valor) FILTER (WHERE ped.data <= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - 90) AND ped.data > ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - 180)), 0::numeric) AS fat_90d_anterior,
    round(COALESCE(sum(ped.valor) FILTER (WHERE ped.data > ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - 180)), 0::numeric) / 6.0, 2) AS media_mensal_6m
   FROM cliente_grupo_membros m
     LEFT JOIN ped ON ped.doc = m.documento
  GROUP BY m.grupo_id;

CREATE OR REPLACE VIEW public.v_grupo_contas_receber
  WITH (security_invoker = true)
  AS
 WITH tit AS (
         SELECT regexp_replace(fcr.cnpj_cpf, '\D'::text, ''::text, 'g'::text) AS doc,
            fcr.saldo,
            fcr.data_vencimento
           FROM fin_contas_receber fcr
          WHERE fcr.status_titulo <> ALL (ARRAY['RECEBIDO'::text, 'CANCELADO'::text])
        )
 SELECT g.id AS grupo_id,
    g.nome,
    count(DISTINCT m.documento) FILTER (WHERE t.doc IS NOT NULL) AS documentos_com_titulo,
    COALESCE(sum(t.saldo), 0::numeric) AS total_aberto,
    COALESCE(sum(t.saldo) FILTER (WHERE t.data_vencimento >= (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date), 0::numeric) AS a_vencer,
    COALESCE(sum(t.saldo) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - t.data_vencimento) >= 1 AND ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - t.data_vencimento) <= 30), 0::numeric) AS venc_1_30,
    COALESCE(sum(t.saldo) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - t.data_vencimento) >= 31 AND ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - t.data_vencimento) <= 60), 0::numeric) AS venc_31_60,
    COALESCE(sum(t.saldo) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - t.data_vencimento) >= 61 AND ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - t.data_vencimento) <= 90), 0::numeric) AS venc_61_90,
    COALESCE(sum(t.saldo) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - t.data_vencimento) > 90), 0::numeric) AS venc_90_mais
   FROM cliente_grupos g
     JOIN cliente_grupo_membros m ON m.grupo_id = g.id
     LEFT JOIN tit t ON t.doc = m.documento
  WHERE g.ativo = true
  GROUP BY g.id, g.nome;

CREATE OR REPLACE VIEW public.v_grupo_contas_receber_por_doc
  WITH (security_invoker = true)
  AS
 WITH tit AS (
         SELECT regexp_replace(fcr.cnpj_cpf, '\D'::text, ''::text, 'g'::text) AS doc,
            fcr.company,
            fcr.nome_cliente,
            fcr.saldo,
            fcr.data_vencimento
           FROM fin_contas_receber fcr
          WHERE fcr.status_titulo <> ALL (ARRAY['RECEBIDO'::text, 'CANCELADO'::text])
        )
 SELECT m.grupo_id,
    m.documento,
    t.company,
    max(t.nome_cliente) AS nome_cliente,
    COALESCE(sum(t.saldo), 0::numeric) AS total_aberto,
    COALESCE(sum(t.saldo) FILTER (WHERE ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - t.data_vencimento) > 0), 0::numeric) AS vencido
   FROM cliente_grupo_membros m
     LEFT JOIN tit t ON t.doc = m.documento
  GROUP BY m.grupo_id, m.documento, t.company;

CREATE OR REPLACE VIEW public.v_sku_aumento_vigente
  WITH (security_invoker = on)
  AS
 SELECT DISTINCT op.account AS empresa_lower,
    op.omie_codigo_produto AS sku_codigo_omie,
    op.descricao AS sku_descricao,
    op.familia,
    fa.id AS aumento_id,
    fa.fornecedor_nome,
    fa.nome AS aumento_nome,
    COALESCE(fai.data_vigencia_especifica, fa.data_vigencia) AS data_vigencia_efetiva,
    fai.aumento_perc,
    fai.categoria_fornecedor,
    fai.id AS aumento_item_id,
    fa.estado AS aumento_estado
   FROM fornecedor_aumento_anunciado fa
     JOIN fornecedor_aumento_item fai ON fai.aumento_id = fa.id
     JOIN categoria_aumento_familia_mapeamento m ON m.aumento_item_id = fai.id
     JOIN omie_products op ON op.familia = m.familia_omie AND lower(op.account) = lower(fa.empresa) AND COALESCE(op.ativo, true) = true AND (m.sku_codigo_omie_especifico IS NULL OR op.omie_codigo_produto = m.sku_codigo_omie_especifico)
  WHERE (fa.estado = ANY (ARRAY['ativo'::text, 'vigente'::text])) AND fai.ativo = true AND fai.confirmado = true AND COALESCE(fai.data_vigencia_especifica, fa.data_vigencia) >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '7 days'::interval);

CREATE OR REPLACE VIEW public.v_sku_candidatos_primeira_compra
  WITH (security_invoker = on)
  AS
 WITH recorrencia_180d AS (
         SELECT vih.empresa,
            vih.sku_codigo_omie,
            count(DISTINCT vih.nfe_chave_acesso) AS nfs_180d,
            count(DISTINCT to_char(vih.data_emissao::timestamp with time zone, 'YYYY-MM'::text)) AS meses_180d,
            count(DISTINCT vih.cliente_cnpj_cpf) AS clientes_180d,
            (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - max(vih.data_emissao) AS dias_desde_ultima
           FROM v_sku_demanda_efetiva vih
          WHERE vih.data_emissao >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval) AND vih.quantidade > 0::numeric
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

CREATE OR REPLACE VIEW public.v_sku_demanda_estatisticas
  WITH (security_invoker = on)
  AS
 WITH vendas_por_ordem AS (
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
    ultima_venda_data
   FROM stats;

CREATE OR REPLACE VIEW public.v_sku_demanda_rajada
  WITH (security_invoker = on)
  AS
 WITH datas_serie AS (
         SELECT generate_series((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '179 days'::interval, (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date::timestamp without time zone, '1 day'::interval)::date AS dt
        ), skus_ativos AS (
         SELECT DISTINCT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie,
            max(venda_items_history.sku_descricao) AS sku_descricao,
            max(venda_items_history.sku_unidade) AS sku_unidade
           FROM v_sku_demanda_efetiva venda_items_history
          WHERE venda_items_history.data_emissao >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval)
          GROUP BY venda_items_history.empresa, venda_items_history.sku_codigo_omie
        ), vendas_diarias AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie,
            venda_items_history.data_emissao AS dt,
            sum(venda_items_history.quantidade) AS qtde_dia,
            sum(venda_items_history.valor_total) AS valor_dia
           FROM v_sku_demanda_efetiva venda_items_history
          WHERE venda_items_history.data_emissao >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval)
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

CREATE OR REPLACE VIEW public.v_sku_leadtime_estatisticas
  WITH (security_invoker = on)
  AS
 WITH stats AS (
         SELECT h.empresa::text AS empresa,
            h.sku_codigo_omie,
            max(h.sku_descricao) AS sku_descricao,
            max(h.fornecedor_codigo_omie) AS fornecedor_codigo_omie,
            max(h.fornecedor_nome) AS fornecedor_nome,
            count(*) FILTER (WHERE h.lt_bruto_dias_uteis IS NOT NULL) AS lt_n_observacoes,
            round(avg(h.lt_bruto_dias_uteis), 2) AS lt_sku_medio,
            round(stddev(h.lt_bruto_dias_uteis), 2) AS lt_sku_desvio,
            percentile_cont(0.95::double precision) WITHIN GROUP (ORDER BY (h.lt_bruto_dias_uteis::double precision)) AS lt_p95_dias
           FROM v_sku_leadtime_efetivo h
          WHERE h.t2_data_faturamento >= (((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval) AT TIME ZONE 'America/Sao_Paulo'::text) AND h.lt_bruto_dias_uteis IS NOT NULL
          GROUP BY (h.empresa::text), h.sku_codigo_omie
        ), fornecedor_stats AS (
         SELECT h.empresa::text AS empresa,
            h.fornecedor_codigo_omie,
            round(avg(h.lt_bruto_dias_uteis), 2) AS lt_fornecedor_medio,
            round(stddev(h.lt_bruto_dias_uteis), 2) AS lt_fornecedor_desvio,
            count(*) AS lt_fornecedor_n_observacoes
           FROM v_sku_leadtime_efetivo h
          WHERE h.t2_data_faturamento >= (((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval) AT TIME ZONE 'America/Sao_Paulo'::text) AND h.lt_bruto_dias_uteis IS NOT NULL
          GROUP BY (h.empresa::text), h.fornecedor_codigo_omie
        )
 SELECT s.empresa,
    s.sku_codigo_omie,
    s.sku_descricao,
    s.fornecedor_codigo_omie,
    s.fornecedor_nome,
    s.lt_n_observacoes,
        CASE
            WHEN s.lt_n_observacoes >= 3 THEN s.lt_sku_medio
            ELSE f.lt_fornecedor_medio
        END AS lt_medio_dias_uteis,
        CASE
            WHEN s.lt_n_observacoes >= 3 THEN s.lt_sku_desvio
            ELSE f.lt_fornecedor_desvio
        END AS lt_desvio_padrao_dias,
    s.lt_p95_dias,
        CASE
            WHEN s.lt_n_observacoes >= 3 THEN 'SKU'::text
            ELSE 'FORNECEDOR'::text
        END AS fonte_leadtime,
    f.lt_fornecedor_desvio,
    f.lt_fornecedor_n_observacoes
   FROM stats s
     LEFT JOIN fornecedor_stats f ON s.empresa = f.empresa AND s.fornecedor_codigo_omie = f.fornecedor_codigo_omie;

CREATE OR REPLACE VIEW public.v_sku_parametros_sugeridos
  WITH (security_invoker = on)
  AS
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
        ), base AS (
         SELECT c.empresa,
            c.sku_codigo_omie,
            c.sku_descricao,
            c.valor_total_90d,
            c.num_ordens,
            c.demanda_media_diaria AS d,
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
                END AS z_aplicado
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
                END AS status_sugestao
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
                    WHEN com_calculos.preco_item_eoq > 0::numeric AND com_calculos.cm_anual > 0::numeric AND com_calculos.d > 0::numeric THEN ceil(sqrt(2.0 * (COALESCE(com_calculos.d, 0::numeric) * 252::numeric) * com_calculos.cp / (com_calculos.cm_anual * com_calculos.preco_item_eoq)))
                    ELSE 1::numeric
                END AS qc_eoq
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
        END AS estoque_seguranca_sugerido
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

CREATE OR REPLACE VIEW public.v_sku_sigma_demanda
  WITH (security_invoker = on)
  AS
 WITH datas AS (
         SELECT generate_series((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval, (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '1 day'::interval, '1 day'::interval)::date AS dt
        ), vendas_diarias AS (
         SELECT venda_items_history.empresa,
            venda_items_history.sku_codigo_omie::text AS sku_codigo_omie,
            venda_items_history.data_emissao AS dt,
            sum(venda_items_history.quantidade) AS qtde
           FROM v_sku_demanda_efetiva venda_items_history
          WHERE venda_items_history.data_emissao >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '180 days'::interval)
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
 SELECT empresa,
    sku_codigo_omie,
    round(stddev_samp(qtde), 4) AS sigma_demanda_diaria,
    round(avg(qtde), 4) AS media_demanda_diaria
   FROM serie
  GROUP BY empresa, sku_codigo_omie;

CREATE OR REPLACE VIEW public.v_sugestao_negociacao_ativa
  WITH (security_invoker = on)
  AS
 SELECT sng.id,
    sng.empresa,
    sng.sku_codigo_omie,
    sng.sku_descricao,
    sng.motivo,
    sng.motivo_detalhes,
    sng.score_final,
    sng.volume_financeiro_12m,
    sng.preco_medio_unitario,
    sng.promocoes_12m,
    sng.perc_meses_com_promo,
    sng.status,
    sng.data_geracao,
    sng.valido_ate,
    sng.valido_ate - (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date AS dias_ate_expirar,
    sng.campanha_id_gerada,
    mv.categoria,
    sp.fornecedor_nome,
    sp.ponto_pedido,
    sp.estoque_maximo,
    COALESCE(sea.estoque_fisico, 0::numeric) + COALESCE(sea.estoque_pendente_entrada, 0::numeric) AS estoque_efetivo
   FROM sugestao_negociacao_paralela sng
     LEFT JOIN private.mv_sku_ranking_negociacao_paralela mv ON mv.empresa = sng.empresa AND mv.sku_codigo_omie = sng.sku_codigo_omie
     LEFT JOIN sku_parametros sp ON sp.empresa = sng.empresa AND sp.sku_codigo_omie::text = sng.sku_codigo_omie
     LEFT JOIN sku_estoque_atual sea ON sea.empresa = sng.empresa AND sea.sku_codigo_omie = sng.sku_codigo_omie
  WHERE (sng.status = ANY (ARRAY['nova'::text, 'visualizada'::text, 'acao_tomada'::text])) AND sng.valido_ate >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - '7 days'::interval);

-- Os DEFAULTs: o dia de SP no lugar do dia da sessão (metadado; nenhuma linha é reescrita).
ALTER TABLE public.farmer_agenda ALTER COLUMN agenda_date SET DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date;
ALTER TABLE public.fornecedor_cadeia_logistica ALTER COLUMN valido_desde SET DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date;
ALTER TABLE public.priority_score_log ALTER COLUMN score_date SET DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date;
ALTER TABLE public.sku_embalagem_equivalencia ALTER COLUMN vigente_desde SET DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date;
ALTER TABLE public.sugestao_negociacao_paralela ALTER COLUMN data_geracao SET DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date;
ALTER TABLE public.sugestao_negociacao_paralela ALTER COLUMN valido_ate SET DEFAULT (((now() AT TIME ZONE 'America/Sao_Paulo'::text))::date + '14 days'::interval);

-- Pós-condição: o que ficou instalado é ESTE texto, com o fuso de SP escrito e sem o dia da sessão,
-- security_invoker preservado, dono postgres e o ACL idêntico ao de antes do replace.
DO $post$
DECLARE
  r record;
  v_oid oid;
  v_src text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('fin_aging_pagar', 'fc866c3e79b281b50a9348bc72c0c005'),
      ('fin_aging_receber', 'cbdbef687d520889236a948144a48675'),
      ('fin_fluxo_caixa_diario', '226717ab7773079782316aa0bacced7e'),
      ('v_caca_candidatos', '24af34211e33745ac90b36c559561dbe'),
      ('v_caca_compradores', '41cce289721d3631b1bd518e55dc048f'),
      ('v_desconto_flat_condicional_ativo', '494a8aa614db6c8a5299fa6bb4e5f29b'),
      ('v_fornecedor_lt_logistica_total', '1405d96cc9817129839f73a64fb647c6'),
      ('v_grupo_comercial', '73de52bd7737a62d2828589f97661e9a'),
      ('v_grupo_contas_receber', 'b05ddadaa94d946e3e84184cee2b97ed'),
      ('v_grupo_contas_receber_por_doc', 'ab437b5db3d7f3f914c7d31c0783133f'),
      ('v_sku_aumento_vigente', '3d12ee0c70206f5cd2fe47cab60e0779'),
      ('v_sku_candidatos_primeira_compra', '0cd9b6439b4bb72a84bf9d6acea9e4b3'),
      ('v_sku_demanda_estatisticas', 'f05c5621d0254b746c6ada8cb0c9d22a'),
      ('v_sku_demanda_rajada', '91fce84224800a53021d3022d297aac2'),
      ('v_sku_leadtime_estatisticas', '3dc951377dd8c0da5d23a95a7ea3deef'),
      ('v_sku_parametros_sugeridos', 'cb7f8b8b2286ca815c0a76ea8aa412de'),
      ('v_sku_sigma_demanda', '7be1b6b1f09c0943ed20b70a91f49ea4'),
      ('v_sugestao_negociacao_ativa', '031084feabb96a7f903eda803cb24ffd')
    ) AS x(alvo, este)
  LOOP
    v_oid := to_regclass('public.' || r.alvo);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'POS1 FALHOU: a view % não existe — quem a lê quebraria', r.alvo;
    END IF;
    v_src := pg_catalog.pg_get_viewdef(v_oid, true);
    IF md5(v_src) <> r.este THEN
      RAISE EXCEPTION 'POS2 FALHOU: a definição instalada de % (md5 %) não é a desta migration', r.alvo, md5(v_src);
    END IF;
    -- As agulhas vão partidas: o gate textual lê a migration inteira, literal incluso.
    IF position(upper('current' || '_date') IN upper(v_src)) > 0
       OR position('now()' || '::date' IN v_src) > 0
       OR v_src ~ ('_at' || '::date')
       OR position('America/Sao_Paulo' IN v_src) = 0 THEN
      RAISE EXCEPTION 'POS3 FALHOU: % ainda lê o dia da sessão, ou perdeu o fuso de SP', r.alvo;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c, unnest(c.reloptions) o
                    WHERE c.oid = v_oid AND lower(o) IN ('security_invoker=on', 'security_invoker=true')) THEN
      RAISE EXCEPTION 'POS4 FALHOU: % perdeu security_invoker — passaria a ler como dono, sem RLS', r.alvo;
    END IF;
    IF (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid = v_oid) <> 'postgres' THEN
      RAISE EXCEPTION 'POS5 FALHOU: % mudou de dono', r.alvo;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM hoje_sp_acl_antes) <> 18 THEN
    RAISE EXCEPTION 'POS6 FALHOU: a foto do ACL tem % views, esperadas 18', (SELECT count(*) FROM hoje_sp_acl_antes);
  END IF;
  IF EXISTS (SELECT 1 FROM hoje_sp_acl_antes a
               JOIN pg_catalog.pg_class c ON c.relnamespace = 'public'::regnamespace AND c.relname = a.alvo
              WHERE c.relacl::text IS DISTINCT FROM a.acl) THEN
    RAISE EXCEPTION 'POS6 FALHOU: o ACL de alguma view mudou no replace';
  END IF;
  FOR r IN
    SELECT * FROM (VALUES
      ('farmer_agenda', 'agenda_date', '((now() AT TIME ZONE ''America/Sao_Paulo''::text))::date'),
      ('fornecedor_cadeia_logistica', 'valido_desde', '((now() AT TIME ZONE ''America/Sao_Paulo''::text))::date'),
      ('priority_score_log', 'score_date', '((now() AT TIME ZONE ''America/Sao_Paulo''::text))::date'),
      ('sku_embalagem_equivalencia', 'vigente_desde', '((now() AT TIME ZONE ''America/Sao_Paulo''::text))::date'),
      ('sugestao_negociacao_paralela', 'data_geracao', '((now() AT TIME ZONE ''America/Sao_Paulo''::text))::date'),
      ('sugestao_negociacao_paralela', 'valido_ate', '(((now() AT TIME ZONE ''America/Sao_Paulo''::text))::date + ''14 days''::interval)')
    ) AS x(tabela, coluna, novo)
  LOOP
    IF (SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid)
          FROM pg_catalog.pg_attrdef d
          JOIN pg_catalog.pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
         WHERE d.adrelid = to_regclass('public.' || r.tabela) AND a.attname = r.coluna) IS DISTINCT FROM r.novo THEN
      RAISE EXCEPTION 'POS7 FALHOU: o DEFAULT de %.% não é o desta migration', r.tabela, r.coluna;
    END IF;
  END LOOP;
END
$post$;
