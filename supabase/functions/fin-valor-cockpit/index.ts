// supabase/functions/fin-valor-cockpit/index.ts
// A3 — Cockpit de Valor (Oben). Gate: master OU commercial_role gerencial/estrategico/super_admin.
// Helpers espelhados VERBATIM de src/lib/financeiro/valor-cockpit-helpers.ts.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

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

// Gate: master (user_roles) OU gestor comercial (commercial_roles gerencial/estrategico/super_admin).
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

// ===== Helpers espelhados (verbatim de valor-cockpit-helpers.ts) =====
function margemContribuicao(input: { receita_liquida: number; custo_unitario: number | null; quantidade: number }): number | null {
  if (input.custo_unitario == null || !Number.isFinite(input.custo_unitario)) return null;
  return input.receita_liquida - input.custo_unitario * input.quantidade;
}
function diasEntre(a: string, b: string): number { return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000); }
function maxData(a: string, b: string): string { return a >= b ? a : b; }
function minData(a: string, b: string): string { return a <= b ? a : b; }
type TituloAR = { valor_documento: number; saldo: number; data_emissao: string | null; data_recebimento: string | null; status: string };
function arMedioTTM(input: { titulos: TituloAR[]; ttm_inicio: string; ttm_fim: string }): number {
  const janelaDias = diasEntre(input.ttm_inicio, input.ttm_fim);
  if (janelaDias <= 0) return 0;
  let soma = 0;
  for (const t of input.titulos) {
    if (!t.data_emissao) continue;
    const inicioOpen = maxData(t.data_emissao, input.ttm_inicio);
    const fimOpen = t.data_recebimento ? minData(t.data_recebimento, input.ttm_fim) : input.ttm_fim;
    const dias = diasEntre(inicioOpen, fimOpen);
    if (dias <= 0) continue;
    soma += (t.data_recebimento ? t.valor_documento : t.saldo) * dias;
  }
  return soma / janelaDias;
}
type ComboInput = { cliente: string; sku: string; receita_liquida: number; quantidade: number; custo_unitario: number | null };
type CapitalCliente = { cliente: string; ar_medio: number | null };
type CapitalSKU = { sku: string; estoque_valor: number | null };
function montarCelulasComboEVP(input: { combos: ComboInput[]; capitalClientes: CapitalCliente[]; capitalSKUs: CapitalSKU[]; k: number }) {
  const arPorCliente = new Map(input.capitalClientes.map((c) => [c.cliente, c.ar_medio]));
  const estoquePorSKU = new Map(input.capitalSKUs.map((s) => [s.sku, s.estoque_valor]));
  const receitaPorCliente = new Map<string, number>();
  const qtdPorSKU = new Map<string, number>();
  for (const c of input.combos) {
    receitaPorCliente.set(c.cliente, (receitaPorCliente.get(c.cliente) ?? 0) + c.receita_liquida);
    qtdPorSKU.set(c.sku, (qtdPorSKU.get(c.sku) ?? 0) + c.quantidade);
  }
  const celulas = input.combos.map((c) => {
    const cm = margemContribuicao({ receita_liquida: c.receita_liquida, custo_unitario: c.custo_unitario, quantidade: c.quantidade });
    const arC = arPorCliente.get(c.cliente) ?? null;
    const estS = estoquePorSKU.get(c.sku) ?? null;
    const rc = receitaPorCliente.get(c.cliente) ?? 0;
    const qs = qtdPorSKU.get(c.sku) ?? 0;
    const a_cs = arC != null && rc > 0 ? arC * (c.receita_liquida / rc) : 0;
    const i_cs = estS != null && qs > 0 ? estS * (c.quantidade / qs) : 0;
    const encargo = input.k * (a_cs + i_cs);
    const evp = cm == null ? null : cm - encargo;
    return { cliente: c.cliente, sku: c.sku, receita_liquida: c.receita_liquida, quantidade: c.quantidade, cm, a_cs, i_cs, encargo, evp, ar_indisponivel: arC == null, estoque_indisponivel: estS == null };
  });
  type Cel = typeof celulas[number];
  const rollup = (keyFn: (c: Cel) => string) => {
    const m = new Map<string, { receita: number; quantidade: number; cm: number; cmNull: boolean; encargo: number; evp: number; evpNull: boolean }>();
    for (const cel of celulas) {
      const key = keyFn(cel);
      const acc = m.get(key) ?? { receita: 0, quantidade: 0, cm: 0, cmNull: true, encargo: 0, evp: 0, evpNull: true };
      acc.receita += cel.receita_liquida; acc.quantidade += cel.quantidade;
      if (cel.cm != null) { acc.cm += cel.cm; acc.cmNull = false; }
      acc.encargo += cel.encargo;
      if (cel.evp != null) { acc.evp += cel.evp; acc.evpNull = false; }
      m.set(key, acc);
    }
    return m;
  };
  const mc = rollup((c) => c.cliente);
  const ms = rollup((c) => c.sku);
  const porCliente = [...mc.entries()].map(([cliente, a]) => ({ cliente, receita: a.receita, cm: a.cmNull ? null : a.cm, encargo: a.encargo, evp: a.evpNull ? null : a.evp }));
  const porSKU = [...ms.entries()].map(([sku, a]) => ({ sku, receita: a.receita, quantidade: a.quantidade, cm: a.cmNull ? null : a.cm, encargo: a.encargo, evp: a.evpNull ? null : a.evp }));
  let cmEmp = 0, cmNull = true, encEmp = 0, evpEmp = 0, evpNull = true, recEmp = 0;
  for (const cel of celulas) { recEmp += cel.receita_liquida; encEmp += cel.encargo; if (cel.cm != null) { cmEmp += cel.cm; cmNull = false; } if (cel.evp != null) { evpEmp += cel.evp; evpNull = false; } }
  return { celulas, porCliente, porSKU, empresa: { receita: recEmp, cm: cmNull ? null : cmEmp, encargo: encEmp, evp: evpNull ? null : evpEmp } };
}
type CockpitConfig = { margem_minima_pct: number; desconto_max_pct: number; prazo_alvo_dias: number; dias_estoque_max: number; sample_min_receita: number };
type Recomendacao = { acao: string; motivo: string; impacto_rs: number | null };
function recomendarAcaoComercial(input: { evp: number | null; receita_liquida: number; cm: number | null; desconto_total: number; prazo_medio_dias: number; dias_estoque: number; config: CockpitConfig }): Recomendacao[] {
  const r: Recomendacao[] = []; const c = input.config;
  const receitaBruta = input.receita_liquida + input.desconto_total;
  const descontoPct = receitaBruta > 0 ? input.desconto_total / receitaBruta : 0;
  const cmPct = input.cm != null && input.receita_liquida > 0 ? input.cm / input.receita_liquida : null;
  if (descontoPct > c.desconto_max_pct && (input.evp == null || input.evp <= 0)) r.push({ acao: "Cortar desconto", motivo: `Desconto ${(descontoPct * 100).toFixed(0)}% > máx ${(c.desconto_max_pct * 100).toFixed(0)}% e o combo não gera valor.`, impacto_rs: Math.max(0, input.desconto_total - receitaBruta * c.desconto_max_pct) });
  if (input.prazo_medio_dias > c.prazo_alvo_dias && (input.evp == null || input.evp < 0)) r.push({ acao: "Encurtar prazo / exigir antecipado", motivo: `Prazo médio ${input.prazo_medio_dias.toFixed(0)}d > alvo ${c.prazo_alvo_dias}d puxa o custo de capital de giro.`, impacto_rs: null });
  if (cmPct != null && cmPct < c.margem_minima_pct) r.push({ acao: "Subir preço", motivo: `Margem ${(cmPct * 100).toFixed(0)}% < mínima ${(c.margem_minima_pct * 100).toFixed(0)}%.`, impacto_rs: Math.max(0, c.margem_minima_pct * input.receita_liquida - (input.cm as number)) });
  if (input.dias_estoque > c.dias_estoque_max && (input.evp == null || input.evp < 0)) r.push({ acao: "Despriorizar / liquidar estoque", motivo: `${input.dias_estoque.toFixed(0)} dias de estoque > limite ${c.dias_estoque_max}d e o item não gera valor.`, impacto_rs: null });
  if (r.length === 0 && input.evp != null && input.evp > 0) r.push({ acao: "Crescer / proteger", motivo: "Gera valor econômico positivo e sem alertas.", impacto_rs: null });
  return r;
}
function scoreConfiancaCockpit(input: { cobertura_receita: number; custo_ausente_pct: number; ar_indisponivel_pct: number; estoque_ausente_pct: number; imposto_estimado: boolean }) {
  const motivos: string[] = []; let nivel = 3;
  const rebaixar = (para: number, m: string) => { if (para < nivel) nivel = para; motivos.push(m); };
  if (input.cobertura_receita < 0.6) rebaixar(1, `Cobertura de receita ${(input.cobertura_receita * 100).toFixed(0)}% — muita venda fora do app; cockpit parcial.`);
  else if (input.cobertura_receita < 0.85) rebaixar(2, `Cobertura de receita ${(input.cobertura_receita * 100).toFixed(0)}% (ideal ≥85%).`);
  if (input.custo_ausente_pct > 0.4) rebaixar(1, `${(input.custo_ausente_pct * 100).toFixed(0)}% das células sem custo — margem indisponível em boa parte.`);
  else if (input.custo_ausente_pct > 0.15) rebaixar(2, `${(input.custo_ausente_pct * 100).toFixed(0)}% sem custo cadastrado.`);
  if (input.ar_indisponivel_pct > 0.3) rebaixar(2, `${(input.ar_indisponivel_pct * 100).toFixed(0)}% das vendas sem AR vinculável — encargo de cliente subestimado.`);
  if (input.estoque_ausente_pct > 0.3) rebaixar(2, `${(input.estoque_ausente_pct * 100).toFixed(0)}% dos SKUs sem estoque — encargo de SKU subestimado.`);
  if (input.imposto_estimado) motivos.push("Imposto alocado nível-empresa (estimado), não por linha.");
  return { nivel: (nivel === 3 ? "alta" : nivel === 2 ? "media" : "baixa") as "alta" | "media" | "baixa", motivos };
}

// ===== Orquestração =====
const COMPANY = "oben";
const CONFIG_DEFAULT: CockpitConfig = { margem_minima_pct: 0.15, desconto_max_pct: 0.10, prazo_alvo_dias: 30, dias_estoque_max: 120, sample_min_receita: 5000 };

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const auth = await authorizeGestorOuMaster(req);
  if (!auth.ok) return auth.response;
  const db = createClient(SUPABASE_URL, SERVICE_ROLE);

  const now = new Date();
  const ttm_fim = now.toISOString().slice(0, 10);
  const ttm_inicio = new Date(now.getTime() - 365 * 86400000).toISOString().slice(0, 10);

  // WACC (A2) — reusa fin_valor_inputs.ke.base; fallback default se ausente.
  const { data: viRow } = await db.from("fin_valor_inputs").select("valor_inputs").eq("company", COMPANY).maybeSingle();
  const vi = ((viRow as { valor_inputs?: Record<string, unknown> } | null)?.valor_inputs ?? {}) as Record<string, unknown>;
  const keBase = (vi.ke as Record<string, unknown> | undefined)?.base as Record<string, unknown> | undefined;
  const k = keBase ? (Number(keBase.ancora || 0) + Number(keBase.premio_risco_equity || 0) + Number(keBase.premio_tamanho_private || 0) + Number(keBase.premio_iliquidez_controle || 0)) : 0.20;

  // Config (limiares)
  const { data: cfgRow } = await db.from("fin_config_cashflow").select("cockpit_config").eq("company", COMPANY).maybeSingle();
  const cfgRaw = ((cfgRow as { cockpit_config?: Record<string, unknown> } | null)?.cockpit_config ?? {}) as Record<string, unknown>;
  const numOr = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x)) ? Number(x) : d);
  const config: CockpitConfig = {
    margem_minima_pct: numOr(cfgRaw.margem_minima_pct, CONFIG_DEFAULT.margem_minima_pct),
    desconto_max_pct: numOr(cfgRaw.desconto_max_pct, CONFIG_DEFAULT.desconto_max_pct),
    prazo_alvo_dias: numOr(cfgRaw.prazo_alvo_dias, CONFIG_DEFAULT.prazo_alvo_dias),
    dias_estoque_max: numOr(cfgRaw.dias_estoque_max, CONFIG_DEFAULT.dias_estoque_max),
    sample_min_receita: numOr(cfgRaw.sample_min_receita, CONFIG_DEFAULT.sample_min_receita),
  };

  // 1) Linhas de venda TTM (order_items × sales_orders pra data) — paginado simples (limite alto).
  const { data: orders } = await db.from("sales_orders").select("id, created_at").gte("created_at", ttm_inicio);
  const orderIds = (orders ?? []).map((o: { id: string }) => o.id);
  if (orderIds.length === 0) return jsonResponse({ company: COMPANY, vazio: true, motivo: "Sem pedidos no TTM." }, 200);
  const { data: items } = await db.from("order_items").select("sales_order_id, customer_user_id, product_id, omie_codigo_produto, quantity, unit_price, discount").in("sales_order_id", orderIds);
  const linhas = (items ?? []) as Array<{ customer_user_id: string; product_id: string | null; omie_codigo_produto: number | null; quantity: number; unit_price: number; discount: number | null }>;

  // 2) Mapas de apoio
  const userIds = [...new Set(linhas.map((l) => l.customer_user_id))];
  const productIds = [...new Set(linhas.map((l) => l.product_id).filter(Boolean) as string[])];
  const { data: clientes } = await db.from("omie_clientes").select("user_id, omie_codigo_cliente").in("user_id", userIds);
  const userToOmie = new Map((clientes ?? []).map((c: { user_id: string; omie_codigo_cliente: number }) => [c.user_id, String(c.omie_codigo_cliente)]));
  const { data: custos } = await db.from("product_costs").select("product_id, cost_price").in("product_id", productIds);
  const custoPorProduto = new Map((custos ?? []).map((c: { product_id: string; cost_price: number }) => [c.product_id, c.cost_price]));
  const { data: estoque } = await db.from("inventory_position").select("omie_codigo_produto, saldo, cmc, account");
  const estoquePorSKU = new Map((estoque ?? []).filter((e: { account: string }) => e.account === COMPANY || e.account === "vendas").map((e: { omie_codigo_produto: number; saldo: number; cmc: number }) => [String(e.omie_codigo_produto), { saldo: e.saldo, cmc: e.cmc }]));

  // 3) Combos cliente×SKU
  const comboMap = new Map<string, { cliente: string; sku: string; receita: number; qtd: number; desconto: number; product_id: string | null }>();
  for (const l of linhas) {
    const cliente = userToOmie.get(l.customer_user_id) ?? "sem_cliente";
    const sku = l.omie_codigo_produto != null ? String(l.omie_codigo_produto) : "sem_sku";
    const key = `${cliente}|${sku}`;
    const receita = l.unit_price * l.quantity - (l.discount ?? 0);
    const acc = comboMap.get(key) ?? { cliente, sku, receita: 0, qtd: 0, desconto: 0, product_id: l.product_id };
    acc.receita += receita; acc.qtd += l.quantity; acc.desconto += (l.discount ?? 0);
    comboMap.set(key, acc);
  }
  const combos: ComboInput[] = [...comboMap.values()].map((c) => ({ cliente: c.cliente, sku: c.sku, receita_liquida: c.receita, quantidade: c.qtd, custo_unitario: c.product_id ? (custoPorProduto.get(c.product_id) ?? null) : null }));

  // 4) Capital por cliente (AR médio TTM) e por SKU (estoque)
  const omieCods = [...new Set(combos.map((c) => c.cliente).filter((c) => c !== "sem_cliente"))];
  const { data: crs } = await db.from("fin_contas_receber").select("omie_codigo_cliente, valor_documento, saldo, data_emissao, data_recebimento, status_titulo").eq("company", COMPANY).in("omie_codigo_cliente", omieCods.map(Number));
  const titulosPorCliente = new Map<string, TituloAR[]>();
  for (const t of (crs ?? []) as Array<{ omie_codigo_cliente: number; valor_documento: number; saldo: number; data_emissao: string | null; data_recebimento: string | null; status_titulo: string }>) {
    const key = String(t.omie_codigo_cliente);
    const arr = titulosPorCliente.get(key) ?? [];
    arr.push({ valor_documento: t.valor_documento, saldo: t.saldo, data_emissao: t.data_emissao, data_recebimento: t.data_recebimento, status: t.status_titulo });
    titulosPorCliente.set(key, arr);
  }
  const capitalClientes: CapitalCliente[] = [...new Set(combos.map((c) => c.cliente))].map((cliente) => ({
    cliente,
    ar_medio: cliente === "sem_cliente" ? null : (titulosPorCliente.has(cliente) ? arMedioTTM({ titulos: titulosPorCliente.get(cliente)!, ttm_inicio, ttm_fim }) : null),
  }));
  const capitalSKUs: CapitalSKU[] = [...new Set(combos.map((c) => c.sku))].map((sku) => {
    const e = estoquePorSKU.get(sku);
    return { sku, estoque_valor: e ? e.saldo * e.cmc : null };
  });

  // 5) Monta EVP
  const res = montarCelulasComboEVP({ combos, capitalClientes, capitalSKUs, k });

  // 6) Recomendações por cliente (usa PMR médio do cliente como prazo; desconto agregado)
  const descontoPorCliente = new Map<string, number>();
  for (const c of [...comboMap.values()]) descontoPorCliente.set(c.cliente, (descontoPorCliente.get(c.cliente) ?? 0) + c.desconto);
  const recomendacoesCliente = res.porCliente.map((rc) => ({
    cliente: rc.cliente,
    recomendacoes: recomendarAcaoComercial({ evp: rc.evp, receita_liquida: rc.receita, cm: rc.cm, desconto_total: descontoPorCliente.get(rc.cliente) ?? 0, prazo_medio_dias: 0, dias_estoque: 0, config }),
  }));

  // 7) Confiança
  const total = res.celulas.length || 1;
  const custo_ausente_pct = res.celulas.filter((c) => c.cm == null).length / total;
  const ar_indisponivel_pct = res.celulas.filter((c) => c.ar_indisponivel).length / total;
  const estoque_ausente_pct = res.celulas.filter((c) => c.estoque_indisponivel).length / total;
  // cobertura de receita: receita do cockpit ÷ receita-AR total da Oben no TTM
  const { data: arTotalRows } = await db.from("fin_contas_receber").select("valor_documento").eq("company", COMPANY).gte("data_emissao", ttm_inicio);
  const arTotal = (arTotalRows ?? []).reduce((s: number, t: { valor_documento: number }) => s + (t.valor_documento || 0), 0);
  const cobertura_receita = arTotal > 0 ? Math.min(1, res.empresa.receita / arTotal) : 1;
  const confianca = scoreConfiancaCockpit({ cobertura_receita, custo_ausente_pct, ar_indisponivel_pct, estoque_ausente_pct, imposto_estimado: true });

  return jsonResponse({
    company: COMPANY, k, ttm: { inicio: ttm_inicio, fim: ttm_fim },
    porCliente: res.porCliente, porSKU: res.porSKU, empresa: res.empresa,
    recomendacoesCliente, confianca, cobertura_receita, config,
  }, 200);
});
