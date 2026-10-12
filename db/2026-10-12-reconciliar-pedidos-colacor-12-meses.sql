-- Reconciliação de pedidos da COLACOR — JANELA DE 12 MESES (365 dias, desde 12/10/2025)
--
-- Extensão aprovada pelo founder em 2026-10-12: a rodada de 165 dias (recibo #351) parou em 29/04/2026
-- e deixou 368 pedidos (R$ 143k) de out/2025–abr/2026 com o status congelado da 1ª importação — o aviso
-- de "pedidos sem nota" mostraria, para a Colacor, dois terços de status velho.
-- MESMO molde do arquivo de 165 dias (db/2026-10-11-reconciliar-pedidos-colacor-backlog.sql): só a janela
-- e o marcador mudam. O pipeline já foi auditado pedido a pedido (canário #349, 165 dias #351).
-- PRÉ-VOO (psql-ro, 2026-10-12 13:01Z): snapshot novo 19.834 pedidos + 46.794 itens; RPC viva md5
-- 4b16bbb4… (= baseline); cota colacor livre; nenhum reprocesso em andamento; edge v1.19 atestada.
-- Estimativa: ~14 páginas, ~70 s (timeout do POST 150 s).
-- Aplicação: `bun run db:aplicar <este arquivo>` (SEM BEGIN/COMMIT).
do $run$
declare
  v_cmd   text;
  v_novo  text;
  v_antes bigint;
begin
  select command into v_cmd from cron.job where jobname = 'sync-reprocess-operational';
  v_novo := replace(v_cmd,
    '''{"action": "reprocess_operational", "account": "oben"}''::jsonb',
    '''{"action": "reprocess_orders", "account": "colacor", "window_days": 365}''::jsonb');
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
             = '{"action":"reprocess_orders","account":"colacor","window_days":365}'::jsonb
     ) is distinct from 1 then
    raise exception 'pós-condição: o POST dirigido não foi enfileirado (ou foi mais de um)';
  end if;
  raise notice 'RECONCILIAR-COLACOR-12-MESES-ENFILEIRADO-OK';
end $run$;
