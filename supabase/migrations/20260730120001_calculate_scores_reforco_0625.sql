-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- calculate-scores — SEGUNDO DISPARO às 06:15 (fecha a perda de frescor do lease)
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- O QUE FECHA. O lease do #1578 serializa os runs, mas o run PERDEDOR é simplesmente pulado (200
-- `skipped`) e não volta: o próximo disparo real era o cron do dia seguinte. Trocamos corrupção
-- (last-writer-wins restaurando margem velha) por até 24h de dado velho — melhor que o bug, mas
-- ainda uma regressão, e foi declarada como limitação no #1578 e no #1591.
--
-- Dois cenários que este disparo cobre, e que hoje só se resolvem no dia seguinte:
--   1. o run das 06:00 ganhou o lease mas rodou DEGRADADO (`marginRefreshFatal` — a RPC de margem
--      falhou, tipicamente por timeout): ele regrava o snapshot que leu e termina em erro. Às 06:15
--      a RPC costuma estar de pé, e o segundo run mede a margem de verdade;
--   2. dois disparos se sobrepuseram (cron + botão manual da staff dentro da mesma janela de ~30s):
--      o perdedor foi pulado. Aos 06:15 o lease está livre.
--
-- POR QUE UM CRON, E NÃO ESPERAR DENTRO DA EDGE. A primeira tentativa de fechar isto foi retry com
-- espera no claim, e o challenge /codex mostrou que a calibragem não fechava nada: a última
-- tentativa caía em t=15s contra um run que MEDI em ~29s (28/07: cron 06:00:00, finalize do lease
-- 06:00:29). Cobrir de verdade exigiria esperar >30s DENTRO da edge, consumindo a margem do
-- wall-clock (150s Free / 400s pago) antes mesmo de começar o recompute. Um segundo disparo 15min
-- depois não tem esse custo: cada run tem o wall-clock inteiro para si.
--
-- POR QUE É SEGURO RODAR DUAS VEZES. O recompute é IDEMPOTENTE por construção — lê o estado, calcula
-- e reescreve as mesmas linhas (`apply_score_updates` é UPDATE-only por id, anti-ressurreição). Rodar
-- 2× no mesmo dia produz o mesmo resultado que rodar 1×, com dado mais fresco. E o LEASE garante que
-- os dois nunca se sobreponham: se por algum motivo o run das 06:00 ainda estiver vivo às 06:15 (o
-- que exigiria ~15min de execução, contra os ~29s medidos), o segundo é pulado e nada acontece.
--
-- CUSTO: ~30s de edge por dia, mais 6.633 linhas em `health_score_history` e `priority_score_log`.
-- Estas duas são séries temporais append-only de display/tendência (não estado money-path — a fonte
-- é `farmer_client_scores`), então uma amostra a mais por dia é adensamento da série, não corrupção.
-- ⚠️ Se o volume dessas tabelas virar problema, a saída é retenção/particionamento, NÃO remover o
-- segundo disparo em silêncio — quem remover perde a cura do frescor sem perceber.
--
-- POR QUE 06:25 E NÃO 06:15. O horário foi escolhido olhando a VIZINHANÇA de crons (mapeada por
-- psql-ro em 2026-07-28), não por número redondo. A hora 6 é congestionada:
--   06:00 → daily-calculate-scores + fin-sync-base-diario + scoring-recalc-batch-nightly
--            + sync-products-customers-daily (4 jobs)
--   06:15 → sync-colacor-vendas-products + afiacao_customer_metrics_refresh_6h
--   06:20 → vendas-sync-pedidos-colacor-2h + afiacao_oportunidade_badge_refresh_2h
--   06:45 → compute-costs-daily
-- 06:15 era a escolha óbvia e é justamente a ruim: o `sync-colacor-vendas-products` mexe em PRODUTO,
-- e o recompute lê custo para calcular margem — ler no meio de uma atualização de catálogo é pedir
-- para medir um estado intermediário. 06:25 só coincide com os watchdogs leves do `*/5`
-- (afiacao-os-sync, sayerlack-portal-watchdog, tint-watchdog-corante-5min); os `*/10`, `*/15` e
-- `*/30` não caem no minuto :25.
--
-- 25 MINUTOS de distância do run principal: tem de ser MAIOR que a duração de um run (~29s medido,
-- folga de ~50×) para que o segundo disparo encontre o lease livre, e PEQUENO o bastante para que o
-- dado fresco chegue antes do expediente. A vendedora abre a carteira de manhã; 06:25 é madrugada.

-- Idempotente: `cron.schedule` com nome existente REAGENDA em vez de duplicar. Espelha VERBATIM o
-- comando do job 36 (`daily-calculate-scores`, conferido por psql-ro em 2026-07-28) — inclusive o
-- `timeout_milliseconds` explícito, sem o qual o default de 5s mataria a chamada em silêncio e o
-- `cron.job_run_details` ainda diria 'succeeded' (só prova o ENQUEUE; a verdade HTTP está em
-- `net._http_response`). O `triggered_by` distingue os dois disparos no log da edge.
SELECT cron.schedule(
  'calculate-scores-reforco-0625',
  '25 6 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/calculate-scores',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
    body := '{"triggered_by":"cron-reforco-0625"}'::jsonb,
    timeout_milliseconds := 150000
  );
  $cron$
);

-- Validação pós-apply (read-only): o job existe, está ativo, no horário certo, e o comando carrega
-- o timeout explícito (sem ele o default de 5s mata a chamada em silêncio).
SELECT 'MIGRATION calculate_scores_segundo_disparo OK' AS status,
  jobname, schedule, active,
  (command LIKE '%timeout_milliseconds%')        AS tem_timeout_deve_ser_true,
  (command LIKE '%cron-reforco-0625%')           AS tem_marcador_deve_ser_true,
  (SELECT count(*) FROM cron.job WHERE command LIKE '%calculate-scores%' AND active)::int AS disparos_ativos_deve_ser_2
FROM cron.job WHERE jobname = 'calculate-scores-reforco-0625';
