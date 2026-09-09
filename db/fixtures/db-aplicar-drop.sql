-- Fixture do teste de fumaça de `db:aplicar` — desfaz a fixture `db-aplicar-ok.sql`.
-- Sem CASCADE de propósito: se algo tiver passado a depender da tabela, o DROP DEVE falhar
-- e o recibo deve fechar como `falhou` — não queremos arrastar dependente nenhum.
DROP TABLE public.fixture_aplicar_ok;
