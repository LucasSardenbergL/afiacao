-- Run dirigido do omie-sync-sku-items: as 7 NF-e da Renner Sayerlack (abril/2026)
--
-- O QUE: executa o comando GRAVADO do job 186 (afiacao_omie_oben_sku_items_2h) com o body trocado
-- de `dias 3` para `dias 175` + `fornecedor_codigo_omie 8689681266`. É 1 POST para a edge, sem
-- escrita direta em tabela nenhuma.
--
-- POR QUE AGORA: as 7 NF-e (t2 em abril) não têm leadtime nem controle. A janela do fornecedor tem
-- 1.402 linhas de histórico, acima do teto de 1.000 do PostgREST, e até a v1.4 a edge transformaria
-- trackings com linha em pendentes (sku-items-cte-fora-da-fila.md §10.3). Só roda com a
-- v1.5-fila-paginada no ar, conferida pelo eco antes.
--
-- PRÉ-VOO (psql-ro, 2026-10-08): janela 223 NF-e, 216 com linha, 1.402 linhas de histórico.
-- Pendentes pela regra v1.5: 7 (todas de abril, sem leadtime e sem controle, nenhuma CT-e).
--
-- ENVELOPE: transacional (BEGIN/COMMIT). Idempotente no efeito: re-rodar reconsulta só o que ainda
-- está pendente, porque a fila mede pendência. Pós-condição: o POST foi ENFILEIRADO em
-- `net.http_request_queue` com o body dirigido.
-- Roda como `postgres` (o `cron.job` e o `net` exigem).
begin;

do $run$
declare
  v_cmd  text;
  v_novo text;
  v_antes bigint;
begin
  select command into v_cmd from cron.job where jobid = 186;
  v_novo := replace(v_cmd, '''dias'', 3)', '''dias'', 175, ''fornecedor_codigo_omie'', 8689681266)');
  if v_cmd is null or v_novo = v_cmd then
    raise exception 'o molde do job 186 mudou — nada executado';
  end if;
  select coalesce(max(id), 0) into v_antes from net.http_request_queue;
  execute v_novo;
  -- Pós-condição de ENFILEIRAMENTO: exatamente 1 POST novo, para esta edge, com o body dirigido.
  if (select count(*) from net.http_request_queue q
      where q.id > v_antes
        and q.url like '%/functions/v1/omie-sync-sku-items'
        and convert_from(q.body, 'UTF8')::jsonb @> '{"empresa":"OBEN","dias":175,"fornecedor_codigo_omie":8689681266}'::jsonb
     ) is distinct from 1 then
    raise exception 'pós-condição: o POST dirigido não foi enfileirado (ou foi mais de um)';
  end if;
end $run$;

select 'RUN-ENFILEIRADO-OK';
commit;
