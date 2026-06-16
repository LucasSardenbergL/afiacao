-- Fase 1 — Fornecedores fora da carteira: RPCs (classificar + reverter) + trigger de derivação.
-- Espelha o helper TS src/lib/fornecedores/classificacao.ts (regra de tag → exclusão).
-- Régua A (founder, 2026-06-15): excluir = tem tag {fornecedor,transportadora} (case/acento-insensível,
--   lower(trim)) E NÃO tem venda real (pedido válido) E NÃO é exceção curada. "Tem pedido = cliente, fica."
-- Reversibilidade (P1 Codex): reverter re-enfileira AMBOS os recalcs (visit + score) → os 2 scores voltam.
-- ⚠️ Correção vs. plano: a fila é a TABELA visit_score_recalc_queue (visit_score_recalc_pending é VIEW,
--    security_invoker, não-inserível) + a TABELA score_recalc_queue; ambas têm `reason` NOT NULL e
--    índice único parcial (customer_user_id, farmer_id) WHERE processed_at IS NULL (ON CONFLICT cobre).
-- Idempotente: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS antes do CREATE TRIGGER.

-- ============================================================
-- classificar_clientes_fornecedores() — re-deriva a classificação de TODOS os cadastros.
--   is_fornecedor       = tem tag {fornecedor,transportadora}
--   tem_venda_real      = tem pedido válido (régua A: DECIDE a exclusão)
--   excluir_da_carteira = is_fornecedor AND NÃO tem venda real AND NÃO há exceção curada
-- Roda no SQL Editor após o sync + a curadoria. REVOKE de anon/authenticated.
-- ============================================================
CREATE OR REPLACE FUNCTION public.classificar_clientes_fornecedores()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_classificados int;
  v_excluidos     int;
BEGIN
  UPDATE public.cliente_classificacao cc SET
    is_fornecedor = EXISTS (
      SELECT 1 FROM unnest(cc.tags_omie) t
      WHERE lower(trim(t)) = ANY (ARRAY['fornecedor','transportadora'])
    ),
    tem_venda_real = EXISTS (
      SELECT 1 FROM public.sales_orders so
      WHERE so.customer_user_id = cc.user_id
        AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
    ),
    excluir_da_carteira = (
      EXISTS (
        SELECT 1 FROM unnest(cc.tags_omie) t
        WHERE lower(trim(t)) = ANY (ARRAY['fornecedor','transportadora'])
      )
      -- Régua A (founder, 2026-06-15): só sai quem NÃO tem venda real. "Tem pedido = cliente, fica."
      AND NOT EXISTS (
        SELECT 1 FROM public.sales_orders so
        WHERE so.customer_user_id = cc.user_id
          AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
      )
      AND NOT EXISTS (SELECT 1 FROM public.fornecedor_excecao e WHERE e.user_id = cc.user_id)
    ),
    updated_at = now();
  GET DIAGNOSTICS v_classificados = ROW_COUNT;
  SELECT count(*) INTO v_excluidos FROM public.cliente_classificacao WHERE excluir_da_carteira;
  RETURN jsonb_build_object('classificados', v_classificados, 'excluidos', v_excluidos);
END $$;
REVOKE ALL ON FUNCTION public.classificar_clientes_fornecedores() FROM anon, authenticated;

-- ============================================================
-- aplicar_exclusao_fornecedores() — classificar + APLICAR o corte (eligible=false + apaga scores).
-- Codex P1 (cleanup recorrente): roda no cron nightly e fecha o furo do fornecedor classificado
-- PÓS-rollout cujo score velho seguiria aparecendo (a maioria dos leitores não filtra eligible).
-- Idempotente. REVOKE de anon/authenticated (só service_role/cron/SQL Editor).
-- ============================================================
CREATE OR REPLACE FUNCTION public.aplicar_exclusao_fornecedores()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_class jsonb;
  v_elig  int;
  v_cvs   int;
  v_fcs   int;
BEGIN
  v_class := public.classificar_clientes_fornecedores();
  UPDATE public.carteira_assignments SET eligible = false, updated_at = now()
   WHERE eligible
     AND customer_user_id IN (SELECT user_id FROM public.cliente_classificacao WHERE excluir_da_carteira);
  GET DIAGNOSTICS v_elig = ROW_COUNT;
  DELETE FROM public.customer_visit_scores
   WHERE customer_user_id IN (SELECT user_id FROM public.cliente_classificacao WHERE excluir_da_carteira);
  GET DIAGNOSTICS v_cvs = ROW_COUNT;
  DELETE FROM public.farmer_client_scores
   WHERE customer_user_id IN (SELECT user_id FROM public.cliente_classificacao WHERE excluir_da_carteira);
  GET DIAGNOSTICS v_fcs = ROW_COUNT;
  RETURN v_class || jsonb_build_object('eligible_off', v_elig, 'visit_scores_apagados', v_cvs, 'farmer_scores_apagados', v_fcs);
END $$;
REVOKE ALL ON FUNCTION public.aplicar_exclusao_fornecedores() FROM anon, authenticated;

-- ============================================================
-- reverter_exclusao_fornecedor(user, motivo) — curadoria: fornecedor que É cliente real volta.
-- MASTER-ONLY. Adiciona exceção (sticky), tira a flag, re-eligível na carteira, e RE-ENFILEIRA os
-- DOIS recalcs (visit + score) → customer_visit_scores e farmer_client_scores são reconstruídos
-- pelos drains/crons existentes. REVOKE de anon (authenticated passa, mas a gate interna barra não-master).
-- ============================================================
CREATE OR REPLACE FUNCTION public.reverter_exclusao_fornecedor(p_user_id uuid, p_motivo text DEFAULT 'reversão manual')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_enfileirados int;
  v_tmp          int;
BEGIN
  IF NOT public.has_role(auth.uid(), 'master'::public.app_role) THEN
    RAISE EXCEPTION 'apenas master pode reverter exclusão de fornecedor';
  END IF;

  INSERT INTO public.fornecedor_excecao (user_id, motivo, criado_por)
  VALUES (p_user_id, p_motivo, auth.uid())
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE public.cliente_classificacao
     SET excluir_da_carteira = false, updated_at = now()
   WHERE user_id = p_user_id;

  -- eligible respeita a canonicidade (Codex P1): clone (alias ativo) continua eligible=false;
  -- só não-clone volta a true. Senão a reversão ressuscitaria um clone escondido pela B-lite.
  UPDATE public.carteira_assignments
     SET eligible = NOT EXISTS (
           SELECT 1 FROM public.customer_canonical_alias cca
           WHERE cca.alias_user_id = p_user_id AND cca.status = 'active'
         ),
         updated_at = now()
   WHERE customer_user_id = p_user_id;

  -- Re-enfileira recalc p/ cada owner do cliente (reason fixo; ON CONFLICT cobre o índice parcial pending).
  INSERT INTO public.visit_score_recalc_queue (customer_user_id, farmer_id, reason)
  SELECT ca.customer_user_id, ca.owner_user_id, 'reversao_fornecedor'
    FROM public.carteira_assignments ca
   WHERE ca.customer_user_id = p_user_id
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_enfileirados = ROW_COUNT;

  INSERT INTO public.score_recalc_queue (customer_user_id, farmer_id, reason)
  SELECT ca.customer_user_id, ca.owner_user_id, 'reversao_fornecedor'
    FROM public.carteira_assignments ca
   WHERE ca.customer_user_id = p_user_id
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_tmp = ROW_COUNT;
  v_enfileirados := v_enfileirados + v_tmp;
  RETURN jsonb_build_object('revertido', p_user_id, 'recalc_enfileirado', v_enfileirados);
END $$;
REVOKE ALL ON FUNCTION public.reverter_exclusao_fornecedor(uuid, text) FROM anon;

-- ============================================================
-- Trigger de derivação: mudança de tag / cadastro novo mantém is_fornecedor fresco.
-- BEFORE INSERT OR UPDATE OF tags_omie → deriva SÓ is_fornecedor (das tags).
-- excluir_da_carteira depende de venda real (régua A) → responsabilidade EXCLUSIVA da RPC
-- classificar_clientes_fornecedores(). FAIL-SAFE: cadastro novo nasce excluir=false (default) e só
-- é excluído quando a RPC roda com a venda — nunca remove um cliente-fornecedor por engano.
-- ============================================================
CREATE OR REPLACE FUNCTION public.cliente_classificacao_derive()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.is_fornecedor := EXISTS (
    SELECT 1 FROM unnest(NEW.tags_omie) t
    WHERE lower(trim(t)) = ANY (ARRAY['fornecedor','transportadora'])
  );
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_cliente_classificacao_derive ON public.cliente_classificacao;
CREATE TRIGGER trg_cliente_classificacao_derive
  BEFORE INSERT OR UPDATE OF tags_omie ON public.cliente_classificacao
  FOR EACH ROW EXECUTE FUNCTION public.cliente_classificacao_derive();

-- ============================================================
-- Validação (cole no SQL Editor e confira: rpcs = 3, trigger_ok = 1)
-- ============================================================
SELECT 'MIGRATION B OK' AS status,
  (SELECT count(*) FROM pg_proc
     WHERE proname IN ('classificar_clientes_fornecedores','aplicar_exclusao_fornecedores','reverter_exclusao_fornecedor')) AS rpcs,
  (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_cliente_classificacao_derive') AS trigger_ok;
