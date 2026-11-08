-- Cópia SEM ENVELOPE de supabase/migrations/20261111120000_radar_carga_publicacao_curta.sql para o
-- `bun run db:aplicar` (a transação é do executor). Mesmos bytes, menos o BEGIN;/COMMIT; — a postcondição
-- confere o md5(prosrc) dos 11 corpos, então qualquer divergência da migration aborta o apply.
-- =============================================================================
-- Radar: a publicação da carga mensal passa a rodar em TRANSAÇÕES CURTAS, sem expor foto parcial
-- =============================================================================
-- Incidente (2026-11-08, docs/historico/radar-carga-publicacao-atomica.md): a 1ª carga real publicada pela
-- 20261110130000 (um INSERT…ON CONFLICT de 503.929 linhas numa transação) estourou statement_timeout 30 min
-- 2×, segurou row lock em ~500k linhas de radar_empresas e travou o Supabase Realtime (ShareLock sobre o xid
-- do cron); o 57014 não caía no WHEN OTHERS e o lote ficava `validada` em laço. Cron pausado, foto intacta.
--
-- Por que não basta fatiar: a FOTO é um rótulo por linha (`ultimo_lote = vigente`). Num mês novo todas as
-- ~490k linhas que continuam mudam de rótulo; fatiado com o predicado antigo, cada lote comitado TIRARIA
-- empresas da foto vigente. A saída é guardar, na própria linha, o rótulo de onde ela veio:
--
--   lote_anterior  — gravado no MESMO UPDATE que troca ultimo_lote para o lote P em publicação.
--   P              — public.radar_lote_publicando(): o lote validado cuja publicação começou e é MAIS NOVO
--                    que o vigente V (re-run do mesmo mês nunca troca rótulo: P é NULL).
--   foto de V      — ultimo_lote = ANY(ARRAY[V, P]) AND (ultimo_lote = V OR lote_anterior = V)
--
-- Durante a publicação isso é exatamente a foto velha (A): rótulo V intocado + rótulo P vindo de V. A empresa
-- nova (rótulo P, anterior NULL) e a que volta ao dump (rótulo P, anterior < V) ficam fora. A virada é UMA
-- linha de radar_ingest_state (status complete): no mesmo snapshot V := P e P := NULL, e a foto vira B inteira.
--
-- Publicação (job radar-publicar-lote → `CALL public.radar_carga_publicar()`): procedure SEM security definer
-- e SEM cláusula SET (as duas proíbem COMMIT), que chama radar_carga_publicar_passo() e COMITA depois de cada
-- passo, com orçamento de 8 min por tick e trava de SESSÃO (o advisory de transação morre no COMMIT):
--   reivindicar  checagens (não regride, staging = esperado; re-run exige membresia IGUAL — Codex ALTO 3) e
--                marca carga_publicacao_iniciada_em. Falha aqui → lote `falhou` (nada foi escrito).
--   lote         próximas K linhas do staging (cursor = último CNPJ EXAMINADO): UPDATE só do que difere
--                (rótulo ou cadastro) + INSERT dos CNPJs novos. Tamanho adaptativo para ficar ≤ ~2 s.
--   recruzar     radar_recruzar_ja_cliente() (marca também as novas, ainda ocultas).
--   virar        conferências só-leitura (examinadas = esperado; count do rótulo = esperado) e a virada.
-- Erro depois de reivindicar NÃO vira `falhou`: a linha já tem rótulo P e a foto só segue coerente se P
-- continuar valendo — o lote fica em publicação, registra carga_erro/tentativas e o próximo tick retoma.
-- query_canceled tem ramo próprio (nunca OTHERS); lock_not_available/deadlock → adiado.
--
-- Leitores: radar_lista e radar_contagem_por_municipio (RPCs interativas, STABLE = 1 snapshot) usam o
-- predicado acima, e com filtro de lote nulo escondem a empresa ainda não publicada; radar_agregado_recalcular,
-- radar_score_recalcular, radar_avisar_lote (jobs em massa) e radar_coorte_sortear (sorteio que não pode
-- mudar) ESPERAM a virada. Build antigo do front: as 2 queries diretas (`.eq('ultimo_lote', V)`) erram só
-- enquanto P existe — residual aceito e registrado (Codex ALTO 1), o front novo usa o rótulo efetivo.
--
-- 'publicando' NÃO é um valor novo de carga_fase (alargar o CHECK pediria DROP CONSTRAINT): é
-- `carga_fase = 'validada' AND carga_publicacao_iniciada_em IS NOT NULL`. Com isso radar_carga_iniciar já
-- recusa carga nova durante a publicação (ela bloqueia qualquer `validada`) e o staging fica imutável.
--
-- Ordem de deploy: ESTA migration (o cron segue INATIVO — alter_job não mexe em `active`) → religar o cron.
-- Prova PG17: db/test-radar-publicacao-curta.sh (correção) e db/test-radar-publicacao-curta-custo.sh (custo
-- com a DDL real de prod, db/fixtures/radar-empresas-ddl-prod-20261108.sql). Codex: desenho 2026-11-08.
-- =============================================================================
SET LOCAL lock_timeout = '5s';

-- 1) Rótulo de origem por linha (sem índice: só é lido junto do rótulo, que já é indexado) ----------------
ALTER TABLE public.radar_empresas ADD COLUMN IF NOT EXISTS lote_anterior text;
COMMENT ON COLUMN public.radar_empresas.lote_anterior IS
  'Rótulo (ultimo_lote) que a linha tinha antes de a publicação em passos do lote atual trocá-lo. Só tem sentido enquanto ultimo_lote = public.radar_lote_publicando(): aí a linha pertence à foto do lote_anterior. NULL = empresa nova. Escritor único: radar_carga_publicar_passo.';

-- 2) Progresso da publicação ---------------------------------------------------------------------------
ALTER TABLE public.radar_ingest_state ADD COLUMN IF NOT EXISTS carga_publicacao_iniciada_em timestamptz;
ALTER TABLE public.radar_ingest_state ADD COLUMN IF NOT EXISTS carga_cursor text;
ALTER TABLE public.radar_ingest_state ADD COLUMN IF NOT EXISTS carga_examinadas integer;
ALTER TABLE public.radar_ingest_state ADD COLUMN IF NOT EXISTS carga_gravadas integer;
ALTER TABLE public.radar_ingest_state ADD COLUMN IF NOT EXISTS carga_tentativas integer;
ALTER TABLE public.radar_ingest_state ADD COLUMN IF NOT EXISTS carga_varrida_em timestamptz;
ALTER TABLE public.radar_ingest_state ADD COLUMN IF NOT EXISTS carga_recruzada_em timestamptz;
COMMENT ON COLUMN public.radar_ingest_state.carga_publicacao_iniciada_em IS
  'Publicação em passos começou (carga_fase segue validada até a virada). Com isto não nulo e o lote mais novo que o vigente, as linhas com ultimo_lote = este lote pertencem à foto do seu lote_anterior.';

-- 3) O lote em publicação (P) -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.radar_lote_publicando()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.mes_referencia
    FROM public.radar_ingest_state s
   WHERE s.carga_fase = 'validada'
     AND s.carga_publicacao_iniciada_em IS NOT NULL
     AND s.mes_referencia > COALESCE((SELECT max(c.mes_referencia) FROM public.radar_ingest_state c
                                       WHERE c.status = 'complete'), '')
   ORDER BY s.mes_referencia
   LIMIT 1
$$;
COMMENT ON FUNCTION public.radar_lote_publicando() IS
  'Lote cuja publicação em passos está em andamento e é mais novo que o vigente (NULL fora disso; re-run do mesmo mês é sempre NULL). Leitor da foto V: ultimo_lote = ANY(ARRAY[V, P]) AND (ultimo_lote = V OR lote_anterior = V).';

-- 4) Um passo da publicação (cada chamada = uma transação curta do chamador) ----------------------------
CREATE OR REPLACE FUNCTION public.radar_carga_publicar_passo(p_tamanho integer DEFAULT 2000)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ini    timestamptz := clock_timestamp();
  r        record;
  v_vig    text;
  v_k      integer := GREATEST(1, LEAST(COALESCE(p_tamanho, 2000), 10000));
  v_etapa  text;
  v_cnpjs  text[];
  v_upd    integer := 0;
  v_ins    integer := 0;
  v_n      integer;
  v_m      integer;
  v_novos  integer;
  v_marc   integer;
  v_estado text;
  v_msg    text;
  v_res    jsonb := '{}'::jsonb;
BEGIN
  -- Reentrante com a trava de SESSÃO da procedure; outra sessão com a carga em voo → ocupado.
  IF NOT pg_try_advisory_xact_lock(hashtext('radar_carga')) THEN
    RETURN jsonb_build_object('estado', 'ocupado');
  END IF;
  SELECT max(mes_referencia) INTO v_vig FROM public.radar_ingest_state WHERE status = 'complete';
  -- Sem FOR UPDATE: a trava acima serializa, e não pegar xid antes da hora mantém só-leitura o que é leitura.
  SELECT * INTO r FROM public.radar_ingest_state WHERE carga_fase = 'validada'
   ORDER BY (carga_publicacao_iniciada_em IS NOT NULL) DESC, mes_referencia LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('estado', 'nada');
  END IF;
  v_etapa := CASE WHEN r.carga_publicacao_iniciada_em IS NULL THEN 'reivindicar'
                  WHEN r.carga_varrida_em IS NULL THEN 'lote'
                  WHEN r.carga_recruzada_em IS NULL THEN 'recruzar'
                  ELSE 'virar' END;
  -- Linha de vendedor em edição: espera até 5 s; passou disso, 55P03 → adiado (próximo tick).
  PERFORM set_config('lock_timeout', '5s', true);

  BEGIN
    IF v_etapa = 'reivindicar' THEN
      -- Score/agregado em voo leem a foto inteira em vários comandos: não começa a trocar rótulo embaixo deles
      -- (e, uma vez começada, os dois esperam a virada). Mesmas chaves das travas deles → adiado.
      IF NOT pg_try_advisory_xact_lock(20261105, 1) OR NOT pg_try_advisory_xact_lock(20261103, 1) THEN
        RAISE EXCEPTION 'RCARGA_JOB_EM_MASSA: score ou agregado em voo' USING ERRCODE = '55P03';
      END IF;
      IF v_vig IS NOT NULL AND r.mes_referencia < v_vig THEN
        RAISE EXCEPTION 'RCARGA_REGRIDE: % é mais antigo que o vigente %', r.mes_referencia, v_vig;
      END IF;
      SELECT count(*) INTO v_n FROM public.radar_empresas_carga WHERE lote = r.mes_referencia;
      IF v_n IS DISTINCT FROM r.carga_esperado THEN
        RAISE EXCEPTION 'RCARGA_STAGING_DIVERGE: staging tem % linhas, a validação contou %', v_n, r.carga_esperado;
      END IF;
      IF r.mes_referencia = v_vig THEN
        -- Re-run do mês vigente: o rótulo não muda, então entrada/saída não teriam como ficar ocultas até a
        -- virada. Só se publica refresh cadastral de MESMA membresia (Codex ALTO 3).
        SELECT count(*) INTO v_m FROM public.radar_empresas_carga c
          JOIN public.radar_empresas e ON e.cnpj = c.cnpj AND e.ultimo_lote = v_vig
         WHERE c.lote = r.mes_referencia;
        SELECT count(*) INTO v_n FROM public.radar_empresas WHERE ultimo_lote = v_vig;
        IF v_m <> r.carga_esperado OR v_n <> r.carga_esperado THEN
          RAISE EXCEPTION 'RCARGA_RERUN_MEMBRESIA: re-run de % mudaria a foto (staging na foto: % de %; foto vigente: %) — publique como lote novo',
            v_vig, v_m, r.carga_esperado, v_n;
        END IF;
      END IF;
      UPDATE public.radar_ingest_state
         SET carga_publicacao_iniciada_em = clock_timestamp(), carga_cursor = NULL, carga_examinadas = 0,
             carga_gravadas = 0, carga_tentativas = 0, carga_varrida_em = NULL, carga_recruzada_em = NULL,
             carga_erro = NULL
       WHERE mes_referencia = r.mes_referencia;
      v_estado := 'avancou';
      v_res := jsonb_build_object('rerun', r.mes_referencia = v_vig);

    ELSIF v_etapa = 'lote' THEN
      SELECT array_agg(x.cnpj ORDER BY x.cnpj) INTO v_cnpjs
        FROM (SELECT c.cnpj FROM public.radar_empresas_carga c
               WHERE c.lote = r.mes_referencia AND c.cnpj > COALESCE(r.carga_cursor, '')
               ORDER BY c.cnpj LIMIT v_k) x;
      IF v_cnpjs IS NULL THEN
        UPDATE public.radar_ingest_state SET carga_varrida_em = clock_timestamp()
         WHERE mes_referencia = r.mes_referencia;
        v_res := jsonb_build_object('varrida', true);
      ELSE
        -- Só o que difere: o re-run medido (503.929 linhas, 0 diferentes) não reescreve nem trava nada.
        UPDATE public.radar_empresas e SET
          razao_social = c.razao_social, nome_fantasia = c.nome_fantasia, cnae_principal = c.cnae_principal,
          cnae_descricao = c.cnae_descricao, cnaes_secundarios = c.cnaes_secundarios, data_abertura = c.data_abertura,
          porte = c.porte, capital_social = c.capital_social, logradouro = c.logradouro, numero = c.numero,
          complemento = c.complemento, bairro = c.bairro, municipio_codigo = c.municipio_codigo,
          municipio_nome = c.municipio_nome, uf = c.uf, cep = c.cep, telefone1 = c.telefone1,
          telefone2 = c.telefone2, email = c.email, socios_nomes = c.socios_nomes,
          lote_anterior = CASE WHEN e.ultimo_lote = c.lote THEN e.lote_anterior ELSE e.ultimo_lote END,
          ultimo_lote = c.lote,
          updated_at = clock_timestamp()
          FROM public.radar_empresas_carga c
         WHERE c.lote = r.mes_referencia AND c.cnpj = ANY (v_cnpjs) AND e.cnpj = c.cnpj
           AND (e.ultimo_lote, e.razao_social, e.nome_fantasia, e.cnae_principal, e.cnae_descricao,
                e.cnaes_secundarios, e.data_abertura, e.porte, e.capital_social, e.logradouro, e.numero,
                e.complemento, e.bairro, e.municipio_codigo, e.municipio_nome, e.uf, e.cep, e.telefone1,
                e.telefone2, e.email, e.socios_nomes)
               IS DISTINCT FROM
               (c.lote, c.razao_social, c.nome_fantasia, c.cnae_principal, c.cnae_descricao,
                c.cnaes_secundarios, c.data_abertura, c.porte, c.capital_social, c.logradouro, c.numero,
                c.complemento, c.bairro, c.municipio_codigo, c.municipio_nome, c.uf, c.cep, c.telefone1,
                c.telefone2, c.email, c.socios_nomes);
        GET DIAGNOSTICS v_upd = ROW_COUNT;
        -- CNPJ novo entra com o rótulo P e lote_anterior NULL: fora de qualquer foto até a virada.
        INSERT INTO public.radar_empresas (
          cnpj, razao_social, nome_fantasia, cnae_principal, cnae_descricao, cnaes_secundarios, data_abertura,
          porte, capital_social, logradouro, numero, complemento, bairro, municipio_codigo, municipio_nome, uf,
          cep, telefone1, telefone2, email, socios_nomes, ultimo_lote, lote_anterior, updated_at)
        SELECT c.cnpj, c.razao_social, c.nome_fantasia, c.cnae_principal, c.cnae_descricao, c.cnaes_secundarios,
               c.data_abertura, c.porte, c.capital_social, c.logradouro, c.numero, c.complemento, c.bairro,
               c.municipio_codigo, c.municipio_nome, c.uf, c.cep, c.telefone1, c.telefone2, c.email,
               c.socios_nomes, c.lote, NULL, clock_timestamp()
          FROM public.radar_empresas_carga c
         WHERE c.lote = r.mes_referencia AND c.cnpj = ANY (v_cnpjs)
           AND NOT EXISTS (SELECT 1 FROM public.radar_empresas e WHERE e.cnpj = c.cnpj)
        ON CONFLICT (cnpj) DO NOTHING;
        GET DIAGNOSTICS v_ins = ROW_COUNT;
        IF v_ins > 0 AND r.mes_referencia = v_vig THEN
          RAISE EXCEPTION 'RCARGA_RERUN_INSERE: % empresas novas num re-run apareceriam antes da virada', v_ins;
        END IF;
        UPDATE public.radar_ingest_state
           SET carga_cursor = v_cnpjs[cardinality(v_cnpjs)],
               carga_examinadas = COALESCE(carga_examinadas, 0) + cardinality(v_cnpjs),
               carga_gravadas = COALESCE(carga_gravadas, 0) + v_upd + v_ins,
               carga_tentativas = 0, carga_erro = NULL
         WHERE mes_referencia = r.mes_referencia;
        v_res := jsonb_build_object('examinadas', cardinality(v_cnpjs), 'atualizadas', v_upd, 'inseridas', v_ins);
      END IF;
      v_estado := 'avancou';

    ELSIF v_etapa = 'recruzar' THEN
      -- Empresa nova que já é cliente entra na foto JÁ marcada (marcar a oculta não muda nenhuma foto).
      v_marc := public.radar_recruzar_ja_cliente();
      UPDATE public.radar_ingest_state SET carga_recruzada_em = clock_timestamp()
       WHERE mes_referencia = r.mes_referencia;
      v_estado := 'avancou';
      v_res := jsonb_build_object('ja_cliente_marcados', v_marc);

    ELSE  -- virar: conferências só-leitura primeiro (sem xid), depois a linha que troca a foto
      IF r.carga_examinadas IS DISTINCT FROM r.carga_esperado THEN
        RAISE EXCEPTION 'RCARGA_VARREDURA_INCOMPLETA: examinou % de % linhas', r.carga_examinadas, r.carga_esperado;
      END IF;
      SELECT count(*) INTO v_n FROM public.radar_empresas WHERE ultimo_lote = r.mes_referencia;
      IF v_n IS DISTINCT FROM r.carga_esperado THEN
        RAISE EXCEPTION 'RCARGA_FOTO_DIVERGE: % empresas com ultimo_lote %, esperava %', v_n, r.mes_referencia, r.carga_esperado;
      END IF;
      SELECT count(*) INTO v_novos FROM public.radar_empresas
       WHERE ultimo_lote = r.mes_referencia AND primeira_vista_em >= r.iniciado_em;
      UPDATE public.radar_ingest_state
         SET status = 'complete', total_recebido = r.carga_esperado, novos = v_novos,
             finalizado_em = clock_timestamp(), erro = NULL,
             carga_fase = 'publicada', carga_publicada_em = clock_timestamp(), carga_erro = NULL
       WHERE mes_referencia = r.mes_referencia;
      TRUNCATE public.radar_empresas_carga;
      v_estado := 'publicado';
      v_res := jsonb_build_object('total', r.carga_esperado, 'novos', v_novos, 'gravadas', r.carga_gravadas,
                                  'publicacao_iniciada_em', r.carga_publicacao_iniciada_em);
    END IF;
  EXCEPTION
    WHEN lock_not_available OR deadlock_detected THEN
      v_estado := 'adiado';
      v_res := jsonb_build_object('adiado', SQLSTATE, 'motivo', left(SQLERRM, 300));
    WHEN query_canceled THEN  -- 57014 (statement_timeout/cancel): NÃO cai em OTHERS
      v_estado := 'cancelado';
      v_msg := left(SQLSTATE || ': ' || SQLERRM, 500);
    WHEN OTHERS THEN
      v_estado := 'erro';
      v_msg := left(SQLSTATE || ': ' || SQLERRM, 500);
  END;

  IF v_estado IN ('cancelado', 'erro') THEN
    IF v_etapa = 'reivindicar' THEN
      -- Nada foi escrito: a carga falha e a foto vigente segue (lote complete continua complete).
      v_estado := 'falhou';
      UPDATE public.radar_ingest_state
         SET carga_fase = 'falhou', carga_erro = v_msg,
             status = CASE WHEN status = 'complete' THEN 'complete' ELSE 'error' END,
             erro   = CASE WHEN status = 'complete' THEN erro ELSE v_msg END
       WHERE mes_referencia = r.mes_referencia;
    ELSE
      -- Já há linhas com rótulo P: P tem de continuar valendo para a foto seguir coerente. Retoma no próximo tick.
      UPDATE public.radar_ingest_state
         SET carga_erro = v_msg, carga_tentativas = COALESCE(carga_tentativas, 0) + 1
       WHERE mes_referencia = r.mes_referencia;
    END IF;
    v_res := jsonb_build_object('etapa', v_etapa, 'erro', v_msg);
  END IF;

  IF v_estado IN ('publicado', 'falhou', 'cancelado', 'erro') THEN
    INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
    VALUES ('radar.publicar_lote', 'automatica', COALESCE(r.carga_publicacao_iniciada_em, v_ini), clock_timestamp(),
            CASE WHEN v_estado = 'publicado' THEN 'sucesso' ELSE 'erro' END,
            v_res || jsonb_build_object('lote', r.mes_referencia, 'estado', v_estado));
  END IF;
  RETURN v_res || jsonb_build_object('estado', v_estado, 'etapa', v_etapa, 'lote', r.mes_referencia,
                                     'ms', round(extract(epoch FROM clock_timestamp() - v_ini) * 1000));
END;
$$;
COMMENT ON FUNCTION public.radar_carga_publicar_passo(integer) IS
  'Um passo (uma transação do chamador) da publicação do lote validado: reivindicar → lotes de p_tamanho linhas → recruzar → virar. Chamado em laço pela procedure radar_carga_publicar (cron radar-publicar-lote).';

-- 5) A procedure do job (COMMIT entre passos; sem SECURITY DEFINER e sem SET, que proíbem COMMIT) --------
CREATE OR REPLACE PROCEDURE public.radar_carga_publicar(p_orcamento interval DEFAULT interval '8 minutes')
LANGUAGE plpgsql
AS $$
DECLARE
  v_ini timestamptz := clock_timestamp();
  v_k   integer := 500;   -- começa pequeno: a prod pode ser bem mais lenta que a prova local
  v_r   jsonb;
  v_ms  numeric;
BEGIN
  -- Trava de SESSÃO: sobrevive aos COMMITs e serializa com iniciar/validar (mesma chave, advisory de xact).
  IF NOT pg_catalog.pg_try_advisory_lock(pg_catalog.hashtext('radar_carga')) THEN
    RETURN;
  END IF;
  LOOP
    -- COMMIT na mesma linha: o db:aplicar recusa a linha `COMMIT;` solta (lê como envelope do arquivo).
    v_r := public.radar_carga_publicar_passo(v_k); COMMIT;
    EXIT WHEN v_r->>'estado' IS DISTINCT FROM 'avancou';
    -- Lote adaptativo: mira ~1 s por transação (o lock de linha e o xid seguram só isso). Medido em PG17 com
    -- a DDL de prod: lote de 5.000 chegou a 4,1 s (flush do pending list dos GIN), por isso o teto é 3.000.
    v_ms := (v_r->>'ms')::numeric;
    IF v_ms > 1500 THEN
      v_k := GREATEST(50, v_k / 2);
    ELSIF v_ms < 500 THEN
      v_k := LEAST(3000, v_k + v_k / 2);
    END IF;
    EXIT WHEN clock_timestamp() - v_ini > p_orcamento;
  END LOOP;
  PERFORM pg_catalog.pg_advisory_unlock(pg_catalog.hashtext('radar_carga'));
END;
$$;
COMMENT ON PROCEDURE public.radar_carga_publicar(interval) IS
  'Entrypoint do cron radar-publicar-lote (`CALL public.radar_carga_publicar()`, um statement só — `SET …; CALL` vira bloco implícito e o COMMIT falha). Laço de radar_carga_publicar_passo com COMMIT a cada passo, orçamento por tick; retoma no tick seguinte.';

-- A antiga entrypoint de uma transação vira UM passo (para operação manual); nunca mais publica tudo de uma vez.
CREATE OR REPLACE FUNCTION public.radar_carga_publicar_pendente()
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.radar_carga_publicar_passo(2000)
$$;
COMMENT ON FUNCTION public.radar_carga_publicar_pendente() IS
  'Obsoleta desde 20261111120000: executa UM passo da publicação em passos (radar_carga_publicar_passo). O cron usa CALL public.radar_carga_publicar().';

-- ACL: passo, procedure e a antiga só do owner (o cron roda como postgres); P é lido pelo front (gestor).
REVOKE ALL ON FUNCTION public.radar_carga_publicar_passo(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON PROCEDURE public.radar_carga_publicar(interval) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.radar_carga_publicar_pendente() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.radar_lote_publicando() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_lote_publicando() TO authenticated, service_role;

-- 6) Job: mesmo nome e janela, comando novo; `active` fica como está (religar é passo à parte, pós-prova) ---
DO $job$
DECLARE
  v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = 'radar-publicar-lote';
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'TRAVA: cron radar-publicar-lote ausente — a 20261110130000 não está aplicada';
  END IF;
  PERFORM cron.alter_job(job_id := v_id, schedule := '*/15 0-5,7-23 * * *',
                         command := 'CALL public.radar_carga_publicar()');
END
$job$;

-- 7) Leitores (corpo = pg_get_functiondef da PROD em 2026-11-08 + as edições marcadas; REPLACE preserva o ACL) --

CREATE OR REPLACE FUNCTION public.radar_carga_iniciar(p_lote text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_antes  text;
  v_vig    text;
BEGIN
  IF p_lote IS NULL OR p_lote !~ '^[0-9]{4}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'RCARGA_LOTE_INVALIDO' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('radar_carga'));
  IF EXISTS (SELECT 1 FROM public.radar_ingest_state WHERE carga_fase = 'validada') THEN
    RAISE EXCEPTION 'RCARGA_PUBLICACAO_PENDENTE: há lote validado esperando o job radar-publicar-lote' USING ERRCODE = '55000';
  END IF;
  SELECT max(mes_referencia) INTO v_vig FROM public.radar_ingest_state WHERE status = 'complete';
  IF v_vig IS NOT NULL AND p_lote < v_vig THEN
    RAISE EXCEPTION 'RCARGA_LOTE_REGRIDE: % é mais antigo que o vigente %', p_lote, v_vig USING ERRCODE = '22023';
  END IF;

  -- Uma carga por vez no staging: a anterior que não terminou (abortou no meio) perde o que mandou.
  TRUNCATE public.radar_empresas_carga;
  UPDATE public.radar_ingest_state
     SET carga_fase = 'falhou', carga_erro = 'RCARGA_SUBSTITUIDA pela carga de ' || p_lote
   WHERE carga_fase = 'recebendo' AND mes_referencia <> p_lote;

  SELECT status INTO v_antes FROM public.radar_ingest_state WHERE mes_referencia = p_lote FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.radar_ingest_state (mes_referencia, status, total_recebido, novos, iniciado_em,
                                           finalizado_em, erro, carga_fase, carga_iniciada_em)
    VALUES (p_lote, 'running', 0, NULL, now(), NULL, NULL, 'recebendo', now());
  ELSE
    -- Re-run: preserva iniciado_em; um lote já complete CONTINUA complete (a foto vigente segue no ar).
    UPDATE public.radar_ingest_state
       SET status        = CASE WHEN v_antes = 'complete' THEN 'complete' ELSE 'running' END,
           erro          = CASE WHEN v_antes = 'complete' THEN erro ELSE NULL END,
           finalizado_em = CASE WHEN v_antes = 'complete' THEN finalizado_em ELSE NULL END,
           carga_fase = 'recebendo', carga_esperado = NULL, carga_erro = NULL,
           carga_iniciada_em = now(), carga_validada_em = NULL,
           -- Publicação em passos (20261111120000): o progresso da publicação ANTERIOR deste lote não vale para
           -- a carga nova — sem zerar, o passo leria 'já varrido/recruzado' e iria direto à virada.
           carga_publicacao_iniciada_em = NULL, carga_cursor = NULL, carga_examinadas = NULL,
           carga_gravadas = NULL, carga_tentativas = NULL, carga_varrida_em = NULL, carga_recruzada_em = NULL
     WHERE mes_referencia = p_lote;
  END IF;
  RETURN jsonb_build_object('lote', p_lote, 'retomado', v_antes IS NOT NULL,
                            'vigente_preservado', v_antes IS NOT DISTINCT FROM 'complete');
END;
$function$;

CREATE OR REPLACE FUNCTION public.radar_lista(p_busca text DEFAULT NULL::text, p_municipio text DEFAULT NULL::text, p_uf text DEFAULT NULL::text, p_ufs text[] DEFAULT NULL::text[], p_cnae_exato text DEFAULT NULL::text, p_cnae_prefixo text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_incluir_ja_clientes boolean DEFAULT false, p_ultimo_lote text DEFAULT NULL::text, p_primeira_vista_min timestamp with time zone DEFAULT NULL::timestamp with time zone, p_sugeridos_lote text DEFAULT NULL::text, p_sugeridos_score_min numeric DEFAULT NULL::numeric, p_com_telefone boolean DEFAULT false, p_com_contato boolean DEFAULT false, p_data_abertura_min date DEFAULT NULL::date, p_data_abertura_max date DEFAULT NULL::date, p_ordem text DEFAULT 'score'::text, p_offset integer DEFAULT 0, p_limit integer DEFAULT 50, p_cnae_secundario text DEFAULT NULL::text, p_municipio_codigo text DEFAULT NULL::text, p_so_meus boolean DEFAULT false, p_so_visitar boolean DEFAULT false)
 RETURNS SETOF radar_empresas
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_w text[] := ARRAY[]::text[];
  v_pub text := public.radar_lote_publicando();  -- P: mesma foto que V até a virada (função STABLE = 1 snapshot)
BEGIN
  -- O mesmo gate da policy radar_empresas_select_gestor: quem não lê a tabela não lê a RPC.
  IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  -- Entrada mal formada contaria ZERO em silêncio (ou abriria a ordenação a SQL): grita.
  IF p_ordem IS NULL OR p_ordem NOT IN ('score', 'capital_social', 'data_abertura') THEN
    RAISE EXCEPTION 'ordem inválida' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 200 OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'paginação inválida' USING ERRCODE = '22023';
  END IF;
  IF p_cnae_exato IS NOT NULL AND p_cnae_exato !~ '^[0-9]{7}$' THEN
    RAISE EXCEPTION 'cnae_exato inválido' USING ERRCODE = '22023';
  END IF;
  IF p_cnae_prefixo IS NOT NULL AND p_cnae_prefixo !~ '^[0-9]{1,6}$' THEN
    RAISE EXCEPTION 'cnae_prefixo inválido' USING ERRCODE = '22023';
  END IF;
  IF p_cnae_secundario IS NOT NULL AND p_cnae_secundario !~ '^[0-9]{7}$' THEN
    RAISE EXCEPTION 'cnae_secundario inválido' USING ERRCODE = '22023';
  END IF;
  IF (p_ultimo_lote IS NOT NULL AND p_ultimo_lote !~ '^[0-9]{4}-[0-9]{2}$')
     OR (p_sugeridos_lote IS NOT NULL AND p_sugeridos_lote !~ '^[0-9]{4}-[0-9]{2}$') THEN
    RAISE EXCEPTION 'lote inválido' USING ERRCODE = '22023';
  END IF;
  IF p_sugeridos_lote IS NOT NULL AND p_sugeridos_score_min IS NULL THEN
    RAISE EXCEPTION 'sugeridos sem limiar de score' USING ERRCODE = '22023';
  END IF;
  -- Código de município da RFB: 4 dígitos. Mal formado contaria ZERO em silêncio: grita.
  IF p_municipio_codigo IS NOT NULL AND p_municipio_codigo !~ '^[0-9]{4}$' THEN
    RAISE EXCEPTION 'municipio_codigo inválido' USING ERRCODE = '22023';
  END IF;
  IF p_ufs IS NOT NULL AND (cardinality(p_ufs) = 0 OR cardinality(p_ufs) > 27
     OR EXISTS (SELECT 1 FROM unnest(p_ufs) AS x(u) WHERE x.u IS NULL OR x.u !~ '^[A-Z]{2}$')) THEN
    RAISE EXCEPTION 'ufs inválido' USING ERRCODE = '22023';
  END IF;

  -- Busca (razão OU fantasia) e município: o termo já chega sanitizado pelo front
  -- (sanitizeForPostgrestOr). Termo sem conteúdo (só espaço) = sem filtro, como o front faz com o vazio.
  IF private.padrao_like_contem(p_busca) IS NOT NULL THEN
    v_w := array_append(v_w, $w$(e.razao_social ILIKE private.padrao_like_contem($1) ESCAPE '\' OR e.nome_fantasia ILIKE private.padrao_like_contem($1) ESCAPE '\')$w$);
  END IF;
  IF private.padrao_like_contem(p_municipio) IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.municipio_nome ILIKE private.padrao_like_contem($2) ESCAPE '\'$w$);
  END IF;
  -- Cidade escolhida no ranking/mapa: o CÓDIGO, exato (o nome tem homônimos em outras UFs). Usa idx_radar_muni.
  IF p_municipio_codigo IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.municipio_codigo = $20$w$);
  END IF;
  -- "Meus atendimentos": só os leads que o vendedor assumiu e que seguem ATIVOS (não expirados, dono ainda na
  -- capability). NO SERVIDOR, antes do LIMIT/OFFSET: recortar os 50 carregados no front daria falso vazio. A
  -- expiração e o dono vêm de radar_atendimentos_ativos() (a mesma leitura da ficha e dos selos): a regra do
  -- prazo vive só em private.radar_atendimento_expira_em. Sem parâmetro ($n): o predicado é constante.
  IF COALESCE(p_so_meus, false) THEN
    v_w := array_append(v_w, $w$e.cnpj IN (SELECT a.cnpj FROM public.radar_atendimentos_ativos() a WHERE a.eh_meu)$w$);
  END IF;
  -- "Para visitar": todo contato utilizável do lead tem indício de contabilidade (no EFETIVO, com a correção do
  -- vendedor) e há endereço. NO SERVIDOR, antes do LIMIT/OFFSET. O IN pré-recorta pelos ~80 mil CNPJs com sinal ou
  -- correção positiva; a regra em si é private.radar_contato_visitar (a mesma do card e do e-mail). Sem parâmetro.
  IF COALESCE(p_so_visitar, false) THEN
    v_w := array_append(v_w, $w$e.cnpj IN (SELECT c.cnpj FROM public.radar_contato_contabil c
                                           UNION SELECT k.cnpj FROM public.radar_contato_contabil_correcoes k WHERE k.veredito)
      AND private.radar_contato_visitar(e.cnpj, e.telefone1, e.telefone2, e.email, e.logradouro)$w$);
  END IF;
  -- UF escolhida vence a região.
  IF p_uf IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.uf = $3$w$);
  ELSIF p_ufs IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.uf = ANY ($4)$w$);
  END IF;
  IF p_cnae_exato IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.cnae_principal = $5$w$);
  ELSIF p_cnae_prefixo IS NOT NULL THEN
    v_w := array_append(v_w, $w$starts_with(e.cnae_principal, $6)$w$);
  END IF;
  -- CNAE secundário combina com o principal (E): "@>" usa o GIN idx_radar_empresas_cnaes_sec.
  IF p_cnae_secundario IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.cnaes_secundarios @> ARRAY[$19]$w$);
  END IF;
  -- "Só sugeridos" = o predicado do card (filtrarSugeridos): fixa lote/status/já-cliente, vence os de baixo.
  IF p_sugeridos_lote IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.ultimo_lote = ANY (ARRAY[$11, $21]) AND (e.ultimo_lote = $11 OR e.lote_anterior = $11) AND e.prospeccao_status = 'em_conversa' AND e.ja_cliente = false
      AND e.omie_codigo_cliente IS NULL AND (e.rfb_situacao IS NULL OR e.rfb_situacao = '02')
      AND e.cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$' AND e.score >= $12$w$);
  ELSE
    IF p_status IS NOT NULL THEN
      v_w := array_append(v_w, $w$e.prospeccao_status = $7$w$);
    ELSE
      v_w := array_append(v_w, $w$e.prospeccao_status <> 'descartado'$w$);
    END IF;
    IF NOT COALESCE(p_incluir_ja_clientes, false) THEN
      v_w := array_append(v_w, $w$e.ja_cliente = false$w$);
    END IF;
    IF p_ultimo_lote IS NOT NULL THEN
      -- Foto do lote pedido; durante a publicação em passos inclui quem já ganhou o rótulo novo vindo dele.
      v_w := array_append(v_w, $w$e.ultimo_lote = ANY (ARRAY[$9, $21]) AND (e.ultimo_lote = $9 OR e.lote_anterior = $9)$w$);
    ELSIF v_pub IS NOT NULL THEN
      -- Sem recorte de lote: a empresa que só existe no lote em publicação ainda não é de foto nenhuma.
      v_w := array_append(v_w, $w$NOT (e.ultimo_lote = $21 AND e.lote_anterior IS NULL)$w$);
    END IF;
  END IF;
  IF p_primeira_vista_min IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.primeira_vista_em >= $10$w$);
  END IF;
  IF COALESCE(p_com_telefone, false) THEN
    v_w := array_append(v_w, $w$(e.telefone1 IS NOT NULL OR e.telefone2 IS NOT NULL)$w$);
  END IF;
  IF COALESCE(p_com_contato, false) THEN
    v_w := array_append(v_w, $w$(e.telefone1 IS NOT NULL OR e.telefone2 IS NOT NULL OR e.email IS NOT NULL)$w$);
  END IF;
  IF p_data_abertura_min IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.data_abertura >= $15$w$);
  END IF;
  IF p_data_abertura_max IS NOT NULL THEN
    v_w := array_append(v_w, $w$e.data_abertura <= $16$w$);
  END IF;

  RETURN QUERY EXECUTE format(
    $q$SELECT e.* FROM public.radar_empresas e WHERE %s ORDER BY e.%I DESC NULLS LAST, e.cnpj LIMIT $17 OFFSET $18$q$,
    array_to_string(v_w, ' AND '), p_ordem)
  USING p_busca, p_municipio, p_uf, p_ufs, p_cnae_exato, p_cnae_prefixo, p_status, p_incluir_ja_clientes,
        p_ultimo_lote, p_primeira_vista_min, p_sugeridos_lote, p_sugeridos_score_min, p_com_telefone,
        p_com_contato, p_data_abertura_min, p_data_abertura_max, p_limit, p_offset, p_cnae_secundario, p_municipio_codigo, v_pub;
END
$function$;

CREATE OR REPLACE FUNCTION public.radar_contagem_por_municipio(p_uf text DEFAULT NULL::text, p_cnae_prefix text DEFAULT NULL::text, p_cnae_exato text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_incluir_ja_clientes boolean DEFAULT false, p_data_abertura_min date DEFAULT NULL::date, p_data_abertura_max date DEFAULT NULL::date, p_limit integer DEFAULT 500, p_lote text DEFAULT NULL::text, p_primeira_vista_min timestamp with time zone DEFAULT NULL::timestamp with time zone, p_ufs text[] DEFAULT NULL::text[], p_com_contato boolean DEFAULT false, p_cnae_secundario text DEFAULT NULL::text, p_com_telefone boolean DEFAULT false)
 RETURNS TABLE(municipio_codigo text, municipio_nome text, uf text, lat double precision, lng double precision, total bigint, com_telefone bigint, a_contatar bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inedito_ok boolean;
  v_pub text := public.radar_lote_publicando();  -- P: mesma foto que V até a virada (função STABLE = 1 snapshot)
  v_corte date;
  v_estab text;  -- NULL = sem corte de data; 'd0' = estabelecida; 'd1' = estabelecida_d1; 'vivo' = fora do fino
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar';
  END IF;
  IF p_cnae_prefix IS NOT NULL AND p_cnae_prefix !~ '^[0-9]{1,7}$' THEN RAISE EXCEPTION 'cnae_prefix inválido'; END IF;
  IF p_cnae_exato  IS NOT NULL AND p_cnae_exato  !~ '^[0-9]{7}$'   THEN RAISE EXCEPTION 'cnae_exato inválido';  END IF;
  IF p_cnae_secundario IS NOT NULL AND p_cnae_secundario !~ '^[0-9]{7}$' THEN RAISE EXCEPTION 'cnae_secundario inválido'; END IF;
  -- Lote mal formado contaria ZERO em silêncio (nenhum ultimo_lote casa) — ausente ≠ zero: grita.
  IF p_lote IS NOT NULL AND p_lote !~ '^[0-9]{4}-[0-9]{2}$' THEN RAISE EXCEPTION 'lote inválido'; END IF;
  -- Região vazia ou com UF mal formada também contaria zero em silêncio: grita.
  IF p_ufs IS NOT NULL AND (cardinality(p_ufs) = 0 OR cardinality(p_ufs) > 27
     OR EXISTS (SELECT 1 FROM unnest(p_ufs) AS x(u) WHERE x.u IS NULL OR x.u !~ '^[A-Z]{2}$')) THEN
    RAISE EXCEPTION 'ufs inválido';
  END IF;

  -- Inéditos cabem no agregado só quando são os DO LOTE VIGENTE (a identidade com que ele foi calculado).
  v_inedito_ok := p_primeira_vista_min IS NULL OR p_primeira_vista_min = (
    SELECT s.iniciado_em FROM public.radar_ingest_state s
     WHERE s.status = 'complete' ORDER BY s.mes_referencia DESC LIMIT 1);

  -- AGREGADO: tudo o que o recorte cabe em radar_agregado_municipio (UF, região, status, já-cliente, lote,
  -- contato e inéditos do lote vigente). É o default do /radar e o roteirizador.
  IF p_cnae_prefix IS NULL AND p_cnae_exato IS NULL AND p_cnae_secundario IS NULL
     AND p_data_abertura_min IS NULL AND p_data_abertura_max IS NULL
     AND v_inedito_ok THEN
    -- Agregado de outro lote contaria a foto velha (ou ZERO para o lote novo): indisponível, nunca 0.
    IF private.radar_agregado_valido() IS NULL THEN
      RAISE EXCEPTION 'agregado indisponível: as contagens do lote vigente ainda não foram calculadas';
    END IF;
    RETURN QUERY
    WITH agg AS MATERIALIZED (
      SELECT a.municipio_codigo AS mc, a.uf AS u, a.municipio_nome AS mn,
             sum(a.n)::bigint AS t,
             COALESCE(sum(a.n) FILTER (WHERE a.tem_telefone), 0)::bigint AS ct,
             COALESCE(sum(a.n) FILTER (WHERE a.prospeccao_status = 'a_contatar'), 0)::bigint AS ac
        FROM public.radar_agregado_municipio a
       WHERE (p_uf IS NULL OR a.uf = p_uf)
         AND (p_uf IS NOT NULL OR p_ufs IS NULL OR a.uf = ANY (p_ufs))
         AND ((p_status IS NOT NULL AND a.prospeccao_status = p_status)
              OR (p_status IS NULL AND a.prospeccao_status <> 'descartado'))
         AND (p_incluir_ja_clientes OR a.ja_cliente = false)
         AND (p_lote IS NULL OR a.lote = p_lote)
         AND (p_primeira_vista_min IS NULL OR a.inedito)
         AND (NOT COALESCE(p_com_contato, false) OR a.tem_contato)
         AND (NOT COALESCE(p_com_telefone, false) OR a.tem_telefone)
       GROUP BY a.municipio_codigo, a.uf, a.municipio_nome
    )
    SELECT a.mc, COALESCE(m.nome, a.mn), a.u, m.lat, m.lng,
           sum(a.t)::bigint, sum(a.ct)::bigint, sum(a.ac)::bigint
      FROM agg a
      LEFT JOIN public.radar_municipios m ON m.codigo = a.mc
     GROUP BY a.mc, COALESCE(m.nome, a.mn), a.u, m.lat, m.lng
     ORDER BY sum(a.t) DESC, a.mc
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
    RETURN;
  END IF;

  -- FINO: CNAE e/ou o corte de "estabelecidas" (data máxima = corte do cálculo, ou corte + 1 dia na
  -- madrugada antes do recálculo diário). Data máxima de outro dia, data mínima ou inéditos de outro lote
  -- não cabem: caminho vivo. Com CNAE secundário, o mesmo recorte lê radar_agregado_cnae_sec — se o código
  -- está entre os cobertos pelo cálculo; senão o agregado contaria ZERO para ele: caminho vivo.
  IF p_data_abertura_min IS NULL AND v_inedito_ok THEN
    IF p_data_abertura_max IS NULL THEN
      v_estab := NULL;
    ELSE
      SELECT e.corte_estabelecida INTO v_corte FROM public.radar_agregado_estado e WHERE e.id = 1;
      v_estab := CASE WHEN p_data_abertura_max = v_corte THEN 'd0'
                      WHEN p_data_abertura_max = v_corte + 1 THEN 'd1'
                      ELSE 'vivo' END;
    END IF;
    IF v_estab IS DISTINCT FROM 'vivo' AND p_cnae_secundario IS NULL THEN
      IF private.radar_agregado_valido() IS NULL THEN
        RAISE EXCEPTION 'agregado indisponível: as contagens do lote vigente ainda não foram calculadas';
      END IF;
      RETURN QUERY
      WITH agg AS MATERIALIZED (
        SELECT a.municipio_codigo AS mc, a.uf AS u, a.municipio_nome AS mn,
               sum(a.n)::bigint AS t,
               COALESCE(sum(a.n) FILTER (WHERE a.tem_telefone), 0)::bigint AS ct,
               COALESCE(sum(a.n) FILTER (WHERE a.prospeccao_status = 'a_contatar'), 0)::bigint AS ac
          FROM public.radar_agregado_cnae a
         WHERE (p_uf IS NULL OR a.uf = p_uf)
           AND (p_uf IS NOT NULL OR p_ufs IS NULL OR a.uf = ANY (p_ufs))
           AND (p_cnae_exato  IS NULL OR a.cnae_principal = p_cnae_exato)
           AND (p_cnae_prefix IS NULL OR starts_with(a.cnae_principal, p_cnae_prefix))
           AND ((p_status IS NOT NULL AND a.prospeccao_status = p_status)
                OR (p_status IS NULL AND a.prospeccao_status <> 'descartado'))
           AND (p_incluir_ja_clientes OR a.ja_cliente = false)
           AND (v_estab IS NULL OR (v_estab = 'd0' AND a.estabelecida) OR (v_estab = 'd1' AND a.estabelecida_d1))
           AND (p_lote IS NULL OR a.lote = p_lote)
           AND (p_primeira_vista_min IS NULL OR a.inedito)
           AND (NOT COALESCE(p_com_contato, false) OR a.tem_contato)
           AND (NOT COALESCE(p_com_telefone, false) OR a.tem_telefone)
         GROUP BY a.municipio_codigo, a.uf, a.municipio_nome
      )
      SELECT a.mc, COALESCE(m.nome, a.mn), a.u, m.lat, m.lng,
             sum(a.t)::bigint, sum(a.ct)::bigint, sum(a.ac)::bigint
        FROM agg a
        LEFT JOIN public.radar_municipios m ON m.codigo = a.mc
       GROUP BY a.mc, COALESCE(m.nome, a.mn), a.u, m.lat, m.lng
       ORDER BY sum(a.t) DESC, a.mc
       LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
      RETURN;
    END IF;
    IF v_estab IS DISTINCT FROM 'vivo' AND p_cnae_secundario IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.radar_agregado_estado e
                    WHERE e.id = 1 AND p_cnae_secundario = ANY (e.cnaes_secundarios_cobertos)) THEN
      IF private.radar_agregado_valido() IS NULL THEN
        RAISE EXCEPTION 'agregado indisponível: as contagens do lote vigente ainda não foram calculadas';
      END IF;
      RETURN QUERY
      WITH agg AS MATERIALIZED (
        SELECT a.municipio_codigo AS mc, a.uf AS u, a.municipio_nome AS mn,
               sum(a.n)::bigint AS t,
               COALESCE(sum(a.n) FILTER (WHERE a.tem_telefone), 0)::bigint AS ct,
               COALESCE(sum(a.n) FILTER (WHERE a.prospeccao_status = 'a_contatar'), 0)::bigint AS ac
          FROM public.radar_agregado_cnae_sec a
         WHERE a.cnae_secundario = p_cnae_secundario
           AND (p_uf IS NULL OR a.uf = p_uf)
           AND (p_uf IS NOT NULL OR p_ufs IS NULL OR a.uf = ANY (p_ufs))
           AND (p_cnae_exato  IS NULL OR a.cnae_principal = p_cnae_exato)
           AND (p_cnae_prefix IS NULL OR starts_with(a.cnae_principal, p_cnae_prefix))
           AND ((p_status IS NOT NULL AND a.prospeccao_status = p_status)
                OR (p_status IS NULL AND a.prospeccao_status <> 'descartado'))
           AND (p_incluir_ja_clientes OR a.ja_cliente = false)
           AND (v_estab IS NULL OR (v_estab = 'd0' AND a.estabelecida) OR (v_estab = 'd1' AND a.estabelecida_d1))
           AND (p_lote IS NULL OR a.lote = p_lote)
           AND (p_primeira_vista_min IS NULL OR a.inedito)
           AND (NOT COALESCE(p_com_contato, false) OR a.tem_contato)
           AND (NOT COALESCE(p_com_telefone, false) OR a.tem_telefone)
         GROUP BY a.municipio_codigo, a.uf, a.municipio_nome
      )
      SELECT a.mc, COALESCE(m.nome, a.mn), a.u, m.lat, m.lng,
             sum(a.t)::bigint, sum(a.ct)::bigint, sum(a.ac)::bigint
        FROM agg a
        LEFT JOIN public.radar_municipios m ON m.codigo = a.mc
       GROUP BY a.mc, COALESCE(m.nome, a.mn), a.u, m.lat, m.lng
       ORDER BY sum(a.t) DESC, a.mc
       LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
      RETURN;
    END IF;
  END IF;

  -- VIVO: data de abertura fora do corte, data mínima ou inéditos de outro lote — o caminho de antes.
  -- p_uf vence p_ufs: com UF escolhida a região não entra (a UF já recorta mais fino). Prefixo de CNAE
  -- por starts_with: p_cnae_prefix só tem dígitos, então casa o mesmo que o LIKE de antes, sem curinga.
  RETURN QUERY
  SELECT re.municipio_codigo,
         COALESCE(m.nome, re.municipio_nome) AS municipio_nome,
         re.uf,
         m.lat, m.lng,
         count(*)::bigint AS total,
         count(*) FILTER (WHERE re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL)::bigint AS com_telefone,
         count(*) FILTER (WHERE re.prospeccao_status = 'a_contatar')::bigint AS a_contatar
    FROM public.radar_empresas re
    LEFT JOIN public.radar_municipios m ON m.codigo = re.municipio_codigo
   WHERE (p_uf IS NULL OR re.uf = p_uf)
     AND (p_uf IS NOT NULL OR p_ufs IS NULL OR re.uf = ANY (p_ufs))
     AND (p_cnae_exato  IS NULL OR re.cnae_principal = p_cnae_exato)
     AND (p_cnae_prefix IS NULL OR starts_with(re.cnae_principal, p_cnae_prefix))
     AND (p_cnae_secundario IS NULL OR re.cnaes_secundarios @> ARRAY[p_cnae_secundario])
     AND ((p_status IS NOT NULL AND re.prospeccao_status = p_status)
          OR (p_status IS NULL AND re.prospeccao_status <> 'descartado'))
     AND (p_incluir_ja_clientes OR re.ja_cliente = false)
     AND (p_data_abertura_min IS NULL OR re.data_abertura >= p_data_abertura_min)
     AND (p_data_abertura_max IS NULL OR re.data_abertura <= p_data_abertura_max)
     AND (p_lote IS NULL OR (re.ultimo_lote = ANY (ARRAY[p_lote, v_pub])
                             AND (re.ultimo_lote = p_lote OR re.lote_anterior = p_lote)))
     AND (p_lote IS NOT NULL OR v_pub IS NULL OR NOT (re.ultimo_lote = v_pub AND re.lote_anterior IS NULL))
     AND (p_primeira_vista_min IS NULL OR re.primeira_vista_em >= p_primeira_vista_min)
     AND (NOT COALESCE(p_com_contato, false) OR re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL OR re.email IS NOT NULL)
     AND (NOT COALESCE(p_com_telefone, false) OR re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL)
   GROUP BY re.municipio_codigo, COALESCE(m.nome, re.municipio_nome), re.uf, m.lat, m.lng
   ORDER BY total DESC, re.municipio_codigo
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 500), 2000));
END $function$;

CREATE OR REPLACE FUNCTION public.radar_agregado_recalcular(p_forcar boolean DEFAULT false, p_agora timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET work_mem TO '32MB'
AS $function$
DECLARE
  v_lote text;
  v_ini timestamptz;
  e public.radar_agregado_estado%ROWTYPE;
  v_tem_estado boolean;
  -- Marco diário: 06:35 UTC, depois de situação (06:05), recruzamento (06:15) e score (06:30).
  v_marco timestamptz := date_trunc('day', p_agora - interval '6 hours 35 minutes', 'UTC') + interval '6 hours 35 minutes';
  -- "Estabelecidas" = abertas há 5 anos ou mais na data de São Paulo (o hojeISO do front).
  v_corte date := ((p_agora AT TIME ZONE 'America/Sao_Paulo')::date - interval '5 years')::date;
  v_empresas bigint;
  v_grupos integer;
  v_cobertos text[];
BEGIN
  -- Um cálculo por vez: o segundo espera o primeiro e relê o estado já novo.
  PERFORM pg_advisory_xact_lock(20261103, 1);
  -- Publicação em passos em andamento (20261111120000): os rótulos físicos misturam a foto velha e a nova
  -- — o agregado segue o da foto vigente até a virada (o tick seguinte recalcula).
  IF public.radar_lote_publicando() IS NOT NULL THEN
    RETURN jsonb_build_object('recalculou', false, 'adiado', 'publicacao_em_andamento',
                              'lote_em_publicacao', public.radar_lote_publicando());
  END IF;

  SELECT s.mes_referencia, s.iniciado_em INTO v_lote, v_ini
    FROM public.radar_ingest_state s
   WHERE s.status = 'complete'
   ORDER BY s.mes_referencia DESC LIMIT 1;

  SELECT * INTO e FROM public.radar_agregado_estado WHERE id = 1;
  v_tem_estado := FOUND;

  IF NOT COALESCE(p_forcar, false) AND v_tem_estado
     AND e.base_lote IS NOT DISTINCT FROM v_lote
     AND e.base_iniciado_em IS NOT DISTINCT FROM v_ini
     AND e.calculado_em >= v_marco THEN
    RETURN jsonb_build_object('recalculou', false, 'lote', v_lote, 'calculado_em', e.calculado_em);
  END IF;

  -- CNAEs secundários cobertos pelo agregado = os CNAEs PRINCIPAIS da base (a carga só traz os CNAEs-alvo
  -- como principal). Varredura solta do índice de cnae_principal: uma descida por código, não a tabela.
  WITH RECURSIVE t(c) AS (
    SELECT min(cnae_principal) FROM public.radar_empresas
    UNION ALL
    SELECT (SELECT min(r.cnae_principal) FROM public.radar_empresas r WHERE r.cnae_principal > t.c)
      FROM t WHERE t.c IS NOT NULL
  )
  SELECT COALESCE(array_agg(t.c ORDER BY t.c), ARRAY[]::text[]) INTO v_cobertos FROM t WHERE t.c IS NOT NULL;

  -- DELETE (não TRUNCATE): quem lê durante o cálculo continua vendo o agregado anterior até o COMMIT.
  DELETE FROM public.radar_agregado_cnae;
  DELETE FROM public.radar_agregado_cnae_sec;
  DELETE FROM public.radar_agregado_municipio;
  -- 1 leitura de radar_empresas: cada empresa sai 1× com secundário NULL (→ fino) e 1× por CNAE
  -- secundário coberto, sem repetir (→ secundário; o array da RFB pode trazer o mesmo código 2 vezes).
  WITH src AS MATERIALIZED (
    SELECT re.ultimo_lote AS lote, re.municipio_codigo AS mc, re.uf AS u, re.municipio_nome AS mn,
           re.prospeccao_status AS st, re.ja_cliente AS jc,
           (re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL) AS tt,
           (re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL OR re.email IS NOT NULL) AS tc,
           COALESCE(re.primeira_vista_em >= v_ini, false) AS ined,
           re.cnae_principal AS cp,
           s.cs,
           COALESCE(re.data_abertura <= v_corte, false) AS est,
           COALESCE(re.data_abertura <= v_corte + 1, false) AS est1,
           count(*) AS n
      FROM public.radar_empresas re
      CROSS JOIN LATERAL (
        SELECT NULL::text AS cs
        UNION ALL
        SELECT DISTINCT x.cs FROM unnest(re.cnaes_secundarios) AS x(cs) WHERE x.cs = ANY (v_cobertos)
      ) s
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13
  ), fino AS (
    INSERT INTO public.radar_agregado_cnae
           (lote, municipio_codigo, uf, municipio_nome, prospeccao_status, ja_cliente,
            tem_telefone, tem_contato, inedito, cnae_principal, estabelecida, estabelecida_d1, n)
    SELECT lote, mc, u, mn, st, jc, tt, tc, ined, cp, est, est1, n FROM src WHERE cs IS NULL
    RETURNING 1
  )
  INSERT INTO public.radar_agregado_cnae_sec
         (lote, municipio_codigo, uf, municipio_nome, prospeccao_status, ja_cliente,
          tem_telefone, tem_contato, inedito, cnae_principal, cnae_secundario, estabelecida, estabelecida_d1, n)
  SELECT lote, mc, u, mn, st, jc, tt, tc, ined, cp, cs, est, est1, n FROM src WHERE cs IS NOT NULL;

  -- O agregado por município é a soma do fino: a tabela grande é lida uma vez só.
  INSERT INTO public.radar_agregado_municipio
         (lote, municipio_codigo, uf, municipio_nome, prospeccao_status, ja_cliente,
          tem_telefone, tem_contato, inedito, n)
  SELECT c.lote, c.municipio_codigo, c.uf, c.municipio_nome, c.prospeccao_status, c.ja_cliente,
         c.tem_telefone, c.tem_contato, c.inedito, sum(c.n)::bigint
    FROM public.radar_agregado_cnae c
   GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9;

  SELECT COALESCE(sum(a.n), 0), count(*) INTO v_empresas, v_grupos FROM public.radar_agregado_municipio a;

  INSERT INTO public.radar_agregado_estado AS t (id, base_lote, base_iniciado_em, calculado_em, empresas, grupos, corte_estabelecida,
                                                  cnaes_secundarios_cobertos)
  VALUES (1, v_lote, v_ini, p_agora, v_empresas, v_grupos, v_corte, v_cobertos)
  ON CONFLICT (id) DO UPDATE
     SET base_lote = EXCLUDED.base_lote, base_iniciado_em = EXCLUDED.base_iniciado_em,
         calculado_em = EXCLUDED.calculado_em, empresas = EXCLUDED.empresas, grupos = EXCLUDED.grupos,
         corte_estabelecida = EXCLUDED.corte_estabelecida,
         cnaes_secundarios_cobertos = EXCLUDED.cnaes_secundarios_cobertos;

  RETURN jsonb_build_object('recalculou', true, 'lote', v_lote, 'empresas', v_empresas, 'grupos', v_grupos,
                            'corte_estabelecida', v_corte, 'cnaes_secundarios_cobertos', cardinality(v_cobertos),
                            'calculado_em', p_agora);
END
$function$;

CREATE OR REPLACE FUNCTION public.radar_score_recalcular()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ini            timestamptz := clock_timestamp();
  v_vigente        text;
  v_vigente_inicio timestamptz;
  v_ref            date;
  v_resumo         jsonb;
  -- Versão da FÓRMULA gravada com o score (v4 = nova migration que troca esta constante e os pesos).
  c_versao         CONSTANT text := 'v3';
  -- Rede de segurança do gate: sem mudança detectada, a rodada diária do 7º dia recalcula mesmo assim
  -- (6 d 23 h: o cron das 06:30 nunca cai alguns ms antes do vencimento e empurra para o 8º — Codex BAIXO 3).
  -- O gate é heurístico numa corrida: transação que começou ANTES da leitura da impressão e commita DEPOIS,
  -- sem mudar o nº de já-clientes, fica invisível ao max(updated_at) — a rede de 7 dias é o teto da
  -- defasagem (Codex MÉDIO 1; os escritores reais são a ingestão, que muda o lote, e o cadastro de 1 linha).
  c_validade       CONSTANT interval := interval '6 days 23 hours';
  v_est            public.radar_score_estado%ROWTYPE;
  v_tem_estado     boolean;
  v_fp_upd         timestamptz;
  v_fp_jc          bigint;
BEGIN
  -- Um cálculo por vez: o estado do gate é lido e gravado sob a mesma trava.
  PERFORM pg_advisory_xact_lock(20261105, 1);
  -- Publicação em passos em andamento (20261111120000): os rótulos físicos misturam a foto velha e a nova
  -- — pontuar agora classificaria o rótulo novo como "lote em ingestão". A rodada do dia seguinte pontua.
  IF public.radar_lote_publicando() IS NOT NULL THEN
    RETURN jsonb_build_object('adiado', 'publicacao_em_andamento', 'lote_em_publicacao', public.radar_lote_publicando());
  END IF;

  -- Lote vigente: a foto mais nova que terminou. Sem ela, nada pontua (NULL honesto, nunca 0).
  SELECT s.mes_referencia, s.iniciado_em
    INTO v_vigente, v_vigente_inicio
    FROM public.radar_ingest_state s
   WHERE s.status = 'complete'
   ORDER BY s.mes_referencia DESC
   LIMIT 1;
  -- Referência de idade = 1º dia do mês do lote (dado), nunca o relógio da sessão (relogio-nu-da-sessao-gate).
  v_ref := CASE WHEN v_vigente IS NULL THEN NULL ELSE to_date(v_vigente || '-01', 'YYYY-MM-DD') END;

  -- GATE (Mini, 2026-11-05): o score só depende do lote, da fórmula, das colunas da linha (toda escrita
  -- de ingestão/recruzamento bumpa updated_at) e da contagem de já-clientes por município/UF. Nada disso
  -- depende do relógio. A impressão digital é lida ANTES do cálculo, pelos índices (max de updated_at e
  -- o parcial de ja_cliente): nunca a tabela. Igual à do último cálculo completo → não relê os 731 MB.
  SELECT max(re.updated_at) INTO v_fp_upd FROM public.radar_empresas re;
  SELECT count(*) INTO v_fp_jc FROM public.radar_empresas re WHERE re.ja_cliente;

  SELECT * INTO v_est FROM public.radar_score_estado WHERE id = 1;
  v_tem_estado := FOUND;

  IF v_tem_estado
     AND v_est.lote IS NOT DISTINCT FROM v_vigente
     AND v_est.lote_iniciado_em IS NOT DISTINCT FROM v_vigente_inicio
     AND v_est.versao_formula IS NOT DISTINCT FROM c_versao
     AND v_est.max_updated_at IS NOT DISTINCT FROM v_fp_upd
     AND v_est.ja_cliente_n IS NOT DISTINCT FROM v_fp_jc
     AND v_est.calculado_em > v_ini - c_validade THEN
    v_resumo := jsonb_build_object(
      'lote_vigente', v_vigente,
      'versao_formula', c_versao,
      'recalculou', false,
      'motivo', 'nada mudou desde o último cálculo completo',
      'ultimo_calculo_em', v_est.calculado_em,
      'duracao_ms', round(extract(epoch FROM clock_timestamp() - v_ini) * 1000)::integer);
    -- O registro diário continua (data_health e radar_avisar_lote leem lote_vigente da última rodada).
    BEGIN
      INSERT INTO public.acoes_execucoes
        (acao, origem, iniciado_em, finalizado_em, status, detalhes)
      VALUES
        ('radar.score_recalcular', 'automatica', v_ini, clock_timestamp(), 'sucesso', v_resumo);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RETURN v_resumo;
  END IF;

  -- UM comando: cálculo, UPDATE e resumo partilham o MESMO snapshot (Codex MÉDIO 3).
  WITH
  -- Pesos VERSIONADOS por esta migration. Tier da curadoria (scripts/radar/cnaes-alvo.txt), informado pela
  -- penetração medida em 2026-10-19 (ja_cliente/total por CNAE): tier 1 ≥ 0,4 %, tier 3 < 0,1 %.
  pesos_cnae(cnae, tier, pontos, rotulo) AS (VALUES
    ('3101200', 1, 25, 'móveis de madeira'),
    ('3102100', 1, 25, 'móveis de metal'),
    ('3103900', 1, 25, 'móveis de outros materiais'),
    ('2391503', 1, 25, 'marmoraria'),
    ('1629301', 1, 25, 'artefatos de madeira'),
    ('9529105', 1, 25, 'restauração de mobiliário'),
    ('1622699', 2, 15, 'carpintaria para construção'),
    ('1622602', 2, 15, 'esquadrias de madeira'),
    ('1622601', 2, 15, 'casas de madeira'),
    ('1623400', 2, 15, 'tanoaria e embalagens de madeira'),
    ('1610203', 2, 15, 'serraria'),
    ('1610204', 2, 15, 'resserragem'),
    ('1610205', 2, 15, 'tratamento de madeira'),
    ('4743100', 2, 15, 'vidraçaria'),
    ('2511000', 2, 15, 'estruturas metálicas'),
    ('2542000', 3,  8, 'serralheria'),
    ('2512800', 3,  8, 'esquadrias de metal'),
    ('2539001', 3,  8, 'usinagem e solda'),
    ('2539002', 3,  8, 'tratamento e polimento de metais'),
    ('2319200', 3,  8, 'artigos de vidro'),
    ('1621800', 3,  8, 'madeira laminada e chapas')
  ),
  -- Códigos tier 1 da curadoria, para o fator de atividade SECUNDÁRIA (v3).
  tier1 AS (
    SELECT array_agg(cnae) AS codigos FROM pesos_cnae WHERE tier = 1
  ),
  muni AS (
    SELECT e.municipio_codigo, count(*)::integer AS n
      FROM public.radar_empresas e
     WHERE e.ja_cliente AND e.municipio_codigo IS NOT NULL
     GROUP BY e.municipio_codigo
  ),
  ufs AS (
    SELECT e.uf, count(*)::integer AS n
      FROM public.radar_empresas e
     WHERE e.ja_cliente AND e.uf IS NOT NULL
     GROUP BY e.uf
  ),
  fatores AS (
    SELECT
      e.cnpj,
      e.score         AS score_atual,
      e.score_motivos AS motivos_atuais,
      e.score_versao  AS versao_formula_atual,
      e.updated_at    AS versao,          -- recruzamento e ingestão bumpam updated_at: é a versão lida
      e.ja_cliente    AS ja_cliente_lido,
      CASE
        WHEN v_vigente IS NULL          THEN 'sem lote vigente'
        WHEN e.ja_cliente               THEN 'já é cliente'
        WHEN e.ultimo_lote < v_vigente  THEN 'fora da foto vigente'
        WHEN e.ultimo_lote > v_vigente  THEN 'lote em ingestão'   -- chunk de lote `running` (Codex ALTO 1)
      END AS nulo_motivo,
      -- CNAE
      COALESCE(pc.pontos, 0) AS p_cnae,
      CASE pc.tier
        WHEN 1 THEN 'CNAE prioritário (' || pc.rotulo || ')'
        WHEN 2 THEN 'CNAE intermediário (' || pc.rotulo || ')'
        WHEN 3 THEN 'CNAE de apoio (' || pc.rotulo || ')'
      END AS m_cnae,
      -- atividade secundária prioritária (v3): principal tier 2/3 com algum secundário tier 1. Só soma.
      CASE WHEN e.cnaes_secundarios && t1.codigos THEN CASE pc.tier WHEN 2 THEN 10 WHEN 3 THEN 7 ELSE 0 END ELSE 0 END AS p_cnae_sec,
      CASE WHEN pc.tier IN (2, 3) AND e.cnaes_secundarios && t1.codigos THEN
        'atividade secundária prioritária (' ||
        (SELECT p2.rotulo FROM unnest(e.cnaes_secundarios) AS s(c) JOIN pesos_cnae p2 ON p2.cnae = s.c AND p2.tier = 1
          ORDER BY p2.cnae LIMIT 1) || ')'
      END AS m_cnae_sec,
      -- porte
      CASE e.porte WHEN '05' THEN 10 WHEN '03' THEN 8 WHEN '01' THEN 3 ELSE 0 END AS p_porte,
      CASE e.porte WHEN '05' THEN 'porte demais (médio/grande)' WHEN '03' THEN 'porte EPP' WHEN '01' THEN 'porte ME' END AS m_porte,
      -- capital social (NULL = sem ponto e sem motivo)
      CASE
        WHEN e.capital_social >= 1000000 THEN 15
        WHEN e.capital_social >=  500000 THEN 12
        WHEN e.capital_social >=  100000 THEN 10
        WHEN e.capital_social >=   50000 THEN 6
        WHEN e.capital_social >=   10000 THEN 3
        ELSE 0
      END AS p_capital,
      CASE
        WHEN e.capital_social >= 1000000 THEN 'capital ≥ R$ 1 mi'
        WHEN e.capital_social >=  500000 THEN 'capital R$ 500 mil–1 mi'
        WHEN e.capital_social >=  100000 THEN 'capital R$ 100–500 mil'
        WHEN e.capital_social >=   50000 THEN 'capital R$ 50–100 mil'
        WHEN e.capital_social >=   10000 THEN 'capital R$ 10–50 mil'
      END AS m_capital,
      -- idade na referência do lote (anos completos); o motivo cita a referência (Codex BAIXO 6)
      CASE
        WHEN e.data_abertura IS NULL OR v_ref IS NULL THEN 0
        WHEN e.data_abertura > v_ref - interval '1 year'   THEN 4
        WHEN e.data_abertura > v_ref - interval '3 years'  THEN 6
        WHEN e.data_abertura > v_ref - interval '10 years' THEN 10
        ELSE 8
      END AS p_idade,
      CASE
        WHEN e.data_abertura IS NULL OR v_ref IS NULL THEN NULL
        WHEN e.data_abertura > v_ref - interval '1 year'   THEN 'empresa com menos de 1 ano (ref. ' || v_vigente || ')'
        WHEN e.data_abertura > v_ref - interval '3 years'  THEN 'empresa com 1–3 anos (ref. ' || v_vigente || ')'
        WHEN e.data_abertura > v_ref - interval '10 years' THEN 'empresa com 3–10 anos (ref. ' || v_vigente || ')'
        ELSE 'empresa com 10+ anos (ref. ' || v_vigente || ')'
      END AS m_idade,
      -- proximidade comercial
      CASE
        WHEN m.n >= 30 THEN 20
        WHEN m.n >= 10 THEN 15
        WHEN m.n >=  3 THEN 10
        WHEN m.n >=  1 THEN 6
        WHEN u.n >= 100 THEN 5
        ELSE 0
      END AS p_prox,
      CASE
        WHEN m.n >= 1   THEN 'município com ' || m.n || ' cliente' || CASE WHEN m.n > 1 THEN 's' ELSE '' END
        WHEN u.n >= 100 THEN 'UF com ' || u.n || ' clientes'
      END AS m_prox,
      -- contato
      CASE WHEN e.telefone1 IS NOT NULL OR e.telefone2 IS NOT NULL THEN 7 ELSE 0 END AS p_tel,
      CASE WHEN e.telefone1 IS NOT NULL OR e.telefone2 IS NOT NULL THEN 'telefone disponível' END AS m_tel,
      CASE WHEN e.email IS NOT NULL THEN 3 ELSE 0 END AS p_email,
      CASE WHEN e.email IS NOT NULL THEN 'e-mail disponível' END AS m_email,
      -- inédito no lote vigente
      CASE WHEN v_vigente_inicio IS NOT NULL AND e.primeira_vista_em >= v_vigente_inicio THEN 10 ELSE 0 END AS p_inedito,
      CASE WHEN v_vigente_inicio IS NOT NULL AND e.primeira_vista_em >= v_vigente_inicio THEN 'inédito no lote ' || v_vigente END AS m_inedito
    FROM public.radar_empresas e
    CROSS JOIN tier1 t1
    LEFT JOIN pesos_cnae pc ON pc.cnae = e.cnae_principal
    LEFT JOIN muni m ON m.municipio_codigo = e.municipio_codigo
    LEFT JOIN ufs  u ON u.uf = e.uf
  ),
  calc AS (
    SELECT
      f.cnpj, f.score_atual, f.motivos_atuais, f.versao_formula_atual, f.versao, f.ja_cliente_lido,
      CASE WHEN f.nulo_motivo IS NOT NULL THEN NULL
           ELSE (f.p_cnae + f.p_cnae_sec + f.p_porte + f.p_capital + f.p_idade + f.p_prox + f.p_tel + f.p_email + f.p_inedito)::smallint
      END AS score_novo,
      CASE WHEN f.nulo_motivo IS NOT NULL THEN ARRAY[f.nulo_motivo]
           ELSE array_remove(ARRAY[f.m_cnae, f.m_cnae_sec, f.m_porte, f.m_capital, f.m_idade, f.m_prox, f.m_tel, f.m_email, f.m_inedito], NULL)
      END AS motivos_novos,
      -- Sem score não há fórmula aplicada: a versão acompanha o NULL (ausente, nunca 'v3' sobre nota inexistente).
      CASE WHEN f.nulo_motivo IS NOT NULL THEN NULL ELSE c_versao END AS versao_formula_nova
    FROM fatores f
  ),
  upd AS (
    UPDATE public.radar_empresas e
       SET score = c.score_novo,
           score_motivos = c.motivos_novos,
           score_versao = c.versao_formula_nova,
           score_em = v_ini
      FROM calc c
     WHERE c.cnpj = e.cnpj
       AND (c.score_novo, c.motivos_novos, c.versao_formula_nova) IS DISTINCT FROM (c.score_atual, c.motivos_atuais, c.versao_formula_atual)
       -- Guarda de VERSÃO (Codex ALTO 2): se a linha mudou depois do snapshot (EvalPlanQual reavalia só a
       -- linha-alvo), não grava score velho — pula e deixa para a próxima rodada.
       AND e.updated_at IS NOT DISTINCT FROM c.versao
       AND e.ja_cliente = c.ja_cliente_lido
    RETURNING e.cnpj
  )
  SELECT jsonb_build_object(
           'lote_vigente', v_vigente,
           'versao_formula', c_versao,
           'recalculou', true,
           'avaliados', count(*),
           'a_alterar', count(*) FILTER (WHERE (c.score_novo, c.motivos_novos, c.versao_formula_nova) IS DISTINCT FROM (c.score_atual, c.motivos_atuais, c.versao_formula_atual)),
           'alterados', (SELECT count(*) FROM upd),
           'pulados', count(*) FILTER (WHERE (c.score_novo, c.motivos_novos, c.versao_formula_nova) IS DISTINCT FROM (c.score_atual, c.motivos_atuais, c.versao_formula_atual)) - (SELECT count(*) FROM upd),
           'com_score', count(c.score_novo),
           'sem_score', jsonb_build_object(
             'ja_cliente',       count(*) FILTER (WHERE c.score_novo IS NULL AND c.motivos_novos = ARRAY['já é cliente']),
             'fora_da_foto',     count(*) FILTER (WHERE c.score_novo IS NULL AND c.motivos_novos = ARRAY['fora da foto vigente']),
             'lote_em_ingestao', count(*) FILTER (WHERE c.score_novo IS NULL AND c.motivos_novos = ARRAY['lote em ingestão']),
             'sem_lote',         count(*) FILTER (WHERE c.score_novo IS NULL AND c.motivos_novos = ARRAY['sem lote vigente'])),
           'faixas', jsonb_build_object(
             '0-19',   count(*) FILTER (WHERE c.score_novo BETWEEN  0 AND 19),
             '20-39',  count(*) FILTER (WHERE c.score_novo BETWEEN 20 AND 39),
             '40-59',  count(*) FILTER (WHERE c.score_novo BETWEEN 40 AND 59),
             '60-79',  count(*) FILTER (WHERE c.score_novo BETWEEN 60 AND 79),
             '80-100', count(*) FILTER (WHERE c.score_novo BETWEEN 80 AND 100)),
           'duracao_ms', round(extract(epoch FROM clock_timestamp() - v_ini) * 1000)::integer)
    INTO v_resumo
    FROM calc c;

  -- Grava a impressão digital SÓ com rodada limpa: linha pulada pela guarda de versão (mudou depois do
  -- snapshot) apaga o estado, e a próxima rodada recalcula.
  IF (v_resumo->>'pulados')::bigint = 0 THEN
    INSERT INTO public.radar_score_estado AS t
           (id, lote, lote_iniciado_em, versao_formula, max_updated_at, ja_cliente_n, calculado_em)
    VALUES (1, v_vigente, v_vigente_inicio, c_versao, v_fp_upd, v_fp_jc, v_ini)
    ON CONFLICT (id) DO UPDATE
       SET lote = EXCLUDED.lote, lote_iniciado_em = EXCLUDED.lote_iniciado_em,
           versao_formula = EXCLUDED.versao_formula, max_updated_at = EXCLUDED.max_updated_at,
           ja_cliente_n = EXCLUDED.ja_cliente_n, calculado_em = EXCLUDED.calculado_em;
  ELSE
    DELETE FROM public.radar_score_estado WHERE id = 1;
  END IF;

  -- Registro ao FINAL, atômico com o trabalho; fail-open: observabilidade nunca derruba o recálculo.
  BEGIN
    INSERT INTO public.acoes_execucoes
      (acao, origem, iniciado_em, finalizado_em, status, detalhes)
    VALUES
      ('radar.score_recalcular', 'automatica', v_ini, clock_timestamp(), 'sucesso', v_resumo);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN v_resumo;
END;
$function$;

CREATE OR REPLACE FUNCTION public.radar_avisar_lote(p_agora timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_espera      constant interval := interval '15 minutes';
  c_espera_sit  constant interval := interval '30 hours';  -- ≥ 1 retentativa do job das 06:05 depois do fechamento
  c_top         constant integer  := 10;
  c_score_alvo  constant smallint := 70;
  c_tela        constant text     := 'https://steu.lovable.app/radar';
  c_fmt         constant text     := 'FM999,999,999';
  v_ini         timestamptz := clock_timestamp();
  r             record;
  v_lotes       jsonb := '[]'::jsonb;
  v_janela_fim  timestamptz;
  v_ineditos_foto bigint;
  v_ineditos    bigint;
  v_ineditos_fila bigint;
  v_lote_ant    text;
  v_total_ant   integer;
  v_sairam      bigint;
  v_verificados bigint;
  v_baixas      bigint;
  v_score_lote  text;
  v_score_estado text;
  v_p_alvo      bigint;
  v_sem_score   bigint;
  v_top         text;
  v_linha_score text;
  v_linha_sairam text;
  v_linha_baixas text;
  v_sit_aplicada boolean;
  v_linha_situacao text;
  v_titulo      text;
  v_corpo       text;
  v_alerta_id   bigint;
  v_marcados    integer;
  v_detalhe     jsonb;
BEGIN
  -- Publicação em passos em andamento (20261111120000): os rótulos físicos misturam a foto velha e a nova
  -- — as contagens do aviso ("saíram do dump") leem rótulos; avisa depois da virada.
  IF public.radar_lote_publicando() IS NOT NULL THEN
    RETURN jsonb_build_object('avisados', 0, 'adiado', 'publicacao_em_andamento',
                              'lote_em_publicacao', public.radar_lote_publicando());
  END IF;
  IF p_agora IS NULL THEN
    RAISE EXCEPTION 'radar_avisar_lote: p_agora não pode ser NULL' USING ERRCODE = '22023';
  END IF;

  FOR r IN
    SELECT mes_referencia, total_recebido, novos, iniciado_em, finalizado_em, situacao_aplicada_fechamento
      FROM public.radar_ingest_state
     WHERE status = 'complete'
       AND avisado_em IS NULL
       AND finalizado_em IS NOT NULL
       AND finalizado_em <= p_agora - c_espera
       -- Situação do lote aplicada pelo job (20261027010000) — ou 30 h sem ela: o aviso sai dizendo isso.
       AND (situacao_aplicada_fechamento = finalizado_em OR finalizado_em <= p_agora - c_espera_sit)
     ORDER BY mes_referencia
     FOR UPDATE SKIP LOCKED
  LOOP
    -- Janela do lote: [iniciado_em deste, iniciado_em do lote seguinte) — independe de ultimo_lote.
    SELECT min(iniciado_em) INTO v_janela_fim
      FROM public.radar_ingest_state WHERE mes_referencia > r.mes_referencia;
    v_janela_fim := COALESCE(v_janela_fim, 'infinity'::timestamptz);

    -- Inéditos: N persistido no finalize; a foto atual dá a fila (quem ainda está para contatar).
    SELECT count(*),
           count(*) FILTER (WHERE NOT ja_cliente AND prospeccao_status NOT IN ('descartado', 'virou_cliente'))
      INTO v_ineditos_foto, v_ineditos_fila
      FROM public.radar_empresas
     WHERE primeira_vista_em >= r.iniciado_em AND primeira_vista_em < v_janela_fim;
    v_ineditos := COALESCE(r.novos, v_ineditos_foto);

    -- Saíram do dump: vigentes EXATAMENTE no lote anterior, ausentes neste, ainda na base (não descartadas).
    SELECT mes_referencia, total_recebido INTO v_lote_ant, v_total_ant
      FROM public.radar_ingest_state
     WHERE status = 'complete' AND mes_referencia < r.mes_referencia
     ORDER BY mes_referencia DESC LIMIT 1;
    IF v_lote_ant IS NULL THEN
      v_sairam := NULL;
      v_linha_sairam := '• Saíram do dump: sem lote anterior para comparar.';
    ELSE
      SELECT count(*) INTO v_sairam
        FROM public.radar_empresas
       WHERE ultimo_lote = v_lote_ant
         AND prospeccao_status NOT IN ('descartado', 'virou_cliente');
      v_linha_sairam := '• Saíram do dump: ' || replace(to_char(v_sairam, c_fmt), ',', '.')
        || ' de ' || replace(to_char(v_total_ant, c_fmt), ',', '.')
        || ' empresas do lote anterior (' || v_lote_ant || ') não vieram em ' || r.mes_referencia
        || ' e seguem na base sem descarte (baixas/inaptas são descartadas pela situação cadastral RFB).';
    END IF;

    -- Clientes com baixa: foto RFB DESTE lote × universo de clientes (radar ∪ documentos de cliente).
    WITH clientes AS MATERIALIZED (
      SELECT d.doc AS cnpj FROM public.radar_docs_clientes() d
      UNION
      SELECT re.cnpj FROM public.radar_empresas re WHERE re.ja_cliente
    )
    SELECT count(*), count(*) FILTER (WHERE s.situacao IN ('03', '04', '08'))
      INTO v_verificados, v_baixas
      FROM clientes c
      JOIN public.radar_situacao_cadastral s ON s.cnpj = c.cnpj AND s.lote = r.mes_referencia;
    IF v_verificados = 0 THEN
      v_linha_baixas := '• Clientes com baixa/inaptidão/suspensão: nenhum cliente com situação cadastral verificada neste lote.';
    ELSE
      v_linha_baixas := '• Clientes com baixa/inaptidão/suspensão: ' || replace(to_char(v_baixas, c_fmt), ',', '.')
        || ' de ' || replace(to_char(v_verificados, c_fmt), ',', '.')
        || ' clientes verificados neste lote → ' || c_tela;
    END IF;

    v_sit_aplicada := r.situacao_aplicada_fechamento IS NOT DISTINCT FROM r.finalizado_em;
    IF v_sit_aplicada THEN
      v_linha_situacao := '';
    ELSE
      v_linha_situacao := E'\n' || '• ATENÇÃO: a situação cadastral RFB deste lote NÃO foi aplicada (job radar-aplicar-situacao-diario sem sucesso há mais de 30 h)'
        || ' — leads baixados/inaptos seguem na fila e clientes irregulares não foram avisados. Recuperação: docs/historico/radar-finalize-timeout-2026-09.md.';
    END IF;

    -- Score: a ÚLTIMA rodada automática do score diz qual foto avaliou (detalhes.lote_vigente).
    SELECT e.detalhes->>'lote_vigente' INTO v_score_lote
      FROM public.acoes_execucoes e
     WHERE e.acao = 'radar.score_recalcular' AND e.origem = 'automatica' AND e.status = 'sucesso'
     ORDER BY e.finalizado_em DESC NULLS LAST, e.iniciado_em DESC
     LIMIT 1;
    IF v_score_lote = r.mes_referencia THEN
      v_score_estado := 'calculado';
      SELECT count(*) FILTER (WHERE score >= c_score_alvo), count(*) FILTER (WHERE score IS NULL)
        INTO v_p_alvo, v_sem_score
        FROM public.radar_empresas
       WHERE primeira_vista_em >= r.iniciado_em AND primeira_vista_em < v_janela_fim;
      v_linha_score := '• Score ≥ ' || c_score_alvo || ': ' || replace(to_char(v_p_alvo, c_fmt), ',', '.')
        || ' de ' || replace(to_char(v_ineditos_foto, c_fmt), ',', '.') || ' inéditos'
        || CASE WHEN v_sem_score > 0 THEN ' (' || v_sem_score || ' sem score)' ELSE '' END || '.';
      SELECT string_agg(
               lpad(t.pos::text, 2, ' ') || '. ' || COALESCE(NULLIF(btrim(t.razao_social), ''), 'razão social não informada')
               || ' (' || COALESCE(NULLIF(btrim(t.municipio_nome), ''), '?') || '/' || COALESCE(t.uf, '??') || ') — score '
               || t.score || ' — ' || COALESCE(array_to_string(t.score_motivos[1:2], '; '), 'sem motivos'),
               E'\n' ORDER BY t.pos)
        INTO v_top
        FROM (SELECT row_number() OVER (ORDER BY score DESC, cnpj) AS pos,
                     razao_social, municipio_nome, uf, score, score_motivos
                FROM public.radar_empresas
               WHERE primeira_vista_em >= r.iniciado_em AND primeira_vista_em < v_janela_fim
                 AND NOT ja_cliente AND prospeccao_status NOT IN ('descartado', 'virou_cliente')
                 AND score IS NOT NULL
               ORDER BY score DESC, cnpj
               LIMIT c_top) t;
      v_top := E'\nTop ' || c_top || ' inéditos por score:' || E'\n' || COALESCE(v_top, '(nenhum inédito com score)');
    ELSIF v_score_lote > r.mes_referencia THEN
      v_score_estado := 'indisponivel';
      v_p_alvo := NULL; v_sem_score := NULL;
      v_linha_score := '• Score: indisponível para este lote — o score já reflete o lote ' || v_score_lote || '; o ranking atual está na tela.';
      v_top := '';
    ELSE
      v_score_estado := 'pendente';
      v_p_alvo := NULL; v_sem_score := NULL;
      v_linha_score := '• Score: pendente — o recálculo diário (radar_score_recalcular) ainda não avaliou este lote; o ranking vem na tela quando rodar.';
      v_top := '';
    END IF;

    v_titulo := '[Radar] lote ' || r.mes_referencia || ': ' || replace(to_char(v_ineditos, c_fmt), ',', '.')
      || ' inéditos de ' || replace(to_char(r.total_recebido, c_fmt), ',', '.');
    v_corpo :=
      'Lote ' || r.mes_referencia || ' do Radar de Clientes fechado em '
      || to_char(r.finalizado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') || ' (BRT).' || E'\n\n'
      || '• Inéditos: ' || replace(to_char(v_ineditos, c_fmt), ',', '.') || ' de '
      || replace(to_char(r.total_recebido, c_fmt), ',', '.') || ' empresas recebidas ('
      || replace(to_char(v_ineditos_fila, c_fmt), ',', '.') || ' na fila de prospecção hoje).' || E'\n'
      || v_linha_sairam || E'\n'
      || v_linha_baixas || v_linha_situacao || E'\n'
      || v_linha_score || E'\n'
      || v_top || E'\n\n'
      || 'Fila completa (inéditos primeiro): ' || c_tela || E'\n'
      || 'Fonte: dados abertos de CNPJ da RFB, dump ' || r.mes_referencia || '. Este aviso é único por lote.';

    INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status, metadata)
    VALUES ('oben', 'outro', CASE WHEN v_sit_aplicada THEN 'info' ELSE 'atencao' END, v_titulo, v_corpo, 'pendente_notificacao',
            jsonb_build_object('origem', 'radar_avisar_lote', 'lote', r.mes_referencia,
                               'ineditos', v_ineditos, 'ineditos_foto', v_ineditos_foto, 'ineditos_fila', v_ineditos_fila,
                               'total', r.total_recebido,
                               'sairam', v_sairam, 'total_anterior', v_total_ant, 'lote_anterior', v_lote_ant,
                               'clientes_baixa', v_baixas, 'clientes_verificados', v_verificados,
                               'score', v_score_estado, 'score_lote', v_score_lote,
                               'score_alvo', v_p_alvo, 'sem_score', v_sem_score,
                               'situacao_aplicada', v_sit_aplicada))
    RETURNING id INTO v_alerta_id;
    IF v_alerta_id IS NULL THEN
      RAISE EXCEPTION 'radar_avisar_lote: fornecedor_alerta não materializou o aviso do lote %', r.mes_referencia
        USING ERRCODE = '25000';
    END IF;

    UPDATE public.radar_ingest_state
       SET avisado_em = p_agora
     WHERE mes_referencia = r.mes_referencia AND avisado_em IS NULL;
    GET DIAGNOSTICS v_marcados = ROW_COUNT;
    IF v_marcados <> 1 THEN
      RAISE EXCEPTION 'radar_avisar_lote: avisado_em marcou % linha(s) para o lote % (esperado 1)', v_marcados, r.mes_referencia
        USING ERRCODE = '25000';
    END IF;

    v_detalhe := jsonb_build_object(
      'lote', r.mes_referencia, 'alerta_id', v_alerta_id,
      'ineditos', v_ineditos, 'ineditos_foto', v_ineditos_foto, 'ineditos_fila', v_ineditos_fila,
      'total', r.total_recebido,
      'sairam', v_sairam, 'lote_anterior', v_lote_ant, 'total_anterior', v_total_ant,
      'clientes_baixa', v_baixas, 'clientes_verificados', v_verificados,
      'score', v_score_estado, 'score_lote', v_score_lote, 'score_alvo', v_p_alvo, 'sem_score', v_sem_score,
      'situacao_aplicada', v_sit_aplicada);
    v_lotes := v_lotes || v_detalhe;
  END LOOP;

  IF jsonb_array_length(v_lotes) > 0 THEN
    INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
    VALUES ('radar.avisar_lote', 'automatica', v_ini, clock_timestamp(), 'sucesso',
            jsonb_build_object('lotes', v_lotes, 'avisados', jsonb_array_length(v_lotes)));
  END IF;

  RETURN jsonb_build_object('avisados', jsonb_array_length(v_lotes), 'lotes', v_lotes);
END;
$function$;

CREATE OR REPLACE FUNCTION public.radar_coorte_sortear(p_tamanho integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_lote    text;
  v_sorteio text;
  v_agora   timestamptz := clock_timestamp();
  v_sem_ver integer;
  v_topo    integer;
  v_amostra integer;
BEGIN
  IF p_tamanho IS NULL OR p_tamanho < 1 OR p_tamanho > 500 THEN
    RAISE EXCEPTION 'tamanho da amostra fora de 1..500: %', p_tamanho USING ERRCODE = '22023';
  END IF;
  SELECT s.mes_referencia INTO v_lote
    FROM public.radar_ingest_state s
   WHERE s.status = 'complete'
   ORDER BY s.mes_referencia DESC
   LIMIT 1;
  IF v_lote IS NULL THEN
    RAISE EXCEPTION 'sem lote vigente: não há foto para sortear' USING ERRCODE = '55000';
  END IF;
  v_sorteio := 'coorte-' || v_lote;
  -- Serializa ANTES de olhar se existe: duas primeiras chamadas simultâneas não materializam conjuntos diferentes.
  PERFORM pg_advisory_xact_lock(hashtextextended('radar_coorte:' || v_sorteio, 0));
  -- Publicação em passos em andamento (20261111120000): os rótulos físicos misturam a foto velha e a nova
  -- — sorteio registrado não muda depois: não sorteia sobre a foto em troca.
  IF public.radar_lote_publicando() IS NOT NULL THEN
    RAISE EXCEPTION 'RCOORTE_PUBLICACAO_EM_ANDAMENTO: o lote % está sendo publicado; sorteie depois da virada',
      public.radar_lote_publicando() USING ERRCODE = '55000';
  END IF;

  IF EXISTS (SELECT 1 FROM public.radar_coorte_controle WHERE sorteio = v_sorteio) THEN
    -- Registrado é registrado: re-chamar não re-sorteia (a fila muda; a coorte não pode mudar junto).
    RETURN (SELECT jsonb_build_object('sorteio', v_sorteio, 'novo', false,
                                      'topo', count(*) FILTER (WHERE grupo = 'topo'),
                                      'amostra', count(*) FILTER (WHERE grupo = 'amostra'))
              FROM public.radar_coorte_controle WHERE sorteio = v_sorteio);
  END IF;

  -- Universo comum aos dois grupos: lead da foto vigente, a contatar, com telefone, em município onde já há
  -- cliente (a área que o time trabalha). O corte 70 é LIMIAR_SUGERIDO de src/lib/radar/sugeridos.ts.
  CREATE TEMP TABLE _radar_universo ON COMMIT DROP AS
    SELECT e.cnpj, e.score, e.score_versao
      FROM public.radar_empresas e
     WHERE e.ultimo_lote = v_lote
       AND NOT e.ja_cliente
       AND e.prospeccao_status = 'a_contatar'
       AND e.score >= 40
       AND (e.telefone1 IS NOT NULL OR e.telefone2 IS NOT NULL)
       AND e.municipio_codigo IN (SELECT c.municipio_codigo FROM public.radar_empresas c
                                   WHERE c.ja_cliente AND c.municipio_codigo IS NOT NULL);

  -- A nota sem versão não pode ser congelada (a 1ª rodada do cron depois da 20261029150000 é que a grava).
  SELECT count(*)::integer INTO v_sem_ver FROM _radar_universo WHERE score_versao IS NULL;
  IF v_sem_ver > 0 THEN
    RAISE EXCEPTION 'score sem versão em % leads elegíveis — espere a rodada do cron que grava score_versao', v_sem_ver
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.radar_coorte_controle (sorteio, grupo, cnpj, lote, posicao, score_no_sorteio, score_versao, sorteada_em)
  SELECT v_sorteio, 'topo', u.cnpj, v_lote, row_number() OVER (ORDER BY u.score DESC, u.cnpj), u.score, u.score_versao, v_agora
    FROM _radar_universo u
   WHERE u.score >= 70;
  GET DIAGNOSTICS v_topo = ROW_COUNT;

  INSERT INTO public.radar_coorte_controle (sorteio, grupo, cnpj, lote, posicao, score_no_sorteio, score_versao, sorteada_em)
  SELECT v_sorteio, 'amostra', s.cnpj, v_lote, row_number() OVER (ORDER BY s.chave, s.cnpj), s.score, s.score_versao, v_agora
    FROM (SELECT u.cnpj, u.score, u.score_versao, md5(v_sorteio || ':' || u.cnpj) AS chave
            FROM _radar_universo u
           WHERE u.score BETWEEN 40 AND 69
           ORDER BY md5(v_sorteio || ':' || u.cnpj), u.cnpj
           LIMIT p_tamanho) s;
  GET DIAGNOSTICS v_amostra = ROW_COUNT;

  IF v_topo = 0 OR v_amostra = 0 THEN
    -- Coorte vazia não compara nada: aborta tudo em vez de registrar meio sorteio.
    RAISE EXCEPTION 'coorte vazia (topo %, amostra %): nada registrado', v_topo, v_amostra USING ERRCODE = '55000';
  END IF;

  BEGIN
    INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
    VALUES ('radar.coorte_sortear', CASE WHEN auth.uid() IS NULL THEN 'automatica' ELSE 'manual' END,
            v_agora, clock_timestamp(), 'sucesso',
            jsonb_build_object('sorteio', v_sorteio, 'topo', v_topo, 'amostra', v_amostra, 'pedido', p_tamanho,
                               'regra', 'a_contatar · telefone · município com cliente · topo >= 70 (todos) · amostra 40-69 por md5(sorteio:cnpj)'));
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- observabilidade nunca derruba o sorteio; o registro de verdade é radar_coorte_controle
  END;

  RETURN jsonb_build_object('sorteio', v_sorteio, 'novo', true, 'topo', v_topo, 'amostra', v_amostra);
END
$function$;

-- 8) Postcondição -------------------------------------------------------------------------------------
DO $post$
DECLARE
  f   text;
  v_md5 text;
  -- md5(prosrc) de cada corpo, calculado pelo banco a partir dos bytes DESTE arquivo (PG17 local):
  -- 1 byte fora (transcrição) aborta tudo.
  c_corpos CONSTANT text[][] := ARRAY[
    ARRAY['public.radar_carga_iniciar(text)', '9df1991252c249b3b09b8d866f09f706'],
    ARRAY['public.radar_lote_publicando()', '9c541c8c517d1b9d2b8c8aa89a6e3d78'],
    ARRAY['public.radar_carga_publicar_passo(integer)', '3ac182511586437c423f40514b4fa2f7'],
    ARRAY['public.radar_carga_publicar(interval)', 'd79f5fa74443ba2b966ec18c70b83d49'],
    ARRAY['public.radar_carga_publicar_pendente()', 'b78114585c3fbc89745a7aa690b8bc97'],
    ARRAY['public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamp with time zone,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean,boolean)', '829e547135cecdd67d7af0c9c777a99f'],
    ARRAY['public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone,text[],boolean,text,boolean)', 'f79e5a814b622248b8d2845ef27edb65'],
    ARRAY['public.radar_agregado_recalcular(boolean,timestamp with time zone)', '689efa9f14564f1c8643ebb04b158241'],
    ARRAY['public.radar_score_recalcular()', '49c21fef6ab031b2ffe0d0367f86560e'],
    ARRAY['public.radar_avisar_lote(timestamp with time zone)', '8e3f436f6832712d460c1dfa1aef8939'],
    ARRAY['public.radar_coorte_sortear(integer)', 'a16c2010ee9ea80cc584620bf7ac0c1e']];
  i int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'radar_empresas' AND column_name = 'lote_anterior') THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_empresas.lote_anterior ausente';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'radar_ingest_state'
         AND column_name IN ('carga_publicacao_iniciada_em', 'carga_cursor', 'carga_examinadas', 'carga_gravadas',
                             'carga_tentativas', 'carga_varrida_em', 'carga_recruzada_em')) <> 7 THEN
    RAISE EXCEPTION 'P2 FALHOU: colunas de progresso da publicação incompletas';
  END IF;
  FOR i IN 1 .. array_length(c_corpos, 1) LOOP
    IF to_regprocedure(c_corpos[i][1]) IS NULL THEN
      RAISE EXCEPTION 'P3 FALHOU: % ausente', c_corpos[i][1];
    END IF;
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(c_corpos[i][1]);
    IF v_md5 IS DISTINCT FROM c_corpos[i][2] THEN
      RAISE EXCEPTION 'P3 FALHOU: corpo de % diverge do arquivo (md5 % ≠ %)', c_corpos[i][1], v_md5, c_corpos[i][2];
    END IF;
  END LOOP;
  -- A procedure só COMITA sem SECURITY DEFINER e sem SET; o passo e o leitor de P são DEFINER.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.radar_carga_publicar(interval)'::regprocedure
                    AND prokind = 'p' AND NOT prosecdef AND proconfig IS NULL) THEN
    RAISE EXCEPTION 'P4 FALHOU: radar_carga_publicar não é procedure INVOKER sem SET — o COMMIT entre passos falharia';
  END IF;
  IF NOT (SELECT prosecdef AND provolatile = 's' FROM pg_proc WHERE oid = 'public.radar_lote_publicando()'::regprocedure)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.radar_carga_publicar_passo(integer)'::regprocedure) THEN
    RAISE EXCEPTION 'P4 FALHOU: radar_lote_publicando (STABLE DEFINER) ou radar_carga_publicar_passo (DEFINER) com atributos errados';
  END IF;
  FOREACH f IN ARRAY ARRAY['public.radar_carga_publicar_passo(integer)', 'public.radar_carga_publicar(interval)',
                           'public.radar_carga_publicar_pendente()'] LOOP
    IF has_function_privilege('anon', to_regprocedure(f), 'EXECUTE')
       OR has_function_privilege('authenticated', to_regprocedure(f), 'EXECUTE')
       OR has_function_privilege('service_role', to_regprocedure(f), 'EXECUTE') THEN
      RAISE EXCEPTION 'P5 FALHOU: % executável fora do owner (o cron)', f;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.radar_lote_publicando()'::regprocedure, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.radar_lote_publicando()'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'P5 FALHOU: radar_lote_publicando com ACL errada (authenticated sim, anon não)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'radar-publicar-lote' AND schedule = '*/15 0-5,7-23 * * *'
                    AND username = 'postgres' AND database = current_database()
                    AND command = 'CALL public.radar_carga_publicar()') THEN
    RAISE EXCEPTION 'P6 FALHOU: cron radar-publicar-lote sem o comando CALL único (SET; CALL quebra o COMMIT), fora da janela ou de outro dono';
  END IF;
  RAISE NOTICE 'radar publicação curta OK: lote_anterior, passo/procedure, 6 leitores, cron CALL (active inalterado)';
END
$post$;

