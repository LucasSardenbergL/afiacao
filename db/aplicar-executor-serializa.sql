-- db/aplicar-executor-serializa.sql — o db:aplicar passa a ser UM apply por vez.
-- ============================================================================================
-- A corrida (achado do Codex, 2026-09-27; medida em PG17 por db/test-pre-anti-deriva-concorrencia.sh):
-- a PRE anti-deriva de uma migration LÊ o corpo vivo num comando e o CREATE OR REPLACE GRAVA em
-- outro. Em READ COMMITTED, um apply concorrente que commitasse entre os dois era apagado em
-- silêncio, com a PÓS aprovando. `aplicar_sql` não serializava nada: só travava a PRÓPRIA linha
-- do ledger. Este arquivo põe a fila na porta (advisory (20260909,1) + READ COMMITTED exigido).
--
-- O corpo abaixo é BYTE A BYTE o de db/claude-rw-bootstrap.sql (a prova exige o mesmo md5 pelos
-- dois caminhos): re-colar o bootstrap não desfaz a fila, e este arquivo não diverge dele.
--
-- Aplicação: bun run db:aplicar db/aplicar-executor-serializa.sql --ensaio   (ROLLBACK)
--            bun run db:aplicar db/aplicar-executor-serializa.sql
-- O executor se substitui: a chamada que aplica ESTE arquivo ainda roda o corpo antigo (que já
-- está compilado na sessão); a fila vale da próxima chamada em diante. A PÓS chama a porta nova
-- ANTES do commit — corpo novo quebrado (PL/pgSQL é late-bound) aborta tudo e a porta antiga
-- continua de pé, em vez de virar uma porta que nem o próprio conserto consegue atravessar.
-- Sem BEGIN/COMMIT: a transação é do executor.

-- Trava ANTES da pré-condição: o ALTER sem efeito (aplicar_sql já é VOLATILE) prende a linha de
-- pg_proc até o fim desta transação — quem tentar recriar a função agora espera e falha alto.
DO $trava$
BEGIN
  IF to_regprocedure('public.aplicar_sql(text,text,bigint)') IS NOT NULL THEN
    ALTER FUNCTION public.aplicar_sql(text, text, bigint) VOLATILE;
  END IF;
END
$trava$;

-- Pré-condição: o corpo vivo é o PREDECESSOR revisado (o de prod em 2026-09-30, md5 EXATO do
-- prosrc) ou JÁ este (re-aplicar é seguro). Qualquer outro é mudança que este CREATE OR REPLACE
-- apagaria — aborta. Ausente também aborta: este arquivo é DELTA, o nascimento é o bootstrap.
DO $pre$
DECLARE
  v_vivo text;
BEGIN
  SELECT md5(p.prosrc) INTO v_vivo
    FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.aplicar_sql(text,text,bigint)');
  IF v_vivo IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public.aplicar_sql ausente — este arquivo é delta de db/claude-rw-bootstrap.sql';
  END IF;
  IF v_vivo NOT IN ('ac51b3cea53fa87492e6956ed7a56586', '38699b251148bcc4c74faab795d06d38') THEN
    RAISE EXCEPTION 'PRE FALHOU: aplicar_sql vivo (md5 %) não é o predecessor revisado nem este — reconcilie antes', v_vivo;
  END IF;
END
$pre$;

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

  -- UM apply POR VEZ, daqui até o COMMIT (achado do Codex, 2026-09-27). A PRE anti-deriva de uma
  -- migration LÊ o corpo vivo num comando e o CREATE OR REPLACE GRAVA em outro: em READ COMMITTED,
  -- um apply concorrente que commitasse entre os dois era apagado em silêncio, com a PÓS aprovando
  -- (medido em PG17: db/test-pre-anti-deriva-concorrencia.sh). A fila fecha isso para TODO apply que
  -- passa por esta porta, com ou sem PRE, com ou sem trava no arquivo: quem chega depois espera AQUI,
  -- antes de ler qualquer coisa. Não alcança quem não passa por ela (SQL Editor, MCP, builder) —
  -- para esses vale a trava por ALTER sem efeito no próprio arquivo (skill lovable-db-operator).
  --
  -- READ COMMITTED é EXIGIDO, não suposto: a fila só serve se cada comando do corpo tirar snapshot
  -- NOVO depois dela. Em REPEATABLE READ o snapshot nasce no 1º comando da transação, antes desta
  -- espera, e a PRE de quem esperou leria o mundo de antes do primeiro.
  --
  -- Espera até o `lock_timeout` de quem chama (15 s no db-aplicar.sh); estourou, recusa com nome
  -- próprio e o corpo não roda. Chave (int4, int4) = (20260909, 1), o nascimento do db:aplicar:
  -- as outras travas do repo são todas bigint, e as duas formas não colidem.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'APLICAR_SQL: isolamento % — a fila exige READ COMMITTED (ISOLAMENTO_ERRADO); NADA foi executado',
      current_setting('transaction_isolation') USING ERRCODE = '25000';
  END IF;

  IF NOT pg_try_advisory_xact_lock(20260909, 1) THEN
    RAISE NOTICE 'APLICAR_SQL: outro apply em curso — aguardando a vez';
    BEGIN
      PERFORM pg_advisory_xact_lock(20260909, 1);
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'APLICAR_SQL: outro apply segurou a vez além do lock_timeout (VEZ_OCUPADA) — NADA foi executado; rode de novo'
        USING ERRCODE = '55P03';
    END;
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

COMMENT ON FUNCTION public.aplicar_sql(text, text, bigint) IS
  'Porta de escrita automatizada (SECURITY DEFINER = postgres). Um apply por vez (advisory '
  '(20260909,1), exige READ COMMITTED). Confere o sha256 do corpo antes de executar e grava o '
  'recibo na mesma transação. EXECUTE só para claude_rw.';

-- Pós-condição: o corpo é ESTE, a porta continua fechada como antes, e a porta nova EXECUTA.
DO $pos$
DECLARE
  v_oid oid := to_regprocedure('public.aplicar_sql(text,text,bigint)');
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POS FALHOU: aplicar_sql sumiu';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = v_oid)
       IS DISTINCT FROM '38699b251148bcc4c74faab795d06d38' THEN
    RAISE EXCEPTION 'POS FALHOU: o corpo vivo não é este';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) THEN
    RAISE EXCEPTION 'POS FALHOU: perdeu SECURITY DEFINER';
  END IF;
  IF (SELECT p.proconfig FROM pg_catalog.pg_proc p WHERE p.oid = v_oid)
       IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']::text[] THEN
    RAISE EXCEPTION 'POS FALHOU: search_path da porta mudou';
  END IF;
  IF NOT has_function_privilege('claude_rw', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: claude_rw perdeu EXECUTE';
  END IF;
  IF has_function_privilege('public', v_oid, 'EXECUTE') OR has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: a porta abriu para PUBLIC/anon';
  END IF;

  -- A porta NOVA executa (criar não é rodar). Tentativa NULL nunca casa uma linha do ledger: a
  -- chamada percorre o trecho novo inteiro (isolamento + fila) e para na conferência da tentativa,
  -- sem executar corpo nenhum e sem escrever no ledger. Qualquer outro desfecho aborta o arquivo.
  BEGIN
    PERFORM public.aplicar_sql('SELECT 1', encode(sha256(convert_to('SELECT 1', 'UTF8')), 'hex'), NULL);
    RAISE EXCEPTION 'POS FALHOU: a porta nova aceitou tentativa NULL';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM NOT LIKE 'APLICAR_SQL: tentativa % inexistente%' THEN
      RAISE;
    END IF;
  END;
END
$pos$;
