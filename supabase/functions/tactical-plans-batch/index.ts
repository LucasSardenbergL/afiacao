// supabase/functions/tactical-plans-batch/index.ts
//
// Cron noturno que, para cada vendedora (farmer) com carteira, seleciona o
// top-25 dos clientes por priority_score que passam no gate de R$/h e dispara
// a pré-geração do plano tático chamando generate-tactical-plan no modo
// self-contained. Idempotência fica na edge alvo (skipped: 'ja_gerado_hoje').
//
// Gate de R$/h: espelha src/lib/tactical/pregeracao.ts (oráculo testado por vitest).
//   profitPerHora = ((rev > 0 ? rev : avg) * (margin / 100) * 0.1) / (15 / 60)
//   Threshold: R$ 50/h.
//
// Semântica top-N: filtra o gate ANTES de cortar no TOP_25 — pega os 25 de
// maior priority DENTRE os que passam (não os 25 de maior priority e filtra depois).
//
// Setup pg_cron (manual depois do merge):
//   SELECT cron.schedule('tactical-plans-batch-nightly', '0 5 * * *',
//     $$ SELECT net.http_post(
//       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/tactical-plans-batch',
//       headers := jsonb_build_object('x-cron-secret', current_setting('app.cron_shared_key', true)),
//       timeout_milliseconds := 55000
//     ); $$
//   );

import { createClient } from 'npm:@supabase/supabase-js@^2';
import { authorizeCronOrStaff, corsHeaders } from '../_shared/auth.ts';

// ── Gate de R$/h (espelha src/lib/tactical/pregeracao.ts) ────────────────────
const PROFIT_PER_HOUR_THRESHOLD = 50;

function profitPerHora(rev: number, avg: number, marginPct: number): number {
  const baseRev = rev > 0 ? rev : avg;
  // 10% do GMV como proxy de margem operacional; visita ~15 min → 4 visitas/h.
  return (baseRev * (marginPct / 100) * 0.1) / (15 / 60);
}

const TOP_N = 25;
const CONCURRENCY = 5; // cada chamada faz 1 LLM (~3-5s); 5 em paralelo ~5s/chunk

// ── Handler ──────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const selfUrl = `${Deno.env.get('SUPABASE_URL')!}/functions/v1/generate-tactical-plan`;
  const cronSecret = Deno.env.get('CRON_SECRET') ?? '';
  if (!cronSecret) {
    console.warn('[tactical-plans-batch] CRON_SECRET not set; downstream calls will be rejected');
  }

  // 1. Pagina farmer_client_scores e agrupa por farmer_id.
  //    A carteira já está limpa de fornecedor pela Fase 1 (classificacao).
  const porFarmer = new Map<string, Array<{
    customer: string;
    priority: number;
    rev: number;
    avg: number;
    m: number;
  }>>();

  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('farmer_client_scores')
      .select('farmer_id, customer_user_id, priority_score, revenue_potential, avg_monthly_spend_180d, gross_margin_pct')
      .order('farmer_id', { ascending: true })
      .range(from, from + 999);

    if (error) {
      return new Response(
        JSON.stringify({ ok: false, error: error.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const rows = (data ?? []) as Array<{
      farmer_id: string;
      customer_user_id: string;
      priority_score: number | null;
      revenue_potential: number | null;
      avg_monthly_spend_180d: number | null;
      gross_margin_pct: number | null;
    }>;

    for (const r of rows) {
      const arr = porFarmer.get(r.farmer_id) ?? [];
      arr.push({
        customer: r.customer_user_id,
        priority: Number(r.priority_score ?? 0),
        rev: Number(r.revenue_potential ?? 0),
        avg: Number(r.avg_monthly_spend_180d ?? 0),
        m: Number(r.gross_margin_pct ?? 0),
      });
      porFarmer.set(r.farmer_id, arr);
    }

    if (rows.length < 1000) break;
  }

  // 2. Por farmer: ordena por priority desc, filtra gate R$/h, corta em TOP_N.
  //    Semântica: pega os 25 de maior priority DENTRE os que passam no gate.
  const alvos: Array<{ farmer: string; customer: string }> = [];

  for (const [farmer, scores] of porFarmer) {
    scores.sort((a, b) => b.priority - a.priority);
    let n = 0;
    for (const s of scores) {
      if (n >= TOP_N) break;
      if (profitPerHora(s.rev, s.avg, s.m) < PROFIT_PER_HOUR_THRESHOLD) continue;
      alvos.push({ farmer, customer: s.customer });
      n++;
    }
  }

  // 3. Fan-out concorrente em chunks de 5. Idempotência é na edge alvo.
  let gerados = 0;
  let pulados = 0;
  let erros = 0;

  for (let i = 0; i < alvos.length; i += CONCURRENCY) {
    const chunk = alvos.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (a) => {
        try {
          const r = await fetch(selfUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-cron-secret': cronSecret,
            },
            body: JSON.stringify({
              customerId: a.customer,
              farmerId: a.farmer,
              planType: 'estrategico',
            }),
          });
          const j = await r.json().catch(() => ({})) as Record<string, unknown>;
          if (j.generated) gerados++;
          else if (j.skipped) pulados++;
          else erros++;
        } catch {
          erros++;
        }
      }),
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      farmers: porFarmer.size,
      alvos: alvos.length,
      gerados,
      pulados,
      erros,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
