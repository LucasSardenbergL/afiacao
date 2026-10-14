// src/lib/financeiro/ciclo-cliente-helpers.ts
// Ciclo financeiro por cliente — regra PURA sobre os fatos de v_ciclo_cliente_resumo.
// Spec: docs/superpowers/specs/2026-10-14-ciclo-financeiro-cockpit-cliente-design.md (v2, §4–§5).
// Princípios: ausente ≠ zero (null + motivo); todo R$ é CENÁRIO rotulado, nunca previsão;
// estoque vencido nunca soma ao recorrente; desconto só com custo do dinheiro informado.

export const CARENCIA_DIAS = 3;
export const LIMITE_ATRASO_LEVE = 7;
export const LIMITE_FOLGA = -3;
export const MIN_DOCUMENTOS = 6;
export const RECENCIA_MAX_DIAS = 90;
/** Teto de sanidade do custo do dinheiro (% a.m.) — acima disso o input é erro de digitação. */
export const CUSTO_MENSAL_MAX = 0.2;
const NP = ' — não é previsão';
export const DEGRAUS_PRAZO: readonly number[] = [90, 75, 60, 56, 45, 42, 35, 30, 28, 21, 14, 7];

export type Perfil = 'folga' | 'pontual' | 'atraso_leve' | 'atraso_cronico' | 'misto' | 'sem_dado';
export type Confianca = 'media' | 'baixa';
export type Alavanca = 'recuperar_vencido' | 'cobrar_atraso' | 'degrau_prazo' | 'nenhuma';
export type Cenario = { reais: number | null; motivo: string; rotulo: string };
export type SugestaoCliente = {
  alavanca: Alavanca;
  texto: string;
  cenario: Cenario | null;
  descontoCandidato: boolean;
  /** null quando não há degrau numérico (parcelado, ausente ou já no menor degrau). */
  degrau: { de: number; para: number } | null;
};

export type ResumoClienteRow = Record<string, unknown>;

export type ResumoCliente = {
  company: string; omieCodigoCliente: number; nomeCliente: string | null;
  nParcelas: number | null; nDocumentos: number | null; valorPago: number | null; valorPagoSemBaixa: number | null;
  prazoConcedidoPond: number | null; prazoRealPond: number | null; atrasoPond: number | null;
  atrasoP50: number | null; atrasoP80: number | null; atrasoP80Valor: number | null; atrasoMaxObservado: number | null;
  excessoCarenciaPond: number | null; pctValorAtrasado: number | null; ultimaBaixa: string | null;
  nVencidas: number | null; saldoVencido: number | null; saldoVencido90: number | null; diasVencidoMax: number | null;
  volumeEmitido12m: number | null; primeiraEmissao: string | null; nStatusAmbiguo: number | null;
};

/** Número finito ou null. Nunca `Number(null) === 0`. */
export function num(x: unknown): number | null {
  if (x === null || x === undefined) return null;
  if (typeof x === 'string' && x.trim() === '') return null;
  const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
}

const txt = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null);

export function normalizarResumo(row: ResumoClienteRow): ResumoCliente {
  return {
    company: String(row.company),
    omieCodigoCliente: num(row.omie_codigo_cliente) ?? -1,
    nomeCliente: txt(row.nome_cliente),
    nParcelas: num(row.n_parcelas), nDocumentos: num(row.n_documentos),
    valorPago: num(row.valor_pago), valorPagoSemBaixa: num(row.valor_pago_sem_baixa),
    prazoConcedidoPond: num(row.prazo_concedido_pond), prazoRealPond: num(row.prazo_real_pond),
    atrasoPond: num(row.atraso_pond), atrasoP50: num(row.atraso_p50), atrasoP80: num(row.atraso_p80),
    atrasoP80Valor: num(row.atraso_p80_valor), atrasoMaxObservado: num(row.atraso_max_observado),
    excessoCarenciaPond: num(row.excesso_carencia_pond), pctValorAtrasado: num(row.pct_valor_atrasado),
    ultimaBaixa: txt(row.ultima_baixa),
    nVencidas: num(row.n_vencidas), saldoVencido: num(row.saldo_vencido),
    saldoVencido90: num(row.saldo_vencido_90), diasVencidoMax: num(row.dias_vencido_max),
    volumeEmitido12m: num(row.volume_emitido_12m), primeiraEmissao: txt(row.primeira_emissao),
    nStatusAmbiguo: num(row.n_status_ambiguo),
  };
}

export function perfilPorP80(p80: number | null): Exclude<Perfil, 'misto'> {
  if (p80 === null) return 'sem_dado';
  if (p80 <= LIMITE_FOLGA) return 'folga';
  if (p80 <= 0) return 'pontual';
  if (p80 <= LIMITE_ATRASO_LEVE) return 'atraso_leve';
  return 'atraso_cronico';
}

export function perfilCliente(r: ResumoCliente): { perfil: Perfil; perfilQtd: Perfil; perfilValor: Perfil } {
  const perfilQtd = perfilPorP80(r.atrasoP80);
  const perfilValor = perfilPorP80(r.atrasoP80Valor);
  return { perfil: perfilQtd === perfilValor ? perfilQtd : 'misto', perfilQtd, perfilValor };
}

function diasEntre(deIso: string, ateIso: string): number {
  return Math.round((Date.parse(`${ateIso}T00:00:00Z`) - Date.parse(`${deIso}T00:00:00Z`)) / 86_400_000);
}

export function confiancaCliente(r: ResumoCliente, hojeSp: string): Confianca {
  if (r.nDocumentos === null || r.nDocumentos < MIN_DOCUMENTOS || r.ultimaBaixa === null) return 'baixa';
  return diasEntre(r.ultimaBaixa, hojeSp) <= RECENCIA_MAX_DIAS ? 'media' : 'baixa';
}

/** Próximo degrau usual ESTRITAMENTE abaixo do prazo (arredondado). Sem 7→0. */
export function degrauAbaixo(prazo: number): number | null {
  const p = Math.round(prazo);
  for (const d of DEGRAUS_PRAZO) if (d < p) return d;
  return null;
}

export function porDia(volume: number | null): number | null {
  return volume === null || volume <= 0 ? null : volume / 365;
}

export function sugerirAlavanca(r: ResumoCliente, hojeSp: string): SugestaoCliente {
  const nada: SugestaoCliente = { alavanca: 'nenhuma', texto: '', cenario: null, descontoCandidato: false, degrau: null };

  // (0) Estoque vencido — qualquer perfil/confiança; nunca somado ao recorrente.
  if (r.saldoVencido !== null && r.saldoVencido > 0) {
    const brl = (v: number) => `R$ ${v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}`;
    const parte90 = r.saldoVencido90 === null ? '' : ` (${brl(r.saldoVencido90)} > 90d)`;
    return {
      ...nada,
      alavanca: 'recuperar_vencido',
      texto: `${brl(r.saldoVencido)} vencidos${parte90}`,
      cenario: { reais: r.saldoVencido, motivo: 'saldo vencido em aberto', rotulo: `estoque vencido a recuperar (não é recorrente nem lucro)${NP}` },
    };
  }

  if (confiancaCliente(r, hojeSp) === 'baixa') return { ...nada, texto: 'Poucos documentos ou sem pagamento recente — só fatos' };
  const { perfil } = perfilCliente(r);
  if (perfil === 'misto') return { ...nada, texto: 'Frequência e valor do atraso divergem — sem sugestão automática' };
  if (perfil === 'sem_dado') return nada;

  const dia = porDia(r.volumeEmitido12m);

  if (perfil === 'atraso_leve' || perfil === 'atraso_cronico') {
    const excesso = r.excessoCarenciaPond;
    const cenario: Cenario =
      dia === null
        ? { reais: null, motivo: 'sem volume na janela', rotulo: `cenário: atraso cai à carência de 3d${NP}` }
        : excesso === null
          ? { reais: null, motivo: 'sem atraso medido', rotulo: `cenário: atraso cai à carência de 3d${NP}` }
          : { reais: excesso * dia, motivo: 'excesso sobre a carência × volume diário', rotulo: `cenário: atraso cai à carência de 3d${NP}` };
    return {
      ...nada,
      alavanca: 'cobrar_atraso',
      texto: perfil === 'atraso_cronico' ? 'Régua de cobrança ativa + revisar limite de crédito' : 'Lembrete D−2 e D+1',
      cenario,
      descontoCandidato: perfil === 'atraso_leve',
    };
  }

  // pontual / folga → degrau
  const prazo = r.prazoConcedidoPond;
  if (prazo === null) return nada;
  const rotuloDegrau = `cenário: se continuar pagando no vencimento${NP}`;

  // Média ponderada só é a CONDIÇÃO quando toda NF tem parcela única (spec §5.3).
  if (r.nParcelas === null || r.nDocumentos === null) {
    return {
      ...nada, alavanca: 'degrau_prazo',
      texto: 'Degrau de prazo — sem contagem de parcelas/documentos para validar',
      cenario: { reais: null, motivo: 'sem contagem de parcelas/documentos', rotulo: rotuloDegrau },
    };
  }
  if (r.nParcelas > r.nDocumentos) {
    return {
      ...nada, alavanca: 'degrau_prazo',
      texto: `Parcelado: prazo médio ${Math.round(prazo)} d não é a condição — revisar o calendário de parcelas no drill`,
      cenario: { reais: null, motivo: 'parcelado: média não é condição', rotulo: rotuloDegrau },
    };
  }

  const para = degrauAbaixo(prazo);
  if (para === null) return { ...nada, texto: 'Prazo já no menor degrau usual' };
  const de = Math.round(prazo);
  const degrau = { de, para };
  if (perfil === 'folga') {
    return {
      ...nada, alavanca: 'degrau_prazo', degrau,
      texto: `Candidato a degrau ${de}→${para} dias`,
      cenario: { reais: null, motivo: 'benefício depende de piloto', rotulo: `paga antes do vencimento — encurtar pode liberar zero${NP}` },
    };
  }
  return {
    ...nada, alavanca: 'degrau_prazo', degrau,
    texto: `Degrau ${de}→${para} dias (hipótese)`,
    // R$ usa o prazo CRU; o arredondamento é só do texto.
    cenario: dia === null
      ? { reais: null, motivo: 'sem volume na janela', rotulo: rotuloDegrau }
      : { reais: (prazo - para) * dia, motivo: 'dias a menos × volume diário', rotulo: rotuloDegrau },
  };
}

export type ResultadoDesconto =
  | { ok: true; dMax: number }
  | { ok: false; motivo: 'custo_ausente' | 'custo_invalido' | 'dias_invalidos' };

/** Teto de indiferença: P·(1−d)·(1+c)^(N/30) = P ⇒ d = 1 − (1+c)^(−N/30). Antes de custos e risco. */
export function descontoMaximo(custoMensal: number | null, dias: number): ResultadoDesconto {
  if (custoMensal === null) return { ok: false, motivo: 'custo_ausente' };
  if (!Number.isFinite(custoMensal) || custoMensal <= 0) return { ok: false, motivo: 'custo_invalido' };
  if (!Number.isFinite(dias) || dias <= 0) return { ok: false, motivo: 'dias_invalidos' };
  return { ok: true, dMax: 1 - Math.pow(1 + custoMensal, -dias / 30) };
}

/** Input BR em % a.m. ("2,5" → 0,025). Vazio = ausente; resto inválido = fail-closed. */
export function parseCustoMensal(texto: string):
  | { ok: true; c: number }
  | { ok: false; motivo: 'custo_ausente' | 'custo_invalido' } {
  const t = texto.trim();
  if (t === '') return { ok: false, motivo: 'custo_ausente' };
  if (!/^\d+([.,]\d+)?$/.test(t)) return { ok: false, motivo: 'custo_invalido' };
  const pct = Number(t.replace(',', '.'));
  if (!Number.isFinite(pct) || pct <= 0 || pct / 100 > CUSTO_MENSAL_MAX) return { ok: false, motivo: 'custo_invalido' };
  return { ok: true, c: pct / 100 };
}
