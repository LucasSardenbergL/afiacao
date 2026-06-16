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
  if (!cronSecret) {
    console.warn('[scoring-recalc-batch] CRON_SECRET not set; downstream calls to scoring-recalc-client will be rejected');
  }

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

  // 2. Decay diário: recalcula só os clientes COM atividade (call) nos últimos 30d,
  //    mapeando farmer_id = DONO da carteira (Opção A; codex 2026-05-24). Garante o
  //    refresh do decay temporal (um sinal de 30 dias atrás muda de peso todo dia)
  //    sem fan-out da carteira inteira (~6908 estouraria o timeout de 50s). O backfill
  //    completo da carteira é feito pela fila no rollout, não aqui.
  //    ANTI-DRIFT: o dono vem de carteira_assignments, nunca do farmer_id da ligação.

  // ownerMap: customer_user_id → owner_user_id (carteira_assignments, paginado)
  const ownerMap = new Map<string, string>();
  for (let cp = 0; ; cp++) {
    const { data: aPage } = await supabase
      .from('carteira_assignments')
      .select('customer_user_id, owner_user_id')
      .range(cp * 1000, cp * 1000 + 999);
    const aRows = (aPage ?? []) as Array<{ customer_user_id: string; owner_user_id: string }>;
    for (const a of aRows) ownerMap.set(a.customer_user_id, a.owner_user_id);
    if (aRows.length < 1000) break;
  }

  // Fornecedores fora da carteira: clientes marcados p/ exclusão não entram no decay
  // (defesa em profundidade — o scoring-recalc-client também pula; aqui evita o fan-out à toa).
  const flaggeds = new Set<string>();
  for (let fp = 0; ; fp++) {
    const { data: fPage } = await supabase
      .from('cliente_classificacao')
      .select('user_id')
      .eq('excluir_da_carteira', true)
      .range(fp * 1000, fp * 1000 + 999);
    const fRows = (fPage ?? []) as Array<{ user_id: string }>;
    for (const r of fRows) flaggeds.add(r.user_id);
    if (fRows.length < 1000) break;
  }

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

  // Dedup por CLIENTE (1 score por cliente); farmer_id = dono (fallback: quem ligou).
  const unique = new Map<string, { customer_user_id: string; farmer_id: string }>();
  for (const p of (pairs ?? []) as Array<{ customer_user_id: string; farmer_id: string }>) {
    if (flaggeds.has(p.customer_user_id)) continue;
    unique.set(p.customer_user_id, {
      customer_user_id: p.customer_user_id,
      farmer_id: ownerMap.get(p.customer_user_id) ?? p.farmer_id,
    });
  }

  // Process pairs in concurrent batches to fit within edge function 50s timeout.
  // 10 concurrent × ~500ms each = ~5s per batch, so 200 pairs = ~10s total.
  const CONCURRENCY = 10;
  const allPairs = Array.from(unique.values());
  const results: Array<{ customer_user_id: string; farmer_id: string; ok: boolean }> = [];

  for (let i = 0; i < allPairs.length; i += CONCURRENCY) {
    const chunk = allPairs.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (pair) => {
        try {
          const r = await fetch(clientUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-cron-secret': cronSecret,
            },
            body: JSON.stringify(pair),
          });
          const j = await r.json().catch(() => ({}));
          return { ...pair, ok: r.ok, ...j };
        } catch (err) {
          return { ...pair, ok: false, error: String(err) };
        }
      }),
    );
    results.push(...chunkResults);
  }

  return new Response(JSON.stringify({
    drained,
    recalculated: results.length,
    errors: results.filter((r) => !r.ok).length,
  }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
