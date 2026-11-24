-- Onda D da tela Clientes — fatia 1: CONTRATO de "pode agir" e "contato visível", sem fechar nada.
-- Spec: docs/superpowers/specs/2026-11-24-clientes-pii-por-carteira-design.md (founder: opção c +
-- contexto operacional; Codex challenge integrado).
--
-- O que entra:
--   private.clientes_para_agir(uid)            — conjunto: atribuição ELEGÍVEL do uid, expandida pela
--                                                raiz fiscal (customer_canonical_alias) só quando a
--                                                raiz tem UM dono elegível (raiz ambígua não amplia)
--   private.clientes_contato_visiveis(uid)     — o de cima ∪ o dos donos que o uid cobre (cobertura vigente)
--   private.cliente_pode_agir(cust, uid)       — staff atual E cust ∈ clientes_para_agir(uid)
--   private.cliente_contato_visivel(cust, uid) — staff atual E (gestão OU cust ∈ clientes_contato_visiveis)
--   public.pode_agir_no_cliente(uuid)          — wrapper com auth.uid() (front: AcoesDaFicha)
--   public.venda_registrar_contato             — gate trocado pelo predicado único (IS TRUE)
--   public.v_perfil_contato                    — view-gate mascarada (self OU staff; contato só se visível)
--   public.buscar_clientes_global(text, int)   — Cmd-K: sem staff; doc/e-mail só casam onde visível
--
-- NÃO entra (fatias 2/3): REVOKE de coluna em profiles, policies de addresses/customer_contacts,
-- ledger + RPC operacional (nascem com os leitores de pedido/expedição/rota/aprovação).
-- Aplicação: bun run db:aplicar (o EXECUTOR fornece a transação — este arquivo não leva BEGIN/COMMIT).

-- ───────────────────────── conjuntos ─────────────────────────
CREATE OR REPLACE FUNCTION private.clientes_para_agir(_uid uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  WITH proprias AS (
    SELECT a.customer_user_id AS c
      FROM public.carteira_assignments a
     WHERE _uid IS NOT NULL
       AND a.owner_user_id = _uid
       AND a.eligible IS TRUE
  ), raizes AS (
    SELECT DISTINCT COALESCE(ca.canonical_user_id, p.c) AS r
      FROM proprias p
      LEFT JOIN public.customer_canonical_alias ca
             ON ca.alias_user_id = p.c AND ca.status = 'active'
  ), ambiguas AS (
    -- raiz com mais de um dono elegível (somando os membros do grupo) não expande para ninguém
    SELECT COALESCE(ca.canonical_user_id, a.customer_user_id) AS r
      FROM public.carteira_assignments a
      LEFT JOIN public.customer_canonical_alias ca
             ON ca.alias_user_id = a.customer_user_id AND ca.status = 'active'
     WHERE a.eligible IS TRUE
       AND COALESCE(ca.canonical_user_id, a.customer_user_id) IN (SELECT r FROM raizes)
     GROUP BY 1
    HAVING count(DISTINCT a.owner_user_id) > 1
  ), raizes_ok AS (
    SELECT r FROM raizes WHERE r NOT IN (SELECT r FROM ambiguas)
  )
  SELECT c FROM proprias
  UNION
  SELECT r FROM raizes_ok
  UNION
  SELECT ca.alias_user_id
    FROM public.customer_canonical_alias ca
    JOIN raizes_ok ro ON ro.r = ca.canonical_user_id
   WHERE ca.status = 'active';
$function$;

CREATE OR REPLACE FUNCTION private.clientes_contato_visiveis(_uid uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT private.clientes_para_agir(_uid)
  UNION
  SELECT private.clientes_para_agir(c.covered_user_id)
    FROM public.carteira_coverage c
   WHERE _uid IS NOT NULL
     AND c.covering_user_id = _uid
     AND c.active IS TRUE
     AND (c.valid_until IS NULL OR c.valid_until > now());
$function$;

-- ───────────────────────── predicados pontuais ─────────────────────────
CREATE OR REPLACE FUNCTION private.cliente_pode_agir(_customer_user_id uuid, _uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT _uid IS NOT NULL
     AND _customer_user_id IS NOT NULL
     AND (COALESCE(public.has_role(_uid, 'employee'::public.app_role), false)
          OR COALESCE(public.has_role(_uid, 'master'::public.app_role), false))
     AND EXISTS (SELECT 1 FROM private.clientes_para_agir(_uid) x(c) WHERE x.c = _customer_user_id);
$function$;

CREATE OR REPLACE FUNCTION private.cliente_contato_visivel(_customer_user_id uuid, _uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT _uid IS NOT NULL
     AND _customer_user_id IS NOT NULL
     AND (COALESCE(public.has_role(_uid, 'employee'::public.app_role), false)
          OR COALESCE(public.has_role(_uid, 'master'::public.app_role), false))
     AND (COALESCE(private.pode_ver_carteira_completa(_uid), false)
          OR EXISTS (SELECT 1 FROM private.clientes_contato_visiveis(_uid) x(c) WHERE x.c = _customer_user_id));
$function$;

REVOKE ALL ON FUNCTION private.clientes_para_agir(uuid)             FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.clientes_contato_visiveis(uuid)      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.cliente_pode_agir(uuid, uuid)        FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.cliente_contato_visivel(uuid, uuid)  FROM PUBLIC, anon;
-- authenticated mantém EXECUTE: as policies da fatia 3 avaliam estes predicados como o CALLER.
GRANT EXECUTE ON FUNCTION private.clientes_para_agir(uuid)            TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.clientes_contato_visiveis(uuid)     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.cliente_pode_agir(uuid, uuid)       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.cliente_contato_visivel(uuid, uuid) TO authenticated, service_role;

-- ───────────────────────── wrapper público: "pode agir neste cliente" ─────────────────────────
CREATE OR REPLACE FUNCTION public.pode_agir_no_cliente(p_customer_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT COALESCE(private.cliente_pode_agir(p_customer_user_id, (SELECT auth.uid())), false);
$function$;
REVOKE ALL ON FUNCTION public.pode_agir_no_cliente(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pode_agir_no_cliente(uuid) TO authenticated, service_role;

-- ───────────────────────── escritor do desfecho: o MESMO predicado ─────────────────────────
-- Corpo vivo de prod (pg_get_functiondef, 2026-11-24) com só o gate trocado: antes aceitava
-- atribuição NÃO elegível (fornecedor/clone) e divergia do front. venda_contato tinha 0 linhas.
CREATE OR REPLACE FUNCTION public.venda_registrar_contato(p_comprador uuid, p_resultado text, p_motivo text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_comprador uuid;
  v_motivo    text := NULLIF(btrim(p_motivo), '');
  v_dia       date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_id        uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'venda_registrar_contato: sem sessao' USING ERRCODE = '42501';
  END IF;
  IF p_comprador IS NULL THEN
    RAISE EXCEPTION 'venda_registrar_contato: comprador NULL' USING ERRCODE = '22023';
  END IF;
  IF p_resultado IS NULL OR p_resultado NOT IN ('vendeu','vai_pedir','sem_interesse','nao_atendeu') THEN
    RAISE EXCEPTION 'venda_registrar_contato: resultado invalido' USING ERRCODE = '22023';
  END IF;
  IF v_motivo IS NOT NULL AND p_resultado <> 'sem_interesse' THEN
    RAISE EXCEPTION 'venda_registrar_contato: motivo so com sem_interesse' USING ERRCODE = '22023';
  END IF;
  IF length(v_motivo) > 500 THEN
    RAISE EXCEPTION 'venda_registrar_contato: motivo longo demais' USING ERRCODE = '22023';
  END IF;

  -- Predicado único (o mesmo do front): staff atual, atribuição elegível, raiz fiscal resolvida.
  IF NOT (COALESCE(private.cliente_pode_agir(p_comprador, v_uid), false)) THEN
    RAISE EXCEPTION 'venda_registrar_contato: comprador fora da carteira' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
           (SELECT ca.canonical_user_id FROM public.customer_canonical_alias ca
             WHERE ca.alias_user_id = p_comprador AND ca.status = 'active'),
           p_comprador)
    INTO v_comprador;

  -- Último toque do dia vence.
  INSERT INTO public.venda_contato (farmer_user_id, comprador_id, dia, resultado, motivo)
  VALUES (v_uid, v_comprador, v_dia, p_resultado, v_motivo)
  ON CONFLICT (farmer_user_id, comprador_id, dia)
  DO UPDATE SET resultado = EXCLUDED.resultado, motivo = EXCLUDED.motivo, atualizado_em = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END
$function$;
REVOKE ALL ON FUNCTION public.venda_registrar_contato(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venda_registrar_contato(uuid, text, text) TO authenticated, service_role;

-- ───────────────────────── view-gate mascarada do contato ─────────────────────────
-- Owner postgres (BYPASSRLS): o WHERE é a fronteira de LINHA (self exato OU staff); o CASE é a de
-- COLUNA. Filtro/ordem do PostgREST operam sobre a coluna JÁ mascarada (oráculo fechado).
CREATE OR REPLACE VIEW public.v_perfil_contato
WITH (security_invoker = off, security_barrier = true) AS
SELECT p.user_id,
       v.visivel AS contato_visivel,
       CASE WHEN v.visivel THEN p.email    END AS email,
       CASE WHEN v.visivel THEN p.phone    END AS phone,
       CASE WHEN v.visivel THEN p.document END AS document,
       CASE WHEN v.visivel THEN p.cnpj     END AS cnpj,
       -- PJ/PF é IDENTIDADE (não o número): mesma regra de ehCnpjDocumento (14 alfanuméricos).
       length(regexp_replace(upper(coalesce(p.document, '')), '[^0-9A-Z]', '', 'g')) = 14 AS eh_pj
  FROM public.profiles p
 CROSS JOIN LATERAL (
   SELECT (p.user_id = (SELECT auth.uid()))
          OR COALESCE(private.cliente_contato_visivel(p.user_id, (SELECT auth.uid())), false) AS visivel
 ) v
 WHERE (SELECT auth.uid()) IS NOT NULL
   AND (p.user_id = (SELECT auth.uid())
        OR COALESCE((SELECT public.has_role((SELECT auth.uid()), 'employee'::public.app_role)), false)
        OR COALESCE((SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role)), false));

REVOKE ALL ON public.v_perfil_contato FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.v_perfil_contato TO authenticated, service_role;

-- ───────────────────────── Cmd-K ─────────────────────────
-- Nome/razão social casam em qualquer cliente; documento/CNPJ/e-mail só casam (e só voltam) onde o
-- contato é visível — termo que só existe no contato oculto responde igual a termo ausente.
-- Staff (employee/master) nunca aparece como cliente. Erro de autorização LANÇA (42501).
CREATE OR REPLACE FUNCTION public.buscar_clientes_global(p_termo text, p_limite integer DEFAULT 5)
RETURNS TABLE(user_id uuid, name text, razao_social text, contato_visivel boolean, documento text, email text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_termo  text := btrim(coalesce(p_termo, ''));
  v_pat    text;
  v_gestao boolean;
  v_lim    integer := least(greatest(coalesce(p_limite, 5), 1), 20);
BEGIN
  IF v_uid IS NULL
     OR NOT (COALESCE(public.has_role(v_uid, 'employee'::public.app_role), false)
             OR COALESCE(public.has_role(v_uid, 'master'::public.app_role), false)) THEN
    RAISE EXCEPTION 'buscar_clientes_global: sem permissao' USING ERRCODE = '42501';
  END IF;
  -- curingas do ILIKE neutralizados (termo só-curinga não vira match-all)
  v_termo := regexp_replace(v_termo, '[%_\\*]', '', 'g');
  IF length(v_termo) < 2 THEN
    RETURN;
  END IF;
  v_pat := '%' || v_termo || '%';
  v_gestao := COALESCE(private.pode_ver_carteira_completa(v_uid), false);

  RETURN QUERY
  WITH visiveis AS MATERIALIZED (
    SELECT x.c FROM private.clientes_contato_visiveis(v_uid) x(c) WHERE NOT v_gestao
  )
  SELECT p.user_id, p.name, p.razao_social, s.vis,
         CASE WHEN s.vis THEN COALESCE(p.cnpj, p.document) END,
         CASE WHEN s.vis THEN p.email END
    FROM public.profiles p
   CROSS JOIN LATERAL (SELECT (v_gestao OR p.user_id IN (SELECT c FROM visiveis)) AS vis) s
   WHERE COALESCE(p.is_employee, false) = false
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur
                      WHERE ur.user_id = p.user_id
                        AND ur.role IN ('employee'::public.app_role, 'master'::public.app_role))
     AND (p.name ILIKE v_pat
          OR p.razao_social ILIKE v_pat
          OR (s.vis AND (p.document ILIKE v_pat OR p.cnpj ILIKE v_pat OR p.email ILIKE v_pat)))
   ORDER BY (p.name ILIKE v_termo || '%') DESC, p.name, p.user_id
   LIMIT v_lim;
END
$function$;
REVOKE ALL ON FUNCTION public.buscar_clientes_global(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.buscar_clientes_global(text, integer) TO authenticated, service_role;

-- ───────────────────────── postcondição ─────────────────────────
DO $pos$
DECLARE
  v_ro text[];
BEGIN
  IF to_regprocedure('private.cliente_pode_agir(uuid,uuid)') IS NULL
     OR to_regprocedure('private.cliente_contato_visivel(uuid,uuid)') IS NULL
     OR to_regprocedure('public.pode_agir_no_cliente(uuid)') IS NULL
     OR to_regprocedure('public.buscar_clientes_global(text,integer)') IS NULL THEN
    RAISE EXCEPTION 'pos: função ausente';
  END IF;
  IF pg_get_functiondef('public.venda_registrar_contato(uuid,text,text)'::regprocedure) !~ 'private\.cliente_pode_agir'
     OR pg_get_functiondef('public.venda_registrar_contato(uuid,text,text)'::regprocedure) ~ 'LEFT JOIN public\.customer_canonical_alias' THEN
    RAISE EXCEPTION 'pos: venda_registrar_contato sem o predicado único';
  END IF;
  SELECT reloptions INTO v_ro FROM pg_class WHERE oid = 'public.v_perfil_contato'::regclass;
  IF NOT (v_ro @> ARRAY['security_barrier=true'])
     OR NOT (v_ro @> ARRAY['security_invoker=off'] OR v_ro @> ARRAY['security_invoker=false']) THEN
    RAISE EXCEPTION 'pos: v_perfil_contato sem barrier/invoker=off (%)', v_ro;
  END IF;
  IF has_table_privilege('anon', 'public.v_perfil_contato', 'SELECT')
     OR has_table_privilege('authenticated', 'public.v_perfil_contato', 'INSERT')
     OR has_table_privilege('authenticated', 'public.v_perfil_contato', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.v_perfil_contato', 'SELECT') THEN
    RAISE EXCEPTION 'pos: ACL de v_perfil_contato errada';
  END IF;
  IF has_function_privilege('anon', 'public.pode_agir_no_cliente(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.buscar_clientes_global(text,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.venda_registrar_contato(uuid,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'private.cliente_contato_visivel(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.buscar_clientes_global(text,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'pos: ACL de função errada';
  END IF;
END
$pos$;
