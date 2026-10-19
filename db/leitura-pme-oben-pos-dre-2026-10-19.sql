-- Leitura (sem gravar) do PME da Oben após o recompute do DRE (#3168), cenário realista.
-- save_snapshot:false → a edge só computa e responde; nada em fin_projecao_snapshots/fin_alertas.
-- Os request_id saem por NOTICE (o db:aplicar descarta SELECT); a resposta se lê em net._http_response.
DO $leitura$
DECLARE
  c   text;
  rid bigint;
  n   int := 0;
BEGIN
  FOREACH c IN ARRAY ARRAY['oben'] LOOP
    rid := net.http_post(
      url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/fin-cashflow-engine',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
      ),
      body := jsonb_build_object('company', c, 'cenario', 'realista', 'save_snapshot', false),
      timeout_milliseconds := 120000
    );
    RAISE NOTICE 'LEITURA_PME % %', c, rid;
    n := n + 1;
  END LOOP;
  IF n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'LEITURA_PME FALHOU: % disparos, esperado 1', n;
  END IF;
END
$leitura$;
