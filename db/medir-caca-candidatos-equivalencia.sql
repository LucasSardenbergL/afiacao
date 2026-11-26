-- db/medir-caca-candidatos-equivalencia.sql — prova de equivalência da 20261126230000 (READ-ONLY).
--   bun run db:aplicar db/medir-caca-candidatos-equivalencia.sql --ensaio   (SEMPRE --ensaio)
-- Por persona (farmer, master): md5 linha a linha, ordenado, da view ATUAL × o corpo NOVO inline.
-- Mesmo md5 e mesma contagem = mesma saída. Roda antes do apply (view antiga viva).
CREATE TEMP VIEW caca_cand_novo AS
 WITH cli AS (
         SELECT p.user_id,
            p.name,
            k.phone,
            p.cnae,
                CASE
                    WHEN length(
                    CASE
                        WHEN COALESCE(k.document, ''::text) ~ '[A-Za-z]'::text THEN normalizar_documento(COALESCE(k.document, ''::text))
                        ELSE regexp_replace(COALESCE(k.document, ''::text), '\D'::text, ''::text, 'g'::text)
                    END) = ANY (ARRAY[11, 14]) THEN
                    CASE
                        WHEN COALESCE(k.document, ''::text) ~ '[A-Za-z]'::text THEN normalizar_documento(COALESCE(k.document, ''::text))
                        ELSE regexp_replace(COALESCE(k.document, ''::text), '\D'::text, ''::text, 'g'::text)
                    END
                    WHEN length(
                    CASE
                        WHEN COALESCE(k.cnpj, ''::text) ~ '[A-Za-z]'::text THEN normalizar_documento(COALESCE(k.cnpj, ''::text))
                        ELSE regexp_replace(COALESCE(k.cnpj, ''::text), '\D'::text, ''::text, 'g'::text)
                    END) = ANY (ARRAY[11, 14]) THEN
                    CASE
                        WHEN COALESCE(k.cnpj, ''::text) ~ '[A-Za-z]'::text THEN normalizar_documento(COALESCE(k.cnpj, ''::text))
                        ELSE regexp_replace(COALESCE(k.cnpj, ''::text), '\D'::text, ''::text, 'g'::text)
                    END
                    ELSE NULL::text
                END AS documento
           FROM profiles p
             JOIN private.v_perfil_chaves_internas k ON k.user_id = p.user_id
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
        ), contas_ativas AS MATERIALIZED (
         SELECT ativ.documento,
            COALESCE(array_agg(ativ.account) FILTER (WHERE ativ.ativo_6m), ARRAY[]::text[]) AS contas
           FROM ativ
          GROUP BY ativ.documento
        ), grupo AS MATERIALIZED (
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
        ), fam_grupo AS MATERIALIZED (
         SELECT s.documento,
            array_agg(DISTINCT op.familia) FILTER (WHERE op.familia IS NOT NULL AND op.familia <> ''::text) AS familias
           FROM so_ok s
             JOIN oi_dedup d ON d.sales_order_id = s.id
             JOIN omie_products op ON op.id = d.product_id AND op.account = s.account
          GROUP BY s.documento
        ), cid AS MATERIALIZED (
         SELECT DISTINCT ON (addresses.user_id) addresses.user_id,
            (addresses.city || '-'::text) || addresses.state AS cidade_uf
           FROM addresses
          WHERE COALESCE(addresses.city, ''::text) <> ''::text AND COALESCE(addresses.state, ''::text) <> ''::text
          ORDER BY addresses.user_id, addresses.is_default DESC NULLS LAST, addresses.created_at DESC NULLS LAST
        ), optout_doc AS MATERIALIZED (
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
        ), cand AS MATERIALIZED (
         SELECT cd.documento,
            a.empresa_alvo,
            cd.user_id,
            cd.name,
            cd.phone,
            cd.cnae,
            EXISTS ( SELECT 1
                   FROM unnest(COALESCE(ca.contas, ARRAY[]::text[])) c(conta)
                  WHERE c.conta <> a.empresa_alvo) AS compra_em_outra_empresa
           FROM cli_doc cd
             CROSS JOIN alvos a
             LEFT JOIN contas_ativas ca ON ca.documento = cd.documento
          WHERE NOT (a.empresa_alvo = ANY (COALESCE(ca.contas, ARRAY[]::text[]))) AND NOT (EXISTS ( SELECT 1
                   FROM optout_doc oo
                  WHERE oo.documento = cd.documento))
        ), contato AS MATERIALIZED (
         SELECT vpc_1.user_id,
            vpc_1.phone,
            vpc_1.contato_visivel
           FROM v_perfil_contato vpc_1
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
    cand.compra_em_outra_empresa,
        CASE
            WHEN g.ultima_grupo IS NOT NULL THEN (now() AT TIME ZONE 'America/Sao_Paulo'::text)::date - g.ultima_grupo
            ELSE NULL::integer
        END AS ultima_compra_grupo_dias,
    cand.name AS nome,
    vpc.phone AS telefone,
    cand.user_id AS cliente_user_id,
    COALESCE(vpc.contato_visivel, false) AS contato_visivel
   FROM cand
     LEFT JOIN contato vpc ON vpc.user_id = cand.user_id
     LEFT JOIN grupo g ON g.documento = cand.documento
     LEFT JOIN fam_grupo fg ON fg.documento = cand.documento
     LEFT JOIN cid ON cid.user_id = cand.user_id;

DO $m$
DECLARE
  u  uuid;
  n1 bigint; d1 text; n2 bigint; d2 text;
BEGIN
  FOREACH u IN ARRAY ARRAY['700657a1-d75d-4c72-99b1-0a0f2065fa29', '414a9727-ad1d-4998-914e-9c6ccf26cf50']::uuid[] LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', u::text, true);
    SELECT count(*), md5(string_agg(z::text, '|' ORDER BY z.documento, z.empresa_alvo)) INTO n1, d1
      FROM (SELECT documento, empresa_alvo, cidade_uf, ramo, ticket_faixa, familias, compra_em_outra_empresa, ultima_compra_grupo_dias, nome, telefone, cliente_user_id, contato_visivel FROM public.v_caca_candidatos) z;
    SELECT count(*), md5(string_agg(z::text, '|' ORDER BY z.documento, z.empresa_alvo)) INTO n2, d2
      FROM (SELECT documento, empresa_alvo, cidade_uf, ramo, ticket_faixa, familias, compra_em_outra_empresa, ultima_compra_grupo_dias, nome, telefone, cliente_user_id, contato_visivel FROM pg_temp.caca_cand_novo) z;
    RAISE NOTICE 'MED persona=% antiga n=% md5=% | nova n=% md5=% | igual=%', u, n1, d1, n2, d2, (n1 = n2 AND d1 = d2);
    IF NOT (n1 = n2 AND d1 = d2) THEN
      RAISE EXCEPTION 'EQUIVALENCIA QUEBRADA persona=%', u;
    END IF;
  END LOOP;
END
$m$;
