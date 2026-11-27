-- ============================================================================
-- Desligamento de funcionário — revoga tudo de uma vez, auditado.
--
-- Lacuna registrada em docs/historico/clientes-onda-d-pii-carteira.md (4b-1): tirar o papel não tirava a
-- flag de equipe, o commercial_roles nem a carteira; fazia-se à mão no banco. Um desligado com carteira
-- mantinha acesso a PII (onda D: PII condicionada a papel + carteira/cobertura) e às filas de venda/cobrança.
--
-- Decisões (founder, 2026-11-27):
--   · carteira vai para um colega escolhido na tela (p_novo_dono);
--   · nada se apaga do histórico (auth.users/profiles/pedidos/contatos/ledger ficam) — database.md §5;
--   · login bloqueado (ban no Auth) — feito pela edge `desligar-funcionario`, que chama esta RPC com o JWT
--     do master e depois o admin API; o resultado do ban volta por `registrar_ban_desligamento`;
--   · só master desliga; nunca a si mesmo (logo nunca o último master).
--
-- O que a RPC faz, numa transação:
--   1. user_roles: remove employee/master;          2. profiles: is_employee=false, is_approved=false;
--   3. commercial_roles: remove;                     4. omie_vendedor_map: códigos do desligado → novo dono
--      (a carteira é DERIVADA desse mapa pelo carteira-rebuild — sem remapear, o rebuild desfaria a troca);
--   5. carteira_assignments: owner → novo dono;      6. company_config.carteira_hunter_user_id → novo dono;
--   7. carteira_coverage: encerra (active=false);    8. cobranca_caso aberto e tarefas abertas → novo dono;
--   9. vendor_sip_credentials: remove (é credencial de acesso ao PABX fora do app, não histórico).
-- Fora de propósito: venda_sugestao / meta_potencial_carteira / farmer_agenda são DERIVADOS da carteira e se
-- refazem no próximo recálculo.
--
-- Concorrência com o carteira-rebuild: a RPC trava a linha `sync_state(carteira_rebuild, global)` e recusa
-- se há rebuild em voo (< 15 min, a mesma janela do claim). Um claim que chega depois espera o COMMIT e lê
-- o mapa já remapeado.
--
-- Idempotente: 2ª chamada sem nada a revogar devolve `ja_desligado` e o último desligamento, sem nova linha.
-- ============================================================================

-- ───────────────────────── Auditoria ─────────────────────────
CREATE TABLE IF NOT EXISTS public.funcionario_desligamentos (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL,
  desligado_por      uuid NOT NULL,
  novo_dono_user_id  uuid,
  motivo             text NOT NULL CHECK (length(btrim(motivo)) >= 3),
  papeis_removidos   text[] NOT NULL DEFAULT '{}',
  commercial_role    text,
  resumo             jsonb NOT NULL DEFAULT '{}'::jsonb,
  ban_status         text NOT NULL DEFAULT 'pendente' CHECK (ban_status IN ('pendente', 'aplicado', 'falhou')),
  ban_erro           text,
  ban_em             timestamptz,
  criado_em          timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.funcionario_desligamentos IS
  'Auditoria do desligamento de funcionário. Único escritor: desligar_funcionario/registrar_ban_desligamento '
  '(SECURITY DEFINER). Leitura: master.';

CREATE INDEX IF NOT EXISTS funcionario_desligamentos_user_idx
  ON public.funcionario_desligamentos (user_id, criado_em DESC);

ALTER TABLE public.funcionario_desligamentos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS funcionario_desligamentos_select ON public.funcionario_desligamentos;
CREATE POLICY funcionario_desligamentos_select ON public.funcionario_desligamentos
  FOR SELECT TO authenticated
  USING (COALESCE((SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role)), false));

-- Nenhum papel da aplicação escreve (nem service_role: seria 2º escritor capaz de forjar/apagar).
-- service_role também não LÊ (Codex P2: BYPASSRLS leria tudo); a edge só usa as RPCs.
REVOKE ALL ON public.funcionario_desligamentos FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.funcionario_desligamentos TO authenticated;

-- ───────────────────────── RPC ─────────────────────────
CREATE OR REPLACE FUNCTION public.desligar_funcionario(
  p_user_id   uuid,
  p_novo_dono uuid,
  p_motivo    text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_ator        uuid := (SELECT auth.uid());
  v_papeis      text[];
  v_cr          text;
  v_flag        boolean;
  v_hunter      text;
  n_map         integer := 0;
  n_carteira    integer := 0;
  n_cobertura   integer := 0;
  n_cobranca    integer := 0;
  n_tarefas     integer := 0;
  n_sip         integer := 0;
  n_hunter      integer := 0;
  n_flag        integer := 0;
  v_aprovado    boolean;
  v_anterior    uuid;
  v_rb_status   text;
  v_rb_em       timestamptz;
  v_tem_dono    boolean;
  v_id          uuid;
  v_resumo      jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'desligamento: funcionário obrigatório' USING ERRCODE = '22004';
  END IF;

  -- Serializa TODOS os desligamentos ANTES do gate (Codex P1): dois masters não se desligam um ao outro
  -- em paralelo — o 2º espera, e o gate abaixo lê o estado já comitado (READ COMMITTED: snapshot novo
  -- por comando).
  PERFORM pg_advisory_xact_lock(hashtextextended('desligar_funcionario', 0));

  -- Gate na fronteira: só master, autenticado.
  IF v_ator IS NULL OR NOT COALESCE(public.has_role(v_ator, 'master'::public.app_role), false) THEN
    RAISE EXCEPTION 'desligamento: apenas master' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = v_ator THEN
    RAISE EXCEPTION 'desligamento: não é possível desligar a si mesmo' USING ERRCODE = '42501';
  END IF;

  -- Trava o rebuild de carteira e decide pela MESMA leitura (Codex P1: checar antes de travar deixava um
  -- claim entrar no meio). Sem a linha, um claim concorrente a criaria sem esperar ⇒ recusa (fail-closed).
  -- 15 min = a janela do próprio claim; uma edge não vive tanto, então não há worker vivo além dela.
  SELECT status, last_sync_at INTO v_rb_status, v_rb_em
    FROM public.sync_state
   WHERE entity_type = 'carteira_rebuild' AND account = 'global'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'desligamento: estado do rebuild de carteira ausente' USING ERRCODE = '55000';
  END IF;
  IF v_rb_status = 'syncing' AND v_rb_em >= now() - interval '15 minutes' THEN
    RAISE EXCEPTION 'desligamento: rebuild de carteira em andamento, tente em alguns minutos'
      USING ERRCODE = '55P03';
  END IF;

  SELECT COALESCE(array_agg(role::text ORDER BY role::text), '{}')
    INTO v_papeis
    FROM public.user_roles
   WHERE user_id = p_user_id AND role IN ('employee'::public.app_role, 'master'::public.app_role);
  SELECT commercial_role::text INTO v_cr FROM public.commercial_roles WHERE user_id = p_user_id;
  SELECT COALESCE(bool_or(is_employee), false), COALESCE(bool_or(is_approved), false)
    INTO v_flag, v_aprovado
    FROM public.profiles WHERE user_id = p_user_id;
  SELECT NULLIF(btrim(value::text, '" '), '') INTO v_hunter
    FROM public.company_config WHERE key = 'carteira_hunter_user_id';
  SELECT id INTO v_anterior FROM public.funcionario_desligamentos
   WHERE user_id = p_user_id ORDER BY criado_em DESC LIMIT 1;

  -- Elegível = é equipe HOJE (papel, flag ou commercial_role) ou já foi desligado (retry/resíduo).
  -- Trabalho a transferir, sozinho, NÃO torna alguém desligável (Codex P1).
  IF cardinality(v_papeis) = 0 AND v_cr IS NULL AND NOT v_flag AND v_anterior IS NULL THEN
    RAISE EXCEPTION 'desligamento: usuário não é da equipe' USING ERRCODE = '22023';
  END IF;

  v_tem_dono :=
       EXISTS (SELECT 1 FROM public.omie_vendedor_map WHERE user_id = p_user_id)
    OR EXISTS (SELECT 1 FROM public.carteira_assignments WHERE owner_user_id = p_user_id)
    OR COALESCE(v_hunter = p_user_id::text, false)
    OR EXISTS (SELECT 1 FROM public.cobranca_caso WHERE dona_user_id = p_user_id AND fechado_em IS NULL)
    OR EXISTS (SELECT 1 FROM public.tarefas WHERE assigned_to = p_user_id AND status = 'aberta');

  -- Idempotência: nada a revogar nem a transferir ⇒ devolve o último registro, sem escrever. Aprovação
  -- residual conta como resíduo (Codex P2: reaprovar um desligado não pode passar como "já desligado").
  IF cardinality(v_papeis) = 0 AND v_cr IS NULL AND NOT v_flag AND NOT v_aprovado AND NOT v_tem_dono
     AND NOT EXISTS (SELECT 1 FROM public.carteira_coverage
                      WHERE active AND (covering_user_id = p_user_id OR covered_user_id = p_user_id))
     AND NOT EXISTS (SELECT 1 FROM public.vendor_sip_credentials WHERE user_id = p_user_id) THEN
    RETURN jsonb_build_object('status', 'ja_desligado', 'desligamento_id', v_anterior);
  END IF;

  IF p_motivo IS NULL OR length(btrim(p_motivo)) < 3 THEN
    RAISE EXCEPTION 'desligamento: motivo obrigatório' USING ERRCODE = '22023';
  END IF;

  -- "Nunca o último master" não precisa de guard: o ator é master e ≠ alvo, então sempre sobra um.

  -- Novo dono: obrigatório quando há o que transferir; tem de ser equipe ATIVA e outra pessoa
  -- (o próprio master pode receber).
  IF v_tem_dono AND p_novo_dono IS NULL THEN
    RAISE EXCEPTION 'desligamento: escolha quem recebe a carteira' USING ERRCODE = '22023';
  END IF;
  IF p_novo_dono IS NOT NULL THEN
    IF p_novo_dono = p_user_id OR NOT EXISTS (
         SELECT 1 FROM public.user_roles
          WHERE user_id = p_novo_dono
            AND role IN ('employee'::public.app_role, 'master'::public.app_role)) THEN
      RAISE EXCEPTION 'desligamento: novo dono precisa ser outro membro ativo da equipe' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 1-3. Acesso.
  DELETE FROM public.user_roles
   WHERE user_id = p_user_id AND role IN ('employee'::public.app_role, 'master'::public.app_role);
  UPDATE public.profiles SET is_employee = false, is_approved = false
   WHERE user_id = p_user_id AND (is_employee OR is_approved);
  GET DIAGNOSTICS n_flag = ROW_COUNT;
  DELETE FROM public.commercial_roles WHERE user_id = p_user_id;

  -- 4-6. Carteira (mapa primeiro: é dele que o rebuild deriva o dono).
  IF p_novo_dono IS NOT NULL THEN
    UPDATE public.omie_vendedor_map SET user_id = p_novo_dono WHERE user_id = p_user_id;
    GET DIAGNOSTICS n_map = ROW_COUNT;
    UPDATE public.carteira_assignments SET owner_user_id = p_novo_dono, updated_at = now()
     WHERE owner_user_id = p_user_id;
    GET DIAGNOSTICS n_carteira = ROW_COUNT;
    -- Condicionado ao valor ATUAL (Codex P2): não sobrescreve um hunter trocado em paralelo.
    UPDATE public.company_config SET value = p_novo_dono::text
     WHERE key = 'carteira_hunter_user_id' AND btrim(value::text, '" ') = p_user_id::text;
    GET DIAGNOSTICS n_hunter = ROW_COUNT;
    UPDATE public.cobranca_caso SET dona_user_id = p_novo_dono, atualizado_em = now(), atualizado_por = v_ator
     WHERE dona_user_id = p_user_id AND fechado_em IS NULL;
    GET DIAGNOSTICS n_cobranca = ROW_COUNT;
    UPDATE public.tarefas SET assigned_to = p_novo_dono, updated_at = now()
     WHERE assigned_to = p_user_id AND status = 'aberta';
    GET DIAGNOSTICS n_tarefas = ROW_COUNT;
  END IF;

  -- 7. Cobertura: encerra (a linha fica como histórico).
  UPDATE public.carteira_coverage SET active = false, valid_until = LEAST(COALESCE(valid_until, now()), now())
   WHERE active AND (covering_user_id = p_user_id OR covered_user_id = p_user_id);
  GET DIAGNOSTICS n_cobertura = ROW_COUNT;

  -- 9. Credencial SIP.
  DELETE FROM public.vendor_sip_credentials WHERE user_id = p_user_id;
  GET DIAGNOSTICS n_sip = ROW_COUNT;

  v_resumo := jsonb_build_object(
    'flag_equipe', n_flag, 'vendedor_map', n_map, 'carteira', n_carteira, 'hunter', n_hunter,
    'cobertura', n_cobertura, 'cobranca', n_cobranca, 'tarefas', n_tarefas, 'sip', n_sip);

  INSERT INTO public.funcionario_desligamentos
    (user_id, desligado_por, novo_dono_user_id, motivo, papeis_removidos, commercial_role, resumo)
  VALUES (p_user_id, v_ator, p_novo_dono, btrim(p_motivo), v_papeis, v_cr, v_resumo)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('status', 'desligado', 'desligamento_id', v_id, 'resumo', v_resumo,
                            'papeis_removidos', to_jsonb(v_papeis));
END
$fn$;

REVOKE ALL ON FUNCTION public.desligar_funcionario(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.desligar_funcionario(uuid, uuid, text) TO authenticated;

-- Resultado do ban (edge, service_role). Só marca o ÚLTIMO desligamento daquele usuário.
CREATE OR REPLACE FUNCTION public.registrar_ban_desligamento(
  p_desligamento_id uuid,
  p_ok              boolean,
  p_erro            text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF p_desligamento_id IS NULL OR p_ok IS NULL THEN
    RAISE EXCEPTION 'registrar_ban: parâmetros obrigatórios' USING ERRCODE = '22004';
  END IF;
  -- Só o desligamento VIGENTE daquele usuário, e um sucesso já registrado não é rebaixado por uma
  -- resposta atrasada (Codex P2).
  UPDATE public.funcionario_desligamentos d
     SET ban_status = CASE WHEN p_ok THEN 'aplicado' ELSE 'falhou' END,
         ban_erro   = CASE WHEN p_ok THEN NULL ELSE left(p_erro, 500) END,
         ban_em     = now()
   WHERE d.id = p_desligamento_id
     AND d.id = (SELECT x.id FROM public.funcionario_desligamentos x
                  WHERE x.user_id = d.user_id ORDER BY x.criado_em DESC LIMIT 1)
     AND (p_ok OR d.ban_status <> 'aplicado');
  IF NOT FOUND AND NOT EXISTS (SELECT 1 FROM public.funcionario_desligamentos WHERE id = p_desligamento_id) THEN
    RAISE EXCEPTION 'registrar_ban: desligamento inexistente' USING ERRCODE = 'P0002';
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION public.registrar_ban_desligamento(uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_ban_desligamento(uuid, boolean, text) TO service_role;

-- Postcondição: ACL fechado nas duas pontas e RLS ligada.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.desligar_funcionario(uuid, uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.registrar_ban_desligamento(uuid, boolean, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.registrar_ban_desligamento(uuid, boolean, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondição: ACL aberto';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.funcionario_desligamentos'::regclass) THEN
    RAISE EXCEPTION 'postcondição: RLS desligada';
  END IF;
END $$;
