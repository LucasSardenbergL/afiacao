-- ============================================================================================
-- Radar: radar_recruzar_ja_cliente() — caminho alfanumérico só com documento CRU ou MÁSCARA EXATA
-- ============================================================================================
-- Achado MÉDIO do Codex retroativo do PR #3175: a normalização alfanumérica removia `.`, `-` e `/` em
-- qualquer posição, então "aeg-123.456.789-09" (CPF com anotação) virava a chave AEG12345678909 — com DV
-- válido por coincidência — e marcaria um lead como ja_cliente. Agora o caminho alnum só aceita o
-- documento cru (14 posições) ou com a máscara 00.000.000/0000-00 nas posições exatas, e só então
-- remove os separadores. O caminho numérico (só dígitos) segue idêntico: acervo intocado.
-- Envelope BEGIN/COMMIT (SQL Editor/MCP — objeto do `postgres`). Molde TRAVA → PRE → CREATE → PÓS.
-- Prova PG17: db/test-radar-cnpj-alfanumerico.sh (--falsificar, sabotagem sem_mascara_exata).
-- Diário: docs/historico/radar-cnpj-alfanumerico.md
-- ============================================================================================
BEGIN;

DO $trava$
BEGIN
  IF to_regprocedure('public.radar_recruzar_ja_cliente()') IS NULL THEN
    RAISE EXCEPTION 'TRAVA FALHOU: radar_recruzar_ja_cliente() ausente — aplique 20261019110000_radar_cnpj_alfanumerico antes';
  END IF;
  ALTER FUNCTION public.radar_recruzar_ja_cliente() VOLATILE;
END
$trava$;

-- PRE: md5(prosrc) vivo ∈ {predecessor (20261019110000, aplicado em prod 2026-10-19), este arquivo}.
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.radar_recruzar_ja_cliente()'));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('9163372cc465397c22fc4c655c97c46c', '3bb62946f182f9a8ed30aa8061512303') THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_recruzar_ja_cliente() vivo (md5 %) não é o predecessor revisado nem este', v_vivo;
  END IF;
END
$pre$;

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
  --   alnum: btrim + upper, e SÓ para documento CRU (14 posições) ou com a MÁSCARA nas posições exatas
  --          (00.000.000/0000-00); aí remove os separadores. Não apaga letra e não aceita separador fora
  --          do lugar: "aeg 123.456.789-09" e "aeg-123.456.789-09" (CPF com anotação) NÃO viram a chave
  --          AEG12345678909 por acaso (Codex, desenho + retroativo do PR #3175; precisão > recall).
  --   Os dois passam pelo formato RFB jul/2026 (12 alfanuméricos + 2 DVs numéricos = 14 posições).
  CREATE TEMP TABLE tmp_docs_clientes ON COMMIT DROP AS
    WITH brutos AS (
      SELECT document AS bruto FROM public.profiles WHERE document IS NOT NULL
      UNION ALL
      SELECT cnpj_cpf FROM public.omie_clientes_nao_vinculados WHERE cnpj_cpf IS NOT NULL
    ),
    alnum AS (
      SELECT regexp_replace(d, '[-./]', '', 'g') AS doc
      FROM (SELECT btrim(upper(bruto)) AS d FROM brutos) x
      WHERE d ~ '^[0-9A-Z]{12}[0-9]{2}$'
         OR d ~ '^[0-9A-Z]{2}[.][0-9A-Z]{3}[.][0-9A-Z]{3}/[0-9A-Z]{4}-[0-9]{2}$'
    ),
    candidatos AS (
      SELECT regexp_replace(bruto, '[^0-9]', '', 'g') AS doc FROM brutos
      UNION ALL
      SELECT doc FROM alnum
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

REVOKE ALL ON FUNCTION public.radar_recruzar_ja_cliente() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_recruzar_ja_cliente() TO service_role;

DO $post$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.radar_recruzar_ja_cliente()');
  IF v_md5 IS DISTINCT FROM '3bb62946f182f9a8ed30aa8061512303' THEN
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
  RAISE NOTICE 'RADAR RECRUZAR MASCARA EXATA OK';
END
$post$;

COMMIT;
