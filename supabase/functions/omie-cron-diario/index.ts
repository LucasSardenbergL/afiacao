// Edge Function: omie-cron-diario
// Roda a cada 2h (jobid 52, `15 */2 * * *`) os syncs incrementais Omie (3 dias) para a empresa
// configurada. Tolera falhas individuais. Cada etapa tem timeout próprio. Retry 1x em 425.
//
// ⚠️ STEP_TIMEOUT_MS corta só o CLIENTE (este orquestrador). As edges Omie commitam por
// página/item e seguem rodando server-side em BACKGROUND até o guard interno delas
// (nfes ~130s, pedidos idem) — bem além dos 25s. Por isso um step que
// estoura o timeout é reportado modo:"background" (NÃO falha): foi disparado, mas o
// resultado não foi coletado. CONFIRME o efeito por contagem no banco, nunca por
// resultados[step].ok. Provado por efeito em 2026-06-27 (ver docs/agent/sync.md).
//
// ⚠️ O `omie-sync-sku-items` NÃO é step daqui desde 2026-09-24 — tem cron PRÓPRIO
// (`afiacao_omie_oben_sku_items_2h`, `35 */2 * * *`, dias=3) além do diário das 07:00 (jobid 53).
// Como 4º step ele repetia, segundos depois, a MESMA `ConsultarRecebimento(nIdReceb)` que o step
// NFe acabara de fazer para toda NFe da janela; a Omie respondia "Consumo redundante detectado.
// Aguarde ~50 segundos (REDUNDANT)", que não cabe no guard de 50s dele — 46 runs `error` e 6
// e-mails falsos em 30 dias (docs/historico/sku-items-consumo-redundante-no-ciclo.md). 20 minutos
// depois do step NFe a chamada deixa de ser redundante. Não o devolva para esta lista.

import {
  classificarSonda,
  EDGE,
  EFEITO,
  erroSondaAmbigua,
  FONTE,
  respostaSonda,
  VERSAO,
} from "./versao.ts";

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
  // "respondido" = recebeu resposta HTTP (ok reflete o status); "background" = abortado no
  // cliente pelo STEP_TIMEOUT_MS, edge segue server-side (NÃO é falha, resultado não coletado);
  // "erro" = erro de transporte antes de qualquer resposta.
  modo?: "respondido" | "background" | "erro";
  status?: number;
  duracao_ms: number;
  body?: unknown;
  erro?: string;
  nota?: string;
  coletado?: boolean;
  retried_425?: boolean;
};

async function callFunction(name: string, body: Record<string, unknown>): Promise<StepResult> {
  const start = Date.now();
  const ctrl = new AbortController();
  // Distingue "o NOSSO timeout de cliente disparou" de um erro genuíno (rede/boot).
  let abortadoPorTimeoutCliente = false;
  const timer = setTimeout(() => {
    abortadoPorTimeoutCliente = true;
    ctrl.abort();
  }, STEP_TIMEOUT_MS);
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
    return { ok: res.ok, modo: "respondido", status: res.status, duracao_ms: Date.now() - start, body: parsed };
  } catch (e) {
    clearTimeout(timer);
    if (abortadoPorTimeoutCliente) {
      // Cortado pelo NOSSO AbortController (STEP_TIMEOUT_MS), não por falha da edge.
      // A edge commita por página/item e segue em background até o guard interno dela.
      // NÃO é falha (ok:true), mas o resultado NÃO foi coletado (coletado:false) →
      // confirmar o efeito por contagem no banco.
      return {
        ok: true,
        modo: "background",
        coletado: false,
        duracao_ms: Date.now() - start,
        nota: "abortado no cliente (STEP_TIMEOUT_MS); edge segue server-side ate o guard interno — confirmar por contagem no banco",
      };
    }
    return { ok: false, modo: "erro", duracao_ms: Date.now() - start, erro: (e as Error).message };
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

// `versao/edge/fonte` em TODA resposta, não só na da sonda: o jobid 52 chama esta edge DIRETO, e o
// corpo que ele deixa em `net._http_response` a cada 2h prova o deploy sem invocar nada (versao.ts).
function jsonRes(corpo: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ ...corpo, versao: VERSAO, edge: EDGE, fonte: FONTE }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function authorizeCronOrStaff(req: Request): Promise<boolean> {
  const CRON_SEC = Deno.env.get("CRON_SECRET");
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret && CRON_SEC && cronSecret === CRON_SEC) return true;
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice(7);
  if (token === SERVICE_ROLE) return true;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: authHeader, apikey: SERVICE_ROLE },
    });
    if (!userRes.ok) return false;
    const user = await userRes.json();
    if (!user?.id) return false;
    const roleRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${user.id}&select=role`,
      { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } },
    );
    if (!roleRes.ok) return false;
    const roles = (await roleRes.json()) as Array<{ role: string }>;
    const allowed = new Set(["employee", "master"]);
    return roles.some((r) => allowed.has(r.role));
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!(await authorizeCronOrStaff(req))) {
    return jsonRes({ error: "Unauthorized" }, 401);
  }

  // ⚠️ SONDA — logo após o gate (que já aceita x-cron-secret) e ANTES do primeiro step: cada step
  // chama uma edge que ESCREVE, e o ciclo paga cota Omie. O corpo é lido UMA vez, aqui; o fluxo
  // real abaixo reaproveita esta leitura (req.json() é one-shot). Ver versao.ts.
  const body: { empresa?: unknown } = await req.json().catch(() => ({}));
  const decisaoSonda = classificarSonda(body);
  if (decisaoSonda.tipo === "sonda") return jsonRes(respostaSonda(VERSAO), 200);
  // Fail-CLOSED: `probe` com valor não reconhecido NUNCA cai no ciclo real por omissão.
  if (decisaoSonda.tipo === "ambiguo") {
    return jsonRes({ error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
  }

  const t0 = Date.now();
  const empresa = typeof body?.empresa === "string" ? body.empresa : "OBEN";

  const resultados: Record<string, StepResult> = {};
  const dias = 3;

  const steps: Array<{ key: string; name: string; body: Record<string, unknown> }> = [
    // trigger:"cron" → a edge detecta o caminho cron pelo BODY (o orquestrador chama via service_role e NÃO
    // repassa x-cron-secret p/ a filha) e decide AUTO incremental×completo (marcador de cadência), em vez do
    // default manual (completo sempre). Sem isto o heartbeat #1081 também marcava "manual". O step segue
    // abortando em 25s (a edge continua server-side); ela é SÍNCRONA de propósito — responder cedo soltaria
    // este step e os seguintes (nfes/ctes/sku) antes do espelho de pedidos → órfãs. (Codex 2026-06-26)
    { key: "pedidos",   name: "omie-sync-pedidos-compra", body: { empresa, dias, trigger: "cron" } },
    { key: "nfes",      name: "omie-sync-nfes-recebidas", body: { empresa, dias } },
    { key: "ctes",      name: "omie-sync-ctes-recebidos", body: { empresa, dias } },
    // sku_items NÃO entra (REDUNDANT com o step nfes — ver o cabeçalho): cron próprio no :35.
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
    // OBEN: wrapper instrumentado (cria run + grava log antes→depois p/ resumo do dia + reverter).
    // Demais empresas: core direta (aplica com fusível/trava/validação, sem log — v1 é OBEN-only).
    const r2 = empresa.toUpperCase() === "OBEN"
      ? await callRpc("aplicar_parametros_automatico_diario", { p_empresa: "OBEN" })
      : await callRpc("atualizar_parametros_numericos_skus", { p_empresa: empresa });
    resultados["reclassificacao"] = {
      ok: r1.ok && r2.ok,
      duracao_ms: r1.duracao_ms + r2.duracao_ms,
      body: { classificacao: r1, parametros: r2 },
    };
  } else {
    resultados["reclassificacao"] = { ok: false, duracao_ms: 0, erro: "abortado_total_timeout" };
  }

  return jsonRes({
    ok: true,
    empresa,
    duracao_total_ms: Date.now() - t0,
    resultados,
  });
});
