-- ============================================================================================
-- Recusa DEFINITIVA do portal Sayerlack: o servidor deixa de reabrir e passa a encerrar.
-- Incidente: pedido #3169 (2026-09-30, R$ 12.414, 13 SKUs) — aprovado + erro_nao_retentavel
--   (GRUPO_LEADTIME_MISMATCH), sem protocolo, sem Omie, efetivarAttempted=false. Ficou 11 DIAS
--   aprovado e disparável à mão, com o alerta `reposicao_portal_humano` tocando, enquanto o motor
--   (por desenho, [FANTASMA] em gerar_pedidos_sugeridos_ciclo) já tinha recomprado 10 dos 13 SKUs
--   no #3174 e 2 no #3187. Precedentes do mesmo estado: #1276, #1497, #2388 (19 dias), #2416.
--   Todos terminaram em cancelamento humano. A tela ganhou o botão no PR #2955; isto é o servidor.
--
-- (1) iniciar_envio_portal_pre_claim — passa a RECUSAR estados de portal que não podem voltar
--     a 'pendente_envio_portal' por um disparo:
--       • erro_nao_retentavel — a recusa se repete, ou (se o cadastro mudou) reenvia itens que
--         o ciclo seguinte já comprou. Nada deduplica entre pedidos. A saída consciente continua
--         sendo o "Forçar reenvio" do PortalDrawer (admin, com confirmação), que grava
--         'pendente_envio_portal' ANTES do disparo — por isso não passa por este bloqueio.
--       • aceito_portal_sem_protocolo / indeterminado_requer_conciliacao — o portal PODE ter o
--         pedido. A edge já barra antes de chamar a RPC; aqui vira defesa em profundidade.
--       • sucesso_portal / enviado_portal — idem (a edge devolve already_sent quando há protocolo;
--         sem protocolo, reabrir duplicaria).
--     Lista NEGATIVA de propósito: os estados que entram hoje (nao_aplicavel no 1º envio,
--     pendente_envio_portal, erro_retentavel, falha_envio_portal) seguem idênticos. Recusar é
--     fail-closed (nenhuma compra), e a edge já trata `false` como "claim perdido".
--
-- (2) reposicao_encerrar_recusas_definitivas(p_dias) + cron horário — encerra como `cancelado`
--     (decisão do founder 2026-10-11: reusa o status, autor 'sistema:recusa_portal', prazo 3 dias)
--     SÓ o pedido que PROVADAMENTE nunca chegou ao fornecedor:
--       status='aprovado_aguardando_disparo' · status_envio_portal='erro_nao_retentavel' ·
--       sem portal_protocolo · sem omie_pedido_compra_id/numero · evidence.efetivarAttempted
--       = false EXPLÍCITO (ausente ≠ false) · sem disparo_claim_em · a ÚLTIMA tentativa em
--       pedidos_portal_tentativas é a própria recusa e terminou há > p_dias.
--     Precisão > recall: na dúvida o pedido fica onde está e o alerta continua tocando.
--     `falha_envio` fica FORA (a tentativa de Omie aconteceu — conciliar antes).
--     Mesma higiene do cancelar_pedido_sugerido: status_envio_portal='nao_aplicavel' e
--     portal_proximo_retry_em=NULL. portal_erro/portal_resposta ficam (rastro forense).
--     Predicado e escrita numa ÚNICA instrução (EvalPlanQual re-avalia contra a versão nova da
--     linha se um disparo concorrente a travar — mesmo padrão do guard atômico de 2026-09-05).
--
-- (3) analytics_outbox_pedido_compra — 'cancelado' passa a emitir reposicao.sugestao_cancelada
--     (com origem_cancelamento humano|sistema); sem isso os encerramentos automáticos sumiriam do funil.
--
-- APLICAR: bun run db:aplicar supabase/migrations/<este arquivo> — o executor fornece a transação.
-- Idempotente (CREATE OR REPLACE preserva ACL; cron.schedule com o mesmo nome ATUALIZA o job).
-- Pré-voo (psql-ro, 2026-10-11): corpo de prod de iniciar_envio_portal_pre_claim conferido via
--   pg_get_functiondef = o da 20260906170000; 0 linhas casam o predicado de (2) hoje.
-- ============================================================================================

-- (1) ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.iniciar_envio_portal_pre_claim(p_pedido_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_claimed boolean;
BEGIN
  UPDATE public.pedido_compra_sugerido
     SET status_envio_portal = 'pendente_envio_portal',
         portal_erro = NULL,
         portal_proximo_retry_em = now() + interval '15 minutes'
   WHERE id = p_pedido_id
     AND COALESCE(status_envio_portal, 'nao_aplicavel') NOT IN (
           'enviando_portal',
           'erro_nao_retentavel',
           'aceito_portal_sem_protocolo',
           'indeterminado_requer_conciliacao',
           'sucesso_portal',
           'enviado_portal')
     AND status IN ('aprovado_aguardando_disparo', 'disparado', 'falha_envio')
     AND portal_recusa_motivo IS NULL
  RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed, false);
END;
$function$;

-- (2) ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reposicao_encerrar_recusas_definitivas(p_dias integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ids bigint[];
BEGIN
  IF p_dias IS NULL OR p_dias < 1 THEN
    RAISE EXCEPTION '[ENCERRAR-RECUSA] p_dias invalido (%): minimo 1', p_dias USING ERRCODE = '22023';
  END IF;

  WITH encerrados AS (
    UPDATE public.pedido_compra_sugerido pcs
       SET status = 'cancelado',
           cancelado_por = 'sistema:recusa_portal',
           cancelado_em = now(),
           justificativa_cancelamento =
             'Encerrado automaticamente: recusa definitiva do portal Sayerlack há mais de ' || p_dias
             || ' dia(s), sem protocolo, sem PO no Omie e sem clique no Efetivar. Motivo do portal: '
             || COALESCE(NULLIF(btrim(portal_erro), ''), '(não registrado)')
             || '. Os itens ainda necessários voltam pelo ciclo normal.',
           status_envio_portal = 'nao_aplicavel',
           portal_proximo_retry_em = NULL,
           atualizado_em = now()
     WHERE status = 'aprovado_aguardando_disparo'
       AND status_envio_portal = 'erro_nao_retentavel'
       AND NULLIF(btrim(portal_protocolo), '') IS NULL
       AND NULLIF(btrim(omie_pedido_compra_id), '') IS NULL
       AND NULLIF(btrim(omie_pedido_compra_numero), '') IS NULL
       AND portal_resposta -> 'evidence' -> 'efetivarAttempted' = 'false'::jsonb
       AND disparo_claim_em IS NULL
       AND cancelado_em IS NULL
       -- Relógio = a ÚLTIMA tentativa no portal, e ela tem de ser a própria recusa definitiva.
       -- NÃO `atualizado_em`: salvar condição de pagamento (useDetalhesModal) renova a linha e
       -- adiaria o encerramento sem nova tentativa (achado Codex). Sem tentativa registrada →
       -- não encerra (precisão > recall). Índice (pedido_id, iniciado_em DESC) cobre o LIMIT 1.
       AND EXISTS (
         SELECT 1
           FROM (SELECT t.status_resultado, t.concluido_em
                   FROM public.pedidos_portal_tentativas t
                  WHERE t.pedido_id = pcs.id
                  ORDER BY t.iniciado_em DESC
                  LIMIT 1) ult
          WHERE ult.status_resultado = 'erro_nao_retentavel'
            AND ult.concluido_em < now() - make_interval(days => p_dias))
    RETURNING pcs.id
  )
  SELECT COALESCE(array_agg(e.id ORDER BY e.id), '{}') INTO v_ids FROM encerrados e;

  RETURN jsonb_build_object('encerrados', cardinality(v_ids), 'ids', to_jsonb(v_ids), 'dias', p_dias);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reposicao_encerrar_recusas_definitivas(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reposicao_encerrar_recusas_definitivas(integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.reposicao_encerrar_recusas_definitivas(integer) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.reposicao_encerrar_recusas_definitivas(integer) TO service_role;

SELECT cron.schedule(
  'reposicao-encerrar-recusas-definitivas',
  '40 * * * *',
  $cron$SELECT public.reposicao_encerrar_recusas_definitivas(3);$cron$
);

-- (3) ---------------------------------------------------------------------------------------
-- analytics_outbox_pedido_compra: o encerramento automático (status 'cancelado') emitia NADA — o
-- funil criada→aprovada→cancelada perderia exatamente esses pedidos (achado Codex). Passa a emitir
-- `reposicao.sugestao_cancelada` também para 'cancelado', com `origem_cancelamento` humano|sistema
-- (o rótulo, nunca o e-mail de quem cancelou). Resto do corpo = prod (pg_get_functiondef 2026-10-11).
-- A view analytics_outbox_reconciliacao só concilia aprovada/expirada: nada a ajustar nela.
CREATE OR REPLACE FUNCTION public.analytics_outbox_pedido_compra()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_evento text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_evento := 'reposicao.sugestao_criada';
  ELSIF NEW.aprovado_em IS NOT NULL AND OLD.aprovado_em IS NULL THEN
    v_evento := 'reposicao.sugestao_aprovada';
  -- ⚠️ `IS DISTINCT FROM` e não `UPDATE OF status`: o Postgres dispara
  -- `UPDATE OF` mesmo quando o valor final não mudou.
  ELSIF NEW.status = 'expirado_sem_aprovacao' AND OLD.status IS DISTINCT FROM NEW.status THEN
    v_evento := 'reposicao.sugestao_expirada';
  ELSIF NEW.status IN ('cancelado_humano', 'cancelado') AND OLD.status IS DISTINCT FROM NEW.status THEN
    v_evento := 'reposicao.sugestao_cancelada';
  ELSE
    RETURN NULL;  -- AFTER trigger: o retorno é ignorado
  END IF;

  -- FAIL-OPEN deliberado: telemetria NUNCA reprova o money-path. Aprovar uma
  -- compra não pode falhar porque a outbox está indisponível.
  -- ⚠️ Isto deixa de ser outbox transacional ESTRITA, e a troca é declarada,
  -- não escondida. O que impede virar a "sonda que degrada em silêncio" do
  -- CLAUDE.md é a view do bloco 5: o silêncio é AUDITÁVEL contra a fonte, e a
  -- ausência ganha denominador. Fail-open SEM reconciliação seria a armadilha.
  BEGIN
    INSERT INTO public.analytics_outbox (evento, distinct_id, user_id, props, chave_dedup, ocorrido_em)
    VALUES (
      v_evento,
      'sistema:reposicao',
      NULL,
      jsonb_build_object(
        'sugestao_id',        NEW.id,
        'status',             NEW.status,
        'condicao_origem',    NEW.condicao_origem,
        'origem_evento_tipo', NEW.origem_evento_tipo,
        -- booleano, não o e-mail: diz SE houve humano, sem dizer QUEM.
        'aprovacao_humana',   (NEW.aprovado_por IS NOT NULL),
        -- rótulo, não o autor: 'cancelado' é o vocabulário dos encerramentos de sistema.
        'origem_cancelamento', CASE NEW.status WHEN 'cancelado_humano' THEN 'humano'
                                               WHEN 'cancelado' THEN 'sistema' END
      ),
      -- ⚠️ a chave inclui o EVENTO, não só o id: um pedido passa por criada →
      -- aprovada → (expirada|cancelada) e cada transição é uma linha. Chavear
      -- só por id engoliria o funil inteiro depois do primeiro evento.
      'pcs:' || NEW.id::text || ':' || v_evento,
      now()
    )
    ON CONFLICT (chave_dedup) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[analytics_outbox] evento % do pedido % perdido (fail-open): % / %',
      v_evento, NEW.id, SQLSTATE, SQLERRM;
  END;

  RETURN NULL;
END;
$function$;

-- POSTCONDIÇÃO --------------------------------------------------------------------------------
DO $post$
DECLARE
  v_pre   oid;
  v_enc   oid;
  v_src   text;
  v_resp  jsonb;
  v_claim boolean;
  v_n     integer;
BEGIN
  SELECT p.oid INTO v_pre FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'iniciar_envio_portal_pre_claim'
     AND pg_get_function_identity_arguments(p.oid) = 'p_pedido_id bigint';
  IF v_pre IS NULL THEN
    RAISE EXCEPTION 'POST FALHOU [PRE-CLAIM-AUSENTE]: iniciar_envio_portal_pre_claim(bigint) nao existe -- todo disparo Sayerlack quebraria';
  END IF;
  IF has_function_privilege('anon', v_pre, 'EXECUTE') OR has_function_privilege('authenticated', v_pre, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU [PRE-CLAIM-ACL]: anon/authenticated executam o pre-claim (era so service_role)';
  END IF;
  v_src := (SELECT prosrc FROM pg_proc WHERE oid = v_pre);
  IF v_src !~ '''erro_nao_retentavel''' THEN
    RAISE EXCEPTION 'POST FALHOU [PRE-CLAIM-GUARD]: o pre-claim nao recusa erro_nao_retentavel -- o #3169 continuaria re-disparavel';
  END IF;
  -- Execução (late-bound): id NULL nunca casa PK; nenhuma linha tocada.
  v_claim := public.iniciar_envio_portal_pre_claim(NULL::bigint);
  IF v_claim IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'POST FALHOU [PRE-CLAIM-EXEC]: sonda id=NULL devolveu %', v_claim;
  END IF;

  SELECT p.oid INTO v_enc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reposicao_encerrar_recusas_definitivas'
     AND pg_get_function_identity_arguments(p.oid) = 'p_dias integer';
  IF v_enc IS NULL THEN
    RAISE EXCEPTION 'POST FALHOU [ENCERRAR-AUSENTE]';
  END IF;
  IF has_function_privilege('anon', v_enc, 'EXECUTE') OR has_function_privilege('authenticated', v_enc, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU [ENCERRAR-ACL]: anon/authenticated executam o encerramento automatico';
  END IF;
  -- Execução sem efeito: com prazo de 36500 dias nenhum pedido real casa.
  v_resp := public.reposicao_encerrar_recusas_definitivas(36500);
  IF (v_resp->>'encerrados')::int IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'POST FALHOU [ENCERRAR-EXEC]: sonda de 100 anos encerrou pedidos: %', v_resp;
  END IF;

  SELECT count(*) INTO v_n FROM cron.job
   WHERE jobname = 'reposicao-encerrar-recusas-definitivas' AND active
     AND schedule = '40 * * * *'
     AND command LIKE '%reposicao_encerrar_recusas_definitivas(3)%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'POST FALHOU [CRON]: job reposicao-encerrar-recusas-definitivas ausente/inativo/divergente (n=%)', v_n;
  END IF;

  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.analytics_outbox_pedido_compra'::regproc)
       !~ 'IN \(''cancelado_humano'', ''cancelado''\)' THEN
    RAISE EXCEPTION 'POST FALHOU [OUTBOX]: o trigger de analytics nao emite cancelamento para status cancelado';
  END IF;

  RAISE NOTICE 'pre-claim recusa terminais do portal; encerramento automatico (3 dias, so prova de nao-efetivado) executou sem efeito; cron horario ativo';
END
$post$;
