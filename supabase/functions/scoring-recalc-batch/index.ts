// supabase/functions/scoring-recalc-batch/index.ts
//
// Cron noturno (03:00 BRT = 06:00 UTC) que:
//   1. Drena a fila score_recalc_pending (chamadas inseridas que ainda não recalcularam)
//   2. Recalcula todos os pares (customer_user_id, farmer_id) com calls nos últimos 30 dias
//
// Invoca scoring-recalc-client internamente via fetch.
// Auth cron via header x-cron-secret (CRON_SECRET env var).
//
// Setup pg_cron (manual depois do merge):
//   SELECT cron.schedule('scoring-recalc-batch-nightly', '0 6 * * *',
//     $$ SELECT net.http_post(
//       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/scoring-recalc-batch',
//       headers := jsonb_build_object('x-cron-secret', current_setting('app.cron_shared_key', true))
//     ); $$
//   );

import { createClient } from 'npm:@supabase/supabase-js@^2';
import { authorizeCronOrStaff, corsHeaders } from '../_shared/auth.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const clientUrl = `${Deno.env.get('SUPABASE_URL')!}/functions/v1/scoring-recalc-client`;
  // Internal cron-to-cron auth: pass the same CRON_SECRET the batch itself accepted.
  const cronSecret = Deno.env.get('CRON_SECRET') ?? '';

  // 1. Drena fila pendente (chamadas inseridas hoje que ainda não recalcularam)
  const drainResp = await fetch(clientUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cron-secret': cronSecret,
    },
    body: JSON.stringify({ drain_queue: true, max_drain: 500 }),
  });
  const drained = await drainResp.json().catch(() => ({}));

  // 2. Recalc full: para cada par único (customer_user_id, farmer_id) com call
  //    nos últimos 30 dias. Garante refresh diário do decay temporal mesmo sem
  //    novas chamadas (um sinal de 30 dias atrás muda de peso todo dia).
  const { data: pairs, error: pErr } = await supabase
    .from('farmer_calls')
    .select('customer_user_id, farmer_id')
    .gte('started_at', new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString())
    .not('customer_user_id', 'is', null);

  if (pErr) {
    return new Response(JSON.stringify({ error: pErr.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Dedup: um par pode ter N chamadas — processar só uma vez
  const unique = new Map<string, { customer_user_id: string; farmer_id: string }>();
  for (const p of (pairs ?? []) as Array<{ customer_user_id: string; farmer_id: string }>) {
    unique.set(`${p.customer_user_id}::${p.farmer_id}`, p);
  }

  const results = [];
  for (const pair of unique.values()) {
    const r = await fetch(clientUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-cron-secret': cronSecret,
      },
      body: JSON.stringify(pair),
    });
    const j = await r.json().catch(() => ({}));
    results.push({ ...pair, ok: r.ok, ...j });
  }

  return new Response(JSON.stringify({
    drained,
    recalculated: results.length,
    errors: results.filter((r) => !r.ok).length,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
