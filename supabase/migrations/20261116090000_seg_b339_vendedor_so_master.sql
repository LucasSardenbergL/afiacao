-- ============================================================
-- seg_b339_vendedor_so_master — achado b339bb5b do scanner Lovable Security (2026-11-16)
--
-- Decisão do founder: "quem troca o vendedor responsável pelo cliente sou apenas eu". O vendedor de
-- omie_customer_account_map.omie_codigo_vendedor decide a DONA da carteira: o carteira-rebuild
-- deriva carteira_assignments.owner_user_id dele (× omie_vendedor_map). carteira_assignments e
-- omie_vendedor_map já eram só-master para JWT. O mapa não: o employee gravava o vendedor por três
-- vias, conferidas na PROD via psql-ro e no código:
--   (1) a policy "Staff can manage account map" (FOR ALL para master OU employee), escrita direta;
--   (2) a RPC register_carteira_member (SECURITY INVOKER, EXECUTE para authenticated), chamada
--       pela tela AdminApprovals com o vendedor que o browser manda;
--   (3) a edge omie-cliente `criar_perfil_local`, que repassa `codigo_vendedor` do body com
--       service_role. Esta vem no código da edge (v. versao.ts), não aqui.
--
-- O conserto, sem quebrar o sync (service_role) nem a aprovação de cadastro pelo employee:
--   · a RPC vira SECURITY DEFINER com gate de papel. Servidor (service_role, ou sem JWT: cron e SQL
--     Editor) e master gravam o vendedor como antes. O employee segue admitindo o cliente (código
--     Omie, ledger), mas o vendedor que ele manda é IGNORADO: o vendedor vem do Omie, pelo
--     omie-analytics-sync, que é a fonte de verdade. Customer e qualquer outro → 42501;
--   · a policy ALL do staff vira duas: master ALL e staff SELECT (a leitura do employee continua);
--   · o ledger da carteira (carteira_membership_ledger) também vira master ALL + staff SELECT, e a RPC
--     não deixa o employee renovar o TTL (updated_at) nem trocar o código de um vínculo existente — os
--     achados P1 das revisões Codex. A edge omie-cliente chama a RPC com o JWT do chamador quando ele
--     não é master, para que esse gate valha também pela edge;
--   · TRUNCATE sai de anon/authenticated nas 4 tabelas da posse (TRUNCATE ignora a RLS) e a escrita
--     de anon sai do mapa e da carteira (anon nunca teve policy de escrita; é defesa em camadas).
--
-- CREATE OR REPLACE sobre o corpo da PROD (pg_get_functiondef, 2026-11-16), idêntico ao da migration
-- 20260821192817 + o gate. search_path passa a '' com tudo qualificado. REPLACE preserva o ACL, e
-- ele é reemitido nomeando os papéis. Idempotente. Postcondição no fim.
-- Sem BEGIN/COMMIT: a transação é do envelope `db:aplicar` (no SQL Editor, rode o arquivo inteiro).
-- ============================================================

CREATE OR REPLACE FUNCTION public.register_carteira_member(p_user_id uuid, p_account text, p_omie_codigo_cliente bigint, p_omie_codigo_vendedor bigint DEFAULT NULL::bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_papel    text := auth.role();
  v_vendedor bigint := p_omie_codigo_vendedor;
  v_restrito boolean := false;  -- true = employee: admite cliente, mas não mexe em posse
  v_linhas integer;
BEGIN
  -- Gate (b339bb5b). DEFINER ignora a RLS, então o papel é decidido AQUI, antes de qualquer escrita.
  IF v_papel = 'service_role' OR (v_uid IS NULL AND v_papel IS NULL) THEN
    NULL;  -- servidor: edges com service_role, cron, SQL Editor
  ELSIF v_uid IS NOT NULL AND public.has_role(v_uid, 'master'::public.app_role) THEN
    NULL;  -- o founder reatribui
  ELSIF v_uid IS NOT NULL AND public.has_role(v_uid, 'employee'::public.app_role) THEN
    v_vendedor := NULL;  -- admite o cliente, mas não escolhe o vendedor (COALESCE preserva o atual)
    v_restrito := true;
  ELSE
    RAISE EXCEPTION 'register_carteira_member: exige equipe interna'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL OR p_omie_codigo_cliente IS NULL THEN
    RAISE EXCEPTION 'register_carteira_member: user_id e omie_codigo_cliente são obrigatórios'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- Membership (acumulador). DO NOTHING preserva first_seen_at E identity_state de quem já é membro:
  -- um quarantinado (ambiguous/conflict) NÃO volta a verified por re-chamada.
  INSERT INTO public.carteira_membership_ledger (user_id, identity_state, first_seen_at, source, updated_at)
  VALUES (p_user_id, 'verified', now(), 'rpc', now())
  ON CONFLICT (user_id) DO NOTHING;

  -- Proof account-correta. `source='rpc'` (NÃO 'manual'): diz a verdade sobre a procedência e mantém a
  -- linha alcançável pelo delete de ambiguidade do sync — 'manual' é reservado a override HUMANO, que é
  -- o único que merece imunidade ao fail-closed.
  -- `p_account` é validado pelo CHECK `chk_ocam_account` ('oben'|'colacor'|'colacor_sc'): o slug INTERNO
  -- do sync ('vendas'|'servicos'|'colacor_vendas') levanta 23514 em vez de gravar conta errada.
  -- Vendedor ausente NUNCA é fabricado como 0 — COALESCE preserva o vendedor já conhecido.
  INSERT INTO public.omie_customer_account_map (
    user_id, account, omie_codigo_cliente, omie_codigo_vendedor, source, evidence_document_normalized, updated_at
  )
  VALUES (
    p_user_id, p_account, p_omie_codigo_cliente, v_vendedor, 'rpc', NULL, now()
  )
  ON CONFLICT (user_id, account) DO UPDATE SET
    omie_codigo_cliente  = EXCLUDED.omie_codigo_cliente,
    omie_codigo_vendedor = COALESCE(EXCLUDED.omie_codigo_vendedor, omie_customer_account_map.omie_codigo_vendedor),
    -- NÃO rebaixa um override humano: se a linha já é 'manual', permanece 'manual'.
    source               = CASE WHEN omie_customer_account_map.source = 'manual' THEN 'manual' ELSE 'rpc' END,
    -- PR-2/A2: esta RPC não prova identidade por documento — não pode deixar a prova de outro writer
    -- (possivelmente de OUTRO código) colada na linha que ela acabou de reescrever.
    evidence_document_normalized = NULL,
    -- b339bb5b (Codex, 2ª/3ª rodada): `updated_at` é o TTL da view omie_customer_account_map_fresco
    -- (7 dias), de onde o carteira-rebuild deriva a dona. O employee NÃO renova: recolocaria na view um
    -- vendedor vencido e o rebuild trocaria a dona (Hunter → A). Servidor e master renovam como antes
    -- (revalidação legítima, inclusive sem vendedor).
    updated_at           = CASE WHEN v_restrito THEN omie_customer_account_map.updated_at ELSE now() END
  -- Employee não troca o código Omie de um vínculo que já existe (Codex, 3ª/4ª rodada): permutar códigos
  -- entre clientes faz o sync marcar os incumbentes como `conflict` e o rebuild mudar a dona. A trava fica
  -- no próprio ON CONFLICT, que já segura a linha, sem a corrida de um SELECT antes.
  WHERE NOT v_restrito
     OR omie_customer_account_map.omie_codigo_cliente = EXCLUDED.omie_codigo_cliente;
  GET DIAGNOSTICS v_linhas = ROW_COUNT;
  IF v_linhas = 0 THEN
    RAISE EXCEPTION 'register_carteira_member: só o master troca o código Omie de um vínculo existente'
      USING ERRCODE = '42501';
  END IF;
END
$function$;
REVOKE ALL ON FUNCTION public.register_carteira_member(uuid, text, bigint, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_carteira_member(uuid, text, bigint, bigint) TO authenticated, service_role;

-- Policies do mapa: a escrita é só do master; a leitura do staff fica.
DROP POLICY IF EXISTS "Staff can manage account map" ON public.omie_customer_account_map;
DROP POLICY IF EXISTS "Master manage account map" ON public.omie_customer_account_map;
CREATE POLICY "Master manage account map" ON public.omie_customer_account_map FOR ALL TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role)))
  WITH CHECK ((SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role)));
DROP POLICY IF EXISTS "Staff view account map" ON public.omie_customer_account_map;
CREATE POLICY "Staff view account map" ON public.omie_customer_account_map FOR SELECT TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role))
         OR (SELECT public.has_role((SELECT auth.uid()), 'employee'::public.app_role)));

-- Ledger da carteira (Codex, 2ª rodada): a policy ALL do employee deixava excluir um clone ou mudar o
-- identity_state e, com o rebuild, trocar a dona sem tocar nas tabelas acima. Ninguém grava no ledger
-- com JWT (só service_role: omie-analytics-sync; a RPC acima, agora DEFINER; e o trigger SECDEF
-- tg_omie_clientes_to_ledger). A escrita vai para o master; a leitura do staff fica.
DROP POLICY IF EXISTS "Staff can manage carteira membership ledger" ON public.carteira_membership_ledger;
DROP POLICY IF EXISTS "Master manage carteira membership ledger" ON public.carteira_membership_ledger;
CREATE POLICY "Master manage carteira membership ledger" ON public.carteira_membership_ledger FOR ALL TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role)))
  WITH CHECK ((SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role)));
DROP POLICY IF EXISTS "Staff view carteira membership ledger" ON public.carteira_membership_ledger;
CREATE POLICY "Staff view carteira membership ledger" ON public.carteira_membership_ledger FOR SELECT TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role))
         OR (SELECT public.has_role((SELECT auth.uid()), 'employee'::public.app_role)));

-- TRUNCATE ignora a RLS: sai dos papéis de client nas 3 tabelas da posse. Anon nunca escreve aqui.
REVOKE TRUNCATE ON TABLE public.omie_customer_account_map, public.carteira_assignments, public.omie_vendedor_map,
  public.carteira_membership_ledger
  FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.omie_customer_account_map, public.carteira_assignments, public.omie_vendedor_map,
  public.carteira_membership_ledger
  FROM PUBLIC, anon;

-- ── Postcondição ──────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_t text;
BEGIN
  IF NOT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=""']
            FROM pg_proc p WHERE p.oid = 'public.register_carteira_member(uuid,text,bigint,bigint)'::regprocedure) THEN
    RAISE EXCEPTION 'POST: register_carteira_member sem SECURITY DEFINER ou sem search_path vazio';
  END IF;
  IF has_function_privilege('anon', 'public.register_carteira_member(uuid,text,bigint,bigint)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.register_carteira_member(uuid,text,bigint,bigint)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.register_carteira_member(uuid,text,bigint,bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POST: ACL de register_carteira_member errada (anon não; authenticated e service_role sim)';
  END IF;
  IF position('v_vendedor := NULL' IN pg_get_functiondef('public.register_carteira_member(uuid,text,bigint,bigint)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POST: register_carteira_member sem o ramo que ignora o vendedor do employee';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'omie_customer_account_map'
              AND cmd <> 'SELECT' AND coalesce(qual, '') || coalesce(with_check, '') ~ 'employee') THEN
    RAISE EXCEPTION 'POST: ainda há policy de ESCRITA do employee em omie_customer_account_map';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'omie_customer_account_map'
                  AND policyname = 'Staff view account map' AND cmd = 'SELECT') THEN
    RAISE EXCEPTION 'POST: leitura do staff no mapa sumiu';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'carteira_membership_ledger'
              AND cmd <> 'SELECT' AND coalesce(qual, '') || coalesce(with_check, '') ~ 'employee') THEN
    RAISE EXCEPTION 'POST: ainda há policy de ESCRITA do employee em carteira_membership_ledger';
  END IF;
  IF position('WHEN v_restrito THEN omie_customer_account_map.updated_at' IN pg_get_functiondef('public.register_carteira_member(uuid,text,bigint,bigint)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POST: register_carteira_member deixa o employee renovar o TTL';
  END IF;
  IF position('só o master troca o código Omie' IN pg_get_functiondef('public.register_carteira_member(uuid,text,bigint,bigint)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'POST: register_carteira_member deixa o employee trocar o código de vínculo existente';
  END IF;

  FOREACH v_t IN ARRAY ARRAY['omie_customer_account_map', 'carteira_assignments', 'omie_vendedor_map', 'carteira_membership_ledger'] LOOP
    IF has_table_privilege('anon', 'public.' || v_t, 'TRUNCATE')
       OR has_table_privilege('authenticated', 'public.' || v_t, 'TRUNCATE')
       OR has_table_privilege('anon', 'public.' || v_t, 'INSERT')
       OR has_table_privilege('anon', 'public.' || v_t, 'UPDATE')
       OR has_table_privilege('anon', 'public.' || v_t, 'DELETE') THEN
      RAISE EXCEPTION 'POST: % ainda com TRUNCATE para client ou escrita para anon', v_t;
    END IF;
  END LOOP;

  RAISE NOTICE 'POST-OK seg_b339_vendedor_so_master';
END
$post$;
