// Regra pura da frente 4 do ciclo (PMP por fornecedor e custo do prazo). Fatos vêm de v_ciclo_cp_titulos e
// v_ciclo_fornecedor_resumo (RPC master-only). Premissa do founder: prazo maior = preço maior, então a regra
// mostra o CUSTO do prazo (desconto perdido, juros/multa), nunca sugere pedir prazo.
// Money-path: ausente ≠ zero — dado faltando degrada para null, nunca vira 0.
import { num, porDia } from '@/lib/financeiro/ciclo-cliente-helpers';
import { addDias } from '@/lib/time/sp-day';

type SituacaoCp = 'paga' | 'paga_sem_baixa' | 'paga_parcial' | 'vencida_aberta' | 'a_vencer' | 'status_ambiguo';

export type TituloCp = {
  company: string; fornecedor: number; lancamento: number; documento: string | null;
  emissao: string; vencimento: string; dataBaixa: string | null; dataBaixaConfiavel: boolean;
  valor: number; valorAberto: number | null; situacao: SituacaoCp; prazoConcedido: number;
  prazoReal: number | null; atrasoBaixa: number | null; descontoObtido: number | null;
  descontoInformado: number | null; valorPagoPrincipal: number | null; encargoPago: number | null; diasVencido: number | null;
  /** De onde vem o valorAberto: resumo do Omie (exato) ou o valor cheio do título (estimativa). */
  fonteValorAberto: FonteValorAberto | null;
};

type FonteValorAberto = 'omie_resumo' | 'valor_titulo';

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
const fonteValorAberto = (x: unknown): FonteValorAberto | null =>
  (x === 'omie_resumo' || x === 'valor_titulo' ? x : null);

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
    fonteValorAberto: fonteValorAberto(r.fonte_valor_aberto),
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

/** Vencimento no sábado/domingo: pagar no próximo dia útil (segunda) é em dia. Feriado não é tratado (sem tabela). */
function folgaFimDeSemana(venc: string): number {
  const dia = new Date(`${venc}T00:00:00Z`).getUTCDay();
  return dia === 6 ? 2 : dia === 0 ? 1 : 0;
}
/** Em dia = data de baixa confiável até o vencimento (ou até o próximo dia útil, se venceu no fim de semana). */
const pagoEmDia = (t: TituloCp) => t.atrasoBaixa !== null && t.atrasoBaixa <= folgaFimDeSemana(t.vencimento);

const chaveDocumento = (t: TituloCp) => t.documento ?? `l:${t.lancamento}`;
const temDesconto = (t: TituloCp) => t.descontoInformado !== null && t.descontoInformado > 0;

type Documento = { chave: string; vencimento: string; desconto: number; principal: number; emDia: boolean };

/**
 * Agrupa parcelas por NF. Taxa e vencimento vêm só das parcelas COM desconto; "em dia" olha TODAS as parcelas pagas
 * da NF (uma parcela atrasada sem desconto, ou com data incerta, tira a NF de "em dia" — Codex review #1).
 */
function documentosComDesconto(titulos: TituloCp[]): Documento[] {
  const m = new Map<string, Documento & { comDesconto: boolean }>();
  for (const t of titulos) {
    const pagaParcela = t.situacao === 'paga' || t.situacao === 'paga_sem_baixa';
    if (!pagaParcela && !temDesconto(t)) continue;
    const k = chaveDocumento(t);
    const d = m.get(k) ?? { chave: k, vencimento: t.vencimento, desconto: 0, principal: 0, emDia: true, comDesconto: false };
    if (pagaParcela) d.emDia = d.emDia && pagoEmDia(t);
    if (temDesconto(t)) {
      if (!d.comDesconto || t.vencimento < d.vencimento) d.vencimento = t.vencimento;
      d.desconto += t.descontoInformado ?? 0;
      d.principal += t.valorPagoPrincipal ?? t.valor;
      d.comDesconto = true;
    }
    m.set(k, d);
  }
  return [...m.values()].filter((d) => d.comDesconto)
    .sort((a, b) => (a.vencimento < b.vencimento ? -1 : a.vencimento > b.vencimento ? 1 : 0));
}

/** Vencimento do 1º de ≥ 3 NFs com desconto em até 90 dias. Desconto isolado não abre regime. */
export function inicioRegimeDesconto(titulos: TituloCp[]): string | null {
  const docs = documentosComDesconto(titulos);
  for (let i = 0; i + 2 < docs.length; i++) {
    if (docs[i + 2].vencimento <= addDias(docs[i].vencimento, 90)) return docs[i].vencimento;
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
  const ini = [regimeInicio, addDias(hoje, -180)].sort()[1];
  const docs = documentosComDesconto(titulos).filter((d) => d.vencimento >= ini && d.vencimento < hoje && d.principal > 0);
  const n = docs.length;
  if (n < 5) return { taxa: null, nDocumentos: n, motivo: 'amostra' };
  const taxas = docs.map((d) => d.desconto / d.principal).sort((a, b) => a - b);
  const mediana = percentil(taxas, 0.5);
  // ±0,5 p.p. inclusivo; a folga de 1e-9 absorve o erro binário (1,5% e 2,5% em torno de 2% — Codex review #8).
  const TOL = 0.005 + 1e-9;
  if (Math.abs(percentil(taxas, 0.2) - mediana) > TOL || Math.abs(percentil(taxas, 0.8) - mediana) > TOL) {
    return { taxa: null, nDocumentos: n, motivo: 'dispersao' };
  }
  if (docs.filter((d) => d.emDia).length / n < 0.8) return { taxa: null, nDocumentos: n, motivo: 'nao_pontualidade' };
  return { taxa: mediana, nDocumentos: n, motivo: null };
}

export type CustoPrazo = {
  taxa: number | null; regimeInicio: string | null; perdidoAtraso: number | null;
  /** Pago em dia sem desconto nenhum (cenário). */
  perdidoEmDiaSemDesconto: number | null;
  /** Pago em dia com desconto, mas abaixo da taxa observada (cenário) — não é "sem desconto". */
  perdidoEmDiaDescontoAbaixo: number | null;
  encargoPago: number | null; descontoObtido: number | null;
};

/** Desconto perdido é CENÁRIO (taxa observada × base); desconto obtido e juros/multa são apurados do resumo. */
export function custoDoPrazo(titulos: TituloCp[], resumo: ResumoFornecedor, hoje: string): CustoPrazo {
  const regimeInicio = inicioRegimeDesconto(titulos);
  const { taxa } = taxaDescontoObservada(titulos, regimeInicio, hoje);
  const apurado = { encargoPago: resumo.encargoPago12m, descontoObtido: resumo.descontoObtido12m };
  if (taxa === null || regimeInicio === null) {
    return { taxa: null, regimeInicio, perdidoAtraso: null, perdidoEmDiaSemDesconto: null, perdidoEmDiaDescontoAbaixo: null, ...apurado };
  }
  let perdidoAtraso = 0;
  let perdidoEmDiaSemDesconto = 0;
  let perdidoEmDiaDescontoAbaixo = 0;
  for (const t of titulos) {
    if (t.situacao !== 'paga' || t.vencimento < regimeInicio || !t.dataBaixaConfiavel) continue;
    if (t.descontoInformado === null || t.atrasoBaixa === null) continue;
    // Centavo por título: a taxa observada (mediana de razões) carrega resíduo binário — 0,0200002 × base − desconto
    // cheio dava R$ 0,0015 e punha a Sayerlack na fila com "R$ 0" (pré-voo em prod, 2026-10-18).
    const perdido = Math.max(Math.round((taxa * (t.valorPagoPrincipal ?? t.valor) - t.descontoInformado) * 100) / 100, 0);
    if (!pagoEmDia(t)) perdidoAtraso += perdido;
    else if (t.descontoInformado > 0) perdidoEmDiaDescontoAbaixo += perdido;
    else perdidoEmDiaSemDesconto += perdido;
  }
  return { taxa, regimeInicio, perdidoAtraso, perdidoEmDiaSemDesconto, perdidoEmDiaDescontoAbaixo, ...apurado };
}

export type ItemFilaCusto = { resumo: ResumoFornecedor; custo: CustoPrazo; totalRs: number };

/**
 * Fila "onde o prazo está custando": R$ perdido por atraso (cenário) + juros/multa (apurado), desempate pelo
 * vencido em aberto. Sem nenhum dos dois = "sem evidência" (nunca R$ 0). Pago em dia sem desconto (ou com desconto
 * abaixo do observado) vai para "conferir boleto", fora do total.
 */
export type ItemConferirBoleto = { resumo: ResumoFornecedor; valor: number; semDesconto: number; descontoAbaixo: number };

export function montarFilaCustoPrazo(itens: Array<{ resumo: ResumoFornecedor; custo: CustoPrazo }>): {
  fila: ItemFilaCusto[]; semEvidencia: ResumoFornecedor[]; conferirBoleto: ItemConferirBoleto[];
} {
  const fila: ItemFilaCusto[] = [];
  const semEvidencia: ResumoFornecedor[] = [];
  const conferirBoleto: ItemConferirBoleto[] = [];
  for (const { resumo, custo } of itens) {
    const semDesconto = custo.perdidoEmDiaSemDesconto ?? 0;
    const descontoAbaixo = custo.perdidoEmDiaDescontoAbaixo ?? 0;
    if (semDesconto + descontoAbaixo > 0) {
      conferirBoleto.push({ resumo, valor: semDesconto + descontoAbaixo, semDesconto, descontoAbaixo });
    }
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

const brlCurto = (v: number) => `R$ ${Math.round(v).toLocaleString('pt-BR')}`;

/** O que o "conferir boleto" diz: sem desconto, desconto abaixo do observado, ou os dois (com o R$ de cada). */
export function rotuloConferirBoleto({ semDesconto, descontoAbaixo }: { semDesconto: number; descontoAbaixo: number }): string {
  if (semDesconto > 0 && descontoAbaixo > 0) {
    return `pago em dia sem desconto (${brlCurto(semDesconto)}) ou com desconto abaixo do observado (${brlCurto(descontoAbaixo)})`;
  }
  return descontoAbaixo > 0 ? 'pago em dia com desconto abaixo do observado' : 'pago em dia sem desconto';
}

/** Desconto do drill = o OBTIDO (o mesmo da tabela). O informado pelo Omie sem confirmação vai à parte, nunca no lugar. */
export function descontoNoDrill(t: TituloCp): { obtido: number | null; informadoNaoConfirmado: number | null } {
  return {
    obtido: t.descontoObtido,
    informadoNaoConfirmado: t.descontoObtido === null && t.descontoInformado !== null && t.descontoInformado > 0
      ? t.descontoInformado : null,
  };
}

export type PontualidadeMes = {
  mes: string; valorVencido: number; valorAberto: number;
  pctEmDia: number | null; pctAtrasado: number | null; coberturaData: number | null; mesParcial: boolean;
};

/** Por mês de vencimento (só o que já venceu — vencimento < hoje, igual ao SQL; vence hoje = a vencer):
 *  % em dia / atrasado entre os títulos com data de baixa confiável. Parcial: o mês corrente e todo mês que começa
 *  antes da janela de 12 m das pagas (vencimento ≥ hoje − 365) — ali só entra parte do mês, ou só os abertos. */
export function pontualidadePorMes(titulos: TituloCp[], hoje: string): PontualidadeMes[] {
  const meses = new Map<string, { vencido: number; aberto: number; datavel: number; emDia: number; atrasado: number }>();
  for (const t of titulos) {
    if (t.vencimento >= hoje || t.situacao === 'a_vencer' || t.situacao === 'status_ambiguo') continue;
    const mes = `${t.vencimento.slice(0, 7)}-01`;
    const m = meses.get(mes) ?? { vencido: 0, aberto: 0, datavel: 0, emDia: 0, atrasado: 0 };
    m.vencido += t.valor;
    if (t.situacao === 'vencida_aberta' || t.situacao === 'paga_parcial') m.aberto += t.valorAberto ?? 0;
    if (t.dataBaixaConfiavel && t.atrasoBaixa !== null) {
      m.datavel += t.valor;
      if (pagoEmDia(t)) m.emDia += t.valor;
      else m.atrasado += t.valor;
    }
    meses.set(mes, m);
  }
  const mesHoje = `${hoje.slice(0, 7)}-01`;
  const inicioJanela = addDias(hoje, -365);
  return [...meses.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([mes, m]) => ({
      mes,
      valorVencido: m.vencido,
      valorAberto: m.aberto,
      pctEmDia: m.datavel > 0 ? m.emDia / m.datavel : null,
      pctAtrasado: m.datavel > 0 ? m.atrasado / m.datavel : null,
      coberturaData: m.vencido > 0 ? m.datavel / m.vencido : null,
      mesParcial: mes === mesHoje || mes < inicioJanela,
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

export type OrdemFornecedores = 'compras' | 'atraso' | 'vencido' | 'juros' | 'desconto' | 'nome';
const CAMPO_ORDEM: Record<Exclude<OrdemFornecedores, 'nome'>, keyof ResumoFornecedor> = {
  compras: 'compras12m', atraso: 'atrasoPondPos', vencido: 'valorVencidoAberto', juros: 'encargoPago12m', desconto: 'descontoObtido12m',
};
const desc = (a: number | null, b: number | null) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : b - a);

/** Ordena a tabela: campo desc com null por último (ausente nunca vira 0), nome asc; desempate por compras. Ordem
 *  desconhecida (URL editado à mão) cai em compras. */
export function ordenarFornecedores(xs: ResumoFornecedor[], ordem: string): ResumoFornecedor[] {
  const porCompras = (a: ResumoFornecedor, b: ResumoFornecedor) => desc(a.compras12m, b.compras12m);
  if (ordem === 'nome') {
    return [...xs].sort((a, b) => (a.nome === null ? (b.nome === null ? 0 : 1) : b.nome === null ? -1
      : a.nome.localeCompare(b.nome, 'pt-BR')) || porCompras(a, b));
  }
  const campo = CAMPO_ORDEM[ordem as keyof typeof CAMPO_ORDEM] ?? 'compras12m';
  return [...xs].sort((a, b) => desc(a[campo] as number | null, b[campo] as number | null) || porCompras(a, b));
}

const semAcento = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Busca por nome ou código Omie, sem caixa nem acento. */
export function filtrarFornecedores(xs: ResumoFornecedor[], busca: string): ResumoFornecedor[] {
  const q = semAcento(busca.trim());
  if (q === '') return xs;
  return xs.filter((x) => semAcento(x.nome ?? '').includes(q) || String(x.fornecedor).includes(q));
}
