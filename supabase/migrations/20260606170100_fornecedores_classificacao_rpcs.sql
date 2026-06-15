-- Fase 1 — Fornecedores fora da carteira: RPCs (classificar + reverter) + trigger de derivação.
-- Espelha o helper TS src/lib/fornecedores/classificacao.ts (regra de tag → exclusão).
-- Regra (case/acento-insensível, lower(trim)): tag ∈ {fornecedor,transportadora} = não-cliente.
-- Reversibilidade (P1 Codex): reverter re-enfileira AMBOS os recalcs (visit + score) → os 2 scores voltam.
-- ⚠️ Correção vs. plano: a fila é a TABELA visit_score_recalc_queue (visit_score_recalc_pending é VIEW,
--    security_invoker, não-inserível) + a TABELA score_recalc_queue; ambas têm `reason` NOT NULL e
--    índice único parcial (customer_user_id, farmer_id) WHERE processed_at IS NULL (ON CONFLICT cobre).
-- Idempotente: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS antes do CREATE TRIGGER.

-- ============================================================
-- classificar_clientes_fornecedores() — re-deriva a classificação de TODOS os cadastros.
--   is_fornecedor       = tem tag {fornecedor,transportadora}
--   tem_venda_real      = tem pedido válido (informativo; NÃO decide exclusão na v1)
--   excluir_da_carteira = is_fornecedor AND NÃO há exceção curada (fornecedor_excecao)
-- Roda no SQL Editor após o sync (Task 4) + a curadoria (Task 9). REVOKE de anon/authenticated.
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
        AND so.status NOT IN ('cancelado','rascunho','pendente')
    ),
    excluir_da_carteira = (
      EXISTS (
        SELECT 1 FROM unnest(cc.tags_omie) t
        WHERE lower(trim(t)) = ANY (ARRAY['fornecedor','transportadora'])
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
-- reverter_exclusao_fornecedor(user, motivo) — curadoria: fornecedor que É cliente real volta.
-- MASTER-ONLY. Adiciona exceção (sticky), tira a flag, re-eligível na carteira, e RE-ENFILEIRA os
-- DOIS recalcs (visit + score) → customer_visit_scores e farmer_client_scores são reconstruídos
-- pelos drains/crons existentes. REVOKE de anon (authenticated passa, mas a gate interna barra não-master).
-- ============================================================
CREATE OR REPLACE FUNCTION public.reverter_exclusao_fornecedor(p_user_id uuid, p_motivo text DEFAULT 'reversão manual')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_enfileirados int;
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

  UPDATE public.carteira_assignments
     SET eligible = true, updated_at = now()
   WHERE customer_user_id = p_user_id;

  -- Re-enfileira recalc p/ cada owner do cliente (reason fixo; ON CONFLICT cobre o índice parcial pending).
  INSERT INTO public.visit_score_recalc_queue (customer_user_id, farmer_id, reason)
  SELECT ca.customer_user_id, ca.owner_user_id, 'reversao_fornecedor'
    FROM public.carteira_assignments ca
   WHERE ca.customer_user_id = p_user_id
  ON CONFLICT DO NOTHING;

  INSERT INTO public.score_recalc_queue (customer_user_id, farmer_id, reason)
  SELECT ca.customer_user_id, ca.owner_user_id, 'reversao_fornecedor'
    FROM public.carteira_assignments ca
   WHERE ca.customer_user_id = p_user_id
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_enfileirados = ROW_COUNT;
  RETURN jsonb_build_object('revertido', p_user_id, 'recalc_enfileirado', v_enfileirados);
END $$;
REVOKE ALL ON FUNCTION public.reverter_exclusao_fornecedor(uuid, text) FROM anon;

-- ============================================================
-- Trigger de derivação: cadastro novo (NF de devolução futura) / mudança de tag nasce já classificado.
-- BEFORE INSERT OR UPDATE OF tags_omie → re-deriva is_fornecedor/excluir_da_carteira.
-- (tem_venda_real NÃO entra aqui — exige varrer sales_orders; fica na RPC batch.)
-- Como a RPC classificar() NÃO altera tags_omie no SET, o trigger não interfere nela.
-- ============================================================
CREATE OR REPLACE FUNCTION public.cliente_classificacao_derive()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.is_fornecedor := EXISTS (
    SELECT 1 FROM unnest(NEW.tags_omie) t
    WHERE lower(trim(t)) = ANY (ARRAY['fornecedor','transportadora'])
  );
  NEW.excluir_da_carteira := NEW.is_fornecedor
    AND NOT EXISTS (SELECT 1 FROM public.fornecedor_excecao e WHERE e.user_id = NEW.user_id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_cliente_classificacao_derive ON public.cliente_classificacao;
CREATE TRIGGER trg_cliente_classificacao_derive
  BEFORE INSERT OR UPDATE OF tags_omie ON public.cliente_classificacao
  FOR EACH ROW EXECUTE FUNCTION public.cliente_classificacao_derive();

-- ============================================================
-- Validação (cole no SQL Editor e confira: rpcs = 2, trigger_ok = 1)
-- ============================================================
SELECT 'MIGRATION B OK' AS status,
  (SELECT count(*) FROM pg_proc
     WHERE proname IN ('classificar_clientes_fornecedores','reverter_exclusao_fornecedor')) AS rpcs,
  (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_cliente_classificacao_derive') AS trigger_ok;
