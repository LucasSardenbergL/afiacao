-- Loyalty hardening (#2 auto-crédito + #3 resgate quebrado + resgate-grátis) — auditoria 2026-06-04.
--
-- #2 (segurança): "Users can earn points" deixava o CLIENTE inserir loyalty_points type='earn'
--    de QUALQUER valor pra si (auto-crédito). O ganho legítimo é via trigger award_loyalty_points()
--    (SECURITY DEFINER, bypassa RLS) → dropar a policy NÃO quebra o earning.
-- #2b (segurança, achado codex): "Users can create their own redemptions" deixava o cliente
--    inserir um resgate 'pendente' DIRETO, sem saldo nem débito → "resgate grátis" se o fulfillment
--    processa a fila. Dropada também — a RPC (definer) é o único caminho de criar resgate.
-- #3 (money-bug): o resgate em Loyalty.tsx inseria loyalty_points type='resgate' client-side, mas a
--    RLS só aceitava 'earn' → o débito FALHAVA → saldo nunca caía. Débito passa a ser server-side.
--
-- Consumidores não afetados: useAdminLoyalty (staff → "Staff can manage all *"), omie-sync
-- (service_role), trigger de earn (SECURITY DEFINER). Cliente mantém o SELECT do próprio histórico.

-- 1) Fecha o auto-crédito de pontos e o resgate-grátis (writes diretos do cliente).
DROP POLICY IF EXISTS "Users can earn points" ON public.loyalty_points;
DROP POLICY IF EXISTS "Users can create their own redemptions" ON public.loyalty_redemptions;

-- 2) Resgate atômico server-side: pontos resolvidos por CATÁLOGO autoritativo (não vêm do cliente),
--    valida saldo, cria o resgate e debita. Advisory lock 64-bit anti double-spend na corrida.
CREATE OR REPLACE FUNCTION public.resgatar_recompensa(p_reward_key text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_points integer;
  v_name text;
  v_saldo bigint; -- SUM(points) é bigint (robustez; > int max é irreal mas evita overflow)
  v_redemption_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'nao autenticado';
  END IF;

  -- Catálogo autoritativo (espelha REWARDS do front; o cliente passa só a CHAVE, nunca o preço).
  CASE p_reward_key
    WHEN 'frete_10'       THEN v_points := 100; v_name := '10% desconto no frete';
    WHEN 'afiacao_gratis' THEN v_points := 300; v_name := 'Afiação grátis (1 ferramenta)';
    WHEN 'kit_manutencao' THEN v_points := 500; v_name := 'Kit de manutenção';
    WHEN 'desconto_20'    THEN v_points := 750; v_name := 'Desconto 20% no próximo pedido';
    ELSE RAISE EXCEPTION 'recompensa desconhecida: %', p_reward_key;
  END CASE;

  -- Serializa resgates concorrentes do MESMO usuário (anti double-spend / double-click).
  PERFORM pg_advisory_xact_lock(hashtextextended('loyalty_resgate:' || v_uid::text, 0));

  SELECT COALESCE(SUM(points), 0) INTO v_saldo
  FROM public.loyalty_points
  WHERE user_id = v_uid;

  IF v_saldo < v_points THEN
    RAISE EXCEPTION 'saldo insuficiente: % < %', v_saldo, v_points;
  END IF;

  INSERT INTO public.loyalty_redemptions (user_id, reward_name, points_spent, status)
  VALUES (v_uid, v_name, v_points, 'pendente')
  RETURNING id INTO v_redemption_id;

  INSERT INTO public.loyalty_points (user_id, points, type, description)
  VALUES (v_uid, -v_points, 'resgate', 'Resgate: ' || v_name);

  RETURN v_redemption_id;
END;
$$;

-- Só autenticado executa (anon tem grant explícito no Supabase — revogar por nome).
REVOKE ALL ON FUNCTION public.resgatar_recompensa(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resgatar_recompensa(text) TO authenticated;
