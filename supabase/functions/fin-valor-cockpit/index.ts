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
function numOrNull(x: unknown): number | null {
  if (x == null || typeof x === "boolean" || Array.isArray(x)) return null;
  if (typeof x !== "number" && typeof x !== "string") return null;
  if (typeof x === "string" && x.trim() === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
// Hurdle (Ke) do cockpit, de fin_valor_inputs.ke.base. Ausente/inválido → null (NÃO fabrica 0.20).
function resolverHurdleCockpit(vi: Record<string, unknown> | null | undefined): number | null {
  const ke = ((vi?.ke as Record<string, unknown> | undefined)?.base) as Record<string, unknown> | undefined;
  if (!ke) return null;
  const ancora = numOrNull(ke.ancora);
  if (ancora == null) return null;
  const soma = ancora
    + (numOrNull(ke.premio_risco_equity) ?? 0)
    + (numOrNull(ke.premio_tamanho_private) ?? 0)
    + (numOrNull(ke.premio_iliquidez_controle) ?? 0);
  return Number.isFinite(soma) && soma > 0 ? soma : null;
}
function diasEntre(a: string, b: string): number { return Math.round((new Date(b + "T00:00:00Z").getTime() - new Date(a + "T00:00:00Z").getTime()) / 86400000); }
function maxData(a: string, b: string): string { return a >= b ? a : b; }
function minData(a: string, b: string): string { return a <= b ? a : b; }
// Espelho VERBATIM de valor-cockpit-helpers.ts (Fase 3 baixa derivada).
const STATUS_LIQUIDADO_AR = ['RECEBIDO', 'LIQUIDADO', 'PAGO'];
function statusLiquidadoAR(status: string | null | undefined): boolean {
  return !!status && STATUS_LIQUIDADO_AR.includes(status);
}
// Faturabilidade do pedido pai — espelha v_caca (deleted_at IS NULL AND status <> ALL(['cancelado','rascunho'])).
// Blocklist semântica: status conhecido novo CONTA por default; cancelado/rascunho/soft-deletado/NULL não.
const STATUS_NAO_FATURAVEL = ['cancelado', 'rascunho'];
function pedidoContaNoFaturamento(status: string | null | undefined, deletedAt: string | null | undefined): boolean {
  if (deletedAt != null) return false;
  if (status == null) return false;
  return !STATUS_NAO_FATURAVEL.includes(status);
}
// Faturabilidade do TÍTULO de AR (denominador de cobertura_receita) — contraparte de
// pedidoContaNoFaturamento. Exclui só status_titulo='CANCELADO' (2,66% do arTotal Oben; estorno/dup/
// outra-conta = 0 no AR, psql-ro 2026-06-18). NÃO filtra por status do PEDIDO (vínculo título→pedido
// parcial e desacoplado). NULL → CONTA (assimétrico vs o numerador): conservador é NÃO superestimar a cobertura.
const STATUS_TITULO_NAO_FATURAVEL = ['CANCELADO'];
function tituloFaturavelAR(statusTitulo: string | null | undefined): boolean {
  return statusTitulo == null ? true : !STATUS_TITULO_NAO_FATURAVEL.includes(statusTitulo);
}
// Dois sinais de cobertura (proxy direcional). ar_por_app = cobertura_receita histórica; app_por_ar
// = venda do app com AR faturável. Divisor 0 / não-finito → 1 (não fabrica penalidade). Espelho de src.
function coberturaBidirecional(input: { receita: number; arFaturavel: number }): { ar_por_app: number; app_por_ar: number } {
  const r = input.receita, a = input.arFaturavel;
  if (!Number.isFinite(r) || !Number.isFinite(a)) return { ar_por_app: 1, app_por_ar: 1 };
  return {
    ar_por_app: a > 0 ? Math.min(1, r / a) : 1,
    app_por_ar: r > 0 ? Math.min(1, a / r) : 1,
  };
}
type TituloAR = {
  valor_documento: number; saldo: number; valor_recebido: number;
  data_emissao: string | null; data_vencimento: string | null;
  data_baixa_derivada: string | null; status: string;
};
type ARMedioResult = { ar_medio: number; v_real: number; v_proxy: number; v_sem_fecho: number };
function arMedioTTM(input: { titulos: TituloAR[]; ttm_inicio: string; ttm_fim: string }): ARMedioResult {
  const janelaDias = diasEntre(input.ttm_inicio, input.ttm_fim);
  if (janelaDias <= 0) return { ar_medio: 0, v_real: 0, v_proxy: 0, v_sem_fecho: 0 };
  let soma = 0, v_real = 0, v_proxy = 0, v_sem_fecho = 0;
  for (const t of input.titulos) {
    if (!t.data_emissao) continue;
    const liquidado = statusLiquidadoAR(t.status);
    const inicioOpen = maxData(t.data_emissao, input.ttm_inicio);
    let fimOpen: string;
    let valor: number;
    let real = false;
    if (liquidado) {
      const fecho = t.data_baixa_derivada ?? t.data_vencimento ?? null;
      if (fecho == null) { v_sem_fecho += t.valor_documento; continue; }
      fimOpen = minData(fecho, input.ttm_fim);
      valor = t.valor_documento;
      real = !!t.data_baixa_derivada;
    } else {
      fimOpen = input.ttm_fim;
      valor = (Number.isFinite(t.saldo) && t.saldo > 0) ? t.saldo : Math.max(0, t.valor_documento - (t.valor_recebido || 0));
    }
    const dias = Math.max(0, diasEntre(inicioOpen, fimOpen));
    if (dias <= 0) continue;
    soma += valor * dias;
    if (liquidado) { if (real) v_real += t.valor_documento; else v_proxy += t.valor_documento; }
  }
  return { ar_medio: soma / janelaDias, v_real, v_proxy, v_sem_fecho };
}
type ComboInput = { cliente: string; sku: string; receita_liquida: number; quantidade: number; custo_unitario: number | null };
type CapitalCliente = { cliente: string; ar_medio: number | null };
type CapitalSKU = { sku: string; estoque_valor: number | null };
function montarCelulasComboEVP(input: { combos: ComboInput[]; capitalClientes: CapitalCliente[]; capitalSKUs: CapitalSKU[]; k: number | null }) {
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
    const ar_indisponivel = arC == null || rc <= 0;
    const estoque_indisponivel = estS == null || qs <= 0;
    const a_cs = arC != null && rc > 0 ? arC * (c.receita_liquida / rc) : 0;
    const i_cs = estS != null && qs > 0 ? estS * (c.quantidade / qs) : 0;
    const encargo: number | null = input.k == null ? null : input.k * (a_cs + i_cs);
    const evp = cm == null || encargo == null ? null : cm - encargo;
    return { cliente: c.cliente, sku: c.sku, receita_liquida: c.receita_liquida, quantidade: c.quantidade, cm, a_cs, i_cs, encargo, evp, ar_indisponivel, estoque_indisponivel };
  });
  type Cel = typeof celulas[number];
  const rollup = (keyFn: (c: Cel) => string) => {
    const m = new Map<string, { receita: number; quantidade: number; cm: number; cmNull: boolean; encargo: number; encargoNull: boolean; encargoTotal: number; encargoTotalNull: boolean; evp: number; evpNull: boolean }>();
    for (const cel of celulas) {
      const key = keyFn(cel);
      const acc = m.get(key) ?? { receita: 0, quantidade: 0, cm: 0, cmNull: true, encargo: 0, encargoNull: true, encargoTotal: 0, encargoTotalNull: true, evp: 0, evpNull: true };
      acc.receita += cel.receita_liquida; acc.quantidade += cel.quantidade;
      if (cel.encargo != null) { acc.encargoTotal += cel.encargo; acc.encargoTotalNull = false; }
      if (cel.cm != null) { acc.cm += cel.cm; acc.cmNull = false; if (cel.encargo != null) { acc.encargo += cel.encargo; acc.encargoNull = false; } }
      if (cel.evp != null) { acc.evp += cel.evp; acc.evpNull = false; }
      m.set(key, acc);
    }
    return m;
  };
  const mc = rollup((c) => c.cliente);
  const ms = rollup((c) => c.sku);
  const porCliente = [...mc.entries()].map(([cliente, a]) => ({ cliente, receita: a.receita, cm: a.cmNull ? null : a.cm, encargo: a.encargoNull ? null : a.encargo, encargo_total: a.encargoTotalNull ? null : a.encargoTotal, evp: a.evpNull ? null : a.evp }));
  const porSKU = [...ms.entries()].map(([sku, a]) => ({ sku, receita: a.receita, quantidade: a.quantidade, cm: a.cmNull ? null : a.cm, encargo: a.encargoNull ? null : a.encargo, encargo_total: a.encargoTotalNull ? null : a.encargoTotal, evp: a.evpNull ? null : a.evp }));
  let cmEmp = 0, cmNull = true, encEmp = 0, encNull = true, encTotalEmp = 0, encTotalNull = true, evpEmp = 0, evpNull = true, recEmp = 0;
  for (const cel of celulas) { recEmp += cel.receita_liquida; if (cel.encargo != null) { encTotalEmp += cel.encargo; encTotalNull = false; } if (cel.cm != null) { cmEmp += cel.cm; cmNull = false; if (cel.encargo != null) { encEmp += cel.encargo; encNull = false; } } if (cel.evp != null) { evpEmp += cel.evp; evpNull = false; } }
  return { celulas, porCliente, porSKU, empresa: { receita: recEmp, cm: cmNull ? null : cmEmp, encargo: encNull ? null : encEmp, encargo_total: encTotalNull ? null : encTotalEmp, evp: evpNull ? null : evpEmp } };
}
type CockpitConfig = { margem_minima_pct: number; desconto_max_pct: number; prazo_alvo_dias: number; dias_estoque_max: number; sample_min_receita: number };
type Recomendacao = { acao: string; motivo: string; impacto_rs: number | null };
function recomendarAcaoComercial(input: { evp: number | null; receita_liquida: number; cm: number | null; desconto_total: number; prazo_medio_dias: number; dias_estoque: number; config: CockpitConfig; hurdle_indisponivel?: boolean }): Recomendacao[] {
  const r: Recomendacao[] = []; const c = input.config;
  const receitaBruta = input.receita_liquida + input.desconto_total;
  const descontoPct = receitaBruta > 0 ? input.desconto_total / receitaBruta : 0;
  const cmPct = input.cm != null && input.receita_liquida > 0 ? input.cm / input.receita_liquida : null;
  const evpConhecivel = !input.hurdle_indisponivel;
  if (descontoPct > c.desconto_max_pct && (!evpConhecivel || input.evp == null || input.evp <= 0)) r.push({ acao: "Cortar desconto", motivo: evpConhecivel ? `Desconto ${(descontoPct * 100).toFixed(0)}% > máx ${(c.desconto_max_pct * 100).toFixed(0)}% e o combo não gera valor.` : `Desconto ${(descontoPct * 100).toFixed(0)}% > máx ${(c.desconto_max_pct * 100).toFixed(0)}% — lucro econômico indisponível (configure o hurdle p/ confirmar).`, impacto_rs: Math.max(0, input.desconto_total - receitaBruta * c.desconto_max_pct) });
  if (evpConhecivel && input.prazo_medio_dias > c.prazo_alvo_dias && (input.evp == null || input.evp < 0)) r.push({ acao: "Encurtar prazo / exigir antecipado", motivo: `Prazo médio ${input.prazo_medio_dias.toFixed(0)}d > alvo ${c.prazo_alvo_dias}d puxa o custo de capital de giro.`, impacto_rs: null });
  if (cmPct != null && cmPct < c.margem_minima_pct) r.push({ acao: "Subir preço", motivo: `Margem ${(cmPct * 100).toFixed(0)}% < mínima ${(c.margem_minima_pct * 100).toFixed(0)}%.`, impacto_rs: Math.max(0, c.margem_minima_pct * input.receita_liquida - (input.cm as number)) });
  if (evpConhecivel && input.dias_estoque > c.dias_estoque_max && (input.evp == null || input.evp < 0)) r.push({ acao: "Despriorizar / liquidar estoque", motivo: `${input.dias_estoque.toFixed(0)} dias de estoque > limite ${c.dias_estoque_max}d e o item não gera valor.`, impacto_rs: null });
  if (r.length === 0 && input.evp != null && input.evp > 0) r.push({ acao: "Crescer / proteger", motivo: "Gera valor econômico positivo e sem alertas.", impacto_rs: null });
  // aviso de hurdle ausente vive na confiança + banner da UI (NÃO por cliente — vazaria pro A4).
  return r;
}
function scoreConfiancaCockpit(input: { cobertura_receita: number; custo_ausente_pct: number; ar_indisponivel_pct: number; estoque_ausente_pct: number; imposto_estimado: boolean; hurdle_indisponivel?: boolean; cobertura_app_por_ar?: number }) {
  const motivos: string[] = []; let nivel = 3;
  const rebaixar = (para: number, m: string) => { if (para < nivel) nivel = para; motivos.push(m); };
  if (input.hurdle_indisponivel) rebaixar(1, "Sem Ke/hurdle configurado — lucro econômico (EVP) indisponível; configure em /financeiro/valor.");
  if (input.cobertura_receita < 0.6) rebaixar(1, `Cobertura de receita ${(input.cobertura_receita * 100).toFixed(0)}% — muita venda fora do app; cockpit parcial.`);
  else if (input.cobertura_receita < 0.85) rebaixar(2, `Cobertura de receita ${(input.cobertura_receita * 100).toFixed(0)}% (ideal ≥85%).`);
  if (input.cobertura_app_por_ar != null && input.cobertura_app_por_ar < 0.5) rebaixar(2, `${((1 - input.cobertura_app_por_ar) * 100).toFixed(0)}% da venda do app sem AR faturável — encargo de cliente subestimado; possível divergência app↔financeiro.`);
  if (input.custo_ausente_pct > 0.4) rebaixar(1, `${(input.custo_ausente_pct * 100).toFixed(0)}% das células sem custo — margem indisponível em boa parte.`);
  else if (input.custo_ausente_pct > 0.15) rebaixar(2, `${(input.custo_ausente_pct * 100).toFixed(0)}% sem custo cadastrado.`);
  if (input.ar_indisponivel_pct > 0.3) rebaixar(2, `${(input.ar_indisponivel_pct * 100).toFixed(0)}% das vendas sem AR vinculável — encargo de cliente subestimado.`);
  if (input.estoque_ausente_pct > 0.3) rebaixar(2, `${(input.estoque_ausente_pct * 100).toFixed(0)}% dos SKUs sem estoque — encargo de SKU subestimado.`);
  if (input.imposto_estimado) motivos.push("Imposto alocado nível-empresa (estimado), não por linha.");
  return { nivel: (nivel === 3 ? "alta" : nivel === 2 ? "media" : "baixa") as "alta" | "media" | "baixa", motivos };
}

// ===== Orquestração =====
const COMPANY = "oben";
// Ponte de contas de estoque da Oben (paridade com get_preco_cockpit): inventory_position guarda o mesmo
// SKU em 'vendas' (conta Omie crua) e 'oben' (empresa); elegemos entre as duas a linha mais fresca com cmc>0.
const ESTOQUE_ACCOUNTS = ["vendas", "oben"];
const CONFIG_DEFAULT: CockpitConfig = { margem_minima_pct: 0.15, desconto_max_pct: 0.10, prazo_alvo_dias: 30, dias_estoque_max: 120, sample_min_receita: 5000 };

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const auth = await authorizeGestorOuMaster(req);
  if (!auth.ok) return auth.response;
  const db = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Paginação robusta: evita o truncamento silencioso do default ~1000 do PostgREST e propaga erro.
  async function fetchAll<T>(
    build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
    label: string,
  ): Promise<T[]> {
    const page = 1000; let from = 0; const out: T[] = [];
    for (;;) {
      const { data, error } = await build(from, from + page - 1);
      if (error) throw new Error(`${label}: ${error.message}`);
      const rows = data ?? [];
      out.push(...rows);
      if (rows.length < page) break;
      from += page;
    }
    return out;
  }

  const now = new Date();
  const ttm_fim = now.toISOString().slice(0, 10);
  const ttm_inicio = new Date(now.getTime() - 365 * 86400000).toISOString().slice(0, 10);
  // Prefiltro de BUSCA do order_items (created_at = data de CARGA) com 90d de folga antes do ttm_inicio.
  // A janela REAL do cockpit é por order_date_kpi (Bug C, mais abaixo); created_at só LIMITA o fetch.
  // Provado (psql-ro 2026-06-18) que todo item com order_date_kpi na janela tem created_at >= order_date_kpi
  // (0 falso-negativo hoje); a folga de 90d blinda contra pedido pós-datado futuro (created_at < data pedido).
  const ttm_prefetch = new Date(now.getTime() - (365 + 90) * 86400000).toISOString().slice(0, 10);
  // Guard de formato p/ as datas que entram em .or()/.gte() (defesa anti-injeção: só ISO
  // YYYY-MM-DD; aqui vêm de toISOString, mas o guard documenta e blinda contra regressão).
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (!ISO_DATE.test(ttm_inicio) || !ISO_DATE.test(ttm_fim) || !ISO_DATE.test(ttm_prefetch)) {
    return jsonResponse({ error: "janela TTM inválida" }, 500);
  }

  try {
    // WACC (A2) — reusa fin_valor_inputs.ke.base; fallback default se ausente.
    const { data: viRow } = await db.from("fin_valor_inputs").select("valor_inputs").eq("company", COMPANY).maybeSingle();
    const vi = ((viRow as { valor_inputs?: Record<string, unknown> } | null)?.valor_inputs ?? {}) as Record<string, unknown>;
    // Hurdle (Ke) resolvido com guard de ausência (NÃO fabrica 0.20). Null → EVP indisponível.
    const k = resolverHurdleCockpit(vi);
    const hurdle_indisponivel = k == null;

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

    // FILTRO OBEN obrigatório: um pedido do app mistura itens das 3 empresas (Oben/Colacor/Colacor SC),
    // enviados separadamente. Sem o filtro por produto, o cockpit da Oben fica contaminado.
    type Prod = { id: string; omie_codigo_produto: number; account: string };
    const prods = await fetchAll<Prod>((f, t) => db.from("omie_products").select("id, omie_codigo_produto, account").eq("account", COMPANY).order("id", { ascending: true }).range(f, t), "omie_products");
    const obenProductIds = new Set(prods.map((p) => p.id));
    const obenSkus = new Set(prods.map((p) => String(p.omie_codigo_produto)));
    // Bug D: SKU→product_id da Oben p/ recuperar linhas com product_id NULL (gap de FK histórico — 2026-03,
    // app-orders; SKU é oben-exclusivo e ÚNICO: 3660/3660, provado psql-ro). Atribui o produto Oben certo E
    // resolve o custo da recuperada (mesmo product_id da linkada → combo cliente×SKU nunca mistura custo).
    const obenSkuToProductId = new Map(prods.map((p) => [String(p.omie_codigo_produto), p.id]));

    // Linhas candidatas: busca por created_at (prefiltro com folga, ttm_prefetch); a janela REAL é por
    // order_date_kpi do pedido pai (Bug C), aplicada via pedidosNaJanela abaixo.
    type Item = { customer_user_id: string; product_id: string | null; omie_codigo_produto: number | null; quantity: number; unit_price: number; discount: number | null; sales_order_id: string };
    const itemsAll = await fetchAll<Item>((f, t) => db.from("order_items").select("customer_user_id, product_id, omie_codigo_produto, quantity, unit_price, discount, created_at, sales_order_id").gte("created_at", ttm_prefetch).order("id", { ascending: true }).range(f, t), "order_items");
    // Faturabilidade + JANELA: carrega TODOS os pedidos (id,status,deleted_at,order_date_kpi) — ~7k linhas,
    // barato. pedidosNaJanela = faturável (exclui cancelado/rascunho/soft-deletado, régua v_caca) E
    // order_date_kpi ∈ [ttm_inicio, ttm_fim] (Bug C: janela pela DATA DO PEDIDO, não pela carga). SEM filtro
    // de account na faturabilidade (vale p/ qualquer conta); o recorte Oben vem por product_id/SKU abaixo.
    type SalesOrderRow = { id: string; status: string | null; deleted_at: string | null; order_date_kpi: string | null; account: string | null };
    const salesOrdersAll = await fetchAll<SalesOrderRow>((f, t) => db.from("sales_orders").select("id, status, deleted_at, order_date_kpi, account").order("id", { ascending: true }).range(f, t), "sales_orders");
    // order_date_kpi é DATE → comparação de string 'YYYY-MM-DD' é cronológica (mesmo padrão de
    // carteira-positivacao-snapshot). Reúsa a régua UTC que o cockpit já aplica ao AR (ttm_inicio/ttm_fim).
    const pedidosNaJanela = new Set(
      salesOrdersAll
        .filter((so) => pedidoContaNoFaturamento(so.status, so.deleted_at)
          && so.order_date_kpi != null && so.order_date_kpi >= ttm_inicio && so.order_date_kpi <= ttm_fim)
        .map((so) => so.id),
    );
    // Guard de conta p/ a recuperação por SKU (Bug D): só recupera linha cujo pedido-pai é account='oben'
    // — o SKU resolve a produto Oben E o pedido é da Oben. Blinda contra colisão futura de SKU entre contas
    // (Codex P2; hoje 120/120 recuperadas são oben, provado psql-ro). Linha LINKADA não usa isto (product_id já é Oben).
    const pedidosOben = new Set(salesOrdersAll.filter((so) => so.account === COMPANY).map((so) => so.id));
    // Oben por product_id OU (FK ausente → SKU resolve a produto Oben, Bug D). Normaliza ao product_id efetivo
    // (recuperada ganha o id Oben → custo resolve). Pedido fora da janela/não-faturável é descartado aqui.
    const linhas = itemsAll.flatMap((l) => {
      const pid = l.product_id != null
        ? (obenProductIds.has(l.product_id) ? l.product_id : null)
        : (l.omie_codigo_produto != null && pedidosOben.has(l.sales_order_id) ? (obenSkuToProductId.get(String(l.omie_codigo_produto)) ?? null) : null);
      return pid != null && pedidosNaJanela.has(l.sales_order_id) ? [{ ...l, product_id: pid }] : [];
    });
    if (linhas.length === 0) return jsonResponse({ company: COMPANY, vazio: true, motivo: "Sem linhas de venda da Oben no TTM." }, 200);

    // Mapas de apoio (paginados, sem .in para evitar URL gigante + truncamento)
    const clientesAll = await fetchAll<{ user_id: string; omie_codigo_cliente: number }>((f, t) => db.from("omie_clientes").select("user_id, omie_codigo_cliente").order("id", { ascending: true }).range(f, t), "omie_clientes");
    const userToOmie = new Map(clientesAll.map((c) => [c.user_id, String(c.omie_codigo_cliente)]));
    const custosAll = await fetchAll<{ product_id: string; cost_price: number }>((f, t) => db.from("product_costs").select("product_id, cost_price").order("id", { ascending: true }).range(f, t), "product_costs");
    const custoPorProduto = new Map(custosAll.map((c) => [c.product_id, c.cost_price]));
    // Estoque com PONTE DE CONTAS (paridade com get_preco_cockpit / cockpit_preco_fixes): inventory_position
    // guarda o MESMO SKU em 'vendas' (conta Omie crua, omie-analytics-sync) e 'oben' (empresa, sync-reprocess)
    // — mesma fonte Omie, divergindo pelo timing do sync. Busca AS DUAS e elege por SKU a linha com cmc>0 mais
    // FRESCA por SYNCED_AT (frescor da FONTE — NÃO updated_at, que trigger/reprocess tocam; NULLS LAST), igual
    // o cockpit de preço. Resolve a colisão do Map (antes pegava linha arbitrária) e cobre SKU só-em-'vendas'.
    // saldo/cmc são NULLABLE: cmc ausente/≤0/NaN OU saldo ausente/<0 → estoque_valor null (não R$0/negativo —
    // money-path: ausente≠zero; saldo<0 inflaria o EVP). ⚠️ débito pré-existente (Codex): montarCelulasComboEVP
    // trata estoque null como i_cs=0 (encargo subestimado → EVP superestimado p/ SKU sem estoque) — fora do escopo.
    type EstoqueRow = { omie_codigo_produto: number; saldo: number | null; cmc: number | null; synced_at: string | null };
    const estoqueAll = await fetchAll<EstoqueRow>((f, t) => db.from("inventory_position").select("omie_codigo_produto, saldo, cmc, synced_at").in("account", ESTOQUE_ACCOUNTS).order("id", { ascending: true }).range(f, t), "inventory_position");
    const estoqueValorPorSKU = new Map<string, number | null>(); // estoque_valor da linha eleita (null = sem custo/saldo confiável)
    const estoqueFrescPorSKU = new Map<string, number>();
    for (const e of estoqueAll) {
      const sku = String(e.omie_codigo_produto);
      if (!obenSkus.has(sku)) continue;
      if (!(typeof e.cmc === "number" && Number.isFinite(e.cmc) && e.cmc > 0)) continue; // espelha cmc>0 (e <> NaN) do get_preco_cockpit
      const tsRaw = e.synced_at ? Date.parse(e.synced_at) : NaN;
      const fresc = Number.isFinite(tsRaw) ? tsRaw : -Infinity; // synced_at ausente/inválido = menos preferido (NULLS LAST)
      const prev = estoqueFrescPorSKU.get(sku);
      if (prev !== undefined && fresc <= prev) continue; // mantém a mais fresca; empate → 1ª por ordem de id (estável)
      estoqueFrescPorSKU.set(sku, fresc);
      const saldo = typeof e.saldo === "number" && Number.isFinite(e.saldo) && e.saldo >= 0 ? e.saldo : null;
      estoqueValorPorSKU.set(sku, saldo !== null ? saldo * e.cmc : null); // saldo inválido (null/<0/NaN) → null, não 0/negativo
    }

    // Combos cliente×SKU — cliente não-mapeado vira 'app:<uuid>' (NÃO funde clientes distintos).
    const comboMap = new Map<string, { cliente: string; sku: string; receita: number; qtd: number; desconto: number; product_id: string | null }>();
    for (const l of linhas) {
      const cliente = userToOmie.get(l.customer_user_id) ?? `app:${l.customer_user_id}`;
      const sku = l.omie_codigo_produto != null ? String(l.omie_codigo_produto) : "sem_sku";
      const key = `${cliente}|${sku}`;
      const receita = l.unit_price * l.quantity - (l.discount ?? 0);
      const acc = comboMap.get(key) ?? { cliente, sku, receita: 0, qtd: 0, desconto: 0, product_id: l.product_id };
      acc.receita += receita; acc.qtd += l.quantity; acc.desconto += (l.discount ?? 0);
      comboMap.set(key, acc);
    }
    const combos: ComboInput[] = [...comboMap.values()].map((c) => ({ cliente: c.cliente, sku: c.sku, receita_liquida: c.receita, quantidade: c.qtd, custo_unitario: c.product_id ? (custoPorProduto.get(c.product_id) ?? null) : null }));

    // AR da Oben relevante à janela (emitido na janela OU ainda em aberto) — serve p/ AR por cliente e cobertura.
    type CR = { omie_codigo_cliente: number | null; omie_codigo_lancamento: number | null; valor_documento: number; saldo: number; valor_recebido: number; data_emissao: string | null; data_vencimento: string | null; status_titulo: string };
    const crsAll = await fetchAll<CR>((f, t) => db.from("fin_contas_receber").select("omie_codigo_cliente, omie_codigo_lancamento, valor_documento, saldo, valor_recebido, data_emissao, data_vencimento, status_titulo").eq("company", COMPANY).or(`data_recebimento.is.null,data_recebimento.gte.${ttm_inicio},data_emissao.gte.${ttm_inicio}`).order("id", { ascending: true }).range(f, t), "fin_contas_receber");
    // Fase 3: baixa REAL derivada (v_titulo_baixas, tipo CR) por omie_codigo_lancamento.
    type Baixa = { omie_codigo_lancamento: number | null; data_baixa_final: string | null };
    const baixasAll = await fetchAll<Baixa>((f, t) => db.from("v_titulo_baixas").select("omie_codigo_lancamento, data_baixa_final").eq("company", COMPANY).eq("tipo", "CR").order("omie_codigo_lancamento", { ascending: true }).range(f, t), "v_titulo_baixas");
    const baixaPorCod = new Map<number, string>();
    for (const b of baixasAll) { if (b.omie_codigo_lancamento != null && b.data_baixa_final) baixaPorCod.set(Number(b.omie_codigo_lancamento), b.data_baixa_final); }
    const titulosPorCliente = new Map<string, TituloAR[]>();
    for (const cr of crsAll) {
      if (cr.omie_codigo_cliente == null) continue;
      const key = String(cr.omie_codigo_cliente);
      const arr = titulosPorCliente.get(key) ?? [];
      arr.push({
        valor_documento: cr.valor_documento, saldo: cr.saldo, valor_recebido: cr.valor_recebido,
        data_emissao: cr.data_emissao, data_vencimento: cr.data_vencimento,
        data_baixa_derivada: cr.omie_codigo_lancamento != null ? (baixaPorCod.get(Number(cr.omie_codigo_lancamento)) ?? null) : null,
        status: cr.status_titulo,
      });
      titulosPorCliente.set(key, arr);
    }
    // AR por cliente + cobertura GLOBAL da baixa derivada real (gate defensivo, codex).
    let gReal = 0, gProxy = 0, gSem = 0;
    const arPorClienteRaw = new Map<string, number>();
    for (const cliente of new Set(combos.map((c) => c.cliente))) {
      const tts = titulosPorCliente.get(cliente);
      if (!tts) continue;
      const r = arMedioTTM({ titulos: tts, ttm_inicio, ttm_fim });
      arPorClienteRaw.set(cliente, r.ar_medio);
      gReal += r.v_real; gProxy += r.v_proxy; gSem += r.v_sem_fecho;
    }
    const baseCob = gReal + gProxy + gSem;
    const coberturaBaixaAR = baseCob > 0 ? gReal / baseCob : 1; // sem liquidado na janela → não penaliza
    // Gate global: cobertura de baixa derivada real < 80% → AR não-confiável → null (vira
    // ar_indisponivel → scoreConfiancaCockpit rebaixa). Oben ~100% → não dispara; protege
    // expansão futura de escopo (codex: global sozinho pode esconder cliente, mas aqui o
    // escopo é fixo oben; per-cliente fica como v2 — o proxy de vencimento já é exposto).
    const arConfiavel = coberturaBaixaAR >= 0.8;
    if (!arConfiavel) console.warn(`[ValorCockpit][${COMPANY}] cobertura baixa derivada ${(coberturaBaixaAR * 100).toFixed(0)}% < 80% → AR rebaixado a indisponível`);
    const capitalClientes: CapitalCliente[] = [...new Set(combos.map((c) => c.cliente))].map((cliente) => ({
      cliente,
      ar_medio: arConfiavel && arPorClienteRaw.has(cliente) ? arPorClienteRaw.get(cliente)! : null,
    }));
    const capitalSKUs: CapitalSKU[] = [...new Set(combos.map((c) => c.sku))].map((sku) => ({
      sku, estoque_valor: estoqueValorPorSKU.get(sku) ?? null, // 0 legítimo (saldo 0) preservado; ausente/inválido → null
    }));

    const res = montarCelulasComboEVP({ combos, capitalClientes, capitalSKUs, k });

    // Recomendações por cliente. NOTA: prazo_medio_dias/dias_estoque ainda não computados por cliente/SKU
    // (deferido) → as regras de prazo/estoque ficam inertes; as de desconto/preço usam dados reais.
    const descontoPorCliente = new Map<string, number>();
    for (const c of [...comboMap.values()]) descontoPorCliente.set(c.cliente, (descontoPorCliente.get(c.cliente) ?? 0) + c.desconto);
    const recomendacoesCliente = res.porCliente.map((rc) => ({
      cliente: rc.cliente,
      recomendacoes: recomendarAcaoComercial({ evp: rc.evp, receita_liquida: rc.receita, cm: rc.cm, desconto_total: descontoPorCliente.get(rc.cliente) ?? 0, prazo_medio_dias: 0, dias_estoque: 0, config, hurdle_indisponivel }),
    }));

    const total = res.celulas.length || 1;
    const custo_ausente_pct = res.celulas.filter((c) => c.cm == null).length / total;
    const ar_indisponivel_pct = res.celulas.filter((c) => c.ar_indisponivel).length / total;
    const estoque_ausente_pct = res.celulas.filter((c) => c.estoque_indisponivel).length / total;
    // cobertura_receita: receita Oben do cockpit ÷ AR Oben FATURÁVEL emitido no TTM (mesmo crsAll).
    // PROXY DIRECIONAL de confiança, NÃO reconciliação contábil: numerador = receita comercial de
    // itens (unit_price·qty−desc, data do PEDIDO); denominador = valor_documento de títulos AR
    // (impostos/frete/parcelas, data de EMISSÃO), fonte independente (Omie financeiro, sem FK a
    // sales_orders). Nem toda venda vira AR (à vista) e vice-versa → numerador pode exceder o
    // denominador (Oben ~R$5,1M vs ~R$4,2M em 2026-06-18) e a cobertura satura em 1,0 (Math.min);
    // a métrica só detecta "AR sem venda no app", não o inverso. Daí os thresholds largos. Exclui
    // CANCELADO (tituloFaturavelAR) p/ simetria com o numerador (pedidoContaNoFaturamento).
    const arTotal = crsAll.filter((cr) => cr.data_emissao != null && cr.data_emissao >= ttm_inicio && tituloFaturavelAR(cr.status_titulo)).reduce((s, cr) => s + (cr.valor_documento || 0), 0);
    const { ar_por_app, app_por_ar } = coberturaBidirecional({ receita: res.empresa.receita, arFaturavel: arTotal });
    const cobertura_receita = ar_por_app; // retrocompat: mesmo valor de antes
    const confianca = scoreConfiancaCockpit({ cobertura_receita, cobertura_app_por_ar: app_por_ar, custo_ausente_pct, ar_indisponivel_pct, estoque_ausente_pct, imposto_estimado: true, hurdle_indisponivel });

    return jsonResponse({
      company: COMPANY, k, hurdle_indisponivel, ttm: { inicio: ttm_inicio, fim: ttm_fim },
      porCliente: res.porCliente, porSKU: res.porSKU, empresa: res.empresa,
      recomendacoesCliente, confianca, cobertura_receita, cobertura_app_por_ar: app_por_ar,
      cobertura_baixa_ar: coberturaBaixaAR, // Fase 3: fração da AR liquidada com baixa derivada REAL (vs vencimento-proxy)
      config,
    }, 200);
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
