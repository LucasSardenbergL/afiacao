-- 20260927133606_positivacao_mes_sp_sessao_utc.sql
-- ============================================================
-- Positivação ao vivo: os dois eixos timestamptz passam a ser lidos NO MÊS DE SP,
-- seja qual for o TimeZone da sessão.
-- ============================================================
-- `_carteira_positivacao_for_owner` (20260525210000_viewas_rpcs_for.sql) fixa o mês em São
-- Paulo — `mes_inicio`/`mes_fim` são `date` calculadas de `now() AT TIME ZONE
-- 'America/Sao_Paulo'` —, mas comparava duas colunas timestamptz no fuso da SESSÃO:
--   · farmer_calls.started_at contra essas datas: o cast implícito date→timestamptz usa o
--     TimeZone da sessão;
--   · o fallback de pedido sem order_date_kpi, sales_orders.created_at convertido a date: idem.
-- A prod roda sessões em UTC (TimeZone=UTC vindo do arquivo de configuração, sem override por
-- papel nem por banco — psql-ro, 2026-09-27), e o PostgREST herda isso. Efeito: o que acontece
-- das 21:00 às 23:59 BRT do último dia do mês conta no mês SEGUINTE, e o das 21:00 às 23:59 BRT
-- do último dia do mês anterior conta no mês corrente.
--
-- Impacto medido em 2026-09-27: zero hoje. farmer_calls tem 0 linhas; dos 31.550 pedidos
-- válidos, só 4 caem no fallback (todos com instante real, nenhum numa borda de mês). É defeito
-- LATENTE: morde no dia em que farmer_calls receber dado. O snapshot mensal CONGELADO
-- (carteira_positivacao_snapshot) não tem o defeito — os loaders dele só leem colunas date
-- (supabase/functions/_shared/mapas-paginados.ts).
--
-- O fallback converte o INSTANTE para a data de SP. Os importadores gravam a data como
-- MEIO-DIA UTC (31.510 linhas em 365 dias: data de SP = data UTC, a conversão é neutra), e as
-- 41 linhas gravadas como meia-noite UTC têm todas order_date_kpi, então nunca chegam ao
-- fallback. Writer novo que grave data como meia-noite UTC tem de preencher order_date_kpi.
--
-- Única mudança no corpo: essas 2 expressões. Mesmo nome, assinatura, SECURITY DEFINER e
-- search_path; o resto é o corpo de prod linha a linha. route_visits.visit_date é `date`
-- (date×date não tem fuso) e fica como está.
-- CREATE OR REPLACE preserva o ACL; o REVOKE é para o ambiente onde a função NASCE aqui, em
-- que o default privilege do Supabase daria EXECUTE a PUBLIC, anon e authenticated.
--
-- Prova: db/test-positivacao-eligible-consumo.sh (PG17, relógio controlado, borda de SP
-- cruzada sob sessão UTC e SP) e o mesmo script com --falsificar.
-- Aplicação: bun run db:aplicar — a transação é do executor, por isso não há BEGIN/COMMIT aqui.
-- Reverter depois do commit = migration compensatória nova, nunca re-colar a 20260525210000.
--
-- Identidade de corpo (PRE e POS): md5 do corpo SEM comentários e com espaço colapsado. O apply
-- por outros caminhos já tirou comentário do corpo de prod (o vivo não tem o `--` da linha `uid`
-- que o repo tem), e um md5 exato reprovaria uma aplicação sã.

-- Pré-condição: o corpo vivo tem de ser o PREDECESSOR revisado (o de 20260525210000, que é o de
-- prod em 2026-09-27) ou JÁ este (re-aplicar é seguro). Qualquer outro corpo é mudança concorrente
-- que este CREATE OR REPLACE apagaria em silêncio — aborta. Função ausente (ambiente novo) segue.
DO $pre$
DECLARE
  v_norm text;
BEGIN
  SELECT md5(btrim(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', ' ', 'g')))
    INTO v_norm
    FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public._carteira_positivacao_for_owner(uuid)');
  IF v_norm IS NOT NULL
     AND v_norm NOT IN ('abc56a4d2006e63dae4d9c3d9f237528',   -- predecessor: 20260525210000 = prod
                        'b376457c884b473251adcc9f5783c7fa') THEN              -- este corpo: re-aplicação
    RAISE EXCEPTION 'PRE FALHOU: o corpo vivo de _carteira_positivacao_for_owner (md5 normalizado %) não é o predecessor revisado nem este — outra mudança chegou antes; reconcilie antes de aplicar', v_norm;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public._carteira_positivacao_for_owner(p_owner uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid uuid := p_owner;
  mes_inicio date := date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo'))::date;
  mes_fim date := (date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo')) + interval '1 month')::date;
  result jsonb;
BEGIN
  IF uid IS NULL THEN RETURN NULL; END IF;

  WITH eleg AS (
    SELECT ca.customer_user_id
    FROM public.carteira_assignments ca
    WHERE ca.owner_user_id = uid AND ca.eligible = true
  ),
  pedidos_validos AS (
    SELECT so.customer_user_id,
           -- data do pedido em SP; a sessão da prod é UTC
           COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS d,
           so.total
    FROM public.sales_orders so
    WHERE so.status NOT IN ('cancelado','rascunho','pendente')
  ),
  pedidos_mes AS (
    SELECT pv.customer_user_id, sum(pv.total) AS receita
    FROM pedidos_validos pv
    JOIN eleg e ON e.customer_user_id = pv.customer_user_id
    WHERE pv.d >= mes_inicio AND pv.d < mes_fim
    GROUP BY pv.customer_user_id
  ),
  primeiro_pedido AS (
    SELECT pv.customer_user_id, min(pv.d) AS primeira
    FROM pedidos_validos pv
    JOIN eleg e ON e.customer_user_id = pv.customer_user_id
    GROUP BY pv.customer_user_id
  ),
  contato_mes AS (
    SELECT DISTINCT u.customer_user_id
    FROM (
      SELECT fc.customer_user_id FROM public.farmer_calls fc
        -- a ligação é comparada pela data de SP, nunca pelo cast da sessão
        WHERE fc.farmer_id = uid
          AND (fc.started_at AT TIME ZONE 'America/Sao_Paulo')::date >= mes_inicio
          AND (fc.started_at AT TIME ZONE 'America/Sao_Paulo')::date < mes_fim
          AND fc.customer_user_id IS NOT NULL
      UNION
      SELECT rv.customer_user_id FROM public.route_visits rv
        WHERE rv.visited_by = uid AND rv.visit_date >= mes_inicio AND rv.visit_date < mes_fim
          AND rv.customer_user_id IS NOT NULL
    ) u
    JOIN eleg e ON e.customer_user_id = u.customer_user_id
  ),
  scores AS (
    SELECT fcs.customer_user_id, fcs.revenue_potential, fcs.churn_risk,
           fcs.recover_score, fcs.days_since_last_purchase, fcs.priority_score,
           fcs.avg_repurchase_interval
    FROM public.farmer_client_scores fcs
    JOIN eleg e ON e.customer_user_id = fcs.customer_user_id
  ),
  a_positivar AS (
    SELECT s.customer_user_id,
           COALESCE(p.razao_social, p.name) AS nome,
           s.revenue_potential, s.churn_risk, s.recover_score,
           s.days_since_last_purchase, s.priority_score
    FROM scores s
    LEFT JOIN public.profiles p ON p.user_id = s.customer_user_id
    WHERE s.customer_user_id NOT IN (SELECT customer_user_id FROM pedidos_mes)
    ORDER BY s.priority_score DESC NULLS LAST, s.revenue_potential DESC NULLS LAST
    LIMIT 200
  )
  SELECT jsonb_build_object(
    'mes', to_char(mes_inicio, 'YYYY-MM-DD'),
    'total_eligible', (SELECT count(*) FROM eleg),
    'positivados', (SELECT count(*) FROM pedidos_mes),
    'compradores_mtd', (SELECT count(*) FROM pedidos_mes),
    'receita_mtd', COALESCE((SELECT sum(receita) FROM pedidos_mes), 0),
    'contatados_mtd', (SELECT count(*) FROM contato_mes),
    'recencia_critica', (
      SELECT count(*) FROM scores s
      WHERE COALESCE(s.churn_risk,0) >= 60
         OR (COALESCE(s.avg_repurchase_interval,0) > 0
             AND COALESCE(s.days_since_last_purchase,0) > s.avg_repurchase_interval * 1.5)
    ),
    'novos_clientes_positivados', (
      SELECT count(*) FROM primeiro_pedido pp
      WHERE pp.primeira >= mes_inicio AND pp.primeira < mes_fim
    ),
    'a_positivar', COALESCE((SELECT jsonb_agg(a_positivar) FROM a_positivar), '[]'::jsonb)
  ) INTO result;

  RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public._carteira_positivacao_for_owner(uuid) FROM PUBLIC, anon, authenticated;

-- Postcondição: relê o CATÁLOGO (nunca invoca a função) e aborta a transação se a migration não
-- pegou. É confirmação de INSTALAÇÃO — o CONTROLE (a borda de SP decide o número sob sessão UTC) é
-- provado executando, no PG17 da prova, e não aqui.
DO $post$
DECLARE
  v_oid oid := to_regprocedure('public._carteira_positivacao_for_owner(uuid)');
  v_codigo text;
  v_norm text;
  v_secdef boolean;
  v_config text[];
  v_dono text;
  v_wrapper text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POS1 FALHOU: _carteira_positivacao_for_owner(uuid) não existe — a positivação ao vivo quebrou';
  END IF;
  SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g'),
         md5(btrim(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', ' ', 'g'))),
         p.prosecdef, p.proconfig, pg_catalog.pg_get_userbyid(p.proowner)
    INTO v_codigo, v_norm, v_secdef, v_config, v_dono
    FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
  IF NOT v_secdef OR v_config IS DISTINCT FROM ARRAY['search_path=public'] OR v_dono IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'POS2 FALHOU: secdef=% config=% dono=% — esperado SECURITY DEFINER, search_path=public, dono postgres', v_secdef, v_config, v_dono;
  END IF;
  IF v_norm IS DISTINCT FROM 'b376457c884b473251adcc9f5783c7fa' THEN
    RAISE EXCEPTION 'POS6 FALHOU: o corpo instalado (md5 normalizado %) não é o desta migration', v_norm;
  END IF;
  IF v_codigo !~ '\(so\.created_at AT TIME ZONE ''America/Sao_Paulo''\)::date\) AS d'
     OR v_codigo !~ '\(fc\.started_at AT TIME ZONE ''America/Sao_Paulo''\)::date >= mes_inicio'
     OR v_codigo !~ '\(fc\.started_at AT TIME ZONE ''America/Sao_Paulo''\)::date < mes_fim' THEN
    RAISE EXCEPTION 'POS3 FALHOU: o corpo não converte pedido E ligação para a data de SP';
  END IF;
  IF v_codigo ~ 'created_at::date' OR v_codigo ~ 'fc\.started_at\s*[<>]' THEN
    RAISE EXCEPTION 'POS4 FALHOU: sobrou comparação no fuso da sessão no corpo';
  END IF;
  IF pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS5 FALHOU: o interno sem gate ficou executável por anon/authenticated/PUBLIC';
  END IF;
  -- os grants POSITIVOS que o produto usa: os wrappers (não tocados aqui) seguem executáveis
  FOREACH v_wrapper IN ARRAY ARRAY['public.get_minha_positivacao()', 'public.get_minha_positivacao_for(uuid)'] LOOP
    IF to_regprocedure(v_wrapper) IS NULL
       OR NOT pg_catalog.has_function_privilege('authenticated', to_regprocedure(v_wrapper), 'EXECUTE') THEN
      RAISE EXCEPTION 'POS7 FALHOU: % ausente ou sem EXECUTE para authenticated — a tela de positivação quebraria', v_wrapper;
    END IF;
  END LOOP;
  RAISE NOTICE 'POS OK: positivação lê pedido e ligação na data de SP; corpo, dono e ACL conferidos';
END
$post$;
