-- ============================================================
-- BACKFILL order_items.desconto_valor · conta oben · TTM 12 meses
-- colheita 2 — SEM disparo: nenhum net.http_post, nenhuma escrita em order_items.
-- Colhe a resposta do disparo 001 (passo 1) antes da pausa para decisão do founder.
--
-- Copia para acoes_execucoes.detalhes.colheita as respostas que já chegaram em
-- net._http_response (UNLOGGED, purga em ~6h). Sem isto, uma pausa longa entre disparos
-- deixaria a linha 'executando' para sempre — e a trava de sequência do próximo disparo
-- recusaria seguir, com razão, sem ter como distinguir "perdida" de "ainda rodando".
-- ============================================================
DO $colheita$
DECLARE
  c_acao constant text := 'desconto_backfill.oben_ttm';
  v_json jsonb;
  v_n    integer := 0;
  r      record;
BEGIN
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
    v_n := v_n + 1;
  END LOOP;

  -- POSTCONDIÇÃO: nenhuma resposta já chegada ficou sem colher.
  IF EXISTS (SELECT 1 FROM public.acoes_execucoes e
               JOIN net._http_response x ON x.id::text = e.detalhes->>'request_id'
              WHERE e.acao = c_acao AND e.status = 'executando') THEN
    RAISE EXCEPTION 'COLHEITA: sobrou resposta chegada sem colher — postcondicao falhou';
  END IF;
  RAISE NOTICE 'COLHEITA_OK colhidas=%', v_n;
END
$colheita$;
