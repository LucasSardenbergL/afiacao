-- ============================================================================================
-- 20261011120000 · picking v2 — reserva exclusiva da coleta + janela pela inclusão (Fase 0.5b)
-- Prova: db/test-picking-v2.sh (PG17, aplica esta migration depois da 20261011020000)
-- Spec: docs/superpowers/specs/2026-10-10-picking-v2-design.md §1.3, §3.6 · Codex 0.5b r1–r3
--
-- O QUE: a coleta da fila (edge `picking-fila-omie`, modo `sincronizar`) passa a escrever só
-- dentro de uma RESERVA exclusiva por conta:
--   1. `picking_coleta_reservar(conta)` — lease fixo de 150 s, intervalo mínimo de 90 s entre
--      inícios; a geração da coleta é o instante do SERVIDOR (não mais o da edge).
--   2. `picking_sincronizar_fila(conta, token, …, p_listagem_suspeita)` — aplica só se o token é o
--      da reserva vigente; ao aplicar, libera a reserva. `p_listagem_suspeita` veta a ausência.
--      Grava `incluido_em` (dInc do Omie) na tarefa: a edge lista a etapa 10 desde a inclusão da
--      tarefa aberta mais antiga (ou hoje − 30), então acompanhada nunca sai da listagem por idade.
--   3. Tarefa AUSENTE do Omie em 2 coletas completas seguidas fica BLOQUEADA em toda RPC que
--      autoriza trabalho (pegar, leitura positiva, retomar, concluir → `ausente_do_omie`) até
--      reaparecer. Sem ConsultarPedido nesta fase (coordenação com o vendas-sync pendente —
--      Codex 0.5b r3), ausência não interrompe nada sozinha: bloqueia, sem mudar o status.
-- Sem a reserva, uma coleta que começou antes podia aplicar uma observação mais velha do Omie
-- por cima de uma mais nova (Codex 0.5b P1-1).
--
-- O QUE NÃO É: não muda o corpo da sync além da reserva, do veto e do incluido_em (o resto é o da
-- 0.3); não confirma saída da etapa (p_confirmados_fora segue no contrato, a edge manda '{}');
-- não escreve no Omie; não liga cron (migration própria, depois da 1ª escrita manual conferida).
--
-- DROP+CREATE da sync (assinatura nova) RESETA o ACL → REVOKE/GRANT reemitidos nomeando as roles.
-- Envelope: sem BEGIN/COMMIT (o db:aplicar embrulha); idempotente; postcondição no fim.
-- ============================================================================================

ALTER TABLE public.picking_coleta_estado ALTER COLUMN aplicada_em DROP NOT NULL;  -- NULL = nunca aplicada
ALTER TABLE public.picking_coleta_estado ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE public.picking_coleta_estado ADD COLUMN IF NOT EXISTS lease_ate   timestamptz;
ALTER TABLE public.picking_tarefas       ADD COLUMN IF NOT EXISTS incluido_em date;  -- dInc do Omie
-- Coletas completas SEGUIDAS sem o pedido. ≥ 2 = bloqueado (uma troca compensada de pedidos entre
-- páginas pode esconder um pedido presente numa coleta — Codex 0.5b r4 P2); presente → 0.
ALTER TABLE public.picking_tarefas       ADD COLUMN IF NOT EXISTS ausente_rodadas integer NOT NULL DEFAULT 0;

-- 'aaaa-mm-dd' → date; formato ou data inválida → NULL (nunca derruba o lote).
CREATE OR REPLACE FUNCTION public.picking_v2_data(p text)
 RETURNS date
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
BEGIN
  IF p IS NULL OR p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
    RETURN NULL;
  END IF;
  RETURN p::date;
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
  RETURN NULL;
END;
$function$;

-- ─── Reserva exclusiva da coleta (só service_role) ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.picking_coleta_reservar(p_account text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_agora timestamptz;
  v_e     public.picking_coleta_estado%ROWTYPE;
  v_token uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF p_account IS NULL OR p_account NOT IN ('oben', 'colacor') THEN
    RAISE EXCEPTION 'picking_coleta_reservar: conta inválida (%)', p_account USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('picking_v2_conta:' || p_account, 0));
  v_agora := clock_timestamp();
  SELECT * INTO v_e FROM public.picking_coleta_estado e WHERE e.account = p_account FOR UPDATE;
  IF NOT FOUND THEN
    -- 1ª reserva da conta: nasce o estado, sob o lock da conta (Codex 0.5b r2 P1-4).
    INSERT INTO public.picking_coleta_estado (account, ultima_coleta_iniciada_em, aplicada_em, lease_token, lease_ate)
    VALUES (p_account, v_agora, NULL, v_token, v_agora + interval '150 seconds');
    RETURN jsonb_build_object('ok', true, 'token', v_token, 'iniciada_em', v_agora);
  END IF;
  IF v_e.lease_ate IS NOT NULL AND v_e.lease_ate > v_agora THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'ocupada', 'lease_ate', v_e.lease_ate);
  END IF;
  IF v_e.ultima_coleta_iniciada_em > v_agora - interval '90 seconds' THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'intervalo_minimo',
                              'ultima_coleta_iniciada_em', v_e.ultima_coleta_iniciada_em);
  END IF;
  -- Lease vencido (coleta abandonada) também é substituído: o token velho perde a escrita.
  UPDATE public.picking_coleta_estado e
     SET lease_token = v_token, lease_ate = v_agora + interval '150 seconds', ultima_coleta_iniciada_em = v_agora
   WHERE e.account = p_account;
  RETURN jsonb_build_object('ok', true, 'token', v_token, 'iniciada_em', v_agora);
END;
$function$;

-- ─── RPC 1 (nova assinatura): picking_sincronizar_fila ───────────────────────────────────────
-- p_presentes = códigos da listagem (COM repetição entre páginas); p_total_de_registros = o total
--   do Omie; p_pedidos = admitidos pelo corte ∪ acompanhados presentes, cada um com
--   `incluido_em` ('aaaa-mm-dd'); p_confirmados_fora = confirmação individual de saída (a edge
--   manda '{}' nesta fase); p_listagem_suspeita = a paginação viu sinal de listagem mutável →
--   sem ausência nesta rodada.
DROP FUNCTION IF EXISTS public.picking_sincronizar_fila(text, timestamptz, bigint[], integer, jsonb, bigint[]);
CREATE OR REPLACE FUNCTION public.picking_sincronizar_fila(
  p_account text,
  p_lease_token uuid,
  p_presentes bigint[],
  p_total_de_registros integer,
  p_pedidos jsonb,
  p_confirmados_fora bigint[],
  p_listagem_suspeita boolean
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_agora        timestamptz;
  v_ultima       timestamptz;
  v_token        uuid;
  v_achou        boolean;
  v_completa     boolean;
  v_ped          jsonb;
  v_cod          bigint;
  v_motivo       text;
  v_versao       text;
  v_hash         text;
  v_t            public.picking_tarefas%ROWTYPE;
  v_mudou        boolean;
  v_novo_status  text;
  v_ausentes     bigint[] := '{}'::bigint[];
  v_fora         bigint[] := coalesce(p_confirmados_fora, '{}'::bigint[]);
  v_criadas      integer := 0;
  v_revisadas    integer := 0;
  v_bloqueadas   integer := 0;
  v_interromp    integer := 0;
  v_saidas       integer := 0;
  v_resumo       jsonb;
BEGIN
  IF p_account IS NULL OR p_account NOT IN ('oben', 'colacor') THEN
    RAISE EXCEPTION 'picking_sincronizar_fila: conta inválida (%)', p_account USING ERRCODE = '22023';
  END IF;
  IF p_lease_token IS NULL OR p_presentes IS NULL OR p_total_de_registros IS NULL
     OR p_confirmados_fora IS NULL OR p_listagem_suspeita IS NULL
     OR p_total_de_registros < 0 OR jsonb_typeof(p_pedidos) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'picking_sincronizar_fila: parâmetros ausentes ou malformados' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_presentes) x WHERE x IS NULL OR x <= 0)
     OR EXISTS (SELECT 1 FROM unnest(v_fora) x WHERE x IS NULL OR x <= 0) THEN
    RAISE EXCEPTION 'picking_sincronizar_fila: código de pedido nulo ou não positivo' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_pedidos) e
              WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
                 OR coalesce(e ->> 'codigo_pedido', '') !~ '^[1-9][0-9]{0,17}$') THEN
    RAISE EXCEPTION 'picking_sincronizar_fila: pedido sem codigo_pedido válido' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_pedidos) e
              GROUP BY (e ->> 'codigo_pedido')::bigint HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'picking_sincronizar_fila: pedido duplicado no lote' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_pedidos) e
              WHERE NOT ((e ->> 'codigo_pedido')::bigint = ANY (p_presentes))) THEN
    RAISE EXCEPTION 'picking_sincronizar_fila: pedido detalhado fora de p_presentes' USING ERRCODE = '22023';
  END IF;

  -- Só a coleta DONA da reserva vigente escreve (Codex 0.5b P1-1): reserva trocada por outra
  -- coleta, ou já consumida por esta (token NULL), = reserva perdida, sem efeito. A geração é a
  -- do lease, atribuída pelo servidor em picking_coleta_reservar.
  PERFORM pg_advisory_xact_lock(hashtextextended('picking_v2_conta:' || p_account, 0));
  v_agora := clock_timestamp();
  SELECT e.ultima_coleta_iniciada_em, e.lease_token INTO v_ultima, v_token
    FROM public.picking_coleta_estado e WHERE e.account = p_account FOR UPDATE;
  v_achou := FOUND;
  IF NOT v_achou OR (v_token = p_lease_token) IS NOT TRUE THEN
    RETURN jsonb_build_object('aplicada', false, 'motivo', 'reserva_perdida');
  END IF;

  -- O corte de data decide só a ADMISSÃO: tarefa acompanhada e presente tem de vir detalhada,
  -- senão uma alteração no Omie nunca chegaria a ela.
  IF EXISTS (SELECT 1 FROM public.picking_tarefas t
              WHERE t.account = p_account AND t.omie_codigo_pedido = ANY (p_presentes)
                AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_pedidos) e
                                 WHERE (e ->> 'codigo_pedido')::bigint = t.omie_codigo_pedido)) THEN
    RAISE EXCEPTION 'picking_sincronizar_fila: tarefa acompanhada presente na listagem sem detalhe' USING ERRCODE = '22023';
  END IF;

  -- Listagem só é fotografia se bate com o total do Omie e não tem duplicata (contrato 2).
  -- `p_listagem_suspeita` VETA a completude (Codex 0.5b P2-7): total mutável entre páginas pode
  -- coincidir na soma e esconder a falta.
  v_completa := cardinality(p_presentes) = p_total_de_registros
                AND (SELECT count(DISTINCT x) FROM unnest(p_presentes) x) = cardinality(p_presentes)
                AND NOT p_listagem_suspeita;

  FOR v_ped IN SELECT e FROM jsonb_array_elements(p_pedidos) e ORDER BY (e ->> 'codigo_pedido')::bigint LOOP
    v_cod    := (v_ped ->> 'codigo_pedido')::bigint;
    v_motivo := public.picking_v2_motivo_invalido(v_ped);
    v_versao := nullif(btrim(concat_ws(' ', v_ped ->> 'd_alt', v_ped ->> 'h_alt')), '');
    v_hash   := NULL;
    IF v_motivo IS NULL THEN
      SELECT md5(string_agg(i.hash_linha, ',' ORDER BY i.codigo_item)) INTO v_hash
        FROM public.picking_v2_itens(v_ped) i;
    END IF;

    SELECT * INTO v_t FROM public.picking_tarefas t
     WHERE t.account = p_account AND t.omie_codigo_pedido = v_cod;

    IF NOT FOUND THEN
      INSERT INTO public.picking_tarefas AS t
             (account, omie_codigo_pedido, numero_pedido, cliente_nome, status, versao_omie,
              hash_fisico, motivo_bloqueio, ultima_coleta_em, incluido_em)
      VALUES (p_account, v_cod, v_ped ->> 'numero_pedido', v_ped ->> 'cliente_nome',
              CASE WHEN v_motivo IS NULL THEN 'aguardando' ELSE 'bloqueado_dado' END,
              v_versao, v_hash, v_motivo, v_agora, public.picking_v2_data(v_ped ->> 'incluido_em'))
      RETURNING * INTO v_t;
      IF v_motivo IS NULL THEN
        INSERT INTO public.picking_linhas
               (account, tarefa_id, codigo_item, omie_codigo_produto, codigo_produto, descricao,
                quantidade, unidade, ean, fracionaria, hash_linha)
        SELECT p_account, v_t.id, i.codigo_item, i.omie_codigo_produto, i.codigo_produto, i.descricao,
               i.quantidade, i.unidade, i.ean, i.fracionaria, i.hash_linha
          FROM public.picking_v2_itens(v_ped) i;
      ELSE
        v_bloqueadas := v_bloqueadas + 1;
      END IF;
      INSERT INTO public.picking_eventos (account, tarefa_id, tipo, para_status, detalhe)
      VALUES (p_account, v_t.id, 'criada', v_t.status, jsonb_build_object('motivo', v_motivo));
      v_criadas := v_criadas + 1;
      CONTINUE;
    END IF;

    -- Estado relido DEPOIS do lock da tarefa.
    PERFORM pg_advisory_xact_lock(hashtextextended('picking_v2_tarefa:' || v_t.id::text, 0));
    SELECT * INTO v_t FROM public.picking_tarefas t WHERE t.id = v_t.id FOR UPDATE;

    UPDATE public.picking_tarefas t
       SET ausente_desde = NULL, fora_da_etapa_em = NULL, ultima_coleta_em = v_agora,
           ausente_rodadas = 0,
           estado_seq = t.estado_seq + CASE WHEN t.ausente_rodadas >= 2 THEN 1 ELSE 0 END,
           numero_pedido = coalesce(v_ped ->> 'numero_pedido', t.numero_pedido),
           cliente_nome  = coalesce(v_ped ->> 'cliente_nome', t.cliente_nome),
           incluido_em   = coalesce(public.picking_v2_data(v_ped ->> 'incluido_em'), t.incluido_em)
     WHERE t.id = v_t.id;

    -- Dado ilegível: a tarefa inteira para (nunca pula linha); leituras em voo param de valer.
    IF v_motivo IS NOT NULL THEN
      IF v_t.status <> 'bloqueado_dado' OR v_t.motivo_bloqueio IS DISTINCT FROM v_motivo THEN
        UPDATE public.picking_tarefas t
           SET status = 'bloqueado_dado', motivo_bloqueio = v_motivo, versao_omie = v_versao,
               separado_em = NULL,
               revisao = t.revisao + CASE WHEN v_t.status <> 'bloqueado_dado' THEN 1 ELSE 0 END,
               estado_seq = t.estado_seq + 1, atualizado_em = v_agora
         WHERE t.id = v_t.id;
        INSERT INTO public.picking_eventos (account, tarefa_id, tipo, de_status, para_status, detalhe)
        VALUES (p_account, v_t.id, 'bloqueada_dado', v_t.status, 'bloqueado_dado',
                jsonb_build_object('motivo', v_motivo));
        v_bloqueadas := v_bloqueadas + 1;
      END IF;
      CONTINUE;
    END IF;

    -- Descrição e código acompanham o Omie sem subir revisão (não decidem o bipe).
    UPDATE public.picking_linhas l
       SET codigo_produto = n.codigo_produto, descricao = n.descricao
      FROM public.picking_v2_itens(v_ped) n
     WHERE l.tarefa_id = v_t.id AND n.codigo_item = l.codigo_item
       AND (l.codigo_produto IS DISTINCT FROM n.codigo_produto OR l.descricao IS DISTINCT FROM n.descricao);

    -- Mudou só preço/imposto (hash igual) numa tarefa saudável: nada a recontar.
    IF v_hash = v_t.hash_fisico AND v_t.status NOT IN ('bloqueado_dado', 'interrompida_externa') THEN
      UPDATE public.picking_tarefas t SET versao_omie = v_versao WHERE t.id = v_t.id
         AND t.versao_omie IS DISTINCT FROM v_versao;
      CONTINUE;
    END IF;

    v_mudou := v_hash IS DISTINCT FROM v_t.hash_fisico;
    IF v_mudou THEN
      UPDATE public.picking_linhas l
         SET ativa = false, revisao = l.revisao + 1, atualizado_em = v_agora
       WHERE l.tarefa_id = v_t.id AND l.ativa
         AND NOT EXISTS (SELECT 1 FROM public.picking_v2_itens(v_ped) n WHERE n.codigo_item = l.codigo_item);

      UPDATE public.picking_linhas l
         SET omie_codigo_produto = n.omie_codigo_produto, quantidade = n.quantidade,
             unidade = n.unidade, ean = n.ean, fracionaria = n.fracionaria, hash_linha = n.hash_linha,
             ativa = true, revisao = l.revisao + 1, atualizado_em = v_agora
        FROM public.picking_v2_itens(v_ped) n
       WHERE l.tarefa_id = v_t.id AND n.codigo_item = l.codigo_item
         AND (NOT l.ativa OR l.hash_linha <> n.hash_linha);

      INSERT INTO public.picking_linhas
             (account, tarefa_id, codigo_item, omie_codigo_produto, codigo_produto, descricao,
              quantidade, unidade, ean, fracionaria, hash_linha)
      SELECT p_account, v_t.id, n.codigo_item, n.omie_codigo_produto, n.codigo_produto, n.descricao,
             n.quantidade, n.unidade, n.ean, n.fracionaria, n.hash_linha
        FROM public.picking_v2_itens(v_ped) n
       WHERE NOT EXISTS (SELECT 1 FROM public.picking_linhas l
                          WHERE l.tarefa_id = v_t.id AND l.codigo_item = n.codigo_item);
    END IF;

    -- Tarefa que JÁ FOI PEGA nunca volta direto à fila: o volume pode ter peças que o banco não
    -- conta (revisão perdida, leitura offline rejeitada) → reconciliação física em picking_retomar.
    v_novo_status := CASE WHEN v_t.pega_em IS NOT NULL THEN 'suspensa_alteracao' ELSE 'aguardando' END;

    UPDATE public.picking_tarefas t
       SET status = v_novo_status, hash_fisico = v_hash, versao_omie = v_versao,
           motivo_bloqueio = NULL, separado_em = NULL,
           revisao = t.revisao + CASE WHEN v_mudou THEN 1 ELSE 0 END,
           estado_seq = t.estado_seq + 1, atualizado_em = v_agora
     WHERE t.id = v_t.id;
    INSERT INTO public.picking_eventos (account, tarefa_id, tipo, de_status, para_status, detalhe)
    VALUES (p_account, v_t.id, CASE WHEN v_mudou THEN 'linha_revisada' ELSE 'recuperada' END,
            v_t.status, v_novo_status, jsonb_build_object('versao_omie', v_versao));
    v_revisadas := v_revisadas + 1;
  END LOOP;

  -- Presente na listagem: limpa as marcas de ausência (inclusive de quem não tem tarefa a revisar).
  UPDATE public.picking_tarefas t
     SET ausente_desde = NULL, fora_da_etapa_em = NULL, ausente_rodadas = 0,
         estado_seq = t.estado_seq + CASE WHEN t.ausente_rodadas >= 2 THEN 1 ELSE 0 END
   WHERE t.account = p_account AND t.omie_codigo_pedido = ANY (p_presentes)
     AND (t.ausente_desde IS NOT NULL OR t.fora_da_etapa_em IS NOT NULL OR t.ausente_rodadas > 0);

  -- Ausência: só com listagem completa (fail-closed) e só vira estado com confirmação individual.
  IF v_completa THEN
    FOR v_t IN SELECT * FROM public.picking_tarefas t
                WHERE t.account = p_account AND t.status <> 'interrompida_externa'
                  AND t.fora_da_etapa_em IS NULL AND NOT (t.omie_codigo_pedido = ANY (p_presentes))
                ORDER BY t.omie_codigo_pedido LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended('picking_v2_tarefa:' || v_t.id::text, 0));
      SELECT * INTO v_t FROM public.picking_tarefas t WHERE t.id = v_t.id FOR UPDATE;
      IF v_t.omie_codigo_pedido = ANY (v_fora) THEN
        IF v_t.status = 'separado' THEN
          -- Fim normal: alguém moveu o pedido separado para a etapa seguinte.
          UPDATE public.picking_tarefas t
             SET fora_da_etapa_em = v_agora, ausente_desde = NULL, estado_seq = t.estado_seq + 1
           WHERE t.id = v_t.id;
          INSERT INTO public.picking_eventos (account, tarefa_id, tipo, de_status, para_status)
          VALUES (p_account, v_t.id, 'saiu_da_etapa', 'separado', 'separado');
          v_saidas := v_saidas + 1;
        ELSE
          UPDATE public.picking_tarefas t
             SET status = 'interrompida_externa', motivo_bloqueio = NULL, ausente_desde = NULL,
                 revisao = t.revisao + 1, estado_seq = t.estado_seq + 1, atualizado_em = v_agora
           WHERE t.id = v_t.id;
          INSERT INTO public.picking_eventos (account, tarefa_id, tipo, de_status, para_status)
          VALUES (p_account, v_t.id, 'interrompida_externa', v_t.status, 'interrompida_externa');
          v_interromp := v_interromp + 1;
        END IF;
      ELSE
        -- 2ª coleta seguida sem o pedido = começa o bloqueio: estado_seq sobe (a tela relê).
        UPDATE public.picking_tarefas t
           SET ausente_desde = coalesce(t.ausente_desde, v_agora), ausente_rodadas = t.ausente_rodadas + 1,
               estado_seq = t.estado_seq + CASE WHEN t.ausente_rodadas + 1 = 2 THEN 1 ELSE 0 END
         WHERE t.id = v_t.id;
        v_ausentes := v_ausentes || v_t.omie_codigo_pedido;
      END IF;
    END LOOP;
  END IF;

  v_resumo := jsonb_build_object(
    'aplicada', true, 'listagem_completa', v_completa, 'listagem_suspeita', p_listagem_suspeita,
    'coleta_iniciada_em', v_ultima, 'criadas', v_criadas,
    'revisadas', v_revisadas, 'bloqueadas', v_bloqueadas, 'interrompidas', v_interromp,
    'saidas_da_etapa', v_saidas, 'ausentes_a_confirmar', to_jsonb(v_ausentes));

  -- Aplicou: libera a reserva (o mesmo token não aplica duas vezes).
  UPDATE public.picking_coleta_estado e
     SET aplicada_em = v_agora, ultimo_resumo = v_resumo, lease_token = NULL, lease_ate = NULL
   WHERE e.account = p_account;

  RETURN v_resumo;
END;
$function$;
-- ─── RPC 2: picking_pegar_task — recusa tarefa ausente do Omie (resto igual ao da 0.3) ──────
CREATE OR REPLACE FUNCTION public.picking_pegar_task(
  p_evento_id uuid,
  p_account text,
  p_tarefa_id uuid,
  p_estado_seq integer,
  p_assumir boolean DEFAULT false,
  p_reconciliacao_fisica boolean DEFAULT false
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_cmd  jsonb;
  v_ev   public.picking_eventos%ROWTYPE;
  v_t    public.picking_tarefas%ROWTYPE;
  v_atr  uuid;
  v_res  jsonb;
  v_para text;
  v_inseriu integer;
BEGIN
  IF NOT (public.has_role(v_uid, 'employee'::public.app_role) OR public.has_role(v_uid, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'picking_pegar_task: só staff' USING ERRCODE = '42501';
  END IF;
  IF p_evento_id IS NULL OR p_tarefa_id IS NULL OR p_account IS NULL OR p_estado_seq IS NULL THEN
    RAISE EXCEPTION 'picking_pegar_task: parâmetros ausentes' USING ERRCODE = '22023';
  END IF;
  v_cmd := jsonb_build_object('op', 'pegar', 'account', p_account, 'tarefa', p_tarefa_id,
                              'estado_seq', p_estado_seq, 'assumir', p_assumir IS TRUE,
                              'reconciliacao', p_reconciliacao_fisica IS TRUE);

  PERFORM pg_advisory_xact_lock(hashtextextended('picking_v2_tarefa:' || p_tarefa_id::text, 0));
  SELECT * INTO v_t FROM public.picking_tarefas t WHERE t.id = p_tarefa_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'picking_pegar_task: tarefa inexistente' USING ERRCODE = 'P0002';
  END IF;
  IF v_t.account <> p_account THEN
    RAISE EXCEPTION 'picking_pegar_task: tarefa de outra conta' USING ERRCODE = '22023';
  END IF;

  -- UUID já processado: devolve o resultado gravado ANTES de olhar o estado (contrato 5).
  SELECT * INTO v_ev FROM public.picking_eventos e WHERE e.id = p_evento_id;
  IF FOUND THEN
    IF v_ev.operador_id IS DISTINCT FROM v_uid OR v_ev.detalhe -> 'comando' IS DISTINCT FROM v_cmd THEN
      RAISE EXCEPTION 'picking_pegar_task: evento % reutilizado em outro comando', p_evento_id USING ERRCODE = '22023';
    END IF;
    RETURN (v_ev.detalhe -> 'resultado') || jsonb_build_object('replay', true);
  END IF;

  IF v_t.estado_seq <> p_estado_seq THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'estado_mudou');
  ELSIF v_t.ausente_rodadas >= 2 THEN
    -- Sumiu da etapa 10 em 2 coletas completas seguidas e ninguém confirmou para onde foi: não
    -- se começa, assume nem reabre a separação (nem o próprio operador) até reaparecer.
    v_res := jsonb_build_object('ok', false, 'motivo', 'ausente_do_omie');
  ELSIF v_t.status = 'aguardando' THEN
    v_atr := gen_random_uuid();
  ELSIF v_t.status = 'em_separacao' AND v_t.operador_id = v_uid THEN
    v_res := jsonb_build_object('ok', true, 'atribuicao_id', v_t.atribuicao_id, 'tarefa_revisao', v_t.revisao,
                                'estado_seq', v_t.estado_seq);
  ELSIF v_t.status = 'em_separacao' AND p_assumir IS NOT TRUE THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'em_separacao_por_outro');
  ELSIF v_t.status = 'em_separacao' AND p_reconciliacao_fisica IS NOT TRUE THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'exige_reconciliacao_fisica');
  ELSIF v_t.status = 'em_separacao' THEN
    v_atr := gen_random_uuid();
  ELSE
    v_res := jsonb_build_object('ok', false, 'motivo', 'status_' || v_t.status);
  END IF;

  IF v_atr IS NOT NULL THEN
    UPDATE public.picking_tarefas t
       SET status = 'em_separacao', operador_id = v_uid, atribuicao_id = v_atr,
           pega_em = clock_timestamp(), estado_seq = t.estado_seq + 1, atualizado_em = clock_timestamp()
     WHERE t.id = v_t.id;
    v_para := 'em_separacao';
    v_res := jsonb_build_object('ok', true, 'atribuicao_id', v_atr, 'tarefa_revisao', v_t.revisao,
                                'estado_seq', v_t.estado_seq + 1);
  END IF;

  INSERT INTO public.picking_eventos (id, account, tarefa_id, tipo, de_status, para_status, operador_id, detalhe)
  VALUES (p_evento_id, v_t.account, v_t.id, 'pegar', v_t.status, v_para, v_uid,
          jsonb_build_object('comando', v_cmd, 'resultado', v_res))
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inseriu = ROW_COUNT;
  IF v_inseriu = 0 THEN
    RAISE EXCEPTION 'evento % gravado por outra transação', p_evento_id USING ERRCODE = '22023';
  END IF;
  RETURN v_res || jsonb_build_object('replay', false);
END;
$function$;

-- ─── RPCs 3, 5 e 6 — recusam tarefa ausente (resto igual ao da 0.3; REPLACE preserva o ACL) ──
CREATE OR REPLACE FUNCTION public.picking_registrar_leitura(
  p_leitura_id uuid,
  p_account text,
  p_tarefa_id uuid,
  p_atribuicao_id uuid,
  p_tarefa_revisao integer,
  p_tipo text,
  p_codigo_lido text DEFAULT NULL,
  p_linha_id uuid DEFAULT NULL,
  p_quantidade numeric DEFAULT NULL,
  p_estorna_leitura_id uuid DEFAULT NULL,
  p_lido_em timestamptz DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_codigo    text := nullif(btrim(p_codigo_lido), '');
  v_cmd       jsonb;
  v_ex        public.picking_leituras%ROWTYPE;
  v_t         public.picking_tarefas%ROWTYPE;
  v_l         public.picking_linhas%ROWTYPE;
  v_orig      public.picking_leituras%ROWTYPE;
  v_motivo    text;
  v_linha     uuid;
  v_linrev    integer;
  v_unid      numeric;
  v_prod      bigint;
  v_fator     numeric;
  v_cb_status text;
  v_cb_unid   text;
  v_tem_cb    boolean;
  v_nprod     integer;
  v_inseriu   integer;
BEGIN
  IF NOT (public.has_role(v_uid, 'employee'::public.app_role) OR public.has_role(v_uid, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'picking_registrar_leitura: só staff' USING ERRCODE = '42501';
  END IF;
  IF p_leitura_id IS NULL OR p_tarefa_id IS NULL OR p_account IS NULL OR p_tarefa_revisao IS NULL
     OR p_atribuicao_id IS NULL OR p_tipo IS NULL OR p_tipo NOT IN ('bipe', 'manual', 'estorno') THEN
    RAISE EXCEPTION 'picking_registrar_leitura: parâmetros ausentes ou tipo inválido' USING ERRCODE = '22023';
  END IF;
  -- Domínio positivo e FINITO (NaN > Infinity no Postgres, então `< 'Infinity'` também barra NaN).
  IF (p_tipo = 'bipe' AND (v_codigo IS NULL OR length(v_codigo) > 64 OR p_linha_id IS NOT NULL
                           OR p_quantidade IS NOT NULL OR p_estorna_leitura_id IS NOT NULL))
     OR (p_tipo = 'manual' AND (p_linha_id IS NULL OR p_quantidade IS NULL
                                OR NOT (p_quantidade > 0 AND p_quantidade < 'Infinity')
                                OR v_codigo IS NOT NULL OR p_estorna_leitura_id IS NOT NULL))
     OR (p_tipo = 'estorno' AND (p_estorna_leitura_id IS NULL OR p_quantidade IS NOT NULL
                                 OR v_codigo IS NOT NULL OR p_linha_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'picking_registrar_leitura: parâmetros incompatíveis com o tipo %', p_tipo USING ERRCODE = '22023';
  END IF;
  v_cmd := jsonb_build_object('account', p_account, 'tarefa', p_tarefa_id, 'atribuicao', p_atribuicao_id,
                              'tarefa_revisao', p_tarefa_revisao, 'tipo', p_tipo, 'codigo', v_codigo,
                              'linha', p_linha_id, 'quantidade', p_quantidade, 'estorno', p_estorna_leitura_id);

  PERFORM pg_advisory_xact_lock(hashtextextended('picking_v2_tarefa:' || p_tarefa_id::text, 0));
  SELECT * INTO v_t FROM public.picking_tarefas t WHERE t.id = p_tarefa_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'picking_registrar_leitura: tarefa inexistente' USING ERRCODE = 'P0002';
  END IF;
  IF v_t.account <> p_account THEN
    RAISE EXCEPTION 'picking_registrar_leitura: tarefa de outra conta' USING ERRCODE = '22023';
  END IF;

  -- UUID já processado: resolvido ANTES do estado atual (contrato 5), e só para o MESMO comando.
  SELECT * INTO v_ex FROM public.picking_leituras r WHERE r.id = p_leitura_id;
  IF FOUND THEN
    IF v_ex.operador_id <> v_uid OR v_ex.comando IS DISTINCT FROM v_cmd THEN
      RAISE EXCEPTION 'picking_registrar_leitura: leitura % reutilizada em outro comando', p_leitura_id USING ERRCODE = '22023';
    END IF;
    RETURN jsonb_build_object('ok', v_ex.aceita, 'motivo', v_ex.motivo_rejeicao, 'linha_id', v_ex.linha_id,
                              'unidades', v_ex.unidades, 'replay', true);
  END IF;

  IF v_t.status <> 'em_separacao' THEN
    v_motivo := 'tarefa_fora_de_separacao';
  ELSIF v_t.atribuicao_id IS DISTINCT FROM p_atribuicao_id OR v_t.operador_id IS DISTINCT FROM v_uid THEN
    v_motivo := 'atribuicao_antiga';
  ELSIF v_t.revisao <> p_tarefa_revisao THEN
    v_motivo := 'revisao_antiga';
  ELSIF v_t.ausente_rodadas >= 2 AND p_tipo <> 'estorno' THEN
    -- Sumiu da etapa 10 em 2 coletas completas seguidas: nada entra no volume até reaparecer
    -- (estorno, que tira, segue permitido). Codex 0.5b r4 P1.
    v_motivo := 'ausente_do_omie';
  END IF;

  IF v_motivo IS NULL AND p_tipo = 'bipe' THEN
    SELECT c.omie_codigo_produto, c.unidades_por_leitura, c.status, c.unidade
      INTO v_prod, v_fator, v_cb_status, v_cb_unid
      FROM public.picking_codigos_barras c
     WHERE c.account = v_t.account AND c.codigo = v_codigo AND c.status <> 'revogado';
    v_tem_cb := FOUND;
    -- Interpretações distintas do EAN = pares (produto, unidade): o mesmo EAN numa linha UN e
    -- noutra CX do mesmo produto faria 1 peça avulsa valer 1 caixa.
    SELECT count(DISTINCT (l.omie_codigo_produto, l.unidade)) INTO v_nprod
      FROM public.picking_linhas l
     WHERE l.tarefa_id = v_t.id AND l.ativa AND l.ean = v_codigo;

    IF v_tem_cb AND v_cb_status <> 'aprovado' THEN
      v_motivo := 'codigo_pendente_aprovacao';
    ELSIF v_tem_cb AND EXISTS (SELECT 1 FROM public.picking_linhas l
                                WHERE l.tarefa_id = v_t.id AND l.ativa AND l.ean = v_codigo
                                  AND (l.omie_codigo_produto <> v_prod OR l.unidade <> v_cb_unid
                                       OR v_fator <> 1)) THEN
      -- O mesmo código lido como EAN da linha (1 unidade) e como cadastro (outro produto,
      -- unidade ou fator): duas interpretações físicas — não se escolhe uma no escuro.
      v_motivo := 'codigo_ambiguo';
    ELSIF NOT v_tem_cb AND v_nprod = 0 THEN
      v_motivo := 'codigo_desconhecido';
    ELSIF NOT v_tem_cb AND v_nprod > 1 THEN
      v_motivo := 'codigo_ambiguo';
    ELSIF v_tem_cb AND NOT EXISTS (SELECT 1 FROM public.picking_linhas l
                                    WHERE l.tarefa_id = v_t.id AND l.ativa AND l.omie_codigo_produto = v_prod) THEN
      v_motivo := 'codigo_fora_do_pedido';
    ELSIF v_tem_cb AND NOT EXISTS (SELECT 1 FROM public.picking_linhas l
                                    WHERE l.tarefa_id = v_t.id AND l.ativa AND l.omie_codigo_produto = v_prod
                                      AND l.unidade = v_cb_unid) THEN
      v_motivo := 'unidade_incompativel';
    END IF;

    IF v_motivo IS NULL THEN
      IF NOT v_tem_cb THEN v_fator := 1; END IF;  -- EAN do próprio item: 1 leitura = 1 unidade da linha
      -- Candidatas: código cadastrado → linhas do produto NA UNIDADE do código; EAN → linhas com esse EAN.
      IF NOT EXISTS (SELECT 1 FROM public.picking_linhas l
                      WHERE l.tarefa_id = v_t.id AND l.ativa AND NOT l.fracionaria
                        AND CASE WHEN v_tem_cb THEN l.omie_codigo_produto = v_prod AND l.unidade = v_cb_unid
                                 ELSE l.ean = v_codigo END) THEN
        v_motivo := 'linha_fracionaria_exige_manual';
      ELSE
        SELECT * INTO v_l FROM public.picking_linhas l
         WHERE l.tarefa_id = v_t.id AND l.ativa AND NOT l.fracionaria
           AND CASE WHEN v_tem_cb THEN l.omie_codigo_produto = v_prod AND l.unidade = v_cb_unid
                    ELSE l.ean = v_codigo END
           AND l.quantidade - public.picking_v2_separada(l.id, l.revisao) > 0
         ORDER BY l.codigo_item LIMIT 1;
        IF NOT FOUND THEN
          v_motivo := 'excesso';
        ELSE
          v_linha := v_l.id; v_linrev := v_l.revisao; v_unid := v_fator;
          IF v_fator > v_l.quantidade - public.picking_v2_separada(v_l.id, v_l.revisao) THEN
            v_motivo := 'excesso';
          END IF;
        END IF;
      END IF;
    END IF;

  ELSIF v_motivo IS NULL AND p_tipo = 'manual' THEN
    SELECT * INTO v_l FROM public.picking_linhas l WHERE l.id = p_linha_id AND l.tarefa_id = v_t.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'picking_registrar_leitura: linha não pertence à tarefa' USING ERRCODE = '22023';
    END IF;
    v_linha := v_l.id; v_linrev := v_l.revisao; v_unid := p_quantidade;
    IF NOT v_l.ativa THEN
      v_motivo := 'linha_inativa';
    ELSIF NOT v_l.fracionaria AND (v_l.ean IS NOT NULL OR EXISTS (
            SELECT 1 FROM public.picking_codigos_barras c
             WHERE c.account = v_t.account AND c.omie_codigo_produto = v_l.omie_codigo_produto
               AND c.unidade = v_l.unidade AND c.status = 'aprovado')) THEN
      v_motivo := 'manual_nao_permitido';
    ELSIF NOT v_l.fracionaria AND p_quantidade <> trunc(p_quantidade) THEN
      v_motivo := 'quantidade_nao_inteira';
    ELSIF p_quantidade > v_l.quantidade - public.picking_v2_separada(v_l.id, v_l.revisao) THEN
      v_motivo := 'excesso';
    END IF;

  ELSIF v_motivo IS NULL AND p_tipo = 'estorno' THEN
    SELECT * INTO v_orig FROM public.picking_leituras r WHERE r.id = p_estorna_leitura_id;
    IF NOT FOUND THEN
      -- Dependência ainda não recebida (offline fora de ordem): NÃO grava; o aparelho reenvia.
      RETURN jsonb_build_object('ok', false, 'motivo', 'original_nao_recebido', 'pendente', true, 'replay', false);
    END IF;
    IF v_orig.tarefa_id <> v_t.id OR NOT v_orig.aceita OR v_orig.tipo = 'estorno' THEN
      v_motivo := 'estorno_invalido';
    ELSE
      SELECT * INTO v_l FROM public.picking_linhas l WHERE l.id = v_orig.linha_id;
      v_linha := v_l.id; v_linrev := v_orig.linha_revisao; v_unid := -v_orig.unidades;
      IF NOT v_l.ativa OR v_l.revisao <> v_orig.linha_revisao THEN
        v_motivo := 'estorno_revisao_antiga';
      ELSIF EXISTS (SELECT 1 FROM public.picking_leituras r
                     WHERE r.estorna_leitura_id = v_orig.id AND r.aceita) THEN
        v_motivo := 'ja_estornada';
      END IF;
    END IF;
  END IF;

  -- UUID concorrente em OUTRA tarefa (lock diferente): o ON CONFLICT espera a outra transação.
  INSERT INTO public.picking_leituras
         (id, account, tarefa_id, linha_id, linha_revisao, tarefa_revisao, tipo, codigo_lido, unidades,
          estorna_leitura_id, operador_id, atribuicao_id, comando, lido_em, recebido_em, aceita, motivo_rejeicao)
  VALUES (p_leitura_id, v_t.account, v_t.id, v_linha, v_linrev, p_tarefa_revisao, p_tipo, v_codigo, v_unid,
          v_orig.id, v_uid, p_atribuicao_id, v_cmd, p_lido_em, clock_timestamp(), v_motivo IS NULL, v_motivo)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inseriu = ROW_COUNT;
  IF v_inseriu = 0 THEN
    RAISE EXCEPTION 'picking_registrar_leitura: leitura % gravada por outra transação', p_leitura_id USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object('ok', v_motivo IS NULL, 'motivo', v_motivo, 'linha_id', v_linha,
                            'unidades', v_unid, 'replay', false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.picking_retomar(
  p_evento_id uuid,
  p_account text,
  p_tarefa_id uuid,
  p_estado_seq integer,
  p_reconciliacao_fisica boolean DEFAULT false
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_cmd  jsonb;
  v_ev   public.picking_eventos%ROWTYPE;
  v_t    public.picking_tarefas%ROWTYPE;
  v_atr  uuid;
  v_res  jsonb;
  v_para text;
  v_inseriu integer;
BEGIN
  IF NOT (public.has_role(v_uid, 'employee'::public.app_role) OR public.has_role(v_uid, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'picking_retomar: só staff' USING ERRCODE = '42501';
  END IF;
  IF p_evento_id IS NULL OR p_tarefa_id IS NULL OR p_account IS NULL OR p_estado_seq IS NULL THEN
    RAISE EXCEPTION 'picking_retomar: parâmetros ausentes' USING ERRCODE = '22023';
  END IF;
  v_cmd := jsonb_build_object('op', 'retomar', 'account', p_account, 'tarefa', p_tarefa_id,
                              'estado_seq', p_estado_seq, 'reconciliacao', p_reconciliacao_fisica IS TRUE);

  PERFORM pg_advisory_xact_lock(hashtextextended('picking_v2_tarefa:' || p_tarefa_id::text, 0));
  SELECT * INTO v_t FROM public.picking_tarefas t WHERE t.id = p_tarefa_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'picking_retomar: tarefa inexistente' USING ERRCODE = 'P0002';
  END IF;
  IF v_t.account <> p_account THEN
    RAISE EXCEPTION 'picking_retomar: tarefa de outra conta' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ev FROM public.picking_eventos e WHERE e.id = p_evento_id;
  IF FOUND THEN
    IF v_ev.operador_id IS DISTINCT FROM v_uid OR v_ev.detalhe -> 'comando' IS DISTINCT FROM v_cmd THEN
      RAISE EXCEPTION 'picking_retomar: evento % reutilizado em outro comando', p_evento_id USING ERRCODE = '22023';
    END IF;
    RETURN (v_ev.detalhe -> 'resultado') || jsonb_build_object('replay', true);
  END IF;

  IF v_t.estado_seq <> p_estado_seq THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'estado_mudou');
  ELSIF v_t.ausente_rodadas >= 2 THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'ausente_do_omie');
  ELSIF v_t.status NOT IN ('suspensa_alteracao', 'separado', 'aguardando_ajuste') THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'status_' || v_t.status);
  ELSIF v_t.fora_da_etapa_em IS NOT NULL THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'fora_da_etapa');
  ELSIF p_reconciliacao_fisica IS NOT TRUE THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'exige_reconciliacao_fisica');
  ELSE
    v_atr := gen_random_uuid();
    UPDATE public.picking_tarefas t
       SET status = 'em_separacao', operador_id = v_uid, atribuicao_id = v_atr, separado_em = NULL,
           pega_em = clock_timestamp(), estado_seq = t.estado_seq + 1, atualizado_em = clock_timestamp()
     WHERE t.id = v_t.id;
    v_para := 'em_separacao';
    v_res := jsonb_build_object('ok', true, 'atribuicao_id', v_atr, 'tarefa_revisao', v_t.revisao,
                                'estado_seq', v_t.estado_seq + 1);
  END IF;

  INSERT INTO public.picking_eventos (id, account, tarefa_id, tipo, de_status, para_status, operador_id, detalhe)
  VALUES (p_evento_id, v_t.account, v_t.id, 'retomar', v_t.status, v_para, v_uid,
          jsonb_build_object('comando', v_cmd, 'resultado', v_res))
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inseriu = ROW_COUNT;
  IF v_inseriu = 0 THEN
    RAISE EXCEPTION 'evento % gravado por outra transação', p_evento_id USING ERRCODE = '22023';
  END IF;
  RETURN v_res || jsonb_build_object('replay', false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.picking_concluir(
  p_evento_id uuid,
  p_account text,
  p_tarefa_id uuid,
  p_atribuicao_id uuid,
  p_tarefa_revisao integer,
  p_leituras uuid[]
)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_cmd  jsonb;
  v_ev   public.picking_eventos%ROWTYPE;
  v_t    public.picking_tarefas%ROWTYPE;
  v_res  jsonb;
  v_para text;
  v_faltam integer;
  v_inseriu integer;
BEGIN
  IF NOT (public.has_role(v_uid, 'employee'::public.app_role) OR public.has_role(v_uid, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'picking_concluir: só staff' USING ERRCODE = '42501';
  END IF;
  IF p_evento_id IS NULL OR p_tarefa_id IS NULL OR p_account IS NULL OR p_atribuicao_id IS NULL
     OR p_tarefa_revisao IS NULL OR p_leituras IS NULL OR array_position(p_leituras, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'picking_concluir: parâmetros ausentes' USING ERRCODE = '22023';
  END IF;
  v_cmd := jsonb_build_object('op', 'concluir', 'account', p_account, 'tarefa', p_tarefa_id,
                              'atribuicao', p_atribuicao_id, 'tarefa_revisao', p_tarefa_revisao,
                              'leituras', (SELECT to_jsonb(array_agg(DISTINCT x ORDER BY x)) FROM unnest(p_leituras) x));

  PERFORM pg_advisory_xact_lock(hashtextextended('picking_v2_tarefa:' || p_tarefa_id::text, 0));
  SELECT * INTO v_t FROM public.picking_tarefas t WHERE t.id = p_tarefa_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'picking_concluir: tarefa inexistente' USING ERRCODE = 'P0002';
  END IF;
  IF v_t.account <> p_account THEN
    RAISE EXCEPTION 'picking_concluir: tarefa de outra conta' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_ev FROM public.picking_eventos e WHERE e.id = p_evento_id;
  IF FOUND THEN
    IF v_ev.operador_id IS DISTINCT FROM v_uid OR v_ev.detalhe -> 'comando' IS DISTINCT FROM v_cmd THEN
      RAISE EXCEPTION 'picking_concluir: evento % reutilizado em outro comando', p_evento_id USING ERRCODE = '22023';
    END IF;
    RETURN (v_ev.detalhe -> 'resultado') || jsonb_build_object('replay', true);
  END IF;

  SELECT count(*) INTO v_faltam FROM unnest(p_leituras) x
   WHERE NOT EXISTS (SELECT 1 FROM public.picking_leituras r
                      WHERE r.id = x AND r.tarefa_id = v_t.id AND r.atribuicao_id = p_atribuicao_id);

  IF v_t.status <> 'em_separacao' THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'tarefa_fora_de_separacao');
  ELSIF v_t.ausente_rodadas >= 2 THEN
    -- Separado só vale para pedido que ainda está na etapa 10 (Codex 0.5b r4 P1).
    v_res := jsonb_build_object('ok', false, 'motivo', 'ausente_do_omie');
  ELSIF v_t.atribuicao_id IS DISTINCT FROM p_atribuicao_id OR v_t.operador_id IS DISTINCT FROM v_uid THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'atribuicao_antiga');
  ELSIF v_t.revisao <> p_tarefa_revisao THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'revisao_antiga');
  ELSIF v_faltam > 0 THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'leituras_pendentes', 'faltam', v_faltam);
  ELSIF NOT EXISTS (SELECT 1 FROM public.picking_linhas l WHERE l.tarefa_id = v_t.id AND l.ativa) THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'sem_linhas');
  ELSIF EXISTS (SELECT 1 FROM public.picking_linhas l
                 WHERE l.tarefa_id = v_t.id AND l.ativa
                   AND public.picking_v2_separada(l.id, l.revisao) <> l.quantidade) THEN
    v_res := jsonb_build_object('ok', false, 'motivo', 'linhas_incompletas');
  ELSE
    UPDATE public.picking_tarefas t
       SET status = 'separado', separado_em = clock_timestamp(), estado_seq = t.estado_seq + 1,
           atualizado_em = clock_timestamp()
     WHERE t.id = v_t.id;
    v_para := 'separado';
    v_res := jsonb_build_object('ok', true, 'estado_seq', v_t.estado_seq + 1);
  END IF;

  INSERT INTO public.picking_eventos (id, account, tarefa_id, tipo, de_status, para_status, operador_id, detalhe)
  VALUES (p_evento_id, v_t.account, v_t.id, 'concluir', v_t.status, v_para, v_uid,
          jsonb_build_object('comando', v_cmd, 'resultado', v_res))
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inseriu = ROW_COUNT;
  IF v_inseriu = 0 THEN
    RAISE EXCEPTION 'evento % gravado por outra transação', p_evento_id USING ERRCODE = '22023';
  END IF;
  RETURN v_res || jsonb_build_object('replay', false);
END;
$function$;

REVOKE ALL ON FUNCTION public.picking_v2_data(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.picking_coleta_reservar(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.picking_coleta_reservar(text) TO service_role;
REVOKE ALL ON FUNCTION public.picking_sincronizar_fila(text, uuid, bigint[], integer, jsonb, bigint[], boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.picking_sincronizar_fila(text, uuid, bigint[], integer, jsonb, bigint[], boolean)
  TO service_role;

-- ─── Postcondição ────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_fn text;
BEGIN
  IF to_regprocedure('public.picking_sincronizar_fila(text, timestamptz, bigint[], integer, jsonb, bigint[])') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDICAO: assinatura antiga da sync ainda existe';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY[
    'public.picking_coleta_reservar(text)',
    'public.picking_sincronizar_fila(text, uuid, bigint[], integer, jsonb, bigint[], boolean)'
  ] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN
      RAISE EXCEPTION 'POSTCONDICAO: % não existe', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICAO: % executável por anon/authenticated', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICAO: % sem EXECUTE para service_role', v_fn;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public'
         AND ((table_name = 'picking_coleta_estado' AND column_name IN ('lease_token', 'lease_ate'))
           OR (table_name = 'picking_tarefas' AND column_name IN ('incluido_em', 'ausente_rodadas')))) <> 4 THEN
    RAISE EXCEPTION 'POSTCONDICAO: colunas novas ausentes';
  END IF;
  IF (SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'picking_coleta_estado' AND column_name = 'aplicada_em') <> 'YES' THEN
    RAISE EXCEPTION 'POSTCONDICAO: aplicada_em ainda NOT NULL';
  END IF;
  IF has_function_privilege('anon', 'public.picking_v2_data(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.picking_v2_data(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO: picking_v2_data executável por anon/authenticated';
  END IF;
  -- CREATE OR REPLACE preserva o ACL das RPCs do aparelho (authenticated executa; anon não).
  FOREACH v_fn IN ARRAY ARRAY[
    'public.picking_pegar_task(uuid, text, uuid, integer, boolean, boolean)',
    'public.picking_registrar_leitura(uuid, text, uuid, uuid, integer, text, text, uuid, numeric, uuid, timestamptz)',
    'public.picking_retomar(uuid, text, uuid, integer, boolean)',
    'public.picking_concluir(uuid, text, uuid, uuid, integer, uuid[])'
  ] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POSTCONDICAO: ACL de % mudou', v_fn;
    END IF;
  END LOOP;
  -- Nenhuma tarefa aberta sem incluido_em (a janela da listagem depende dela): em prod, 0 tarefas.
  IF EXISTS (SELECT 1 FROM public.picking_tarefas t
              WHERE t.incluido_em IS NULL AND t.status <> 'interrompida_externa' AND t.fora_da_etapa_em IS NULL) THEN
    RAISE EXCEPTION 'POSTCONDICAO: tarefa aberta sem incluido_em — exige backfill antes';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_table_privilege(v_fn, 'public.picking_coleta_estado', 'UPDATE')
       OR has_table_privilege(v_fn, 'public.picking_tarefas', 'UPDATE') THEN
      RAISE EXCEPTION 'POSTCONDICAO: tabelas da fila graváveis direto por %', v_fn;
    END IF;
  END LOOP;
END
$post$;
