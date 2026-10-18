// Regra pura da frente 4 do ciclo (PMP por fornecedor e custo do prazo). Fatos vêm de v_ciclo_cp_titulos e
// v_ciclo_fornecedor_resumo (RPC master-only). Premissa do founder: prazo maior = preço maior, então a regra
// mostra o CUSTO do prazo (desconto perdido, juros/multa), nunca sugere pedir prazo.
// Money-path: ausente ≠ zero — dado faltando degrada para null, nunca vira 0.
import { num, porDia } from '@/lib/financeiro/ciclo-cliente-helpers';

export type SituacaoCp = 'paga' | 'paga_sem_baixa' | 'paga_parcial' | 'vencida_aberta' | 'a_vencer' | 'status_ambiguo';

export type TituloCp = {
  company: string; fornecedor: number; lancamento: number; documento: string | null;
  emissao: string; vencimento: string; dataBaixa: string | null; dataBaixaConfiavel: boolean;
  valor: number; valorAberto: number | null; situacao: SituacaoCp; prazoConcedido: number;
  prazoReal: number | null; atrasoBaixa: number | null; descontoObtido: number | null;
  descontoInformado: number | null; valorPagoPrincipal: number | null; encargoPago: number | null; diasVencido: number | null;
};

export type ResumoFornecedor = {
  company: string; fornecedor: number; nome: string | null; fonteNome: string | null;
  compras12m: number | null; nTitulos12m: number | null; nDocumentosPagos: number | null; valorPago: number | null;
  prazoConcedidoPond: number | null; prazoRealPond: number | null; atrasoPondSinal: number | null; atrasoPondPos: number | null;
  nPrazoNegativo: number | null; valorPagoEmDia: number | null; valorPagoAtrasado: number | null;
  valorPagoDataIncerta: number | null; valorPagoConfDecisao: number | null;
  descontoObtido12m: number | null; encargoPago12m: number | null; nTitulosComDesconto: number | null;
  valorVencidoAberto: number | null; nVencidas: number | null; diasVencidoMax: number | null;
  valorAVencer: number | null; nStatusAmbiguo: number | null;
};

const txt = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null);

export function normalizarTituloCp(r: Record<string, unknown>): TituloCp {
  return {
    company: String(r.company),
    fornecedor: num(r.omie_codigo_fornecedor) ?? -1,
    lancamento: num(r.omie_codigo_lancamento) ?? -1,
    documento: txt(r.numero_documento),
    emissao: String(r.data_emissao),
    vencimento: String(r.data_vencimento),
    dataBaixa: txt(r.data_baixa),
    dataBaixaConfiavel: r.data_baixa_confiavel === true,
    valor: num(r.valor_documento) ?? 0,
    valorAberto: num(r.valor_aberto),
    situacao: r.situacao as SituacaoCp,
    prazoConcedido: num(r.prazo_concedido_dias) ?? 0,
    prazoReal: num(r.prazo_real_dias),
    atrasoBaixa: num(r.dias_atraso_baixa),
    descontoObtido: num(r.desconto_obtido),
    descontoInformado: num(r.desconto_informado_omie),
    valorPagoPrincipal: num(r.valor_pago_principal),
    encargoPago: num(r.encargo_pago),
    diasVencido: num(r.dias_vencido),
  };
}

export function normalizarResumoFornecedor(r: Record<string, unknown>): ResumoFornecedor {
  return {
    company: String(r.company),
    fornecedor: num(r.omie_codigo_fornecedor) ?? -1,
    nome: txt(r.nome_fornecedor),
    fonteNome: txt(r.fonte_nome),
    compras12m: num(r.compras_12m),
    nTitulos12m: num(r.n_titulos_12m),
    nDocumentosPagos: num(r.n_documentos_pagos),
    valorPago: num(r.valor_pago),
    prazoConcedidoPond: num(r.prazo_concedido_pond),
    prazoRealPond: num(r.prazo_real_pond),
    atrasoPondSinal: num(r.atraso_pond_sinal),
    atrasoPondPos: num(r.atraso_pond_pos),
    nPrazoNegativo: num(r.n_prazo_negativo),
    valorPagoEmDia: num(r.valor_pago_em_dia),
    valorPagoAtrasado: num(r.valor_pago_atrasado),
    valorPagoDataIncerta: num(r.valor_pago_data_incerta),
    valorPagoConfDecisao: num(r.valor_pago_conf_decisao),
    descontoObtido12m: num(r.desconto_obtido_12m),
    encargoPago12m: num(r.encargo_pago_12m),
    nTitulosComDesconto: num(r.n_titulos_com_desconto),
    valorVencidoAberto: num(r.valor_vencido_aberto),
    nVencidas: num(r.n_vencidas),
    diasVencidoMax: num(r.dias_vencido_max),
    valorAVencer: num(r.valor_a_vencer),
    nStatusAmbiguo: num(r.n_status_ambiguo),
  };
}

// ── datas ISO (YYYY-MM-DD) em UTC, sem fuso ──
function somaDias(iso: string, dias: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
const chaveDocumento = (t: TituloCp) => t.documento ?? `l:${t.lancamento}`;
const temDesconto = (t: TituloCp) => t.descontoInformado !== null && t.descontoInformado > 0;

type Documento = { chave: string; vencimento: string; desconto: number; principal: number; emDia: boolean };

/** Agrupa parcelas por NF: vencimento = o mais cedo; em dia só se TODAS as parcelas tiverem atraso ≤ 0. */
function documentosComDesconto(titulos: TituloCp[]): Documento[] {
  const m = new Map<string, Documento>();
  for (const t of titulos) {
    if (!temDesconto(t)) continue;
    const k = chaveDocumento(t);
    const emDia = t.atrasoBaixa !== null && t.atrasoBaixa <= 0;
    const base = t.valorPagoPrincipal ?? t.valor;
    const d = m.get(k);
    if (!d) m.set(k, { chave: k, vencimento: t.vencimento, desconto: t.descontoInformado ?? 0, principal: base, emDia });
    else {
      if (t.vencimento < d.vencimento) d.vencimento = t.vencimento;
      d.desconto += t.descontoInformado ?? 0;
      d.principal += base;
      d.emDia = d.emDia && emDia;
    }
  }
  return [...m.values()].sort((a, b) => (a.vencimento < b.vencimento ? -1 : a.vencimento > b.vencimento ? 1 : 0));
}

/** Vencimento do 1º de ≥ 3 NFs com desconto em até 90 dias. Desconto isolado não abre regime. */
export function inicioRegimeDesconto(titulos: TituloCp[]): string | null {
  const docs = documentosComDesconto(titulos);
  for (let i = 0; i + 2 < docs.length; i++) {
    if (docs[i + 2].vencimento <= somaDias(docs[i].vencimento, 90)) return docs[i].vencimento;
  }
  return null;
}

/** Igual ao percentile_cont do Postgres (interpolação linear). `xs` ordenado. */
function percentil(xs: number[], p: number): number {
  const pos = (xs.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
}

export type MotivoSemTaxa = 'sem_regime' | 'amostra' | 'dispersao' | 'nao_pontualidade';

export function taxaDescontoObservada(
  titulos: TituloCp[], regimeInicio: string | null, hoje: string,
): { taxa: number | null; nDocumentos: number; motivo: MotivoSemTaxa | null } {
  if (regimeInicio === null) return { taxa: null, nDocumentos: 0, motivo: 'sem_regime' };
  const ini = [regimeInicio, somaDias(hoje, -180)].sort()[1];
  const docs = documentosComDesconto(titulos).filter((d) => d.vencimento >= ini && d.vencimento < hoje && d.principal > 0);
  const n = docs.length;
  if (n < 5) return { taxa: null, nDocumentos: n, motivo: 'amostra' };
  const taxas = docs.map((d) => d.desconto / d.principal).sort((a, b) => a - b);
  const mediana = percentil(taxas, 0.5);
  if (Math.abs(percentil(taxas, 0.2) - mediana) > 0.005 || Math.abs(percentil(taxas, 0.8) - mediana) > 0.005) {
    return { taxa: null, nDocumentos: n, motivo: 'dispersao' };
  }
  if (docs.filter((d) => d.emDia).length / n < 0.8) return { taxa: null, nDocumentos: n, motivo: 'nao_pontualidade' };
  return { taxa: mediana, nDocumentos: n, motivo: null };
}

export type CustoPrazo = {
  taxa: number | null; regimeInicio: string | null; perdidoAtraso: number | null;
  perdidoEmDiaSemDesconto: number | null; encargoPago: number | null; descontoObtido: number | null;
};

/** Desconto perdido é CENÁRIO (taxa observada × base); desconto obtido e juros/multa são apurados do resumo. */
export function custoDoPrazo(titulos: TituloCp[], resumo: ResumoFornecedor, hoje: string): CustoPrazo {
  const regimeInicio = inicioRegimeDesconto(titulos);
  const { taxa } = taxaDescontoObservada(titulos, regimeInicio, hoje);
  const apurado = { encargoPago: resumo.encargoPago12m, descontoObtido: resumo.descontoObtido12m };
  if (taxa === null || regimeInicio === null) {
    return { taxa: null, regimeInicio, perdidoAtraso: null, perdidoEmDiaSemDesconto: null, ...apurado };
  }
  let perdidoAtraso = 0;
  let perdidoEmDiaSemDesconto = 0;
  for (const t of titulos) {
    if (t.situacao !== 'paga' || t.vencimento < regimeInicio || !t.dataBaixaConfiavel) continue;
    if (t.descontoInformado === null || t.atrasoBaixa === null) continue;
    const perdido = Math.max(taxa * (t.valorPagoPrincipal ?? t.valor) - t.descontoInformado, 0);
    if (t.atrasoBaixa > 0) perdidoAtraso += perdido;
    else perdidoEmDiaSemDesconto += perdido;
  }
  return { taxa, regimeInicio, perdidoAtraso, perdidoEmDiaSemDesconto, ...apurado };
}

export type ItemFilaCusto = { resumo: ResumoFornecedor; custo: CustoPrazo; totalRs: number };

/**
 * Fila "onde o prazo está custando": R$ perdido por atraso (cenário) + juros/multa (apurado), desempate pelo
 * vencido em aberto. Sem nenhum dos dois = "sem evidência" (nunca R$ 0). Pago em dia sem desconto vai para
 * "conferir boleto", fora do total.
 */
export function montarFilaCustoPrazo(itens: Array<{ resumo: ResumoFornecedor; custo: CustoPrazo }>): {
  fila: ItemFilaCusto[]; semEvidencia: ResumoFornecedor[]; conferirBoleto: Array<{ resumo: ResumoFornecedor; valor: number }>;
} {
  const fila: ItemFilaCusto[] = [];
  const semEvidencia: ResumoFornecedor[] = [];
  const conferirBoleto: Array<{ resumo: ResumoFornecedor; valor: number }> = [];
  for (const { resumo, custo } of itens) {
    const emDia = custo.perdidoEmDiaSemDesconto;
    if (emDia !== null && emDia > 0) conferirBoleto.push({ resumo, valor: emDia });
    if (custo.perdidoAtraso === null && custo.encargoPago === null) {
      semEvidencia.push(resumo);
      continue;
    }
    const totalRs = (custo.perdidoAtraso ?? 0) + (custo.encargoPago ?? 0);
    if (totalRs > 0) fila.push({ resumo, custo, totalRs });
  }
  fila.sort((a, b) => b.totalRs - a.totalRs || (b.resumo.valorVencidoAberto ?? 0) - (a.resumo.valorVencidoAberto ?? 0));
  conferirBoleto.sort((a, b) => b.valor - a.valor);
  return { fila, semEvidencia, conferirBoleto };
}

export type PontualidadeMes = {
  mes: string; valorVencido: number; valorAberto: number;
  pctEmDia: number | null; pctAtrasado: number | null; coberturaData: number | null; mesParcial: boolean;
};

/** Por mês de vencimento (só o que já venceu): % em dia / atrasado entre os títulos com data de baixa confiável. */
export function pontualidadePorMes(titulos: TituloCp[], hoje: string): PontualidadeMes[] {
  const meses = new Map<string, { vencido: number; aberto: number; datavel: number; emDia: number; atrasado: number }>();
  for (const t of titulos) {
    if (t.vencimento > hoje || t.situacao === 'status_ambiguo') continue;
    const mes = `${t.vencimento.slice(0, 7)}-01`;
    const m = meses.get(mes) ?? { vencido: 0, aberto: 0, datavel: 0, emDia: 0, atrasado: 0 };
    m.vencido += t.valor;
    if (t.situacao === 'vencida_aberta' || t.situacao === 'paga_parcial') m.aberto += t.valorAberto ?? 0;
    if (t.dataBaixaConfiavel && t.atrasoBaixa !== null) {
      m.datavel += t.valor;
      if (t.atrasoBaixa > 0) m.atrasado += t.valor;
      else m.emDia += t.valor;
    }
    meses.set(mes, m);
  }
  const mesHoje = `${hoje.slice(0, 7)}-01`;
  return [...meses.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([mes, m]) => ({
      mes,
      valorVencido: m.vencido,
      valorAberto: m.aberto,
      pctEmDia: m.datavel > 0 ? m.emDia / m.datavel : null,
      pctAtrasado: m.datavel > 0 ? m.atrasado / m.datavel : null,
      coberturaData: m.vencido > 0 ? m.datavel / m.vencido : null,
      mesParcial: mes === mesHoje,
    }));
}

export function confiancaFornecedor(r: ResumoFornecedor): 'media' | 'baixa' {
  if (r.nDocumentosPagos === null || r.nDocumentosPagos < 6) return 'baixa';
  if (r.valorPago === null || r.valorPago <= 0 || r.valorPagoConfDecisao === null) return 'baixa';
  return r.valorPagoConfDecisao / r.valorPago < 0.8 ? 'baixa' : 'media';
}

/** R$/dia sobre COMPRAS (não CMV): quanto 1 dia a mais ou a menos de PMP move de caixa. */
export function rotuloPorDiaCompras(compras12m: number | null): { porDia: number } | null {
  const v = porDia(compras12m);
  return v === null ? null : { porDia: v };
}
