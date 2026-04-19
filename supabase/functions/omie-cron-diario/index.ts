// Edge Function: omie-cron-diario
// Roda diariamente os syncs incrementais Omie (3 dias) para a empresa configurada.
// Tolera falhas individuais. Cada etapa tem timeout próprio. Retry 1x em 425.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const STEP_TIMEOUT_MS = 25_000;
const TOTAL_TIMEOUT_MS = 115_000; // ~2 min teto

type StepResult = {
  ok: boolean;
  status?: number;
  duracao_ms: number;
  body?: unknown;
  erro?: string;
  retried_425?: boolean;
};

async function callFunction(name: string, body: Record<string, unknown>): Promise<StepResult> {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STEP_TIMEOUT_MS);
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_ROLE}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let parsed: unknown = null;
    const text = await res.text();
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    clearTimeout(timer);
    return { ok: res.ok, status: res.status, duracao_ms: Date.now() - start, body: parsed };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, duracao_ms: Date.now() - start, erro: (e as Error).message };
  }
}

async function runStep(name: string, body: Record<string, unknown>): Promise<StepResult> {
  const r = await callFunction(name, body);
  if (r.status === 425) {
    console.log(`[cron-diario] ${name} 425 — aguardando 60s e retry`);
    await new Promise((res) => setTimeout(res, 60_000));
    const r2 = await callFunction(name, body);
    return { ...r2, retried_425: true };
  }
  return r;
}

async function callRpc(fn: string, params: Record<string, unknown>): Promise<StepResult> {
  const start = Date.now();
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
      },
      body: JSON.stringify(params),
    });
    let parsed: unknown = null;
    const text = await res.text();
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { ok: res.ok, status: res.status, duracao_ms: Date.now() - start, body: parsed };
  } catch (e) {
    return { ok: false, duracao_ms: Date.now() - start, erro: (e as Error).message };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const t0 = Date.now();
  let empresa = "OBEN";
  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body && typeof body.empresa === "string") empresa = body.empresa;
    }
  } catch { /* ignore */ }

  const resultados: Record<string, StepResult> = {};
  const dias = 3;

  const steps: Array<{ key: string; name: string; body: Record<string, unknown> }> = [
    { key: "pedidos",   name: "omie-sync-pedidos-compra", body: { empresa, dias } },
    { key: "nfes",      name: "omie-sync-nfes-recebidas", body: { empresa, dias } },
    { key: "ctes",      name: "omie-sync-ctes-recebidos", body: { empresa, dias } },
    { key: "sku_items", name: "omie-sync-sku-items",      body: { empresa, dias } },
    { key: "vendas",    name: "omie-sync-vendas-items",   body: { empresa, dias } },
  ];

  for (const s of steps) {
    if (Date.now() - t0 > TOTAL_TIMEOUT_MS) {
      resultados[s.key] = { ok: false, duracao_ms: 0, erro: "abortado_total_timeout" };
      continue;
    }
    console.log(`[cron-diario] ${s.key} → ${s.name}`);
    try {
      resultados[s.key] = await runStep(s.name, s.body);
    } catch (e) {
      resultados[s.key] = { ok: false, duracao_ms: 0, erro: (e as Error).message };
    }
    await sleep(2000);
  }

  // Reclassificação ABC/XYZ + parâmetros numéricos
  if (Date.now() - t0 < TOTAL_TIMEOUT_MS) {
    const r1 = await callRpc("atualizar_classificacao_skus", { p_empresa: empresa });
    const r2 = await callRpc("atualizar_parametros_numericos_skus", { p_empresa: empresa });
    resultados["reclassificacao"] = {
      ok: r1.ok && r2.ok,
      duracao_ms: r1.duracao_ms + r2.duracao_ms,
      body: { classificacao: r1, parametros: r2 },
    };
  } else {
    resultados["reclassificacao"] = { ok: false, duracao_ms: 0, erro: "abortado_total_timeout" };
  }

  return new Response(
    JSON.stringify({
      ok: true,
      empresa,
      duracao_total_ms: Date.now() - t0,
      resultados,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
  );
});
