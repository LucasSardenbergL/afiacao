-- Fixture do db/test-db-aplicar.sh — comando que não roda dentro de transação NENHUMA.
-- Este executor DEVE RECUSÁ-LA com o marcador RECUSA_FORA_DE_TRANSACAO: o recibo só é atômico
-- porque há uma transação, e CREATE INDEX CONCURRENTLY a proíbe. Não há conserto no executor —
-- o arquivo tem de ir pelo Caminho A (MCP/SQL Editor).
CREATE TABLE IF NOT EXISTS public.fixture_aplicar_cic (id int PRIMARY KEY, chave text);
CREATE INDEX CONCURRENTLY IF NOT EXISTS fixture_aplicar_cic_chave
  ON public.fixture_aplicar_cic (chave);
