-- ============================================================================================
-- 20261017120000 · 1ª vista de cada pedido do portal na varredura Sayerlack (carência de 1 rodada)  [money-path]
--
-- O QUE: tabela `sayerlack_varredura_visto` — 1 linha por protocolo do portal que a varredura
-- (edge sayerlack-varrer-pedidos-portal v1.2) achou como candidato a PO, com o instante da 1ª vista.
--
-- POR QUÊ: palavra do founder (2026-10-17), revisão Codex P1: PO lançado À MÃO no Omie só chega ao espelho
-- (`purchase_orders_tracking`) no próximo sync (a cada 2 h; 8 de 21 POs Sayerlack de outubro foram à mão). Importar na
-- 1ª vista criaria o 2º PO. A edge só importa o pedido já visto numa rodada anterior E com sync `complete` do espelho
-- terminado depois da vista. Sem registro de vista a carência nunca venceria — por isso o escritor LANÇA em erro.
--
-- 1 escritor: a edge (service_role), INSERT ... ON CONFLICT DO NOTHING (a 1ª vista nunca muda). Sem UPDATE/DELETE.
--
-- APLICAR: bun run db:aplicar supabase/migrations/<este arquivo> — o executor fornece a transação.
-- Idempotente (IF NOT EXISTS). Postcondição no fim.
-- ============================================================================================

CREATE TABLE IF NOT EXISTS public.sayerlack_varredura_visto (
  protocolo       text PRIMARY KEY CHECK (protocolo ~ '^[0-9]{3,12}$'),
  primeira_vez_em timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.sayerlack_varredura_visto IS
  '1ª vista de cada pedido do portal Sayerlack como candidato na varredura (carência de 1 rodada contra PO lançado à mão no Omie). 1 escritor: edge sayerlack-varrer-pedidos-portal (service_role), só INSERT.';

ALTER TABLE public.sayerlack_varredura_visto ENABLE ROW LEVEL SECURITY;
-- Sem policy: só o service_role (que ignora RLS) lê e escreve. Fecha também o GRANT padrão do Supabase.
REVOKE ALL ON TABLE public.sayerlack_varredura_visto FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.sayerlack_varredura_visto TO service_role;

DO $post$
BEGIN
  IF to_regclass('public.sayerlack_varredura_visto') IS NULL THEN
    RAISE EXCEPTION 'V1 FALHOU: tabela sayerlack_varredura_visto ausente';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sayerlack_varredura_visto'::regclass) THEN
    RAISE EXCEPTION 'V2 FALHOU: RLS desligada em sayerlack_varredura_visto';
  END IF;
  IF has_table_privilege('anon', 'public.sayerlack_varredura_visto', 'SELECT')
     OR has_table_privilege('authenticated', 'public.sayerlack_varredura_visto', 'SELECT') THEN
    RAISE EXCEPTION 'V3 FALHOU: anon/authenticated ainda leem sayerlack_varredura_visto';
  END IF;
  IF has_table_privilege('service_role', 'public.sayerlack_varredura_visto', 'UPDATE') THEN
    RAISE EXCEPTION 'V4 FALHOU: service_role pode UPDATE — a 1ª vista tem de ser imutável';
  END IF;
  RAISE NOTICE 'sayerlack_varredura_visto: tabela com RLS fechada, service_role só SELECT/INSERT';
END
$post$;
