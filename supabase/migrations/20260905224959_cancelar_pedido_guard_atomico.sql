-- ============================================================
-- cancelar_pedido_sugerido — o guard de status passa a viver DENTRO da escrita
-- Objetivo: fechar o [P1] TOCTOU do parecer Codex xhigh no PR #2204.
-- ============================================================
-- POR QUÊ (a corrida, cenário A do parecer):
--   A RPC fazia `SELECT * INTO v_pedido … WHERE id`, decidia sobre esse retrato, e só depois
--   gravava com `UPDATE … WHERE id` — SEM repetir o predicado e SEM lock. Em paralelo, a edge
--   `disparar-pedidos-aprovados` seleciona `aprovado_aguardando_disparo`, segura a linha em
--   memória durante a chamada `IncluirPedCompra` (rede, segundos) e finaliza com outro
--   `UPDATE … WHERE id`. Intercalando:
--       RPC lê 'aprovado' → disparador cria o PO no Omie e grava 'disparado' → RPC grava por
--       último e deixa `cancelado_humano` sobre uma COMPRA REAL EM ANDAMENTO.
--   O PR #2204 estreitou a janela pelo front (lote nunca toca `aprovado_aguardando_disparo`;
--   status relido do banco antes de chamar) mas não podia fechá-la: a janela é do servidor.
--
-- O FIX: uma única instrução. O predicado de status vive no MESMO comando que grava.
--   Em READ COMMITTED (o default do Supabase), um UPDATE que esbarra numa linha travada por
--   uma transação concorrente ESPERA o commit dela e RE-AVALIA o WHERE contra a versão NOVA
--   da linha (EvalPlanQual). Se o disparador gravou 'disparado' primeiro, o predicado passa a
--   ser falso e a linha é PULADA → 0 linhas → a RPC recusa. Era exatamente essa re-avaliação
--   que o SELECT-decide-UPDATE não tinha: ele decidia sobre um retrato que o lock não protegia.
--   Mesmo padrão do `iniciar_envio_portal_pre_claim` (claim condicional em UMA instrução), que
--   já existe nesta tabela pelo mesmo motivo.
--
-- O QUE ESTA MIGRATION **NÃO** FECHA (dito aqui para não ser lido como fechado):
--   O cenário B do mesmo parecer — a RPC cancela PRIMEIRO e o disparador, que já selecionou a
--   linha, cria o PO no Omie e grava por cima. O operador vê "rejeitado" e a compra acontece.
--   ⚠️ NÃO afirme que o estado final de B fica `status='disparado'` com os carimbos de
--   cancelamento, "verdadeiro e detectável". Rascunhei isso e o Codex (gpt-6-astra · max)
--   derrubou com dois contra-exemplos, ambos preexistentes e ambos fora do alcance de qualquer
--   consulta do tipo `status='disparado' AND cancelado_em IS NOT NULL`:
--     1. a edge IGNORA o `{error}` do seu UPDATE final e retorna `status_final='disparado'` mesmo
--        se a gravação falhar ⇒ o banco fica `cancelado_humano` SEM `omie_pedido_compra_id`,
--        com PO real no Omie e o fornecedor possivelmente já notificado;
--     2. se a resposta do Omie se perder, o catch grava `falha_envio` POR CIMA do cancelamento.
--   Ou seja: B é P1 aberto, e não há hoje sinal confiável que o encontre depois do fato.
--   Fechar B é claim atômico no disparador — outra fatia, com deploy manual de edge. E o claim
--   NÃO precisa de um status novo em voo (era a minha suposição; o Codex apontou o furo): uma
--   COLUNA de claim dedicada na própria linha arbitra com raio muito menor sobre rótulos, KPIs e
--   filtros — o disparador reivindica condicionalmente, o cancelamento exige ausência de claim, e
--   só quem ganhou chama o Omie. Resultado externo ambíguo mantém a pendência para conciliação;
--   liberar o claim por timeout recria o problema. Ver o doc do objetivo.
--
-- PRESERVADO de propósito: assinatura, SECURITY INVOKER (`prosecdef=false`), o `SET search_path`,
-- o ACL (por isso `CREATE OR REPLACE` e NUNCA `DROP`+`CREATE`, que RESETARIA o ACL — database.md
-- §4), a higiene do portal (`status_envio_portal='nao_aplicavel'`, `portal_proximo_retry_em=NULL`)
-- e o vocabulário `cancelado_humano`. Idempotente: re-rodar não muda nada.

BEGIN;

CREATE OR REPLACE FUNCTION public.cancelar_pedido_sugerido(
  p_pedido_id bigint, p_usuario text, p_justificativa text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_id      bigint;
  v_status  text;
  v_disparo timestamptz;
BEGIN
  -- ⚠️ O guard e a escrita são UMA instrução. Não separe de novo: o `AND status NOT IN (…)`
  -- aqui é o que faz o Postgres re-avaliar o predicado contra a linha recém-commitada por um
  -- disparo concorrente. Movê-lo para um SELECT acima reabre exatamente o [P1] do #2204.
  -- `status` é NOT NULL na tabela; se algum dia deixar de ser, a negação vira NULL e a linha
  -- NÃO é atualizada — falha FECHADA (recusa o cancelamento), que é o lado seguro aqui.
  UPDATE pedido_compra_sugerido
  SET status = 'cancelado_humano',
      cancelado_por = p_usuario,
      cancelado_em = NOW(),
      justificativa_cancelamento = p_justificativa,
      status_envio_portal = 'nao_aplicavel',  -- higiene do portal (Fase 1, migration 20260530210001)
      portal_proximo_retry_em = NULL,         -- e cancela qualquer retry agendado
      atualizado_em = NOW()
  WHERE id = p_pedido_id
    AND status NOT IN ('disparado', 'concluido_recebido')
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'ok', 'pedido_id', p_pedido_id);
  END IF;

  -- 0 linhas. A DECISÃO já foi tomada acima, pelo predicado — esta leitura serve só para
  -- MONTAR A MENSAGEM e não pode voltar a decidir nada.
  SELECT status, horario_disparo_real INTO v_status, v_disparo
    FROM pedido_compra_sugerido
   WHERE id = p_pedido_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'pedido não encontrado');
  END IF;

  IF v_status IN ('disparado', 'concluido_recebido') THEN
    -- COALESCE porque `'texto' || NULL` colapsa a STRING INTEIRA para NULL: sem ele, um
    -- pedido disparado sem `horario_disparo_real` devolvia {"error": null}.
    -- ⚠️ Medido (correção do Codex a um rascunho meu): a recusa NÃO sumia da tela — em
    -- `rejeitar-pedido.ts` o `{error:null}` cai no ramo `!confirmouOk(data)` e vira falha
    -- genérica, e o `CancelarModal` passa pela mesma fronteira. O que se ganha aqui é a
    -- mensagem VERDADEIRA em vez de "resposta inesperada da RPC (sem status ok)", que não
    -- diz ao operador que a compra já foi disparada.
    RETURN jsonb_build_object(
      'error', 'pedido já foi disparado em ' || COALESCE(v_disparo::text, '(horário não registrado)')
    );
  END IF;

  -- A linha existe e não está num status bloqueado, mas o UPDATE não a pegou ⇒ ela mudou entre
  -- as duas instruções. Não afirmamos "já foi disparado" (seria fabricar o motivo): dizemos o
  -- que sabemos.
  -- Mesmo COALESCE da mensagem acima, pelo mesmo motivo: se o NOT NULL de `status` algum dia
  -- cair, `'texto' || NULL` colapsaria TAMBÉM esta recusa para {"error": null} (achado Codex).
  RETURN jsonb_build_object(
    'error', 'pedido não pôde ser cancelado (status atual: ' || COALESCE(v_status, '(desconhecido)') || ')'
  );
END;
$$;

-- ── Postcondição: a migration ABORTA se não pegou, na cara de quem colou ──────────────
DO $post$
DECLARE
  v_oid        oid;
  v_src        text;
  v_resp       jsonb;
BEGIN
  SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'cancelar_pedido_sugerido'
     AND pg_get_function_identity_arguments(p.oid) = 'p_pedido_id bigint, p_usuario text, p_justificativa text';
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POST FALHOU [AUSENTE]: cancelar_pedido_sugerido(bigint,text,text) nao existe -- o botao Cancelar e a rejeicao em lote quebrariam';
  END IF;

  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'POST FALHOU [SECDEF]: a funcao virou SECURITY DEFINER -- era INVOKER e passaria a bypassar a RLS de pedido_compra_sugerido';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_oid AND proconfig::text LIKE '%search_path=public, pg_temp%') THEN
    RAISE EXCEPTION 'POST FALHOU [SEARCH-PATH]: search_path nao esta preso em (public, pg_temp)';
  END IF;

  -- ACL: asserta o RESULTADO que o botão precisa (authenticated executa), não o verbo usado.
  -- `has_function_privilege` é verdadeiro também quando o privilégio vem de PUBLIC — então isto
  -- NÃO é um detector de `DROP`+`CREATE` (que recria com o default `EXECUTE TO PUBLIC` e passaria
  -- neste teste). O que ele pega é a perda EFETIVA de EXECUTE, que é o que quebra a tela.
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU [ACL-EXECUTE]: authenticated nao executa a RPC -- o botao Cancelar e a rejeicao em lote morreriam com permission denied';
  END IF;

  -- ESTRUTURAL: o guard tem de estar preso ao WHERE do UPDATE. É o invariante inteiro desta
  -- migration. (Textual e portanto conservador: reformatar o corpo faz gritar. Isso é o lado certo.)
  v_src := (SELECT prosrc FROM pg_proc WHERE oid = v_oid);
  IF v_src !~ 'WHERE id = p_pedido_id[[:space:]]+AND status NOT IN' THEN
    RAISE EXCEPTION 'POST FALHOU [GUARD-NO-UPDATE]: o predicado de status nao esta no WHERE do UPDATE -- o TOCTOU do #2204 continua aberto';
  END IF;

  -- EXECUÇÃO: plpgsql é LATE-BOUND — `CREATE OR REPLACE` aceita corpo inválido e só quebra em
  -- runtime. Roda a função de verdade com `NULL::bigint`: `id = NULL` é NULL, nunca casa uma PK,
  -- e isso independe de qualquer transação concorrente. Assim o UPDATE e o SELECT são planejados
  -- e executados sem tocar UMA linha real.
  -- ⚠️ NÃO use `min(id) - 1` aqui (achado Codex, gpt-6-astra · max): se um INSERT com id MENOR
  -- ainda não commitou, a sonda escolhe um id que a outra transação está prestes a materializar —
  -- "ausente por construção" vira uma linha REAL entre a sonda e o UPDATE. Sequence crescente
  -- não ordena commits.
  -- O UPDATE ainda toma `RowExclusiveLock` na TABELA (não em linha) até o fim desta transação:
  -- convive com DML concorrente, conflita só com manutenção/DDL. E medido em prod hoje: os 3
  -- triggers de `pedido_compra_sugerido` são todos `FOR EACH ROW`, então zero linhas = zero
  -- trigger. Se um dia entrar um `FOR EACH STATEMENT` que escreve, este assert precisa mudar.
  v_resp := public.cancelar_pedido_sugerido(NULL::bigint, 'postcondicao_migration', 'assert de execução — nenhum pedido tocado');
  IF v_resp->>'error' IS DISTINCT FROM 'pedido não encontrado' THEN
    RAISE EXCEPTION 'POST FALHOU [EXEC-LATE-BOUND]: a RPC nao executou o caminho de pedido ausente (devolveu %) -- corpo late-bound quebrado', v_resp;
  END IF;

  RAISE NOTICE 'cancelar_pedido_sugerido: INVOKER, search_path preso, authenticated executa, guard DENTRO do UPDATE, e a função EXECUTOU (sonda id=NULL, nenhuma linha tocada)';
END
$post$;

COMMIT;
