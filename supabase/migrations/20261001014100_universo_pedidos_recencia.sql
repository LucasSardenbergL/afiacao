-- 20261001014100_universo_pedidos_recencia.sql
-- ============================================================
-- Recência (private.customer_metrics_mv + melhoria_clientes_por_produto,
-- classificar_clientes_fornecedores, v_grupo_comercial): universo de pedidos CANÔNICO e data só
-- order_date_kpi onde há data.
-- ============================================================
-- A classe e a autoridade: ver o cabeçalho de 20261001014000_universo_pedidos_caca.sql e
-- docs/historico/universo-pedidos-classe-sql.md.
--
-- Antes desta migration (prod, 2026-10-01):
--   · private.customer_metrics_mv (recência/cadência/churn: fila crítica, scoring do farmer, rota,
--     Customer 360 — via a view-gate public.customer_metrics_mv e get_customer_metrics): denylist de
--     DOIS (cancelado, rascunho), sem deleted_at, data COALESCE(kpi, created_at de SP);
--   · melhoria_clientes_por_produto: denylist de TRÊS (sem orcamento), data COALESCE;
--   · classificar_clientes_fornecedores: denylist canônica, SEM deleted_at;
--   · v_grupo_comercial: ALLOWLIST dos 4 de venda (igual hoje; diverge se surgir status novo), data
--     created_at de SP.
--
-- Decisão do founder (2026-10-01): canônico + data só kpi — a D2 da positivação. Efeito medido na
-- prod (psql-ro, 2026-10-01 01:20 UTC): na MV, 1.229 clientes com pedido; só o universo muda 1 (o
-- orçamento de R$ 4.660 sai dos 90–180 dias); com a data só kpi mudam 3, e as somas passam a bater
-- com a positivação (90 d −R$ 767; 90–180 d −R$ 5.239,10). melhoria: 0 de 511 clientes mudam.
-- v_grupo_comercial: 0 (cliente_grupo_membros está vazia). classificar: 0 (nenhum pedido apagado).
--
-- O `order_date_kpi IS NOT NULL` explícito NÃO é redundante na MV (a cadência conta count(*) de toda
-- linha do base) nem no grupo comercial (faturamento_total soma toda linha); na melhoria ele SERIA
-- (a janela de 12 meses já exclui o kpi nulo), e por isso não entra — predicado redundante não se
-- falsifica.
--
-- MV não tem CREATE OR REPLACE: o bloco dela renomeia a antiga, cria a nova, re-amarra a view-gate por
-- CREATE OR REPLACE (preserva OID e ACL; o WITH (security_invoker = off, security_barrier = true) é
-- repetido — a gate é view-gate de propósito, database.md §4), copia o ACL item a item e derruba a
-- antiga já sem dependentes. O cron afiacao_customer_metrics_refresh_6h (REFRESH … CONCURRENTLY) segue
-- funcionando: o índice único é recriado com o mesmo nome.
--
-- Identidade (PRE e POS): md5 EXATO do prosrc (funções) e do pg_get_viewdef(oid, true) (views/MV),
-- medidos na prod; PRE aceita o predecessor ou este corpo; POS: semântica → md5 → config/ACL iguais.
-- Aplicação: `bun run db:aplicar <este arquivo> --ensaio`, depois sem --ensaio. Prova:
-- db/test-universo-pedidos-classe.sh.

ALTER FUNCTION public.melhoria_clientes_por_produto(text) STABLE;
ALTER FUNCTION public.classificar_clientes_fornecedores() VOLATILE;
ALTER VIEW public.v_grupo_comercial SET (security_invoker = true);

CREATE TEMP TABLE IF NOT EXISTS universo_retrato (alvo text PRIMARY KEY, config text NOT NULL, acl text NOT NULL) ON COMMIT DROP;

DO $pre$
DECLARE r record; v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.melhoria_clientes_por_produto(text)', 'fb00b17ac45b38e31a08fe4531c51618', 'afb1ec8cc6e75305fb1c7d3d716495c8'),
      ('public.classificar_clientes_fornecedores()', '7168163f53b1f515ec0e77ee87018b2d', 'c99d2afabff27f52fc5a45d9ddfabd88')
    ) AS x(alvo, predecessor, este)
  LOOP
    IF to_regprocedure(r.alvo) IS NULL THEN
      RAISE EXCEPTION 'PRE: % ausente — esta migration exige o predecessor medido na prod', r.alvo;
    END IF;
    SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.alvo);
    IF v_md5 IS DISTINCT FROM r.predecessor AND v_md5 IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'PRE: % deriva — md5(prosrc)=% não é o predecessor (%) nem este corpo (%)', r.alvo, v_md5, r.predecessor, r.este;
    END IF;
    INSERT INTO pg_temp.universo_retrato
      SELECT r.alvo, p.provolatile::text || '|' || p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|'
             || coalesce(array_to_string(p.proconfig, ','), '-'), coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), 'NULL')
        FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.alvo);
  END LOOP;
END $pre$;

DO $pre$
DECLARE r record; v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.v_grupo_comercial', '73de52bd7737a62d2828589f97661e9a', '636aee1851fb145c2da6084e681bbdbf')
    ) AS x(alvo, predecessor, este)
  LOOP
    IF to_regclass(r.alvo) IS NULL THEN
      RAISE EXCEPTION 'PRE: % ausente — esta migration exige o predecessor medido na prod', r.alvo;
    END IF;
    v_md5 := md5(pg_get_viewdef(to_regclass(r.alvo), true));
    IF v_md5 IS DISTINCT FROM r.predecessor AND v_md5 IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'PRE: % deriva — md5(viewdef)=% não é o predecessor (%) nem este corpo (%)', r.alvo, v_md5, r.predecessor, r.este;
    END IF;
    INSERT INTO pg_temp.universo_retrato
      SELECT r.alvo, coalesce((SELECT string_agg(o, ',' ORDER BY o) FROM unnest(c.reloptions) o), '-') || '|' || pg_get_userbyid(c.relowner),
             coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(c.relacl) a), 'NULL')
        FROM pg_catalog.pg_class c WHERE c.oid = to_regclass(r.alvo);
  END LOOP;
END $pre$;

-- ── private.customer_metrics_mv: MV não tem CREATE OR REPLACE ───────────────────────────────────
-- Renomeia a antiga (e o índice: nome de índice é por schema), cria a nova com o mesmo nome, re-amarra
-- a view-gate por CREATE OR REPLACE — preserva OID e ACL; o WITH é REPETIDO, porque omiti-lo reseta
-- security_invoker/security_barrier (database.md §4) e a gate passaria a ler como dono sem filtro —,
-- copia o ACL da antiga item a item (sem valor fixo: o que a prod tiver no instante do apply) e só
-- então derruba a antiga, já sem dependentes. Um dependente desconhecido faz o DROP falhar e a
-- transação inteira volta. A query da MV custa ~25 ms em prod (5.665 linhas): a trava é curta.
-- Os RENAME são a trava: ACCESS EXCLUSIVE na MV e na gate antes de qualquer leitura.
ALTER MATERIALIZED VIEW private.customer_metrics_mv RENAME TO customer_metrics_mv_antiga;
ALTER INDEX private.idx_customer_metrics_mv_uid RENAME TO idx_customer_metrics_mv_uid_antiga;
ALTER VIEW public.customer_metrics_mv SET (security_barrier = true);

DO $pre_mv$
DECLARE v_mv text; v_gate text;
BEGIN
  IF to_regclass('private.customer_metrics_mv_antiga') IS NULL OR to_regclass('public.customer_metrics_mv') IS NULL THEN
    RAISE EXCEPTION 'PRE: private.customer_metrics_mv ou a view-gate public.customer_metrics_mv ausente';
  END IF;
  v_mv := md5(pg_get_viewdef('private.customer_metrics_mv_antiga'::regclass, true));
  -- a gate segue a MV pelo OID: depois do RENAME o deparse dela diz _antiga. Normaliza o nome de volta,
  -- senão o md5 nunca bateria com o medido na prod (pego pela prova PG17).
  v_gate := md5(replace(pg_get_viewdef('public.customer_metrics_mv'::regclass, true),
                        'private.customer_metrics_mv_antiga', 'private.customer_metrics_mv'));
  IF v_mv IS DISTINCT FROM 'f47c2fd0fca117f97dc197bbae30670b' AND v_mv IS DISTINCT FROM 'f7f16282c71948d25f97ca8b31df9155' THEN
    RAISE EXCEPTION 'PRE: private.customer_metrics_mv deriva — md5(viewdef)=% não é o predecessor (f47c2fd0fca117f97dc197bbae30670b) nem este corpo', v_mv;
  END IF;
  IF v_gate IS DISTINCT FROM 'd1967849771139100c7ef200e0accfe9' THEN
    RAISE EXCEPTION 'PRE: public.customer_metrics_mv (view-gate) deriva — md5(viewdef)=% não é o medido (d1967849771139100c7ef200e0accfe9)', v_gate;
  END IF;
  INSERT INTO pg_temp.universo_retrato
    SELECT 'private.customer_metrics_mv', pg_get_userbyid(c.relowner),
           coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(c.relacl) a), 'NULL')
      FROM pg_catalog.pg_class c WHERE c.oid = 'private.customer_metrics_mv_antiga'::regclass;
  INSERT INTO pg_temp.universo_retrato
    SELECT 'public.customer_metrics_mv', coalesce((SELECT string_agg(o, ',' ORDER BY o) FROM unnest(c.reloptions) o), '-') || '|' || pg_get_userbyid(c.relowner),
           coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(c.relacl) a), 'NULL')
      FROM pg_catalog.pg_class c WHERE c.oid = 'public.customer_metrics_mv'::regclass;
END $pre_mv$;

CREATE MATERIALIZED VIEW private.customer_metrics_mv AS
 WITH base AS (
         SELECT so.customer_user_id,
            so.total,
            so.order_date_kpi AS d
           FROM sales_orders so
          WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento') AND so.deleted_at IS NULL AND so.order_date_kpi IS NOT NULL
        ), last_order AS (
         SELECT base.customer_user_id,
            (max(base.d)::timestamp without time zone AT TIME ZONE 'America/Sao_Paulo'::text) AS ultima_compra_data,
            GREATEST(0, (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - max(base.d)) AS dias_desde_ultima_compra
           FROM base
          GROUP BY base.customer_user_id
        ), orders_90d AS (
         SELECT base.customer_user_id,
            count(*) AS pedidos_90d,
            COALESCE(sum(base.total), 0::numeric) AS faturamento_90d,
                CASE
                    WHEN count(*) > 0 THEN COALESCE(sum(base.total), 0::numeric) / count(*)::numeric
                    ELSE 0::numeric
                END AS ticket_medio_90d
           FROM base
          WHERE base.d >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - 90) AND base.d <= (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date
          GROUP BY base.customer_user_id
        ), orders_prev_90d AS (
         SELECT base.customer_user_id,
            COALESCE(sum(base.total), 0::numeric) AS faturamento_prev_90d
           FROM base
          WHERE base.d >= ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - 180) AND base.d < ((now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - 90)
          GROUP BY base.customer_user_id
        ), cadence AS (
         SELECT base.customer_user_id,
                CASE
                    WHEN count(*) >= 3 THEN (max(base.d) - min(base.d))::numeric / NULLIF(count(*) - 1, 0)::numeric
                    ELSE NULL::numeric
                END AS intervalo_medio_dias
           FROM base
          GROUP BY base.customer_user_id
        )
 SELECT p.user_id AS customer_user_id,
    p.name AS razao_social,
    p.document,
    lo.ultima_compra_data,
    COALESCE(lo.dias_desde_ultima_compra, 9999) AS dias_desde_ultima_compra,
    COALESCE(o90.pedidos_90d, 0::bigint) AS pedidos_90d,
    COALESCE(o90.faturamento_90d, 0::numeric) AS faturamento_90d,
    COALESCE(o90.ticket_medio_90d, 0::numeric) AS ticket_medio_90d,
    COALESCE(op.faturamento_prev_90d, 0::numeric) AS faturamento_prev_90d,
    c.intervalo_medio_dias,
        CASE
            WHEN c.intervalo_medio_dias IS NOT NULL AND c.intervalo_medio_dias > 0::numeric THEN COALESCE(lo.dias_desde_ultima_compra, 9999)::numeric / c.intervalo_medio_dias
            ELSE NULL::numeric
        END AS atraso_relativo,
        CASE
            WHEN c.intervalo_medio_dias IS NULL THEN true
            ELSE false
        END AS is_cold_start,
    now() AS calculated_at
   FROM profiles p
     LEFT JOIN last_order lo ON lo.customer_user_id = p.user_id
     LEFT JOIN orders_90d o90 ON o90.customer_user_id = p.user_id
     LEFT JOIN orders_prev_90d op ON op.customer_user_id = p.user_id
     LEFT JOIN cadence c ON c.customer_user_id = p.user_id
  WHERE p.is_employee = false OR p.is_employee IS NULL
WITH DATA;
CREATE UNIQUE INDEX idx_customer_metrics_mv_uid ON private.customer_metrics_mv USING btree (customer_user_id);

CREATE OR REPLACE VIEW public.customer_metrics_mv WITH (security_invoker = off, security_barrier = true) AS
 SELECT customer_user_id,
    razao_social,
    document,
    ultima_compra_data,
    dias_desde_ultima_compra,
    pedidos_90d,
    faturamento_90d,
    ticket_medio_90d,
    faturamento_prev_90d,
    intervalo_medio_dias,
    atraso_relativo,
    is_cold_start,
    calculated_at
   FROM private.customer_metrics_mv
  WHERE (( SELECT auth.role() AS role)) = 'service_role'::text OR COALESCE(( SELECT has_role(( SELECT auth.uid() AS uid), 'master'::app_role) AS has_role), false) OR COALESCE(( SELECT has_role(( SELECT auth.uid() AS uid), 'employee'::app_role) AS has_role), false);

DO $acl_mv$
DECLARE a record; v_dono oid;
BEGIN
  SELECT c.relowner INTO v_dono FROM pg_catalog.pg_class c WHERE c.oid = 'private.customer_metrics_mv'::regclass;
  -- zera o que um default privilege do schema tenha dado à nova…
  FOR a IN SELECT DISTINCT x.grantee FROM pg_catalog.pg_class c, aclexplode(c.relacl) x
            WHERE c.oid = 'private.customer_metrics_mv'::regclass AND x.grantee <> v_dono LOOP
    EXECUTE format('REVOKE ALL ON private.customer_metrics_mv FROM %s',
                   CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END);
  END LOOP;
  -- …e reconcede exatamente o que a antiga tinha
  FOR a IN SELECT x.* FROM pg_catalog.pg_class c, aclexplode(c.relacl) x
            WHERE c.oid = 'private.customer_metrics_mv_antiga'::regclass AND x.grantee <> v_dono LOOP
    EXECUTE format('GRANT %s ON private.customer_metrics_mv TO %s%s', a.privilege_type,
                   CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END,
                   CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $acl_mv$;

DROP MATERIALIZED VIEW private.customer_metrics_mv_antiga;

DO $pos_mv$
DECLARE v_def text; v_ret record; v_dono text; v_acl text; v_cfg text; v_pop boolean;
BEGIN
  IF to_regclass('private.customer_metrics_mv_antiga') IS NOT NULL THEN
    RAISE EXCEPTION 'POS: a MV antiga sobreviveu';
  END IF;
  v_def := pg_get_viewdef('private.customer_metrics_mv'::regclass, true);
  IF position($q$so.status <> ALL (ARRAY['cancelado'::text, 'rascunho'::text, 'pendente'::text, 'orcamento'::text])$q$ IN v_def) = 0 THEN
    RAISE EXCEPTION 'POS: private.customer_metrics_mv sem a denylist canônica dos 4';
  END IF;
  IF position('so.deleted_at IS NULL' IN v_def) = 0 OR position('so.order_date_kpi IS NOT NULL' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POS: private.customer_metrics_mv sem deleted_at IS NULL ou sem order_date_kpi IS NOT NULL';
  END IF;
  IF v_def ~ 'COALESCE\(so\.order_date_kpi' THEN
    RAISE EXCEPTION 'POS: private.customer_metrics_mv ainda data por COALESCE(kpi, created_at) — conta 2x o gêmeo push/pull';
  END IF;
  IF md5(v_def) IS DISTINCT FROM 'f7f16282c71948d25f97ca8b31df9155' THEN
    RAISE EXCEPTION 'POS: private.customer_metrics_mv md5(viewdef)=% não é o corpo desta migration (f7f16282c71948d25f97ca8b31df9155)', md5(v_def);
  END IF;
  SELECT pg_get_userbyid(c.relowner), coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(c.relacl) a), 'NULL'), c.relispopulated
    INTO v_dono, v_acl, v_pop FROM pg_catalog.pg_class c WHERE c.oid = 'private.customer_metrics_mv'::regclass;
  SELECT * INTO v_ret FROM pg_temp.universo_retrato WHERE alvo = 'private.customer_metrics_mv';
  IF v_ret.config IS DISTINCT FROM v_dono OR v_ret.acl IS DISTINCT FROM v_acl THEN
    RAISE EXCEPTION 'POS: MV com dono/ACL diferentes — antes [%|%], depois [%|%]', v_ret.config, v_ret.acl, v_dono, v_acl;
  END IF;
  IF v_pop IS NOT TRUE THEN RAISE EXCEPTION 'POS: MV nova não foi populada'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid = 'private.customer_metrics_mv'::regclass
                    AND i.indisunique AND i.indexrelid = 'private.idx_customer_metrics_mv_uid'::regclass) THEN
    RAISE EXCEPTION 'POS: MV sem o índice único (o REFRESH ... CONCURRENTLY do cron depende dele)';
  END IF;
  -- a gate: mesmo texto (re-amarrada pelo nome), mesmas opções, dono e ACL
  IF md5(pg_get_viewdef('public.customer_metrics_mv'::regclass, true)) IS DISTINCT FROM 'd1967849771139100c7ef200e0accfe9' THEN
    RAISE EXCEPTION 'POS: a view-gate mudou de texto';
  END IF;
  SELECT coalesce((SELECT string_agg(o, ',' ORDER BY o) FROM unnest(c.reloptions) o), '-') || '|' || pg_get_userbyid(c.relowner),
         coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(c.relacl) a), 'NULL')
    INTO v_cfg, v_acl FROM pg_catalog.pg_class c WHERE c.oid = 'public.customer_metrics_mv'::regclass;
  SELECT * INTO v_ret FROM pg_temp.universo_retrato WHERE alvo = 'public.customer_metrics_mv';
  IF v_ret.config IS DISTINCT FROM v_cfg OR v_ret.acl IS DISTINCT FROM v_acl THEN
    RAISE EXCEPTION 'POS: a view-gate mudou opções/dono/ACL — antes [%|%], depois [%|%]', v_ret.config, v_ret.acl, v_cfg, v_acl;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_rewrite rw ON rw.oid = d.objid
                  WHERE rw.ev_class = 'public.customer_metrics_mv'::regclass AND d.refobjid = 'private.customer_metrics_mv'::regclass) THEN
    RAISE EXCEPTION 'POS: a view-gate não lê a MV nova';
  END IF;
  RAISE NOTICE 'POS MV OK';
END $pos_mv$;


-- public.melhoria_clientes_por_produto
CREATE OR REPLACE FUNCTION public.melhoria_clientes_por_produto(p_termo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'private'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_full boolean;
  v_result jsonb;
begin
  if v_uid is null or not (has_role(v_uid,'employee'::app_role) or has_role(v_uid,'master'::app_role)) then
    raise exception 'Apenas staff pode consultar';
  end if;
  if length(trim(coalesce(p_termo,''))) < 3 then
    raise exception 'Termo de busca muito curto (mínimo 3 caracteres)';
  end if;
  v_full := pode_ver_carteira_completa(v_uid);

  with prods as (
    select id, descricao, codigo, account
    from omie_products
    where coalesce(ativo, true) = true
      and (descricao ilike private.padrao_like_contem(trim(p_termo)) escape '\' or codigo ilike private.padrao_like_contem(trim(p_termo)) escape '\')
    order by descricao
    limit 5
  ),
  compras as (
    select oi.customer_user_id,
           count(distinct oi.sales_order_id) as n_pedidos,
           max(so.order_date_kpi) as ultima_compra,
           sum(oi.quantity * oi.unit_price) as valor_12m
    from order_items oi
    join sales_orders so on so.id = oi.sales_order_id
    join prods p on p.id = oi.product_id
    where so.status not in ('cancelado','rascunho','pendente','orcamento')
      and so.deleted_at is null
      and so.order_date_kpi >= (now() at time zone 'America/Sao_Paulo')::date - interval '12 months'
    group by oi.customer_user_id
  ),
  visiveis as (
    select c.* from compras c
    where v_full or carteira_visivel_para(c.customer_user_id, v_uid)
  ),
  top50 as (
    -- NULLS LAST e OBRIGATORIO desde que order_items.unit_price virou nullable
    -- (20260905225613): `sum(quantity * unit_price)` devolve NULL quando NENHUM item do
    -- cliente tem preco conhecido, e o default do Postgres em DESC e NULLS **FIRST** —
    -- medido: `ORDER BY v DESC` sobre (1,NULL,5) devolve NULL,5,1. Sem isto, o cliente
    -- de quem NAO SE SABE a receita encabecaria o top-50 de melhoria, invertendo a
    -- ordem que a tela usa para decidir quem visitar. "Nao sei" nao e "o maior".
    select * from visiveis order by valor_12m desc nulls last limit 50
  )
  select jsonb_build_object(
    'produtos_casados', (select coalesce(jsonb_agg(jsonb_build_object(
        'descricao', descricao, 'codigo', codigo, 'account', account)), '[]'::jsonb) from prods),
    'clientes', (select coalesce(jsonb_agg(jsonb_build_object(
        'cliente', coalesce(pr.razao_social, pr.name),
        'n_pedidos', t.n_pedidos,
        'ultima_compra', t.ultima_compra,
        'valor_12m', round(t.valor_12m::numeric, 2)
      ) order by t.valor_12m desc nulls last), '[]'::jsonb)
      from top50 t join profiles pr on pr.user_id = t.customer_user_id),
    'total_clientes_visiveis', (select count(*) from visiveis),
    'escopo', case when v_full then 'todos' else 'minha_carteira' end
  ) into v_result;

  return v_result;
end $function$;

-- public.classificar_clientes_fornecedores
CREATE OR REPLACE FUNCTION public.classificar_clientes_fornecedores()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_classificados int;
  v_excluidos     int;
BEGIN
  UPDATE public.cliente_classificacao cc SET
    is_fornecedor = EXISTS (
      SELECT 1 FROM unnest(cc.tags_omie) t
      WHERE lower(trim(t)) = ANY (ARRAY['fornecedor','transportadora'])
    ),
    tem_venda_real = EXISTS (
      SELECT 1 FROM public.sales_orders so
      WHERE so.customer_user_id = cc.user_id
        AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento') AND so.deleted_at IS NULL
    ),
    excluir_da_carteira = (
      EXISTS (
        SELECT 1 FROM unnest(cc.tags_omie) t
        WHERE lower(trim(t)) = ANY (ARRAY['fornecedor','transportadora'])
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.sales_orders so
        WHERE so.customer_user_id = cc.user_id
          AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento') AND so.deleted_at IS NULL
      )
      AND NOT EXISTS (SELECT 1 FROM public.fornecedor_excecao e WHERE e.user_id = cc.user_id)
    ),
    updated_at = now();
  GET DIAGNOSTICS v_classificados = ROW_COUNT;
  SELECT count(*) INTO v_excluidos FROM public.cliente_classificacao WHERE excluir_da_carteira;
  RETURN jsonb_build_object('classificados', v_classificados, 'excluidos', v_excluidos);
END $function$;

-- public.v_grupo_comercial
CREATE OR REPLACE VIEW public.v_grupo_comercial WITH (security_invoker = true) AS
 WITH ped AS (
         SELECT regexp_replace(COALESCE(p.cnpj, p.document, ''::text), '\D'::text, ''::text, 'g'::text) AS doc,
            so.order_date_kpi AS data,
            COALESCE(so.total, ( SELECT sum(((it.value ->> 'quantity'::text)::numeric) * ((it.value ->> 'unit_price'::text)::numeric)) AS sum
                   FROM jsonb_array_elements(so.items) it(value))) AS valor
           FROM sales_orders so
             JOIN profiles p ON p.user_id = so.customer_user_id
          WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento') AND so.deleted_at IS NULL AND so.order_date_kpi IS NOT NULL
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

DO $pos$
DECLARE r record; v_src text; v_cfg text; v_acl text; v_ret record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.melhoria_clientes_por_produto(text)', 'afb1ec8cc6e75305fb1c7d3d716495c8'),
      ('public.classificar_clientes_fornecedores()', 'c99d2afabff27f52fc5a45d9ddfabd88')
    ) AS x(alvo, este)
  LOOP
    SELECT p.prosrc, p.provolatile::text || '|' || p.prosecdef::text || '|' || pg_get_userbyid(p.proowner) || '|'
             || coalesce(array_to_string(p.proconfig, ','), '-'),
           coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(p.proacl) a), 'NULL')
      INTO v_src, v_cfg, v_acl
      FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.alvo);
    IF v_src IS NULL THEN RAISE EXCEPTION 'POS: % sumiu', r.alvo; END IF;
    -- semântica primeiro (diz O QUE está errado); o md5 depois (só diz QUE está)
    IF position($q$so.status NOT IN ('cancelado','rascunho','pendente','orcamento')$q$ IN v_src) = 0
       AND position($q$so.status not in ('cancelado','rascunho','pendente','orcamento')$q$ IN v_src) = 0 THEN
      RAISE EXCEPTION 'POS: % sem a denylist canônica dos 4 no alias so', r.alvo;
    END IF;
    IF v_src ~* 'so\.deleted_at\s+is\s+null' IS NOT TRUE THEN
      RAISE EXCEPTION 'POS: % sem so.deleted_at IS NULL', r.alvo;
    END IF;
    IF v_src ~* $re$(is distinct from 'cancelado'|coalesce\(so\.status|status in \('faturado')$re$ THEN
      RAISE EXCEPTION 'POS: % ainda carrega a forma antiga do universo', r.alvo;
    END IF;
    IF md5(v_src) IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'POS: % md5(prosrc)=% não é o corpo desta migration (%)', r.alvo, md5(v_src), r.este;
    END IF;
    SELECT * INTO v_ret FROM pg_temp.universo_retrato WHERE alvo = r.alvo;
    IF v_ret.config IS DISTINCT FROM v_cfg OR v_ret.acl IS DISTINCT FROM v_acl THEN
      RAISE EXCEPTION 'POS: % mudou config/ACL — antes [%|%], depois [%|%]', r.alvo, v_ret.config, v_ret.acl, v_cfg, v_acl;
    END IF;
  END LOOP;
  RAISE NOTICE 'POS OK';
END $pos$;

DO $pos$
DECLARE r record; v_def text; v_cfg text; v_acl text; v_ret record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.v_grupo_comercial', '636aee1851fb145c2da6084e681bbdbf')
    ) AS x(alvo, este)
  LOOP
    v_def := pg_get_viewdef(to_regclass(r.alvo), true);
    SELECT coalesce((SELECT string_agg(o, ',' ORDER BY o) FROM unnest(c.reloptions) o), '-') || '|' || pg_get_userbyid(c.relowner),
           coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(c.relacl) a), 'NULL')
      INTO v_cfg, v_acl FROM pg_catalog.pg_class c WHERE c.oid = to_regclass(r.alvo);
    -- o deparse escreve a denylist como <> ALL (ARRAY[...]): a semântica se lê nessa forma
    IF position($q$so.status <> ALL (ARRAY['cancelado'::text, 'rascunho'::text, 'pendente'::text, 'orcamento'::text])$q$ IN v_def) = 0 THEN
      RAISE EXCEPTION 'POS: % sem a denylist canônica dos 4 no alias so', r.alvo;
    END IF;
    IF position('so.deleted_at IS NULL' IN v_def) = 0 OR position('so.order_date_kpi IS NOT NULL' IN v_def) = 0 THEN
      RAISE EXCEPTION 'POS: % sem deleted_at IS NULL ou sem order_date_kpi IS NOT NULL', r.alvo;
    END IF;
    IF v_def ~ 'COALESCE\(so\.order_date_kpi' OR v_def ~ 'so\.created_at AT TIME ZONE' THEN
      RAISE EXCEPTION 'POS: % ainda data por created_at (o fallback conta 2x o gêmeo push/pull)', r.alvo;
    END IF;
    IF md5(v_def) IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'POS: % md5(viewdef)=% não é o corpo desta migration (%)', r.alvo, md5(v_def), r.este;
    END IF;
    SELECT * INTO v_ret FROM pg_temp.universo_retrato WHERE alvo = r.alvo;
    IF v_ret.config IS DISTINCT FROM v_cfg OR v_ret.acl IS DISTINCT FROM v_acl THEN
      RAISE EXCEPTION 'POS: % mudou opções/dono/ACL — antes [%|%], depois [%|%]', r.alvo, v_ret.config, v_ret.acl, v_cfg, v_acl;
    END IF;
  END LOOP;
  RAISE NOTICE 'POS OK';
END $pos$;
