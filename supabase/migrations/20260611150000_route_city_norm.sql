-- ============================================================================
-- #16-full (fase 1, SHADOW): cidade normalizada PERSISTIDA em
-- customer_visit_scores — pré-requisito do filtro server-side da fila de
-- ligação por rota (/rota/ligacoes), que hoje baixa ~7k linhas e filtra
-- cidade no client (normalizeCityKey/cityKeyEquals).
--
-- Desenho (consult Codex 2026-06-11, gpt-5.5):
--   - city_norm = GENERATED ALWAYS ... STORED: sem trigger, sem backfill
--     (o ALTER calcula as linhas existentes), sem writers a mudar.
--   - A funcao route_city_norm e IMMUTABLE e espelha SO a parte CIDADE do
--     normalizeCityKey TS (src/lib/whatsapp/route-city.ts). A UF continua
--     sendo julgada no CLIENT (cityKeyEquals, semantica assimetrica
--     deliberada: cadastro sem UF casa por cidade) -- o filtro server e um
--     SUPERSET seguro (.in('city_norm', cidades)), nunca exclui por UF.
--   - SEM unaccent(): a extensao e STABLE no PG17, inelegivel pra generated
--     column. O strip de acentos usa normalize(s, NFD) (core, IMMUTABLE) +
--     remocao dos combining marks U+0300..U+036F -- paridade com o TS.
--   - Paridade TS x SQL provada por harness diferencial em PG17
--     (db/test-city-norm-paridade.sh) sobre corpus de cidades reais +
--     adversariais. O corte do full-fetch so apos 7 dias uteis de SHADOW
--     (o frontend roda as 2 queries, EXIBE a legada e loga divergencia).
--
-- ATENCAO Lovable: migration MANUAL -- colar este bloco no SQL Editor + Run.
-- ============================================================================

-- Espelho da parte-cidade de normalizeCityKey (route-city.ts). Ordem IDENTICA:
-- espacos-unicode -> ASCII | NFD + strip combining | UPPER | trim | extrai UF
-- ("(MG)" | "/MG" | ultima palavra de 2 letras) so pra REMOVE-LA | colapsa
-- espacos. Editar AQUI exige editar o TS, re-rodar o harness de paridade e
-- RECOMPUTAR a coluna (DROP COLUMN + ADD COLUMN -- generated nao re-deriva
-- sozinha quando a funcao muda).
-- Os \uXXXX abaixo sao interpretados pelo motor de regex ARE do Postgres
-- (string sem E'' passa o texto cru pro regex) -- deliberadamente NAO usamos
-- os caracteres literais (invisiveis, frageis a editor/copy-paste).
CREATE OR REPLACE FUNCTION public.route_city_norm(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $func$
DECLARE
  s text;
BEGIN
  IF raw IS NULL THEN
    RETURN NULL;
  END IF;
  -- Espacos unicode que o \s do JS reconhece (e o [[:space:]] POSIX nao) ->
  -- espaco ASCII, pra paridade com o split/replace(\s) do TS.
  s := regexp_replace(raw, '[   -     　﻿]', ' ', 'g');
  -- stripAccents (NFD + remove combining marks U+0300..U+036F) -> UPPER ->
  -- trim (ordem identica ao TS).
  s := btrim(upper(regexp_replace(normalize(s, NFD), '[̀-ͯ]', '', 'g')));
  IF s = '' THEN
    RETURN NULL;
  END IF;
  -- Extracao de UF (mesma precedencia do TS) -- descartada: city_norm e so a cidade.
  IF s ~ '\([A-Z]{2}\)\s*$' THEN
    s := btrim(regexp_replace(s, '\([A-Z]{2}\)\s*$', ''));
  ELSIF s ~ '/\s*[A-Z]{2}\s*$' THEN
    s := btrim(regexp_replace(s, '/\s*[A-Z]{2}\s*$', ''));
  ELSIF s ~ '\s[A-Z]{2}$' THEN
    s := btrim(regexp_replace(s, '\s+[A-Z]{2}$', ''));
  END IF;
  s := btrim(regexp_replace(s, '\s+', ' ', 'g'));
  RETURN nullif(s, '');
END
$func$;

-- anon/authenticated nao precisam executar a funcao diretamente (a coluna
-- gerada e computada pelo dono da tabela); revogar reduz superficie.
REVOKE EXECUTE ON FUNCTION public.route_city_norm(text) FROM PUBLIC, anon, authenticated;

ALTER TABLE public.customer_visit_scores
  ADD COLUMN IF NOT EXISTS city_norm text
  GENERATED ALWAYS AS (public.route_city_norm(city)) STORED;

CREATE INDEX IF NOT EXISTS idx_cvs_city_norm
  ON public.customer_visit_scores (city_norm)
  WHERE city_norm IS NOT NULL;

-- Validacao (esperado: func_ok=1 | col_ok=1 | idx_ok=1 | norm_null_com_city=0)
SELECT 'BLOCO A OK' AS status,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'route_city_norm') AS func_ok,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customer_visit_scores'
      AND column_name = 'city_norm') AS col_ok,
  (SELECT count(*) FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_cvs_city_norm') AS idx_ok,
  (SELECT count(*) FROM public.customer_visit_scores
    WHERE city IS NOT NULL AND btrim(city) <> '' AND city_norm IS NULL) AS norm_null_com_city;
