// supabase/functions/carteira-positivacao-snapshot/index.ts
// Cron mensal (dia 1) — congela o mês FECHADO anterior em carteira_positivacao_snapshot.
// Idempotente (upsert por mes,customer_user_id). Auth via x-cron-secret OU staff.
//
// Body opcional { mes: 'yyyy-mm-01' } pra backfill manual de um mês específico.
// Default = mês anterior (fuso America/Sao_Paulo).
//
// Setup pg_cron (manual pós-merge):
//   SELECT cron.schedule('carteira-positivacao-snapshot-mensal', '0 8 1 * *',
//     $$ SELECT net.http_post(
//       url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/carteira-positivacao-snapshot',
//       headers := jsonb_build_object('x-cron-secret',
//         (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1))
//     ); $$);

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

  const body = await req.json().catch(() => ({} as { mes?: string }));

  // Resolve mês-alvo (default = mês anterior em BRT).
  const nowBrt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const inicio = body.mes
    ? new Date(`${body.mes}T00:00:00`)
    : new Date(nowBrt.getFullYear(), nowBrt.getMonth() - 1, 1);
  const fim = new Date(inicio.getFullYear(), inicio.getMonth() + 1, 1);
  const mesIso = `${inicio.getFullYear()}-${String(inicio.getMonth() + 1).padStart(2, '0')}-01`;
  const fimIso = `${fim.getFullYear()}-${String(fim.getMonth() + 1).padStart(2, '0')}-01`;

  // Carteira (dono+elegibilidade de AGORA — melhor aproximação retroativa disponível).
  const assignments: Array<{ customer_user_id: string; owner_user_id: string; eligible: boolean }> = [];
  for (let p = 0; ; p++) {
    const { data } = await supabase.from('carteira_assignments')
      .select('customer_user_id, owner_user_id, eligible')
      .range(p * 1000, p * 1000 + 999);
    const rows = (data ?? []) as typeof assignments;
    assignments.push(...rows);
    if (rows.length < 1000) break;
  }

  // Pedidos válidos do mês por cliente (receita + 1ª data). order_date_kpi é não-nulo (backfill).
  const byCustomer = new Map<string, { receita: number; primeira: string | null }>();
  for (let p = 0; ; p++) {
    const { data } = await supabase.from('sales_orders')
      .select('customer_user_id, total, order_date_kpi')
      .not('status', 'in', '(cancelado,rascunho,pendente)')
      .gte('order_date_kpi', mesIso)
      .lt('order_date_kpi', fimIso)
      .range(p * 1000, p * 1000 + 999);
    const rows = (data ?? []) as Array<{ customer_user_id: string; total: number | null; order_date_kpi: string }>;
    for (const o of rows) {
      const cur = byCustomer.get(o.customer_user_id) ?? { receita: 0, primeira: null };
      cur.receita += Number(o.total ?? 0);
      if (!cur.primeira || o.order_date_kpi < cur.primeira) cur.primeira = o.order_date_kpi;
      byCustomer.set(o.customer_user_id, cur);
    }
    if (rows.length < 1000) break;
  }

  const rows = assignments.map((a) => {
    const ped = byCustomer.get(a.customer_user_id);
    return {
      mes: mesIso,
      customer_user_id: a.customer_user_id,
      owner_user_id: a.owner_user_id,
      eligible: a.eligible,
      had_order_in_month: !!ped,
      first_order_date_in_month: ped?.primeira ?? null,
      revenue_month: ped?.receita ?? 0,
    };
  });

  let upserted = 0;
  let errors = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('carteira_positivacao_snapshot')
      .upsert(rows.slice(i, i + 500), { onConflict: 'mes,customer_user_id' });
    if (error) errors++;
    else upserted += Math.min(500, rows.length - i);
  }

  return new Response(JSON.stringify({ mes: mesIso, total: rows.length, upserted, errors }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
