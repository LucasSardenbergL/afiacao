-- ============================================================
-- corrigir_cancelamento_pos_disparo — o gate de papel passa para a forma CANÔNICA
-- ============================================================
-- POR QUÊ: a 20260906152235 escrevia o gate como `IF NOT COALESCE(has_role(…) OR …, false)`.
-- Semanticamente correto e fail-CLOSED — mas `bun run authz:check` REPROVA essa forma, e com
-- razão declarada: o matcher só reconhece bloqueio quando a negação é a CABEÇA da condição, e
-- num `NOT COALESCE(gate(), false)` o `false` é argumento. O contrato de autorização deste repo
-- (scripts/authz-manifest.ts) precisa enxergar o gate para defendê-lo na próxima edição.
--
-- `(A OR B OR C) IS NOT TRUE` mantém exatamente o fail-closed que o COALESCE dava: se algum ramo
-- devolver NULL e nenhum for TRUE, a expressão é NULL, `NULL IS NOT TRUE` é TRUE, e o RAISE
-- dispara. Nenhum comportamento muda; muda a forma, que agora é auditável.
--
-- ⚠️ Migration SEPARADA de propósito. A 20260906152235 JÁ FOI APLICADA em produção (validada por
-- psql-ro em 2026-09-06: trigger armado, RPC DEFINER, trilha com RLS, view com security_invoker).
-- Editar aquele arquivo faria o repo descrever algo diferente do que rodou. `CREATE OR REPLACE`
-- preserva o ACL (nunca `DROP`+`CREATE`, que o RESETARIA — database.md §4), então este bloco é
-- pequeno, idempotente e seguro de recolar.

BEGIN;

CREATE OR REPLACE FUNCTION public.corrigir_cancelamento_pos_disparo(
  p_pedido_id     bigint,
  p_usuario       text,
  p_motivo        text,
  p_evidencia     text,
  p_justificativa text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_agora    timestamptz := now();
  v_evid     text := btrim(COALESCE(p_evidencia, ''));
  v_ant      text;
  v_omie     text;
  v_valor    numeric;
BEGIN
  -- GATE. SECURITY DEFINER bypassa RLS ⇒ a autorização tem de ser explícita, na fronteira.
  -- A FORMA importa tanto quanto a semântica. `NOT COALESCE(gate(), false)` — o que estava aqui —
  -- é fail-CLOSED e mesmo assim REPROVA no `authz:check`: o matcher só aceita a negação como
  -- CABEÇA da condição, e ali o `false` é argumento (limite declarado em lib/authz-contract.ts).
  -- Esta forma casa o ramo `NOT ( … )` do matcher E mantém o fail-closed, com o COALESCE movido
  -- para DENTRO de cada parcela: sem ele, um ramo NULL faria `NOT (NULL)` ser NULL, o IF não
  -- dispararia e o gate falharia ABERTO — que é o defeito que o COALESCE existia para impedir.
  -- Um gate que a fronteira do CI não enxerga é um gate que ninguém defende na próxima edição.
  IF NOT (
       COALESCE(public.has_role(v_uid, 'employee'::public.app_role), false)
       OR COALESCE(public.has_role(v_uid, 'master'::public.app_role), false)
       OR COALESCE(auth.role() = 'service_role', false)
     ) THEN
    RAISE EXCEPTION '[CANCEL-POS-DISPARO-FORBIDDEN] apenas staff corrige cancelamento pos-disparo'
      USING ERRCODE = '42501';
  END IF;

  -- Validação ANTES de qualquer escrita. Depois da primeira, toda falha teria de ser RAISE
  -- (o PostgREST commita a transação que termina sem erro SQL — lição do #2231); aqui ainda
  -- não escrevemos nada, e mesmo assim usamos RAISE para que a recusa seja indistinguível de
  -- um abort — nunca um `{error}` que uma via distraída leia como sucesso.
  IF p_motivo IS NULL OR p_motivo NOT IN
       ('cancelado_junto_ao_fornecedor', 'po_excluido_no_omie', 'duplicidade_operacional') THEN
    RAISE EXCEPTION '[CANCEL-POS-DISPARO-MOTIVO] motivo invalido: % (esperado cancelado_junto_ao_fornecedor | po_excluido_no_omie | duplicidade_operacional)',
      COALESCE(p_motivo, '(nulo)') USING ERRCODE = 'P0001';
  END IF;

  IF length(v_evid) < 4 THEN
    RAISE EXCEPTION '[CANCEL-POS-DISPARO-EVIDENCIA] evidencia obrigatoria: informe o protocolo do fornecedor, o numero do chamado ou o id do PO excluido no Omie (minimo 4 caracteres, veio %)',
      length(v_evid) USING ERRCODE = 'P0001';
  END IF;

  IF p_usuario IS NULL OR btrim(p_usuario) = '' THEN
    RAISE EXCEPTION '[CANCEL-POS-DISPARO-USUARIO] usuario obrigatorio' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK antes de qualquer escrita. Preciso do status ANTERIOR para a trilha, e `RETURNING` só
  -- devolve os valores NOVOS (PG17 não tem `RETURNING OLD.*`). Ler antes SEM lock recriaria
  -- exatamente o TOCTOU da 20260905224959. `FOR NO KEY UPDATE` — não `FOR SHARE`, que faria dois
  -- corretores adquirirem o lock juntos e deadlockarem na promoção (achado Codex no #2231).
  SELECT status, omie_pedido_compra_id, valor_total
    INTO v_ant, v_omie, v_valor
    FROM public.pedido_compra_sugerido
   WHERE id = p_pedido_id
     FOR NO KEY UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '[CANCEL-POS-DISPARO-AUSENTE] pedido % nao encontrado', p_pedido_id
      USING ERRCODE = 'P0001';
  END IF;

  -- ALLOWLIST, não denylist (lição do #2231): esta RPC existe SÓ para o caso pós-disparo. Pedido
  -- em qualquer outro estado tem a porta normal (`cancelar_pedido_sugerido`) — esta não é atalho
  -- para ela, e deixar passar aqui seria abrir um segundo caminho sem o guard daquela.
  IF v_ant NOT IN ('disparado', 'concluido_recebido') THEN
    RAISE EXCEPTION '[CANCEL-POS-DISPARO-ESTADO] pedido % esta em "%" — a correcao pos-disparo so se aplica a disparado/concluido_recebido. Use cancelar_pedido_sugerido().',
      p_pedido_id, v_ant USING ERRCODE = 'P0001';
  END IF;

  -- Abre a porta para ESTE pedido e só para ele. `is_local => true` ⇒ morre no fim da transação
  -- mesmo se algo abaixo lançar.
  PERFORM set_config('app.correcao_cancelamento_pos_disparo', p_pedido_id::text, true);

  UPDATE public.pedido_compra_sugerido
     SET status                             = 'cancelado_humano',
         cancelado_por                      = p_usuario,
         cancelado_em                       = v_agora,
         justificativa_cancelamento         = p_justificativa,
         cancelamento_pos_disparo_motivo    = p_motivo,
         cancelamento_pos_disparo_evidencia = v_evid,
         cancelamento_pos_disparo_por       = p_usuario,
         cancelamento_pos_disparo_em        = v_agora,
         status_envio_portal                = 'nao_aplicavel',  -- mesma higiene do portal da RPC normal
         portal_proximo_retry_em            = NULL,
         atualizado_em                      = v_agora
   WHERE id = p_pedido_id
     AND status IN ('disparado', 'concluido_recebido');  -- redundante sob o lock; barato e fail-closed

  IF NOT FOUND THEN
    -- Sob o lock isto é inalcançável. Se acontecer, algo mudou a linha sem respeitar o lock:
    -- abortar é a única resposta honesta — jamais devolver "ok" sobre zero linhas (#2231).
    RAISE EXCEPTION '[CANCEL-POS-DISPARO-ZERO-LINHAS] o UPDATE do pedido % nao pegou nenhuma linha sob lock', p_pedido_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Fecha a porta ANTES da trilha: nada depois deste ponto precisa dela, e uma função futura que
  -- chame esta e siga escrevendo não herda a autorização.
  PERFORM set_config('app.correcao_cancelamento_pos_disparo', '', true);

  -- A trilha. Mesma transação: se o INSERT falhar, o cancelamento não acontece. Sem trilha,
  -- sem correção — é essa a diferença entre esta porta e o SQL na mão que ela substitui.
  INSERT INTO public.reposicao_cancelamento_pos_disparo_audit
    (pedido_id, status_anterior, status_novo, motivo, evidencia, justificativa,
     omie_pedido_compra_id, valor_total, executado_por, executado_por_uid, executado_em)
  VALUES
    (p_pedido_id, v_ant, 'cancelado_humano', p_motivo, v_evid, p_justificativa,
     v_omie, v_valor, p_usuario, v_uid, v_agora);

  RETURN jsonb_build_object(
    'status', 'ok',
    'pedido_id', p_pedido_id,
    'status_anterior', v_ant,
    'omie_pedido_compra_id', v_omie,
    'motivo', p_motivo
  );
END;
$$;

DO $post$
DECLARE v_src text; v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='corrigir_cancelamento_pos_disparo';
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POST FALHOU [AUSENTE]: corrigir_cancelamento_pos_disparo sumiu -- a correcao legitima ficaria sem porta';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_oid) THEN
    RAISE EXCEPTION 'POST FALHOU [RPC-INVOKER]: a RPC deixou de ser SECURITY DEFINER -- nao gravaria a trilha';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') OR has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU [ACL]: o CREATE OR REPLACE mexeu no ACL (authenticated deve executar, anon nao)';
  END IF;
  v_src := (SELECT prosrc FROM pg_proc WHERE oid=v_oid);
  IF v_src !~ 'IF NOT \([[:space:]]*COALESCE' THEN
    RAISE EXCEPTION 'POST FALHOU [GATE-FORMA]: o gate nao esta na forma `IF NOT (COALESCE(...) OR ...)` -- ou o authz:check volta a reprovar, ou o fail-closed se perdeu';
  END IF;
  IF v_src !~ 'has_role' THEN
    RAISE EXCEPTION 'POST FALHOU [GATE-AUSENTE]: o gate de papel sumiu do corpo -- qualquer authenticated corrigiria cancelamento';
  END IF;
  RAISE NOTICE 'gate de corrigir_cancelamento_pos_disparo na forma canonica, DEFINER e ACL preservados';
END
$post$;

COMMIT;
