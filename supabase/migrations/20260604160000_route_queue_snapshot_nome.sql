-- Gap acionável: guarda o nome do cliente no snapshot da fila (pra listar quem ficou sem contato).
ALTER TABLE public.route_queue_snapshot ADD COLUMN IF NOT EXISTS cliente_nome text;

SELECT 'route_queue_snapshot.cliente_nome OK' AS status,
       (SELECT count(*) FROM information_schema.columns
        WHERE table_name='route_queue_snapshot' AND column_name='cliente_nome') AS coluna;
