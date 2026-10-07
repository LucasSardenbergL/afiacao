-- ============================================================
-- Sensor POR FORA da fila do omie-sync-sku-items — o recebimento que não anda há mais de 48h
-- Contexto: docs/historico/sku-items-fila-parada-sensor-por-fora.md
-- Aplicação: `bun run db:aplicar <este arquivo>` (o executor dá a transação — por isso SEM
--            BEGIN/COMMIT aqui; o `aplicar_sql()` é SECURITY DEFINER do `postgres`, então os
--            objetos nascem com o dono e o ACL default de `postgres`, e o cron roda como ele).
-- ============================================================
-- POR QUÊ: a edge grava `results.fila_parada_48h` e fecha `error` "fila não anda" (#2539), mas
--   (a) o `fin_sync_watchdog_check` só pagina com DOIS `error` seguidos da mesma action, e a NF-e com
--       mais de 3 dias só é alcançada pelo diário das 07:00 (jobid 53, dias=30) — o `error` dele é
--       apagado pelo `complete` do run seguinte de 2h (jobid 186, dias=3), que nem a enxerga. Verde
--       falso POR CONSTRUÇÃO (§7 do docs/historico/sku-items-consumo-redundante-no-ciclo.md);
--   (b) o sensor da edge é a máquina vigiada dando nota a si mesma.
--   Incidente-mãe: fin_alertas 8a83fdf2-8660-4bf0-8151-a871cf437d6c (sync_error OBEN, 2026-09-23).
-- O QUE MEDE: o mesmo que `avaliarFilaParada` (supabase/functions/omie-sync-sku-items/adiamento.ts),
--   só que pelo DADO, entre os runs, sem ler `fin_sync_log` nem o `results` da edge:
--   · janela = a query da edge (index.ts): OBEN, t2 nos últimos 30 dias (o `dias` do diário),
--     `nfe_chave_acesso` presente;
--   · fora o CT-e (modelo 57 pela chave, parser ESTRITO de 44 dígitos — escopo.ts, #2798);
--   · pendente = a regra `pendenteNaFila` (#2801): com `itens_pendentes` medido, k > 0; sem medida
--     (legado, ou a coluna ainda nem existe), "sem linha em sku_leadtime_history";
--   · só conta recebimento SEM NENHUMA linha de leadtime na janela — o incompleto (com linha) volta
--     à fila no #2801 mas "não é fila parada" (é a régua do sensor que pagina lá); na v1.3 isso só
--     tira as irmãs de um recebimento que já gravou, que a edge reconsulta sem dano;
--   · elegível desde = fim do backoff (6h/24h/72h por tentativas) se já tentada; senão o MAIOR
--     entre o nascimento da linha e o faturamento (`elegivelDesdeMs`);
--   · por RECEBIMENTO (`nid_receb`, a unidade de uma chamada), a linha mais antiga;
--   · parado = elegível há MAIS de 48h (estrito, como `ELEGIVEL_HA_MUITO_MS`).
-- ⚠️ `itens_pendentes` é lida por `to_jsonb(c)`, não por nome: a coluna chega com o #2801
--   (migration 20261005170000) e ainda não existe em prod. Ler por nome amarraria a ordem de
--   aplicação dos dois PRs. Sem a coluna o valor é NULL e vale a regra legada — que é a regra da
--   edge no ar (v1.3). Se a coluna um dia for renomeada, o sensor volta à regra legada e ERRA PARA
--   O LADO QUE ALERTA (o recebimento medido completo sem linha passa a contar) — barulho, não silêncio.
-- ⚠️ CRON no minuto :52 — 17 min depois de cada :35 e 52 min depois do diário das 07:00. Os
--   watchdogs */30 (:00/:30) caem NO MESMO MINUTO do diário: lá, o recebimento que o run das 07:00
--   está para tratar seria acusado segundos antes. Fora do minuto de qualquer run, não há corrida.
-- Alerta: fin_alertas (oben, `sync_sku_items_fila_parada`, aviso) + e-mail '[Sync fila] OBEN'
--   (fornecedor_alerta → dispatch-notifications) na abertura do episódio; resolve sozinho
--   (dismissed_at + resolvido_em, como o data_health_watchdog) quando a contagem zera. A mensagem
--   carrega a data do DADO (elegível desde do mais antigo), nunca a idade corrida.
-- Validação pós-apply (psql-ro, outra conexão):
--   SELECT jobname, schedule, active, username FROM cron.job
--    WHERE jobname = 'afiacao_sku_items_fila_parada_1h';
--   SELECT count(*) AS na_fila, count(*) FILTER (WHERE parado) AS parados FROM public.v_sku_items_fila;
-- ============================================================

CREATE VIEW public.v_sku_items_fila
WITH (security_invoker = on) AS
WITH janela AS (
  SELECT
    t.id,
    t.created_at,
    t.t2_data_faturamento,
    t.nfe_chave_acesso,
    COALESCE(t.nid_receb::text, NULLIF(t.raw_data -> 'cabec' ->> 'nIdReceb', '')) AS nid_receb,
    EXISTS (SELECT 1 FROM public.sku_leadtime_history h WHERE h.tracking_id = t.id) AS tem_linha
  FROM public.purchase_orders_tracking t
  WHERE t.empresa = 'OBEN'
    AND t.t2_data_faturamento >= now() - interval '30 days'
    AND t.nfe_chave_acesso IS NOT NULL
),
pendentes AS (
  SELECT
    j.nid_receb,
    j.t2_data_faturamento,
    COALESCE(c.tentativas, 0) AS tentativas,
    CASE
      WHEN COALESCE(c.tentativas, 0) > 0 THEN
        c.ultima_tentativa + CASE c.tentativas
                               WHEN 1 THEN interval '6 hours'
                               WHEN 2 THEN interval '24 hours'
                               ELSE interval '72 hours'
                             END
      ELSE GREATEST(j.created_at, j.t2_data_faturamento)
    END AS elegivel_desde
  FROM janela j
  LEFT JOIN public.sku_items_sync_controle c ON c.tracking_id = j.id
  CROSS JOIN LATERAL (SELECT (to_jsonb(c) ->> 'itens_pendentes')::int AS itens_pendentes) m
  WHERE NOT (j.nfe_chave_acesso ~ '^[0-9]{44}$' AND substr(j.nfe_chave_acesso, 21, 2) = '57')
    AND CASE WHEN m.itens_pendentes IS NOT NULL THEN m.itens_pendentes > 0 ELSE NOT j.tem_linha END
)
SELECT
  p.nid_receb,
  count(*)::int AS linhas_pendentes,
  min(p.elegivel_desde) AS elegivel_desde,
  max(p.tentativas)::int AS tentativas_max,
  min(p.t2_data_faturamento) AS t2_min,
  (now() - min(p.elegivel_desde) > interval '48 hours') AS parado
FROM pendentes p
WHERE p.nid_receb IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM janela j2 WHERE j2.nid_receb = p.nid_receb AND j2.tem_linha)
GROUP BY p.nid_receb;

COMMENT ON VIEW public.v_sku_items_fila IS
  'Fila do omie-sync-sku-items (OBEN, 30 dias), 1 linha por recebimento SEM leadtime: elegivel_desde '
  '(a linha mais antiga; no futuro = ainda em backoff) e parado (> 48h elegivel). Espelho por fora de '
  'avaliarFilaParada. Le-se no diagnostico: SELECT * FROM v_sku_items_fila WHERE parado. '
  'docs/historico/sku-items-fila-parada-sensor-por-fora.md';

CREATE FUNCTION public.sku_items_fila_parada_check()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_parados int;
  v_na_fila int;
  v_nid text;
  v_desde timestamptz;
  v_msg text;
BEGIN
  SELECT count(*) FILTER (WHERE f.parado), count(*)
    INTO v_parados, v_na_fila
    FROM public.v_sku_items_fila f;

  IF v_parados > 0 THEN
    SELECT f.nid_receb, f.elegivel_desde
      INTO v_nid, v_desde
      FROM public.v_sku_items_fila f
     WHERE f.parado
     ORDER BY f.elegivel_desde, f.nid_receb
     LIMIT 1;

    v_msg := format(
      'Fila do sku-items OBEN parada: %s recebimento(s) sem leadtime elegível(is) há mais de 48h sem consulta. '
      'Mais antigo: nIdReceb %s, elegível desde %s UTC. Lista: SELECT * FROM v_sku_items_fila WHERE parado.',
      v_parados, v_nid, to_char(v_desde AT TIME ZONE 'UTC', 'DD/MM HH24:MI'));

    -- Abre o episódio uma vez: com um alerta ativo do tipo (inclusive silenciado — dismissed_until
    -- deixa a linha ativa), o índice único parcial faz o INSERT não pegar e nada é reenviado.
    INSERT INTO public.fin_alertas (company, tipo, severidade, mensagem, contexto, email_enfileirado_em)
    VALUES ('oben', 'sync_sku_items_fila_parada', 'aviso', v_msg,
            jsonb_build_object(
              'recebimentos_parados', v_parados,
              'recebimentos_na_fila', v_na_fila,
              'nid_receb_mais_antigo', v_nid,
              'elegivel_desde_mais_antigo', v_desde,
              'limiar_horas', 48,
              'janela_dias', 30,
              'fonte', 'v_sku_items_fila'),
            now())
    ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
    IF FOUND THEN
      INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
      VALUES ('oben', 'outro', 'atencao', '[Sync fila] OBEN', v_msg, 'pendente_notificacao');
    END IF;
  ELSE
    UPDATE public.fin_alertas
       SET dismissed_at = now(), resolvido_em = now()
     WHERE company = 'oben'
       AND tipo = 'sync_sku_items_fila_parada'
       AND dismissed_at IS NULL;
  END IF;
END;
$fn$;

COMMENT ON FUNCTION public.sku_items_fila_parada_check() IS
  'Sensor por fora da fila do omie-sync-sku-items: abre fin_alertas sync_sku_items_fila_parada (+ e-mail) '
  'quando algum recebimento de v_sku_items_fila esta parado; resolve quando zera. Cron '
  'afiacao_sku_items_fila_parada_1h (:52). docs/historico/sku-items-fila-parada-sensor-por-fora.md';

-- O default de `public` dá EXECUTE a anon/authenticated e ALL na view (pg_default_acl, medido
-- 2026-10-05). Fecha como as sentinelas irmãs (reposicao_param_fila_sensor, tint_watchdog_fase5_check):
-- quem chama é o cron, como `postgres`. O claude_ro segue lendo a view (default dele, intacto).
REVOKE ALL ON FUNCTION public.sku_items_fila_parada_check() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.v_sku_items_fila FROM PUBLIC, anon, authenticated;

-- pg_cron 1.6: schedule faz upsert por (nome, dono) — re-agendar mantém o jobid.
SELECT cron.schedule(
  'afiacao_sku_items_fila_parada_1h',
  '52 * * * *',
  'SELECT public.sku_items_fila_parada_check();'
);

-- ------------------------------------------------------------
-- Postcondição — relê o catálogo e EXECUTA o sensor; aborta se algo não pegou ou não roda
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_oid oid := to_regprocedure('public.sku_items_fila_parada_check()');
  v_cols text;
  v_job record;
BEGIN
  -- A1: a view existe e lê como QUEM CHAMA (invoker): como OWNER ela furaria a RLS das 3 tabelas
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
     WHERE c.oid = to_regclass('public.v_sku_items_fila') AND c.relkind = 'v'
       AND 'security_invoker=on' = ANY (coalesce(c.reloptions, '{}'))
  ) THEN
    RAISE EXCEPTION 'A1 FALHOU: v_sku_items_fila ausente ou sem security_invoker=on (leria como dono, furando a RLS)';
  END IF;

  -- A2: as colunas que a função e o diagnóstico leem, nesta ordem
  SELECT string_agg(a.attname, ',' ORDER BY a.attnum) INTO v_cols
    FROM pg_attribute a
   WHERE a.attrelid = to_regclass('public.v_sku_items_fila') AND a.attnum > 0 AND NOT a.attisdropped;
  IF v_cols IS DISTINCT FROM 'nid_receb,linhas_pendentes,elegivel_desde,tentativas_max,t2_min,parado' THEN
    RAISE EXCEPTION 'A2 FALHOU: colunas da view = % — a função leria outra coisa', coalesce(v_cols, '<nenhuma>');
  END IF;

  -- A3: a função existe, é SECURITY DEFINER do postgres, com search_path preso
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'A3 FALHOU: sku_items_fila_parada_check() ausente — o cron chamaria uma função que não existe';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = v_oid AND p.prosecdef
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proconfig = ARRAY['search_path=public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'A3 FALHOU: a função não é SECURITY DEFINER do postgres com search_path=public, pg_temp — leria a fila filtrada pela RLS ou com search_path sequestrável';
  END IF;

  -- A4: ninguém de fora chama (abriria/fecharia alerta e mandaria e-mail): PUBLIC, anon, authenticated
  IF has_function_privilege('public', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'A4 FALHOU: PUBLIC/anon/authenticated ainda executam o sensor — qualquer logado dispararia e-mail';
  END IF;

  -- A5: a view fechada para o app; e o claude_ro segue lendo (a sentinela exige SELECT em todo public)
  IF has_table_privilege('anon', 'public.v_sku_items_fila', 'SELECT')
     OR has_table_privilege('authenticated', 'public.v_sku_items_fila', 'SELECT') THEN
    RAISE EXCEPTION 'A5 FALHOU: anon/authenticated leem v_sku_items_fila';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_ro')
     AND NOT has_table_privilege('claude_ro', 'public.v_sku_items_fila', 'SELECT') THEN
    RAISE EXCEPTION 'A5 FALHOU: claude_ro sem SELECT na view — o diagnóstico por psql-ro cegaria e a sentinela authz:claude-ro acusaria';
  END IF;

  -- A6: o cron existe, ativo, no :52, chama o sensor, e roda como postgres (dono da função)
  SELECT j.schedule, j.command, j.active, j.username INTO v_job
    FROM cron.job j WHERE j.jobname = 'afiacao_sku_items_fila_parada_1h';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A6 FALHOU: cron afiacao_sku_items_fila_parada_1h ausente — o sensor nunca rodaria';
  END IF;
  IF v_job.schedule IS DISTINCT FROM '52 * * * *' OR NOT v_job.active
     OR v_job.command IS DISTINCT FROM 'SELECT public.sku_items_fila_parada_check();'
     OR v_job.username IS DISTINCT FROM 'postgres' THEN
    RAISE EXCEPTION 'A6 FALHOU: cron schedule=% active=% username=% command=% — esperado :52, ativo, postgres, o sensor',
      v_job.schedule, v_job.active, v_job.username, v_job.command;
  END IF;

  -- A7: EXECUTA o sensor (PL/pgSQL é late-bound: o CREATE passa e o erro só aparece rodando). O efeito
  -- é desfeito por uma SQLSTATE própria; QUALQUER outro erro sobe e aborta a migration.
  BEGIN
    PERFORM public.sku_items_fila_parada_check();
    RAISE EXCEPTION USING ERRCODE = 'SKF01', MESSAGE = 'sonda A7: desfaz o efeito da execução';
  EXCEPTION
    WHEN SQLSTATE 'SKF01' THEN NULL;
  END;

  RAISE NOTICE 'postcondicao OK: view invoker, 6 colunas, funcao SECDEF fechada, cron :52 como postgres, sensor executou';
END
$post$;
