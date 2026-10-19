-- ============================================================================================
-- Radar de Clientes: CNPJ ALFANUMÉRICO (RFB emite desde jul/2026 — 12 posições [0-9A-Z] + 2 DVs)
-- ============================================================================================
-- Antes, tudo assumia ^[0-9]{14}$: o CHECK de radar_empresas.cnpj descartaria em silêncio toda
-- empresa nova do dump mensal, e um cliente com CNPJ alfanumérico nunca viraria ja_cliente.
-- Medido em prod em 2026-10-19 (psql-ro): 0 documentos com letra em profiles (5.668),
-- omie_clientes_nao_vinculados (10.164) e radar_empresas (526.176) — mudança preventiva, sem acervo.
--
-- O que faz (idempotente; envelope BEGIN/COMMIT porque o caminho é SQL Editor/MCP — os objetos
-- são do `postgres`, fora do alcance do `db:aplicar`):
--   1) CHECK radar_empresas_cnpj_check → '^[0-9A-Z]{12}[0-9]{2}$' (recriado só se a definição divergir);
--   2) CHECK radar_contatos_cnpj_check (novo; antes só a FK guardava o formato);
--   3) radar_recruzar_ja_cliente(): o documento do cliente passa por DUAS normalizações —
--      a antiga (só dígitos: acervo numérico intocado, prefixo/sufixo com letra segue casando) e a
--      nova (upper + remove só separadores de máscara — nunca apaga letra, pra anotação não virar
--      chave por acaso). DV não é conferido aqui: a igualdade com um cnpj do radar (DV validado no
--      ingest) já basta.
--   Molde TRAVA → PRE → CREATE → PÓS (sql-house-style "Recriar objeto VIVO"); REVOKE nomeando roles.
-- Prova PG17: db/test-radar-cnpj-alfanumerico.sh (com --falsificar).
-- Diário: docs/historico/radar-cnpj-alfanumerico.md
-- ============================================================================================
BEGIN;

-- TRAVA: ALTER sem efeito na função que a PRE guarda e este arquivo recria (volatilidade VIVA = v).
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_recruzar_ja_cliente()') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: radar_recruzar_ja_cliente() ausente — aplique 20260610200000_radar_fundacao antes';
  END IF;
  ALTER FUNCTION public.radar_recruzar_ja_cliente() VOLATILE;
END
$trava$;

-- PRE: md5(prosrc) vivo ∈ {predecessor revisado em prod 2026-10-19, este arquivo}. Outro corpo ABORTA.
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.radar_recruzar_ja_cliente()'));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('27ccab8ed049e4403a9e4232507915a4', '9163372cc465397c22fc4c655c97c46c') THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_recruzar_ja_cliente() vivo (md5 %) não é o predecessor revisado nem este', v_vivo;
  END IF;
END
$pre$;

-- 1) + 2) CHECKs — recria só quando a definição viva diverge (re-colar é no-op)
DO $chk$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_catalog.pg_constraint
   WHERE conrelid = 'public.radar_empresas'::regclass AND conname = 'radar_empresas_cnpj_check';
  IF v_def IS DISTINCT FROM 'CHECK ((cnpj ~ ''^[0-9A-Z]{12}[0-9]{2}$''::text))' THEN
    ALTER TABLE public.radar_empresas DROP CONSTRAINT IF EXISTS radar_empresas_cnpj_check;
    ALTER TABLE public.radar_empresas ADD CONSTRAINT radar_empresas_cnpj_check
      CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$');
  END IF;

  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_catalog.pg_constraint
   WHERE conrelid = 'public.radar_contatos'::regclass AND conname = 'radar_contatos_cnpj_check';
  IF v_def IS DISTINCT FROM 'CHECK ((cnpj ~ ''^[0-9A-Z]{12}[0-9]{2}$''::text))' THEN
    ALTER TABLE public.radar_contatos DROP CONSTRAINT IF EXISTS radar_contatos_cnpj_check;
    ALTER TABLE public.radar_contatos ADD CONSTRAINT radar_contatos_cnpj_check
      CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$');
  END IF;
END
$chk$;

-- 3) Recruza "já é cliente": profiles.document ∪ omie_clientes_nao_vinculados.cnpj_cpf
--    (⚠️ omie_clientes NÃO tem documento — só códigos). Chamada pelo cron diário e pelo finalize da edge.
CREATE OR REPLACE FUNCTION public.radar_recruzar_ja_cliente()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_marcados integer;
BEGIN
  DROP TABLE IF EXISTS tmp_docs_clientes;
  -- Duas normalizações por documento (humano digita com máscara, prefixo, minúscula):
  --   num:   só dígitos → o acervo numérico, exatamente como antes (prefixo/sufixo com letra segue casando);
  --   alnum: btrim + upper + remove SÓ os separadores da máscara (. - /). Não apaga letra nenhuma e
  --          espaço INTERNO não é separador: "aeg 123.456.789-09" (CPF com anotação) NÃO vira a chave
  --          AEG12345678909 por acaso (contraexemplo do Codex; precisão > recall).
  --   Os dois passam pelo formato RFB jul/2026 (12 alfanuméricos + 2 DVs numéricos = 14 posições).
  CREATE TEMP TABLE tmp_docs_clientes ON COMMIT DROP AS
    WITH brutos AS (
      SELECT document AS bruto FROM public.profiles WHERE document IS NOT NULL
      UNION ALL
      SELECT cnpj_cpf FROM public.omie_clientes_nao_vinculados WHERE cnpj_cpf IS NOT NULL
    ),
    candidatos AS (
      SELECT regexp_replace(bruto, '[^0-9]', '', 'g') AS doc FROM brutos
      UNION ALL
      SELECT regexp_replace(btrim(upper(bruto)), '[-./]', '', 'g') FROM brutos
    )
    SELECT DISTINCT doc
    FROM candidatos
    WHERE doc ~ '^[0-9A-Z]{12}[0-9]{2}$';

  UPDATE public.radar_empresas re
  SET ja_cliente = true, updated_at = now()
  WHERE re.ja_cliente = false
    AND EXISTS (SELECT 1 FROM tmp_docs_clientes d WHERE d.doc = re.cnpj);

  GET DIAGNOSTICS v_marcados = ROW_COUNT;
  RETURN v_marcados;
END;
$$;

-- trava a função: só service_role (edge com service client + cron). REPLACE preserva o ACL,
-- mas o REVOKE é reemitido nomeando as roles (regra da casa: DROP+CREATE o resetaria) e o GRANT
-- ao executor legítimo fica explícito (em prod já vinha do default privilege; aqui é intenção).
REVOKE ALL ON FUNCTION public.radar_recruzar_ja_cliente() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_recruzar_ja_cliente() TO service_role;

-- PÓS: o estado vivo é ESTE — CHECKs validados, corpo deste arquivo, ACL fechado.
DO $post$
DECLARE
  v_md5 text;
  v_def text;
  v_ok boolean;
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('radar_empresas', 'radar_empresas_cnpj_check'),
                                 ('radar_contatos', 'radar_contatos_cnpj_check')) AS t(tab, con) LOOP
    SELECT pg_get_constraintdef(c.oid), c.convalidated INTO v_def, v_ok
      FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = ('public.' || r.tab)::regclass AND c.conname = r.con;
    IF v_def IS DISTINCT FROM 'CHECK ((cnpj ~ ''^[0-9A-Z]{12}[0-9]{2}$''::text))' THEN
      RAISE EXCEPTION 'POS FALHOU: %.% não tem o CHECK alfanumérico (def=%)', r.tab, r.con, v_def;
    END IF;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'POS FALHOU: %.% existe mas NÃO está validada (NOT VALID)', r.tab, r.con;
    END IF;
  END LOOP;

  SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.radar_recruzar_ja_cliente()');
  IF v_md5 IS DISTINCT FROM '9163372cc465397c22fc4c655c97c46c' THEN
    RAISE EXCEPTION 'POS FALHOU: radar_recruzar_ja_cliente() vivo (md5 %) não é o corpo deste arquivo', v_md5;
  END IF;

  IF has_function_privilege('anon', 'public.radar_recruzar_ja_cliente()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.radar_recruzar_ja_cliente()', 'EXECUTE')
     OR has_function_privilege('public', 'public.radar_recruzar_ja_cliente()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: radar_recruzar_ja_cliente() executável por anon/authenticated/PUBLIC';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.radar_recruzar_ja_cliente()', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: service_role (edge + cron) perdeu EXECUTE em radar_recruzar_ja_cliente()';
  END IF;
  RAISE NOTICE 'RADAR CNPJ ALFANUMERICO OK';
END
$post$;

COMMIT;
