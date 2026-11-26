-- Onda D da tela Clientes — fatia 4a-2: o CORTE do snapshot de pedido e dos contatos do cliente.
-- Diário: docs/historico/clientes-onda-d-pii-carteira.md (§Fatia 4).
--
-- 1. sales_orders.customer_document/customer_address/customer_phone: authenticated perde o SELECT de
--    COLUNA (mantém o UPDATE de coluna e o INSERT de tabela — o pedido continua gravando o snapshot).
--    Codex P0 da fatia 3: qualquer employee lia o snapshot de todo pedido sem ledger.
--    Depois disto o snapshot sai só por:
--      · contato_cliente_operacional('pedido', …) — staff, com ledger;
--      · v_pedido_snapshot_proprio (20261126130000) — o cliente, só os próprios pedidos.
-- 2. customer_contacts: REVOKE SELECT de TABELA + GRANT SELECT só das colunas SEM contato (id, dono,
--    flags, carimbos). Leitura de contato só pela v_cliente_contatos (mascarada por carteira, fatia 2).
--    INSERT/DELETE seguem no nível de tabela (as policies de escrita não mudam); o `.select()` pós-escrita
--    do front passa a pedir só `id, customer_user_id`.
--    UPDATE passa a ser de COLUNA, sem `customer_user_id`/`created_by`/`id` (Codex, fatia 4a): a view
--    decide pelo dono ATUAL da linha, então reatribuir um contato de fora da carteira para um cliente
--    dela o exibiria inteiro. O dono do contato fica imutável na edição; o front tira os dois do update.
--
-- PRÉ-REQUISITOS (não aplicar antes):
--   1. 20261126130000 aplicada (a fonte do cliente existe);
--   2. o front da fatia 4a PUBLICADO e com o BUILD_SHA servido = merge (o ramo do cliente já lê a view
--      e o `.select()` dos contatos já não pede coluna de contato). Antes disso: 42501 na tela.
-- Leitor antigo quebra ALTO (42501), não some com linha calada. service_role/postgres não mudam.
-- Aplicação: bun run db:aplicar (o EXECUTOR fornece a transação — este arquivo não leva BEGIN/COMMIT).

-- ───────────────────────── 1. snapshot do pedido ─────────────────────────
REVOKE SELECT (customer_document, customer_address, customer_phone) ON public.sales_orders FROM PUBLIC, anon, authenticated;

-- ───────────────────────── 2. contatos do cliente ─────────────────────────
REVOKE SELECT ON public.customer_contacts FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, customer_user_id, is_decision_maker, is_primary, whatsapp_only, source, created_by, created_at, updated_at
) ON public.customer_contacts TO authenticated;
REVOKE UPDATE ON public.customer_contacts FROM PUBLIC, anon, authenticated;
GRANT UPDATE (
  phone, nome, cargo, email, is_decision_maker, is_primary, whatsapp_only, birthday, notas, source, updated_at
) ON public.customer_contacts TO authenticated;

DO $post$
DECLARE
  r text;
  c text;
  v_aberto text[];
  v_sem_grant text[];
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH c IN ARRAY ARRAY['customer_document', 'customer_address', 'customer_phone'] LOOP
      IF has_column_privilege(r, 'public.sales_orders', c, 'SELECT') THEN
        v_aberto := array_append(v_aberto, r || ':sales_orders.' || c);
      END IF;
    END LOOP;
    FOREACH c IN ARRAY ARRAY['phone', 'email', 'nome', 'cargo', 'birthday', 'notas'] LOOP
      IF has_column_privilege(r, 'public.customer_contacts', c, 'SELECT') THEN
        v_aberto := array_append(v_aberto, r || ':customer_contacts.' || c);
      END IF;
    END LOOP;
  END LOOP;
  IF v_aberto IS NOT NULL THEN
    RAISE EXCEPTION 'B1 FALHOU: contato de cliente segue legivel pela API: %', v_aberto;
  END IF;
  -- o pedido continua GRAVANDO o snapshot (insert do front + update da idempotência)
  IF NOT has_table_privilege('authenticated', 'public.sales_orders', 'INSERT') THEN
    RAISE EXCEPTION 'B2 FALHOU: authenticated perdeu INSERT em sales_orders — o pedido pararia de gravar';
  END IF;
  FOREACH c IN ARRAY ARRAY['customer_document', 'customer_address', 'customer_phone'] LOOP
    IF NOT has_column_privilege('authenticated', 'public.sales_orders', c, 'UPDATE') THEN
      v_sem_grant := array_append(v_sem_grant, 'UPDATE sales_orders.' || c);
    END IF;
  END LOOP;
  IF NOT has_column_privilege('authenticated', 'public.sales_orders', 'id', 'SELECT') THEN
    v_sem_grant := array_append(v_sem_grant, 'SELECT sales_orders.id');
  END IF;
  FOREACH c IN ARRAY ARRAY['id', 'customer_user_id', 'is_decision_maker', 'is_primary', 'whatsapp_only',
                           'source', 'created_by', 'created_at', 'updated_at'] LOOP
    IF NOT has_column_privilege('authenticated', 'public.customer_contacts', c, 'SELECT') THEN
      v_sem_grant := array_append(v_sem_grant, 'SELECT customer_contacts.' || c);
    END IF;
  END LOOP;
  -- verbo a verbo: has_table_privilege com lista responde "algum deles" (PG17)
  IF NOT has_table_privilege('authenticated', 'public.customer_contacts', 'INSERT') THEN
    v_sem_grant := array_append(v_sem_grant, 'INSERT customer_contacts');
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.customer_contacts', 'DELETE') THEN
    v_sem_grant := array_append(v_sem_grant, 'DELETE customer_contacts');
  END IF;
  FOREACH c IN ARRAY ARRAY['phone', 'nome', 'cargo', 'email', 'is_decision_maker', 'is_primary', 'whatsapp_only',
                           'birthday', 'notas', 'source', 'updated_at'] LOOP
    IF NOT has_column_privilege('authenticated', 'public.customer_contacts', c, 'UPDATE') THEN
      v_sem_grant := array_append(v_sem_grant, 'UPDATE customer_contacts.' || c);
    END IF;
  END LOOP;
  IF v_sem_grant IS NOT NULL THEN
    RAISE EXCEPTION 'B3 FALHOU: o corte levou junto o que a tela precisa: %', v_sem_grant;
  END IF;
  FOREACH c IN ARRAY ARRAY['id', 'customer_user_id', 'created_by'] LOOP
    IF has_column_privilege('authenticated', 'public.customer_contacts', c, 'UPDATE') THEN
      RAISE EXCEPTION 'B6 FALHOU: authenticated reatribui customer_contacts.% — mover o contato para a carteira o exibiria inteiro', c;
    END IF;
  END LOOP;
  -- as duas fontes que sobram
  IF to_regclass('public.v_pedido_snapshot_proprio') IS NULL
     OR NOT has_table_privilege('authenticated', 'public.v_pedido_snapshot_proprio', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.v_cliente_contatos', 'SELECT') THEN
    RAISE EXCEPTION 'B4 FALHOU: fonte mascarada ausente (v_pedido_snapshot_proprio / v_cliente_contatos) — aplicar 20261126130000 antes';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.sales_orders', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.customer_contacts', 'SELECT') THEN
    RAISE EXCEPTION 'B5 FALHOU: service_role perdeu leitura (edges)';
  END IF;
  RAISE NOTICE 'fatia 4a-2 ok: snapshot de pedido e contatos do cliente fechados pela API';
END
$post$;
