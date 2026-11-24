-- Onda D da tela Clientes — fatia 2: fontes MASCARADAS para todos os leitores + exceção OPERACIONAL
-- auditada. Spec: docs/superpowers/specs/2026-11-24-clientes-pii-por-carteira-design.md (founder:
-- opção 2, "Contexto operacional (Recomendado)").
--
-- Regra (fatia 1): documento/telefone/e-mail/endereço do cliente só na carteira/cobertura; gestão e
-- master veem tudo; customer vê o próprio. Pedido, expedição, rota e aprovação precisam do contato
-- MESMO fora da carteira: leem pela RPC operacional, que recebe o OBJETO (nunca o cliente), deriva o
-- cliente NO SERVIDOR e grava no ledger a leitura que é EXCEÇÃO (fora da carteira).
--
--   public.v_perfil_contato        — REESCRITA, mesmas colunas: o conjunto visível é calculado 1× por
--                                     consulta (subplano hasheado). A forma da fatia 1 chamava o
--                                     predicado por LINHA: carga aberta estourou 30 s em prod
--                                     (2026-11-24, farmer); a forma de conjunto mediu 215 ms / 16.102 linhas.
--   public.v_endereco_contato      — addresses: cidade/UF sempre (identidade); rótulo (texto livre),
--                                     rua, número, complemento, bairro e CEP só onde o contato é visível.
--   public.v_cliente_contatos      — customer_contacts: só staff, só linhas de cliente visível.
--   public.contato_acesso_operacional — ledger: SÓ referência (quem, cliente, objeto, motivo, quando).
--                                     Nunca o conteúdo da PII. RLS; único writer = a RPC.
--   public.contato_cliente_operacional(tipo, ids[], motivo) — contato por objeto; teto de 200 ids.
--
-- NÃO entra (fatia 3): REVOKE de coluna em profiles, policies de addresses/customer_contacts.
-- Aplicação: bun run db:aplicar (o EXECUTOR fornece a transação — este arquivo não leva BEGIN/COMMIT).

-- ───────────────────────── v_perfil_contato (forma de conjunto) ─────────────────────────
-- Owner postgres (BYPASSRLS): o WHERE é a fronteira de LINHA (self exato OU staff); o CASE é a de
-- COLUNA. visivel = self OU (staff E (gestão OU cliente ∈ clientes_contato_visiveis(uid))) — a mesma
-- semântica de private.cliente_contato_visivel, com o conjunto calculado uma vez. NULL-safe: alvo NULL
-- nunca é visível e o conjunto filtra NULL (senão `x IN (..., NULL)` vira NULL, não false). IN e não
-- EXISTS de propósito: dentro do OR, EXISTS vira subplano por linha (medido 3,4 s vs 215 ms).
CREATE OR REPLACE VIEW public.v_perfil_contato
WITH (security_invoker = off, security_barrier = true) AS
WITH eu AS (
  SELECT (SELECT auth.uid()) AS uid
), ctx AS (
  SELECT e.uid,
         (COALESCE(public.has_role(e.uid, 'employee'::public.app_role), false)
          OR COALESCE(public.has_role(e.uid, 'master'::public.app_role), false)) AS staff,
         COALESCE(private.pode_ver_carteira_completa(e.uid), false) AS gestao
    FROM eu e
   WHERE e.uid IS NOT NULL
)
SELECT p.user_id,
       v.visivel AS contato_visivel,
       CASE WHEN v.visivel THEN p.email    END AS email,
       CASE WHEN v.visivel THEN p.phone    END AS phone,
       CASE WHEN v.visivel THEN p.document END AS document,
       CASE WHEN v.visivel THEN p.cnpj     END AS cnpj,
       -- PJ/PF é IDENTIDADE (não o número): mesma regra de ehCnpjDocumento (14 alfanuméricos).
       length(regexp_replace(upper(coalesce(p.document, '')), '[^0-9A-Z]', '', 'g')) = 14 AS eh_pj
  FROM public.profiles p
 CROSS JOIN ctx
 CROSS JOIN LATERAL (
   SELECT p.user_id IS NOT NULL
          AND ((p.user_id = ctx.uid)
               OR (ctx.staff AND (ctx.gestao
                                  OR p.user_id IN (SELECT x.c FROM private.clientes_contato_visiveis((SELECT auth.uid())) x(c)
                                              WHERE x.c IS NOT NULL)))) AS visivel
 ) v
 WHERE p.user_id = ctx.uid OR ctx.staff;

REVOKE ALL ON public.v_perfil_contato FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.v_perfil_contato TO authenticated, service_role;

-- ───────────────────────── v_endereco_contato ─────────────────────────
CREATE OR REPLACE VIEW public.v_endereco_contato
WITH (security_invoker = off, security_barrier = true) AS
WITH eu AS (
  SELECT (SELECT auth.uid()) AS uid
), ctx AS (
  SELECT e.uid,
         (COALESCE(public.has_role(e.uid, 'employee'::public.app_role), false)
          OR COALESCE(public.has_role(e.uid, 'master'::public.app_role), false)) AS staff,
         COALESCE(private.pode_ver_carteira_completa(e.uid), false) AS gestao
    FROM eu e
   WHERE e.uid IS NOT NULL
)
SELECT a.id,
       a.user_id,
       v.visivel AS contato_visivel,
       a.city,
       a.state,
       a.is_default,
       a.is_from_omie,
       a.created_at,
       CASE WHEN v.visivel THEN a.label        END AS label,
       CASE WHEN v.visivel THEN a.street       END AS street,
       CASE WHEN v.visivel THEN a.number       END AS number,
       CASE WHEN v.visivel THEN a.complement   END AS complement,
       CASE WHEN v.visivel THEN a.neighborhood END AS neighborhood,
       CASE WHEN v.visivel THEN a.zip_code     END AS zip_code
  FROM public.addresses a
 CROSS JOIN ctx
 CROSS JOIN LATERAL (
   SELECT a.user_id IS NOT NULL
          AND ((a.user_id = ctx.uid)
               OR (ctx.staff AND (ctx.gestao
                                  OR a.user_id IN (SELECT x.c FROM private.clientes_contato_visiveis((SELECT auth.uid())) x(c)
                                              WHERE x.c IS NOT NULL)))) AS visivel
 ) v
 WHERE a.user_id = ctx.uid OR ctx.staff;

REVOKE ALL ON public.v_endereco_contato FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.v_endereco_contato TO authenticated, service_role;

-- ───────────────────────── v_cliente_contatos ─────────────────────────
-- Pessoa de contato inteira é contato (nome+telefone+cargo+aniversário+notas): a linha só existe onde
-- o contato do cliente é visível. A tela distingue "oculto" de "vazio" pelo contato_visivel do perfil.
-- Customer não lia customer_contacts e continua não lendo. Escrita segue na tabela (fatia 3: policies).
CREATE OR REPLACE VIEW public.v_cliente_contatos
WITH (security_invoker = off, security_barrier = true) AS
WITH eu AS (
  SELECT (SELECT auth.uid()) AS uid
), ctx AS (
  SELECT e.uid,
         (COALESCE(public.has_role(e.uid, 'employee'::public.app_role), false)
          OR COALESCE(public.has_role(e.uid, 'master'::public.app_role), false)) AS staff,
         COALESCE(private.pode_ver_carteira_completa(e.uid), false) AS gestao
    FROM eu e
   WHERE e.uid IS NOT NULL
)
SELECT cc.id, cc.customer_user_id, cc.phone, cc.nome, cc.cargo, cc.email, cc.is_decision_maker,
       cc.is_primary, cc.whatsapp_only, cc.birthday, cc.notas, cc.source, cc.created_by,
       cc.created_at, cc.updated_at
  FROM public.customer_contacts cc
 CROSS JOIN ctx
 WHERE ctx.staff
   AND cc.customer_user_id IS NOT NULL
   AND (ctx.gestao
        OR cc.customer_user_id IN (SELECT x.c FROM private.clientes_contato_visiveis((SELECT auth.uid())) x(c)
                                              WHERE x.c IS NOT NULL));

REVOKE ALL ON public.v_cliente_contatos FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.v_cliente_contatos TO authenticated, service_role;


-- ───────────────────────── ledger ─────────────────────────
-- Vocabulário FECHADO de motivo por tipo (texto livre deixaria nome/telefone no ledger e inflaria a
-- chave do dedupe). Novo motivo = migration nova, com a tela que o usa.
CREATE TABLE IF NOT EXISTS public.contato_acesso_operacional (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  staff_user_id    uuid        NOT NULL,
  customer_user_id uuid        NOT NULL,
  objeto_tipo      text        NOT NULL,
  objeto_id        uuid        NOT NULL,
  motivo           text        NOT NULL,
  acessado_em      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contato_acesso_operacional_motivo_chk CHECK (
    (objeto_tipo, motivo) IN (
      ('pedido', 'detalhe_pedido'), ('pedido', 'impressao_pedido'),
      ('ordem_servico', 'detalhe_os'), ('ordem_servico', 'lista_os'), ('ordem_servico', 'roteirizar_entrega'),
      ('expedicao', 'separacao'),
      ('rota', 'visita_agendada'),
      ('aprovacao', 'aprovar_cadastro'),
      ('novo_pedido', 'novo_pedido'), ('novo_pedido', 'proposta_recompra')))
);
COMMENT ON TABLE public.contato_acesso_operacional IS
  'Onda D fatia 2: leitura de contato de cliente FORA da carteira pelo contexto operacional. Só '
  'referências — nunca o conteúdo da PII. Único writer: public.contato_cliente_operacional.';

CREATE INDEX IF NOT EXISTS contato_acesso_operacional_cliente_idx
  ON public.contato_acesso_operacional (customer_user_id, acessado_em DESC);
CREATE INDEX IF NOT EXISTS contato_acesso_operacional_staff_idx
  ON public.contato_acesso_operacional (staff_user_id, objeto_tipo, acessado_em DESC);

ALTER TABLE public.contato_acesso_operacional ENABLE ROW LEVEL SECURITY;

-- Leitura: gestão/master veem tudo; staff ATUAL vê as próprias (ex-employee perde o histórico).
-- Escrita: nenhuma policy e nenhum grant a papel da aplicação — inclusive service_role (Codex P1:
-- seria um 2º escritor capaz de forjar/apagar). Único writer = a RPC SECURITY DEFINER (owner).
DROP POLICY IF EXISTS contato_acesso_operacional_select ON public.contato_acesso_operacional;
CREATE POLICY contato_acesso_operacional_select ON public.contato_acesso_operacional
  FOR SELECT TO authenticated
  USING (
    COALESCE((SELECT private.pode_ver_carteira_completa((SELECT auth.uid()))), false)
    OR (staff_user_id = (SELECT auth.uid())
        AND (COALESCE((SELECT public.has_role((SELECT auth.uid()), 'employee'::public.app_role)), false)
             OR COALESCE((SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role)), false)))
  );

REVOKE ALL ON public.contato_acesso_operacional FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.contato_acesso_operacional TO authenticated, service_role;

-- ───────────────────────── RPC operacional por OBJETO ─────────────────────────
-- O cliente NUNCA vem do chamador: sai do objeto, e o tipo amarra a tabela.
--   tipo           objeto                 cliente                      devolve (mínimo por operação)
--   pedido         sales_orders.id        customer_user_id             doc/CNPJ, telefone, endereços, snapshot
--   ordem_servico  orders.id              user_id (OS de afiação)      doc/CNPJ, telefone, endereços
--   expedicao      picking_tasks.id       pedido da tarefa             telefone, endereços
--   rota           route_visits.id        customer_user_id             telefone, endereços
--   aprovacao      profiles.user_id       só cadastro PENDENTE         doc/CNPJ, telefone, e-mail
--   novo_pedido    profiles.user_id       pedido/proposta SEM objeto   doc/CNPJ, telefone, endereços
-- `novo_pedido` é o elo fraco (o "objeto" é o próprio cliente): 1 cliente por chamada e no máximo 80
-- clientes DISTINTOS fora da carteira por staff/dia (pico medido 2026-11-24: 34 clientes/dia TOTAIS,
-- dentro e fora da carteira), contados no ledger sob lock por staff.
-- Objeto inexistente/sem cliente não devolve linha nem grava. Staff (user_roles OU is_employee) nunca
-- é cliente. O ledger grava só a EXCEÇÃO, com dedupe de 10 min por (staff, tipo, objeto, cliente,
-- motivo); a decisão é serializada por staff (pg_advisory_xact_lock) — chamadas concorrentes não duplicam.
CREATE OR REPLACE FUNCTION public.contato_cliente_operacional(
  p_objeto_tipo text,
  p_objeto_ids  uuid[],
  p_motivo      text
)
RETURNS TABLE(
  objeto_id         uuid,
  customer_user_id  uuid,
  via_excecao       boolean,
  email             text,
  phone             text,
  document          text,
  cnpj              text,
  enderecos         jsonb,
  pedido_documento  text,
  pedido_endereco   text,
  pedido_telefone   text
)
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
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
    SELECT rv.id, rv.customer_user_id, NULL, NULL, NULL
      FROM public.route_visits rv
     WHERE p_objeto_tipo = 'rota' AND rv.id = ANY (v_ids)
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
    -- NULL-safe (Codex P1): exceção é TRUE a menos que self/gestão/conjunto PROVEM o contrário
    SELECT a.oid, a.cid, a.pdoc, a.pend, a.ptel,
           NOT COALESCE(a.cid = v_uid OR v_gestao OR EXISTS (SELECT 1 FROM vis WHERE vis.c = a.cid), false) AS exc
      FROM alvo a
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

-- Lança o estouro do teto diário DENTRO da consulta (o CASE só a chama quando estoura).
CREATE OR REPLACE FUNCTION private.contato_operacional_teto_estourado()
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SET search_path TO ''
AS $function$
BEGIN
  RAISE EXCEPTION 'contato_cliente_operacional: teto diario de clientes fora da carteira em novo_pedido'
    USING ERRCODE = '54000';
END
$function$;
REVOKE ALL ON FUNCTION private.contato_operacional_teto_estourado() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.contato_cliente_operacional(text, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contato_cliente_operacional(text, uuid[], text) TO authenticated, service_role;

-- ───────────────────────── postcondição ─────────────────────────
DO $pos$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.contato_acesso_operacional'::regclass) THEN
    RAISE EXCEPTION 'pos: ledger sem RLS';
  END IF;
  IF has_table_privilege('anon', 'public.contato_acesso_operacional', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('authenticated', 'public.contato_acesso_operacional', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('service_role', 'public.contato_acesso_operacional', 'INSERT,UPDATE,DELETE,TRUNCATE') THEN
    RAISE EXCEPTION 'pos: ledger com 2º escritor (anon/authenticated/service_role)';
  END IF;
  IF has_function_privilege('anon', 'public.contato_cliente_operacional(text, uuid[], text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.contato_cliente_operacional(text, uuid[], text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.contato_operacional_teto_estourado()', 'EXECUTE') THEN
    RAISE EXCEPTION 'pos: ACL da RPC operacional errado';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.contato_cliente_operacional(text, uuid[], text)'::regprocedure) IS NOT TRUE THEN
    RAISE EXCEPTION 'pos: RPC operacional não é SECURITY DEFINER';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY['public.v_perfil_contato', 'public.v_endereco_contato', 'public.v_cliente_contatos']) AS v(n)
     WHERE has_table_privilege('anon', v.n, 'SELECT')
        OR has_table_privilege('authenticated', v.n, 'INSERT,UPDATE,DELETE')
        OR NOT has_table_privilege('authenticated', v.n, 'SELECT')
        OR NOT (SELECT reloptions @> ARRAY['security_invoker=off', 'security_barrier=true']
                  FROM pg_class WHERE oid = v.n::regclass)
  ) THEN
    RAISE EXCEPTION 'pos: view-gate com ACL ou opção errada';
  END IF;
END
$pos$;
