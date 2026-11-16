-- ============================================================
-- seg_b339_vinculo_conferido — risco residual do achado b339bb5b (scanner Lovable Security)
--
-- O #3912 deixou o employee admitir um vínculo NOVO de cliente com um código Omie LIVRE. É o que
-- permite aprovar cadastro e vender para cliente novo, mas o código vinha do browser (AdminApprovals)
-- ou do body (omie-cliente `criar_perfil_local`). Se ele for o código que a Omie usa para OUTRO
-- cliente V, o sync passa a ver o código como do cliente novo, deixa de revalidar V e, quando o TTL
-- da view fresca vence, a dona de V cai para Hunter. O employee não escolhe a dona, mas faz V perdê-la.
--
-- Conserto: o vínculo novo do employee só passa a valer depois que o SERVIDOR confere o código na Omie.
--   · register_carteira_member, ramo employee: NÃO grava mais nada. Vínculo novo → 42501 (passa pela
--     conferência); código diferente do vínculo existente → 42501 (só o master troca, como no #3912);
--     mesmo código → retorna sem escrita (Codex: o upsert de antes reclassificava `source` e APAGAVA a
--     evidência de documento, o que neutralizava a revogação do sync). Servidor e master como estavam.
--   · admitir_vinculo_conferido (nova, SECURITY DEFINER, EXECUTE só service_role): a edge omie-cliente
--     chama depois de ler, NA OMIE, o documento do código (ConsultarCliente com a credencial da conta).
--     Só admite se o CPF/CNPJ da Omie é o do cadastro e se nenhum OUTRO cadastro tem esse documento
--     (o customer edita o próprio `document`; sem esta trava ele copiaria o de V). Recusa com SQLSTATE
--     própria e motivo legível. Grava o documento conferido em evidence_document_normalized (o
--     `client_revogado` do sync revoga se o documento deixar de sustentar o vínculo). Não escolhe
--     vendedor (o omie-analytics-sync grava o da Omie), não renova TTL, não troca código existente.
--   · Sem resposta da Omie, a edge não chama esta função: o vínculo fica pendente (não existe) e o erro
--     aparece. Ausente ≠ ok.
--
-- CREATE OR REPLACE sobre o corpo da PROD (pg_get_functiondef em 2026-11-16, igual ao da migration
-- 20261116090000) + o ramo do employee. REPLACE preserva o ACL, e ele é reemitido nomeando os papéis.
-- Idempotente. Postcondição no fim. Sem BEGIN/COMMIT: a transação é do envelope `db:aplicar` (no SQL
-- Editor, rode o arquivo inteiro).
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
  v_codigo_atual bigint;
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

  -- Residual do b339bb5b: o employee não grava vínculo por esta RPC. O vínculo NOVO só vale com o
  -- código conferido na Omie pelo servidor (edge omie-cliente → admitir_vinculo_conferido). Sobre o
  -- vínculo que já existe com o MESMO código, a chamada é aceita e não escreve nada.
  IF v_restrito THEN
    SELECT m.omie_codigo_cliente INTO v_codigo_atual
      FROM public.omie_customer_account_map m
     WHERE m.user_id = p_user_id AND m.account = p_account;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'register_carteira_member: vínculo novo do employee passa pela conferência do código na Omie'
        USING ERRCODE = '42501',
              HINT = 'A edge omie-cliente confere o CPF/CNPJ do código na Omie antes de admitir.';
    ELSIF v_codigo_atual IS DISTINCT FROM p_omie_codigo_cliente THEN
      RAISE EXCEPTION 'register_carteira_member: só o master troca o código Omie de um vínculo existente'
        USING ERRCODE = '42501';
    END IF;
    RETURN;  -- employee: mesmo código, sem escrita (não apaga evidência, não reclassifica source)
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
    -- (revalidação legítima, inclusive sem vendedor). Defesa em camadas: o employee já saiu acima.
    updated_at           = CASE WHEN v_restrito THEN omie_customer_account_map.updated_at ELSE now() END
  -- Employee não troca o código Omie de um vínculo que já existe (Codex, 3ª/4ª rodada). Defesa em
  -- camadas: o ramo do employee já retornou acima, sem escrita.
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

-- ── A admissão conferida ──────────────────────────────────────────────────
-- Chamada SÓ pelo servidor (edge omie-cliente com service_role), com o documento que a OMIE devolveu
-- para o código — nunca o do body ou do browser. SQLSTATEs próprias, para a edge traduzir o motivo:
--   VC001  o CPF/CNPJ do código na Omie não é o do cadastro (o código é de OUTRO cliente)
--   VC002  outro cadastro tem o mesmo CPF/CNPJ (clone ou documento copiado; só o master resolve)
--   VC003  cadastro sem CPF/CNPJ, ou a Omie não devolveu documento para o código
--   42501  o vínculo do cadastro nesta conta já é de OUTRO código (só o master troca)
--   23505  o código já está vinculado a OUTRO cadastro nesta conta (uq_ocam_codigo_account)
-- Devolve 'admitido' ou 'ja_vinculado' (mesmo código: não toca na linha nem renova o TTL).
CREATE OR REPLACE FUNCTION public.admitir_vinculo_conferido(p_user_id uuid, p_account text, p_omie_codigo_cliente bigint, p_documento_omie text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid          uuid := auth.uid();
  v_papel        text := auth.role();
  v_doc_omie     text;
  v_doc_local    text;
  v_codigo_atual bigint;
BEGIN
  -- Só servidor. O ACL já fecha authenticated/anon; esta é a 2ª camada (DEFINER ignora a RLS).
  IF NOT (v_papel = 'service_role' OR (v_uid IS NULL AND v_papel IS NULL)) THEN
    RAISE EXCEPTION 'admitir_vinculo_conferido: só o servidor admite vínculo conferido'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_account IS NULL OR p_omie_codigo_cliente IS NULL THEN
    RAISE EXCEPTION 'admitir_vinculo_conferido: user_id, account e omie_codigo_cliente são obrigatórios'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  v_doc_omie := public.normalizar_documento(p_documento_omie);
  IF v_doc_omie IS NULL OR length(v_doc_omie) < 11 THEN
    RAISE EXCEPTION 'A Omie não devolveu CPF/CNPJ para o código %: o vínculo não pode ser conferido', p_omie_codigo_cliente
      USING ERRCODE = 'VC003';
  END IF;

  -- FOR UPDATE antes de ler: o documento do cadastro não muda entre a conferência e o INSERT abaixo.
  SELECT public.normalizar_documento(p.document) INTO v_doc_local
    FROM public.profiles p
   WHERE p.user_id = p_user_id
     FOR UPDATE;
  IF v_doc_local IS NULL OR length(v_doc_local) < 11 THEN
    RAISE EXCEPTION 'O cadastro não tem CPF/CNPJ: o vínculo com o código % não pode ser conferido', p_omie_codigo_cliente
      USING ERRCODE = 'VC003';
  END IF;
  IF v_doc_local <> v_doc_omie THEN
    RAISE EXCEPTION 'O código % pertence, na Omie, a outro CPF/CNPJ, e não ao deste cadastro: vínculo recusado', p_omie_codigo_cliente
      USING ERRCODE = 'VC001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles p
              WHERE p.user_id <> p_user_id
                AND public.normalizar_documento(p.document) = v_doc_local) THEN
    RAISE EXCEPTION 'Outro cadastro tem o mesmo CPF/CNPJ: o vínculo com o código % fica para o master resolver', p_omie_codigo_cliente
      USING ERRCODE = 'VC002';
  END IF;

  SELECT m.omie_codigo_cliente INTO v_codigo_atual
    FROM public.omie_customer_account_map m
   WHERE m.user_id = p_user_id AND m.account = p_account
     FOR UPDATE;
  IF FOUND THEN
    IF v_codigo_atual = p_omie_codigo_cliente THEN
      RETURN 'ja_vinculado';
    END IF;
    RAISE EXCEPTION 'O cadastro já está vinculado a outro código Omie nesta conta: só o master troca'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    INSERT INTO public.carteira_membership_ledger (user_id, identity_state, first_seen_at, source, updated_at)
    VALUES (p_user_id, 'verified', now(), 'rpc', now())
    ON CONFLICT (user_id) DO NOTHING;

    -- Sem vendedor (o omie-analytics-sync grava o da Omie), com o documento CONFERIDO como evidência.
    INSERT INTO public.omie_customer_account_map (
      user_id, account, omie_codigo_cliente, omie_codigo_vendedor, source, evidence_document_normalized, updated_at
    )
    VALUES (p_user_id, p_account, p_omie_codigo_cliente, NULL, 'rpc', v_doc_omie, now());
  EXCEPTION WHEN unique_violation THEN
    -- Chamada idêntica concorrente venceu a corrida: é o mesmo vínculo. Qualquer outra colisão (o código
    -- é de OUTRO cadastro) re-lança o 23505 — nunca vira 'ja_vinculado'.
    IF EXISTS (SELECT 1 FROM public.omie_customer_account_map m
                WHERE m.user_id = p_user_id AND m.account = p_account
                  AND m.omie_codigo_cliente = p_omie_codigo_cliente) THEN
      RETURN 'ja_vinculado';
    END IF;
    RAISE;
  END;

  RETURN 'admitido';
END
$function$;
REVOKE ALL ON FUNCTION public.admitir_vinculo_conferido(uuid, text, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admitir_vinculo_conferido(uuid, text, bigint, text) TO service_role;

-- ── Postcondição ──────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_def text := pg_get_functiondef('public.register_carteira_member(uuid,text,bigint,bigint)'::regprocedure);
  v_adm regprocedure := 'public.admitir_vinculo_conferido(uuid,text,bigint,text)'::regprocedure;
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
  IF position('v_vendedor := NULL' IN v_def) = 0
     OR position('só o master troca o código Omie' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POST: register_carteira_member perdeu uma trava do #3912';
  END IF;
  IF position('vínculo novo do employee passa pela conferência' IN v_def) = 0
     OR position('RETURN;  -- employee: mesmo código, sem escrita' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POST: register_carteira_member ainda deixa o employee gravar vínculo';
  END IF;

  IF NOT (SELECT p.prosecdef AND p.proconfig = ARRAY['search_path=""'] FROM pg_proc p WHERE p.oid = v_adm) THEN
    RAISE EXCEPTION 'POST: admitir_vinculo_conferido sem SECURITY DEFINER ou sem search_path vazio';
  END IF;
  IF has_function_privilege('anon', v_adm, 'EXECUTE')
     OR has_function_privilege('authenticated', v_adm, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_adm, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST: ACL de admitir_vinculo_conferido errada (só service_role)';
  END IF;

  RAISE NOTICE 'POST-OK seg_b339_vinculo_conferido';
END
$post$;
