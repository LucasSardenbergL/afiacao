-- Ensaio de desempenho da fatia 4b-1 (SÓ --ensaio: roda e faz ROLLBACK). Mede como o farmer de maior carteira,
-- antes e depois da migration 20261126230000 (cópia do corpo abaixo), linhas + ms + md5 por view.
-- Uso: bun run db:aplicar db/diagnostico/ensaio-clientes-pii-fatia4b1-perf.sql --ensaio
DO $m$
DECLARE v_f uuid; t0 timestamptz; n bigint; h text;
BEGIN
  SELECT cr.user_id INTO v_f FROM public.commercial_roles cr
    JOIN public.carteira_assignments ca ON ca.owner_user_id = cr.user_id AND ca.eligible
   WHERE cr.commercial_role = 'farmer' GROUP BY cr.user_id ORDER BY count(*) DESC LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_f, 'role', 'authenticated')::text, true);
  t0 := clock_timestamp();
  SELECT count(*), md5(coalesce(string_agg(t::text, '§' ORDER BY t::text), '')) INTO n, h FROM public.v_perfil_equipe t;
  RAISE NOTICE 'PERF antes v_perfil_equipe: % linhas, % ms, md5 %', n, round(extract(epoch FROM clock_timestamp() - t0) * 1000), left(h, 8);
  t0 := clock_timestamp();
  SELECT count(*), md5(coalesce(string_agg(t::text, '§' ORDER BY t::text), '')) INTO n, h FROM public.v_grupo_contatos t;
  RAISE NOTICE 'PERF antes v_grupo_contatos: % linhas, % ms, md5 %', n, round(extract(epoch FROM clock_timestamp() - t0) * 1000), left(h, 8);
END
$m$;
-- Onda D da tela Clientes — fatia 4b-1: o que fecha só no servidor, sem depender de front novo.
-- Diário: docs/historico/clientes-onda-d-pii-carteira.md (§Fatia 4b).
--
-- 1. contato_cliente_operacional (L6): sai o ramo "próprio" (`a.cid = v_uid`). O chamador é SEMPRE staff
--    (gate de entrada), então o "próprio" só valia quando o titular do pedido era o PRÓPRIO vendedor —
--    o fallback `customerUserId || user.id` do front grava isso (19 pedidos em prod). E titular STAFF
--    (papel ou flag) não conta como carteira (Codex P1): fora da gestão, vai sempre para o ledger
--    (prod: 1 staff numa carteira, 12 pedidos — a dona dela lia o snapshot do comprador sem registro).
--    Corpo = o da PRODUÇÃO (pg_get_functiondef 2026-11-26), com só essa linha trocada. REPLACE preserva o ACL.
-- 2. anon perde tudo em addresses, customer_contacts, cliente_grupos, cliente_grupo_membros e
--    v_grupo_contas_receber_por_doc (ACL herdada do default privileges; hoje só a RLS segurava).
-- 3. v_grupo_contatos lê o endereço da v_endereco_contato (rua/número NULL fora da carteira) em vez da
--    addresses crua. security_invoker=true REPETIDO (omitir resetaria a opção).
-- 4. v_perfil_equipe: "equipe" = PAPEL (employee/master), não a flag is_employee — a flag sobrevive ao
--    desligamento (nenhum fluxo a limpa) e mantinha nome+e-mail do ex-funcionário no diretório.
--    Autorização viva já é só por papel. Prod: 0 perfis com flag sem papel. View-gate: security_invoker=off
--    + security_barrier POR DESENHO.
-- 5. Exceções deliberadas registradas no catálogo (COMMENT): resolver_cliente_por_telefone (telefonia),
--    cliente_por_documento (vínculo Omie→perfil, devolve só o uuid).
--
-- Sem pré-requisito de front. Aplicação: bun run db:aplicar (o EXECUTOR fornece a transação — sem BEGIN/COMMIT).

-- ───────────────────────── 1. L6 ─────────────────────────
CREATE OR REPLACE FUNCTION public.contato_cliente_operacional(p_objeto_tipo text, p_objeto_ids uuid[], p_motivo text)
 RETURNS TABLE(objeto_id uuid, customer_user_id uuid, via_excecao boolean, email text, phone text, document text, cnpj text, enderecos jsonb, pedido_documento text, pedido_endereco text, pedido_telefone text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
DECLARE
  v_uid    uuid := auth.uid();
  v_ids    uuid[];
  v_gestao boolean;
  v_hoje   timestamptz := date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
BEGIN
  IF v_uid IS NULL
     OR NOT (COALESCE(public.has_role(v_uid, 'employee'::public.app_role), false)
             OR COALESCE(public.has_role(v_uid, 'master'::public.app_role), false)) THEN
    RAISE EXCEPTION 'contato_cliente_operacional: sem permissao' USING ERRCODE = '42501';
  END IF;
  IF p_objeto_tipo IS NULL OR p_motivo IS NULL
     OR (p_objeto_tipo, p_motivo) NOT IN (
       ('pedido', 'detalhe_pedido'), ('pedido', 'impressao_pedido'),
       ('ordem_servico', 'detalhe_os'), ('ordem_servico', 'lista_os'), ('ordem_servico', 'roteirizar_entrega'),
       ('expedicao', 'separacao'),
       ('rota', 'visita_agendada'),
       ('aprovacao', 'aprovar_cadastro'),
       ('novo_pedido', 'novo_pedido'), ('novo_pedido', 'proposta_recompra')) THEN
    RAISE EXCEPTION 'contato_cliente_operacional: tipo/motivo invalido' USING ERRCODE = '22023';
  END IF;
  -- teto sobre a cardinalidade BRUTA (antes do unnest/DISTINCT): protege também o servidor
  IF cardinality(p_objeto_ids) > 200 THEN
    RAISE EXCEPTION 'contato_cliente_operacional: mais de 200 objetos por chamada' USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(DISTINCT u.i) INTO v_ids FROM unnest(p_objeto_ids) AS u(i) WHERE u.i IS NOT NULL;
  IF v_ids IS NULL THEN
    RETURN;
  END IF;
  IF p_objeto_tipo = 'novo_pedido' AND cardinality(v_ids) > 1 THEN
    RAISE EXCEPTION 'contato_cliente_operacional: novo_pedido e um cliente por chamada' USING ERRCODE = '22023';
  END IF;
  v_gestao := COALESCE(private.pode_ver_carteira_completa(v_uid), false);

  -- serializa dedupe e teto diário deste staff (chamadas concorrentes esperam, não duplicam)
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('contato_cliente_operacional:' || v_uid::text, 0));

  RETURN QUERY
  WITH alvo AS (
    SELECT so.id AS oid, so.customer_user_id AS cid,
           so.customer_document AS pdoc, so.customer_address AS pend, so.customer_phone AS ptel
      FROM public.sales_orders so
     WHERE p_objeto_tipo = 'pedido' AND so.id = ANY (v_ids)
    UNION ALL
    SELECT o.id, o.user_id, NULL, NULL, NULL
      FROM public.orders o
     WHERE p_objeto_tipo = 'ordem_servico' AND o.id = ANY (v_ids)
    UNION ALL
    SELECT pt.id, so.customer_user_id, NULL, NULL, NULL
      FROM public.picking_tasks pt
      JOIN public.sales_orders so ON so.id = pt.sales_order_id
     WHERE p_objeto_tipo = 'expedicao' AND pt.id = ANY (v_ids)
    UNION ALL
    SELECT va.id, va.customer_user_id, NULL, NULL, NULL
      FROM public.visitas_agendadas va
     WHERE p_objeto_tipo = 'rota' AND va.id = ANY (v_ids)
       AND va.scheduled_by = v_uid
    UNION ALL
    SELECT p.user_id, p.user_id, NULL, NULL, NULL
      FROM public.profiles p
     WHERE p_objeto_tipo IN ('aprovacao', 'novo_pedido') AND p.user_id = ANY (v_ids)
       AND (p_objeto_tipo = 'novo_pedido' OR p.is_approved IS NOT TRUE)
       AND p.is_employee IS NOT TRUE
       AND NOT EXISTS (SELECT 1 FROM public.user_roles ur
                        WHERE ur.user_id = p.user_id
                          AND ur.role IN ('employee'::public.app_role, 'master'::public.app_role))
  ), vis AS MATERIALIZED (
    SELECT x.c FROM private.clientes_contato_visiveis(v_uid) x(c) WHERE x.c IS NOT NULL AND NOT v_gestao
  ), classif AS MATERIALIZED (
    -- NULL-safe (Codex P1): exceção é TRUE a menos que gestão/conjunto PROVEM o contrário.
    -- Titular STAFF (papel ou flag) nunca dispensa o ledger de quem não é gestão (4b-1, Codex P1): o
    -- fallback do front grava o vendedor como titular e o snapshot é do comprador, então a carteira do
    -- titular não diz nada sobre de quem é o contato (prod: 12 pedidos com titular staff numa carteira).
    SELECT a.oid, a.cid, a.pdoc, a.pend, a.ptel,
           NOT COALESCE(v_gestao OR (EXISTS (SELECT 1 FROM vis WHERE vis.c = a.cid) AND NOT a.titular_staff), false) AS exc
      FROM (SELECT a0.*,
                   (EXISTS (SELECT 1 FROM public.user_roles ur
                             WHERE ur.user_id = a0.cid
                               AND ur.role IN ('employee'::public.app_role, 'master'::public.app_role))
                    OR EXISTS (SELECT 1 FROM public.profiles pf WHERE pf.user_id = a0.cid AND pf.is_employee IS TRUE)
                   ) AS titular_staff
              FROM alvo a0) a
     WHERE a.cid IS NOT NULL
  ), teto AS MATERIALIZED (
    -- novo_pedido: clientes distintos fora da carteira já lidos hoje + o desta chamada
    SELECT count(DISTINCT u.c) AS n
      FROM (SELECT l.customer_user_id AS c FROM public.contato_acesso_operacional l
             WHERE p_objeto_tipo = 'novo_pedido' AND l.staff_user_id = v_uid
               AND l.objeto_tipo = 'novo_pedido' AND l.acessado_em >= v_hoje
            UNION
            SELECT c.cid FROM classif c WHERE p_objeto_tipo = 'novo_pedido' AND c.exc) u
  ), barra AS MATERIALIZED (
    SELECT CASE WHEN (SELECT n FROM teto) > 80
                THEN private.contato_operacional_teto_estourado() END AS x
  ), grava AS (
    -- CTE de escrita: o Postgres a executa SEMPRE, até o fim, leia o SELECT final dela ou não.
    INSERT INTO public.contato_acesso_operacional (staff_user_id, customer_user_id, objeto_tipo, objeto_id, motivo)
    SELECT v_uid, c.cid, p_objeto_tipo, c.oid, p_motivo
      FROM classif c, barra
     WHERE c.exc
       AND NOT EXISTS (
         SELECT 1 FROM public.contato_acesso_operacional l
          WHERE l.staff_user_id = v_uid AND l.objeto_tipo = p_objeto_tipo AND l.objeto_id = c.oid
            AND l.customer_user_id = c.cid AND l.motivo = p_motivo
            AND l.acessado_em > now() - interval '10 minutes')
    RETURNING 1
  )
  SELECT c.oid, c.cid, c.exc,
         CASE WHEN p_objeto_tipo = 'aprovacao' THEN pr.email END,
         pr.phone,
         CASE WHEN p_objeto_tipo IN ('pedido', 'ordem_servico', 'aprovacao', 'novo_pedido') THEN pr.document END,
         CASE WHEN p_objeto_tipo IN ('pedido', 'ordem_servico', 'aprovacao', 'novo_pedido') THEN pr.cnpj END,
         CASE WHEN p_objeto_tipo = 'aprovacao' THEN '[]'::jsonb ELSE COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'id', ad.id, 'label', ad.label, 'street', ad.street, 'number', ad.number,
                    'complement', ad.complement, 'neighborhood', ad.neighborhood, 'city', ad.city,
                    'state', ad.state, 'zip_code', ad.zip_code, 'is_default', ad.is_default)
                  ORDER BY ad.is_default DESC NULLS LAST, ad.created_at, ad.id)
             FROM public.addresses ad WHERE ad.user_id = c.cid), '[]'::jsonb) END,
         c.pdoc, c.pend, c.ptel
    FROM classif c
    CROSS JOIN barra
    LEFT JOIN public.profiles pr ON pr.user_id = c.cid;
END
$function$;

REVOKE ALL ON FUNCTION public.contato_cliente_operacional(text, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contato_cliente_operacional(text, uuid[], text) TO authenticated;

-- ───────────────────────── 2. anon ─────────────────────────
REVOKE ALL ON public.addresses FROM PUBLIC, anon;
REVOKE ALL ON public.customer_contacts FROM PUBLIC, anon;
REVOKE ALL ON public.cliente_grupos FROM PUBLIC, anon;
REVOKE ALL ON public.cliente_grupo_membros FROM PUBLIC, anon;
REVOKE ALL ON public.v_grupo_contas_receber_por_doc FROM PUBLIC, anon;

-- ───────────────────────── 3. v_grupo_contatos ─────────────────────────
CREATE OR REPLACE VIEW public.v_grupo_contatos WITH (security_invoker = true) AS
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
   FROM public.cliente_grupo_membros m
     JOIN (public.profiles p
     JOIN private.v_perfil_chaves_internas k ON k.user_id = p.user_id) ON
        CASE
            WHEN COALESCE(k.cnpj, k.document, ''::text) ~ '[A-Za-z]'::text THEN public.normalizar_documento(COALESCE(k.cnpj, k.document, ''::text))
            ELSE regexp_replace(COALESCE(k.cnpj, k.document, ''::text), '\D'::text, ''::text, 'g'::text)
        END = m.documento
     LEFT JOIN public.v_perfil_contato vpc ON vpc.user_id = p.user_id
     LEFT JOIN public.v_endereco_contato a ON a.user_id = p.user_id AND a.is_default = true
     LEFT JOIN public.omie_customer_account_map_fresco oc ON oc.user_id = p.user_id AND oc.account = 'oben'::text;
REVOKE ALL ON public.v_grupo_contatos FROM PUBLIC, anon;

-- ───────────────────────── 4. v_perfil_equipe ─────────────────────────
CREATE OR REPLACE VIEW public.v_perfil_equipe WITH (security_invoker = off, security_barrier = true) AS
 WITH ctx AS (
         SELECT COALESCE(public.has_role(( SELECT auth.uid() AS uid), 'employee'::public.app_role), false)
             OR COALESCE(public.has_role(( SELECT auth.uid() AS uid), 'master'::public.app_role), false) AS staff
        )
 SELECT p.user_id,
    p.name,
    p.email,
    p.is_employee,
    p.is_approved
   FROM public.profiles p
     CROSS JOIN ctx
  WHERE ctx.staff AND p.user_id IS NOT NULL AND (p.user_id IN ( SELECT r.user_id
           FROM public.user_roles r
          WHERE r.user_id IS NOT NULL AND (r.role = ANY (ARRAY['employee'::public.app_role, 'master'::public.app_role]))));
REVOKE ALL ON public.v_perfil_equipe FROM PUBLIC, anon;

-- ───────────────────────── 5. exceções registradas ─────────────────────────
COMMENT ON FUNCTION public.resolver_cliente_por_telefone(text) IS
  'Exceção deliberada da onda D (fatia 4b): oráculo telefone→identidade para QUALQUER staff — devolve o cliente (nome/empresa) e, quando o número é de customer_contacts, o NOME e o CARGO da pessoa de contato; nunca telefone/e-mail/documento/endereço — fonte única do reconhecimento de número da telefonia (docs/agent/telefonia.md). Não estender a PII.';
COMMENT ON FUNCTION public.cliente_por_documento(text[]) IS
  'Exceção deliberada da onda D (fatia 4b): documento→user_id para staff, de 1 a 4 variantes, para ligar cliente Omie ao perfil local. Devolve só o uuid (identidade é aberta); a PII segue pelas fontes mascaradas.';

DO $post$
DECLARE
  t text;
  v text;
  v_def text;
  v_aberto text[];
  v_sem text[];
BEGIN
  -- C1: o ramo "próprio" saiu e a régua segue de pé
  v_def := pg_get_functiondef('public.contato_cliente_operacional(text,uuid[],text)'::regprocedure);
  IF position('a.cid = v_uid' IN v_def) > 0 THEN
    RAISE EXCEPTION 'C1 FALHOU: contato_cliente_operacional ainda isenta o titular = chamador (L6)';
  END IF;
  IF position('NOT COALESCE(v_gestao OR (EXISTS (SELECT 1 FROM vis WHERE vis.c = a.cid) AND NOT a.titular_staff), false) AS exc' IN v_def) = 0
     OR position('pf.is_employee IS TRUE) ) AS titular_staff' IN regexp_replace(v_def, '\s+', ' ', 'g')) = 0 THEN
    RAISE EXCEPTION 'C1 FALHOU: classificação de exceção não é a esperada';
  END IF;
  IF has_function_privilege('anon', 'public.contato_cliente_operacional(text,uuid[],text)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc pr, aclexplode(COALESCE(pr.proacl, acldefault('f', pr.proowner))) x
                 WHERE pr.oid = 'public.contato_cliente_operacional(text,uuid[],text)'::regprocedure
                   AND x.grantee = 0 AND x.privilege_type = 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.contato_cliente_operacional(text,uuid[],text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'C1 FALHOU: ACL de contato_cliente_operacional (anon/PUBLIC fechados, authenticated aberto)';
  END IF;

  -- C2: anon sem nenhum verbo nas relações de PII/grupo — verbo a verbo (lista = "algum deles")
  FOREACH t IN ARRAY ARRAY['public.addresses', 'public.customer_contacts', 'public.cliente_grupos',
                           'public.cliente_grupo_membros', 'public.v_grupo_contas_receber_por_doc',
                           'public.v_grupo_contatos', 'public.v_perfil_equipe'] LOOP
    FOREACH v IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
      IF has_table_privilege('anon', t, v) THEN
        v_aberto := array_append(v_aberto, 'anon:' || v || ':' || t);
      END IF;
    END LOOP;
    -- privilégio só de COLUNA escapa do has_table_privilege
    FOREACH v IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
      IF has_any_column_privilege('anon', t, v) THEN
        v_aberto := array_append(v_aberto, 'anon:coluna:' || v || ':' || t);
      END IF;
    END LOOP;
  END LOOP;
  IF v_aberto IS NOT NULL THEN
    RAISE EXCEPTION 'C2 FALHOU: anon segue com acesso: %', v_aberto;
  END IF;

  -- C3: o que as telas precisam continua aberto para authenticated
  FOREACH t IN ARRAY ARRAY['public.addresses', 'public.cliente_grupos', 'public.cliente_grupo_membros',
                           'public.v_grupo_contas_receber_por_doc', 'public.v_grupo_contatos',
                           'public.v_perfil_equipe', 'public.v_endereco_contato'] LOOP
    IF NOT has_table_privilege('authenticated', t, 'SELECT') THEN
      v_sem := array_append(v_sem, 'SELECT ' || t);
    END IF;
  END LOOP;
  FOREACH v IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege('authenticated', 'public.addresses', v) THEN
      v_sem := array_append(v_sem, v || ' addresses');
    END IF;
  END LOOP;
  FOREACH v IN ARRAY ARRAY['INSERT', 'DELETE'] LOOP
    IF NOT has_table_privilege('authenticated', 'public.customer_contacts', v) THEN
      v_sem := array_append(v_sem, v || ' customer_contacts');
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['public.cliente_grupos', 'public.cliente_grupo_membros'] LOOP
    FOREACH v IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('authenticated', t, v) THEN
        v_sem := array_append(v_sem, v || ' ' || t);
      END IF;
    END LOOP;
  END LOOP;
  IF NOT has_column_privilege('authenticated', 'public.customer_contacts', 'id', 'SELECT') THEN
    v_sem := array_append(v_sem, 'SELECT customer_contacts.id');
  END IF;
  FOREACH v IN ARRAY ARRAY['phone', 'email', 'nome', 'cargo', 'birthday', 'notas'] LOOP
    IF has_column_privilege('authenticated', 'public.customer_contacts', v, 'SELECT') THEN
      v_sem := array_append(v_sem, 'corte da 4a desfeito: customer_contacts.' || v || ' legível');
    END IF;
  END LOOP;
  IF NOT has_table_privilege('service_role', 'public.addresses', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.customer_contacts', 'SELECT') THEN
    v_sem := array_append(v_sem, 'service_role perdeu leitura (edges)');
  END IF;
  IF v_sem IS NOT NULL THEN
    RAISE EXCEPTION 'C3 FALHOU: o corte levou junto o que a tela precisa: %', v_sem;
  END IF;

  -- C4: v_grupo_contatos lê a fonte mascarada e segue invoker
  v_def := pg_get_viewdef('public.v_grupo_contatos'::regclass, true);
  IF position('LEFT JOIN v_endereco_contato a ON' IN v_def) = 0 OR v_def ~ '\maddresses\M' THEN
    RAISE EXCEPTION 'C4 FALHOU: v_grupo_contatos ainda lê addresses crua';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.v_grupo_contatos'::regclass
                    AND 'security_invoker=true' = ANY (reloptions)) THEN
    RAISE EXCEPTION 'C4 FALHOU: v_grupo_contatos perdeu security_invoker=true';
  END IF;

  -- C5: v_perfil_equipe por papel, view-gate intacto
  v_def := pg_get_viewdef('public.v_perfil_equipe'::regclass, true);
  IF substring(v_def FROM '(?s)WHERE(.*)$') ~ 'is_employee' THEN
    RAISE EXCEPTION 'C5 FALHOU: v_perfil_equipe ainda aceita a flag is_employee como equipe';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.v_perfil_equipe'::regclass
                    AND 'security_invoker=off' = ANY (reloptions) AND 'security_barrier=true' = ANY (reloptions)) THEN
    RAISE EXCEPTION 'C5 FALHOU: v_perfil_equipe deixou de ser view-gate (invoker=off + barrier)';
  END IF;

  RAISE NOTICE 'fatia 4b-1 ok: L6 fechada, anon fora, grupo mascarado, equipe por papel';
END
$post$;
DO $m$
DECLARE v_f uuid; t0 timestamptz; n bigint; h text;
BEGIN
  SELECT cr.user_id INTO v_f FROM public.commercial_roles cr
    JOIN public.carteira_assignments ca ON ca.owner_user_id = cr.user_id AND ca.eligible
   WHERE cr.commercial_role = 'farmer' GROUP BY cr.user_id ORDER BY count(*) DESC LIMIT 1;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_f, 'role', 'authenticated')::text, true);
  t0 := clock_timestamp();
  SELECT count(*), md5(coalesce(string_agg(t::text, '§' ORDER BY t::text), '')) INTO n, h FROM public.v_perfil_equipe t;
  RAISE NOTICE 'PERF depois v_perfil_equipe: % linhas, % ms, md5 %', n, round(extract(epoch FROM clock_timestamp() - t0) * 1000), left(h, 8);
  t0 := clock_timestamp();
  SELECT count(*), md5(coalesce(string_agg(t::text, '§' ORDER BY t::text), '')) INTO n, h FROM public.v_grupo_contatos t;
  RAISE NOTICE 'PERF depois v_grupo_contatos: % linhas, % ms, md5 %', n, round(extract(epoch FROM clock_timestamp() - t0) * 1000), left(h, 8);
END
$m$;
