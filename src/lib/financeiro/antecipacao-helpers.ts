// F4 — Termômetro de dependência de antecipação (PEGN erro 2) — helper puro (vitest).
// FONTE ÚNICA: as linhas `antecipacao_recorrente` do F1 (fin_dividas), rotuladas pela MÃO do master.
// O Omie NÃO registra antecipação de recebíveis de forma distinguível (grounding, spec §0) → qualquer
// auto-detecção fabricaria sinal. Client-side only (sem edge). Nunca finge número (ausente = null+motivo).
// Spec: docs/superpowers/specs/2026-07-05-antecipacao-termometro-design.md

export type NivelTermometro = 'baixa' | 'media' | 'alta';

export type MotivoAntecipacao =
  | 'ok'
  | 'sem_linhas' // 0 linhas ativas → empty-state EDUCATIVO (não é erro; ensina o que vigiar)
  | 'sem_base'; // tem linhas mas nenhum saldo conhecido / nenhuma métrica de nível computável

// Nomenclatura HONESTA (Codex, ressalva forte): NÃO chamar de "dependência"/"fração antecipada" —
// os campos atuais não provam cessão. É "exposição sacada ÷ AR aberto". Custo ÷ receita LÍQUIDA TTM.

// Subset de fin_dividas (tipo='antecipacao_recorrente', ativo). Datas/valores já resolvidos pelo hook.
export interface LinhaAntecipacao {
  id: string;
  credor: string;
  saldo_devedor: number | null; // saldo_devedor_informado: face dos títulos ainda descontados
  cet_aa: number | null; // fração a.a. (0.32 = 32% a.a.); null = custo desconhecido, NUNCA 0
  coobrigada_por: string | null; // empresa co-obrigada (exposição contingente) ou null
}

export interface AntecipacaoConfig {
  materialSharePct: number; // share do exposicao_sacada p/ uma linha exigir cet. default 0.05
  nivelMediaReceita: number; // custo/receita ≥ isto → média. default 0.02 (2%)
  nivelAltaReceita: number; // custo/receita ≥ isto → alta. default 0.05 (5%)
  nivelMediaDep: number; // dependência ≥ isto → média (fallback sem custo). default 0.30
  nivelAltaDep: number; // dependência ≥ isto → alta. default 0.60
}

export const CONFIG_ANTECIPACAO_PADRAO: AntecipacaoConfig = {
  materialSharePct: 0.05,
  nivelMediaReceita: 0.02,
  nivelAltaReceita: 0.05,
  nivelMediaDep: 0.3,
  nivelAltaDep: 0.6,
};

export interface CredorExposicao {
  credor: string;
  saldo: number;
  share_pct: number; // saldo do credor ÷ exposicao_sacada
}

export interface AntecipacaoResult {
  motivo: MotivoAntecipacao;
  nivel: NivelTermometro | null;
  exposicao_sacada: number; // Σ saldo_devedor conhecido (>0)
  custo_recorrente_aa: number | null; // Σ saldo×cet; null se linha MATERIAL sem cet
  custo_sobre_receita_pct: number | null; // dreno de margem (custo ÷ receita LÍQUIDA TTM) — primária
  exposicao_sobre_ar_pct: number | null; // "exposição sacada ÷ AR aberto" — CRU (>1.0 = base misturada, alerta)
  concentracao_credor_pct: number | null; // share do maior credor
  coobrigacao_total: number; // Σ saldo das linhas co-obrigadas (exposição contingente)
  n_linhas: number;
  receita_liquida_ttm: number | null;
  credores: CredorExposicao[];
  // flags de degradação por métrica (a UI explica cada "—"):
  falta_cet: boolean;
  falta_receita: boolean;
  falta_ar: boolean;
}

const vazio = (
  motivo: MotivoAntecipacao,
  n_linhas: number,
  receita_liquida_ttm: number | null,
  coobrigacao_total = 0,
  exposicao_sacada = 0,
): AntecipacaoResult => ({
  motivo,
  nivel: null,
  exposicao_sacada,
  custo_recorrente_aa: null,
  custo_sobre_receita_pct: null,
  exposicao_sobre_ar_pct: null,
  concentracao_credor_pct: null,
  coobrigacao_total,
  n_linhas,
  receita_liquida_ttm,
  credores: [],
  falta_cet: false,
  falta_receita: false,
  falta_ar: false,
});

export function termometroAntecipacao(input: {
  linhas: LinhaAntecipacao[];
  ar_aberto: number | null; // AR em aberto (fin_contas_receber) — inclui os títulos antecipados
  receita_liquida_ttm: number | null; // Σ receita LÍQUIDA dos últimos 12 snapshots DRE (competência)
  config?: AntecipacaoConfig;
}): AntecipacaoResult {
  const cfg = input.config ?? CONFIG_ANTECIPACAO_PADRAO;
  const { linhas, ar_aberto, receita_liquida_ttm } = input;
  const n_linhas = linhas.length;

  // (1) Sem linhas → empty-state educativo. Não é erro: essas empresas podem simplesmente não
  // antecipar (grounding §0). O card ensina o que vigiar e acende quando a 1ª linha for cadastrada.
  if (n_linhas === 0) return vazio('sem_linhas', 0, receita_liquida_ttm);

  // Coobrigação conta mesmo sem saldo positivo? Não — sem saldo não há exposição mensurável.
  const comSaldo = linhas.filter((l) => l.saldo_devedor != null && l.saldo_devedor > 0);
  const exposicao_sacada = comSaldo.reduce((s, l) => s + (l.saldo_devedor as number), 0);
  const coobrigacao_total = comSaldo
    .filter((l) => l.coobrigada_por != null)
    .reduce((s, l) => s + (l.saldo_devedor as number), 0);

  // (2) Linhas existem mas nenhum saldo conhecido → não dá pra medir nada honestamente.
  if (comSaldo.length === 0 || exposicao_sacada <= 0) {
    return vazio('sem_base', n_linhas, receita_liquida_ttm, coobrigacao_total);
  }

  // Concentração por credor.
  const porCredor = new Map<string, number>();
  for (const l of comSaldo) {
    porCredor.set(l.credor, (porCredor.get(l.credor) ?? 0) + (l.saldo_devedor as number));
  }
  const credores: CredorExposicao[] = [...porCredor.entries()]
    .map(([credor, saldo]) => ({ credor, saldo, share_pct: saldo / exposicao_sacada }))
    .sort((a, b) => b.saldo - a.saldo);
  const concentracao_credor_pct = credores.length > 0 ? credores[0].share_pct : null;

  // (3) Custo recorrente = Σ saldo×cet. Se uma linha MATERIAL (≥ materialSharePct do total) não tem
  // cet, o custo não é honesto → null (NUNCA 0: 0 fingiria "antecipação de graça"). Linhas imateriais
  // sem cet são omitidas (impacto desprezível por definição).
  const materialSemCet = comSaldo.some(
    (l) => (l.saldo_devedor as number) / exposicao_sacada >= cfg.materialSharePct && l.cet_aa == null,
  );
  const falta_cet = materialSemCet;
  const custo_recorrente_aa = materialSemCet
    ? null
    : comSaldo
        .filter((l) => l.cet_aa != null)
        .reduce((s, l) => s + (l.saldo_devedor as number) * (l.cet_aa as number), 0);

  // (4) Dreno de margem (PRIMÁRIA) = custo ÷ receita LÍQUIDA TTM (Codex: líquida, não bruta).
  const temReceita = receita_liquida_ttm != null && receita_liquida_ttm > 0;
  const falta_receita = !temReceita;
  const custo_sobre_receita_pct =
    custo_recorrente_aa != null && temReceita
      ? custo_recorrente_aa / (receita_liquida_ttm as number)
      : null;

  // (5) Exposição sacada ÷ AR aberto (SECUNDÁRIA) — Codex: NÃO é "dependência/fração antecipada",
  // os campos não provam cessão. CRU (não capa): >1.0 = base misturada/over-hocking (alerta, não bug).
  // null se AR ausente (NUNCA 0). Ratio verdadeiro exigiria input `valor_bruto_recebiveis_cedidos` (v2).
  const temAr = ar_aberto != null && ar_aberto > 0;
  const falta_ar = !temAr;
  const exposicao_sobre_ar_pct = temAr ? exposicao_sacada / (ar_aberto as number) : null;

  // (6) Nível do termômetro: primário pelo dreno de margem; fallback pela dependência de volume.
  let nivel: NivelTermometro | null = null;
  if (custo_sobre_receita_pct != null) {
    nivel =
      custo_sobre_receita_pct >= cfg.nivelAltaReceita
        ? 'alta'
        : custo_sobre_receita_pct >= cfg.nivelMediaReceita
          ? 'media'
          : 'baixa';
  } else if (exposicao_sobre_ar_pct != null) {
    nivel =
      exposicao_sobre_ar_pct >= cfg.nivelAltaDep
        ? 'alta'
        : exposicao_sobre_ar_pct >= cfg.nivelMediaDep
          ? 'media'
          : 'baixa';
  }

  const motivo: MotivoAntecipacao = nivel == null ? 'sem_base' : 'ok';

  return {
    motivo,
    nivel,
    exposicao_sacada,
    custo_recorrente_aa,
    custo_sobre_receita_pct,
    exposicao_sobre_ar_pct,
    concentracao_credor_pct,
    coobrigacao_total,
    n_linhas,
    receita_liquida_ttm,
    credores,
    falta_cet,
    falta_receita,
    falta_ar,
  };
}
