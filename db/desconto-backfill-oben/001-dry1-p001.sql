-- ============================================================
-- BACKFILL order_items.desconto_valor · conta oben · TTM 12 meses
-- disparo 1 · etapa dry1 · página 1
-- Passo 1 — dry-run de UMA página: diagnóstico da conciliação, NÃO é aprovação de escrita.
--
-- Efeito: UM net.http_post para `omie-desconto-backfill` com o corpo abaixo.
--   DRY-RUN: a edge concilia e devolve contagens, SEM escrever em order_items.
--   Uma página por invocação (max_paginas 1), timeout 120s.
--
-- A resposta chega DEPOIS do COMMIT (o pg_net só processa a fila após o commit). Ela é lida
-- por psql-ro com LEFT JOIN em net._http_response pelo request_id que este bloco grava em
-- acoes_execucoes NA MESMA TRANSAÇÃO — o `SELECT` de um disparo cru seria descartado pelo
-- EXECUTE de aplicar_sql(), e o request_id se perderia.
--
-- Um arquivo por disparo porque o db:aplicar recusa bytes repetidos: cada invocação é um fato
-- próprio no ledger. Sequência (fechada com o Codex no #2448): dry1 → dry (alvo congelado) →
-- canário → escrita sequencial.
-- ============================================================
DO $disparo$
DECLARE
  c_acao    constant text  := 'desconto_backfill.oben_ttm';
  c_arquivo constant text  := 'db/desconto-backfill-oben/001-dry1-p001.sql';
  c_etapa   constant text  := 'dry1';
  c_corpo   constant jsonb := '{"dry_run": true, "account": "oben", "meses": 12, "pagina": 1, "max_paginas": 1}'::jsonb;
  v_segredo    text;
  v_request_id bigint;
  v_exec       uuid;
  v_json       jsonb;
  r            record;
BEGIN
  -- (1) COLHEITA — copia as respostas já chegadas para acoes_execucoes antes da purga de ~6h
  --     de net._http_response (UNLOGGED). Comparação por TEXTO de propósito: um cast ::bigint
  --     avaliado sobre detalhes de OUTRA ação abortaria o disparo por dado alheio.
  FOR r IN
    SELECT e.id AS exec_id, x.status_code, x.timed_out, x.error_msg, x.content, x.created
      FROM public.acoes_execucoes e
      JOIN net._http_response x ON x.id::text = e.detalhes->>'request_id'
     WHERE e.acao = c_acao AND e.status = 'executando'
  LOOP
    v_json := NULL;
    IF left(ltrim(coalesce(r.content, '')), 1) = '{' THEN
      BEGIN
        v_json := r.content::jsonb;
      EXCEPTION WHEN invalid_text_representation THEN
        v_json := NULL;  -- corpo não-JSON: guarda-se o cru abaixo, sem inventar estrutura
      END;
    END IF;
    UPDATE public.acoes_execucoes
       SET status = CASE WHEN r.status_code = 200 AND v_json IS NOT NULL AND NOT (v_json ? 'error')
                         THEN 'sucesso' ELSE 'erro' END,
           finalizado_em = r.created,
           detalhes = detalhes || jsonb_build_object('colheita', jsonb_build_object(
             'status_code',  r.status_code,
             'timed_out',    r.timed_out,
             'error_msg',    r.error_msg,
             'resposta',     v_json,
             'conteudo_cru', CASE WHEN v_json IS NULL THEN left(r.content, 4000) END,
             'colhido_em',   clock_timestamp()))
     WHERE id = r.exec_id AND status = 'executando';
  END LOOP;

  -- (2) TRAVA DE SEQUÊNCIA — uma invocação por vez, garantida no banco e não na memória de quem
  --     dispara. Linha ainda 'executando' depois da colheita = resposta que não chegou (edge
  --     rodando, ou resposta perdida). Disparar por cima poria duas leituras do Omie no ar ao
  --     mesmo tempo e desfaria a atribuição 1 resposta ↔ 1 página.
  IF EXISTS (SELECT 1 FROM public.acoes_execucoes WHERE acao = c_acao AND status = 'executando') THEN
    RAISE EXCEPTION 'DISPARO RECUSADO: ha invocacao anterior de % sem resposta — resolva antes', c_acao;
  END IF;

  -- (3) DISPARO
  SELECT decrypted_secret INTO v_segredo
    FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1;
  IF v_segredo IS NULL OR length(v_segredo) = 0 THEN
    RAISE EXCEPTION 'DISPARO: CRON_SECRET ausente no vault — nada foi enfileirado';
  END IF;

  v_request_id := net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-desconto-backfill',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_segredo),
    body := c_corpo,
    timeout_milliseconds := 120000);

  -- (4) REGISTRO na MESMA transação: o request_id nunca existe solto.
  INSERT INTO public.acoes_execucoes (acao, origem, executado_por_nome, status, detalhes)
  VALUES (c_acao, 'manual', 'claude_rw · db:aplicar', 'executando',
          jsonb_build_object('request_id', v_request_id, 'etapa', c_etapa,
                             'pagina', c_corpo->'pagina', 'dry_run', c_corpo->'dry_run',
                             'arquivo', c_arquivo, 'corpo', c_corpo))
  RETURNING id INTO v_exec;

  -- (5) POSTCONDIÇÃO — o pedido HTTP está na fila DESTA transação e o registro aponta para ele.
  IF v_request_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM net.http_request_queue q WHERE q.id = v_request_id)
     OR NOT EXISTS (SELECT 1 FROM public.acoes_execucoes e
                     WHERE e.id = v_exec AND e.detalhes->>'request_id' = v_request_id::text) THEN
    RAISE EXCEPTION 'DISPARO: postcondicao falhou (request_id=%) — nada pode ser commitado', v_request_id;
  END IF;
  RAISE NOTICE 'DISPARO_OK request_id=% exec=% etapa=% corpo=%', v_request_id, v_exec, c_etapa, c_corpo;
END
$disparo$;
