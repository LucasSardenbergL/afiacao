-- Cron da reconciliação de pedidos da COLACOR + chave vigiada no sync_reprocess_saude
--
-- O QUE (uma transação, a do `db:aplicar` — por isso SEM BEGIN/COMMIT aqui):
--   1. `_data_health_compute`: o catálogo do `sync_reprocess_saude` ganha a chave VIGIADA
--      ('colacor','operational','orders', sla 4h). Patch por ÂNCORA sobre o `pg_get_functiondef`
--      VIVO (nada copiado à mão): a linha ('colacor','status_produtos',…) tem de aparecer 1x; a
--      chave nova entra logo abaixo dela. Nada mais na função muda.
--   2. cron `sync-reprocess-pedidos-colacor-2h` ('40 */2 * * *'): o comando GRAVADO do
--      `sync-reprocess-operational` (Oben) com o body trocado para a ação SÓ DE PEDIDOS
--      `reprocess_operational_orders` (edge v1.19). Minuto :40 — 20 min depois do sync incremental da
--      Colacor (:20), na cota `colacor/ListarPedidos` (Codex 2026-10-11).
--   3. 1 disparo imediato do mesmo comando: a chave vigiada nasce COM execução — sem ele, o
--      watchdog (*/30) poderia vê-la como "nunca executou" entre o commit e o 1º :40.
--
-- POR QUE: o status dos pedidos da Colacor ficou congelado de jun a out/2026 (o reconciliador só
-- rodava para a Oben). A rodada única de 2026-10-11 (db/2026-10-11-reconciliar-pedidos-colacor-*.sql)
-- corrigiu o atraso; sem cron, ele volta. Diário: docs/historico/status-pedidos-colacor-congelado.md.
--
-- PRÉ-REQUISITO: edge sync-reprocess v1.19-pedidos-operacional NO AR (sonda). Bundle velho responde
-- 400 "Ação desconhecida" à ação nova → o cron falharia a cada 2h e o check acenderia `broken`.
-- PRÉ-VOO (psql-ro): âncora 1x no corpo vivo; nenhum job com o nome; cota livre.
-- Validação pós (psql-ro, outra conexão): ver o fim deste arquivo.
do $patch$
declare
  v_fn    constant text := 'public._data_health_compute()';
  v_anc   constant text := E'                 (''colacor'',      ''status_produtos'',      ''sku_status_omie'',                30),\n';
  v_nova  constant text := E'                 (''colacor'',      ''operational'',          ''orders'',                          4),\n';
  v_def   text;
  v_novo  text;
begin
  v_def := pg_get_functiondef(to_regprocedure(v_fn));
  if v_def is null then
    raise exception 'patch: % não existe', v_fn;
  end if;
  if (length(v_def) - length(replace(v_def, v_anc, ''))) / length(v_anc) is distinct from 1 then
    raise exception 'patch: a âncora (colacor/status_produtos) não aparece 1x no corpo vivo — revise';
  end if;
  if position(v_nova in v_def) > 0 then
    raise exception 'patch: a chave colacor/operational/orders já está no catálogo — nada a fazer';
  end if;
  v_novo := replace(v_def, v_anc, v_anc || v_nova);
  execute v_novo;
end $patch$;

-- Pós-condição 1: a chave está no corpo, 1x, e o compute devolve o check em UMA linha.
do $post1$
declare
  v_def text := pg_get_functiondef(to_regprocedure('public._data_health_compute()'));
  v_nova text := E'(''colacor'',      ''operational'',          ''orders'',                          4),';
  v_n int;
begin
  if (length(v_def) - length(replace(v_def, v_nova, ''))) / length(v_nova) is distinct from 1 then
    raise exception 'pós-condição: a chave colacor/operational/orders não está 1x no corpo';
  end if;
  select count(*) into v_n from public._data_health_compute() where source = 'sync_reprocess_saude';
  if v_n is distinct from 1 then
    raise exception 'pós-condição: _data_health_compute devolveu % linhas de sync_reprocess_saude (esperado 1)', v_n;
  end if;
end $post1$;

-- 2 + 3: cron e disparo imediato.
do $cron$
declare
  v_cmd   text;
  v_novo  text;
  v_antes bigint;
  v_job   bigint;
begin
  if exists (select 1 from cron.job where jobname = 'sync-reprocess-pedidos-colacor-2h') then
    raise exception 'já existe o job sync-reprocess-pedidos-colacor-2h — nada executado';
  end if;
  select command into v_cmd from cron.job where jobname = 'sync-reprocess-operational';
  v_novo := replace(v_cmd,
    '''{"action": "reprocess_operational", "account": "oben"}''::jsonb',
    '''{"action": "reprocess_operational_orders", "account": "colacor"}''::jsonb');
  if v_cmd is null or v_novo = v_cmd or position('timeout_milliseconds' in v_novo) = 0 then
    raise exception 'o molde do cron sync-reprocess-operational mudou — nada executado';
  end if;

  select cron.schedule('sync-reprocess-pedidos-colacor-2h', '40 */2 * * *', v_novo) into v_job;

  select coalesce(max(id), 0) into v_antes from net.http_request_queue;
  execute v_novo;
  if (select count(*) from net.http_request_queue q
       where q.id > v_antes
         and q.url like '%/functions/v1/sync-reprocess'
         and convert_from(q.body, 'UTF8')::jsonb = '{"action":"reprocess_operational_orders","account":"colacor"}'::jsonb
     ) is distinct from 1 then
    raise exception 'pós-condição: o disparo imediato não foi enfileirado (ou foi mais de um)';
  end if;

  -- Pós-condição 2: o job existe, ativo, no horário, com a ação SÓ DE PEDIDOS da Colacor.
  if (select count(*) from cron.job
       where jobid = v_job and jobname = 'sync-reprocess-pedidos-colacor-2h' and active
         and schedule = '40 */2 * * *'
         and command like '%"reprocess_operational_orders"%' and command like '%"colacor"%'
         and command not like '%"reprocess_operational"%'
         and command like '%timeout_milliseconds%') is distinct from 1 then
    raise exception 'pós-condição: o job não ficou como esperado';
  end if;
  raise notice 'CRON-COLACOR-PEDIDOS-OK jobid=%', v_job;
end $cron$;

-- Validação pós-apply (psql-ro, outra conexão):
--   SELECT jobid, jobname, schedule, active, username FROM cron.job WHERE jobname = 'sync-reprocess-pedidos-colacor-2h';
--   SELECT status, (metadata->>'pages'), error_message, created_at FROM sync_reprocess_log
--    WHERE account = 'colacor' AND reprocess_type = 'operational' AND entity_type = 'orders' ORDER BY created_at DESC LIMIT 3;
--   SELECT status, message FROM public._data_health_compute() WHERE source = 'sync_reprocess_saude';
