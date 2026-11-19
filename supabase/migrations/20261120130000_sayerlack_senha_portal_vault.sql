-- ============================================================
-- Senha do portal Sayerlack no Vault + rotação automática (escritor único)
--
-- Incidente: pedido 4505 parou em 2026-11-19 03:00 com PASSWORD_CHANGE_REQUIRED — a senha do
-- usuário do portal expirou no SSO TOTVS. A senha vivia só no env SAYERLACK_PORTAL_PASS, que
-- edge nenhuma consegue regravar: toda expiração parava os pedidos até o founder agir.
--
-- Fonte da verdade passa a ser o Vault (o env vira só BOOTSTRAP, enquanto não há senha ativa):
--   sayerlack_portal_pass           senha ATIVA; description = id da rodada que a provou
--   sayerlack_portal_pass_pendente  candidata da rodada; description = id da rodada DONA
-- Toda mutação da candidata é condicionada à rodada dona (Codex P0: uma rodada atrasada nunca
-- sobrescreve/promove/descarta a candidata de outra).
--
-- Máquina de estados de `sayerlack_senha_rotacao` (no máximo UMA aberta — índice único parcial):
--   solicitada → em_andamento(etapa) → concluida | falhou | ambigua → resolvida_manual
--   aberta = solicitada|em_andamento|ambigua  ⇒ as 4 edges NÃO logam (sem rajada de login errado)
--   etapa 'post_pode_ter_saido' é gravada ANTES do clique em Trocar: daí em diante a rodada
--   nunca mais faz POST — só reconcilia a candidata (TTL nunca autoriza outro POST).
--
-- Acesso: tudo SECURITY DEFINER, EXECUTE só service_role. Log sem senha; staff só lê o log.
-- ============================================================

BEGIN;

-- ---------- log/estado da rotação (NUNCA contém senha) ----------
CREATE TABLE IF NOT EXISTS public.sayerlack_senha_rotacao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'solicitada'
    CHECK (status IN ('solicitada', 'em_andamento', 'concluida', 'falhou', 'ambigua', 'resolvida_manual')),
  etapa text,
  gatilho text,
  erro text,
  tentativas_reconciliacao integer NOT NULL DEFAULT 0,
  email_pendente boolean NOT NULL DEFAULT false,
  email_enviado_em timestamptz,
  pedidos_reenfileirados bigint[],
  diagnostico jsonb,
  solicitado_em timestamptz NOT NULL DEFAULT now(),
  iniciado_em timestamptz,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  concluido_em timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sayerlack_senha_rotacao_aberta
  ON public.sayerlack_senha_rotacao ((true))
  WHERE status IN ('solicitada', 'em_andamento', 'ambigua');

CREATE INDEX IF NOT EXISTS idx_sayerlack_senha_rotacao_solicitado
  ON public.sayerlack_senha_rotacao (solicitado_em DESC);

ALTER TABLE public.sayerlack_senha_rotacao ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sayerlack_senha_rotacao_select_staff" ON public.sayerlack_senha_rotacao;
CREATE POLICY "sayerlack_senha_rotacao_select_staff"
  ON public.sayerlack_senha_rotacao
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role IN ('employee'::public.app_role, 'master'::public.app_role)
    )
  );

REVOKE ALL ON public.sayerlack_senha_rotacao FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sayerlack_senha_rotacao TO authenticated;
GRANT ALL ON public.sayerlack_senha_rotacao TO service_role;

-- ---------- helpers internos do Vault (sem EXECUTE para ninguém além do dono) ----------
CREATE OR REPLACE FUNCTION public._sayerlack_vault_ler(p_nome text)
RETURNS TABLE (valor text, rotacao text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $fn$
  SELECT decrypted_secret, description FROM vault.decrypted_secrets WHERE name = p_nome;
$fn$;

CREATE OR REPLACE FUNCTION public._sayerlack_vault_gravar(p_nome text, p_valor text, p_rotacao text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = p_nome;
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(p_valor, p_nome, p_rotacao);
  ELSE
    PERFORM vault.update_secret(v_id, p_valor, p_nome, p_rotacao);
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public._sayerlack_vault_ler(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._sayerlack_vault_gravar(text, text, text) FROM PUBLIC, anon, authenticated, service_role;

-- ---------- consumidores (as 4 edges): credencial ou bloqueio ----------
-- origem: 'vault' (use `senha`) · 'env_bootstrap' (Vault sem ativa: use o env) · NULL com `bloqueio` (NÃO logue).
CREATE OR REPLACE FUNCTION public.sayerlack_senha_portal_credencial()
RETURNS TABLE (senha text, origem text, bloqueio text, rotacao_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  v_aberta public.sayerlack_senha_rotacao%ROWTYPE;
  v_ativa text;
BEGIN
  SELECT * INTO v_aberta FROM public.sayerlack_senha_rotacao
   WHERE status IN ('solicitada', 'em_andamento', 'ambigua') LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT NULL::text, NULL::text, ('rotacao_' || v_aberta.status)::text, v_aberta.id;
    RETURN;
  END IF;
  SELECT valor INTO v_ativa FROM public._sayerlack_vault_ler('sayerlack_portal_pass');
  IF v_ativa IS NOT NULL THEN
    RETURN QUERY SELECT v_ativa, 'vault'::text, NULL::text, NULL::uuid;
  ELSE
    RETURN QUERY SELECT NULL::text, 'env_bootstrap'::text, NULL::text, NULL::uuid;
  END IF;
END
$fn$;

-- Pedido durável de rotação (idempotente: devolve a rodada aberta se já houver).
CREATE OR REPLACE FUNCTION public.sayerlack_senha_portal_solicitar(p_gatilho text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM public.sayerlack_senha_rotacao
   WHERE status IN ('solicitada', 'em_andamento', 'ambigua') LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  BEGIN
    INSERT INTO public.sayerlack_senha_rotacao (status, gatilho)
    VALUES ('solicitada', left(p_gatilho, 200))
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT id INTO v_id FROM public.sayerlack_senha_rotacao
     WHERE status IN ('solicitada', 'em_andamento', 'ambigua') LIMIT 1;
  END;
  RETURN v_id;
END
$fn$;

-- ---------- rotacionador (escritor único) ----------
-- Claim: solicitada → em_andamento. Também re-assume em_andamento ÓRFÃ que ainda NÃO chegou ao POST
-- (etapa NULL/candidata_gravada e parada há > 10 min). Órfã que pode ter feito POST vira 'ambigua'.
-- Devolve a rodada (com o modo) ou nada.
CREATE OR REPLACE FUNCTION public.sayerlack_senha_portal_assumir()
RETURNS TABLE (rotacao_id uuid, modo text, senha_atual text, origem_atual text, candidata text, tentativas_reconciliacao integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  r public.sayerlack_senha_rotacao%ROWTYPE;
  v_ativa text;
  v_cand text;
  v_cand_rot text;
BEGIN
  SELECT * INTO r FROM public.sayerlack_senha_rotacao
   WHERE status IN ('solicitada', 'em_andamento', 'ambigua')
   LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF r.status = 'em_andamento' THEN
    IF r.atualizado_em > now() - interval '10 minutes' THEN
      RETURN;  -- outra execução viva está com ela
    END IF;
    IF coalesce(r.etapa, '') NOT IN ('', 'assumida', 'candidata_gravada') THEN
      UPDATE public.sayerlack_senha_rotacao
         SET status = 'ambigua', etapa = 'orfa_apos_post', atualizado_em = now(),
             erro = coalesce(erro, 'Execucao anterior parou depois que o POST de troca pode ter saido')
       WHERE id = r.id;
      r.status := 'ambigua';
    END IF;
  END IF;

  SELECT valor INTO v_ativa FROM public._sayerlack_vault_ler('sayerlack_portal_pass');
  SELECT valor, rotacao INTO v_cand, v_cand_rot FROM public._sayerlack_vault_ler('sayerlack_portal_pass_pendente');
  IF v_cand_rot IS DISTINCT FROM r.id::text THEN
    v_cand := NULL;  -- candidata de OUTRA rodada não é desta
  END IF;

  IF r.status = 'ambigua' THEN
    UPDATE public.sayerlack_senha_rotacao AS t
       SET atualizado_em = now(), tentativas_reconciliacao = t.tentativas_reconciliacao + 1
     WHERE t.id = r.id;
    RETURN QUERY SELECT r.id, 'reconciliar'::text, v_ativa,
      CASE WHEN v_ativa IS NULL THEN 'env_bootstrap' ELSE 'vault' END, v_cand, r.tentativas_reconciliacao + 1;
    RETURN;
  END IF;

  UPDATE public.sayerlack_senha_rotacao
     SET status = 'em_andamento', etapa = 'assumida', iniciado_em = coalesce(iniciado_em, now()), atualizado_em = now()
   WHERE id = r.id;
  RETURN QUERY SELECT r.id, 'trocar'::text, v_ativa,
    CASE WHEN v_ativa IS NULL THEN 'env_bootstrap' ELSE 'vault' END, NULL::text, r.tentativas_reconciliacao;
END
$fn$;

CREATE OR REPLACE FUNCTION public.sayerlack_senha_portal_etapa(p_rotacao uuid, p_etapa text, p_diagnostico jsonb DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
BEGIN
  UPDATE public.sayerlack_senha_rotacao
     SET etapa = p_etapa, atualizado_em = now(),
         diagnostico = coalesce(p_diagnostico, diagnostico)
   WHERE id = p_rotacao AND status = 'em_andamento';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ROTACAO_NAO_DONA: rodada % nao esta em andamento', p_rotacao USING ERRCODE = 'P0001';
  END IF;
END
$fn$;

-- Grava a candidata (dona = p_rotacao) ANTES do POST. Só a rodada em andamento grava.
CREATE OR REPLACE FUNCTION public.sayerlack_senha_portal_gravar_candidata(p_rotacao uuid, p_senha text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
BEGIN
  IF p_senha IS NULL OR length(p_senha) < 8 THEN
    RAISE EXCEPTION 'SENHA_INVALIDA: a candidata precisa de ao menos 8 caracteres' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.sayerlack_senha_rotacao
   WHERE id = p_rotacao AND status = 'em_andamento' AND etapa = 'assumida' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ROTACAO_NAO_DONA: rodada % nao pode gravar candidata', p_rotacao USING ERRCODE = 'P0001';
  END IF;
  PERFORM public._sayerlack_vault_gravar('sayerlack_portal_pass_pendente', p_senha, p_rotacao::text);
  UPDATE public.sayerlack_senha_rotacao SET etapa = 'candidata_gravada', atualizado_em = now() WHERE id = p_rotacao;
END
$fn$;

-- Promove a candidata DESTA rodada a ativa, apaga a candidata, fecha a rodada como concluída,
-- marca o e-mail como pendente e reenfileira (uma vez, por CAS) os pedidos que pararam SÓ por
-- troca de senha antes de qualquer clique de finalização. Tudo na mesma transação.
CREATE OR REPLACE FUNCTION public.sayerlack_senha_portal_promover(p_rotacao uuid)
RETURNS bigint[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  v_cand text;
  v_cand_rot text;
  v_ids bigint[];
BEGIN
  PERFORM 1 FROM public.sayerlack_senha_rotacao
   WHERE id = p_rotacao AND status IN ('em_andamento', 'ambigua') FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ROTACAO_NAO_DONA: rodada % nao esta aberta', p_rotacao USING ERRCODE = 'P0001';
  END IF;
  SELECT valor, rotacao INTO v_cand, v_cand_rot FROM public._sayerlack_vault_ler('sayerlack_portal_pass_pendente');
  IF v_cand IS NULL OR v_cand_rot IS DISTINCT FROM p_rotacao::text THEN
    RAISE EXCEPTION 'SEM_CANDIDATA: nao ha candidata da rodada %', p_rotacao USING ERRCODE = 'P0002';
  END IF;

  PERFORM public._sayerlack_vault_gravar('sayerlack_portal_pass', v_cand, p_rotacao::text);
  DELETE FROM vault.secrets WHERE name = 'sayerlack_portal_pass_pendente';

  WITH ultima AS (
    SELECT DISTINCT ON (t.pedido_id) t.pedido_id, t.evidence
      FROM public.pedidos_portal_tentativas t
     ORDER BY t.pedido_id, t.iniciado_em DESC
  ), alvo AS (
    SELECT p.id
      FROM public.pedido_compra_sugerido p
      JOIN ultima u ON u.pedido_id = p.id
     WHERE p.status_envio_portal = 'erro_nao_retentavel'
       AND p.portal_protocolo IS NULL
       AND u.evidence->>'erroTipo' = 'PASSWORD_CHANGE_REQUIRED'
       AND u.evidence->>'efetivarAttempted' = 'false'
  ), upd AS (
    UPDATE public.pedido_compra_sugerido p
       SET status_envio_portal = 'pendente_envio_portal',
           portal_tentativas = 0,
           portal_proximo_retry_em = NULL,
           portal_erro = NULL
      FROM alvo
     WHERE p.id = alvo.id
       AND p.status_envio_portal = 'erro_nao_retentavel'
    RETURNING p.id
  )
  SELECT coalesce(array_agg(id ORDER BY id), ARRAY[]::bigint[]) INTO v_ids FROM upd;

  UPDATE public.sayerlack_senha_rotacao
     SET status = 'concluida', etapa = 'promovida', email_pendente = true,
         pedidos_reenfileirados = v_ids, concluido_em = now(), atualizado_em = now(), erro = NULL
   WHERE id = p_rotacao;
  RETURN v_ids;
END
$fn$;

-- Troca REJEITADA de forma inequívoca pelo portal: descarta a candidata desta rodada e fecha como falhou.
CREATE OR REPLACE FUNCTION public.sayerlack_senha_portal_falhar(p_rotacao uuid, p_erro text, p_descartar boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
BEGIN
  PERFORM 1 FROM public.sayerlack_senha_rotacao
   WHERE id = p_rotacao AND status IN ('em_andamento', 'ambigua') FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ROTACAO_NAO_DONA: rodada % nao esta aberta', p_rotacao USING ERRCODE = 'P0001';
  END IF;
  IF p_descartar THEN
    DELETE FROM vault.secrets
     WHERE name = 'sayerlack_portal_pass_pendente' AND description = p_rotacao::text;
  END IF;
  UPDATE public.sayerlack_senha_rotacao
     SET status = 'falhou', erro = left(p_erro, 1000), concluido_em = now(), atualizado_em = now()
   WHERE id = p_rotacao;
END
$fn$;

-- Resultado incerto: mantém ativa E candidata, rodada vira 'ambigua' (edges seguem paradas).
CREATE OR REPLACE FUNCTION public.sayerlack_senha_portal_marcar_ambigua(p_rotacao uuid, p_erro text, p_diagnostico jsonb DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
BEGIN
  UPDATE public.sayerlack_senha_rotacao
     SET status = 'ambigua', erro = left(p_erro, 1000), atualizado_em = now(),
         diagnostico = coalesce(p_diagnostico, diagnostico)
   WHERE id = p_rotacao AND status IN ('em_andamento', 'ambigua');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ROTACAO_NAO_DONA: rodada % nao esta aberta', p_rotacao USING ERRCODE = 'P0001';
  END IF;
END
$fn$;

-- Saída humana da ambiguidade: o founder trocou à mão e pôs a senha no env; a edge PROVOU login
-- com ela (dashboard) e chama isto. Grava como ativa, apaga candidata, fecha a rodada aberta.
CREATE OR REPLACE FUNCTION public.sayerlack_senha_portal_adotar(p_senha text, p_origem text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  IF p_senha IS NULL OR length(p_senha) < 8 THEN
    RAISE EXCEPTION 'SENHA_INVALIDA: senha adotada precisa de ao menos 8 caracteres' USING ERRCODE = '22023';
  END IF;
  SELECT id INTO v_id FROM public.sayerlack_senha_rotacao
   WHERE status IN ('solicitada', 'em_andamento', 'ambigua') LIMIT 1 FOR UPDATE;
  PERFORM public._sayerlack_vault_gravar('sayerlack_portal_pass', p_senha, 'adotada:' || left(p_origem, 40));
  DELETE FROM vault.secrets WHERE name = 'sayerlack_portal_pass_pendente';
  IF v_id IS NOT NULL THEN
    UPDATE public.sayerlack_senha_rotacao
       SET status = 'resolvida_manual', etapa = 'adotada_' || left(p_origem, 40),
           concluido_em = now(), atualizado_em = now()
     WHERE id = v_id;
  END IF;
END
$fn$;

-- E-mail da senha confirmada: lê a ATIVA só se ela ainda for a desta rodada (versão).
CREATE OR REPLACE FUNCTION public.sayerlack_senha_portal_email_pendente()
RETURNS TABLE (rotacao_id uuid, senha text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $fn$
DECLARE
  v_rot uuid;
  v_val text;
  v_val_rot text;
BEGIN
  SELECT id INTO v_rot FROM public.sayerlack_senha_rotacao
   WHERE status = 'concluida' AND email_pendente
   ORDER BY concluido_em DESC LIMIT 1;
  IF v_rot IS NULL THEN
    RETURN;
  END IF;
  SELECT valor, rotacao INTO v_val, v_val_rot FROM public._sayerlack_vault_ler('sayerlack_portal_pass');
  IF v_val IS NULL OR v_val_rot IS DISTINCT FROM v_rot::text THEN
    RETURN;  -- ativa já é de outra versão: não manda senha velha
  END IF;
  RETURN QUERY SELECT v_rot, v_val;
END
$fn$;

CREATE OR REPLACE FUNCTION public.sayerlack_senha_portal_email_enviado(p_rotacao uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $fn$
  UPDATE public.sayerlack_senha_rotacao
     SET email_pendente = false, email_enviado_em = now(), atualizado_em = now()
   WHERE id = p_rotacao AND email_pendente;
$fn$;

DO $grants$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.sayerlack_senha_portal_credencial()',
    'public.sayerlack_senha_portal_solicitar(text)',
    'public.sayerlack_senha_portal_assumir()',
    'public.sayerlack_senha_portal_etapa(uuid,text,jsonb)',
    'public.sayerlack_senha_portal_gravar_candidata(uuid,text)',
    'public.sayerlack_senha_portal_promover(uuid)',
    'public.sayerlack_senha_portal_falhar(uuid,text,boolean)',
    'public.sayerlack_senha_portal_marcar_ambigua(uuid,text,jsonb)',
    'public.sayerlack_senha_portal_adotar(text,text)',
    'public.sayerlack_senha_portal_email_pendente()',
    'public.sayerlack_senha_portal_email_enviado(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$grants$;

-- ---------- postcondição ----------
DO $post$
DECLARE
  f text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'sayerlack_senha_rotacao' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'A1 FALHOU: sayerlack_senha_rotacao ausente ou sem RLS';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'uq_sayerlack_senha_rotacao_aberta' AND i.indisunique AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'A2 FALHOU: trava de rodada unica ausente — duas rotacoes poderiam correr juntas';
  END IF;
  FOREACH f IN ARRAY ARRAY[
    'public.sayerlack_senha_portal_credencial()',
    'public.sayerlack_senha_portal_solicitar(text)',
    'public.sayerlack_senha_portal_assumir()',
    'public.sayerlack_senha_portal_etapa(uuid,text,jsonb)',
    'public.sayerlack_senha_portal_gravar_candidata(uuid,text)',
    'public.sayerlack_senha_portal_promover(uuid)',
    'public.sayerlack_senha_portal_falhar(uuid,text,boolean)',
    'public.sayerlack_senha_portal_marcar_ambigua(uuid,text,jsonb)',
    'public.sayerlack_senha_portal_adotar(text,text)',
    'public.sayerlack_senha_portal_email_pendente()',
    'public.sayerlack_senha_portal_email_enviado(uuid)',
    'public._sayerlack_vault_ler(text)',
    'public._sayerlack_vault_gravar(text,text,text)'
  ] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE')
       OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'A3 FALHOU: % executavel por anon/authenticated — a senha vazaria', f;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.sayerlack_senha_portal_credencial()', 'EXECUTE') THEN
    RAISE EXCEPTION 'A4 FALHOU: service_role nao executa a credencial — as edges nao logariam';
  END IF;
  IF has_function_privilege('service_role', 'public._sayerlack_vault_ler(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A5 FALHOU: helper interno do Vault exposto ao service_role (leria qualquer segredo por nome)';
  END IF;
  -- O dono das funções (quem rodou este SQL) precisa operar o Vault — o psql-ro não enxerga
  -- o schema vault, então quem prova isto é a própria migration.
  IF NOT (has_table_privilege(current_user, 'vault.secrets', 'DELETE')
          AND has_table_privilege(current_user, 'vault.decrypted_secrets', 'SELECT')
          AND has_function_privilege(current_user, 'vault.create_secret(text,text,text,uuid)', 'EXECUTE')
          AND has_function_privilege(current_user, 'vault.update_secret(uuid,text,text,text,uuid)', 'EXECUTE')) THEN
    RAISE EXCEPTION 'A6 FALHOU: % nao opera o Vault (ler/criar/atualizar/apagar) — a rotacao nao gravaria a senha', current_user;
  END IF;
  RAISE NOTICE 'OK: rotacao de senha Sayerlack instalada';
END
$post$;

COMMIT;
