-- ============================================================================================
-- Grupos de clientes / Caça aceitam CNPJ ALFANUMÉRICO — follow-up 3 do #3180
-- (docs/historico/radar-cnpj-alfanumerico-escritores.md · docs/historico/front-cnpj-alfanumerico.md)
-- ATENÇÃO: migration custom — Lovable NÃO aplica sozinha. Aplicar no SQL Editor (BEGIN … COMMIT abaixo).
-- Prova PG17: db/test-grupos-caca-cnpj-alfanumerico.sh (controle + --falsificar).
--
-- O buraco: `cliente_grupo_membros.documento` tinha CHECK só-dígitos (11|14) e as 6 views de grupo/Caça
-- casavam o documento do cliente por `regexp_replace(x, '\D', '', 'g')` — o CNPJ alfanumérico da RFB
-- (jul/2026: 12 posições [0-9A-Z] + 2 DVs; ex. oficial 12.ABC.345/01DE-35) não entrava em grupo e, na Caça,
-- virava NULL (sumia). Acervo medido em prod 2026-10-20 (psql-ro): 0 membros; 0 documentos com letra em
-- profiles (5.668) e em fin_contas_receber (45.326) — preventivo, nada a migrar.
--
-- O que muda (molde TRAVA → PRE → CREATE → PÓS; idempotente; transação única):
--  1. ACL: `cnpj_alfanumerico_valido(text)` e `normalizar_documento(text)` (#3195, puras, sem dado) ganham
--     EXECUTE para anon e authenticated. Sem isso o CHECK (roda como quem INSERE) e as 6 views
--     (security_invoker ligado, SELECT concedido a anon/authenticated) falham com 42501 para o staff —
--     medido: até a role read-only recebe "permission denied for function normalizar_documento".
--  2. CHECK `cliente_grupo_membros_documento_digits` → `cliente_grupo_membros_documento_formato`:
--     `^[0-9]{11}$` | `^[0-9]{14}$` | `cnpj_alfanumerico_valido(documento)` (formato + DV mod-11).
--     Minúscula, máscara, DV errado, 10 dígitos → 23514 (fail-closed; quem normaliza é o front, para
--     MAIÚSCULA, antes de validar). Numérico: byte-idêntico ao de sempre.
--  3. Nas 6 views, SÓ a expressão do DOCUMENTO (as de telefone ficam) troca `regexp_replace(x,'\D','','g')` por
--     `CASE WHEN x ~ '[A-Za-z]' THEN public.normalizar_documento(x) ELSE regexp_replace(x,'\D','','g') END`.
--     Semântica ≡ normalizar_documento(x) (sem letra a função cai no MESMO regexp_replace; NULL → NULL), mas o
--     numérico — 100% do acervo — não paga a chamada: a função tem SET search_path e NÃO inlina (medido PG17,
--     50k linhas: regexp 152 ms · normalizar_documento 1.125 ms · guard ~regexp). Alfanumérico VÁLIDO vira a
--     chave de 14 chars — e, na Caça, passa pelo `length IN (11,14)` em vez de virar NULL. Colunas/tipos/ordem inalterados;
--     `WITH (security_invoker = …)` repetido com o LITERAL vivo de cada view ('true' nas v_grupo_*, 'on' nas
--     v_caca_* — database.md §4: omitir reseta a opção e a view passa a ler como OWNER).
-- ============================================================================================
BEGIN;

-- ── TRAVA: ALTER sem efeito em cada objeto que a PRE guarda e este arquivo recria (lock antes de ler) ──
DO $trava$
BEGIN
  IF to_regprocedure('public.cnpj_alfanumerico_valido(text)') IS NULL
     OR to_regprocedure('public.normalizar_documento(text)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: helpers do #3195 ausentes — aplique 20261019140000_omie_identidade_cnpj_alfanumerico ANTES';
  END IF;
  ALTER FUNCTION public.cnpj_alfanumerico_valido(text) IMMUTABLE;
  ALTER FUNCTION public.normalizar_documento(text) IMMUTABLE;
  ALTER VIEW public.v_grupo_comercial              SET (security_invoker = true);
  ALTER VIEW public.v_grupo_contatos               SET (security_invoker = true);
  ALTER VIEW public.v_grupo_contas_receber         SET (security_invoker = true);
  ALTER VIEW public.v_grupo_contas_receber_por_doc SET (security_invoker = true);
  ALTER VIEW public.v_caca_compradores             SET (security_invoker = on);
  ALTER VIEW public.v_caca_candidatos              SET (security_invoker = on);
END
$trava$;

-- Foto do que NÃO pode mudar (reloptions e ACL das views) — a PÓS compara.
CREATE TEMP TABLE IF NOT EXISTS foto_views_alnum ON COMMIT DROP AS
  SELECT c.relname, c.reloptions, c.relacl
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname IN ('v_grupo_comercial','v_grupo_contatos','v_grupo_contas_receber',
         'v_grupo_contas_receber_por_doc','v_caca_compradores','v_caca_candidatos');

-- ── PRE: md5 EXATO do vivo ∈ {predecessor medido na prod 2026-10-20, este}. Deriva ABORTA. ──
DO $pre$
DECLARE r record; v_md5 text; v_def text;
BEGIN
  PERFORM pg_catalog.set_config('search_path', 'public, pg_catalog', true);   -- a deparse qualifica pelo search_path
  -- helpers do #3195: NÃO são recriados aqui — só o corpo da prod é aceito
  FOR r IN SELECT * FROM (VALUES
      ('public.cnpj_alfanumerico_valido(text)', 'b27b482a550084775b12ef78f03e29c4'),
      ('public.normalizar_documento(text)',     'b7659502c90df3ff483c576cf56d559d')) AS t(alvo, prod)
  LOOP
    SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(r.alvo);
    IF v_md5 IS DISTINCT FROM r.prod THEN
      RAISE EXCEPTION 'PRE FALHOU: % deriva — md5(prosrc)=% não é o medido na prod (%)', r.alvo, v_md5, r.prod;
    END IF;
  END LOOP;
  -- as 6 views: predecessor (prod) ou este corpo
  FOR r IN SELECT * FROM (VALUES
      ('public.v_grupo_comercial',              '636aee1851fb145c2da6084e681bbdbf', '6f7ca81e8578ae758d1e117d1346dee4'),
      ('public.v_grupo_contatos',               'b1b75f0163b75f0906f56f9053374969', 'cfcc07e66652cca2ff350a0432cf3c74'),
      ('public.v_grupo_contas_receber',         'b05ddadaa94d946e3e84184cee2b97ed', 'fff28689737b15593d24f61974df6a5b'),
      ('public.v_grupo_contas_receber_por_doc', 'ab437b5db3d7f3f914c7d31c0783133f', '00f35408cf7c2e6758a516bdd131c832'),
      ('public.v_caca_compradores',             '8a5cb6e0b81e3b0024a9909d2d87b4ee', '39cd680853ae048fc27ae01f3d2065e4'),
      ('public.v_caca_candidatos',              'f7538335d873138f190f6c60a74b6ffa', '7f5571bfdbfd6c05c26699a9c689d545')) AS t(alvo, prod, este)
  LOOP
    v_md5 := md5(pg_catalog.pg_get_viewdef(to_regclass(r.alvo), true));
    IF v_md5 IS DISTINCT FROM r.prod AND v_md5 IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'PRE FALHOU: % deriva — md5(viewdef)=% não é o predecessor (%) nem este corpo (%)', r.alvo, v_md5, r.prod, r.este;
    END IF;
  END LOOP;
  -- o CHECK vivo: o só-dígitos de 20260615120000 ou o deste arquivo
  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO v_def FROM pg_catalog.pg_constraint c
   WHERE c.conrelid = 'public.cliente_grupo_membros'::regclass AND c.contype = 'c'
     AND c.conname IN ('cliente_grupo_membros_documento_digits', 'cliente_grupo_membros_documento_formato');
  IF v_def IS DISTINCT FROM 'CHECK (((documento ~ ''^[0-9]+$''::text) AND (char_length(documento) = ANY (ARRAY[11, 14]))))'
     AND v_def IS DISTINCT FROM 'CHECK (((documento ~ ''^[0-9]{11}$''::text) OR (documento ~ ''^[0-9]{14}$''::text) OR cnpj_alfanumerico_valido(documento)))' THEN
    RAISE EXCEPTION 'PRE FALHOU: CHECK de cliente_grupo_membros.documento deriva — vivo: %', v_def;
  END IF;
END
$pre$;

-- ── 1. ACL: funções puras (sem dado) executáveis por quem insere no CHECK e por quem lê as views ──
GRANT EXECUTE ON FUNCTION public.cnpj_alfanumerico_valido(text), public.normalizar_documento(text)
  TO anon, authenticated;
-- claude_ro (diagnóstico read-only, só em prod — no harness não existe): sem EXECUTE ele deixa de ler as 6 views
-- (medido na atestação de 2026-10-20: "permission denied for function normalizar_documento" ao SELECT da view).
DO $ro$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'claude_ro') THEN
    GRANT EXECUTE ON FUNCTION public.cnpj_alfanumerico_valido(text), public.normalizar_documento(text) TO claude_ro;
  END IF;
END
$ro$;

-- ── 2. CHECK: só-dígitos (11|14) OU CNPJ alfanumérico válido (formato + DV). Recriado só se divergir. ──
DO $chk$
DECLARE v_def text;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO v_def FROM pg_catalog.pg_constraint c
   WHERE c.conrelid = 'public.cliente_grupo_membros'::regclass AND c.conname = 'cliente_grupo_membros_documento_formato';
  IF v_def IS DISTINCT FROM 'CHECK (((documento ~ ''^[0-9]{11}$''::text) OR (documento ~ ''^[0-9]{14}$''::text) OR cnpj_alfanumerico_valido(documento)))' THEN
    ALTER TABLE public.cliente_grupo_membros DROP CONSTRAINT IF EXISTS cliente_grupo_membros_documento_digits;
    ALTER TABLE public.cliente_grupo_membros DROP CONSTRAINT IF EXISTS cliente_grupo_membros_documento_formato;
    ALTER TABLE public.cliente_grupo_membros ADD CONSTRAINT cliente_grupo_membros_documento_formato
      CHECK (documento ~ '^[0-9]{11}$' OR documento ~ '^[0-9]{14}$' OR public.cnpj_alfanumerico_valido(documento));
  END IF;
END
$chk$;
COMMENT ON CONSTRAINT cliente_grupo_membros_documento_formato ON public.cliente_grupo_membros IS
  'CPF (11 dígitos) | CNPJ numérico (14 dígitos) | CNPJ alfanumérico RFB válido (12 [0-9A-Z] + 2 DVs mod-11, MAIÚSCULO). 20261020130000.';
COMMENT ON COLUMN public.cliente_grupo_membros.documento IS
  'Chave de documento: só-dígitos (CPF 11 / CNPJ 14) ou CNPJ alfanumérico válido em maiúsculas (14 chars). Casa com normalizar_documento() das views.';

-- ── 3. As 6 views: só a expressão do DOCUMENTO muda; corpo = pg_get_viewdef da prod com a troca ──
CREATE OR REPLACE VIEW public.v_grupo_comercial WITH (security_invoker = true) AS
 WITH ped AS (
         SELECT CASE WHEN COALESCE(p.cnpj, p.document, ''::text) ~ '[A-Za-z]'::text THEN public.normalizar_documento(COALESCE(p.cnpj, p.document, ''::text)) ELSE regexp_replace(COALESCE(p.cnpj, p.document, ''::text), '\D'::text, ''::text, 'g'::text) END AS doc,
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
     JOIN profiles p ON CASE WHEN COALESCE(p.cnpj, p.document, ''::text) ~ '[A-Za-z]'::text THEN public.normalizar_documento(COALESCE(p.cnpj, p.document, ''::text)) ELSE regexp_replace(COALESCE(p.cnpj, p.document, ''::text), '\D'::text, ''::text, 'g'::text) END = m.documento
     LEFT JOIN addresses a ON a.user_id = p.user_id AND a.is_default = true
     LEFT JOIN omie_customer_account_map_fresco oc ON oc.user_id = p.user_id AND oc.account = 'oben'::text;

CREATE OR REPLACE VIEW public.v_grupo_contas_receber WITH (security_invoker = true) AS
 WITH tit AS (
         SELECT CASE WHEN fcr.cnpj_cpf ~ '[A-Za-z]'::text THEN public.normalizar_documento(fcr.cnpj_cpf) ELSE regexp_replace(fcr.cnpj_cpf, '\D'::text, ''::text, 'g'::text) END AS doc,
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

CREATE OR REPLACE VIEW public.v_grupo_contas_receber_por_doc WITH (security_invoker = true) AS
 WITH tit AS (
         SELECT CASE WHEN fcr.cnpj_cpf ~ '[A-Za-z]'::text THEN public.normalizar_documento(fcr.cnpj_cpf) ELSE regexp_replace(fcr.cnpj_cpf, '\D'::text, ''::text, 'g'::text) END AS doc,
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

CREATE OR REPLACE VIEW public.v_caca_compradores WITH (security_invoker = on) AS
 WITH cli AS (
         SELECT p.user_id,
            p.name,
            p.phone,
            p.cnae,
                CASE
                    WHEN length(CASE WHEN COALESCE(p.document, ''::text) ~ '[A-Za-z]'::text THEN public.normalizar_documento(COALESCE(p.document, ''::text)) ELSE regexp_replace(COALESCE(p.document, ''::text), '\D'::text, ''::text, 'g'::text) END) = ANY (ARRAY[11, 14]) THEN CASE WHEN COALESCE(p.document, ''::text) ~ '[A-Za-z]'::text THEN public.normalizar_documento(COALESCE(p.document, ''::text)) ELSE regexp_replace(COALESCE(p.document, ''::text), '\D'::text, ''::text, 'g'::text) END
                    WHEN length(CASE WHEN COALESCE(p.cnpj, ''::text) ~ '[A-Za-z]'::text THEN public.normalizar_documento(COALESCE(p.cnpj, ''::text)) ELSE regexp_replace(COALESCE(p.cnpj, ''::text), '\D'::text, ''::text, 'g'::text) END) = ANY (ARRAY[11, 14]) THEN CASE WHEN COALESCE(p.cnpj, ''::text) ~ '[A-Za-z]'::text THEN public.normalizar_documento(COALESCE(p.cnpj, ''::text)) ELSE regexp_replace(COALESCE(p.cnpj, ''::text), '\D'::text, ''::text, 'g'::text) END
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

CREATE OR REPLACE VIEW public.v_caca_candidatos WITH (security_invoker = on) AS
 WITH cli AS (
         SELECT p.user_id,
            p.name,
            p.phone,
            p.cnae,
                CASE
                    WHEN length(CASE WHEN COALESCE(p.document, ''::text) ~ '[A-Za-z]'::text THEN public.normalizar_documento(COALESCE(p.document, ''::text)) ELSE regexp_replace(COALESCE(p.document, ''::text), '\D'::text, ''::text, 'g'::text) END) = ANY (ARRAY[11, 14]) THEN CASE WHEN COALESCE(p.document, ''::text) ~ '[A-Za-z]'::text THEN public.normalizar_documento(COALESCE(p.document, ''::text)) ELSE regexp_replace(COALESCE(p.document, ''::text), '\D'::text, ''::text, 'g'::text) END
                    WHEN length(CASE WHEN COALESCE(p.cnpj, ''::text) ~ '[A-Za-z]'::text THEN public.normalizar_documento(COALESCE(p.cnpj, ''::text)) ELSE regexp_replace(COALESCE(p.cnpj, ''::text), '\D'::text, ''::text, 'g'::text) END) = ANY (ARRAY[11, 14]) THEN CASE WHEN COALESCE(p.cnpj, ''::text) ~ '[A-Za-z]'::text THEN public.normalizar_documento(COALESCE(p.cnpj, ''::text)) ELSE regexp_replace(COALESCE(p.cnpj, ''::text), '\D'::text, ''::text, 'g'::text) END
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

-- ── PÓS: o estado vivo é ESTE — executando, não só no catálogo. ──
DO $post$
DECLARE r record; v_md5 text; v_def text; v_grupo uuid;
BEGIN
  PERFORM pg_catalog.set_config('search_path', 'public, pg_catalog', true);
  -- helpers EXECUTANDO e abertos a quem precisa
  IF NOT public.cnpj_alfanumerico_valido('12ABC34501DE35') OR public.cnpj_alfanumerico_valido('12ABC34501DE36')
     OR public.cnpj_alfanumerico_valido('12abc34501de35') THEN
    RAISE EXCEPTION 'PÓS FALHOU: cnpj_alfanumerico_valido não discrimina o exemplo oficial da RFB / DV errado / minúscula';
  END IF;
  IF public.normalizar_documento('12.345.678/0001-90') <> '12345678000190' OR public.normalizar_documento('12.abc.345/01de-35') <> '12ABC34501DE35' THEN
    RAISE EXCEPTION 'PÓS FALHOU: normalizar_documento não produz a chave esperada';
  END IF;
  FOR r IN SELECT unnest(ARRAY['anon','authenticated','service_role']) AS papel
           UNION ALL SELECT rolname FROM pg_catalog.pg_roles WHERE rolname = 'claude_ro' LOOP
    IF NOT has_function_privilege(r.papel, 'public.cnpj_alfanumerico_valido(text)', 'EXECUTE')
       OR NOT has_function_privilege(r.papel, 'public.normalizar_documento(text)', 'EXECUTE') THEN
      RAISE EXCEPTION 'PÓS FALHOU: % sem EXECUTE nos helpers — o CHECK/as views falhariam com 42501', r.papel;
    END IF;
  END LOOP;
  -- CHECK vivo, validado, e o antigo fora
  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO v_def FROM pg_catalog.pg_constraint c
   WHERE c.conrelid = 'public.cliente_grupo_membros'::regclass AND c.conname = 'cliente_grupo_membros_documento_formato' AND c.convalidated;
  IF v_def IS DISTINCT FROM 'CHECK (((documento ~ ''^[0-9]{11}$''::text) OR (documento ~ ''^[0-9]{14}$''::text) OR cnpj_alfanumerico_valido(documento)))' THEN
    RAISE EXCEPTION 'PÓS FALHOU: CHECK cliente_grupo_membros_documento_formato ausente/diferente — vivo: %', v_def;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.cliente_grupo_membros'::regclass AND conname = 'cliente_grupo_membros_documento_digits') THEN
    RAISE EXCEPTION 'PÓS FALHOU: o CHECK só-dígitos antigo continua vivo — alfanumérico seguiria barrado';
  END IF;
  -- CHECK EXECUTANDO: alfanumérico válido entra, DV errado cai em 23514 — tudo numa subtransação desfeita.
  -- Só o alfanumérico (o numérico é regex, provado no harness); se o exemplo já for membro real, o 23505
  -- também prova que o CHECK o aceitou (re-aplicar com membro alfanumérico presente não pode falhar).
  BEGIN
    INSERT INTO public.cliente_grupos (nome) VALUES ('__pos_20261020130000__') RETURNING id INTO v_grupo;
    BEGIN
      INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES (v_grupo, '12ABC34501DE35');
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES (v_grupo, '12ABC34501DE36');
      RAISE EXCEPTION 'PÓS FALHOU: DV errado (12ABC34501DE36) ENTROU em cliente_grupo_membros' USING ERRCODE = 'P0A01';
    EXCEPTION WHEN check_violation THEN NULL;   -- 23514 é o esperado; o resto (inclusive P0A01) sobe
    END;
    RAISE EXCEPTION 'smoke ok' USING ERRCODE = 'P0A00';   -- desfaz os INSERTs de smoke
  EXCEPTION WHEN SQLSTATE 'P0A00' THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.cliente_grupos WHERE nome = '__pos_20261020130000__') THEN
    RAISE EXCEPTION 'PÓS FALHOU: o smoke não foi desfeito';
  END IF;
  -- as 6 views: corpo = este; reloptions e ACL = foto
  FOR r IN SELECT * FROM (VALUES
      ('v_grupo_comercial',              '6f7ca81e8578ae758d1e117d1346dee4'),
      ('v_grupo_contatos',               'cfcc07e66652cca2ff350a0432cf3c74'),
      ('v_grupo_contas_receber',         'fff28689737b15593d24f61974df6a5b'),
      ('v_grupo_contas_receber_por_doc', '00f35408cf7c2e6758a516bdd131c832'),
      ('v_caca_compradores',             '39cd680853ae048fc27ae01f3d2065e4'),
      ('v_caca_candidatos',              '7f5571bfdbfd6c05c26699a9c689d545')) AS t(alvo, este)
  LOOP
    v_md5 := md5(pg_catalog.pg_get_viewdef(to_regclass('public.' || r.alvo), true));
    IF v_md5 IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'PÓS FALHOU: % — md5(viewdef)=% ≠ este (%)', r.alvo, v_md5, r.este;
    END IF;
    IF pg_catalog.pg_get_viewdef(to_regclass('public.' || r.alvo), true) !~ 'normalizar_documento\(' THEN
      RAISE EXCEPTION 'PÓS FALHOU: % não chama normalizar_documento', r.alvo;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN foto_views_alnum f ON f.relname = c.relname
                    WHERE c.relname = r.alvo AND c.reloptions IS NOT DISTINCT FROM f.reloptions AND c.relacl IS NOT DISTINCT FROM f.relacl) THEN
      RAISE EXCEPTION 'PÓS FALHOU: % mudou reloptions/ACL (security_invoker ou grants) — não era para mudar', r.alvo;
    END IF;
  END LOOP;
  RAISE NOTICE 'OK 20261020130000: ACL aberto, CHECK alfanumérico validado e executado, 6 views normalizando com normalizar_documento()';
END
$post$;

COMMIT;
