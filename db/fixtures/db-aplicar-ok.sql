-- Fixture do db/test-db-aplicar.sh — migration que DEVE aplicar limpa.
-- Vive commitada de propósito: o guard de `db:aplicar` exige arquivo versionado e limpo,
-- e a prova não deve furar o próprio guard que ela verifica.
CREATE TABLE IF NOT EXISTS public.fixture_aplicar_ok (id int PRIMARY KEY, marca text NOT NULL);
INSERT INTO public.fixture_aplicar_ok (id, marca) VALUES (1, 'aplicou') ON CONFLICT DO NOTHING;
