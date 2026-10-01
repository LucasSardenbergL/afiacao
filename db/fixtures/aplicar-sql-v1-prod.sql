-- db/fixtures/aplicar-sql-v1-prod.sql — o corpo de public.aplicar_sql ANTES da fila, verbatim.
-- Fixture da prova db/test-pre-anti-deriva-concorrencia.sh: é o "código REAL antigo" do baseline
-- vermelho (a corrida que a fila fecha) e o ponto de partida do delta db/aplicar-executor-serializa.sql.
-- Âncora: md5(prosrc) = ac51b3cea53fa87492e6956ed7a56586 (2033 bytes) — medido na PROD via psql-ro
-- em 2026-09-30, igual ao do bootstrap de então. A prova confere o md5 ao criar; divergiu, a
-- fixture deixou de ser a prod e o baseline não prova nada (exit 3).
CREATE OR REPLACE FUNCTION public.aplicar_sql(
  p_sql  text,
  p_sha  text,
  p_id   bigint
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $funcao$
DECLARE
  v_sha_real   text;
  v_sha_ledger text;
BEGIN
  IF p_sql IS NULL OR length(btrim(p_sql)) = 0 THEN
    RAISE EXCEPTION 'APLICAR_SQL: corpo vazio' USING ERRCODE = '22023';
  END IF;

  -- Integridade ponta-a-ponta: os bytes que vão RODAR são os bytes que foram REGISTRADOS.
  v_sha_real := encode(sha256(convert_to(p_sql, 'UTF8')), 'hex');
  IF v_sha_real IS DISTINCT FROM p_sha THEN
    RAISE EXCEPTION 'APLICAR_SQL: sha divergente (declarado=%, recebido=%)', p_sha, v_sha_real
      USING ERRCODE = '22023';
  END IF;

  -- TRAVA e VALIDA a tentativa ANTES do EXECUTE. Conferir só depois seria tarde: o corpo já
  -- teria rodado. E `WHERE id = p_id` sozinho não bastava — aceitava um id JÁ fechado (o corpo
  -- executava de novo e a mesma linha era reescrita, sem violar unicidade nenhuma) e aceitava
  -- um id de OUTRO hash (recibo apontando para bytes que não são os que rodaram). O FOR UPDATE
  -- serializa quem tentar usar a mesma tentativa em paralelo.
  SELECT sha256 INTO v_sha_ledger
    FROM public.db_aplicacoes
   WHERE id = p_id AND estado = 'tentativa'
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'APLICAR_SQL: tentativa % inexistente ou já fechada — NADA foi executado', p_id
      USING ERRCODE = '22023';
  END IF;

  -- O ensaio grava o hash prefixado (a linha morre no ROLLBACK); fora isso, tem de bater.
  IF v_sha_ledger NOT IN (p_sha, 'ensaio:' || p_sha) THEN
    RAISE EXCEPTION 'APLICAR_SQL: tentativa % é de OUTRO corpo (ledger=%, recebido=%)',
      p_id, v_sha_ledger, p_sha USING ERRCODE = '22023';
  END IF;

  -- O apply. Erro aqui aborta a função inteira, e com ela o recibo abaixo: é o que garante
  -- que "aplicada" nunca sobrevive a uma migration que voltou atrás.
  EXECUTE p_sql;

  UPDATE public.db_aplicacoes
     SET estado = 'aplicada', concluido_em = now()
   WHERE id = p_id AND estado = 'tentativa';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'APLICAR_SQL: recibo % não pôde ser fechado', p_id USING ERRCODE = '22023';
  END IF;

  RETURN 'FIM_APLICACAO_OK';
END
$funcao$;
