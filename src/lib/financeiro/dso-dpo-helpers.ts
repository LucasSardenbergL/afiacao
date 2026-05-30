/**
 * DSO/DPO contábil agregado (point-in-time) — "Lente contábil agregada".
 *
 * Alternativa HONESTA ao PMR/PMP title-based pra empresas que liquidam em LOTE
 * (colacor: cobertura de baixa derivável ~10% → PMR/PMP/ciclo em "—" pelo gate 40%).
 * NÃO depende da data de baixa: usa o saldo ABERTO de hoje ÷ o fluxo do DRE TTM.
 *
 * Metodologia (validada com codex, consult adversarial 2026-05-30):
 *   • DSO = AR aberto hoje ÷ (receita_BRUTA TTM ÷ dias do período)
 *     — receita_bruta (não líquida): o AR é face do título, inclui tributo.
 *   • DPO = AP aberto hoje ÷ (CMV TTM ÷ dias do período)
 *     — CMV é PROXY de compras (bom só se estoque estável); AP total inclui
 *       tributo/folha/capex → rotular, NÃO chamar de "prazo médio de pagamento".
 *   • TTM (12 meses fechados) — capital de giro não pode ser ruidoso (≠ trimestre).
 *   • Regime COMPETÊNCIA (saldo AR/AP é posição patrimonial; DRE competência).
 *   • Point-in-time (saldo de hoje, não AR médio): não há série histórica de saldo
 *     e reconstruir AR médio precisaria da baixa que o colacor não tem.
 *
 * Degradação honesta (codex):
 *   • saldo aberto = 0 com fluxo > 0 → indicador 0 (NÃO null).
 *   • null SÓ se: denominador (receita/CMV) ausente ou ≤0, OU TTM < 12 meses fechados,
 *     OU dias do período ≤ 0, OU saldo aberto ausente.
 *
 * ⚠️ Só os títulos ABERTOS (OPEN_TITLE_STATUSES) entram no saldo: títulos liquidados
 * têm `saldo` cheio (bug #396, valor_recebido sempre 0) — contá-los infla o AR/AP.
 */

export interface DsoDpoInput {
  /** Σ saldo dos títulos de CR ABERTOS hoje (R$) — só status ∈ OPEN_TITLE_STATUSES. */
  arAberto: number | null;
  /** Σ saldo dos títulos de CP ABERTOS hoje (R$). */
  apAberto: number | null;
  /** Σ receita_bruta dos meses fechados no TTM (R$, competência). */
  receitaBrutaTTM: number | null;
  /** Σ cmv dos meses fechados no TTM (R$, competência). */
  cmvTTM: number | null;
  /** nº de meses com snapshot de DRE no TTM (12 = completo). */
  mesesFechados: number;
  /** dias cobertos pelo TTM (p/ a taxa diária; ~365). */
  diasPeriodo: number;
  /** rótulo do período, ex.: "jun/2025–mai/2026". */
  periodoLabel: string;
}

export interface DsoDpoResult {
  /** dias (arredondado) ou null se indisponível. */
  dso: number | null;
  dpo: number | null;
  // eco dos insumos (transparência/auditoria)
  ar_aberto: number | null;
  ap_aberto: number | null;
  receita_bruta_ttm: number | null;
  cmv_ttm: number | null;
  meses_fechados: number;
  dias_periodo: number;
  periodo_label: string;
  /** true se ao menos um dos dois indicadores computou. */
  disponivel: boolean;
  caveats: string[];
}

export const TTM_MESES_MIN = 12;

/**
 * Teto de plausibilidade (dias). DSO/DPO acima disso é descartado (→ null) em vez de
 * exibir um número com falsa precisão (codex): 730 dias = 2 anos de receita/compras
 * parados no balanço = quase certo dado incoerente (ex.: colacor AP 792k ÷ CMV 199k ≈
 * 1327 dias porque AP inclui matéria-prima/capex/tributo, ≠ CMV). NÃO esconde problema:
 * o caveat explica a inconsistência; só evita o KPI mentir "1327 dias".
 */
export const PLAUSIBILIDADE_TETO_DIAS = 730;

export interface JanelaTTM {
  /** os 12 pares (ano, mes) dos meses FECHADOS, do mais antigo ao mais recente. */
  pares: { ano: number; mes: number }[];
  /** dias cobertos (1º dia do mais antigo → último dia do mais recente). */
  diasPeriodo: number;
  /** rótulo "MM/AAAA–MM/AAAA". */
  periodoLabel: string;
}

/**
 * Janela TTM = os 12 meses FECHADOS (exclui o mês corrente, que está em curso).
 * Pura (recebe `hoje`) → testável e sem surpresa de fuso (usa componentes locais).
 * Ex.: hoje=2026-05-xx → 05/2025 … 04/2026.
 */
export function janelaTTM(hoje: Date): JanelaTTM {
  const y = hoje.getFullYear();
  const m = hoje.getMonth(); // 0-11, mês corrente (em curso, NÃO entra)
  const pares: { ano: number; mes: number }[] = [];
  for (let i = TTM_MESES_MIN; i >= 1; i--) {
    const d = new Date(y, m - i, 1); // i meses atrás do 1º dia do mês corrente
    pares.push({ ano: d.getFullYear(), mes: d.getMonth() + 1 });
  }
  const oldest = pares[0];
  const newest = pares[pares.length - 1];
  const inicio = new Date(oldest.ano, oldest.mes - 1, 1);
  const fim = new Date(newest.ano, newest.mes, 0); // dia 0 do mês seguinte = último dia
  const diasPeriodo = Math.round((fim.getTime() - inicio.getTime()) / 86_400_000) + 1;
  const fmt = (p: { ano: number; mes: number }) => `${String(p.mes).padStart(2, '0')}/${p.ano}`;
  return { pares, diasPeriodo, periodoLabel: `${fmt(oldest)}–${fmt(newest)}` };
}

const CAVEAT_SNAPSHOT =
  'Point-in-time: saldo aberto de HOJE ÷ fluxo dos últimos 12m — sensível a pico recente de faturamento; é lente de balanço agregada, NÃO prazo por título (≠ PMR/PMP).';
const CAVEAT_DPO_CMV =
  'DPO calculado sobre CMV (proxy de compras) e AP total (inclui tributo/folha/capex) — não é o prazo médio de pagamento real a fornecedores.';

/** AR/AP aberto ÷ fluxo diário (TTM). Aplica a degradação honesta. */
function razaoEmDias(
  saldoAberto: number | null,
  fluxoTTM: number | null,
  diasPeriodo: number,
  ttmOk: boolean,
): number | null {
  if (!ttmOk) return null;
  // denominador ausente ou ≤0 → não dá pra calcular
  if (fluxoTTM == null || !(fluxoTTM > 0)) return null;
  // saldo ausente → null; saldo 0 (ou negativo, que não deveria ocorrer) → 0 com fluxo>0
  if (saldoAberto == null) return null;
  const saldo = saldoAberto > 0 ? saldoAberto : 0;
  const fluxoDiario = fluxoTTM / diasPeriodo;
  return Math.round(saldo / fluxoDiario);
}

export function calcularDsoDpo(input: DsoDpoInput): DsoDpoResult {
  const { arAberto, apAberto, receitaBrutaTTM, cmvTTM, mesesFechados, diasPeriodo, periodoLabel } =
    input;

  const ttmOk = mesesFechados >= TTM_MESES_MIN && diasPeriodo > 0;

  const dsoRaw = razaoEmDias(arAberto, receitaBrutaTTM, diasPeriodo, ttmOk);
  const dpoRaw = razaoEmDias(apAberto, cmvTTM, diasPeriodo, ttmOk);

  const caveats = [CAVEAT_SNAPSHOT, CAVEAT_DPO_CMV];
  if (!ttmOk) {
    caveats.push(
      `TTM incompleto (${mesesFechados}/${TTM_MESES_MIN} meses fechados${
        diasPeriodo > 0 ? '' : ', período inválido'
      }) — DSO/DPO não calculados.`,
    );
  }

  // Guard de plausibilidade (codex): descarta valor com falsa precisão em vez de exibi-lo.
  let dso = dsoRaw;
  let dpo = dpoRaw;
  if (dsoRaw !== null && dsoRaw > PLAUSIBILIDADE_TETO_DIAS) {
    dso = null;
    caveats.push(
      `DSO calculado (${dsoRaw} dias) acima do teto de plausibilidade (${PLAUSIBILIDADE_TETO_DIAS}) — descartado (incoerente_plausibilidade: AR aberto vs receita fora da faixa).`,
    );
  }
  if (dpoRaw !== null && dpoRaw > PLAUSIBILIDADE_TETO_DIAS) {
    dpo = null;
    caveats.push(
      `DPO calculado (${dpoRaw} dias) acima do teto de plausibilidade (${PLAUSIBILIDADE_TETO_DIAS}) — descartado (incoerente_plausibilidade: AP aberto inclui não-CMV, denominador incoerente).`,
    );
  }

  return {
    dso,
    dpo,
    ar_aberto: arAberto,
    ap_aberto: apAberto,
    receita_bruta_ttm: receitaBrutaTTM,
    cmv_ttm: cmvTTM,
    meses_fechados: mesesFechados,
    dias_periodo: diasPeriodo,
    periodo_label: periodoLabel,
    disponivel: dso !== null || dpo !== null,
    caveats,
  };
}
