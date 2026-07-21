// supabase/functions/visit-score-recalc-batch/index.ts
//
// PR-VISIT-INTELLIGENCE Sub-PR A — cron noturno (04:00 BRT = 07:00 UTC).
// Roda 1h DEPOIS de scoring-recalc-batch (03:00 BRT) pra ler signal_modifiers
// que V2 acabou de atualizar.
//
// 1. Drena visit_score_recalc_pending
// 2. Full refresh: todos pares (customer, farmer) com atividade últimos 30d
//    (qualquer farmer_calls OU route_visits — sales_orders pulado por falta
//     de farmer_id direto)
//
// pg_cron: `visit-score-recalc-batch-nightly` JÁ ESTÁ ATIVO em produção (`'0 7 * * *'`, conferido
// em `cron.job` 2026-07-21). O bloco abaixo é o comando REAL que está rodando — serve para DR ou
// para recriar (`cron.schedule` faz upsert por nome → idempotente), NÃO é um setup pendente:
//   SELECT cron.schedule('visit-score-recalc-batch-nightly', '0 7 * * *',
//     $$ SELECT net.http_post(
//       url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/visit-score-recalc-batch',
//       headers := jsonb_build_object('Content-Type', 'application/json',
//         'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)),
//       timeout_milliseconds := 55000
//     ); $$
//   );
//
// Este bloco documentava `current_setting('app.cron_shared_key', true)` — GUC que não existe no
// projeto. O `true` (missing_ok) devolve NULL calado, o header sai nulo e a edge responde 401, com
// `cron.job_run_details` marcando `succeeded` mesmo assim (só registra o ENQUEUE do net.http_post;
// a verdade HTTP está em `net._http_response`). Quem criou o cron não seguiu o comentário — ele
// descrevia um setup que nunca existiu. Nenhum dos crons vivos usa a GUC.
//
// `timeout_milliseconds` também faltava, e é obrigatório: o default do pg_net é 5s e mataria o
// batch em silêncio. 55000 é o valor em prod; o teto padrão da casa é 150000 (docs/agent/sync.md)
// — alinhar os dois é follow-up, não deste PR.
//
// Schedule é UTC (`cron.timezone` vazio, #1510): '0 7' = 04:00 BRT, como diz o cabeçalho acima.

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

  const clientUrl = `${Deno.env.get('SUPABASE_URL')!}/functions/v1/visit-score-recalc-client`;
  const cronSecret = Deno.env.get('CRON_SECRET') ?? '';
  if (!cronSecret) {
    console.warn('[visit-score-recalc-batch] CRON_SECRET not set; downstream calls vão ser rejeitadas');
  }

  // 1. Drain pending queue
  const drainResp = await fetch(clientUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': cronSecret },
    body: JSON.stringify({ drain_queue: true, max_drain: 500 }),
  });
  const drained = await drainResp.json().catch(() => ({}));

  // 2. Decay diário: só clientes COM atividade (call/visita) nos últimos 30d, mapeados
  //    pro DONO da carteira (Opção A; codex 2026-05-24). O backfill completo da carteira
  //    (~6908) NÃO passa por aqui — vem pela fila no rollout (fan-out de 6908 estoura 50s).
  //    ANTI-DRIFT: o dono vem de carteira_assignments, nunca do farmer_id/visited_by.
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

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
  // (defesa em profundidade — o visit-score-recalc-client também pula; aqui evita o fan-out à toa).
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

  const [callsRes, visitsRes] = await Promise.all([
    supabase.from('farmer_calls')
      .select('customer_user_id, farmer_id')
      .gte('started_at', cutoff)
      .not('customer_user_id', 'is', null),
    supabase.from('route_visits')
      .select('customer_user_id, visited_by')
      .gte('visit_date', cutoff.slice(0, 10))
      .not('customer_user_id', 'is', null),
  ]);

  // Dedup por CLIENTE (1 score por cliente); farmer_id = dono (fallback: ator da atividade).
  const unique = new Map<string, { customer_user_id: string; farmer_id: string }>();
  for (const row of (callsRes.data ?? []) as Array<{ customer_user_id: string; farmer_id: string }>) {
    if (flaggeds.has(row.customer_user_id)) continue;
    unique.set(row.customer_user_id, {
      customer_user_id: row.customer_user_id,
      farmer_id: ownerMap.get(row.customer_user_id) ?? row.farmer_id,
    });
  }
  for (const row of (visitsRes.data ?? []) as Array<{ customer_user_id: string; visited_by: string }>) {
    if (flaggeds.has(row.customer_user_id)) continue;
    unique.set(row.customer_user_id, {
      customer_user_id: row.customer_user_id,
      farmer_id: ownerMap.get(row.customer_user_id) ?? row.visited_by,
    });
  }

  const pairs = Array.from(unique.values());

  // 3. Parallel chunks of 10 (timeout protection — Supabase edge ~50s)
  const CONCURRENCY = 10;
  const results: Array<{ customer_user_id: string; farmer_id: string; ok: boolean }> = [];
  for (let i = 0; i < pairs.length; i += CONCURRENCY) {
    const chunk = pairs.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (p) => {
        try {
          const r = await fetch(clientUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-cron-secret': cronSecret },
            body: JSON.stringify(p),
          });
          const j = await r.json().catch(() => ({}));
          return { ...p, ok: r.ok, ...j };
        } catch (err) {
          return { ...p, ok: false, error: String(err) };
        }
      }),
    );
    results.push(...chunkResults);
  }

  return new Response(JSON.stringify({
    drained,
    recalculated: results.length,
    errors: results.filter(r => !r.ok).length,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
