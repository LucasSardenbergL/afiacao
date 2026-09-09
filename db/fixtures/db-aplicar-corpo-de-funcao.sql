-- Fixture do db/test-db-aplicar.sh — o CONTROLE dos dois guards de moldura. DEVE APLICAR.
--
-- Prova, num arquivo só, que os guards não são recusa cega:
--   1. `BEGIN` (sem ponto-e-vírgula) e `END;` em COLUNA 0 dentro de $$ NÃO são moldura de
--      transação — é o fecho de bloco PL/pgSQL, e recusá-lo reprovaria 81 arquivos do repo;
--   2. `REFRESH MATERIALIZED VIEW CONCURRENTLY` NÃO é o `CREATE INDEX CONCURRENTLY` — ele roda
--      normalmente, e 10 migrations do repo o usam exatamente assim, dentro de função.
--
-- A matview citada não existe de propósito: PL/pgSQL é late-bound, então `CREATE FUNCTION`
-- passa. O que se prova aqui é o guard TEXTUAL, não o corpo da função.
CREATE TABLE IF NOT EXISTS public.fixture_aplicar_corpo (id int PRIMARY KEY, marca text NOT NULL);

CREATE OR REPLACE FUNCTION public.fixture_corpo_refresca()
RETURNS void LANGUAGE plpgsql AS $funcao$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.fixture_matview_inexistente;
END;
$funcao$;

INSERT INTO public.fixture_aplicar_corpo (id, marca) VALUES (1, 'controle-verde')
  ON CONFLICT DO NOTHING;
