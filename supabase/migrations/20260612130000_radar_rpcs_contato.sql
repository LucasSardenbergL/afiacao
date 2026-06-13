-- =============================================================================
-- RADAR DE CLIENTES — RPCs de contato + KPIs (fatia 2)
-- Spec: docs/superpowers/specs/2026-06-10-radar-clientes-design.md §3.3/§3.6/§3.7
-- ⚠️ APLICAÇÃO MANUAL: colar no SQL Editor do Lovable (Lovable não auto-aplica).
-- Gate: gestor/master via pode_ver_carteira_completa (helper já em prod; mesmo
-- gate da RLS de SELECT das tabelas radar_*). O Radar é founder/gestor-only.
-- =============================================================================

-- 1) status_anterior: o undo precisa reverter o prospeccao_status DESNORMALIZADO
--    em radar_empresas; guardamos o valor pré-contato na linha do log.
ALTER TABLE public.radar_contatos
  ADD COLUMN IF NOT EXISTS status_anterior text;

-- 2) Registrar contato: muda o status da empresa + loga (append-only) + dedupe.
CREATE OR REPLACE FUNCTION public.registrar_contato_radar(
  p_cnpj text, p_acao text, p_nota text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_status_atual text;
  v_existing uuid;
  v_id uuid;
BEGIN
  -- gate: gestor/master (mesma fronteira da RLS das tabelas radar)
  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9]{14}$' THEN
    RAISE EXCEPTION 'cnpj inválido';
  END IF;
  IF p_acao NOT IN ('a_contatar','contatado_sem_resposta','em_conversa','descartado','virou_cliente') THEN
    RAISE EXCEPTION 'ação inválida: %', p_acao;
  END IF;

  -- lê o status atual (= status_anterior do log) e trava a linha p/ serializar.
  SELECT prospeccao_status INTO v_status_atual
    FROM public.radar_empresas WHERE cnpj = p_cnpj FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj; END IF;

  -- serializa o dedupe por chave lógica (race do SELECT→INSERT em double-click).
  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text||':'||p_cnpj||':'||p_acao||':radar', 0));
  -- dedupe idempotente: mesmo gestor+cnpj+ação nos últimos 2 min → devolve o existente.
  SELECT id INTO v_existing FROM public.radar_contatos
   WHERE criado_por = v_uid AND cnpj = p_cnpj AND acao = p_acao
     AND created_at > now() - interval '2 minutes'
   ORDER BY created_at DESC LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_existing, 'deduped', true);
  END IF;

  INSERT INTO public.radar_contatos (cnpj, acao, nota, criado_por, status_anterior)
  VALUES (p_cnpj, p_acao, p_nota, v_uid, v_status_atual)
  RETURNING id INTO v_id;

  UPDATE public.radar_empresas SET
    prospeccao_status = p_acao,
    prospeccao_atualizado_em = now(),
    descarte_motivo = CASE WHEN p_acao = 'descartado' THEN p_nota ELSE NULL END,  -- limpa ao sair de descartado (não deixa motivo stale)
    updated_at = now()
  WHERE cnpj = p_cnpj;

  RETURN jsonb_build_object('id', v_id, 'deduped', false);
END $$;

-- 3) Undo curto (own + < 5 min): reverte o status ao status_anterior do log e
--    apaga a linha. GUARD anti-regressão: só reverte se o status ATUAL da empresa
--    ainda for o que ESTE contato setou (senão um contato mais novo seria pisado).
CREATE OR REPLACE FUNCTION public.desfazer_contato_radar(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_cnpj text;
  v_acao text;
  v_anterior text;
  v_status_atual text;
BEGIN
  SELECT cnpj, acao, status_anterior INTO v_cnpj, v_acao, v_anterior
    FROM public.radar_contatos
   WHERE id = p_id AND criado_por = v_uid AND created_at > now() - interval '5 minutes';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('deleted', false);
  END IF;

  SELECT prospeccao_status INTO v_status_atual
    FROM public.radar_empresas WHERE cnpj = v_cnpj FOR UPDATE;
  -- só reverte o status se ele ainda é o que este contato aplicou (anti-regressão).
  IF v_status_atual = v_acao THEN
    UPDATE public.radar_empresas SET
      prospeccao_status = COALESCE(v_anterior, 'a_contatar'),
      prospeccao_atualizado_em = now(), updated_at = now()
    WHERE cnpj = v_cnpj;
  END IF;

  DELETE FROM public.radar_contatos WHERE id = p_id;
  RETURN jsonb_build_object('deleted', true);
END $$;

-- 4) KPIs do topo da tela (1 round-trip; "novos" lê o state, não conta a tabela).
CREATE OR REPLACE FUNCTION public.radar_kpis()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_lote text;
  v_novos integer;
  v_a_contatar integer;
  v_em_conversa integer;
  v_virou_mes integer;
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;

  SELECT mes_referencia, COALESCE(novos, 0) INTO v_lote, v_novos
    FROM public.radar_ingest_state
   WHERE status = 'complete'
   ORDER BY mes_referencia DESC LIMIT 1;

  SELECT count(*) INTO v_a_contatar FROM public.radar_empresas
   WHERE prospeccao_status = 'a_contatar' AND ja_cliente = false
     AND (v_lote IS NULL OR ultimo_lote = v_lote);
  SELECT count(*) INTO v_em_conversa FROM public.radar_empresas
   WHERE prospeccao_status = 'em_conversa';
  SELECT count(*) INTO v_virou_mes FROM public.radar_empresas
   WHERE prospeccao_status = 'virou_cliente'
     AND prospeccao_atualizado_em >= date_trunc('month', now());

  RETURN jsonb_build_object(
    'lote', v_lote, 'novos', COALESCE(v_novos, 0),
    'a_contatar', v_a_contatar, 'em_conversa', v_em_conversa,
    'virou_cliente_mes', v_virou_mes);
END $$;

-- 5) Trava: gestor/master via gate interno; só authenticated pode invocar.
REVOKE ALL ON FUNCTION public.registrar_contato_radar(text,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.desfazer_contato_radar(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.radar_kpis() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_contato_radar(text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.desfazer_contato_radar(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.radar_kpis() TO authenticated;

-- 6) Validação pós-apply (colar junto; esperar coluna_1=1, funcoes_3=3)
SELECT 'RADAR RPCS OK' AS status,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='radar_contatos' AND column_name='status_anterior') AS coluna_1,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN
      ('registrar_contato_radar','desfazer_contato_radar','radar_kpis')) AS funcoes_3;
