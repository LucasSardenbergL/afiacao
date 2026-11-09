-- Onda 5A, fatia 2, item 5.3 dos pontos cegos do portal Sayerlack (plano 2026-11-06 + adendo 2026-11-08).
-- Migration MANUAL (custom não auto-aplica no Lovable): aplicar pelo envelope (`bun run db:aplicar`).
--
-- O BURACO: pedido aceito no portal (`sucesso_portal`, protocolo), sem PO, que a Sayerlack cancelou (situação 6
-- gravada pela fatia 1) fica para sempre em `aprovado_aguardando_disparo|falha_envio`: o claim recusa o 6 (certo), e
-- NENHUMA porta o encerra — `cancelar_pedido_sugerido` recusa `sucesso_portal` e `corrigir_cancelamento_pos_disparo`
-- só aceita `disparado`. Sobrava o UPDATE cru de staff (a RLS deixa), sem trilha nem guarda.
--
-- A) Trilha imutável `sayerlack_encerramento_cancelado_portal` (1 linha por encerramento, do RETURNING).
-- B) Porta única `sayerlack_encerrar_cancelado_no_portal` (service_role; a edge `sayerlack-encerrar-cancelado-portal`
--    autentica o master e consulta o Omie ANTES): revalida tudo sob FOR UPDATE — OBEN, protocolo, sem PO, 6 do
--    protocolo atual, SEM pendência de disparo (claim aberto = pode haver execução em voo; Codex desenho P1 #1),
--    nada no espelho do Omie (AFI-<id> ou contrato = protocolo), prova do Omie "ausente" para o AFI-<id>.
-- C) Guarda na TABELA (Codex 5A rodada 1 P1 #1; desenho P1 #2): pedido com protocolo do portal e SEM PO não vira
--    `cancelad%` nem é apagado fora da porta (GUC-portão local com o id). O predicado usa o protocolo — imutável
--    desde a fatia 1 — e não `status`/`status_envio_portal`, que staff poderia trocar numa instrução anterior.
--    Medido (psql-ro 2026-11-08): nenhum escritor legítimo faz essa transição nem esse DELETE hoje.
-- Idempotente; sem DROP de objeto existente.

-- ── A. trilha ─────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sayerlack_encerramento_cancelado_portal (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pedido_id          bigint      NOT NULL,
  protocolo          text        NOT NULL,
  status_antes       text        NOT NULL,
  situacao_texto     text        NOT NULL,
  situacao_lida_de   timestamptz NOT NULL,
  situacao_lida_ate  timestamptz NOT NULL,
  prova_omie         jsonb       NOT NULL,
  espelho_sync_status text,
  espelho_sync_em    timestamptz,
  ator               uuid        NOT NULL,
  justificativa      text        NOT NULL,
  execucao_id        uuid,
  criado_em          timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.sayerlack_encerramento_cancelado_portal IS
  'Trilha imutável da 5.3: pedido aceito no portal Sayerlack, sem PO, cancelado no fornecedor (situação 6) e encerrado '
  'por um master pela porta sayerlack_encerrar_cancelado_no_portal. Sem FK de propósito: a trilha sobrevive ao pedido.';
CREATE INDEX IF NOT EXISTS sayerlack_encerramento_cancelado_portal_pedido_idx
  ON public.sayerlack_encerramento_cancelado_portal (pedido_id);

ALTER TABLE public.sayerlack_encerramento_cancelado_portal ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sayerlack_encerramento_cancelado_portal FROM PUBLIC;
REVOKE ALL ON public.sayerlack_encerramento_cancelado_portal FROM anon;
REVOKE ALL ON public.sayerlack_encerramento_cancelado_portal FROM authenticated;
GRANT SELECT ON public.sayerlack_encerramento_cancelado_portal TO authenticated;
DROP POLICY IF EXISTS staff_le_encerramento_cancelado_portal ON public.sayerlack_encerramento_cancelado_portal;
CREATE POLICY staff_le_encerramento_cancelado_portal ON public.sayerlack_encerramento_cancelado_portal
  FOR SELECT TO authenticated
  USING ((SELECT public.has_role(auth.uid(), 'master'::app_role)) OR (SELECT public.has_role(auth.uid(), 'employee'::app_role)));

CREATE OR REPLACE FUNCTION public.sayerlack__trilha_encerramento_imutavel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '42501',
    MESSAGE = '[ENCERRAMENTO-TRILHA-IMUTAVEL] a trilha de encerramento do portal Sayerlack não aceita ' || TG_OP;
END;
$$;
REVOKE ALL ON FUNCTION public.sayerlack__trilha_encerramento_imutavel() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack__trilha_encerramento_imutavel() FROM anon;
REVOKE ALL ON FUNCTION public.sayerlack__trilha_encerramento_imutavel() FROM authenticated;
DROP TRIGGER IF EXISTS trg_trilha_encerramento_imutavel ON public.sayerlack_encerramento_cancelado_portal;
CREATE TRIGGER trg_trilha_encerramento_imutavel
  BEFORE UPDATE OR DELETE ON public.sayerlack_encerramento_cancelado_portal
  FOR EACH ROW EXECUTE FUNCTION public.sayerlack__trilha_encerramento_imutavel();

-- ── C. guarda na tabela de pedidos ────────────────────────────────────────────────────────────────
-- Pedido com protocolo do portal e sem PO: o fornecedor TEM o pedido. Encerrá-lo (status cancelad%) ou apagá-lo
-- aqui sem a porta deixaria o motor recomprar com o pedido vivo no fornecedor — ou, se cancelado lá, sem trilha.
-- Correção excepcional pelo SQL Editor: `SET LOCAL app.sayerlack_encerrar_cancelado = '<id>'` na mesma transação.
CREATE OR REPLACE FUNCTION public.sayerlack__veta_encerrar_aceito_no_portal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF btrim(COALESCE(OLD.portal_protocolo, '')) = '' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF COALESCE(NULLIF(btrim(OLD.omie_pedido_compra_id), ''), '0') <> '0' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;   -- com PO: a porta é corrigir_cancelamento_pos_disparo
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS NOT DISTINCT FROM OLD.status OR COALESCE(NEW.status, '') NOT LIKE 'cancelad%' THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NULLIF(current_setting('app.sayerlack_encerrar_cancelado', true), '') IS NOT DISTINCT FROM OLD.id::text THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501',
    MESSAGE = '[ENCERRAR-ACEITO-NO-PORTAL] pedido ' || OLD.id || ' tem protocolo ' || btrim(OLD.portal_protocolo) ||
              ' no portal Sayerlack e nenhum PO: ' || CASE WHEN TG_OP = 'DELETE' THEN 'apagar' ELSE 'cancelar' END ||
              ' só pela porta auditada (botão "Encerrar — cancelado no fornecedor").';
END;
$$;
REVOKE ALL ON FUNCTION public.sayerlack__veta_encerrar_aceito_no_portal() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack__veta_encerrar_aceito_no_portal() FROM anon;
REVOKE ALL ON FUNCTION public.sayerlack__veta_encerrar_aceito_no_portal() FROM authenticated;
DROP TRIGGER IF EXISTS trg_veta_encerrar_aceito_no_portal ON public.pedido_compra_sugerido;
CREATE TRIGGER trg_veta_encerrar_aceito_no_portal
  BEFORE UPDATE OR DELETE ON public.pedido_compra_sugerido
  FOR EACH ROW EXECUTE FUNCTION public.sayerlack__veta_encerrar_aceito_no_portal();

-- ── B. a porta ────────────────────────────────────────────────────────────────────────────────────
-- Recusa de NEGÓCIO volta como {encerrado:false, motivo} (a edge mostra ao humano); entrada malformada é 22023;
-- ator sem master é 42501. Nada aqui chama o Omie: a prova vem da edge e é checada pela FORMA.
CREATE OR REPLACE FUNCTION public.sayerlack_encerrar_cancelado_no_portal(
  p_pedido_id bigint, p_ator uuid, p_justificativa text, p_prova_omie jsonb, p_execucao_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r          public.pedido_compra_sugerido%ROWTYPE;
  v_just     text := btrim(COALESCE(p_justificativa, ''));
  v_sync_st  text;
  v_sync_em  timestamptz;
  v_trilha   bigint;
  v_n        int;
BEGIN
  IF p_pedido_id IS NULL OR p_ator IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[ENCERRAR-ENTRADA] pedido e ator são obrigatórios';
  END IF;
  IF length(v_just) < 10 OR length(v_just) > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[ENCERRAR-JUSTIFICATIVA] justificativa de 10 a 1000 caracteres';
  END IF;
  IF p_prova_omie IS NULL OR jsonb_typeof(p_prova_omie) <> 'object'
     OR p_prova_omie->>'tipo' IS DISTINCT FROM 'ausente'
     OR p_prova_omie->>'codigo_integracao' IS DISTINCT FROM ('AFI-' || p_pedido_id) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = '[ENCERRAR-PROVA-OMIE] sem prova de ausência do AFI-' || p_pedido_id || ' no Omie, nada se encerra';
  END IF;
  IF NOT public.has_role(p_ator, 'master'::app_role) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '[ENCERRAR-MASTER] só master encerra pedido aceito no portal';
  END IF;

  SELECT * INTO r FROM public.pedido_compra_sugerido WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('encerrado', false, 'motivo', 'pedido_nao_encontrado');
  END IF;
  IF r.empresa IS DISTINCT FROM 'OBEN' OR btrim(COALESCE(r.portal_protocolo, '')) = '' THEN
    RETURN jsonb_build_object('encerrado', false, 'motivo', 'sem_protocolo_do_portal');
  END IF;
  IF r.status NOT IN ('aprovado_aguardando_disparo', 'falha_envio') THEN
    RETURN jsonb_build_object('encerrado', false, 'motivo', 'status_nao_encerravel', 'status', r.status);
  END IF;
  IF r.status_envio_portal IS DISTINCT FROM 'sucesso_portal' THEN
    RETURN jsonb_build_object('encerrado', false, 'motivo', 'portal_nao_confirmado', 'status_envio_portal', r.status_envio_portal);
  END IF;
  IF COALESCE(NULLIF(btrim(r.omie_pedido_compra_id), ''), '0') <> '0' THEN
    RETURN jsonb_build_object('encerrado', false, 'motivo', 'tem_po');
  END IF;
  IF r.portal_situacao_codigo IS DISTINCT FROM '6' OR r.portal_situacao_protocolo IS DISTINCT FROM r.portal_protocolo THEN
    RETURN jsonb_build_object('encerrado', false, 'motivo', 'nao_cancelado_no_portal',
                              'situacao', r.portal_situacao_codigo);
  END IF;
  -- Claim aberto, de QUALQUER idade: o carimbo é o da 1ª tentativa (COALESCE no claim) e uma nova pode estar em voo
  -- (Codex desenho P1 #1). Quem resolve é a conciliação por consulta do disparador.
  IF r.disparo_claim_em IS NOT NULL THEN
    RETURN jsonb_build_object('encerrado', false, 'motivo', 'disparo_pendente', 'pendente_desde', r.disparo_claim_em);
  END IF;
  -- Espelho do Omie: PO com o código de integração do app OU com o protocolo no contrato (gramática da varredura:
  -- split '/' + btrim), que não esteja cancelado. Ausência aqui é "não encontrado no espelho consultado".
  IF EXISTS (
    SELECT 1 FROM public.purchase_orders_tracking t
     WHERE t.empresa::text = 'OBEN'
       AND t.status::text IS DISTINCT FROM 'CANCELADO'
       AND (btrim(COALESCE(t.omie_codigo_integracao, '')) = 'AFI-' || r.id
            OR EXISTS (SELECT 1 FROM unnest(string_to_array(t.numero_contrato_fornecedor, '/')) AS c(n)
                        WHERE btrim(c.n) = r.portal_protocolo))
  ) THEN
    RETURN jsonb_build_object('encerrado', false, 'motivo', 'po_no_espelho');
  END IF;

  SELECT s.status, s.last_sync_at INTO v_sync_st, v_sync_em
    FROM public.sync_state s WHERE s.entity_type = 'pedidos_compra' AND s.account = 'oben';

  PERFORM set_config('app.sayerlack_encerrar_cancelado', r.id::text, true);
  UPDATE public.pedido_compra_sugerido
     SET status = 'cancelado_humano',
         cancelado_por = p_ator::text,
         cancelado_em = now(),
         justificativa_cancelamento = 'Cancelado no fornecedor (portal Sayerlack, protocolo ' || r.portal_protocolo ||
                                      '): ' || v_just,
         portal_proximo_retry_em = NULL,
         atualizado_em = now()
   WHERE id = r.id
     AND status = r.status
     AND disparo_claim_em IS NULL
     AND portal_situacao_codigo = '6';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('app.sayerlack_encerrar_cancelado', '', true);
  IF v_n <> 1 THEN
    -- Impossível sob o FOR UPDATE acima; se acontecer, nada fica meio feito.
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = '[ENCERRAR-CORRIDA] o pedido mudou durante o encerramento';
  END IF;

  INSERT INTO public.sayerlack_encerramento_cancelado_portal
    (pedido_id, protocolo, status_antes, situacao_texto, situacao_lida_de, situacao_lida_ate, prova_omie,
     espelho_sync_status, espelho_sync_em, ator, justificativa, execucao_id)
  VALUES (r.id, r.portal_protocolo, r.status, r.portal_situacao_texto, r.portal_situacao_em, r.portal_situacao_ate,
          p_prova_omie, v_sync_st, v_sync_em, p_ator, v_just, p_execucao_id)
  RETURNING id INTO v_trilha;

  RETURN jsonb_build_object('encerrado', true, 'pedido_id', r.id, 'protocolo', r.portal_protocolo,
                            'trilha_id', v_trilha, 'espelho_sync_status', v_sync_st, 'espelho_sync_em', v_sync_em);
END;
$$;
REVOKE ALL ON FUNCTION public.sayerlack_encerrar_cancelado_no_portal(bigint, uuid, text, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack_encerrar_cancelado_no_portal(bigint, uuid, text, jsonb, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.sayerlack_encerrar_cancelado_no_portal(bigint, uuid, text, jsonb, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sayerlack_encerrar_cancelado_no_portal(bigint, uuid, text, jsonb, uuid) TO service_role;

-- ── POS ───────────────────────────────────────────────────────────────────────────────────────────
DO $pos$
DECLARE
  v_src text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_veta_encerrar_aceito_no_portal'
                   AND tgrelid = 'public.pedido_compra_sugerido'::regclass AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'E1 FALHOU: guarda da tabela de pedidos ausente ou desligada';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_trilha_encerramento_imutavel'
                   AND tgrelid = 'public.sayerlack_encerramento_cancelado_portal'::regclass AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'E2 FALHOU: trilha sem a trava de imutabilidade';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sayerlack_encerramento_cancelado_portal'::regclass) THEN
    RAISE EXCEPTION 'E3 FALHOU: trilha sem RLS';
  END IF;
  IF has_function_privilege('anon', 'public.sayerlack_encerrar_cancelado_no_portal(bigint,uuid,text,jsonb,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.sayerlack_encerrar_cancelado_no_portal(bigint,uuid,text,jsonb,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'E4 FALHOU: porta aberta para anon/authenticated';
  END IF;
  IF has_table_privilege('authenticated', 'public.sayerlack_encerramento_cancelado_portal', 'INSERT')
     OR has_table_privilege('authenticated', 'public.sayerlack_encerramento_cancelado_portal', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.sayerlack_encerramento_cancelado_portal', 'DELETE') THEN
    RAISE EXCEPTION 'E5 FALHOU: trilha gravável por authenticated';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.sayerlack_encerrar_cancelado_no_portal(bigint,uuid,text,jsonb,uuid)'::regprocedure;
  IF v_src NOT LIKE '%IF r.disparo_claim_em IS NOT NULL THEN%' THEN
    RAISE EXCEPTION 'E6 FALHOU: a porta não recusa pendência de disparo';
  END IF;
  RAISE NOTICE 'POSTCONDICAO_OK sayerlack encerrar cancelado no portal';
END
$pos$;
