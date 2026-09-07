-- SONDA DE EXECUÇÃO — read-only, não escreve nada. São DOIS blocos, DOIS Runs.
--
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
-- ⚠️ POR QUE DOIS BLOCOS — o orçamento de exibição é pequeno e NÃO é um número fixo
--    (4 rodadas medidas em 2026-09-06): 445 chars perderam 2 linhas; a versão com
--    `jsonb::text` cortou no MEIO de uma linha; um relatório de 362 apareceu inteiro; e
--    logo depois o corte veio já aos 296 — MAIS CEDO que os 362. Não calibre pelo número.
--    O desenho é que aguenta: cada bloco daqui cabe em ~240 chars / 5 linhas (medido
--    INTEIRO no SQL Editor, marcador incluído), com o veredito agregado na FRENTE.
--    Regra ao acrescentar função: passou de ~250 caracteres ou 5 linhas, abra outro bloco.
--
-- Como LER a resposta de cada bloco:
--   • A 1ª linha traz o veredito agregado. Ela vem ANTES do detalhe de propósito: o que
--     trunca é o FIM.
--   • Se a última linha (`--- fim A ---` / `--- fim B ---`) NÃO apareceu, truncou: o que
--     faltou é DESCONHECIDO, não aprovado.
--
-- Quatro vereditos possíveis, e os quatro são informação:
--   OK        — executou e devolveu resultado.
--   GATE      — recusou com o erro de AUTORIZAÇÃO esperado. O corpo rodou até o gate,
--               que é o que se queria provar (no SQL Editor não há auth.uid(), então o
--               gate de staff SEMPRE dispara — isso é a defesa, não uma falha).
--   SEM ACESSO — o papel da sessão não tem EXECUTE. NÃO é veredito: é ausência de dado
--               (é o que o `claude_ro` do psql-ro recebe nas 6 — por isso ela é handoff).
--   ❌ QUEBRADA — qualquer outro erro. Este é o que importa: me mande a linha. O erro vem
--               cortado em 120 chars pelo orçamento acima; se precisar dele inteiro, rode
--               só aquela chamada num bloco sozinho.

-- ============================== BLOCO A (funções 1-3) ==============================
DO $sondaA$
DECLARE
  v_n bigint; v_txt text; v_res jsonb;
  v_out text := ''; v_quebradas int := 0; v_semacesso int := 0;
BEGIN
  -- 1. o helper de margem (o coração da fatia) — SECURITY DEFINER, sem gate interno
  BEGIN
    SELECT count(*) INTO v_n FROM private.margem_cliente_agregada();
    v_out := v_out || format(E'\n1. margem_cliente_agregada OK (%s clientes)', v_n);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%permission denied for%' THEN
      v_semacesso := v_semacesso + 1;
      v_out := v_out || E'\n1. margem_cliente_agregada SEM ACESSO (nao e veredito)';
    ELSE
      v_quebradas := v_quebradas + 1;
      v_out := v_out || format(E'\n1. margem_cliente_agregada QUEBRADA [%s] %s', SQLSTATE, left(SQLERRM, 120));
    END IF;
  END;

  -- 2. o wrapper público, com as 2 colunas novas projetadas
  BEGIN
    SELECT count(*), sum(itens_sem_preco)::text INTO v_n, v_txt
      FROM public.get_customer_margin_summary();
    v_out := v_out || format(E'\n2. get_customer_margin_summary OK (%s cli, sem_preco=%s)', v_n, v_txt);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%permission denied for%' THEN
      v_semacesso := v_semacesso + 1;
      v_out := v_out || E'\n2. get_customer_margin_summary SEM ACESSO (nao e veredito)';
    ELSE
      v_quebradas := v_quebradas + 1;
      v_out := v_out || format(E'\n2. get_customer_margin_summary QUEBRADA [%s] %s', SQLSTATE, left(SQLERRM, 120));
    END IF;
  END;

  -- 3. ingestão: payload VAZIO exercita o corpo sem escrever linha nenhuma.
  --    ⚠️ Projete só o que DECIDE o veredito (inserted/failed) — foi o `v_res::text` inteiro
  --    aqui e no 4 que estourou o orçamento e cortou o relatório no meio de uma linha.
  BEGIN
    SELECT public.criar_pedidos_com_itens('[]'::jsonb) INTO v_res;
    v_out := v_out || format(E'\n3. criar_pedidos_com_itens OK (ins=%s fail=%s)',
                             v_res->>'inserted', left(coalesce(v_res->>'failed', 'null'), 20));
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%permission denied for%' THEN
      v_semacesso := v_semacesso + 1;
      v_out := v_out || E'\n3. criar_pedidos_com_itens SEM ACESSO (nao e veredito)';
    ELSE
      v_quebradas := v_quebradas + 1;
      v_out := v_out || format(E'\n3. criar_pedidos_com_itens QUEBRADA [%s] %s', SQLSTATE, left(SQLERRM, 120));
    END IF;
  END;

  RAISE EXCEPTION E'SONDA A (NAO e falha -- e o RELATORIO): % QUEBRADA, % SEM ACESSO, de 3.%\n--- fim A ---',
    v_quebradas, v_semacesso, v_out;
END
$sondaA$;

-- ============================== BLOCO B (funções 4-6) ==============================
-- Run SEPARADO: o EXCEPTION do bloco A aborta a transação, então B nunca rodaria junto.
DO $sondaB$
DECLARE
  v_res jsonb;
  v_out text := ''; v_quebradas int := 0; v_semacesso int := 0;
BEGIN
  BEGIN
    SELECT public.reconciliar_pedidos_omie('[]'::jsonb,
             ARRAY['importado','separacao','enviado','faturado','cancelado'], now()) INTO v_res;
    v_out := v_out || format(E'\n4. reconciliar_pedidos_omie OK (ups=%s falhas=%s)',
                             v_res->>'upserts', left(coalesce(v_res->>'falhas', 'null'), 20));
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%permission denied for%' THEN
      v_semacesso := v_semacesso + 1;
      v_out := v_out || E'\n4. reconciliar_pedidos_omie SEM ACESSO (nao e veredito)';
    ELSE
      v_quebradas := v_quebradas + 1;
      v_out := v_out || format(E'\n4. reconciliar_pedidos_omie QUEBRADA [%s] %s', SQLSTATE, left(SQLERRM, 120));
    END IF;
  END;

  -- 5. ranking: sem auth.uid() o gate de staff dispara ANTES do corpo. Um erro DIFERENTE
  --    desse texto seria quebra real. (Só 5 e 6 têm ramo GATE: 1-4 não têm gate interno,
  --    então um erro de staff LÁ seria mudança de desenho — tem de sair vermelho.)
  BEGIN
    PERFORM public.melhoria_clientes_por_produto('TINTA');
    v_out := v_out || E'\n5. melhoria_clientes_por_produto OK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE '%permission denied for%' THEN
      v_semacesso := v_semacesso + 1;
      v_out := v_out || E'\n5. melhoria_clientes_por_produto SEM ACESSO (nao e veredito)';
    ELSIF SQLERRM LIKE '%staff%' THEN
      v_out := v_out || E'\n5. melhoria_clientes_por_produto GATE (rodou ate o gate)';
    ELSE
      v_quebradas := v_quebradas + 1;
      v_out := v_out || format(E'\n5. melhoria_clientes_por_produto QUEBRADA [%s] %s', SQLSTATE, left(SQLERRM, 120));
    END IF;
  END;

  -- 6. defasagem: mesmo desenho, gate 42501 (insufficient_privilege)
  BEGIN
    PERFORM public.get_defasagem_cliente('[]'::jsonb, '00000000-0000-0000-0000-000000000000'::uuid);
    v_out := v_out || E'\n6. get_defasagem_cliente OK';
  EXCEPTION WHEN OTHERS THEN
    -- ⚠️ O gate interno ('forbidden') e o "permission denied for function" do ACL usam a MESMA
    -- SQLSTATE 42501. Classificar só pelo código fazia a sonda dizer GATE ("o corpo rodou")
    -- para um caso em que ela nem tinha ENTRADO na função — veredito fabricado. Por isso a
    -- ordem dos ramos importa: 'permission denied for' PRIMEIRO.
    IF SQLERRM LIKE '%permission denied for%' THEN
      v_semacesso := v_semacesso + 1;
      v_out := v_out || E'\n6. get_defasagem_cliente SEM ACESSO (nao e veredito)';
    ELSIF SQLERRM LIKE '%forbidden%' THEN
      v_out := v_out || E'\n6. get_defasagem_cliente GATE (rodou ate o gate)';
    ELSE
      v_quebradas := v_quebradas + 1;
      v_out := v_out || format(E'\n6. get_defasagem_cliente QUEBRADA [%s] %s', SQLSTATE, left(SQLERRM, 120));
    END IF;
  END;

  RAISE EXCEPTION E'SONDA B (NAO e falha -- e o RELATORIO): % QUEBRADA, % SEM ACESSO, de 3.%\n--- fim B ---',
    v_quebradas, v_semacesso, v_out;
END
$sondaB$;
