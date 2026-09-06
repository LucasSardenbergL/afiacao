-- SONDA DE EXECUÇÃO — read-only, não escreve nada.
-- Por que ela existe: a validação anterior provou que os objetos EXISTEM no catálogo.
-- Existir não é funcionar: SQL e plpgsql são late-bound, então o CREATE aceita corpo que
-- só quebra ao RODAR (coluna que não existe, ambiguidade, função ausente). É a armadilha
-- que já mordeu este repo 3x. Aqui cada função é EXECUTADA de verdade.
--
-- 🟣 Lovable → SQL Editor → cola → Run.  ⚠️ A resposta VAI APARECER COMO ERRO — é assim
--    de propósito: o relatório é entregue por `RAISE EXCEPTION` porque o SQL Editor do
--    Lovable **não exibe `RAISE NOTICE`** (medido em 2026-09-06: o founder rodou a versão
--    com NOTICE e a tela ficou MUDA — 6 vereditos viraram "ausência de dado" lida como
--    aprovação). O EXCEPTION ainda tem um bônus: aborta a transação, então nem por acidente
--    esta sonda deixa rastro no banco.
--
-- Como LER a resposta:
--   • A 1ª linha já traz o veredito agregado (quantas QUEBRADAS). Ela vem ANTES do detalhe
--     de propósito: o SQL Editor TRUNCA mensagem longa (medido no mesmo dia — cortou no meio
--     da 4ª de 6 linhas quando o relatório despejava o jsonb inteiro).
--   • Se a última linha `--- fim ---` NÃO apareceu, a mensagem foi truncada: o que faltou
--     é DESCONHECIDO, não aprovado.
--
-- Três vereditos possíveis, e os três são informação:
--   OK        — executou e devolveu resultado.
--   GATE      — recusou com o erro de AUTORIZAÇÃO esperado. O corpo rodou até o gate,
--               que é o que se queria provar (no SQL Editor não há auth.uid(), então o
--               gate de staff SEMPRE dispara — isso é a defesa, não uma falha).
--   SEM ACESSO — o papel da sessão não tem EXECUTE. NÃO é veredito: é ausência de dado
--               (é o que o `claude_ro` do psql-ro recebe nas 6 — por isso ela é handoff).
--   ❌ QUEBRADA — qualquer outro erro. Este é o que importa: me mande a mensagem.
DO $sonda$
DECLARE
  v_n bigint; v_txt text; v_res jsonb;
  v_out text := ''; v_quebradas int := 0; v_semacesso int := 0;
BEGIN
  -- 1. o helper de margem (o coração da fatia) — SECURITY DEFINER, sem gate interno
  BEGIN
    SELECT count(*) INTO v_n FROM private.margem_cliente_agregada();
    v_out := v_out || format(E'\n1. private.margem_cliente_agregada() ....... OK (%s clientes)', v_n);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%permission denied for%' THEN
      v_semacesso := v_semacesso + 1;
      v_out := v_out || E'\n1. private.margem_cliente_agregada() ....... SEM ACESSO (nao executei -- nao e veredito)';
    ELSE
      v_quebradas := v_quebradas + 1;
      v_out := v_out || format(E'\n1. private.margem_cliente_agregada() ....... QUEBRADA [%s] %s', SQLSTATE, left(SQLERRM, 160));
    END IF;
  END;

  -- 2. o wrapper público, com as 2 colunas novas projetadas
  BEGIN
    SELECT count(*), sum(itens_sem_preco)::text INTO v_n, v_txt
      FROM public.get_customer_margin_summary();
    v_out := v_out || format(E'\n2. get_customer_margin_summary() .......... OK (%s clientes, itens_sem_preco=%s)', v_n, v_txt);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%permission denied for%' THEN
      v_semacesso := v_semacesso + 1;
      v_out := v_out || E'\n2. get_customer_margin_summary() .......... SEM ACESSO (nao executei -- nao e veredito)';
    ELSE
      v_quebradas := v_quebradas + 1;
      v_out := v_out || format(E'\n2. get_customer_margin_summary() .......... QUEBRADA [%s] %s', SQLSTATE, left(SQLERRM, 160));
    END IF;
  END;

  -- 3. ingestão: payload VAZIO exercita o corpo sem escrever linha nenhuma.
  --    ⚠️ Projete só o que DECIDE o veredito (inserted/failed) — foi o `v_res::text` inteiro
  --    aqui e no 4 que estourou o limite do SQL Editor e cortou o relatório no meio.
  BEGIN
    SELECT public.criar_pedidos_com_itens('[]'::jsonb) INTO v_res;
    v_out := v_out || format(E'\n3. criar_pedidos_com_itens([]) ............ OK (inserted=%s failed=%s)',
                             v_res->>'inserted', left(coalesce(v_res->>'failed', 'null'), 40));
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%permission denied for%' THEN
      v_semacesso := v_semacesso + 1;
      v_out := v_out || E'\n3. criar_pedidos_com_itens([]) ............ SEM ACESSO (nao executei -- nao e veredito)';
    ELSE
      v_quebradas := v_quebradas + 1;
      v_out := v_out || format(E'\n3. criar_pedidos_com_itens([]) ............ QUEBRADA [%s] %s', SQLSTATE, left(SQLERRM, 160));
    END IF;
  END;

  BEGIN
    SELECT public.reconciliar_pedidos_omie('[]'::jsonb,
             ARRAY['importado','separacao','enviado','faturado','cancelado'], now()) INTO v_res;
    v_out := v_out || format(E'\n4. reconciliar_pedidos_omie([]) ........... OK (upserts=%s falhas=%s)',
                             v_res->>'upserts', left(coalesce(v_res->>'falhas', 'null'), 40));
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%permission denied for%' THEN
      v_semacesso := v_semacesso + 1;
      v_out := v_out || E'\n4. reconciliar_pedidos_omie([]) ........... SEM ACESSO (nao executei -- nao e veredito)';
    ELSE
      v_quebradas := v_quebradas + 1;
      v_out := v_out || format(E'\n4. reconciliar_pedidos_omie([]) ........... QUEBRADA [%s] %s', SQLSTATE, left(SQLERRM, 160));
    END IF;
  END;

  -- 5. ranking: sem auth.uid() o gate de staff dispara ANTES do corpo. Um erro DIFERENTE
  --    desse texto seria quebra real. (Só 5 e 6 têm ramo GATE: 1-4 não têm gate interno,
  --    então um erro de staff LÁ seria mudança de desenho — tem de sair vermelho.)
  BEGIN
    PERFORM public.melhoria_clientes_por_produto('TINTA');
    v_out := v_out || E'\n5. melhoria_clientes_por_produto() ........ OK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%permission denied for%' THEN
      v_semacesso := v_semacesso + 1;
      v_out := v_out || E'\n5. melhoria_clientes_por_produto() ........ SEM ACESSO (nao executei -- nao e veredito)';
    ELSIF SQLERRM LIKE '%staff%' THEN
      v_out := v_out || E'\n5. melhoria_clientes_por_produto() ........ GATE (corpo rodou ate o gate de staff)';
    ELSE
      v_quebradas := v_quebradas + 1;
      v_out := v_out || format(E'\n5. melhoria_clientes_por_produto() ........ QUEBRADA [%s] %s', SQLSTATE, left(SQLERRM, 160));
    END IF;
  END;

  -- 6. defasagem: mesmo desenho, gate 42501 (insufficient_privilege)
  BEGIN
    PERFORM public.get_defasagem_cliente('[]'::jsonb, '00000000-0000-0000-0000-000000000000'::uuid);
    v_out := v_out || E'\n6. get_defasagem_cliente() ................ OK';
  EXCEPTION WHEN OTHERS THEN
    -- ⚠️ O gate interno ('forbidden') e o "permission denied for function" do ACL usam a MESMA
    -- SQLSTATE 42501. Classificar só pelo código fazia a sonda dizer GATE ("o corpo rodou")
    -- para um caso em que ela nem tinha ENTRADO na função — veredito fabricado. Por isso a
    -- ordem dos ramos importa: 'permission denied for' PRIMEIRO.
    IF SQLERRM LIKE '%permission denied for%' THEN
      v_semacesso := v_semacesso + 1;
      v_out := v_out || E'\n6. get_defasagem_cliente() ................ SEM ACESSO (nao executei -- nao e veredito)';
    ELSIF SQLERRM LIKE '%forbidden%' THEN
      v_out := v_out || E'\n6. get_defasagem_cliente() ................ GATE (corpo rodou ate o gate de staff)';
    ELSE
      v_quebradas := v_quebradas + 1;
      v_out := v_out || format(E'\n6. get_defasagem_cliente() ................ QUEBRADA [%s] %s', SQLSTATE, left(SQLERRM, 160));
    END IF;
  END;

  -- O relatório sai por EXCEPTION porque o SQL Editor não mostra NOTICE. O veredito agregado
  -- vem ANTES do detalhe para sobreviver ao truncamento; `--- fim ---` é a prova de que não truncou.
  RAISE EXCEPTION E'SONDA (isto NAO e falha -- e o RELATORIO): % QUEBRADA(s), % SEM ACESSO, de 6.%\n--- fim ---',
    v_quebradas, v_semacesso, v_out;
END
$sonda$;
