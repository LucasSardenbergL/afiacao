-- SONDA DE EXECUÇÃO — read-only, não escreve nada.
-- Por que ela existe: a validação anterior provou que os objetos EXISTEM no catálogo.
-- Existir não é funcionar: SQL e plpgsql são late-bound, então o CREATE aceita corpo que
-- só quebra ao RODAR (coluna que não existe, ambiguidade, função ausente). É a armadilha
-- que já mordeu este repo 3x. Aqui cada função é EXECUTADA de verdade.
--
-- Três vereditos possíveis, e os três são informação:
--   OK        — executou e devolveu resultado.
--   GATE      — recusou com o erro de AUTORIZAÇÃO esperado. O corpo rodou até o gate,
--               que é o que se queria provar (no SQL Editor não há auth.uid(), então o
--               gate de staff SEMPRE dispara — isso é a defesa, não uma falha).
--   ❌ QUEBRADA — qualquer outro erro. Este é o que importa: me mande a mensagem.
DO $sonda$
DECLARE
  v_n bigint; v_txt text; v_res jsonb;
BEGIN
  -- 1. o helper de margem (o coração da fatia) — SECURITY DEFINER, sem gate interno
  BEGIN
    SELECT count(*) INTO v_n FROM private.margem_cliente_agregada();
    RAISE NOTICE '1. private.margem_cliente_agregada() ....... OK (% clientes)', v_n;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%permission denied for%' THEN
      RAISE NOTICE '1. private.margem_cliente_agregada() ....... SEM ACESSO (nao executei — nao e veredito)';
    ELSE
      RAISE NOTICE '1. private.margem_cliente_agregada() ....... QUEBRADA [%] %', SQLSTATE, SQLERRM;
    END IF;
  END;

  -- 2. o wrapper público, com as 2 colunas novas projetadas
  BEGIN
    SELECT count(*), sum(itens_sem_preco)::text INTO v_n, v_txt
      FROM public.get_customer_margin_summary();
    RAISE NOTICE '2. get_customer_margin_summary() .......... OK (% clientes, itens_sem_preco=%)', v_n, v_txt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%permission denied for%' THEN
      RAISE NOTICE '2. get_customer_margin_summary() .......... SEM ACESSO (nao executei — nao e veredito)';
    ELSE
      RAISE NOTICE '2. get_customer_margin_summary() .......... QUEBRADA [%] %', SQLSTATE, SQLERRM;
    END IF;
  END;

  -- 3. ingestão: payload VAZIO exercita o corpo sem escrever linha nenhuma
  BEGIN
    SELECT public.criar_pedidos_com_itens('[]'::jsonb) INTO v_res;
    RAISE NOTICE '3. criar_pedidos_com_itens([]) ............ OK (%)', v_res::text;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%permission denied for%' THEN
      RAISE NOTICE '3. criar_pedidos_com_itens([]) ............ SEM ACESSO (nao executei — nao e veredito)';
    ELSE
      RAISE NOTICE '3. criar_pedidos_com_itens([]) ............ QUEBRADA [%] %', SQLSTATE, SQLERRM;
    END IF;
  END;

  BEGIN
    SELECT public.reconciliar_pedidos_omie('[]'::jsonb,
             ARRAY['importado','separacao','enviado','faturado','cancelado'], now()) INTO v_res;
    RAISE NOTICE '4. reconciliar_pedidos_omie([]) ........... OK (%)', v_res::text;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%permission denied for%' THEN
      RAISE NOTICE '4. reconciliar_pedidos_omie([]) ........... SEM ACESSO (nao executei — nao e veredito)';
    ELSE
      RAISE NOTICE '4. reconciliar_pedidos_omie([]) ........... QUEBRADA [%] %', SQLSTATE, SQLERRM;
    END IF;
  END;

  -- 5. ranking: sem auth.uid() o gate de staff dispara ANTES do corpo. Um erro DIFERENTE
  --    desse texto seria quebra real.
  BEGIN
    PERFORM public.melhoria_clientes_por_produto('TINTA');
    RAISE NOTICE '5. melhoria_clientes_por_produto() ........ OK';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%permission denied for%' THEN
        RAISE NOTICE '5. melhoria_clientes_por_produto() ........ SEM ACESSO (nao executei — nao e veredito)';
      ELSIF SQLERRM LIKE '%staff%' THEN
        RAISE NOTICE '5. melhoria_clientes_por_produto() ........ GATE (corpo rodou ate o gate de staff)';
      ELSE
        RAISE NOTICE '5. melhoria_clientes_por_produto() ........ QUEBRADA [%] %', SQLSTATE, SQLERRM;
      END IF;
  END;

  -- 6. defasagem: mesmo desenho, gate 42501 (insufficient_privilege)
  BEGIN
    PERFORM public.get_defasagem_cliente('[]'::jsonb, '00000000-0000-0000-0000-000000000000'::uuid);
    RAISE NOTICE '6. get_defasagem_cliente() ................ OK';
  EXCEPTION WHEN OTHERS THEN
    -- ⚠️ O gate interno ('forbidden') e o "permission denied for function" do ACL usam a MESMA
    -- SQLSTATE 42501. Classificar só pelo código fazia a sonda dizer GATE ("o corpo rodou")
    -- para um caso em que ela nem tinha ENTRADO na função — veredito fabricado.
    IF SQLERRM LIKE '%permission denied for%' THEN
      RAISE NOTICE '6. get_defasagem_cliente() ................ SEM ACESSO (nao executei — nao e veredito)';
    ELSIF SQLERRM LIKE '%forbidden%' THEN
      RAISE NOTICE '6. get_defasagem_cliente() ................ GATE (corpo rodou ate o gate de staff)';
    ELSE
      RAISE NOTICE '6. get_defasagem_cliente() ................ QUEBRADA [%] %', SQLSTATE, SQLERRM;
    END IF;
  END;

  RAISE NOTICE '--- FIM DA SONDA (se faltou alguma linha 1..6, ela abortou fora do handler) ---';
END
$sonda$;
