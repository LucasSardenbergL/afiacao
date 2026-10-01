-- 20261001014000_universo_pedidos_caca.sql
-- ============================================================
-- Caça (v_caca_compradores, v_caca_candidatos): o universo de pedidos passa a ser o CANÔNICO e a
-- data do pedido passa a ser só order_date_kpi.
-- ============================================================
-- A classe: objeto SQL que lê public.sales_orders com OUTRO universo que o da autoridade — a
-- denylist status NOT IN ('cancelado','rascunho','pendente','orcamento') junto com deleted_at IS NULL
-- (src/lib/farmer/universo-pedidos.ts; SQL canônico: private.margem_cliente_agregada,
-- _carteira_positivacao_for_owner, recommend_cluster_agregado). Diário:
-- docs/historico/universo-pedidos-classe-sql.md.
--
-- As duas views tinham, na CTE so_ok, a denylist de DOIS (cancelado, rascunho) — orcamento e pendente
-- entravam como compra — e a data COALESCE(order_date_kpi, created_at de SP). O fallback conta 2x a
-- venda que o app empurra ao Omie: ela volta pelo importador como OUTRA linha, com o mesmo
-- (account, omie_pedido_id) e com kpi, e a linha do app (sem kpi) entrava pela created_at
-- (database.md §5, gêmeos push/pull).
--
-- Decisão do founder (2026-10-01): canônico + data só kpi — a D2 da positivação
-- (docs/historico/positivacao-universo-canonico.md). Efeito medido na prod (psql-ro, 2026-10-01
-- 01:20 UTC), por (cliente, conta) de compras: 1.726 grupos; só o universo muda 1 (−1 pedido,
-- −R$ 4.660, o orçamento de 12/06); com a data só kpi mudam 3 (−4 pedidos, −R$ 6.006,10 — o
-- orçamento e os gêmeos das vendas recentes do app). A troca: a venda do app aparece na caça depois
-- que o importador a traz (cron ~2 h por conta), e deixa de contar 2x.
--
-- O `so.order_date_kpi IS NOT NULL` NÃO é redundante: compras/grupo contam count(*) e somam total
-- sem comparar data, então a linha do app sem kpi seguiria contando sem ele.
--
-- Conserto: a ÚNICA mudança em cada view é a CTE so_ok (2 linhas). O resto é o texto VIVO da prod
-- (pg_get_viewdef(oid, true) em 2026-10-01, pós-20260930230623 do fuso de SP), gerado por troca
-- exata com contagem conferida; o WITH (security_invoker = on) é repetido (omiti-lo RESETA a opção
-- e a view passa a ler como dono, sem RLS — database.md §4).
--
-- Identidade (PRE e POS): md5 EXATO do pg_get_viewdef(oid, true). PRE aceita o predecessor medido ou
-- este corpo (re-aplicar é no-op); qualquer outro corpo aborta. POS: semântica primeiro (denylist dos
-- 4 no deparse, deleted_at, kpi IS NOT NULL, sem fallback), depois o md5, depois opções/dono/ACL iguais
-- aos de antes.
--
-- Aplicação: `bun run db:aplicar <este arquivo> --ensaio` e depois sem --ensaio (o executor É a
-- transação; o arquivo não leva BEGIN/COMMIT). Prova: db/test-universo-pedidos-classe.sh (PG17 com o
-- schema-snapshot da prod e os predecessores EXATOS de
-- db/fixtures/universo-pedidos-predecessoras-prod-20261001.sql; bloco U predicado a predicado,
-- --falsificar).

-- Trava ANTES de ler: o ALTER sem efeito (o mesmo security_invoker) prende a linha de pg_class; um
-- CREATE OR REPLACE concorrente espera esta transação e falha na PRE dele.
ALTER VIEW public.v_caca_compradores SET (security_invoker = on);
ALTER VIEW public.v_caca_candidatos SET (security_invoker = on);

CREATE TEMP TABLE IF NOT EXISTS universo_retrato (alvo text PRIMARY KEY, config text NOT NULL, acl text NOT NULL) ON COMMIT DROP;

DO $pre$
DECLARE r record; v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.v_caca_compradores', '41cce289721d3631b1bd518e55dc048f', '8a5cb6e0b81e3b0024a9909d2d87b4ee'),
      ('public.v_caca_candidatos', '24af34211e33745ac90b36c559561dbe', 'f7538335d873138f190f6c60a74b6ffa')
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

-- public.v_caca_compradores
CREATE OR REPLACE VIEW public.v_caca_compradores WITH (security_invoker = on) AS
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
            so.order_date_kpi AS dt,
            cv.documento
           FROM sales_orders so
             JOIN cli_valid cv ON cv.user_id = so.customer_user_id
          WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento') AND so.deleted_at IS NULL AND so.order_date_kpi IS NOT NULL AND (so.account = ANY (ARRAY['oben'::text, 'colacor'::text]))
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

-- public.v_caca_candidatos
CREATE OR REPLACE VIEW public.v_caca_candidatos WITH (security_invoker = on) AS
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
            so.order_date_kpi AS dt,
            cv.documento
           FROM sales_orders so
             JOIN cli_valid cv ON cv.user_id = so.customer_user_id
          WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento') AND so.deleted_at IS NULL AND so.order_date_kpi IS NOT NULL AND (so.account = ANY (ARRAY['oben'::text, 'colacor'::text]))
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

DO $pos$
DECLARE r record; v_def text; v_cfg text; v_acl text; v_ret record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.v_caca_compradores', '8a5cb6e0b81e3b0024a9909d2d87b4ee'),
      ('public.v_caca_candidatos', 'f7538335d873138f190f6c60a74b6ffa')
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
