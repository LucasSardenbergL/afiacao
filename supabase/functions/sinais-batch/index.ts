// supabase/functions/sinais-batch/index.ts
//
// Cron de varredura (rede de segurança da Fatia 2): pega ligações com transcript e
// SEM extração de sinais (sinais_ligacao IS NULL) e dispara extrair-sinais-ligacao.
// O caminho primário é o fire-and-forget do front (WebRTCCallContext) ao fim da ligação;
// esta varredura recupera o que falhou. Idempotência é na edge alvo (hash + prompt_version).
//
// Setup pg_cron (manual depois do deploy):
//   SELECT cron.schedule('sinais-batch-hourly', '0 * * * *',
//     $$ SELECT net.http_post(
//       url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/sinais-batch',
//       headers := jsonb_build_object('x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
//       timeout_milliseconds := 150000
//     ); $$
//   );

import { createClient } from 'npm:@supabase/supabase-js@^2';
import { authorizeCronOrStaff, corsHeaders } from '../_shared/auth.ts';

// Cada extração faz 1 LLM (~3-5s); concorrência baixa pra não estourar rate limit.
const CONCURRENCY = 3;
const PAGE = 500;
// Janela: só varre calls recentes (o histórico antigo sem transcript não interessa).
const DIAS = 14;

interface CallRow {
  id: string;
  customer_user_id: string | null;
  farmer_id: string | null;
  transcript: unknown;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const selfUrl = `${Deno.env.get('SUPABASE_URL')!}/functions/v1/extrair-sinais-ligacao`;
  const cronSecret = Deno.env.get('CRON_SECRET') ?? '';
  if (!cronSecret) {
    console.warn('[sinais-batch] CRON_SECRET ausente; as chamadas à edge alvo serão rejeitadas');
  }

  const cutoff = new Date(Date.now() - DIAS * 24 * 60 * 60 * 1000).toISOString();

  // 1. Pagina calls com transcript e SEM extração (sinais_ligacao IS NULL → usa o índice parcial).
  const alvos: CallRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('farmer_calls')
      .select('id, customer_user_id, farmer_id, transcript')
      .is('sinais_ligacao', null)
      .not('transcript', 'is', null)
      .gte('started_at', cutoff)
      .order('started_at', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const rows = (data ?? []) as CallRow[];
    for (const r of rows) {
      if (r.customer_user_id && r.farmer_id && r.transcript) alvos.push(r);
    }
    if (rows.length < PAGE) break;
  }

  // 2. Fan-out concorrente. Idempotência é na edge alvo (não re-extrai o mesmo hash).
  let extraidos = 0;
  let pulados = 0;
  let erros = 0;
  for (let i = 0; i < alvos.length; i += CONCURRENCY) {
    const chunk = alvos.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (a) => {
        try {
          const r = await fetch(selfUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-cron-secret': cronSecret },
            body: JSON.stringify({
              callId: a.id,
              transcript: a.transcript,
              customerUserId: a.customer_user_id,
              farmerId: a.farmer_id,
            }),
          });
          const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
          if (j.ok) extraidos++;
          else if (j.skipped) pulados++;
          else erros++;
        } catch {
          erros++;
        }
      }),
    );
  }

  return new Response(
    JSON.stringify({ ok: true, alvos: alvos.length, extraidos, pulados, erros }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
