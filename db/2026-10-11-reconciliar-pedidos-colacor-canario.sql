-- Reconciliação de pedidos da COLACOR — CANÁRIO (janela de 7 dias)
--
-- O QUE: 1 POST para a edge sync-reprocess com {"action":"reprocess_orders","account":"colacor",
-- "window_days":7}. Executa o comando GRAVADO do cron `sync-reprocess-operational` (Oben) com o body
-- trocado — mesmo secret do vault, mesmos headers, mesmo timeout. Sem escrita direta em tabela.
--
-- POR QUE: o status dos pedidos da Colacor está congelado desde jun/2026 (criar_pedidos_com_itens é
-- ON CONFLICT DO NOTHING; o reconciliador só roda para a Oben — crons com account 'oben' fixo).
-- Diário: docs/historico/status-pedidos-colacor-congelado.md. Decisão do founder: 2026-10-11.
--
-- POR QUE CANÁRIO: a rodada não tem aborto global (página confirmada fica; timeout não cancela —
-- Codex, 2026-10-11). Primeiro 7 dias (~30 pedidos), conferidos pedido a pedido contra o snapshot;
-- só então a janela longa (db/2026-10-11-reconciliar-pedidos-colacor-backlog.sql).
--
-- PRÉ-VOO (psql-ro, 2026-10-11 10:10): edge sync-reprocess v1.18 no ar (sonda); RPC
-- reconciliar_pedidos_omie viva md5 4b16bbb469c7b4dc6f688df58e191d72 = db/deriva-corpo-baseline.json;
-- cota colacor/ListarPedidos livre; snapshot de 19.834 pedidos + 46.775 itens da Colacor salvo.
-- Sensor: (colacor, manual, orders) já catalogado e dispensado em sync_reprocess_saude.
--
-- Aplicação: `bun run db:aplicar <este arquivo>` (o executor dá a transação — SEM BEGIN/COMMIT).
-- Validação pós (psql-ro): linha nova em sync_reprocess_log (colacor/manual/orders), net._http_response.
do $run$
declare
  v_cmd   text;
  v_novo  text;
  v_antes bigint;
begin
  select command into v_cmd from cron.job where jobname = 'sync-reprocess-operational';
  v_novo := replace(v_cmd,
    '''{"action": "reprocess_operational", "account": "oben"}''::jsonb',
    '''{"action": "reprocess_orders", "account": "colacor", "window_days": 7}''::jsonb');
  if v_cmd is null or v_novo = v_cmd then
    raise exception 'o molde do cron sync-reprocess-operational mudou — nada executado';
  end if;

  -- Guarda: cota do Omie da Colacor livre (outro ListarPedidos em voo faria a edge desistir no meio).
  if exists (select 1 from public.omie_cota_metodo
              where conta = 'colacor' and metodo = 'ListarPedidos'
                and (ocupado_ate > now() or bloqueado_ate > now())) then
    raise exception 'cota colacor/ListarPedidos ocupada ou bloqueada agora — tente fora do minuto do sync';
  end if;

  -- Guarda: nenhum reprocesso de pedidos da Colacor em andamento (duas rodadas concorrentes).
  if exists (select 1 from public.sync_reprocess_log
              where account = 'colacor' and entity_type = 'orders' and status = 'running'
                and created_at > now() - interval '2 hours') then
    raise exception 'já existe reprocesso de pedidos da Colacor em andamento — nada executado';
  end if;

  select coalesce(max(id), 0) into v_antes from net.http_request_queue;
  execute v_novo;

  -- Pós-condição: exatamente 1 POST novo, para a sync-reprocess, com o body dirigido.
  if (select count(*) from net.http_request_queue q
       where q.id > v_antes
         and q.url like '%/functions/v1/sync-reprocess'
         and convert_from(q.body, 'UTF8')::jsonb
             = '{"action":"reprocess_orders","account":"colacor","window_days":7}'::jsonb
     ) is distinct from 1 then
    raise exception 'pós-condição: o POST dirigido não foi enfileirado (ou foi mais de um)';
  end if;
  raise notice 'RECONCILIAR-COLACOR-CANARIO-ENFILEIRADO-OK';
end $run$;
