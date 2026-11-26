-- ============================================================================================
-- Caça — v_caca_candidatos: o planejador re-executava agregados POR CANDIDATO (mesmas linhas).
--
-- SINTOMA: a página de candidatos da Caça (useCaca → v_caca_candidatos, ~31,8k linhas, 32 páginas
-- sequenciais de 1.000) não carregava; a view inteira passava de 300 s no ensaio da onda D.
--
-- CAUSA (plano da prod, farmer sob `authenticated`, 2026-11-26):
--   * o anti-join `cli_doc × alvos` contra `ativ` era estimado em rows=1 (DISTINCT ON sobre CTE
--     vira 200 grupos por default e o planejador supõe que `ativ` cobre todos);
--   * com "1 linha" do lado de fora, `fam_grupo` (GroupAggregate sobre 74k order_items) e a
--     `v_perfil_contato` (16k profiles + SubPlans) entravam como lado INTERNO de Nested Loop —
--     recalculados para cada um dos ~31,8k candidatos. Real: > 1 min só a 1ª página.
--   * como dono das tabelas (sem RLS de tabela) o mesmo formato custava 0,4 s — por isso o
--     envelope e o claude_ro não reproduziam; a medição tem que ser sob `authenticated`.
--
-- CORREÇÃO (mesma semântica, só o encanamento):
--   1. atividade por documento vira array `contas_ativas` (contas com compra nos últimos 6 meses):
--      o filtro "ativo na empresa-alvo" e o `compra_em_outra_empresa` leem o array — some o
--      anti-join que colapsava a estimativa;
--   2. `grupo`, `fam_grupo`, `cid`, `optout_doc`, `cand` e o contato (v_perfil_contato) viram
--      CTEs MATERIALIZED: cada um é calculado UMA vez, nunca re-agregado por linha.
--   Medido (prod, farmer 700657a1…, authenticated, ROLLBACK): 1ª página 869 ms, todos hash joins.
--   Equivalência: md5 linha a linha da view antiga = corpo novo (db/medir-caca-candidatos-equivalencia.sql).
--
-- Mesmas colunas, mesma ordem, mesmos tipos (CREATE OR REPLACE preserva o ACL).
-- `security_invoker = on` REPETIDO (omitir resetaria e a view leria como OWNER, furando a RLS).
-- Pré-flight: corpo base = pg_get_viewdef da PROD em 2026-11-26 (== fatia 3, 20261125120000).
-- ============================================================================================

CREATE OR REPLACE VIEW public.v_caca_candidatos
WITH (security_invoker = on) AS
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

REVOKE ALL ON public.v_caca_candidatos FROM anon;

-- ───────────────────────── postcondição ─────────────────────────
DO $post$
DECLARE
  v_def text := pg_get_viewdef('public.v_caca_candidatos'::regclass);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.v_caca_candidatos'::regclass
                  AND array_to_string(c.reloptions, ',') ~ 'security_invoker=(on|true)') THEN
    RAISE EXCEPTION 'postcondicao: v_caca_candidatos perdeu security_invoker';
  END IF;
  IF has_table_privilege('anon', 'public.v_caca_candidatos', 'SELECT') THEN
    RAISE EXCEPTION 'postcondicao: anon le v_caca_candidatos';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.v_caca_candidatos', 'SELECT') THEN
    RAISE EXCEPTION 'postcondicao: authenticated perdeu SELECT em v_caca_candidatos';
  END IF;
  IF position('contas_ativas AS MATERIALIZED' IN v_def) = 0
     OR position('fam_grupo AS MATERIALIZED' IN v_def) = 0
     OR position('contato AS MATERIALIZED' IN v_def) = 0
     OR position('v_perfil_contato' IN v_def) = 0 THEN
    RAISE EXCEPTION 'postcondicao: corpo novo da v_caca_candidatos ausente';
  END IF;
END
$post$;
