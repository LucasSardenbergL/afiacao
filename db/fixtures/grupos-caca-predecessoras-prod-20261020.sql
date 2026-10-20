-- db/fixtures/grupos-caca-predecessoras-prod-20261020.sql
-- ============================================================
-- Os PREDECESSORES da migration 20261020130000_grupos_caca_cnpj_alfanumerico, VERBATIM da prod:
-- pg_get_functiondef / pg_get_viewdef(oid, true) via psql-ro em 2026-10-20 ~07:30 UTC, já com
-- 20261019140000 (helpers de CNPJ alfanumérico, #3195) aplicada. Carregado SOBRE o schema-snapshot
-- pela prova db/test-grupos-caca-cnpj-alfanumerico.sh: o snapshot (2026-10-19 15:32) não tem as 2 funções
-- e perde barras invertidas de literais de regex; a prova precisa do corpo que a PRE vai encontrar na prod,
-- e o asserta pelo md5 anotado em cada bloco.
-- NÃO é migration e não se aplica em lugar nenhum: é dado de teste.
-- ============================================================

-- public.cnpj_alfanumerico_valido(text) · md5(prosrc) prod = b27b482a550084775b12ef78f03e29c4
CREATE OR REPLACE FUNCTION public.cnpj_alfanumerico_valido(p_doc text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE STRICT
 SET search_path TO ''
AS $function$
DECLARE
  v_pesos1 constant int[] := ARRAY[5,4,3,2,9,8,7,6,5,4,3,2];
  v_pesos2 constant int[] := ARRAY[6,5,4,3,2,9,8,7,6,5,4,3,2];
  v_soma int := 0;
  v_resto int;
  v_d1 int;
  v_d2 int;
  i int;
BEGIN
  IF p_doc !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN
    RETURN false;
  END IF;
  FOR i IN 1..12 LOOP
    v_soma := v_soma + (ascii(substr(p_doc, i, 1)) - 48) * v_pesos1[i];
  END LOOP;
  v_resto := v_soma % 11;
  v_d1 := CASE WHEN v_resto < 2 THEN 0 ELSE 11 - v_resto END;
  v_soma := v_d1 * v_pesos2[13];
  FOR i IN 1..12 LOOP
    v_soma := v_soma + (ascii(substr(p_doc, i, 1)) - 48) * v_pesos2[i];
  END LOOP;
  v_resto := v_soma % 11;
  v_d2 := CASE WHEN v_resto < 2 THEN 0 ELSE 11 - v_resto END;
  RETURN substr(p_doc, 13, 2) = v_d1::text || v_d2::text;
END;
$function$

;

-- public.normalizar_documento(text) · md5(prosrc) prod = b7659502c90df3ff483c576cf56d559d
CREATE OR REPLACE FUNCTION public.normalizar_documento(p_bruto text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
 SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN (btrim(upper(p_bruto)) ~ '^[0-9A-Z]{12}[0-9]{2}$'
          OR btrim(upper(p_bruto)) ~ '^[0-9A-Z]{2}[.][0-9A-Z]{3}[.][0-9A-Z]{3}/[0-9A-Z]{4}-[0-9]{2}$')
     AND btrim(upper(p_bruto)) ~ '[A-Z]'
     AND public.cnpj_alfanumerico_valido(regexp_replace(btrim(upper(p_bruto)), '[-./]', '', 'g'))
    THEN regexp_replace(btrim(upper(p_bruto)), '[-./]', '', 'g')
    ELSE regexp_replace(p_bruto, '\D', '', 'g')
  END
$function$

;

-- ACL de prod das duas (psql-ro 2026-10-20): postgres=X, service_role=X, sandbox_exec_*=X — fechadas a PUBLIC/anon/authenticated.
REVOKE ALL ON FUNCTION public.cnpj_alfanumerico_valido(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.cnpj_alfanumerico_valido(text) TO service_role;
REVOKE ALL ON FUNCTION public.normalizar_documento(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.normalizar_documento(text) TO service_role;

-- public.v_grupo_comercial · reloptions prod = {security_invoker=true} · md5(viewdef) prod = 636aee1851fb145c2da6084e681bbdbf
CREATE OR REPLACE VIEW public.v_grupo_comercial WITH (security_invoker = true) AS
 WITH ped AS (
         SELECT regexp_replace(COALESCE(p.cnpj, p.document, ''::text), '\D'::text, ''::text, 'g'::text) AS doc,
            so.order_date_kpi AS data,
            COALESCE(so.total, ( SELECT sum(((it.value ->> 'quantity'::text)::numeric) * ((it.value ->> 'unit_price'::text)::numeric)) AS sum
                   FROM jsonb_array_elements(so.items) it(value))) AS valor
           FROM sales_orders so
             JOIN profiles p ON p.user_id = so.customer_user_id
          WHERE (so.status <> ALL (ARRAY['cancelado'::text, 'rascunho'::text, 'pendente'::text, 'orcamento'::text])) AND so.deleted_at IS NULL AND so.order_date_kpi IS NOT NULL
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

-- public.v_grupo_contatos · reloptions prod = {security_invoker=true} · md5(viewdef) prod = b1b75f0163b75f0906f56f9053374969
CREATE OR REPLACE VIEW public.v_grupo_contatos WITH (security_invoker = true) AS
 SELECT m.grupo_id,
    m.documento,
    p.user_id,
    COALESCE(p.razao_social, p.name) AS nome,
    p.phone,
    p.email,
    a.city AS cidade,
    a.state AS uf,
    NULLIF(TRIM(BOTH FROM (COALESCE(a.street, ''::text) || ' '::text) || COALESCE(a.number, ''::text)), ''::text) AS endereco,
    oc.omie_codigo_vendedor,
    oc.account AS empresa_omie
   FROM cliente_grupo_membros m
     JOIN profiles p ON regexp_replace(COALESCE(p.cnpj, p.document, ''::text), '\D'::text, ''::text, 'g'::text) = m.documento
     LEFT JOIN addresses a ON a.user_id = p.user_id AND a.is_default = true
     LEFT JOIN omie_customer_account_map_fresco oc ON oc.user_id = p.user_id AND oc.account = 'oben'::text;

-- public.v_grupo_contas_receber · reloptions prod = {security_invoker=true} · md5(viewdef) prod = b05ddadaa94d946e3e84184cee2b97ed
CREATE OR REPLACE VIEW public.v_grupo_contas_receber WITH (security_invoker = true) AS
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

-- public.v_grupo_contas_receber_por_doc · reloptions prod = {security_invoker=true} · md5(viewdef) prod = ab437b5db3d7f3f914c7d31c0783133f
CREATE OR REPLACE VIEW public.v_grupo_contas_receber_por_doc WITH (security_invoker = true) AS
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

-- public.v_caca_compradores · reloptions prod = {security_invoker=on} · md5(viewdef) prod = 8a5cb6e0b81e3b0024a9909d2d87b4ee
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
          WHERE (so.status <> ALL (ARRAY['cancelado'::text, 'rascunho'::text, 'pendente'::text, 'orcamento'::text])) AND so.deleted_at IS NULL AND so.order_date_kpi IS NOT NULL AND (so.account = ANY (ARRAY['oben'::text, 'colacor'::text]))
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

-- public.v_caca_candidatos · reloptions prod = {security_invoker=on} · md5(viewdef) prod = f7538335d873138f190f6c60a74b6ffa
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
          WHERE (so.status <> ALL (ARRAY['cancelado'::text, 'rascunho'::text, 'pendente'::text, 'orcamento'::text])) AND so.deleted_at IS NULL AND so.order_date_kpi IS NOT NULL AND (so.account = ANY (ARRAY['oben'::text, 'colacor'::text]))
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

-- ACL de prod das 6 views (relacl, psql-ro 2026-10-20): anon/authenticated/service_role com tudo (arwdDxtm).
GRANT ALL ON public.v_grupo_comercial, public.v_grupo_contatos, public.v_grupo_contas_receber,
  public.v_grupo_contas_receber_por_doc, public.v_caca_compradores, public.v_caca_candidatos
  TO anon, authenticated, service_role;
