-- 20260927172443_hoje_sp_sessao_utc_precos_piso.sql
-- ============================================================
-- O "hoje" de get_ultimos_precos_cliente e medir_abaixo_piso_tier passa a ser o de SÃO PAULO,
-- seja qual for o TimeZone da sessão.
-- ============================================================
-- Família C da classe "data de SP medida no fuso da SESSÃO"
-- (docs/historico/positivacao-mes-sp-sob-sessao-utc.md): os dois corpos raciocinam em SP —
-- a data de cada pedido é COALESCE(order_date_kpi, (created_at AT TIME ZONE 'America/Sao_Paulo')::date)
-- — mas a comparavam com `current_date`, que é a data do início da transação no fuso da SESSÃO.
-- A prod roda sessões em UTC (TimeZone=UTC vindo do arquivo de configuração, sem override por papel
-- nem por banco — psql-ro, 2026-09-27), e o PostgREST herda. Das 21:00 às 23:59 BRT o current_date
-- já é o dia SEGUINTE em SP:
--   · get_ultimos_precos_cliente (preço de partida do pedido): o filtro anti-futuro aceitava pedido
--     datado de AMANHÃ, que vencia o DISTINCT ON e virava o "último praticado";
--   · medir_abaixo_piso_tier (medição A5, on-demand — nenhum chamador no código): a janela perdia o
--     dia mais antigo. O contrato da janela segue [hoje_SP − p_dias, ∞): SEM teto (pedido de data
--     futura entra) e, com p_dias=90, 91 datas-calendário. Só o "hoje" muda aqui.
--
-- Impacto medido em 2026-09-27: zero hoje no preço — 0 dos 31.550 pedidos do universo têm data de
-- SP depois de hoje (máx. order_date_kpi = 2026-09-25). Na medição, o dia perdido tinha 32 dos
-- 3.264 itens da janela de 90 dias (~1% dos ITENS numa consulta noturna — não limita a fração da
-- folga em R$, que esses itens podem concentrar). É defeito LATENTE: no preço, morde no dia em que
-- um pedido nascer com order_date_kpi futuro.
--
-- Única mudança em cada corpo: `current_date` → `(now() AT TIME ZONE 'America/Sao_Paulo')::date` —
-- o mesmo instante de início de transação (now() e current_date leem os dois o início da
-- transação), levado para a data de SP em vez da data da sessão. O resto é o corpo de prod linha a
-- linha (pg_get_functiondef, 2026-09-27): mesma assinatura e retorno, STABLE, SECURITY DEFINER,
-- search_path ('' e public), dono. Reescritos a partir do corpo VIVO, não do repo.
-- CREATE OR REPLACE preserva dono e ACL (nunca DROP+CREATE: o par renasce com o default privilege
-- e abre para anon). O REVOKE/GRANT abaixo é no-op em prod e existe para o ambiente onde a função
-- NASCE aqui (a PRE admite função ausente): o contrato é o PORTA_GATE de
-- scripts/authz-funcoes-fechadas.ts — anon/PUBLIC sem EXECUTE, authenticated com EXECUTE e o gate
-- no corpo. Os grants diretos de outros papéis (service_role, sandbox_exec_*) não são tocados.
--
-- Prova: db/test-hoje-sp-sessao-utc-precos-piso.sh (PG17, relógio controlado, borda do DIA de SP
-- cruzada sob sessão UTC e SP) e o mesmo script com --falsificar.
-- Aplicação: bun run db:aplicar — a transação é do executor, por isso não há BEGIN/COMMIT aqui.
-- Reverter depois do commit = migration compensatória nova com os corpos antigos.
--
-- Identidade de corpo (PRE e POS): md5 do corpo SEM comentários `--` e com espaço colapsado. O corpo
-- de get_ultimos_precos_cliente em prod já tem outra quebra de linha que o do repo (o apply por
-- outros caminhos reformata), e um md5 exato reprovaria uma aplicação sã. Limite declarado: o
-- normalizador não conhece literal SQL ('a--b' e 'a--c' colidem; 'a b' e 'a  b' também) — nenhum
-- dos dois corpos tem `--` nem espaço duplo dentro de literal (conferido).

-- Pré-condição: o corpo vivo de cada função tem de ser o PREDECESSOR revisado (o de prod em
-- 2026-09-27 = o das migrations de origem, módulo espaço) ou JÁ o desta migration (re-aplicar é
-- seguro). Qualquer outro corpo é mudança concorrente que este CREATE OR REPLACE apagaria em
-- silêncio — aborta. Função ausente (ambiente novo) segue.
DO $pre$
DECLARE
  v_alvo record;
  v_norm text;
BEGIN
  FOR v_alvo IN
    SELECT * FROM (VALUES
      ('public.get_ultimos_precos_cliente(uuid)', 'b8b3798d64e6bdbd8708eef7afc46222', '8d36e4875df012383a1d360789ce6f3d'),
      ('public.medir_abaixo_piso_tier(integer)',  '78b1d60f0fca7d9580b131eafdd55bb0', 'cce088ac976a1c0d1c01ba070bf10ed1')
    ) AS t(assinatura, md5_predecessor, md5_novo)
  LOOP
    SELECT md5(btrim(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', ' ', 'g')))
      INTO v_norm
      FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure(v_alvo.assinatura);
    IF v_norm IS NOT NULL AND v_norm NOT IN (v_alvo.md5_predecessor, v_alvo.md5_novo) THEN
      RAISE EXCEPTION 'PRE FALHOU: o corpo vivo de % (md5 normalizado %) não é o predecessor revisado nem o desta migration — outra mudança chegou antes; reconcilie antes de aplicar', v_alvo.assinatura, v_norm;
    END IF;
  END LOOP;
END
$pre$;

CREATE OR REPLACE FUNCTION public.get_ultimos_precos_cliente(p_customer uuid)
 RETURNS TABLE(product_id uuid, unit_price numeric, ultimo_praticado_em date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'employee'::public.app_role) OR public.has_role(auth.uid(), 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'forbidden: get_ultimos_precos_cliente exige staff' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT DISTINCT ON (oi.product_id) oi.product_id, oi.unit_price,
    COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS ultimo_praticado_em
  FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
  WHERE oi.customer_user_id = p_customer AND oi.customer_user_id = so.customer_user_id
    AND so.deleted_at IS NULL AND COALESCE(so.status, '') NOT IN ('cancelado', 'orcamento')
    AND oi.unit_price > 0 AND oi.product_id IS NOT NULL
    -- anti-futuro contra o hoje de SP: o "hoje" da sessão UTC da prod já é amanhã das 21:00 às 23:59 BRT
    AND COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) <= (now() AT TIME ZONE 'America/Sao_Paulo')::date
  ORDER BY oi.product_id, COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) DESC,
           so.created_at DESC, oi.created_at DESC, oi.id DESC;
END; $function$;
REVOKE EXECUTE ON FUNCTION public.get_ultimos_precos_cliente(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_ultimos_precos_cliente(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.medir_abaixo_piso_tier(p_dias integer DEFAULT 90)
 RETURNS TABLE(company text, tier text, itens_abaixo bigint, total_itens bigint, folga_negativa_reais numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- E2/FU4: era `pode_ver_carteira_completa`. Os parênteses ao redor do COALESCE não são
  -- estilo: `scripts/authz-gate-check.ts` só reconhece como BLOQUEIO as formas
  -- `IF NOT <gate>(…)` e `IF NOT ( … <gate>(…) … )`. Escrito como
  -- `IF NOT COALESCE(<gate>(…), false)` o CI classifica como gate DECORATIVO e falha.
  IF NOT (COALESCE(private.cap_custo_ler(auth.uid()), false)) THEN
    RAISE EXCEPTION 'forbidden: medir_abaixo_piso_tier exige capability de custo' USING errcode = '42501';
  END IF;
  RETURN QUERY
  WITH itens AS (
    SELECT so.account AS company, ctp.tier, oi.unit_price, oi.quantity, oi.omie_codigo_produto, op.familia,
      (SELECT ip.cmc FROM inventory_position ip
        WHERE ip.omie_codigo_produto = oi.omie_codigo_produto AND ip.cmc > 0 AND ip.cmc <> 'NaN'::numeric
          AND ip.account = ANY(CASE so.account WHEN 'oben' THEN ARRAY['vendas','oben']
                WHEN 'colacor' THEN ARRAY['colacor_vendas','colacor'] ELSE ARRAY[so.account] END)
        ORDER BY ip.synced_at DESC NULLS LAST LIMIT 1) AS cmc
    FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
    LEFT JOIN public.cliente_tier_preco ctp ON ctp.company = so.account AND ctp.customer_user_id = so.customer_user_id
    LEFT JOIN public.omie_products op ON op.omie_codigo_produto = oi.omie_codigo_produto AND op.account = so.account
    WHERE so.deleted_at IS NULL AND COALESCE(so.status, '') NOT IN ('cancelado', 'orcamento')
      AND so.omie_numero_pedido IS NOT NULL AND so.omie_numero_pedido::text <> ''
      AND so.account IN ('oben', 'colacor')
      -- janela de p_dias dias de SP contada do hoje de SP: a da sessão UTC da prod perdia o dia mais antigo das 21:00 às 23:59 BRT
      AND COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - p_dias
      AND oi.unit_price > 0
  ),
  avaliado AS (
    SELECT i.company, i.tier, i.unit_price, i.quantity, i.cmc, rp.piso_markup FROM itens i
    LEFT JOIN LATERAL public.resolve_markup_policy(i.company, i.omie_codigo_produto, i.familia, i.tier) rp ON true
    WHERE i.cmc IS NOT NULL AND i.cmc > 0
  )
  SELECT a.company, a.tier,
    count(*) FILTER (WHERE a.piso_markup IS NOT NULL AND a.unit_price < a.cmc * (1 + a.piso_markup/100)) AS itens_abaixo,
    count(*) AS total_itens,
    COALESCE(SUM((a.cmc * (1 + a.piso_markup/100) - a.unit_price) * a.quantity)
             FILTER (WHERE a.piso_markup IS NOT NULL AND a.unit_price < a.cmc * (1 + a.piso_markup/100)), 0) AS folga_negativa_reais
  FROM avaliado a GROUP BY a.company, a.tier ORDER BY a.company, a.tier NULLS FIRST;
END; $function$;
REVOKE EXECUTE ON FUNCTION public.medir_abaixo_piso_tier(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.medir_abaixo_piso_tier(integer) TO authenticated;

-- Postcondição: relê o CATÁLOGO (nunca invoca as funções) e aborta a transação se a migration não
-- pegou. É confirmação de INSTALAÇÃO — o CONTROLE (a borda do dia de SP decide o resultado sob
-- sessão UTC) é provado executando, no PG17 da prova, e não aqui.
DO $post$
DECLARE
  v_alvo record;
  v_oid oid;
  v_codigo text;
  v_norm text;
  v_secdef boolean;
  v_config text[];
  v_dono text;
  v_volatil "char";
BEGIN
  FOR v_alvo IN
    SELECT * FROM (VALUES
      ('public.get_ultimos_precos_cliente(uuid)', '8d36e4875df012383a1d360789ce6f3d', ARRAY['search_path=""'],
       '<= (now() AT TIME ZONE ''America/Sao_Paulo'')::date'),
      ('public.medir_abaixo_piso_tier(integer)',  'cce088ac976a1c0d1c01ba070bf10ed1', ARRAY['search_path=public'],
       '>= (now() AT TIME ZONE ''America/Sao_Paulo'')::date - p_dias')
    ) AS t(assinatura, md5_novo, config, trecho)
  LOOP
    v_oid := to_regprocedure(v_alvo.assinatura);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'POS1 FALHOU: % não existe — o preço de partida/a medição do piso quebrou', v_alvo.assinatura;
    END IF;
    SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g'),
           md5(btrim(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', ' ', 'g'))),
           p.prosecdef, p.proconfig, pg_catalog.pg_get_userbyid(p.proowner), p.provolatile
      INTO v_codigo, v_norm, v_secdef, v_config, v_dono, v_volatil
      FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
    IF NOT v_secdef OR v_config IS DISTINCT FROM v_alvo.config
       OR v_dono IS DISTINCT FROM 'postgres' OR v_volatil IS DISTINCT FROM 's' THEN
      RAISE EXCEPTION 'POS2 FALHOU: %: secdef=% config=% dono=% volatilidade=% — esperado SECURITY DEFINER, %, dono postgres, STABLE',
        v_alvo.assinatura, v_secdef, v_config, v_dono, v_volatil, v_alvo.config;
    END IF;
    IF v_norm IS DISTINCT FROM v_alvo.md5_novo THEN
      RAISE EXCEPTION 'POS3 FALHOU: o corpo instalado de % (md5 normalizado %) não é o desta migration', v_alvo.assinatura, v_norm;
    END IF;
    IF position(v_alvo.trecho IN v_codigo) = 0 OR v_codigo ~* '\mcurrent_date\M' THEN
      RAISE EXCEPTION 'POS4 FALHOU: % não compara com o hoje de SP, ou sobrou current_date no corpo', v_alvo.assinatura;
    END IF;
    IF pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS5 FALHOU: % ficou executável por anon/PUBLIC', v_alvo.assinatura;
    END IF;
    -- o grant POSITIVO que o produto usa: o staff chama pelo PostgREST como authenticated
    IF NOT pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS6 FALHOU: % sem EXECUTE para authenticated — o staff perderia a chamada', v_alvo.assinatura;
    END IF;
  END LOOP;
  RAISE NOTICE 'POS OK: preço de partida e medição do piso comparam com o hoje de SP; corpo, dono, volatilidade e ACL conferidos';
END
$post$;
