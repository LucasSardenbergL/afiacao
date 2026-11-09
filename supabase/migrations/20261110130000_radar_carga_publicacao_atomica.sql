-- =============================================================================
-- Radar: carga mensal publica a FOTO de uma vez (staging + troca atômica do lote vigente)
-- =============================================================================
-- Problema (2ª revisão do Radar, Fable + Codex; follow-up do bloco 1, PR #3169): o `chunk` da edge
-- radar-ingest fazia upsert DIRETO em radar_empresas com `ultimo_lote = <mês novo>`. A fila, os KPIs, o
-- card e o e-mail leem `ultimo_lote = <lote vigente>` (= maior mes_referencia `complete`), então durante
-- os ~10 min de POSTs cada chunk TIRAVA ~1.000 empresas da foto vigente — e uma carga que morresse no meio
-- (lote `error`) deixava a fila com a foto vigente pela metade até a próxima carga completa. O re-run
-- `--forcar` de um lote já `complete` ainda rebaixava o lote para `running` no begin (vigente = mês anterior,
-- cujas linhas já tinham ultimo_lote = o mês re-rodado ⇒ fila quase vazia).
--
-- Desenho (o que entra; idempotente; envelope BEGIN/COMMIT para SQL Editor/MCP; postcondição DO $post$):
--   1. `radar_empresas_carga` — staging (lote, cnpj, campos cadastrais). Os chunks gravam AQUI; a tabela
--      viva não é tocada até a publicação. RLS ligada, sem policy, fechada a PUBLIC/anon/authenticated/
--      service_role: só as RPCs (SECURITY DEFINER) leem e escrevem.
--   2. `radar_ingest_state.carga_*` — fase da carga, SEPARADA do `status` que os leitores usam:
--      recebendo → validada → publicada (ou falhou). `status = 'complete'` passa a ter UM escritor: a
--      publicação. Um re-run de lote `complete` mantém o `complete` (a foto vigente segue no ar) enquanto
--      a carga nova enche o staging.
--   3. RPCs da carga (service_role, serializadas pelo advisory `radar_carga`):
--      radar_carga_iniciar → radar_carga_receber (chunks) → radar_carga_validar (finalize: contagem do
--      staging = o que a carga declarou ter entregue, e sem queda > 15% contra a foto vigente) ·
--      radar_carga_falhar (catch da edge: só uma carga `recebendo` vira `falhou`).
--   4. `radar_carga_publicar_pendente()` — entrypoint do JOB (owner/cron, sem service_role: pelo PostgREST
--      cairia nos 8s do authenticator, como em 20261027010000). Numa transação: upsert do staging em
--      radar_empresas, postcondição de contagem, recruzar ja_cliente, `complete` + finalizado_em, TRUNCATE
--      do staging, ledger `radar.publicar_lote`. Erro → nada da foto muda e o lote fica `falhou` com o
--      motivo; lock/deadlock → fica `validada` e o próximo tick tenta de novo.
--   5. cron `radar-publicar-lote` a cada 15 min, FORA da hora 06 UTC (06:05 situação · 06:15 recruzar ·
--      06:30 score · 06:45 aviso · 06:50 contábil regravam/ler radar_empresas em massa).
--
-- Consequência aceita: o lote vira vigente até ~15 min DEPOIS do finalize (o tempo do próximo tick), e a
-- publicação segura locks de linha de radar_empresas por alguns minutos (o mesmo upsert que antes se
-- espalhava pelos 10 min de chunks, agora numa transação) — manhã de segunda, como a carga.
-- Ordem de deploy: ESTA migration → edge radar-ingest v1.7 (a v1.6 segue funcionando sem ela; a v1.7 sem
-- ela falha no begin_lote, sem tocar a fila).
--
-- Prova PG17: db/test-radar-carga-atomica.sh (nucleo-ci.txt, --falsificar).
-- Diário: docs/historico/radar-carga-publicacao-atomica.md
-- =============================================================================
BEGIN;

-- 1) Staging ------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.radar_empresas_carga (
  lote              text NOT NULL CHECK (lote ~ '^[0-9]{4}-[0-9]{2}$'),
  cnpj              text NOT NULL CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  razao_social      text,
  nome_fantasia     text,
  cnae_principal    text NOT NULL CHECK (cnae_principal ~ '^[0-9]{7}$'),
  cnae_descricao    text,
  cnaes_secundarios text[] NOT NULL DEFAULT '{}',
  data_abertura     date,
  porte             text,
  capital_social    numeric,
  logradouro        text,
  numero            text,
  complemento       text,
  bairro            text,
  municipio_codigo  text,
  municipio_nome    text,
  uf                text,
  cep               text,
  telefone1         text,
  telefone2         text,
  email             text,
  socios_nomes      text,
  recebido_em       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lote, cnpj)
);
ALTER TABLE public.radar_empresas_carga ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.radar_empresas_carga FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.radar_empresas_carga IS
  'Staging da carga mensal do Radar: os chunks da edge radar-ingest gravam aqui (radar_carga_receber) e a foto só chega a radar_empresas na publicação atômica (radar_carga_publicar_pendente). Esvaziada no início e no fim de cada carga.';

-- 2) Fase da carga (separada do status que os leitores usam) -------------------------------------------
ALTER TABLE public.radar_ingest_state ADD COLUMN IF NOT EXISTS carga_fase text;
ALTER TABLE public.radar_ingest_state ADD COLUMN IF NOT EXISTS carga_esperado integer;
ALTER TABLE public.radar_ingest_state ADD COLUMN IF NOT EXISTS carga_erro text;
ALTER TABLE public.radar_ingest_state ADD COLUMN IF NOT EXISTS carga_iniciada_em timestamptz;
ALTER TABLE public.radar_ingest_state ADD COLUMN IF NOT EXISTS carga_validada_em timestamptz;
ALTER TABLE public.radar_ingest_state ADD COLUMN IF NOT EXISTS carga_publicada_em timestamptz;
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.radar_ingest_state'::regclass AND conname = 'radar_ingest_state_carga_fase_check') THEN
    ALTER TABLE public.radar_ingest_state ADD CONSTRAINT radar_ingest_state_carga_fase_check
      CHECK (carga_fase IS NULL OR carga_fase IN ('recebendo', 'validada', 'publicada', 'falhou'));
  END IF;
END
$chk$;
COMMENT ON COLUMN public.radar_ingest_state.carga_fase IS
  'Fase da carga (staging): recebendo → validada → publicada, ou falhou. NULL = lote anterior à publicação atômica. O status complete (o que os leitores usam) só é escrito pela publicação.';

-- 3) RPCs da carga (service_role) ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.radar_carga_iniciar(p_lote text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
           carga_iniciada_em = now(), carga_validada_em = NULL
     WHERE mes_referencia = p_lote;
  END IF;
  RETURN jsonb_build_object('lote', p_lote, 'retomado', v_antes IS NOT NULL,
                            'vigente_preservado', v_antes IS NOT DISTINCT FROM 'complete');
END;
$$;

CREATE OR REPLACE FUNCTION public.radar_carga_receber(p_lote text, p_linhas jsonb)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_fase text;
  v_n    integer;
BEGIN
  IF p_lote IS NULL OR p_lote !~ '^[0-9]{4}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'RCARGA_LOTE_INVALIDO' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_linhas) IS DISTINCT FROM 'array' OR jsonb_array_length(p_linhas) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'RCARGA_LINHAS_INVALIDAS (1..1000)' USING ERRCODE = '22023';
  END IF;
  -- FOR SHARE: chunks concorrem entre si; a validação (FOR UPDATE) espera os chunks em voo e, depois
  -- dela, nenhum chunk entra — o corte do que foi contado é limpo.
  SELECT carga_fase INTO v_fase FROM public.radar_ingest_state WHERE mes_referencia = p_lote FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RCARGA_LOTE_NAO_INICIADO' USING ERRCODE = '55000'; END IF;
  IF v_fase IS DISTINCT FROM 'recebendo' THEN
    RAISE EXCEPTION 'RCARGA_LOTE_FECHADO: fase %', coalesce(v_fase, 'nula') USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.radar_empresas_carga AS c (
    lote, cnpj, razao_social, nome_fantasia, cnae_principal, cnae_descricao, cnaes_secundarios, data_abertura,
    porte, capital_social, logradouro, numero, complemento, bairro, municipio_codigo, municipio_nome, uf, cep,
    telefone1, telefone2, email, socios_nomes)
  SELECT p_lote, x.cnpj, x.razao_social, x.nome_fantasia, x.cnae_principal, x.cnae_descricao,
         coalesce(x.cnaes_secundarios, '{}'), x.data_abertura, x.porte, x.capital_social, x.logradouro, x.numero,
         x.complemento, x.bairro, x.municipio_codigo, x.municipio_nome, x.uf, x.cep, x.telefone1, x.telefone2,
         x.email, x.socios_nomes
    FROM jsonb_to_recordset(p_linhas) AS x(
      cnpj text, razao_social text, nome_fantasia text, cnae_principal text, cnae_descricao text,
      cnaes_secundarios text[], data_abertura date, porte text, capital_social numeric, logradouro text,
      numero text, complemento text, bairro text, municipio_codigo text, municipio_nome text, uf text, cep text,
      telefone1 text, telefone2 text, email text, socios_nomes text)
  ON CONFLICT (lote, cnpj) DO UPDATE SET
    razao_social = EXCLUDED.razao_social, nome_fantasia = EXCLUDED.nome_fantasia,
    cnae_principal = EXCLUDED.cnae_principal, cnae_descricao = EXCLUDED.cnae_descricao,
    cnaes_secundarios = EXCLUDED.cnaes_secundarios, data_abertura = EXCLUDED.data_abertura,
    porte = EXCLUDED.porte, capital_social = EXCLUDED.capital_social, logradouro = EXCLUDED.logradouro,
    numero = EXCLUDED.numero, complemento = EXCLUDED.complemento, bairro = EXCLUDED.bairro,
    municipio_codigo = EXCLUDED.municipio_codigo, municipio_nome = EXCLUDED.municipio_nome, uf = EXCLUDED.uf,
    cep = EXCLUDED.cep, telefone1 = EXCLUDED.telefone1, telefone2 = EXCLUDED.telefone2, email = EXCLUDED.email,
    socios_nomes = EXCLUDED.socios_nomes, recebido_em = now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.radar_carga_validar(p_lote text, p_esperado integer, p_aceitar_queda boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r       record;
  v_n     integer;
  v_ref   integer;
  v_mot   text;
BEGIN
  IF p_lote IS NULL OR p_lote !~ '^[0-9]{4}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'RCARGA_LOTE_INVALIDO' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('radar_carga'));
  SELECT * INTO r FROM public.radar_ingest_state WHERE mes_referencia = p_lote FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RCARGA_LOTE_NAO_INICIADO' USING ERRCODE = '55000'; END IF;

  -- Replay do finalize (a carga re-tenta POST com resposta perdida): devolve o veredito já gravado.
  IF r.carga_fase = 'validada' AND r.carga_esperado IS NOT DISTINCT FROM p_esperado THEN
    RETURN jsonb_build_object('ok', true, 'recebidas', r.carga_esperado, 'publicacao', 'cron', 'replay', true);
  END IF;
  IF r.carga_fase = 'falhou' THEN
    RETURN jsonb_build_object('ok', false, 'motivo', r.carga_erro, 'replay', true);
  END IF;
  IF r.carga_fase IS DISTINCT FROM 'recebendo' THEN
    RAISE EXCEPTION 'RCARGA_FASE_INVALIDA: %', coalesce(r.carga_fase, 'nula') USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_n FROM public.radar_empresas_carga WHERE lote = p_lote;
  SELECT s.total_recebido INTO v_ref FROM public.radar_ingest_state s
   WHERE s.status = 'complete' ORDER BY s.mes_referencia DESC LIMIT 1;

  v_mot := CASE
    WHEN p_esperado IS NULL OR p_esperado <= 0
      THEN 'RCARGA_SEM_ESPERADO: a carga não declarou quantas linhas entregou'
    WHEN v_n <> p_esperado
      THEN format('RCARGA_CONTAGEM_DIVERGE: staging tem %s linhas, a carga declarou %s', v_n, p_esperado)
    WHEN v_ref > 0 AND v_n < v_ref * 0.85 AND NOT coalesce(p_aceitar_queda, false)
      THEN format('RCARGA_QUEDA: %s linhas contra %s da foto vigente (queda > 15%%) — aceitar_queda para publicar assim mesmo', v_n, v_ref)
  END;

  IF v_mot IS NOT NULL THEN
    UPDATE public.radar_ingest_state
       SET carga_fase = 'falhou', carga_erro = v_mot,
           status = CASE WHEN status = 'complete' THEN 'complete' ELSE 'error' END,
           erro   = CASE WHEN status = 'complete' THEN erro ELSE v_mot END
     WHERE mes_referencia = p_lote;
    RETURN jsonb_build_object('ok', false, 'motivo', v_mot, 'recebidas', v_n, 'esperado', p_esperado);
  END IF;

  UPDATE public.radar_ingest_state
     SET carga_fase = 'validada', carga_esperado = v_n, carga_validada_em = now(), carga_erro = NULL
   WHERE mes_referencia = p_lote;
  RETURN jsonb_build_object('ok', true, 'recebidas', v_n, 'publicacao', 'cron');
END;
$$;

CREATE OR REPLACE FUNCTION public.radar_carga_falhar(p_lote text, p_erro text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  -- Só uma carga RECEBENDO vira falhou: lote validado/publicado/legado não é rebaixado por erro de outra ação,
  -- e um lote complete continua complete (a foto vigente não cai por uma carga que morreu).
  UPDATE public.radar_ingest_state
     SET carga_fase = 'falhou', carga_erro = left(coalesce(p_erro, 'erro sem mensagem'), 500),
         status = CASE WHEN status = 'complete' THEN 'complete' ELSE 'error' END,
         erro   = CASE WHEN status = 'complete' THEN erro ELSE left(coalesce(p_erro, 'erro sem mensagem'), 500) END
   WHERE mes_referencia = p_lote AND carga_fase = 'recebendo';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END;
$$;

-- 4) Publicação atômica (JOB) --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.radar_carga_publicar_pendente()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ini      timestamptz := clock_timestamp();
  r          record;
  v_vig      text;
  v_staging  integer;
  v_n        integer;
  v_total    integer;
  v_novos    integer;
  v_marcados integer;
  v_estado   text;
  v_msg      text;
  v_res      jsonb;
BEGIN
  -- Serializa com iniciar/validar; ocupado = outra ponta da carga em voo → o próximo tick tenta.
  IF NOT pg_try_advisory_xact_lock(hashtext('radar_carga')) THEN
    RETURN jsonb_build_object('publicado', NULL, 'ocupado', true);
  END IF;
  SELECT * INTO r FROM public.radar_ingest_state WHERE carga_fase = 'validada'
   ORDER BY mes_referencia LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('publicado', NULL);
  END IF;

  BEGIN
    SELECT max(mes_referencia) INTO v_vig FROM public.radar_ingest_state WHERE status = 'complete';
    IF v_vig IS NOT NULL AND r.mes_referencia < v_vig THEN
      RAISE EXCEPTION 'RCARGA_REGRIDE: % é mais antigo que o vigente %', r.mes_referencia, v_vig;
    END IF;
    SELECT count(*) INTO v_staging FROM public.radar_empresas_carga WHERE lote = r.mes_referencia;
    IF v_staging IS DISTINCT FROM r.carga_esperado THEN
      RAISE EXCEPTION 'RCARGA_STAGING_DIVERGE: staging tem % linhas, a validação contou %', v_staging, r.carga_esperado;
    END IF;

    -- Lock de linha de vendedor em edição: espera até 2 min; passou disso, 55P03 → adiado (fica validada).
    PERFORM set_config('lock_timeout', '2min', true);
    -- Payload SÓ cadastral + ultimo_lote: primeira_vista_em / prospeccao_* / ja_cliente / score / geo /
    -- situação RFB ficam como estão (preservação por omissão, como no upsert antigo da edge).
    INSERT INTO public.radar_empresas AS e (
      cnpj, razao_social, nome_fantasia, cnae_principal, cnae_descricao, cnaes_secundarios, data_abertura, porte,
      capital_social, logradouro, numero, complemento, bairro, municipio_codigo, municipio_nome, uf, cep,
      telefone1, telefone2, email, socios_nomes, ultimo_lote, updated_at)
    SELECT c.cnpj, c.razao_social, c.nome_fantasia, c.cnae_principal, c.cnae_descricao, c.cnaes_secundarios,
           c.data_abertura, c.porte, c.capital_social, c.logradouro, c.numero, c.complemento, c.bairro,
           c.municipio_codigo, c.municipio_nome, c.uf, c.cep, c.telefone1, c.telefone2, c.email, c.socios_nomes,
           c.lote, clock_timestamp()
      FROM public.radar_empresas_carga c
     WHERE c.lote = r.mes_referencia
    ON CONFLICT (cnpj) DO UPDATE SET
      razao_social = EXCLUDED.razao_social, nome_fantasia = EXCLUDED.nome_fantasia,
      cnae_principal = EXCLUDED.cnae_principal, cnae_descricao = EXCLUDED.cnae_descricao,
      cnaes_secundarios = EXCLUDED.cnaes_secundarios, data_abertura = EXCLUDED.data_abertura,
      porte = EXCLUDED.porte, capital_social = EXCLUDED.capital_social, logradouro = EXCLUDED.logradouro,
      numero = EXCLUDED.numero, complemento = EXCLUDED.complemento, bairro = EXCLUDED.bairro,
      municipio_codigo = EXCLUDED.municipio_codigo, municipio_nome = EXCLUDED.municipio_nome, uf = EXCLUDED.uf,
      cep = EXCLUDED.cep, telefone1 = EXCLUDED.telefone1, telefone2 = EXCLUDED.telefone2, email = EXCLUDED.email,
      socios_nomes = EXCLUDED.socios_nomes, ultimo_lote = EXCLUDED.ultimo_lote, updated_at = EXCLUDED.updated_at;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n IS DISTINCT FROM r.carga_esperado THEN
      RAISE EXCEPTION 'RCARGA_PUBLICOU_DIVERGE: gravou % linhas, esperava %', v_n, r.carga_esperado;
    END IF;
    -- ≥ e não =: no re-run de um lote complete, quem estava na carga anterior e saiu desta segue com o rótulo.
    SELECT count(*) INTO v_total FROM public.radar_empresas WHERE ultimo_lote = r.mes_referencia;
    IF v_total < r.carga_esperado THEN
      RAISE EXCEPTION 'RCARGA_FOTO_INCOMPLETA: % empresas com ultimo_lote %, esperava ≥ %', v_total, r.mes_referencia, r.carga_esperado;
    END IF;

    -- Empresa nova que já é cliente entra na foto JÁ marcada (antes o finalize recruzava).
    v_marcados := public.radar_recruzar_ja_cliente();
    SELECT count(*) INTO v_novos FROM public.radar_empresas
     WHERE ultimo_lote = r.mes_referencia AND primeira_vista_em >= r.iniciado_em;

    UPDATE public.radar_ingest_state
       SET status = 'complete', total_recebido = r.carga_esperado, novos = v_novos,
           finalizado_em = clock_timestamp(), erro = NULL,
           carga_fase = 'publicada', carga_publicada_em = clock_timestamp(), carga_erro = NULL
     WHERE mes_referencia = r.mes_referencia;
    TRUNCATE public.radar_empresas_carga;

    v_estado := 'publicado';
    v_res := jsonb_build_object('lote', r.mes_referencia, 'total', r.carga_esperado, 'novos', v_novos,
                                'fora_da_carga_com_rotulo', v_total - r.carga_esperado, 'ja_cliente_marcados', v_marcados);
  EXCEPTION
    WHEN lock_not_available OR deadlock_detected THEN
      v_estado := 'adiado';
      v_res := jsonb_build_object('lote', r.mes_referencia, 'adiado', SQLSTATE, 'motivo', left(SQLERRM, 300));
    WHEN OTHERS THEN
      v_estado := 'falhou';
      v_msg := left(SQLSTATE || ': ' || SQLERRM, 500);
      UPDATE public.radar_ingest_state
         SET carga_fase = 'falhou', carga_erro = v_msg,
             status = CASE WHEN status = 'complete' THEN 'complete' ELSE 'error' END,
             erro   = CASE WHEN status = 'complete' THEN erro ELSE v_msg END
       WHERE mes_referencia = r.mes_referencia;
      v_res := jsonb_build_object('lote', r.mes_referencia, 'falhou', v_msg);
  END;

  IF v_estado <> 'adiado' THEN
    INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
    VALUES ('radar.publicar_lote', 'automatica', v_ini, clock_timestamp(),
            CASE WHEN v_estado = 'publicado' THEN 'sucesso' ELSE 'erro' END, v_res);
  END IF;
  RETURN v_res || jsonb_build_object('estado', v_estado);
END;
$$;

COMMENT ON FUNCTION public.radar_carga_publicar_pendente() IS
  'Entrypoint de JOB (cron radar-publicar-lote): publica numa transação o lote validado do staging radar_empresas_carga em radar_empresas, recruza ja_cliente e marca complete. Erro → foto intacta e lote falhou; lock/deadlock → adiado para o próximo tick. Fora do request da edge (8s do PostgREST).';

-- ACL: as 4 da carga só para service_role (a edge); a publicação só para o owner (o cron).
REVOKE ALL ON FUNCTION public.radar_carga_iniciar(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.radar_carga_receber(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.radar_carga_validar(text, integer, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.radar_carga_falhar(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.radar_carga_publicar_pendente() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.radar_carga_iniciar(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.radar_carga_receber(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.radar_carga_validar(text, integer, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.radar_carga_falhar(text, text) TO service_role;

-- 5) Job ----------------------------------------------------------------------------------------------
SELECT cron.schedule(
  'radar-publicar-lote',
  '*/15 0-5,7-23 * * *',
  $$SET statement_timeout = '30min'; SELECT public.radar_carga_publicar_pendente();$$
);

-- 6) Postcondição -------------------------------------------------------------------------------------
DO $post$
DECLARE
  f text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relname = 'radar_empresas_carga' AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_empresas_carga ausente ou sem RLS — o staging ficaria aberto ao JWT';
  END IF;
  IF has_table_privilege('anon', 'public.radar_empresas_carga', 'SELECT')
     OR has_table_privilege('authenticated', 'public.radar_empresas_carga', 'SELECT')
     OR has_table_privilege('authenticated', 'public.radar_empresas_carga', 'INSERT') THEN
    RAISE EXCEPTION 'P2 FALHOU: radar_empresas_carga com privilégio para anon/authenticated';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'radar_ingest_state'
         AND column_name IN ('carga_fase', 'carga_esperado', 'carga_erro', 'carga_iniciada_em',
                             'carga_validada_em', 'carga_publicada_em')) <> 6 THEN
    RAISE EXCEPTION 'P3 FALHOU: colunas carga_* de radar_ingest_state incompletas';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.radar_ingest_state'::regclass
                    AND conname = 'radar_ingest_state_carga_fase_check' AND convalidated) THEN
    RAISE EXCEPTION 'P4 FALHOU: CHECK de carga_fase ausente ou NOT VALID';
  END IF;
  FOREACH f IN ARRAY ARRAY['public.radar_carga_iniciar(text)', 'public.radar_carga_receber(text,jsonb)',
                           'public.radar_carga_validar(text,integer,boolean)', 'public.radar_carga_falhar(text,text)',
                           'public.radar_carga_publicar_pendente()'] LOOP
    IF to_regprocedure(f) IS NULL
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(f)) THEN
      RAISE EXCEPTION 'P5 FALHOU: % ausente ou não SECURITY DEFINER', f;
    END IF;
    IF has_function_privilege('anon', to_regprocedure(f), 'EXECUTE')
       OR has_function_privilege('authenticated', to_regprocedure(f), 'EXECUTE') THEN
      RAISE EXCEPTION 'P6 FALHOU: % executável por anon/authenticated (REVOKE nas duas pontas)', f;
    END IF;
    IF has_function_privilege('service_role', to_regprocedure(f), 'EXECUTE')
       <> (f <> 'public.radar_carga_publicar_pendente()') THEN
      RAISE EXCEPTION 'P7 FALHOU: ACL de service_role errada em % (carga = sim, publicação = só o cron)', f;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'radar-publicar-lote' AND schedule = '*/15 0-5,7-23 * * *' AND active
                    AND username = 'postgres' AND database = current_database()
                    AND command = 'SET statement_timeout = ''30min''; SELECT public.radar_carga_publicar_pendente();') THEN
    RAISE EXCEPTION 'P8 FALHOU: cron radar-publicar-lote ausente, inativo, de outro dono/banco ou com comando diferente — lote validado nunca viraria vigente';
  END IF;
  IF COALESCE(current_setting('cron.timezone', true), '') NOT IN ('', 'GMT', 'UTC') THEN
    RAISE EXCEPTION 'P9 FALHOU: cron.timezone=% — a janela fora da hora 06 UTC deixaria de valer', current_setting('cron.timezone', true);
  END IF;
  RAISE NOTICE 'radar carga atômica OK: staging fechado, 5 RPCs, cron radar-publicar-lote';
END
$post$;

COMMIT;
