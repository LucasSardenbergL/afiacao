// A3 — Inteligência de Valor (Cockpit cliente/produto). Módulo puro, espelhado verbatim
// na edge function Deno supabase/functions/fin-valor-cockpit/index.ts.

export function margemContribuicao(input: { receita_liquida: number; custo_unitario: number | null; quantidade: number }): number | null {
  if (input.custo_unitario == null || !Number.isFinite(input.custo_unitario)) return null;
  if (!Number.isFinite(input.receita_liquida) || !Number.isFinite(input.quantidade)) return null;
  const m = input.receita_liquida - input.custo_unitario * input.quantidade;
  return Number.isFinite(m) ? m : null;
}

function numOrNull(x: unknown): number | null {
  if (x == null || typeof x === 'boolean' || Array.isArray(x)) return null;
  if (typeof x !== 'number' && typeof x !== 'string') return null;
  if (typeof x === 'string' && x.trim() === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// Hurdle (Ke) do cockpit, de fin_valor_inputs.ke.base (âncora + prêmios). Ausente/inválido → null
// (NÃO fabrica 0.20 — "ausente ≠ número", igual ao guard de NCG do A2). Âncora obrigatória; prêmio
// ausente = 0 (prêmio "nenhum" é legítimo); soma não-finita ou ≤ 0 → null (0% = capital grátis).
export function resolverHurdleCockpit(vi: Record<string, unknown> | null | undefined): number | null {
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

// Faturabilidade do pedido pai — espelha VERBATIM a régua de v_caca_candidatos/v_caca_compradores
// (positivação/comissão): WHERE deleted_at IS NULL AND status <> ALL(ARRAY['cancelado','rascunho']).
// Blocklist semântica: status conhecido NOVO (ex.: 'entregue') CONTA por default — não subconta
// silenciosamente (Codex 2026-06-18); cancelado/rascunho, soft-deletado (deleted_at) ou status NULL
// NÃO contam. Sem este guard, o cockpit de valor somava pedidos cancelados como faturamento (um
// outlier de R$615M inflava o TTM da Oben de ~R$5M para ~R$621M).
const STATUS_NAO_FATURAVEL = ['cancelado', 'rascunho'];
export function pedidoContaNoFaturamento(status: string | null | undefined, deletedAt: string | null | undefined): boolean {
  if (deletedAt != null) return false;            // soft-deletado nunca conta
  if (status == null) return false;               // espelha o NULL <> ALL do v_caca (NULL não passa o WHERE)
  return !STATUS_NAO_FATURAVEL.includes(status);  // default-inclui status conhecido novo
}

// Faturabilidade do TÍTULO de AR (denominador de cobertura_receita) — contraparte de
// pedidoContaNoFaturamento (numerador). Exclui só status_titulo='CANCELADO' (medido = 2,66% do
// arTotal Oben, psql-ro 2026-06-18; estorno/duplicata/outra-conta = 0 no AR). NÃO filtra por status
// do PEDIDO: o vínculo título→pedido é parcial (37% sem numero_pedido) e desacoplado (título
// CANCELADO coexiste com pedido vivo). NULL → CONTA (assimétrico vs o numerador, que exclui NULL):
// nos dois lados a escolha conservadora é NÃO superestimar a cobertura — excluir do denominador a infla.
const STATUS_TITULO_NAO_FATURAVEL = ['CANCELADO'];
export function tituloFaturavelAR(statusTitulo: string | null | undefined): boolean {
  return statusTitulo == null ? true : !STATUS_TITULO_NAO_FATURAVEL.includes(statusTitulo);
}

// Dois sinais de cobertura (proxy DIRECIONAL, não reconciliação). ar_por_app = quanto do AR é
// explicado por venda no app (= cobertura_receita histórica); app_por_ar = quanto da venda no app
// tem AR faturável (detecta venda sem AR — ex.: à vista/divergência). Entrada não-finita, receita
// negativa, OU AR faturável ausente (≤0) → {1,1}: indisponível NÃO fabrica penalidade nem %
// absurda (money-path; AR=0 pode ser fonte vazia/quebrada, não "100% sem AR" — Codex 2026-06-18).
export function coberturaBidirecional(input: { receita: number; arFaturavel: number }): { ar_por_app: number; app_por_ar: number } {
  const r = input.receita, a = input.arFaturavel;
  if (!Number.isFinite(r) || !Number.isFinite(a) || r < 0 || a <= 0) return { ar_por_app: 1, app_por_ar: 1 };
  return {
    ar_por_app: Math.min(1, r / a),
    app_por_ar: r > 0 ? Math.min(1, a / r) : 1,
  };
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

// Status do EVP AFIRMÁVEL da célula (o número que vai ao painel). `evp_teto` é sempre o upper bound bruto.
// Sucede o `evp_parcial` de #961: lá o teto era exibido/somado mesmo positivo (otimista, money-path #2).
// Aqui, com o Ke vivo (k=0,30), teto>0 NÃO é afirmável (omitido); teto≤0 com perna ausente válida é
// não-positivo-garantido (real ≤ teto ≤ 0) e é mantido (não esconder prejuízo). Decisão Claude+Codex 2026-06-23.
export type EvpStatus =
  | 'real'                  // capital completo: evp = cm − encargo (afirmável)
  | 'teto_nao_positivo'     // parcial, teto≤0, perna AUSENTE alocaria ≥0: evp = teto (mantido)
  | 'omitido_teto_positivo' // parcial, teto>0 OU teto não-confiável (perna ausente alocaria <0): evp = null
  | 'indisponivel_cm'       // custo ausente (cm null): evp/evp_teto null
  | 'indisponivel_hurdle';  // k null (encargo indisponível): evp/evp_teto null
export type CelulaEVP = {
  cliente: string; sku: string; receita_liquida: number; quantidade: number;
  cm: number | null; a_cs: number; i_cs: number; encargo: number | null;
  evp_teto: number | null;   // cm − encargo (upper bound bruto; preserva o "evp" de #961). null se cm/encargo ausentes/não-finitos.
  evp: number | null;        // número AFIRMÁVEL (ver evp_status); null quando otimista/indisponível.
  ar_indisponivel: boolean; estoque_indisponivel: boolean;
  capital_parcial: boolean;  // ar_indisponivel || estoque_indisponivel (desacoplado do sinal do evp — sucede evp_parcial)
  evp_status: EvpStatus;
  // Sensibilidade ao hurdle (bônus 2026-06-24): SÓ p/ célula 'real' (capital completo). O agregado é robusto
  // e mascara os frágeis → mede-se POR COMBO (Codex). Parciais ficam fora (a classificação muda com k).
  capital_cs: number;               // a_cs + i_cs (capital alocado total da célula)
  hurdle_break_even: number | null; // o k onde evp=0 (= cm/capital_cs); null se não-real / capital_cs=0 / cm null
  sensivel_hurdle: boolean;         // break-even ∈ [k−δ, k+δ] → "fio da navalha" (recomendação frágil ao hurdle)
  folga_hurdle_pp: number | null;   // break_even − k (em pontos; >0 = folga acima do hurdle, <0 = já abaixo)
  quase_sensivel_hurdle: boolean;   // break_even ∈ (k+δ, k+2δ]: gera valor HOJE mas folga fina (tira a falsa robustez residual). SÓ lado bom (o ruim já é visível via evp<0); mut. exclusivo de sensivel_hurdle.
};
// Rollup: `evp` = Σ células AFIRMÁVEIS (real + teto≤0 mantido) — NÃO inclui omitidas; `evp_teto` = Σ tetos
// (upper bound do grupo, preserva #961); `evp_incompleto` = ∃ célula omitida por otimismo (o `evp` do grupo
// exclui essa fatia → pode ser maior). `encargo` (só células com cm) / `encargo_total` (todas) mantidos.
// perda_garantida = ∃ célula 'teto_nao_positivo' no grupo (o evp inclui um teto≤0 → o prejuízo REAL pode ser maior).
export type RollupCliente = { cliente: string; receita: number; cm: number | null; encargo: number | null; encargo_total: number | null; evp: number | null; evp_teto: number | null; evp_incompleto: boolean; perda_garantida: boolean; cm_incompleto: boolean; qtd_combos_sensiveis: number; qtd_combos_quase_sensiveis: number; min_folga_positiva_pp: number | null; min_folga_positiva_receita: number | null };
export type RollupSKU = { sku: string; receita: number; quantidade: number; cm: number | null; encargo: number | null; encargo_total: number | null; evp: number | null; evp_teto: number | null; evp_incompleto: boolean; perda_garantida: boolean; cm_incompleto: boolean; qtd_combos_sensiveis: number; qtd_combos_quase_sensiveis: number; min_folga_positiva_pp: number | null; min_folga_positiva_receita: number | null };
// Empresa DECOMPOSTA (Codex: somar {reais + tetos≤0} excluindo os teto>0 não é teto nem piso → mentira contábil).
// evp_conhecido = só capital completo; evp_teto_total = upper bound legado; evp_perda_garantida = piso da fatia
// parcial-negativa; evp = null se há QUALQUER fatia não-afirmável (não finge um total).
export type EmpresaEVP = {
  receita: number; cm: number | null; encargo: number | null; encargo_total: number | null;
  evp_conhecido: number | null; evp_teto_total: number | null; evp_perda_garantida: number | null;
  evp: number | null; evp_incompleto: boolean; cm_incompleto: boolean;
  qtd_combos_sensiveis: number;       // combos REAIS no fio da navalha (a granularidade que o agregado robusto esconde)
  qtd_combos_quase_sensiveis: number; // combos REAIS quase-frágeis (break_even ∈ (k+δ, k+2δ]): geram valor mas folga fina — tira a falsa robustez residual
  min_folga_positiva_pp: number | null; // menor folga POSITIVA fora do fio (folga>δ): "próximo combo lucrativo zera com +X pp de Ke"; null se nenhum (sinal contínuo, complementa a contagem — Codex)
  min_folga_positiva_receita: number | null; // receita_liquida do combo DONO do min_folga_positiva_pp — LOCATOR, não severidade: a UI suprime o headline quando imaterial (< sample_min_receita). null junto com o pp (/codex #1044)
  capital_conhecido: number | null;   // Σ capital_cs das células 'real' → UI deriva evp_conhecido(k') = evp_conhecido + (k − k')·capital_conhecido
};
export type ComboEVPResult = {
  celulas: CelulaEVP[];
  porCliente: RollupCliente[];
  porSKU: RollupSKU[];
  empresa: EmpresaEVP;
  // pcts [0,1] por RECEITA (denominador = receita total elegível — NÃO "receita-com-evp", que esconderia a
  // fatia omitida). Alimentam scoreConfiancaCockpit + UI. Sucedem evp_teto_receita_pct.
  evp_conhecido_receita_pct: number;
  evp_omitido_otimista_receita_pct: number;
  evp_perda_garantida_receita_pct: number;
  sem_cm_receita_pct: number;
  // banda do hurdle p/ a sensibilidade (k ± δ; null se k indisponível). A UI rotula 25/30/35% (30 = principal).
  hurdle_banda: { base: number; lo: number; hi: number } | null;
};

export function montarCelulasComboEVP(input: {
  combos: ComboInput[];
  capitalClientes: CapitalCliente[];
  capitalSKUs: CapitalSKU[];
  k: number | null;   // hurdle; null → encargo/EVP indisponíveis (não fabricados)
  banda_hurdle?: number; // δ p/ a sensibilidade (default 0,05 → 25/35% a k=0,30)
}): ComboEVPResult {
  // Guard de hurdle: k inválido (não-finito ou <=0) → indisponível (NÃO fabrica encargo). 0% = capital
  // grátis; resolverHurdleCockpit já barra — isto é defense-in-depth na fronteira (Codex 2026-06-18).
  const k = input.k != null && Number.isFinite(input.k) && input.k > 0 ? input.k : null;
  // Banda do hurdle p/ a sensibilidade (combos no fio da navalha). kLo/kHi só são usados quando k != null.
  const banda = input.banda_hurdle != null && Number.isFinite(input.banda_hurdle) && input.banda_hurdle > 0 ? input.banda_hurdle : 0.05;
  const round4 = (x: number) => Math.round(x * 1e4) / 1e4; // evita lixo de float (0,30−0,10=0,19999…) no contrato/UI
  const kLo = k != null ? round4(Math.max(0, k - banda)) : 0;
  const kHi = k != null ? round4(k + banda) : 0;
  const kHi2 = k != null ? round4(k + 2 * banda) : 0; // teto da faixa quase-frágil (k+2δ); só usado quando k != null
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
    const arCraw = arPorCliente.get(c.cliente) ?? null;
    const estSraw = estoquePorSKU.get(c.sku) ?? null;
    // Capital válido só se finito e >=0. Negativo/NaN do banco → indisponível (NÃO número sujo): somar
    // uma perna negativa REDUZIRIA o encargo e o "teto" viraria piso (Codex 2026-06-18).
    const arC = arCraw != null && Number.isFinite(arCraw) && arCraw >= 0 ? arCraw : null;
    const estS = estSraw != null && Number.isFinite(estSraw) && estSraw >= 0 ? estSraw : null;
    const rc = receitaPorCliente.get(c.cliente) ?? 0;
    const qs = qtdPorSKU.get(c.sku) ?? 0;
    // Indisponível se não há base OU se o denominador da alocação é ≤ 0 (não dá pra alocar honestamente).
    const ar_indisponivel = arC == null || rc <= 0;
    const estoque_indisponivel = estS == null || qs <= 0;
    const capital_parcial = ar_indisponivel || estoque_indisponivel;
    const a_cs = arC != null && rc > 0 ? arC * (c.receita_liquida / rc) : 0;
    const i_cs = estS != null && qs > 0 ? estS * (c.quantidade / qs) : 0;
    // Hurdle ausente (k null) → encargo indisponível (ausente ≠ R$0); o teto só existe com cm E encargo.
    const encargo = k == null ? null : k * (a_cs + i_cs);
    const evp_teto = cm == null || encargo == null || !Number.isFinite(cm - encargo) ? null : cm - encargo;

    // Número AFIRMÁVEL + status. O teto (cm − encargo_parcial) só é upper bound REAL do EVP se a perna
    // AUSENTE alocaria capital ≥0 (a perna presente é a real nos dois lados; seu sinal não afeta a
    // monotonicidade — Codex 2026-06-23): estoque ausente exige quantidade≥0; AR ausente exige
    // receita_liquida≥0. Senão o "teto≤0" pode ser falso (não é piso) → omitir, não afirmar.
    let evp: number | null;
    let evp_status: EvpStatus;
    if (cm == null) { evp = null; evp_status = 'indisponivel_cm'; }
    else if (encargo == null) { evp = null; evp_status = 'indisponivel_hurdle'; }     // k null
    else if (evp_teto == null) { evp = null; evp_status = 'indisponivel_cm'; }         // cm−encargo não-finito (defesa)
    else if (!capital_parcial) { evp = evp_teto; evp_status = 'real'; }
    else {
      // o teto≤0 só é upper bound real se a perna AUSENTE alocaria capital ≥0. Além do NUMERADOR (receita/qtd
      // da célula ≥0), o DENOMINADOR de alocação tem de ser >0: rc/qs ≤0 (devolução/offset no cliente ou SKU)
      // inverte o sinal da fração → 0 não é piso → omitir, NÃO fabricar "perda garantida" (/codex challenge 2026-06-23).
      const estoqueAlocOk = !estoque_indisponivel || (qs > 0 && Number.isFinite(c.quantidade) && c.quantidade >= 0);
      const arAlocOk = !ar_indisponivel || (rc > 0 && Number.isFinite(c.receita_liquida) && c.receita_liquida >= 0);
      if (evp_teto <= 0 && estoqueAlocOk && arAlocOk) { evp = evp_teto; evp_status = 'teto_nao_positivo'; }
      else { evp = null; evp_status = 'omitido_teto_positivo'; }                       // teto>0 OU alocação inválida
    }
    // Sensibilidade ao hurdle: break-even = cm/capital_cs (o k onde evp=0), SÓ p/ célula 'real' (capital
    // completo, cm conhecido). capital_cs=0 → EVP plano (= cm), insensível. Parcial/indisponível → null
    // (a sensibilidade do TETO de parciais fica fora desta entrega — a classificação muda com k, Codex).
    const capital_cs = a_cs + i_cs;
    const hurdle_break_even = evp_status === 'real' && capital_cs > 0 && cm != null && Number.isFinite(cm / capital_cs)
      ? cm / capital_cs : null;
    const sensivel_hurdle = k != null && hurdle_break_even != null && hurdle_break_even >= kLo - 1e-9 && hurdle_break_even <= kHi + 1e-9; // epsilon: borda inclusiva apesar do float (/codex)
    const folga_hurdle_pp = hurdle_break_even != null && k != null ? hurdle_break_even - k : null;
    // Quase-frágil: break_even na faixa externa (kHi, kHi2] = (k+δ, k+2δ] — gera valor HOJE mas folga fina.
    // SÓ lado bom (acima de kHi); o lado ruim (break_even<k → evp<0) já é visível na tabela. Borda inferior
    // exclusiva (kHi já é 'sensível') e superior inclusiva, mesmo epsilon → mut. exclusivo de sensivel_hurdle, sem gap.
    const quase_sensivel_hurdle = k != null && hurdle_break_even != null && hurdle_break_even > kHi + 1e-9 && hurdle_break_even <= kHi2 + 1e-9;
    return { cliente: c.cliente, sku: c.sku, receita_liquida: c.receita_liquida, quantidade: c.quantidade, cm, a_cs, i_cs, encargo, evp_teto, evp, ar_indisponivel, estoque_indisponivel, capital_parcial, evp_status, capital_cs, hurdle_break_even, sensivel_hurdle, folga_hurdle_pp, quase_sensivel_hurdle };
  });

  const rollup = (keyFn: (c: CelulaEVP) => string) => {
    const m = new Map<string, { receita: number; quantidade: number; cm: number; cmNull: boolean; encargo: number; encargoNull: boolean; encargoTotal: number; encargoTotalNull: boolean; evp: number; evpNull: boolean; evpTeto: number; evpTetoNull: boolean; evpIncompleto: boolean; perdaGarantida: boolean; cmIncompleto: boolean; qtdSensiveis: number; qtdQuaseSensiveis: number; minFolgaPositiva: number | null; minFolgaPositivaReceita: number | null }>();
    for (const cel of celulas) {
      const key = keyFn(cel);
      const acc = m.get(key) ?? { receita: 0, quantidade: 0, cm: 0, cmNull: true, encargo: 0, encargoNull: true, encargoTotal: 0, encargoTotalNull: true, evp: 0, evpNull: true, evpTeto: 0, evpTetoNull: true, evpIncompleto: false, perdaGarantida: false, cmIncompleto: false, qtdSensiveis: 0, qtdQuaseSensiveis: 0, minFolgaPositiva: null, minFolgaPositivaReceita: null };
      acc.receita += cel.receita_liquida;
      acc.quantidade += cel.quantidade;
      if (cel.cm == null) acc.cmIncompleto = true; // grupo tem célula sem margem (excluída do EVP)
      if (cel.encargo != null) { acc.encargoTotal += cel.encargo; acc.encargoTotalNull = false; } // todas as células (null-aware)
      if (cel.cm != null) {
        acc.cm += cel.cm; acc.cmNull = false;
        if (cel.encargo != null) { acc.encargo += cel.encargo; acc.encargoNull = false; } // encargo relevante ao EVP (só células com cm)
      }
      if (cel.evp_teto != null) { acc.evpTeto += cel.evp_teto; acc.evpTetoNull = false; }      // upper bound do grupo (todos os tetos)
      if (cel.evp != null) { acc.evp += cel.evp; acc.evpNull = false; }                         // só afirmável (real + teto≤0 mantido)
      if (cel.evp_status === 'omitido_teto_positivo') acc.evpIncompleto = true;                 // fatia otimista fora do evp
      if (cel.evp_status === 'teto_nao_positivo') acc.perdaGarantida = true;                     // evp inclui um teto≤0 → real pode ser pior
      if (cel.sensivel_hurdle) acc.qtdSensiveis++;                                                // combo real no fio da navalha
      if (cel.quase_sensivel_hurdle) acc.qtdQuaseSensiveis++;                                      // combo real quase-frágil (folga fina, lado bom)
      // menor folga POSITIVA fora do fio (real && !sensivel && folga>0 ⟺ folga>δ): "o próximo a virar a +X pp" (Codex: só lado +, não signed-min).
      // Guarda a receita do MESMO combo vencedor (locator, não severidade): a UI suprime o headline quando imaterial (/codex #1044).
      if (cel.evp_status === 'real' && !cel.sensivel_hurdle && cel.folga_hurdle_pp != null && cel.folga_hurdle_pp > 0
          && (acc.minFolgaPositiva == null || cel.folga_hurdle_pp < acc.minFolgaPositiva)) { acc.minFolgaPositiva = cel.folga_hurdle_pp; acc.minFolgaPositivaReceita = cel.receita_liquida; }
      m.set(key, acc);
    }
    return m;
  };

  const mc = rollup((c) => c.cliente);
  const ms = rollup((c) => c.sku);
  const porCliente: RollupCliente[] = [...mc.entries()].map(([cliente, a]) => ({ cliente, receita: a.receita, cm: a.cmNull ? null : a.cm, encargo: a.encargoNull ? null : a.encargo, encargo_total: a.encargoTotalNull ? null : a.encargoTotal, evp: a.evpNull ? null : a.evp, evp_teto: a.evpTetoNull ? null : a.evpTeto, evp_incompleto: a.evpIncompleto, perda_garantida: a.perdaGarantida, cm_incompleto: a.cmIncompleto, qtd_combos_sensiveis: a.qtdSensiveis, qtd_combos_quase_sensiveis: a.qtdQuaseSensiveis, min_folga_positiva_pp: a.minFolgaPositiva, min_folga_positiva_receita: a.minFolgaPositivaReceita }));
  const porSKU: RollupSKU[] = [...ms.entries()].map(([sku, a]) => ({ sku, receita: a.receita, quantidade: a.quantidade, cm: a.cmNull ? null : a.cm, encargo: a.encargoNull ? null : a.encargo, encargo_total: a.encargoTotalNull ? null : a.encargoTotal, evp: a.evpNull ? null : a.evp, evp_teto: a.evpTetoNull ? null : a.evpTeto, evp_incompleto: a.evpIncompleto, perda_garantida: a.perdaGarantida, cm_incompleto: a.cmIncompleto, qtd_combos_sensiveis: a.qtdSensiveis, qtd_combos_quase_sensiveis: a.qtdQuaseSensiveis, min_folga_positiva_pp: a.minFolgaPositiva, min_folga_positiva_receita: a.minFolgaPositivaReceita }));

  // Empresa decomposta + pcts por receita total elegível.
  let cmEmp = 0, cmNull = true, encEmp = 0, encNull = true, encTotalEmp = 0, encTotalNull = true, recEmp = 0;
  let conhecido = 0, conhecidoNull = true, tetoTotal = 0, tetoTotalNull = true, perda = 0, perdaNull = true;
  let evpIncompletoEmp = false, cmIncompletoEmp = false;
  let recConhecido = 0, recOmitido = 0, recPerda = 0, recSemCm = 0;
  let qtdSensiveisEmp = 0, qtdQuaseSensiveisEmp = 0, capitalConhecido = 0, minFolgaPositivaEmp: number | null = null, minFolgaPositivaReceitaEmp: number | null = null;
  for (const cel of celulas) {
    recEmp += cel.receita_liquida;
    if (cel.cm == null) { cmIncompletoEmp = true; recSemCm += cel.receita_liquida; }
    if (cel.encargo != null) { encTotalEmp += cel.encargo; encTotalNull = false; }
    if (cel.cm != null) { cmEmp += cel.cm; cmNull = false; if (cel.encargo != null) { encEmp += cel.encargo; encNull = false; } }
    if (cel.evp_teto != null) { tetoTotal += cel.evp_teto; tetoTotalNull = false; }
    if (cel.evp_status === 'real') { conhecido += cel.evp as number; conhecidoNull = false; recConhecido += cel.receita_liquida; capitalConhecido += cel.capital_cs; }
    else if (cel.evp_status === 'teto_nao_positivo') { perda += cel.evp as number; perdaNull = false; recPerda += cel.receita_liquida; }
    else if (cel.evp_status === 'omitido_teto_positivo') { evpIncompletoEmp = true; recOmitido += cel.receita_liquida; }
    if (cel.sensivel_hurdle) qtdSensiveisEmp++;
    if (cel.quase_sensivel_hurdle) qtdQuaseSensiveisEmp++;
    if (cel.evp_status === 'real' && !cel.sensivel_hurdle && cel.folga_hurdle_pp != null && cel.folga_hurdle_pp > 0
        && (minFolgaPositivaEmp == null || cel.folga_hurdle_pp < minFolgaPositivaEmp)) { minFolgaPositivaEmp = cel.folga_hurdle_pp; minFolgaPositivaReceitaEmp = cel.receita_liquida; }
  }
  // empresa.evp só é um total honesto se NADA foi omitido/indisponível; senão null (Codex: não fingir total).
  const empresaCompleta = !evpIncompletoEmp && !cmIncompletoEmp && k != null;
  const empresa: EmpresaEVP = {
    receita: recEmp, cm: cmNull ? null : cmEmp, encargo: encNull ? null : encEmp, encargo_total: encTotalNull ? null : encTotalEmp,
    evp_conhecido: conhecidoNull ? null : conhecido,
    evp_teto_total: tetoTotalNull ? null : tetoTotal,
    evp_perda_garantida: perdaNull ? null : perda,
    evp: empresaCompleta && !conhecidoNull ? conhecido : null,
    evp_incompleto: evpIncompletoEmp, cm_incompleto: cmIncompletoEmp,
    qtd_combos_sensiveis: qtdSensiveisEmp, qtd_combos_quase_sensiveis: qtdQuaseSensiveisEmp, min_folga_positiva_pp: minFolgaPositivaEmp, min_folga_positiva_receita: minFolgaPositivaReceitaEmp, capital_conhecido: conhecidoNull ? null : capitalConhecido,
  };
  const pct = (x: number) => (recEmp > 0 ? x / recEmp : 0);
  return {
    celulas, porCliente, porSKU, empresa,
    evp_conhecido_receita_pct: pct(recConhecido),
    evp_omitido_otimista_receita_pct: pct(recOmitido),
    evp_perda_garantida_receita_pct: pct(recPerda),
    sem_cm_receita_pct: pct(recSemCm),
    hurdle_banda: k != null ? { base: k, lo: kLo, hi: kHi } : null,
  };
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
  hurdle_indisponivel?: boolean;   // sem Ke → EVP não calculável globalmente; gateia as regras de valor
  evp_incompleto?: boolean;        // grupo tem fatia de EVP OMITIDA por capital parcial (teto>0 otimista) — sucede evp_parcial; não afirma valor
  cm_incompleto?: boolean;         // grupo tem células sem custo (margem desconhecida em parte)
}): Recomendacao[] {
  const r: Recomendacao[] = [];
  const c = input.config;
  const receitaBruta = input.receita_liquida + input.desconto_total;
  const descontoPct = receitaBruta > 0 ? input.desconto_total / receitaBruta : 0;
  const cmPct = input.cm != null && input.receita_liquida > 0 ? input.cm / input.receita_liquida : null;
  // Com hurdle ausente, evp=null significa "não calculável" (NÃO "destrói valor"): não tratar null como sinal.
  const evpConhecivel = !input.hurdle_indisponivel;
  const evpIncompleto = !!input.evp_incompleto;  // fatia otimista omitida (capital não medido) → não afirma valor
  const cmIncompleto = !!input.cm_incompleto;
  const evpNegConhecido = input.evp != null && input.evp < 0; // inclui perda garantida (teto≤0 mantido) → alerta robusto

  // cortar desconto: desconto acima do máx e (sem hurdle OU valor não-positivo conhecido OU não medido/indisponível)
  if (descontoPct > c.desconto_max_pct && (!evpConhecivel || input.evp == null || input.evp <= 0 || evpIncompleto)) {
    const recupera = input.desconto_total - receitaBruta * c.desconto_max_pct;
    const pre = `Desconto ${(descontoPct * 100).toFixed(0)}% > máx ${(c.desconto_max_pct * 100).toFixed(0)}%`;
    // ordem de precedência: hurdle ausente > prejuízo conhecido > não-medido (otimista omitido) > margem ausente.
    // NÃO dizer "não gera valor" quando o EVP foi OMITIDO por otimismo — seria falso (Codex 2026-06-23).
    // precedência: hurdle ausente > (prejuízo medido E fatia omitida) > prejuízo conhecido > não-medido > margem.
    // com fatia omitida + parte medida negativa, NÃO afirmar "não gera valor" sobre o TOTAL (a parte omitida
    // pode ser positiva) — dizer as duas coisas (/codex challenge 2026-06-23).
    let motivo: string;
    if (!evpConhecivel) motivo = `${pre} — lucro econômico indisponível (configure o hurdle p/ confirmar).`;
    else if (evpNegConhecido && evpIncompleto) motivo = `${pre} — parte do valor não medida (capital ausente); a parte medida não gera valor.`;
    else if (evpNegConhecido) motivo = `${pre} e o combo não gera valor.`;
    else if (evpIncompleto) motivo = `${pre} — valor econômico NÃO medido em parte (capital ausente) — não confirmável.`;
    else if (input.cm == null) motivo = `${pre} — margem indisponível (custo ausente).`;
    else motivo = `${pre} e o combo não gera valor.`;
    r.push({ acao: 'Cortar desconto', motivo, impacto_rs: Math.max(0, recupera) });
  }
  // encurtar prazo: prazo acima do alvo e EVP negativo CONHECIDO (evp==null não fabrica ação — Codex)
  if (evpConhecivel && input.prazo_medio_dias > c.prazo_alvo_dias && evpNegConhecido) {
    r.push({ acao: 'Encurtar prazo / exigir antecipado', motivo: `Prazo médio ${input.prazo_medio_dias.toFixed(0)}d > alvo ${c.prazo_alvo_dias}d puxa o custo de capital de giro.`, impacto_rs: null });
  }
  // subir preço: margem% abaixo da mínima (independe do hurdle)
  if (cmPct != null && cmPct < c.margem_minima_pct) {
    const alvoCM = c.margem_minima_pct * input.receita_liquida;
    r.push({ acao: 'Subir preço', motivo: `Margem ${(cmPct * 100).toFixed(0)}% < mínima ${(c.margem_minima_pct * 100).toFixed(0)}%.`, impacto_rs: Math.max(0, alvoCM - (input.cm as number)) });
  }
  // despriorizar/liquidar SKU: estoque alto + EVP negativo CONHECIDO
  if (evpConhecivel && input.dias_estoque > c.dias_estoque_max && evpNegConhecido) {
    r.push({ acao: 'Despriorizar / liquidar estoque', motivo: `${input.dias_estoque.toFixed(0)} dias de estoque > limite ${c.dias_estoque_max}d e o item não gera valor.`, impacto_rs: null });
  }
  // crescer: EVP positivo AFIRMÁVEL e nada disparou. SEM ressalva só se completo (não-omitido E cm completa).
  if (r.length === 0 && input.evp != null && input.evp > 0) {
    if (!evpIncompleto && !cmIncompleto) {
      r.push({ acao: 'Crescer / proteger', motivo: 'Gera valor econômico positivo e sem alertas.', impacto_rs: null });
    } else {
      const ressalvas: string[] = [];
      if (evpIncompleto) ressalvas.push('capital não medido em parte da carteira (EVP parcial omitido) — confirmar');
      if (cmIncompleto) ressalvas.push('margem desconhecida em parte (custo ausente)');
      r.push({ acao: 'Crescer / proteger', motivo: `Provável valor econômico positivo, a confirmar: ${ressalvas.join('; ')}.`, impacto_rs: null });
    }
  }
  // NOTA: aviso "configure o Ke/hurdle" NÃO entra aqui (estado do cockpit, não ação por cliente) — vive na confiança + banner.
  return r;
}

export type ConfiancaCockpit = { nivel: 'alta' | 'media' | 'baixa'; motivos: string[] };

export function scoreConfiancaCockpit(input: {
  cobertura_receita: number;     // [0,1] receita order_items ÷ receita-AR do período
  custo_ausente_pct: number;     // [0,1] células sem custo
  ar_indisponivel_pct: number;   // [0,1] células sem AR joinável
  estoque_ausente_pct: number;   // [0,1] SKUs sem estoque/cmc
  imposto_estimado: boolean;
  hurdle_indisponivel?: boolean; // sem Ke → EVP não calculável → confiança baixa
  evp_omitido_otimista_receita_pct?: number; // [0,1] fração da receita cujo EVP foi OMITIDO (teto>0, capital ausente) — sucede evp_teto_receita_pct
  cobertura_app_por_ar?: number; // [0,1] venda app com AR faturável; <0,5 → divergência → rebaixa
  custo_baixa_confianca_pct?: number; // [0,1] células com custo proxy(<0,7)/legado-fallback (cm EXISTE, base estimada)
}): ConfiancaCockpit {
  const motivos: string[] = [];
  let nivel = 3; // 3 alta, 2 media, 1 baixa
  const rebaixar = (para: number, m: string) => { if (para < nivel) nivel = para; motivos.push(m); };

  if (input.hurdle_indisponivel) rebaixar(1, 'Sem Ke/hurdle configurado — lucro econômico (EVP) indisponível; configure em /financeiro/valor.');
  if (input.cobertura_receita < 0.6) rebaixar(1, `Cobertura de receita ${(input.cobertura_receita * 100).toFixed(0)}% — muita venda fora do app; cockpit parcial.`);
  else if (input.cobertura_receita < 0.85) rebaixar(2, `Cobertura de receita ${(input.cobertura_receita * 100).toFixed(0)}% (ideal ≥85%).`);
  if (input.cobertura_app_por_ar != null && input.cobertura_app_por_ar < 0.5) rebaixar(2, `${((1 - input.cobertura_app_por_ar) * 100).toFixed(0)}% da venda do app sem AR faturável — encargo de cliente subestimado; possível divergência app↔financeiro.`);

  if (input.custo_ausente_pct > 0.4) rebaixar(1, `${(input.custo_ausente_pct * 100).toFixed(0)}% das células sem custo — margem indisponível em boa parte.`);
  else if (input.custo_ausente_pct > 0.15) rebaixar(2, `${(input.custo_ausente_pct * 100).toFixed(0)}% sem custo cadastrado.`);

  // Custo de BAIXA CONFIANÇA (proxy do motor <0,7 OU fallback legado cost_price) — distinto de "sem custo": o
  // cm/EVP EXISTE, mas a base é estimada. Mais brando que custo_ausente (não nullifica): ≥0,2 rebaixa p/ média
  // (impede "alta" com ~1/5 das células estimadas), 0,05–0,2 só informa, e NUNCA derruba abaixo de média sozinho
  // (codex). Mutuamente exclusivo de custo_ausente (classificado APÓS resolver o custo usado).
  const cbc = input.custo_baixa_confianca_pct ?? 0;
  if (cbc >= 0.2) rebaixar(2, `${(cbc * 100).toFixed(0)}% das células com custo estimado (proxy do motor ou fallback legado)${cbc > 0.4 ? ' — boa parte da margem é indicativa' : ''} — confiança da margem reduzida.`);
  else if (cbc >= 0.05) motivos.push(`${(cbc * 100).toFixed(0)}% das células com custo proxy/legado (informativo).`);

  if (input.ar_indisponivel_pct > 0.3) rebaixar(2, `${(input.ar_indisponivel_pct * 100).toFixed(0)}% das vendas sem AR vinculável — encargo de cliente subestimado.`);
  if (input.estoque_ausente_pct > 0.3) rebaixar(2, `${(input.estoque_ausente_pct * 100).toFixed(0)}% dos SKUs sem estoque — encargo de SKU subestimado.`);
  // EVP OMITIDO (capital ausente → teto>0 não afirmado): motivo SEMPRE que >0 (fecha o ponto cego — nunca
  // verde mudo); rebaixa a média quando material (>5% da receita). Por receita, não contagem (Codex 2026-06-23).
  const omitidoPct = input.evp_omitido_otimista_receita_pct ?? 0;
  if (omitidoPct > 0.05) rebaixar(2, `${(omitidoPct * 100).toFixed(0)}% da receita com EVP omitido — encargo de capital não medido; lucro econômico não afirmado nessa fatia.`);
  else if (omitidoPct > 0) motivos.push(`${(omitidoPct * 100).toFixed(1)}% da receita com EVP omitido (capital não medido em parte).`);
  if (input.imposto_estimado) motivos.push('Imposto alocado nível-empresa (estimado), não por linha.');

  return { nivel: nivel === 3 ? 'alta' : nivel === 2 ? 'media' : 'baixa', motivos };
}
