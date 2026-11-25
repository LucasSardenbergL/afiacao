CREATE FUNCTION pg_temp.ms(q text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE t0 timestamptz; h text;
BEGIN t0 := clock_timestamp(); EXECUTE 'SELECT md5(coalesce(string_agg(t::text, '''' ), '''')) FROM (' || q || ') t' INTO h;
RETURN round(extract(epoch FROM clock_timestamp() - t0) * 1000)::text || 'ms'; END $f$;
-- Onda D da tela Clientes — fatia 3a: os leitores de SERVIDOR saem de profiles.email/phone/document/cnpj
-- ANTES do corte. Spec: docs/superpowers/specs/2026-11-24-clientes-pii-por-carteira-design.md.
--
-- Por que existe: a fatia 3b (20261125130000) troca o SELECT de tabela em profiles por GRANT de COLUNA
-- sem as 4 colunas de contato. Objeto INVOKER que cita essas colunas quebra com 42501 mesmo que o
-- chamador nem as selecione. Os 6 objetos abaixo (pg_depend + prosrc em prod, 2026-11-25) migram aqui,
-- e esta migration é SEGURA antes do corte (não muda o que cada leitor recebe, exceto o mascaramento
-- decidido):
--
--   private.v_perfil_chaves_internas — documento/cnpj/telefone CRUS só como CHAVE DE JOIN para as views
--                                      invoker. Schema private (fora do PostgREST). Fronteira de linha =
--                                      a RLS de profiles (self OU staff) + service_role (edge de custo lê
--                                      v_caca_compradores com service_role: sem este ramo, zero linhas EM
--                                      SILÊNCIO no money-path). `current_user` numa view invoker=off é o
--                                      do CHAMADOR (só o acesso às tabelas é do owner).
--   public.v_perfil_equipe           — diretório de equipe (founder 2026-11-25: "qualquer staff"): nome e
--                                      e-mail de quem é staff, para leitor staff. Documento/telefone do
--                                      colega ficam fora.
--   public.cliente_por_documento     — documento → user_id (IDENTIDADE) para staff; substitui os 3
--                                      `.or(document.eq…)` do front (novo pedido, busca Omie, ligações).
--   public.v_caca_candidatos/_compradores, v_grupo_comercial, v_grupo_contatos — mesmas colunas; chave
--                                      fiscal pela view interna; telefone/e-mail PROJETADOS pela
--                                      v_perfil_contato (mascarado fora da carteira — founder 2026-11-25:
--                                      "Mascarar telefone" na Caça). `contato_visivel` acrescentada no FIM.
--                                      O documento segue projetado na Caça: é a chave da fila (decisão).
--   public.listar_clientes_base      — e-mail/telefone/documento e a BUSCA por eles pela v_perfil_contato
--                                      (termo que só casa no contato oculto responde igual a termo ausente).
--   public.resolver_cliente_por_telefone — SECURITY DEFINER + gate de staff explícito (era a RLS);
--                                      devolve identidade, nunca o contato (decisão da spec, telefonia).
--
-- Corpos partem do pg_get_viewdef/pg_get_functiondef de PROD (psql-ro, 2026-11-25), não do repo.
-- Todo CREATE OR REPLACE VIEW repete o WITH (security_invoker…) — omitir RESETA a opção.
-- Aplicação: bun run db:aplicar (o EXECUTOR fornece a transação — este arquivo não leva BEGIN/COMMIT).

-- ───────────────────────── chave fiscal interna (private) ─────────────────────────
CREATE OR REPLACE VIEW private.v_perfil_chaves_internas
WITH (security_invoker = off, security_barrier = true) AS
WITH ctx AS (
  SELECT (SELECT auth.uid()) AS uid,
         (current_user = 'service_role') AS servico,
         (COALESCE(public.has_role((SELECT auth.uid()), 'employee'::public.app_role), false)
          OR COALESCE(public.has_role((SELECT auth.uid()), 'master'::public.app_role), false)) AS staff
)
SELECT p.user_id, p.document, p.cnpj, p.phone
  FROM public.profiles p
 CROSS JOIN ctx
 WHERE ctx.servico
    OR (ctx.uid IS NOT NULL AND (p.user_id = ctx.uid OR ctx.staff));

REVOKE ALL ON private.v_perfil_chaves_internas FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON private.v_perfil_chaves_internas TO authenticated, service_role;

-- ───────────────────────── diretório de equipe ─────────────────────────
-- Alvo staff = papel employee/master OU a flag is_employee (GovernanceUsers lista pela flag).
CREATE OR REPLACE VIEW public.v_perfil_equipe
WITH (security_invoker = off, security_barrier = true) AS
WITH ctx AS (
  SELECT (COALESCE(public.has_role((SELECT auth.uid()), 'employee'::public.app_role), false)
          OR COALESCE(public.has_role((SELECT auth.uid()), 'master'::public.app_role), false)) AS staff
)
SELECT p.user_id, p.name, p.email, p.is_employee, p.is_approved
  FROM public.profiles p
 CROSS JOIN ctx
 WHERE ctx.staff
   AND p.user_id IS NOT NULL
   AND (COALESCE(p.is_employee, false)
        OR p.user_id IN (SELECT r.user_id FROM public.user_roles r
                          WHERE r.user_id IS NOT NULL
                            AND r.role IN ('employee'::public.app_role, 'master'::public.app_role)));

REVOKE ALL ON public.v_perfil_equipe FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.v_perfil_equipe TO authenticated, service_role;

-- ───────────────────────── documento → identidade ─────────────────────────
-- Mesma semântica dos `.or(document.eq.<limpo>,document.eq.<cru>).limit(1)` do front, com ordem
-- estável (o front pegava "o primeiro" sem ORDER BY). Teto de 4 variantes. Só staff.
CREATE OR REPLACE FUNCTION public.cliente_por_documento(p_documentos text[])
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_docs text[];
  v_uid  uuid;
BEGIN
  IF NOT (COALESCE(public.has_role(auth.uid(), 'employee'::public.app_role), false)
          OR COALESCE(public.has_role(auth.uid(), 'master'::public.app_role), false)) THEN
    RAISE EXCEPTION 'cliente_por_documento: so staff' USING ERRCODE = '42501';
  END IF;
  IF p_documentos IS NULL OR cardinality(p_documentos) > 4 THEN
    RAISE EXCEPTION 'cliente_por_documento: de 1 a 4 variantes' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT btrim(d)) INTO v_docs
    FROM unnest(p_documentos) d
   WHERE nullif(btrim(d), '') IS NOT NULL;
  IF v_docs IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT p.user_id INTO v_uid
    FROM public.profiles p
   WHERE p.document = ANY (v_docs)
     AND p.user_id IS NOT NULL
   ORDER BY p.created_at NULLS LAST, p.user_id
   LIMIT 1;
  RETURN v_uid;
END
$function$;

REVOKE ALL ON FUNCTION public.cliente_por_documento(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cliente_por_documento(text[]) TO authenticated, service_role;

-- ───────────────────────── views invoker de Caça e Grupo ─────────────────────────
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
    vpc.phone AS telefone,
    cand.user_id AS cliente_user_id,
    COALESCE(vpc.contato_visivel, false) AS contato_visivel
   FROM cand
     LEFT JOIN public.v_perfil_contato vpc ON vpc.user_id = cand.user_id
     LEFT JOIN grupo g ON g.documento = cand.documento
     LEFT JOIN fam_grupo fg ON fg.documento = cand.documento
     LEFT JOIN cid ON cid.user_id = cand.user_id;

REVOKE ALL ON public.v_caca_candidatos FROM anon;

CREATE OR REPLACE VIEW public.v_caca_compradores
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

REVOKE ALL ON public.v_caca_compradores FROM anon;

CREATE OR REPLACE VIEW public.v_grupo_comercial
WITH (security_invoker = true) AS
 WITH ped AS (
         SELECT
                CASE
                    WHEN COALESCE(k.cnpj, k.document, ''::text) ~ '[A-Za-z]'::text THEN normalizar_documento(COALESCE(k.cnpj, k.document, ''::text))
                    ELSE regexp_replace(COALESCE(k.cnpj, k.document, ''::text), '\D'::text, ''::text, 'g'::text)
                END AS doc,
            so.order_date_kpi AS data,
            COALESCE(so.total, ( SELECT sum(((it.value ->> 'quantity'::text)::numeric) * ((it.value ->> 'unit_price'::text)::numeric)) AS sum
                   FROM jsonb_array_elements(so.items) it(value))) AS valor
           FROM sales_orders so
             JOIN profiles p ON p.user_id = so.customer_user_id
             JOIN private.v_perfil_chaves_internas k ON k.user_id = p.user_id
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

REVOKE ALL ON public.v_grupo_comercial FROM anon;

CREATE OR REPLACE VIEW public.v_grupo_contatos
WITH (security_invoker = true) AS
 SELECT m.grupo_id,
    m.documento,
    p.user_id,
    COALESCE(p.razao_social, p.name) AS nome,
    vpc.phone,
    vpc.email,
    a.city AS cidade,
    a.state AS uf,
    NULLIF(TRIM(BOTH FROM (COALESCE(a.street, ''::text) || ' '::text) || COALESCE(a.number, ''::text)), ''::text) AS endereco,
    oc.omie_codigo_vendedor,
    oc.account AS empresa_omie,
    COALESCE(vpc.contato_visivel, false) AS contato_visivel
   FROM cliente_grupo_membros m
     JOIN (profiles p
             JOIN private.v_perfil_chaves_internas k ON k.user_id = p.user_id) ON
        CASE
            WHEN COALESCE(k.cnpj, k.document, ''::text) ~ '[A-Za-z]'::text THEN normalizar_documento(COALESCE(k.cnpj, k.document, ''::text))
            ELSE regexp_replace(COALESCE(k.cnpj, k.document, ''::text), '\D'::text, ''::text, 'g'::text)
        END = m.documento
     LEFT JOIN public.v_perfil_contato vpc ON vpc.user_id = p.user_id
     LEFT JOIN addresses a ON a.user_id = p.user_id AND a.is_default = true
     LEFT JOIN omie_customer_account_map_fresco oc ON oc.user_id = p.user_id AND oc.account = 'oben'::text;

REVOKE ALL ON public.v_grupo_contatos FROM anon;

-- ───────────────────────── RPCs ─────────────────────────
CREATE OR REPLACE FUNCTION public.listar_clientes_base(p_busca text DEFAULT NULL::text, p_saude text DEFAULT NULL::text, p_ordem text DEFAULT 'prioridade'::text, p_limite integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS TABLE(user_id uuid, name text, email text, phone text, document text, customer_type text, created_at timestamp with time zone, requires_po boolean, prioridade_ordenacao numeric, total bigint, nome_ordenacao text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_saude text := nullif(btrim(coalesce(p_saude, '')), '');
  v_busca text := nullif(btrim(coalesce(p_busca, '')), '');
BEGIN
  IF v_saude = 'all' THEN v_saude := NULL; END IF;
  IF v_saude IS NOT NULL
     AND v_saude NOT IN ('saudavel', 'estavel', 'atencao', 'critico', 'sem_historico') THEN
    RAISE EXCEPTION 'listar_clientes_base: p_saude invalido (%)', v_saude USING ERRCODE = '22023';
  END IF;
  IF p_ordem IS NULL OR p_ordem NOT IN ('prioridade', 'nome') THEN
    RAISE EXCEPTION 'listar_clientes_base: p_ordem invalido (%)', p_ordem USING ERRCODE = '22023';
  END IF;
  IF p_limite IS NULL OR p_limite < 1 OR p_limite > 500 THEN
    RAISE EXCEPTION 'listar_clientes_base: p_limite fora de 1..500 (%)', p_limite USING ERRCODE = '22023';
  END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'listar_clientes_base: p_offset negativo (%)', p_offset USING ERRCODE = '22023';
  END IF;

  -- Aliases próprios (uid/nome/…) no CTE: as colunas de saída do RETURNS TABLE são variáveis
  -- plpgsql e colidiriam com p.user_id/p.name (42702 só em RUNTIME — late-bound).
  RETURN QUERY
  WITH recorte AS (
    SELECT
      p.user_id AS uid, p.name AS nome, vpc.email AS mail, vpc.phone AS fone, vpc.document AS doc,
      p.customer_type AS tipo, p.created_at AS criado, p.requires_po AS exige_po,
      CASE WHEN s.sales_history_status = 'sem_historico' THEN NULL ELSE s.priority_score END AS prio,
      private.nome_ordenacao(p.name) AS nome_ord
    FROM public.profiles p
    LEFT JOIN public.farmer_client_scores s ON s.customer_user_id = p.user_id
    -- Onda D fatia 3: contato pela fonte MASCARADA (termo que só casa no contato oculto = termo ausente).
    LEFT JOIN public.v_perfil_contato vpc ON vpc.user_id = p.user_id
    WHERE p.is_employee = false
      -- v_busca decide se HÁ busca; o padrão escapado vem do helper (IMMUTABLE: avaliado 1x).
      -- Termo sem conteúdo útil → padrão NULL → ILIKE NULL → nenhuma linha (não "sem filtro").
      AND (v_busca IS NULL
           OR p.name     ILIKE private.padrao_like_contem(v_busca) ESCAPE '\'
           OR vpc.email    ILIKE private.padrao_like_contem(v_busca) ESCAPE '\'
           OR vpc.document ILIKE private.padrao_like_contem(v_busca) ESCAPE '\'
           OR vpc.phone    ILIKE private.padrao_like_contem(v_busca) ESCAPE '\')
      AND (v_saude IS NULL
           OR (v_saude = 'sem_historico' AND s.sales_history_status = 'sem_historico')
           OR (v_saude <> 'sem_historico'
               AND s.health_class = v_saude
               AND s.sales_history_status IS DISTINCT FROM 'sem_historico'))
  )
  -- prioridade_ordenacao = a chave de prioridade DESTA ordenação: NULL na ordem 'nome', para o
  -- `.order()` estável do cliente (mesmas chaves, por cima) não re-ordenar a página A–Z.
  -- nome_ordenacao = a chave de nome (normalizada), devolvida pelo mesmo motivo.
  SELECT r.uid, r.nome, r.mail, r.fone, r.doc, r.tipo, r.criado, r.exige_po,
         CASE WHEN p_ordem = 'prioridade' THEN r.prio END, count(*) OVER (), r.nome_ord
  FROM recorte r
  ORDER BY
    CASE WHEN p_ordem = 'prioridade' THEN r.prio END DESC NULLS LAST,
    r.nome_ord NULLS LAST,
    r.nome,
    r.uid
  LIMIT p_limite OFFSET p_offset;
END
$function$;

CREATE OR REPLACE FUNCTION public.resolver_cliente_por_telefone(p_telefone text)
 RETURNS TABLE(customer_user_id uuid, contato_nome text, contato_cargo text, fonte text, candidatos integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_sufixo     text := right(regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'), 8);
  v_ids        uuid[];
  v_fonte      text;
  v_na_carteira uuid[];
  v_escolhido  uuid;
BEGIN
  -- Onda D fatia 3: SECURITY DEFINER (o telefone do perfil sai do grant de coluna); a fronteira de
  -- LINHA que a RLS dava (staff lê tudo) vira este gate explícito. Devolve IDENTIDADE, nunca o contato.
  IF NOT (COALESCE(public.has_role(auth.uid(), 'employee'::public.app_role), false)
          OR COALESCE(public.has_role(auth.uid(), 'master'::public.app_role), false)) THEN
    RAISE EXCEPTION 'resolver_cliente_por_telefone: so staff' USING ERRCODE = '42501';
  END IF;
  IF length(v_sufixo) < 8 THEN
    RETURN;
  END IF;
  -- placeholder (00000000, 99999999…): não identifica ninguém — há 3 perfis assim em prod
  -- (2026-10-10). Casar por ele gravaria ligação de quem não é cliente.
  IF v_sufixo ~ '^(\d)\1{7}$' THEN
    RETURN;
  END IF;

  -- 1) contatos cadastrados (mais específicos: trazem nome e cargo)
  SELECT array_agg(DISTINCT cc.customer_user_id)
    INTO v_ids
    FROM public.customer_contacts cc
   WHERE cc.customer_user_id IS NOT NULL
     AND right(regexp_replace(coalesce(cc.phone, ''), '\D', '', 'g'), 8) = v_sufixo;

  IF v_ids IS NOT NULL THEN
    v_fonte := 'contato';
  ELSE
    -- 2) telefone do perfil, só de quem NÃO é staff
    SELECT array_agg(DISTINCT pr.user_id)
      INTO v_ids
      FROM public.profiles pr
     WHERE right(regexp_replace(coalesce(pr.phone, ''), '\D', '', 'g'), 8) = v_sufixo
       AND NOT EXISTS (
             SELECT 1 FROM public.user_roles r
              WHERE r.user_id = pr.user_id
                AND r.role IN ('employee'::public.app_role, 'master'::public.app_role)
           );
    IF v_ids IS NULL THEN
      RETURN;
    END IF;
    v_fonte := 'perfil';
  END IF;

  IF cardinality(v_ids) = 1 THEN
    v_escolhido := v_ids[1];
  ELSE
    -- desempate: o único candidato da carteira de quem liga; sem isso, fica sem dono
    SELECT array_agg(DISTINCT a.customer_user_id)
      INTO v_na_carteira
      FROM public.carteira_assignments a
     WHERE a.customer_user_id = ANY (v_ids)
       AND a.owner_user_id = auth.uid()
       AND a.eligible IS TRUE;
    IF cardinality(v_na_carteira) = 1 THEN
      v_escolhido := v_na_carteira[1];
    END IF;
  END IF;

  RETURN QUERY
  SELECT v_escolhido,
         c.nome,
         c.cargo,
         v_fonte,
         cardinality(v_ids)
    FROM (SELECT 1) um
    LEFT JOIN LATERAL (
      SELECT cc.nome, cc.cargo
        FROM public.customer_contacts cc
       WHERE v_fonte = 'contato'
         AND cc.customer_user_id = v_escolhido
         AND right(regexp_replace(coalesce(cc.phone, ''), '\D', '', 'g'), 8) = v_sufixo
       ORDER BY cc.is_primary DESC NULLS LAST, cc.created_at
       LIMIT 1
    ) c ON true;
END
$function$;

-- CREATE OR REPLACE preserva o ACL; o REVOKE explícito (PUBLIC E anon) não depende disso.
REVOKE ALL ON FUNCTION public.listar_clientes_base(text, text, text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resolver_cliente_por_telefone(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_clientes_base(text, text, text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolver_cliente_por_telefone(text) TO authenticated, service_role;

-- ───────────────────────── postcondição ─────────────────────────
DO $post$
DECLARE
  v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['public.v_caca_candidatos', 'public.v_caca_compradores',
                           'public.v_grupo_comercial', 'public.v_grupo_contatos'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = v::regclass
                    AND array_to_string(c.reloptions, ',') ~ 'security_invoker=(on|true)') THEN
      RAISE EXCEPTION 'postcondicao: % perdeu security_invoker', v;
    END IF;
    IF has_table_privilege('anon', v, 'SELECT') THEN
      RAISE EXCEPTION 'postcondicao: anon le %', v;
    END IF;
  END LOOP;
  FOREACH v IN ARRAY ARRAY['private.v_perfil_chaves_internas', 'public.v_perfil_equipe'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = v::regclass
                    AND c.reloptions @> ARRAY['security_invoker=off', 'security_barrier=true']) THEN
      RAISE EXCEPTION 'postcondicao: % sem invoker=off/barrier', v;
    END IF;
    IF has_table_privilege('anon', v, 'SELECT') OR NOT has_table_privilege('authenticated', v, 'SELECT') THEN
      RAISE EXCEPTION 'postcondicao: ACL errada em %', v;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.cliente_por_documento(text[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.cliente_por_documento(text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: ACL errada em cliente_por_documento';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.resolver_cliente_por_telefone(text)'::regprocedure) THEN
    RAISE EXCEPTION 'postcondicao: resolver_cliente_por_telefone nao virou SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', 'public.resolver_cliente_por_telefone(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.listar_clientes_base(text,text,text,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: anon executa RPC de clientes';
  END IF;
  -- nenhum objeto INVOKER de public lê as colunas de contato de profiles por pg_depend (views)
  IF EXISTS (
    SELECT 1 FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid JOIN pg_class c ON c.oid = r.ev_class
      JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
     WHERE d.refobjid = 'public.profiles'::regclass AND a.attname IN ('email', 'phone', 'document', 'cnpj')
       AND c.relkind = 'v' AND coalesce(array_to_string(c.reloptions, ','), '') !~ 'security_invoker=(off|false)'
  ) THEN
    RAISE EXCEPTION 'postcondicao: sobrou view invoker lendo contato de profiles';
  END IF;
END
$post$;

SELECT set_config('request.jwt.claims', '{"sub":"700657a1-d75d-4c72-99b1-0a0f2065fa29","role":"authenticated"}', true);
DO $m$
DECLARE r text := '';
BEGIN
  r := r || ' caca_cand=' || pg_temp.ms('SELECT * FROM public.v_caca_candidatos ORDER BY documento, empresa_alvo');
  r := r || ' caca_cand_p1=' || pg_temp.ms('SELECT * FROM public.v_caca_candidatos ORDER BY documento, empresa_alvo LIMIT 1000');
  r := r || ' caca_compr=' || pg_temp.ms('SELECT * FROM public.v_caca_compradores ORDER BY documento, empresa');
  r := r || ' grupo_com=' || pg_temp.ms('SELECT * FROM public.v_grupo_comercial');
  r := r || ' grupo_cont=' || pg_temp.ms('SELECT * FROM public.v_grupo_contatos WHERE grupo_id = ''33f59dc7-872e-45de-bc46-75117e47a3d9''');
  r := r || ' lista_prio=' || pg_temp.ms('SELECT * FROM public.listar_clientes_base(NULL, NULL, ''prioridade'', 100, 0)');
  r := r || ' lista_ult=' || pg_temp.ms('SELECT * FROM public.listar_clientes_base(NULL, NULL, ''nome'', 100, 16000)');
  r := r || ' lista_busca_vazia=' || pg_temp.ms('SELECT * FROM public.listar_clientes_base(''zzqx-inexistente'', NULL, ''nome'', 100, 0)');
  r := r || ' resolver=' || pg_temp.ms('SELECT * FROM public.resolver_cliente_por_telefone(''4733330003'')');
  RAISE NOTICE 'ENSAIO_OK depois:%', r;
END $m$;
