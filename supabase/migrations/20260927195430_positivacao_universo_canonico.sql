-- 20260927195430_positivacao_universo_canonico.sql
-- ============================================================
-- Positivação ao vivo: o universo de pedidos passa a ser o CANÔNICO, com a mesma data do
-- mês congelado. Decisão do founder em 2026-09-27.
-- ============================================================
-- `_carteira_positivacao_for_owner` (a positivação AO VIVO do hero do farmer) e o snapshot
-- mensal CONGELADO (`carregarPedidosDoMes`, supabase/functions/_shared/mapas-paginados.ts)
-- divergiam no universo de pedidos:
--   · ao vivo:   status NOT IN ('cancelado','rascunho','pendente'), sem deleted_at, e data
--                COALESCE(order_date_kpi, data de SP do created_at);
--   · congelado: a denylist canônica de 4 status (src/lib/farmer/universo-pedidos.ts, espelho
--                em supabase/functions/_shared/universo-pedidos.ts) + deleted_at IS NULL, e SÓ
--                order_date_kpi.
-- Decisão: (D1) o ao vivo adota o universo canônico; (D2) o fallback de created_at sai, e a data
-- é só order_date_kpi. Ao vivo e congelado passam a contar o mesmo pedido no mesmo mês.
--
-- Por que o fallback saiu (psql-ro, 2026-09-27 22:41-22:55 UTC):
--   · kpi nulo existe em exatamente 5 linhas, todas criadas pelo APP — nenhum escritor do app
--     grava a coluna (submitQuote e a proposta de WhatsApp inserem 'orcamento'; submitOrder,
--     'rascunho' que vira 'enviado' após o push). O importador do Omie sempre grava kpi.
--   · o pedido que o app empurra ao Omie volta pelo importador como OUTRA linha, com o mesmo
--     (account, omie_pedido_id) e com kpi: 25 dos 26 empurrados têm esse gêmeo. O congelado
--     contava só a importada; o ao vivo contava as duas (a do app pelo fallback). Duplicata viva
--     em jun/ago de 2026: R$ 1.346,10. O ganho do fallback, "o pedido aparece na hora", durava
--     até a próxima importação (cron a cada 2 h por conta).
--   · o único 'orcamento' (cotação do app, nunca enviada) entrava pelo fallback: R$ 4.660 de
--     receita em junho. deleted_at preenchido: 0 linhas hoje.
-- ⚠️ O kpi nulo da linha do app é, por acidente, o que a deduplica. Escritor do app que passar a
-- gravar order_date_kpi sem antes resolver o gêmeo importado volta a duplicar receita, agora no
-- ao vivo E no congelado. Os 22 pares de abril/2026 (anteriores à coluna, kpi pelo backfill) já
-- duplicam nos dois lados; ficam para uma entrega própria.
--
-- Única mudança no corpo: a CTE pedidos_validos. Mesmo nome, assinatura, SECURITY DEFINER e
-- search_path; o resto é o corpo de prod (20260927133606) linha a linha. Pedido sem kpi sai pelas
-- próprias comparações de mês e pelo min(), como no `.gte/.lt` do loader: um `IS NOT NULL`
-- explícito seria redundante e não se falsifica.
-- CREATE OR REPLACE preserva o ACL; o REVOKE reafirma o fechamento (idempotente).
--
-- Prova: db/test-positivacao-eligible-consumo.sh (PG17, relógio controlado; seeds que SÓ cada
-- predicado do universo exclui; a PRE e a POS exercitadas sob transação única) e o mesmo script
-- com --falsificar.
-- Aplicação: bun run db:aplicar — a transação é do executor, por isso não há BEGIN/COMMIT aqui.
-- Reverter depois do commit = migration compensatória nova, nunca re-colar a 20260927133606.
--
-- Identidade de corpo (PRE e POS): md5 EXATO do prosrc. A 20260927133606 usava o md5 do corpo sem
-- comentários e com espaço colapsado, e essa normalização apaga diferenças DENTRO de literais
-- (`interval '1 --x` + quebra + `month'` dá o mesmo hash que `interval '1 month'` — achado do
-- Codex, adversarial 2026-09-27). O exato é seguro aqui porque o db:aplicar transporta os bytes
-- verbatim: o md5 exato do corpo da 20260927133606 tirado do arquivo é o mesmo medido na prod
-- (8abdeac4…, psql-ro 2026-09-27).

-- Pré-condição: o corpo vivo tem de ser o PREDECESSOR revisado (o de 20260927133606, que é o de
-- prod em 2026-09-27) ou JÁ este (re-aplicar é seguro). Qualquer outro corpo é mudança concorrente
-- que este CREATE OR REPLACE apagaria em silêncio — aborta. Função AUSENTE também aborta: esta
-- migration substitui um predecessor obrigatório (numa reconstrução do zero, a 20260525210000 e a
-- 20260927133606 rodam antes), e seguir sem a função reabriria a janela abaixo.
-- A linha da função no catálogo é TRAVADA antes da leitura (ALTER com o mesmo search_path, que não
-- muda nada): sem isso, outro aplicador que commitasse entre a leitura e o CREATE teria o corpo
-- sobrescrito em silêncio; com isso ele espera esta transação e falha. Medido em PG17 (achado do
-- Codex, desenho 2026-09-27). `SELECT … FOR UPDATE` em pg_proc não serve: na prod o papel postgres
-- não tem UPDATE no catálogo. O único event trigger que o ALTER aciona é o pgrst_ddl_watch, que o
-- CREATE abaixo já aciona (medido). O OID é resolvido DEPOIS do toque, nunca antes.
DO $pre$
DECLARE
  v_md5 text;
BEGIN
  IF to_regprocedure('public._carteira_positivacao_for_owner(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: _carteira_positivacao_for_owner(uuid) ausente — esta migration substitui o corpo da 20260927133606, que tem de vir antes';
  END IF;
  ALTER FUNCTION public._carteira_positivacao_for_owner(uuid) SET search_path = public;
  SELECT md5(p.prosrc)
    INTO v_md5
    FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public._carteira_positivacao_for_owner(uuid)');
  IF v_md5 IS NULL OR v_md5 NOT IN ('8abdeac4db77dbdce16bfbd8fca4dbde',   -- predecessor: 20260927133606 = prod
                                     'f1a2bd9e48c7b2c22ff805a50ab524b2') THEN  -- este corpo: re-aplicação
    RAISE EXCEPTION 'PRE FALHOU: o corpo vivo de _carteira_positivacao_for_owner (md5 %) não é o predecessor revisado nem este — outra mudança chegou antes; reconcilie antes de aplicar', v_md5;
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
    -- universo canônico (4 status + não apagado) e a data de KPI, as do mês congelado
    SELECT so.customer_user_id, so.order_date_kpi AS d, so.total
    FROM public.sales_orders so
    WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
      AND so.deleted_at IS NULL
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
-- pegou. É confirmação de INSTALAÇÃO — o CONTROLE (cada predicado do universo decide o número) é
-- provado executando, no PG17 da prova, e não aqui.
DO $post$
DECLARE
  v_oid oid := to_regprocedure('public._carteira_positivacao_for_owner(uuid)');
  v_codigo text;
  v_md5 text;
  v_secdef boolean;
  v_config text[];
  v_dono text;
  v_wrapper text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POS1 FALHOU: _carteira_positivacao_for_owner(uuid) não existe — a positivação ao vivo quebrou';
  END IF;
  -- v_codigo (sem comentários) serve só aos regex de DIAGNÓSTICO; quem decide a identidade é o md5
  -- exato do prosrc (POS6)
  SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), md5(p.prosrc),
         p.prosecdef, p.proconfig, pg_catalog.pg_get_userbyid(p.proowner)
    INTO v_codigo, v_md5, v_secdef, v_config, v_dono
    FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
  IF NOT v_secdef OR v_config IS DISTINCT FROM ARRAY['search_path=public'] OR v_dono IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'POS2 FALHOU: secdef=% config=% dono=% — esperado SECURITY DEFINER, search_path=public, dono postgres', v_secdef, v_config, v_dono;
  END IF;
  -- os predicados semânticos vêm ANTES do md5: depois dele seriam inalcançáveis (todo desvio de
  -- corpo cai no md5 primeiro), e a mensagem que diz O QUE está errado se perderia
  IF v_codigo !~ 'so\.status NOT IN \(''cancelado'',''rascunho'',''pendente'',''orcamento''\)'
     OR v_codigo !~ 'AND so\.deleted_at IS NULL'
     OR v_codigo !~ 'so\.order_date_kpi AS d' THEN
    RAISE EXCEPTION 'POS3 FALHOU: o corpo não lê o universo canônico (4 status + deleted_at) com a data de KPI';
  END IF;
  IF v_codigo ~ 'created_at' OR v_codigo ~* 'COALESCE\(so\.order_date_kpi' THEN
    RAISE EXCEPTION 'POS4 FALHOU: sobrou o fallback de created_at no corpo';
  END IF;
  IF v_codigo !~ '\(fc\.started_at AT TIME ZONE ''America/Sao_Paulo''\)::date >= mes_inicio'
     OR v_codigo !~ '\(fc\.started_at AT TIME ZONE ''America/Sao_Paulo''\)::date < mes_fim' THEN
    RAISE EXCEPTION 'POS8 FALHOU: a ligação deixou de ser comparada pela data de SP';
  END IF;
  IF v_md5 IS DISTINCT FROM 'f1a2bd9e48c7b2c22ff805a50ab524b2' THEN
    RAISE EXCEPTION 'POS6 FALHOU: o corpo instalado (md5 %) não é o desta migration', v_md5;
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
  RAISE NOTICE 'POS OK: positivação no universo canônico com a data de KPI; ligação em SP; corpo, dono e ACL conferidos';
END
$post$;
