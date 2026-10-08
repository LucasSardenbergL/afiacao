-- db/aplicar-porta-recheck.sql — a porta re-confere o recibo DEPOIS da fila: os mesmos bytes não
-- executam duas vezes, nem com dois `db:aplicar` simultâneos.
-- ============================================================================================
-- O defeito (medido em PG17 por db/test-db-aplicar.sh, A15/S14): a fila (20260909, 1) põe dois
-- applies dos MESMOS bytes em ORDEM, e ordem não é impedimento. O executor lê o ledger e grava a
-- tentativa FORA da transação, então os dois passam pela etapa 3 antes de existir recibo; o 2º pegava
-- a vez com uma tentativa válida e executava o corpo DE NOVO. O índice único do recibo o revertia
-- depois — o dado se salvava, a execução não: sequência/IDENTITY consumidas, carga e locks em dobro, e
-- um `duplicate key` no lugar de uma recusa. Este arquivo põe o re-check entre a fila e o EXECUTE.
--
-- O corpo abaixo é BYTE A BYTE o de db/claude-rw-bootstrap.sql (A16 confere o md5 pelos dois
-- caminhos): re-colar o bootstrap não desfaz o re-check, e este arquivo não diverge dele.
--
-- Aplicação: bun run db:aplicar db/aplicar-porta-recheck.sql --ensaio   (ROLLBACK)
--            bun run db:aplicar db/aplicar-porta-recheck.sql
-- Sem BEGIN/COMMIT: a transação é do executor. No SQL Editor/MCP, envolva em `BEGIN; … COMMIT;`.
-- O executor se substitui: a chamada que aplica ESTE arquivo ainda roda o corpo antigo (compilado na
-- sessão); o re-check vale da próxima chamada em diante.
--
-- A PÓS percorre a porta nova pelo caminho REAL, e não só pelo do ensaio como o delta da fila: o
-- re-check é justamente o trecho que o ensaio PULA, e uma sonda só de ensaio deixaria passar um
-- re-check quebrado (PL/pgSQL é late-bound) — que só explodiria no primeiro apply de verdade, numa
-- porta que nem o próprio conserto atravessa. A19 prova que a PÓS barra isso; A19b, que é a parte
-- REAL da sonda que barra (sem ela, o mesmo re-check quebrado aplica).

-- Trava ANTES da pré-condição: o ALTER sem efeito (aplicar_sql já é VOLATILE) prende a linha de
-- pg_proc até o fim desta transação — quem tentar recriar a função agora espera e falha alto.
DO $trava$
BEGIN
  IF to_regprocedure('public.aplicar_sql(text,text,bigint)') IS NOT NULL THEN
    ALTER FUNCTION public.aplicar_sql(text, text, bigint) VOLATILE;
  END IF;
END
$trava$;

-- Pré-condição: o corpo vivo é o PREDECESSOR revisado (a porta com a fila — md5 de prod conferido por
-- psql-ro em 2026-10-08) ou JÁ este (re-aplicar é seguro). Qualquer outro é mudança que este CREATE OR
-- REPLACE apagaria — aborta. Ausente também aborta: este arquivo é DELTA, o nascimento é o bootstrap.
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
  IF v_vivo NOT IN ('38699b251148bcc4c74faab795d06d38', 'd043e0b3f82d255493e87635972c7b06') THEN
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
  v_recibo     bigint;
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

  -- O RE-CHECK, depois da fila: estes bytes já têm recibo? A fila põe dois applies dos MESMOS bytes
  -- em ORDEM, e ordem não é impedimento. O executor lê o ledger e grava a tentativa FORA desta
  -- transação, então os dois passam pela etapa 3 dele antes de qualquer recibo existir; o 2º, quando
  -- pegava a vez, chegava aqui com uma tentativa válida e executava o corpo DE NOVO. O índice único
  -- do recibo o revertia, depois: o dado se salvava, a execução não — sequência e IDENTITY
  -- consumidas, e a carga e os locks de rodar a migration duas vezes (medido em PG17:
  -- db/test-db-aplicar.sh, A15; sem este bloco, S14).
  --
  -- Só vale DEPOIS da fila: antes dela a leitura seria a de um 1º que ainda não commitou — ausência
  -- de recibo lida como "inédito" (S15). E só vale porque a fila exige READ COMMITTED: cada comando
  -- tira snapshot NOVO, e este enxerga o commit de quem segurava a vez.
  --
  -- Só para o apply REAL. No `--ensaio` o ledger guarda 'ensaio:'||sha e a transação inteira morre
  -- no ROLLBACK: bloqueá-lo por "já aplicado" não protege ninguém e empurra quem quer conferir para o
  -- caminho que ESCREVE — o inverso do que o `--ensaio` existe para fazer.
  IF v_sha_ledger = p_sha THEN
    SELECT id INTO v_recibo
      FROM public.db_aplicacoes
     WHERE sha256 = p_sha AND estado = 'aplicada';
    IF FOUND THEN
      RAISE EXCEPTION 'APLICAR_SQL: estes bytes já foram aplicados — recibo % (RECUSA_SHA_JA_APLICADO); NADA foi executado',
        v_recibo USING ERRCODE = '22023';
    END IF;
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
  '(20260909,1), exige READ COMMITTED). Confere o sha256 do corpo antes de executar, re-confere o '
  'recibo depois da fila (os mesmos bytes não rodam duas vezes, nem em paralelo) e grava o recibo '
  'na mesma transação. EXECUTE só para claude_rw.';

-- Pós-condição: o corpo é ESTE, a porta continua fechada como antes, e a porta nova EXECUTA — pelos
-- DOIS caminhos. Tudo dentro de um bloco que termina num RAISE de SQLSTATE próprio: tentativas e
-- recibos da sonda morrem com ele, e nada fica no ledger. Qualquer outro desfecho aborta este arquivo,
-- e a porta antiga continua de pé. Só o ramo de ESPERA da fila não roda aqui (exige outro apply em
-- curso: é o A15 da prova).
DO $pos$
DECLARE
  v_oid oid  := to_regprocedure('public.aplicar_sql(text,text,bigint)');
  v_sql text := 'SELECT 1 /* sonda da PÓS de db/aplicar-porta-recheck.sql */';
  v_sha text := encode(sha256(convert_to(v_sql, 'UTF8')), 'hex');
  v_id  bigint;
  v_ret text;
  v_msg text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POS FALHOU: aplicar_sql sumiu';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = v_oid)
       IS DISTINCT FROM 'd043e0b3f82d255493e87635972c7b06' THEN
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
  IF has_function_privilege('public', v_oid, 'EXECUTE') OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: a porta abriu para PUBLIC/anon/authenticated';
  END IF;

  BEGIN
    -- (1) o caminho do ENSAIO, do começo ao recibo (ele pula o re-check, por desenho)
    INSERT INTO public.db_aplicacoes (arquivo, sha256, estado)
    VALUES ('db/aplicar-porta-recheck.sql#sonda-ensaio', 'ensaio:' || v_sha, 'tentativa')
    RETURNING id INTO v_id;
    v_ret := public.aplicar_sql(v_sql, v_sha, v_id);
    IF v_ret IS DISTINCT FROM 'FIM_APLICACAO_OK' THEN
      RAISE EXCEPTION 'POS FALHOU: no caminho do ensaio a porta nova devolveu %', v_ret;
    END IF;

    -- (2) o caminho REAL sem recibo: atravessa o re-check e aplica
    INSERT INTO public.db_aplicacoes (arquivo, sha256, estado)
    VALUES ('db/aplicar-porta-recheck.sql#sonda', v_sha, 'tentativa')
    RETURNING id INTO v_id;
    v_ret := public.aplicar_sql(v_sql, v_sha, v_id);
    IF v_ret IS DISTINCT FROM 'FIM_APLICACAO_OK' THEN
      RAISE EXCEPTION 'POS FALHOU: no caminho real a porta nova devolveu %', v_ret;
    END IF;

    -- (3) os MESMOS bytes de novo, agora com recibo: o re-check RECUSA, sem executar
    INSERT INTO public.db_aplicacoes (arquivo, sha256, estado)
    VALUES ('db/aplicar-porta-recheck.sql#sonda', v_sha, 'tentativa')
    RETURNING id INTO v_id;
    BEGIN
      v_ret := public.aplicar_sql(v_sql, v_sha, v_id);
      RAISE EXCEPTION 'POS FALHOU: a porta nova executou os mesmos bytes DUAS vezes' USING ERRCODE = 'P0S02';
    EXCEPTION WHEN SQLSTATE '22023' THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF position('(RECUSA_SHA_JA_APLICADO)' IN v_msg) = 0 THEN
        RAISE EXCEPTION 'POS FALHOU: a 2a chamada dos mesmos bytes caiu por OUTRO motivo: %', v_msg;
      END IF;
    END;

    RAISE EXCEPTION 'SONDA_OK' USING ERRCODE = 'P0S01';
  EXCEPTION WHEN SQLSTATE 'P0S01' THEN
    NULL;
  END;
END
$pos$;
