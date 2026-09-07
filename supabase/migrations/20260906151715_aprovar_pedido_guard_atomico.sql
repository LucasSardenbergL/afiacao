-- ============================================================
-- aprovar_pedido_sugerido — o guard de status passa a viver DENTRO da escrita
-- Objetivo: fechar o TOCTOU na TERCEIRA via da mesma classe no money-path de reposição.
-- ============================================================
-- POR QUÊ:
--   O corpo VIVO (lido da PROD via `pg_get_functiondef` em 2026-09-06 — o snapshot do repo
--   não prova a definição viva) decidia sobre um RETRATO e gravava sem reconferir:
--       SELECT * INTO v_pedido … WHERE id = p_pedido_id;   -- retrato
--       IF v_pedido.status NOT IN (…) THEN … END IF;       -- decide sobre o retrato
--       UPDATE … WHERE id = p_pedido_id;                   -- grava SEM repetir o predicado
--   Em READ COMMITTED (default do Supabase) o `SELECT` NÃO bloqueia: ele lê o snapshot ANTIGO.
--   Uma aprovação concorrente a um cancelamento (ou a uma remoção de itens que esvazia o
--   pedido) lê 'pendente_aprovacao', passa no guard, ESPERA no lock da outra transação e, quando
--   ela commita 'cancelado_humano', o `UPDATE … WHERE id` continua casando e carimba
--   'aprovado_aguardando_disparo' POR CIMA do cancelamento. O pedido volta à fila do disparador
--   e vira COMPRA REAL no Omie depois de ter sido cancelado por um humano.
--
--   Achado por parecer Codex (gpt-6-astra · max) durante a entrega da `remover_itens_pedido_sugerido`
--   e confirmado contra a produção. É a 3ª via da mesma classe:
--     1ª `cancelar_pedido_sugerido`      → 20260905224959 (guard no WHERE; escrita única)
--     2ª `remover_itens_pedido_sugerido` → 20260906105549 (lock no pai; 3 escritas, predicado
--                                          em OUTRA tabela ⇒ `FOR NO KEY UPDATE`)
--     3ª esta.
--
-- O FIX: uma única instrução — como na 1ª via, porque aqui a escrita também é UMA só e o
--   predicado vive na PRÓPRIA linha alvo. Um UPDATE que esbarra numa linha travada por outra
--   transação ESPERA o commit dela e RE-AVALIA o WHERE contra a versão NOVA (EvalPlanQual):
--   se o cancelamento gravou primeiro, o predicado fica falso, a linha é PULADA → 0 linhas → a
--   RPC recusa. Era exatamente essa re-avaliação que o SELECT-decide-UPDATE não tinha.
--   NÃO precisa de `FOR NO KEY UPDATE` (a 2ª via precisou porque lá o predicado estava em outra
--   tabela e o EvalPlanQual re-avalia a linha ALVO travada, não o pai).
--
-- ALLOWLIST, não denylist: o predicado é `IN ('pendente_aprovacao','bloqueado_guardrail')` — o
--   MESMO conjunto que a função já exigia (ela negava o complemento), agora como política de
--   servidor. Uma denylist deixaria aprovar um pedido já 'disparado' ou 'expirado_sem_aprovacao'
--   sempre que um status novo entrasse no vocabulário sem alguém lembrar de adicioná-lo à lista.
--
-- FAIL-CLOSED de graça: `status` é NOT NULL na tabela hoje. Se um dia deixar de ser, `status IN
--   (…)` vira NULL, a linha NÃO é atualizada e a RPC RECUSA — o lado seguro.
--
-- O COALESCE das mensagens NÃO é cosmético (é o mesmo achado da 1ª via, e aqui MORDE MAIS
--   FORTE): `'texto' || NULL` colapsa a STRING INTEIRA para NULL, e `erroDoJsonb` em
--   `src/components/reposicao/pedidos/aprovar-disparar.ts` trata `error == null` como AUSÊNCIA
--   de erro. Um `{"error": null}` não curto-circuitaria: o fluxo seguiria para o disparo e o
--   operador veria desfecho de SUCESSO para uma aprovação RECUSADA. Falha ABERTA. Hoje é
--   inalcançável (NOT NULL); o COALESCE é a defesa se o NOT NULL cair.
--
-- CONTRATO PRESERVADO: `sera_disparado_em` continua no retorno, agora vindo do `RETURNING` da
--   linha REALMENTE gravada (antes vinha do retrato pré-UPDATE). Medido: hoje NENHUM consumidor
--   lê esse campo (`git grep sera_disparado_em` só acha o próprio corpo no schema-snapshot; o
--   front lê apenas `error`) — preservá-lo custa um identificador e mantém esta migration como
--   correção PURA do TOCTOU, sem mudança de contrato de carona.
--
-- PRESERVADO de propósito: assinatura `(bigint, text)`, SECURITY INVOKER (`prosecdef=false`,
--   medido na PROD), o `SET search_path TO 'public','pg_temp'` e o ACL — por isso
--   `CREATE OR REPLACE` e NUNCA `DROP`+`CREATE`, que RESETARIA o ACL (database.md §4).
--   Idempotente: re-rodar não muda nada.

BEGIN;

CREATE OR REPLACE FUNCTION public.aprovar_pedido_sugerido(
  p_pedido_id bigint, p_usuario text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_id     bigint;
  v_corte  timestamptz;
  v_status text;
BEGIN
  -- ⚠️ O guard e a escrita são UMA instrução. Não separe de novo: o predicado de status preso
  -- a este WHERE é o que faz o Postgres re-avaliá-lo contra a linha recém-commitada por um
  -- cancelamento concorrente. Movê-lo para um SELECT acima reabre exatamente o TOCTOU.
  UPDATE pedido_compra_sugerido
  SET status = 'aprovado_aguardando_disparo',
      aprovado_por = p_usuario,
      aprovado_em = NOW(),
      atualizado_em = NOW()
  WHERE id = p_pedido_id
    AND status IN ('pendente_aprovacao', 'bloqueado_guardrail')
  RETURNING id, horario_corte_planejado INTO v_id, v_corte;

  IF v_id IS NOT NULL THEN
    -- `sera_disparado_em` sai do RETURNING: é o valor da linha que ACABOU de ser gravada.
    RETURN jsonb_build_object('status', 'ok', 'pedido_id', p_pedido_id,
                              'sera_disparado_em', v_corte);
  END IF;

  -- 0 linhas. A DECISÃO já foi tomada acima, pelo predicado — esta leitura serve só para
  -- MONTAR A MENSAGEM e não pode voltar a decidir nada.
  SELECT status INTO v_status FROM pedido_compra_sugerido WHERE id = p_pedido_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'pedido não encontrado');
  END IF;

  IF v_status IN ('pendente_aprovacao', 'bloqueado_guardrail') THEN
    -- A linha está num status aprovável AGORA, mas o UPDATE não a pegou ⇒ ela mudou entre as
    -- duas instruções. Dizer "já está no estado pendente_aprovacao" seria FABRICAR o motivo
    -- (e mentir: nesse estado ela é aprovável). Dizemos só o que sabemos.
    RETURN jsonb_build_object(
      'error', 'pedido mudou de estado durante a aprovação (estado atual: '
               || COALESCE(v_status, '(desconhecido)') || ') - tente de novo'
    );
  END IF;

  RETURN jsonb_build_object(
    'error', 'pedido já está no estado ' || COALESCE(v_status, '(desconhecido)')
  );
END;
$$;

-- Reafirma o EXECUTE que o botão "Aprovar" precisa. NO-OP hoje (`authenticated=X/postgres` já
-- está no ACL da PROD, medido em 2026-09-06, e `CREATE OR REPLACE` preserva o ACL); existe como
-- defesa se o privilégio se perder e como alvo da falsificação F4 do harness. Idempotente.
GRANT EXECUTE ON FUNCTION public.aprovar_pedido_sugerido(bigint, text) TO authenticated;

-- ── Postcondição: a migration ABORTA se não pegou, na cara de quem colou ──────────────
DO $post$
DECLARE
  v_oid  oid;
  v_src  text;
  v_resp jsonb;
BEGIN
  SELECT p.oid INTO v_oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'aprovar_pedido_sugerido'
     AND pg_get_function_identity_arguments(p.oid) = 'p_pedido_id bigint, p_usuario text';
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POST FALHOU [AUSENTE]: aprovar_pedido_sugerido(bigint,text) nao existe -- o botao Aprovar quebraria';
  END IF;

  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'POST FALHOU [SECDEF]: a funcao virou SECURITY DEFINER -- era INVOKER e passaria a bypassar a RLS de pedido_compra_sugerido';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_oid AND proconfig::text LIKE '%search_path=public, pg_temp%') THEN
    RAISE EXCEPTION 'POST FALHOU [SEARCH-PATH]: search_path nao esta preso em (public, pg_temp)';
  END IF;

  -- ACL: asserta o RESULTADO que o botão precisa (authenticated executa), não o verbo usado.
  -- `has_function_privilege` é verdadeiro também via PUBLIC — então isto NÃO detecta
  -- `DROP`+`CREATE` (que recria com o default `EXECUTE TO PUBLIC` e passaria aqui). O que ele
  -- pega é a perda EFETIVA de EXECUTE, que é o que apaga o botão da tela.
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU [ACL-EXECUTE]: authenticated nao executa a RPC -- o botao Aprovar morreria com permission denied';
  END IF;

  v_src := (SELECT prosrc FROM pg_proc WHERE oid = v_oid);

  -- ESTRUTURAL 1 — POSIÇÃO: o predicado de status tem de estar preso ao WHERE do UPDATE.
  -- É o invariante inteiro desta migration. (Textual e portanto conservador: reformatar o
  -- corpo faz gritar. Esse é o lado certo de errar.)
  IF v_src !~ 'WHERE id = p_pedido_id[[:space:]]+AND status' THEN
    RAISE EXCEPTION 'POST FALHOU [GUARD-NO-UPDATE]: o predicado de status nao esta no WHERE do UPDATE -- o TOCTOU continua aberto e a aprovacao pode gravar sobre um cancelamento';
  END IF;

  -- ESTRUTURAL 2 — POLARIDADE: allowlist, não denylist. Separado do assert de POSIÇÃO de
  -- propósito: uma denylist colada no WHERE passaria no de cima e continuaria deixando
  -- aprovar status que ninguém lembrou de listar.
  IF v_src !~ $re$AND status IN \('pendente_aprovacao', 'bloqueado_guardrail'\)$re$ THEN
    RAISE EXCEPTION 'POST FALHOU [ALLOWLIST]: o guard nao e a allowlist (pendente_aprovacao, bloqueado_guardrail) -- status novo no vocabulario passaria a ser aprovavel em silencio';
  END IF;

  -- EXECUÇÃO: plpgsql é LATE-BOUND — `CREATE OR REPLACE` aceita corpo inválido e só quebra em
  -- runtime. Roda a função de verdade com `NULL::bigint`: `id = NULL` é NULL, nunca casa uma PK,
  -- e isso independe de qualquer transação concorrente. Assim o UPDATE e o SELECT são planejados
  -- e executados sem tocar UMA linha real.
  -- ⚠️ NÃO use `min(id) - 1` aqui (achado Codex): se um INSERT com id MENOR ainda não commitou,
  -- a sonda escolhe um id que a outra transação está prestes a materializar — "ausente por
  -- construção" vira uma linha REAL entre a sonda e o UPDATE. Sequence crescente não ordena commits.
  -- O UPDATE ainda toma `RowExclusiveLock` na TABELA (não em linha) até o fim desta transação:
  -- convive com DML concorrente, conflita só com manutenção/DDL. E medido na PROD hoje: os 3
  -- triggers de `pedido_compra_sugerido` são todos `FOR EACH ROW`, então zero linhas = zero
  -- trigger. Se um dia entrar um `FOR EACH STATEMENT` que escreve, este assert precisa mudar.
  v_resp := public.aprovar_pedido_sugerido(NULL::bigint, 'postcondicao_migration');
  IF v_resp->>'error' IS DISTINCT FROM 'pedido não encontrado' THEN
    RAISE EXCEPTION 'POST FALHOU [EXEC-LATE-BOUND]: a RPC nao executou o caminho de pedido ausente (devolveu %) -- corpo late-bound quebrado', v_resp;
  END IF;

  RAISE NOTICE 'aprovar_pedido_sugerido: INVOKER, search_path preso, authenticated executa, allowlist DENTRO do UPDATE, e a funcao EXECUTOU (sonda id=NULL, nenhuma linha tocada)';
END
$post$;

COMMIT;
