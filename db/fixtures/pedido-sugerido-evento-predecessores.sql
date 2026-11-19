-- Predecessores VIVOS em PROD, lidos por pg_get_functiondef em 2026-11-19 (psql-ro).
-- md5(prosrc): remover 2c34777763a45e0ce5e87188b460dd4e · aprovar(bigint,text) dd87b376da51b2d1603e8ade8c28b3a8
-- Usado só por db/test-pedido-sugerido-evento.sh para provar a PRE contra o corpo real.
CREATE OR REPLACE FUNCTION public.remover_itens_pedido_sugerido(p_pedido_id bigint, p_item_ids bigint[], p_usuario text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status    text;
  v_removidos bigint[];
  v_restantes integer;
  v_total     numeric;
  v_cancelou  boolean := false;
BEGIN
  IF p_item_ids IS NULL OR cardinality(p_item_ids) = 0 THEN
    RETURN jsonb_build_object('error', 'nenhum item informado');
  END IF;

  -- (1) TRAVA O PAI ANTES DE QUALQUER ESCRITA. Esta é a linha que faz o guard valer:
  -- em READ COMMITTED, se o disparador/aprovador já segura a linha, este SELECT ESPERA o
  -- commit dele e relê a versão NOVA (EvalPlanQual) — então `v_status` abaixo é o status
  -- REAL, não um retrato. E o lock é mantido até o fim da transação, de modo que a decisão
  -- tomada sobre ele continua verdadeira enquanto as escritas acontecem.
  -- ⚠️ Não troque por um SELECT sem lock nem mova esta leitura para depois do DELETE:
  -- as duas coisas reabrem exatamente o [P1] que esta migration fecha.
  SELECT s.status INTO v_status
    FROM pedido_compra_sugerido s
   WHERE s.id = p_pedido_id
     FOR NO KEY UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'pedido não encontrado');
  END IF;

  -- (2) ALLOWLIST — a regra do cliente virando política de servidor. Ver o cabeçalho:
  -- `aprovado_aguardando_disparo` fica DE FORA de propósito (é o estado que o disparador pega).
  IF v_status NOT IN ('pendente_aprovacao', 'bloqueado_guardrail') THEN
    -- COALESCE porque `'texto' || NULL` colapsa a STRING INTEIRA para NULL: sem ele, se o
    -- NOT NULL de `status` algum dia cair, a recusa viraria {"error": null} e o front leria
    -- "sem erro" — a recusa SUMIRIA da tela. Mesma lição da 20260905224959.
    RETURN jsonb_build_object(
      'error', 'pedido não permite remoção de itens (status atual: ' || COALESCE(v_status, '(desconhecido)') || ')'
    );
  END IF;

  -- ⚠️ DAQUI PARA BAIXO JÁ HÁ ESCRITA. Toda falha vira RAISE (rollback da transação inteira),
  -- NUNCA `RETURN jsonb_build_object('error', …)`: devolver JSON de erro depois de um DELETE
  -- não desfaz o DELETE — o PostgREST commita a transação que termina sem erro SQL, e o
  -- operador veria "falhou" com os itens já apagados (achado Codex).

  -- (3) O DELETE é preso ao pedido JÁ TRAVADO. O `pedido_id = p_pedido_id` não é redundante:
  -- é ele que impede que um id de item de OUTRO pedido (que não passou pelo guard acima)
  -- seja apagado de carona.
  WITH apagados AS (
    DELETE FROM pedido_compra_item
     WHERE pedido_id = p_pedido_id
       AND id = ANY(p_item_ids)
    RETURNING id
  )
  SELECT array_agg(id) INTO v_removidos FROM apagados;

  -- (4) RECÁLCULO A PARTIR DO BANCO, não do retrato do browser. O total que o front somava
  -- vinha de um SELECT anterior ao DELETE: com dois removedores concorrentes, cada um contava
  -- o item que o outro ainda não tinha commitado e ambos gravavam um total errado. Somar aqui,
  -- sob o lock do pai, elimina isso.
  SELECT count(*)::integer,
         COALESCE(SUM(COALESCE(qtde_final, qtde_sugerida, 0) * COALESCE(preco_unitario, 0)), 0)
    INTO v_restantes, v_total
    FROM pedido_compra_item
   WHERE pedido_id = p_pedido_id;

  -- (5) O recálculo NÃO é condicional ao cancelamento: `valor_total`/`num_skus` são derivados
  -- legítimos e são gravados nos DOIS ramos. O que o guard condiciona é o CARIMBO DE STATUS.
  IF v_restantes = 0 THEN
    UPDATE pedido_compra_sugerido
       SET valor_total = 0,
           num_skus = 0,
           status = 'cancelado_humano',
           cancelado_por = p_usuario,
           cancelado_em = NOW(),
           justificativa_cancelamento = 'Todos os itens foram removidos manualmente',
           status_envio_portal = 'nao_aplicavel',  -- higiene do portal (20260530210001)
           portal_proximo_retry_em = NULL,         -- e cancela qualquer retry agendado
           atualizado_em = NOW()
     WHERE id = p_pedido_id;
    v_cancelou := true;
  ELSE
    UPDATE pedido_compra_sugerido
       SET valor_total = v_total,
           num_skus = v_restantes,
           atualizado_em = NOW()
     WHERE id = p_pedido_id;
  END IF;

  -- UPDATE que pega ZERO linhas não é sucesso (achado Codex): sob RLS, um chamador que
  -- enxerga a linha no SELECT pode não poder atualizá-la. Sem este assert a função devolveria
  -- 'ok' com os itens apagados e o cabeçalho intacto — pior que a falha original.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'remover_itens_pedido_sugerido: o UPDATE do pedido % nao pegou nenhuma linha (RLS de escrita?) -- itens ja apagados, abortando para nao deixar cabecalho divergente', p_pedido_id;
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok',
    'pedido_id', p_pedido_id,
    'removidos', COALESCE(cardinality(v_removidos), 0),
    'restantes', v_restantes,
    'valor_total', v_total,
    'cancelado', v_cancelou
  );
END;
$function$

;
CREATE OR REPLACE FUNCTION public.aprovar_pedido_sugerido(p_pedido_id bigint, p_usuario text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT private.cap_compras_ler(auth.uid()) THEN
    RAISE EXCEPTION 'Acesso negado: requer capacidade de compras' USING ERRCODE = '42501';
  END IF;
  RETURN public.aprovar_pedido_sugerido(p_pedido_id, p_usuario, NULL::jsonb);
END;
$function$

;
