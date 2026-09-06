-- ============================================================
-- remover_itens_pedido_sugerido — a SEGUNDA via de cancelamento entra na fronteira
-- Objetivo: fechar o [P1] do parecer Codex do #2204 na via que o #2204 e a migration
--           20260905224959 (guard atômico da RPC de cancelamento) NÃO cobriram.
-- ============================================================
-- O QUE ESTAVA ABERTO:
--   `useDetalhesModal.recalcularPedido` gravava por UPDATE CRU via PostgREST, sem NENHUM
--   predicado de status: `status='cancelado_humano'`, `cancelado_por/em`, a justificativa
--   e a higiene do portal — espelhando à mão o que a RPC `cancelar_pedido_sugerido` faz,
--   mas FORA dela. O único freio era `podeEditar` no CLIENTE
--   (`status === 'pendente_aprovacao' || status === 'bloqueado_guardrail'`), decidido sobre
--   o `pedido.status` que o browser tem em mãos — potencialmente minutos obsoleto. É
--   literalmente o [P1] do Codex: "a allowlist não é política de servidor; ela valida apenas
--   o status potencialmente obsoleto vindo do browser".
--   Dano: modal aberto com o pedido `pendente_aprovacao` → o pedido é aprovado e disparado →
--   o operador remove o último item → o UPDATE cru carimba `cancelado_humano` sobre uma
--   COMPRA REAL já criada no Omie.
--
-- O DANO COMEÇA ANTES DO CANCELAMENTO (o que a tarefa original não previa):
--   as três vias (remover item, remover em lote, descontinuar SKU) fazem
--   `DELETE FROM pedido_compra_item` **antes** de chamar o recálculo, também sem guard.
--   Fechar só o cancelamento deixaria metade do dano de pé: um pedido `disparado` ficaria
--   com itens faltando — divergência silenciosa contra o pedido real no fornecedor, e sem
--   carimbo nenhum. Por isso a unidade atômica aqui é REMOÇÃO + RECÁLCULO + CANCELAMENTO,
--   e não só o cancelamento.
--
-- POR QUE UMA RPC IRMÃ, e não um parâmetro em `cancelar_pedido_sugerido`:
--   pela SEMÂNTICA, não por limitação técnica. ⚠️ Registro para não repetir o erro: eu havia
--   justificado a irmã por "overload quebraria o PostgREST" e o Codex (gpt-6-astra · max)
--   derrubou — o PostgREST SUPORTA overloads com aridades diferentes; a armadilha real são
--   defaults que se sobrepõem e assinaturas iguais em nome diferindo só no tipo.
--   A razão que se sustenta: remover itens é uma operação DISTINTA de cancelar, e seus
--   estados permitidos são legitimamente diferentes (veja a allowlist abaixo). Copiar o
--   predicado da RPC de cancelamento para "evitar divergência" seria justamente o erro.
--
-- ALLOWLIST (`IN`), não denylist (`NOT IN`) — a diferença que importa:
--   `NOT IN ('disparado','concluido_recebido')` — o predicado do cancelamento — deixaria
--   remover item de um pedido `aprovado_aguardando_disparo`. Esse é exatamente o estado que
--   a edge `disparar-pedidos-aprovados` seleciona para chamar o ERP: permitir remoção ali é
--   permitir alterar os itens DURANTE a chamada ao Omie (a edge lê `pedido_compra_item` para
--   montar o `IncluirPedCompra`). A allowlist aqui é `('pendente_aprovacao','bloqueado_guardrail')`,
--   que é EXATAMENTE o `podeEditar` do cliente — ou seja: esta migration não estreita o
--   produto, ela move para o SERVIDOR a regra que o cliente já pretendia aplicar sozinho.
--
-- POR QUE `FOR NO KEY UPDATE` E NÃO O GUARD NO `WHERE` DA PRIMEIRA ESCRITA:
--   a migration 20260905224959 fecha o TOCTOU pondo o predicado no WHERE do UPDATE, porque
--   lá a escrita é uma só. Aqui são três (DELETE nos filhos, recálculo, UPDATE do pai) e o
--   predicado vive numa TABELA DIFERENTE da primeira escrita. Um `EXISTS (SELECT … FROM
--   pedido_compra_sugerido …)` no WHERE do DELETE NÃO resolve: o EvalPlanQual re-avalia a
--   linha ALVO travada (o item), não o subselect sobre outra tabela — o disparador pode
--   commitar `status='disparado'` depois do snapshot do subselect e o DELETE passar assim
--   mesmo. Travar o pai e só então decidir é correto porque O LOCK MANTÉM A DECISÃO VÁLIDA
--   até o commit; um SELECT sem lock não oferece essa garantia.
--   `FOR NO KEY UPDATE` e não `FOR SHARE`: com SHARE dois removedores adquirem o lock
--   simultaneamente e DEADLOCKAM na promoção quando ambos forem atualizar o pai (achado
--   Codex). `FOR KEY SHARE` é insuficiente — não conflita com o UPDATE de status.
--   Ordem PAI → FILHOS, e essa ordem é a que os outros escritores já praticam: medido em
--   2026-09-06, a edge `disparar-pedidos-aprovados` só faz SELECT em `pedido_compra_item`
--   (3 ocorrências, nenhuma escrita), então a disputa é sempre pela MESMA linha do pai —
--   espera, não deadlock.
--
-- ⚠️ O QUE ESTA MIGRATION **NÃO** FECHA (dito aqui para não ser lido como fechado):
--   1. O EFEITO EXTERNO NO OMIE. O lock serializa o BANCO, não o ERP. Se o disparador já
--      leu os itens e está dentro da chamada `IncluirPedCompra`, a compra acontece mesmo
--      que a remoção seja recusada depois — e vice-versa. Fechar isso é claim atômico no
--      disparador (a fatia que o doc guard-fora-da-escrita-nao-e-guard.md já descreve como
--      cenário B, ainda aberto). A allowlist estreita MUITO a janela (só `pendente_aprovacao`
--      e `bloqueado_guardrail` passam, e o disparador não seleciona esses estados), mas
--      "estreita" não é "fecha" e não afirmo o contrário.
--   2. `aprovar_pedido_sugerido` TEM O MESMO TOCTOU — verificado na PROD em 2026-09-06:
--      `SELECT * INTO … WHERE id` → valida → `UPDATE … WHERE id`, sem repetir o predicado e
--      sem lock. Uma aprovação concorrente pode esperar este lock e gravar
--      `aprovado_aguardando_disparo` POR CIMA do cancelamento que esta função acabou de
--      fazer. É a mesma classe de defeito, em outra função, e é outra fatia.
--   3. Esta é uma fronteira de APLICAÇÃO, não de PRIVILÉGIO. Sendo `SECURITY INVOKER`, não
--      dá para revogar DELETE de `pedido_compra_item` do `authenticated` para forçar a
--      passagem por aqui — isso quebraria o DELETE executado pela PRÓPRIA função. Um cliente
--      antigo ou outro caminho ainda consegue escrever direto. Fechar por privilégio exige
--      desenho diferente (DEFINER + revogação), deliberadamente fora desta fatia.
--
-- SEGURANÇA: `SECURITY INVOKER` (a RLS de `pedido_compra_item`/`pedido_compra_sugerido`
--   continua valendo para quem chama — mesmo comportamento do PostgREST hoje) + `search_path`
--   preso. Medido em 2026-09-06: as policies de `pedido_compra_item` são uniformes
--   (`cap_compras_ler(auth.uid())`, sem predicado por LINHA) ⇒ o chamador vê TODOS os itens
--   do pedido ou NENHUM, nunca um subconjunto. É isso que torna a soma do recálculo confiável;
--   se um dia entrar policy por linha nesta tabela, o recálculo passa a poder subcontar e
--   `restantes = 0` deixaria de significar "pedido vazio" (o assert V3 abaixo vigia isso).
-- Idempotente: `CREATE OR REPLACE`, re-rodar não muda nada.

BEGIN;

CREATE OR REPLACE FUNCTION public.remover_itens_pedido_sugerido(
  p_pedido_id bigint, p_item_ids bigint[], p_usuario text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
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
$$;

-- ACL explícito na MESMA transação da criação (achado Codex: a irmã nasce com ACL PRÓPRIO —
-- não herda nada de `cancelar_pedido_sugerido`). O default de `CREATE FUNCTION` é
-- `EXECUTE TO PUBLIC`; aqui isso é estreitado, e `authenticated` é nomeado explicitamente
-- porque é quem o botão da tela usa. `anon` fica de fora: remover item de pedido de compra
-- não é operação anônima.
REVOKE ALL ON FUNCTION public.remover_itens_pedido_sugerido(bigint, bigint[], text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.remover_itens_pedido_sugerido(bigint, bigint[], text) FROM anon;
GRANT EXECUTE ON FUNCTION public.remover_itens_pedido_sugerido(bigint, bigint[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remover_itens_pedido_sugerido(bigint, bigint[], text) TO service_role;

-- ── Postcondição: a migration ABORTA se não pegou, na cara de quem colou ──────────────
DO $post$
DECLARE
  v_oid  oid;
  v_src  text;
  v_resp jsonb;
BEGIN
  SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'remover_itens_pedido_sugerido'
     AND pg_get_function_identity_arguments(p.oid) = 'p_pedido_id bigint, p_item_ids bigint[], p_usuario text';
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POST FALHOU [AUSENTE]: remover_itens_pedido_sugerido(bigint,bigint[],text) nao existe -- a remocao de itens no modal quebraria inteira';
  END IF;

  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'POST FALHOU [SECDEF]: a funcao e SECURITY DEFINER -- bypassaria a RLS de pedido_compra_item e de pedido_compra_sugerido';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_oid AND proconfig::text LIKE '%search_path=public, pg_temp%') THEN
    RAISE EXCEPTION 'POST FALHOU [SEARCH-PATH]: search_path nao esta preso em (public, pg_temp)';
  END IF;

  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU [ACL-EXECUTE]: authenticated nao executa a RPC -- os botoes de remover item/lote/descontinuar morreriam com permission denied';
  END IF;

  -- O contrapositivo do assert acima: `has_function_privilege` seria verdadeiro tambem se o
  -- EXECUTE viesse de PUBLIC, entao sozinho ele nao prova que o REVOKE pegou. Este prova.
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU [ACL-ANON]: anon executa a RPC -- o REVOKE nao pegou e remocao de item ficou anonima';
  END IF;

  v_src := (SELECT prosrc FROM pg_proc WHERE oid = v_oid);

  -- ESTRUTURAL 1: o lock no pai. E o invariante inteiro desta migration -- sem ele o status
  -- lido vira retrato e o [P1] reabre. Textual e portanto conservador: reformatar faz gritar,
  -- o que e o lado certo do alarme.
  IF v_src !~ 'FOR NO KEY UPDATE' THEN
    RAISE EXCEPTION 'POST FALHOU [SEM-LOCK]: o SELECT do pedido nao trava a linha (FOR NO KEY UPDATE ausente) -- a decisao de status volta a ser um retrato e o TOCTOU reabre';
  END IF;

  -- ESTRUTURAL 2: a ALLOWLIST. Uma denylist aqui deixaria passar
  -- `aprovado_aguardando_disparo`, que e o estado que o disparador leva ao Omie.
  IF v_src !~ E'v_status NOT IN \\(''pendente_aprovacao'', ''bloqueado_guardrail''\\)' THEN
    RAISE EXCEPTION 'POST FALHOU [ALLOWLIST]: o predicado deixou de ser a allowlist (pendente_aprovacao, bloqueado_guardrail) -- uma denylist permitiria remover item durante a chamada ao Omie';
  END IF;

  -- ESTRUTURAL 3: a ordem. O lock do pai tem de vir ANTES do DELETE nos filhos; invertida, a
  -- ordem pai->filho quebra e o DELETE roda sobre um status nao verificado.
  IF strpos(v_src, 'FOR NO KEY UPDATE') > strpos(v_src, 'DELETE FROM pedido_compra_item') THEN
    RAISE EXCEPTION 'POST FALHOU [ORDEM]: o DELETE nos itens vem ANTES do lock do pedido -- o guard deixou de proteger a primeira escrita';
  END IF;

  -- EXECUCAO: plpgsql e LATE-BOUND -- `CREATE OR REPLACE` aceita corpo invalido e so quebra em
  -- runtime. Roda a funcao de verdade com `NULL::bigint`: `s.id = NULL` e NULL, nunca casa uma
  -- PK, entao o caminho executa o SELECT ... FOR NO KEY UPDATE e retorna no NOT FOUND -- sem
  -- tocar UMA linha e sem depender de nenhuma transacao concorrente.
  -- ⚠️ NAO use `min(id) - 1` como id "ausente" (licao da 20260905224959): um INSERT nao
  -- commitado com id menor transforma a sonda numa linha REAL entre a leitura e a escrita.
  v_resp := public.remover_itens_pedido_sugerido(NULL::bigint, ARRAY[-1]::bigint[], 'postcondicao_migration');
  IF v_resp->>'error' IS DISTINCT FROM 'pedido não encontrado' THEN
    RAISE EXCEPTION 'POST FALHOU [EXEC-LATE-BOUND]: a RPC nao executou o caminho de pedido ausente (devolveu %) -- corpo late-bound quebrado', v_resp;
  END IF;

  RAISE NOTICE 'remover_itens_pedido_sugerido: INVOKER, search_path preso, authenticated executa e anon NAO, lock do pai antes do DELETE, allowlist de 2 status, e a funcao EXECUTOU (sonda id=NULL, nenhuma linha tocada)';
END
$post$;

COMMIT;
