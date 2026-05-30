// A3 — Inteligência de Valor (Cockpit cliente/produto). Módulo puro, espelhado verbatim
// na edge function Deno supabase/functions/fin-valor-cockpit/index.ts.

export function margemContribuicao(input: { receita_liquida: number; custo_unitario: number | null; quantidade: number }): number | null {
  if (input.custo_unitario == null || !Number.isFinite(input.custo_unitario)) return null;
  return input.receita_liquida - input.custo_unitario * input.quantidade;
}

function diasEntre(a: string, b: string): number {
  return Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / 86400000);
}
function maxData(a: string, b: string): string { return a >= b ? a : b; }
function minData(a: string, b: string): string { return a <= b ? a : b; }

// Liquidação por STATUS (o vocabulário real do banco: 'A VENCER'/'ATRASADO'/'VENCE HOJE'
// = aberto; 'RECEBIDO'/'PAGO'/'LIQUIDADO' = liquidado). A coluna data_recebimento é
// sempre NULL no LIST do Omie → não dá pra usar como sinal de liquidação.
const STATUS_LIQUIDADO_AR = ['RECEBIDO', 'LIQUIDADO', 'PAGO'];
export function statusLiquidadoAR(status: string | null | undefined): boolean {
  return !!status && STATUS_LIQUIDADO_AR.includes(status);
}

export type TituloAR = {
  valor_documento: number; saldo: number; valor_recebido: number;
  data_emissao: string | null;
  data_vencimento: string | null;
  // baixa REAL derivada de v_titulo_baixas (NÃO a coluna base data_recebimento, sempre NULL)
  data_baixa_derivada: string | null;
  status: string;
};

export type ARMedioResult = {
  ar_medio: number;    // saldo médio em aberto (time-weighted) na janela
  v_real: number;      // Σ valor_documento liquidado fechado por baixa derivada REAL (que contribuiu)
  v_proxy: number;     // Σ valor_documento liquidado fechado por vencimento (proxy, sem baixa)
  v_sem_fecho: number; // Σ valor_documento liquidado SEM baixa nem vencimento (excluído da AR)
};

// Saldo médio em aberto (time-weighted) na janela [ttm_inicio, ttm_fim).
// Liquidação por STATUS (a coluna data_recebimento é sempre NULL); o FECHAMENTO do título
// liquidado vem da baixa derivada (v_titulo_baixas) ou, na falta, do VENCIMENTO (proxy
// marcado em v_proxy — NÃO excluir, que reduziria a AR e inflaria o EVP = otimista).
// Liquidado contribui `valor_documento` (face que esteve em aberto); `saldo` é cheio/enganoso
// p/ liquidado (#396). Aberto contribui `saldo` (fallback doc−recebido se saldo estranho).
// v_real/v_proxy só contam títulos que de fato contribuem na janela (dias>0) → cobertura limpa.
export function arMedioTTM(input: { titulos: TituloAR[]; ttm_inicio: string; ttm_fim: string }): ARMedioResult {
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
      if (fecho == null) { v_sem_fecho += t.valor_documento; continue; } // sabe QUE quitou, não QUANDO
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

export type ComboInput = { cliente: string; sku: string; receita_liquida: number; quantidade: number; custo_unitario: number | null };
export type CapitalCliente = { cliente: string; ar_medio: number | null };
export type CapitalSKU = { sku: string; estoque_valor: number | null };
export type CelulaEVP = {
  cliente: string; sku: string; receita_liquida: number; quantidade: number;
  cm: number | null; a_cs: number; i_cs: number; encargo: number; evp: number | null;
  ar_indisponivel: boolean; estoque_indisponivel: boolean;
};
// `encargo` = encargo de capital SÓ das células com cm conhecido (mantém a identidade evp = cm − encargo).
// `encargo_total` = encargo de TODAS as células (inclui as de margem desconhecida) — transparência.
export type RollupCliente = { cliente: string; receita: number; cm: number | null; encargo: number; encargo_total: number; evp: number | null };
export type RollupSKU = { sku: string; receita: number; quantidade: number; cm: number | null; encargo: number; encargo_total: number; evp: number | null };
export type ComboEVPResult = {
  celulas: CelulaEVP[];
  porCliente: RollupCliente[];
  porSKU: RollupSKU[];
  empresa: { receita: number; cm: number | null; encargo: number; encargo_total: number; evp: number | null };
};

export function montarCelulasComboEVP(input: {
  combos: ComboInput[];
  capitalClientes: CapitalCliente[];
  capitalSKUs: CapitalSKU[];
  k: number;
}): ComboEVPResult {
  const arPorCliente = new Map(input.capitalClientes.map((c) => [c.cliente, c.ar_medio]));
  const estoquePorSKU = new Map(input.capitalSKUs.map((s) => [s.sku, s.estoque_valor]));
  // totais pra alocação
  const receitaPorCliente = new Map<string, number>();
  const qtdPorSKU = new Map<string, number>();
  for (const c of input.combos) {
    receitaPorCliente.set(c.cliente, (receitaPorCliente.get(c.cliente) ?? 0) + c.receita_liquida);
    qtdPorSKU.set(c.sku, (qtdPorSKU.get(c.sku) ?? 0) + c.quantidade);
  }

  const celulas: CelulaEVP[] = input.combos.map((c) => {
    const cm = margemContribuicao({ receita_liquida: c.receita_liquida, custo_unitario: c.custo_unitario, quantidade: c.quantidade });
    const arC = arPorCliente.get(c.cliente) ?? null;
    const estS = estoquePorSKU.get(c.sku) ?? null;
    const rc = receitaPorCliente.get(c.cliente) ?? 0;
    const qs = qtdPorSKU.get(c.sku) ?? 0;
    // Indisponível se não há base OU se o denominador da alocação é ≤ 0 (não dá pra alocar honestamente).
    const ar_indisponivel = arC == null || rc <= 0;
    const estoque_indisponivel = estS == null || qs <= 0;
    const a_cs = arC != null && rc > 0 ? arC * (c.receita_liquida / rc) : 0;
    const i_cs = estS != null && qs > 0 ? estS * (c.quantidade / qs) : 0;
    const encargo = input.k * (a_cs + i_cs);
    const evp = cm == null ? null : cm - encargo;
    return { cliente: c.cliente, sku: c.sku, receita_liquida: c.receita_liquida, quantidade: c.quantidade, cm, a_cs, i_cs, encargo, evp, ar_indisponivel, estoque_indisponivel };
  });

  const rollup = (keyFn: (c: CelulaEVP) => string) => {
    const m = new Map<string, { receita: number; quantidade: number; cm: number; cmNull: boolean; encargo: number; encargoTotal: number; evp: number; evpNull: boolean }>();
    for (const cel of celulas) {
      const key = keyFn(cel);
      const acc = m.get(key) ?? { receita: 0, quantidade: 0, cm: 0, cmNull: true, encargo: 0, encargoTotal: 0, evp: 0, evpNull: true };
      acc.receita += cel.receita_liquida;
      acc.quantidade += cel.quantidade;
      acc.encargoTotal += cel.encargo; // todas as células
      if (cel.cm != null) {
        acc.cm += cel.cm; acc.cmNull = false;
        acc.encargo += cel.encargo;     // encargo relevante ao EVP (só células com cm)
      }
      if (cel.evp != null) { acc.evp += cel.evp; acc.evpNull = false; }
      m.set(key, acc);
    }
    return m;
  };

  const mc = rollup((c) => c.cliente);
  const ms = rollup((c) => c.sku);
  const porCliente: RollupCliente[] = [...mc.entries()].map(([cliente, a]) => ({ cliente, receita: a.receita, cm: a.cmNull ? null : a.cm, encargo: a.encargo, encargo_total: a.encargoTotal, evp: a.evpNull ? null : a.evp }));
  const porSKU: RollupSKU[] = [...ms.entries()].map(([sku, a]) => ({ sku, receita: a.receita, quantidade: a.quantidade, cm: a.cmNull ? null : a.cm, encargo: a.encargo, encargo_total: a.encargoTotal, evp: a.evpNull ? null : a.evp }));

  let cmEmp = 0, cmNull = true, encEmp = 0, encTotalEmp = 0, evpEmp = 0, evpNull = true, recEmp = 0;
  for (const cel of celulas) {
    recEmp += cel.receita_liquida;
    encTotalEmp += cel.encargo;
    if (cel.cm != null) { cmEmp += cel.cm; cmNull = false; encEmp += cel.encargo; }
    if (cel.evp != null) { evpEmp += cel.evp; evpNull = false; }
  }
  return { celulas, porCliente, porSKU, empresa: { receita: recEmp, cm: cmNull ? null : cmEmp, encargo: encEmp, encargo_total: encTotalEmp, evp: evpNull ? null : evpEmp } };
}

export type CockpitConfig = {
  margem_minima_pct: number;
  desconto_max_pct: number;
  prazo_alvo_dias: number;
  dias_estoque_max: number;
  sample_min_receita: number;
};
export type Recomendacao = { acao: string; motivo: string; impacto_rs: number | null };

export function recomendarAcaoComercial(input: {
  evp: number | null;
  receita_liquida: number;
  cm: number | null;
  desconto_total: number;
  prazo_medio_dias: number;
  dias_estoque: number;
  config: CockpitConfig;
}): Recomendacao[] {
  const r: Recomendacao[] = [];
  const c = input.config;
  const receitaBruta = input.receita_liquida + input.desconto_total;
  const descontoPct = receitaBruta > 0 ? input.desconto_total / receitaBruta : 0;
  const cmPct = input.cm != null && input.receita_liquida > 0 ? input.cm / input.receita_liquida : null;

  // cortar desconto: desconto acima do máx e valor não justifica (EVP baixo/negativo)
  if (descontoPct > c.desconto_max_pct && (input.evp == null || input.evp <= 0)) {
    const recupera = input.desconto_total - receitaBruta * c.desconto_max_pct;
    r.push({ acao: 'Cortar desconto', motivo: `Desconto ${(descontoPct * 100).toFixed(0)}% > máx ${(c.desconto_max_pct * 100).toFixed(0)}% e o combo não gera valor.`, impacto_rs: Math.max(0, recupera) });
  }
  // encurtar prazo: prazo acima do alvo e EVP negativo
  if (input.prazo_medio_dias > c.prazo_alvo_dias && (input.evp == null || input.evp < 0)) {
    r.push({ acao: 'Encurtar prazo / exigir antecipado', motivo: `Prazo médio ${input.prazo_medio_dias.toFixed(0)}d > alvo ${c.prazo_alvo_dias}d puxa o custo de capital de giro.`, impacto_rs: null });
  }
  // subir preço: margem% abaixo da mínima
  if (cmPct != null && cmPct < c.margem_minima_pct) {
    const alvoCM = c.margem_minima_pct * input.receita_liquida;
    r.push({ acao: 'Subir preço', motivo: `Margem ${(cmPct * 100).toFixed(0)}% < mínima ${(c.margem_minima_pct * 100).toFixed(0)}%.`, impacto_rs: Math.max(0, alvoCM - (input.cm as number)) });
  }
  // despriorizar/liquidar SKU: estoque alto + EVP negativo
  if (input.dias_estoque > c.dias_estoque_max && (input.evp == null || input.evp < 0)) {
    r.push({ acao: 'Despriorizar / liquidar estoque', motivo: `${input.dias_estoque.toFixed(0)} dias de estoque > limite ${c.dias_estoque_max}d e o item não gera valor.`, impacto_rs: null });
  }
  // crescer: EVP positivo e nada disparou
  if (r.length === 0 && input.evp != null && input.evp > 0) {
    r.push({ acao: 'Crescer / proteger', motivo: 'Gera valor econômico positivo e sem alertas.', impacto_rs: null });
  }
  return r;
}

export type ConfiancaCockpit = { nivel: 'alta' | 'media' | 'baixa'; motivos: string[] };

export function scoreConfiancaCockpit(input: {
  cobertura_receita: number;     // [0,1] receita order_items ÷ receita-AR do período
  custo_ausente_pct: number;     // [0,1] células sem custo
  ar_indisponivel_pct: number;   // [0,1] células sem AR joinável
  estoque_ausente_pct: number;   // [0,1] SKUs sem estoque/cmc
  imposto_estimado: boolean;
}): ConfiancaCockpit {
  const motivos: string[] = [];
  let nivel = 3; // 3 alta, 2 media, 1 baixa
  const rebaixar = (para: number, m: string) => { if (para < nivel) nivel = para; motivos.push(m); };

  if (input.cobertura_receita < 0.6) rebaixar(1, `Cobertura de receita ${(input.cobertura_receita * 100).toFixed(0)}% — muita venda fora do app; cockpit parcial.`);
  else if (input.cobertura_receita < 0.85) rebaixar(2, `Cobertura de receita ${(input.cobertura_receita * 100).toFixed(0)}% (ideal ≥85%).`);

  if (input.custo_ausente_pct > 0.4) rebaixar(1, `${(input.custo_ausente_pct * 100).toFixed(0)}% das células sem custo — margem indisponível em boa parte.`);
  else if (input.custo_ausente_pct > 0.15) rebaixar(2, `${(input.custo_ausente_pct * 100).toFixed(0)}% sem custo cadastrado.`);

  if (input.ar_indisponivel_pct > 0.3) rebaixar(2, `${(input.ar_indisponivel_pct * 100).toFixed(0)}% das vendas sem AR vinculável — encargo de cliente subestimado.`);
  if (input.estoque_ausente_pct > 0.3) rebaixar(2, `${(input.estoque_ausente_pct * 100).toFixed(0)}% dos SKUs sem estoque — encargo de SKU subestimado.`);
  if (input.imposto_estimado) motivos.push('Imposto alocado nível-empresa (estimado), não por linha.');

  return { nivel: nivel === 3 ? 'alta' : nivel === 2 ? 'media' : 'baixa', motivos };
}
