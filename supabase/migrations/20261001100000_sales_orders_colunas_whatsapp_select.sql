-- O canal WhatsApp lê, COMO O STAFF (papel authenticated), duas colunas de sales_orders que nasceram
-- DEPOIS do GRANT por coluna:
--   · get_whatsapp_funil (SECURITY INVOKER) filtra por whatsapp_conversation_id — a seção de funil da
--     supervisão (WhatsappSlaSupervisao → useWhatsappFunil);
--   · a proposta 1-toque relê o orçamento já criado por whatsapp_proposta_dedupe quando o INSERT bate no
--     UNIQUE (src/services/whatsappProposta/enviarProposta.ts, o caminho do 23505).
-- A 20260709163500 trocou o SELECT de TABELA de authenticated por SELECT por COLUNA (para fechar
-- omie_payload/omie_response); a 20260713030000 e a 20260713050000 criaram as duas colunas quatro dias
-- depois, e coluna nova não herda GRANT por coluna. Medido em prod em 2026-09-30:
-- has_column_privilege('authenticated', 'public.sales_orders', <as duas>, 'SELECT') = false, e
-- db/test-whatsapp-funil.sh, com o ACL de prod, reproduz o funil dando "permission denied for table
-- sales_orders" para todo staff. Latente: o canal ainda tinha 0 envios e 0 orçamentos com elo.
--
-- O conserto é o idioma do próprio hardening: as duas colunas entram na lista de SELECT por coluna.
-- omie_payload/omie_response seguem fechadas, e authenticated segue SEM SELECT de tabela (POS2/POS3).
-- Efeito aceito pelo founder (2026-10-01): o cliente com pedidos do canal lê essas duas colunas nas
-- PRÓPRIAS linhas (a RLS sales_orders_select_customer) — a chave da proposta e o uuid da conversa.
-- Idempotente (GRANT repetido é no-op). Sem BEGIN/COMMIT: aplicar com `bun run db:aplicar <este arquivo>`,
-- que fornece a transação. Histórico: docs/historico/provas-canal-revividas.md.

DO $pre$
BEGIN
  IF to_regclass('public.sales_orders') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public.sales_orders ausente';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_attribute
       WHERE attrelid = 'public.sales_orders'::regclass AND attnum > 0 AND NOT attisdropped
         AND attname IN ('whatsapp_conversation_id', 'whatsapp_proposta_dedupe')) <> 2 THEN
    RAISE EXCEPTION 'PRE FALHOU: as colunas do canal nao existem em public.sales_orders';
  END IF;
END
$pre$;

GRANT SELECT (whatsapp_conversation_id, whatsapp_proposta_dedupe) ON public.sales_orders TO authenticated;

DO $pos$
BEGIN
  IF NOT has_column_privilege('authenticated', 'public.sales_orders', 'whatsapp_conversation_id', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.sales_orders', 'whatsapp_proposta_dedupe', 'SELECT') THEN
    RAISE EXCEPTION 'POS1 FALHOU: authenticated segue sem SELECT nas colunas do canal';
  END IF;
  IF has_column_privilege('authenticated', 'public.sales_orders', 'omie_payload', 'SELECT')
     OR has_column_privilege('authenticated', 'public.sales_orders', 'omie_response', 'SELECT') THEN
    RAISE EXCEPTION 'POS2 FALHOU: o hardening abriu - authenticated le omie_payload/omie_response';
  END IF;
  IF has_table_privilege('authenticated', 'public.sales_orders', 'SELECT') THEN
    RAISE EXCEPTION 'POS3 FALHOU: authenticated tem SELECT de TABELA - o hardening e por coluna';
  END IF;
  IF has_column_privilege('anon', 'public.sales_orders', 'whatsapp_conversation_id', 'SELECT') THEN
    RAISE EXCEPTION 'POS4 FALHOU: anon le a coluna do canal';
  END IF;
END
$pos$;
