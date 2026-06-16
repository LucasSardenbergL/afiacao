// supabase/functions/fin-next-best-action/index.ts
// A4 — Próxima Melhor Ação. Gate gestor+master. Compõe A1/A2/A3 via service_role.
// Helper espelhado VERBATIM de src/lib/financeiro/next-best-action-helpers.ts.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function unauthorized(m = "Unauthorized"): Response { return jsonResponse({ error: m }, 401); }

async function authorizeGestorOuMaster(req: Request): Promise<{ ok: true } | { ok: false; response: Response }> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return { ok: false, response: unauthorized() };
  const token = authHeader.slice(7);
  if (token === SERVICE_ROLE) return { ok: true };
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: authHeader, apikey: SERVICE_ROLE } });
    if (!userRes.ok) return { ok: false, response: unauthorized() };
    const user = await userRes.json();
    if (!user?.id) return { ok: false, response: unauthorized() };
    const roleRes = await fetch(`${SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${user.id}&select=role`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } });
    const roles = roleRes.ok ? (await roleRes.json()) as Array<{ role: string }> : [];
    if (roles.some((r) => r.role === "master")) return { ok: true };
    const comRes = await fetch(`${SUPABASE_URL}/rest/v1/commercial_roles?user_id=eq.${user.id}&select=commercial_role`, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } });
    const com = comRes.ok ? (await comRes.json()) as Array<{ commercial_role: string }> : [];
    const gestor = new Set(["gerencial", "estrategico", "super_admin"]);
    if (com.some((c) => gestor.has(c.commercial_role))) return { ok: true };
    return { ok: false, response: unauthorized("Forbidden — gestor comercial ou master") };
  } catch { return { ok: false, response: unauthorized() }; }
}

// ===== Helper espelhado (verbatim de next-best-action-helpers.ts) =====
type StatusAcao = "financiar_ja" | "financiar_condicional" | "consertar_antes" | "falta_dado" | "nao_financiar";
type TipoAcao = "consertar_valor" | "liberar_caixa" | "crescer" | "benchmark";
function caixaDisponivel(input: { saldo_tesouraria: number; dias_cobertura: number; reserva_dias_min: number; confianca_baixa: boolean }): number {
  if (input.dias_cobertura <= 0) return 0;
  const fracaoReserva = Math.min(1, input.reserva_dias_min / input.dias_cobertura);
  let disp = input.saldo_tesouraria * (1 - fracaoReserva);
  if (input.confianca_baixa) disp *= 0.5;
  return Math.max(0, disp);
}
function classificarStatus(input: { tipo: TipoAcao; impacto_eva: number | null; spread_positivo: boolean | null; caixa_consumido: number | null; caixa_disponivel: number; hurdle: number | null; tem_dado: boolean }): StatusAcao {
  if (!input.tem_dado) return "falta_dado";
  if (input.tipo === "benchmark") return "nao_financiar";
  if (input.tipo === "consertar_valor" || input.tipo === "liberar_caixa") return "consertar_antes";
  if (input.tipo === "crescer") {
    if (input.spread_positivo !== true) return "nao_financiar";
    if (input.caixa_consumido == null || input.caixa_consumido <= 0) return "falta_dado"; // crescer SEMPRE consome caixa (NCG): custo ≤0 é dado implausível, não "grátis"
    return input.caixa_consumido <= input.caixa_disponivel ? "financiar_ja" : "financiar_condicional";
  }
  return "falta_dado";
}
type AcaoCandidata = { empresa: string; descricao: string; tipo: TipoAcao; impacto_eva: number | null; caixa_consumido: number | null; payback_meses: number | null; spread_positivo: boolean | null; confianca: "alta" | "media" | "baixa" };
type AcaoFila = AcaoCandidata & { hurdle: number | null; status: StatusAcao };
const PRIORIDADE_TIPO: Record<TipoAcao, number> = { consertar_valor: 0, liberar_caixa: 1, crescer: 2, benchmark: 3 };
function montarFilaAcoes(input: { candidatos: AcaoCandidata[]; caixaPorEmpresa: Record<string, { disponivel: number; confianca: "alta" | "media" | "baixa" }>; hurdlePorEmpresa: Record<string, number> }) {
  const candidatos = [...input.candidatos];
  candidatos.push({ empresa: "—", descricao: "Não fazer nada / pagar dívida / distribuir ao dono (benchmark do hurdle)", tipo: "benchmark", impacto_eva: null, caixa_consumido: 0, payback_meses: null, spread_positivo: null, confianca: "alta" });
  const fila: AcaoFila[] = candidatos.map((c) => {
    const hurdleRaw = c.empresa in input.hurdlePorEmpresa ? input.hurdlePorEmpresa[c.empresa] : null;
    const hurdle = hurdleRaw != null && Number.isFinite(hurdleRaw) && hurdleRaw > 0 ? hurdleRaw : null; // hurdle ≤0 implausível → tratado como ausente (crescer cai em falta_dado)
    const caixaDisp = input.caixaPorEmpresa[c.empresa]?.disponivel ?? 0;
    const tem_dado = c.tipo === "crescer" ? (hurdle != null && c.spread_positivo != null) : true;
    const status = classificarStatus({ tipo: c.tipo, impacto_eva: c.impacto_eva, spread_positivo: c.spread_positivo, caixa_consumido: c.caixa_consumido, caixa_disponivel: caixaDisp, hurdle, tem_dado });
    return { ...c, hurdle, status };
  });
  fila.sort((a, b) => {
    if (PRIORIDADE_TIPO[a.tipo] !== PRIORIDADE_TIPO[b.tipo]) return PRIORIDADE_TIPO[a.tipo] - PRIORIDADE_TIPO[b.tipo];
    // "ausente ≠ R$0": custo null não é grátis (bucket 2, por último) e EVA null não vira ratio 0.
    const custoBucket = (x: AcaoFila) => x.caixa_consumido === 0 ? 0 : (x.caixa_consumido != null && x.caixa_consumido > 0 ? 1 : 2);
    const cbA = custoBucket(a), cbB = custoBucket(b);
    if (cbA !== cbB) return cbA - cbB;
    const ratio = (x: AcaoFila) => x.caixa_consumido != null && x.caixa_consumido > 0 && x.impacto_eva != null ? x.impacto_eva / x.caixa_consumido : null;
    const rA = ratio(a), rB = ratio(b);
    if (rA != null && rB != null) { if (rA !== rB) return rB - rA; }
    else if (rA != null) return -1;
    else if (rB != null) return 1;
    return (a.payback_meses ?? Infinity) - (b.payback_meses ?? Infinity);
  });
  const motivos: string[] = []; let nivel: "alta" | "media" | "baixa" = "alta";
  const rebaixa = (n: "media" | "baixa", m: string) => { if (n === "baixa" || nivel === "alta") nivel = n; motivos.push(m); };
  if (fila.some((a) => a.status === "falta_dado")) rebaixa("media", "Algumas ações sem hurdle/cockpit (Falta dado).");
  if (fila.some((a) => a.confianca === "baixa")) rebaixa("media", "Inclui ação de confiança baixa (ex.: sleeve company-level sem cockpit granular).");
  if (Object.values(input.caixaPorEmpresa).some((c) => c.confianca === "baixa")) rebaixa("baixa", "Projeção de caixa de alguma empresa com confiança baixa.");
  return { fila, caixa_por_empresa: input.caixaPorEmpresa, confianca: { nivel: nivel as "alta" | "media" | "baixa", motivos }, gerado_em: new Date().toISOString() };
}

// ===== Orquestração: chama A1/A2/A3 via service_role =====
const EMPRESAS = ["oben", "colacor", "colacor_sc"];
const RESERVA_DIAS_MIN = 21; // ~3 semanas de cobertura como piso

async function invoke<T>(fn: string, body: unknown): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000); // 20s por function — não trava a fila inteira
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SERVICE_ROLE}`, apikey: SERVICE_ROLE, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch { return null; } finally { clearTimeout(timer); }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const auth = await authorizeGestorOuMaster(req);
  if (!auth.ok) return auth.response;

  const caixaPorEmpresa: Record<string, { disponivel: number; confianca: "alta" | "media" | "baixa" }> = {};
  const hurdlePorEmpresa: Record<string, number> = {};
  const candidatos: AcaoCandidata[] = [];
  const falhas: string[] = [];

  // Paralelo: A1+A2 das 3 empresas + A3 (cockpit Oben) ao mesmo tempo (uma function lenta não trava as outras).
  const [cashResults, valorResults, cockpit] = await Promise.all([
    Promise.all(EMPRESAS.map((e) => invoke<{ indicadores?: { dias_cobertura?: number; saldo_tesouraria?: number } }>("fin-cashflow-engine", { company: e }))),
    Promise.all(EMPRESAS.map((e) => invoke<{ reportado?: { wacc?: number | null; spread?: number | null } }>("fin-valor-engine", { company: e }))),
    invoke<{ recomendacoesCliente?: Array<{ cliente: string; recomendacoes: Array<{ acao: string; motivo: string; impacto_rs: number | null }> }> }>("fin-valor-cockpit", {}),
  ]);

  EMPRESAS.forEach((empresa, i) => {
    const cash = cashResults[i];
    if (cash == null) falhas.push(`caixa (${empresa})`);
    const dias = cash?.indicadores?.dias_cobertura ?? 0;
    const saldo = cash?.indicadores?.saldo_tesouraria ?? 0;
    const cashConfBaixa = cash == null;
    caixaPorEmpresa[empresa] = {
      disponivel: caixaDisponivel({ saldo_tesouraria: saldo, dias_cobertura: dias, reserva_dias_min: RESERVA_DIAS_MIN, confianca_baixa: cashConfBaixa }),
      confianca: cashConfBaixa ? "baixa" : "alta",
    };
    const valor = valorResults[i];
    if (valor == null) falhas.push(`valor/hurdle (${empresa})`);
    const wacc = valor?.reportado?.wacc ?? null;
    if (wacc != null) hurdlePorEmpresa[empresa] = wacc;
    const spread = valor?.reportado?.spread ?? null;
    // Sleeve company-level (sem cockpit granular): crescer sem custo estimado → cai em 'falta_dado'.
    if (empresa !== "oben") {
      candidatos.push({
        empresa, descricao: `${empresa} — sleeve de crescimento (definir ação concreta: margem/NCG/payback)`,
        tipo: "crescer", impacto_eva: null, caixa_consumido: null, payback_meses: null,
        spread_positivo: spread != null ? spread > 0 : null, confianca: "baixa",
      });
    }
  });

  // A3 (Oben): recomendações de cliente viram ações. Vocabulário CONTROLADO da A3 (5 ações fixas).
  if (cockpit == null) falhas.push("cockpit Oben (A3)");
  for (const rc of cockpit?.recomendacoesCliente ?? []) {
    for (const rec of rc.recomendacoes) {
      const acaoLower = rec.acao.toLowerCase();
      const tipo: TipoAcao = acaoLower.includes("prazo") || acaoLower.includes("antecip") ? "liberar_caixa"
        : acaoLower.includes("crescer") ? "crescer"
        : "consertar_valor"; // cortar desconto / subir preço / despriorizar = consertar valor (custo de caixa ~0)
      candidatos.push({
        empresa: "oben", descricao: `Oben — ${rec.acao} (cliente ${rc.cliente})`,
        // crescer consome caixa via NCG mas A3 não estima o ticket → null → 'falta_dado' (dimensionar antes).
        tipo, impacto_eva: rec.impacto_rs, caixa_consumido: tipo === "crescer" ? null : 0, payback_meses: null,
        spread_positivo: tipo === "crescer" ? true : null, confianca: "alta",
      });
    }
  }

  const result = montarFilaAcoes({ candidatos, caixaPorEmpresa, hurdlePorEmpresa });
  // Degradação honesta: insumo interno falhou → rebaixa a confiança (pior dos dois) e diz o quê.
  if (falhas.length > 0) {
    const rank = { alta: 3, media: 2, baixa: 1 } as const;
    const piso: "media" | "baixa" = falhas.length >= 3 ? "baixa" : "media";
    const nivel = rank[result.confianca.nivel] <= rank[piso] ? result.confianca.nivel : piso;
    result.confianca = { nivel, motivos: [...result.confianca.motivos, `Insumos indisponíveis (function falhou): ${falhas.join(", ")} — fila parcial.`] };
  }
  return jsonResponse(result, 200);
});
