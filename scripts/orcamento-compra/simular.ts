// scripts/orcamento-compra/simular.ts
// Backtest do orçamento de compra (spec docs/superpowers/specs/2026-10-15-orcamento-compra-design.md).
// Uso: bun scripts/orcamento-compra/simular.ts --banco <dir-saida>
//      bun scripts/orcamento-compra/simular.ts <fatos.json> <dir-saida>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { addDias, diffDias, ehDiaUtil, type DataISO } from '@/lib/reposicao/orcamento-compra/datas';
import { dataPagamentoPrevista, passoDaLinha, quebrarEmEmbalagens, type LinhaMotor } from '@/lib/reposicao/orcamento-compra/embalagens';
import { amostrasEmpiricas, amostrasGaussianas, historicoSuficiente, marcarCensura, reconstruirEstoque, type SerieDiaria } from '@/lib/reposicao/orcamento-compra/demanda';
import { quantidadeProtegida, valorDasEmbalagens, type ParamsValor } from '@/lib/reposicao/orcamento-compra/valor';
import { fluxosDeSemanaAgregada, type EstadoCaixa, type Fluxo } from '@/lib/reposicao/orcamento-compra/caixa';
import { conciliarCompromissos, projetarRitmo, provisaoContinuidade, ritmoPorDiaDoMes } from '@/lib/reposicao/orcamento-compra/camadas';
import { cortar, type BaseCaixa, type Candidata, type ResultadoCorte } from '@/lib/reposicao/orcamento-compra/corte';
import { classificarCorte, replaySku, type ClasseCorte } from '@/lib/reposicao/orcamento-compra/replay';
import { deduplicarEpisodios, deltaDio, precisaoDoCorte, type Episodio } from '@/lib/reposicao/orcamento-compra/medicao';

export interface Config {
  reservaDias: number; fretePerc: number; minimoPedido: number; minOcorrencias: number;
  intervaloOportunidadeDias: number; horizonteDias: number; horizontePromoDias: number;
}
export const CONFIG_PADRAO: Config = {
  reservaDias: 30, fretePerc: 0.025, minimoPedido: 0, minOcorrencias: 3,
  intervaloOportunidadeDias: 1, horizonteDias: 91, horizontePromoDias: 90,
};

/** R28/R30: idade (dias, pedido→data do ciclo) a partir da qual pedido sem NF (ou com NF sem título) deixa de ser "a faturar" — p90 medido de pedido→faturamento. */
export const IDADE_A_FATURAR_DIAS = 15;

/** Horizonte FIXO do replay do ΔDIO/caixa liberado (R25). */
const HORIZONTE_DIO_DIAS = 30;

/** O que o backtest assume e NÃO reconstrói as-of — vai no resultado.json (R22). */
export const PREMISSAS: string[] = [
  'preco_venda_medio é o atual (v_sku_parametros_sugeridos), não o vigente na data do ciclo',
  'lags p10 (pedido→faturamento, emissão→vencimento) e p50 (pedido→chegada) calculados sobre 180 dias até hoje',
  'cm_anual (custo de capital) é o atual de empresa_configuracao_custos',
  'reserva = saída média diária: pagos não-Sayerlack por data de baixa + títulos Sayerlack por data de EMISSÃO (criados até o momento do ciclo)',
  'recebimentos = quantidade PEDIDA (produtos_consulta.nQtde) na data t4 do tracking; pedido sem t4 não entra (o erro de fechamento pega o buraco)',
  'saídas atrasadas do snapshot (data < dia do ciclo) entram no dia 0; se já estavam pagas, contam em dobro (viés conservador)',
  'pedido disparado sem NF, ou com NF sem título no CP até o snapshot, com menos de 15 dias (p90 pedido→faturamento) entra inteiro como compromisso a faturar e não torna o ciclo indeterminado; com 15 dias ou mais, é não conciliado (a lista de NFs do pedido é a de hoje, não a do ciclo)',
  'pedidos disparados há mais de 60 dias ficam fora dos compromissos (assume-se já pagos ou no CP)',
  'obsolescência = 0 no custo de carregamento',
  'corte guloso com score ajustado não-crescente por SKU: heurística não-ótima (score marginal, não preço-sombra)',
  'demanda média/desvio do ciclo derivados da série as-of [data−180, data−1] (dias não censurados); params.demanda_media_diaria só no CMV diário do resumo',
];

type Num = number | null;
type Saida = { data: DataISO; valor: number; id_origem?: string; origem?: string };
export interface Fatos {
  meta: { gerado_em: string; hoje: DataISO };
  ciclos: { id: number; status: string; data_ciclo: DataISO; horario_geracao: string; horario_disparo_real: string | null; valor_total: Num; omie_pedido_compra_id: string | null }[];
  linhas: { raiz: number; pedido_id: number; sku_codigo_omie: string; qtde: Num; fator_embalagem_portal: Num; preco_unitario: Num; estoque_atual: Num; estoque_fisico: Num; ponto_pedido: Num; modo_promocao: string | null; preco_sem_desconto: Num }[];
  demanda: { sku: string; data: DataISO; qtde: Num }[];
  recebimentos: { sku: string; data: DataISO; qtde: Num }[];
  estoque: { sku: string; estoque_fisico: Num }[];
  params: { sku: string; preco_venda_medio: Num; demanda_media_diaria: Num; demanda_sigma_diario: Num }[];
  snapshots: { dia: DataISO; snapshot_at: string; saldo_tesouraria: Num; dados: { inicio: DataISO; fim: DataISO; total_entradas?: number; saidas?: Saida[]; entradas?: { data?: DataISO; valor: number }[] }[] }[];
  disparados: { id: number; valor_total: Num; momento: string; nfs: string[] }[];
  titulos_sayerlack: { id: string; nf: string | null; valor: Num; data_emissao: DataISO; created_at: string }[];
  pagos_nao_sayerlack: { data: DataISO; valor: Num }[];
  lags: { faturamento_p10: Num; vencimento_p10: Num; chegada_p50: Num };
  cm_anual: Num;
}

export interface DetalheCorte {
  sku: string; k: number; qtde: number;
  /** desembolso da embalagem; null = sem preço (fora do valor cortado, conta em cortesSemPreco) */
  valor: number | null;
  motivo: string;
  /** null = sem score ou ciclo não disparado (R26: replay só nos disparados) */
  classe: ClasseCorte | null;
  /** estoque médio (un) no replay até hoje com/sem a embalagem; null se não classificado */
  estoqueMedioCom: number | null; estoqueMedioSem: number | null;
  precoUnit: number | null;
  fechamentoOk: boolean;
}

export interface ResultadoCiclo {
  cicloId: number; data: DataISO; status: string;
  /** Σ desembolso das embalagens COM preço; as sem preço contam em embalagensSemDesembolso */
  valorMotor: number; valorAceito: number; aceitas: number; cortadas: number;
  embalagensSemDesembolso: number;
  protegidas: number;
  cortesPorMotivo: Record<string, number>;
  estado: EstadoCaixa; scoreMarginal: number | null; escassezCaixa: boolean;
  semScore: { sku: string; motivo: string }[];
  sensiveisAoModelo: number;
  /** erro = estoque reconstruído no fim de data−1 − estoque_fisico gravado na linha; null = não avaliável */
  fechamento: { sku: string; erro: number | null; ok: boolean }[];
  cortesDetalhe: DetalheCorte[];
}

const ts = (s: string) => Date.parse(s);

const FMT_SP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
/** Dia (YYYY-MM-DD) do instante em America/Sao_Paulo — nunca o recorte UTC de um timestamptz (R31). */
export function dataLocalSP(instante: string): DataISO {
  const t = ts(instante);
  if (!Number.isFinite(t)) throw new Error(`instante inválido: ${instante}`);
  const partes = Object.fromEntries(FMT_SP.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${partes.year}-${partes.month}-${partes.day}`;
}

function exigir(v: Num, nome: string): number {
  if (v == null || !Number.isFinite(Number(v))) throw new Error(`${nome} ausente — rode o preVoo`);
  return Number(v);
}

/** Ausente ≠ zero: null/não-finito continua null; preço ≤ 0 também é ausente. */
const numOuNull = (v: Num): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const precoOuNull = (v: Num): number | null => {
  const n = numOuNull(v);
  return n != null && n > 0 ? n : null;
};

export function extrairJson(raw: string): unknown {
  if (/^ERROR:|^psql:.*ERROR/m.test(raw)) throw new Error('psql devolveu ERROR: ' + raw.slice(0, 500));
  if (!/^fim\|ok$/m.test(raw)) throw new Error('sem marcador fim|ok na saída do psql');
  const linha = raw.split('\n').find((l) => l.startsWith('json|'));
  if (!linha) throw new Error('sem linha json| na saída do psql');
  return JSON.parse(linha.slice(5));
}

export function preVoo(f: Fatos): string[] {
  const falhas: string[] = [];
  if (!f.ciclos.length) falhas.push('ciclos vazio — consulta suspeita');
  if (!f.linhas.length) falhas.push('linhas vazio — consulta suspeita');
  if (!f.params.length) falhas.push('params vazio — conferir case de empresa');
  if (!f.snapshots.length) falhas.push('snapshots vazio — sem base de caixa');
  if (f.lags.faturamento_p10 == null || f.lags.vencimento_p10 == null || f.lags.chegada_p50 == null) falhas.push('lags ausentes — sem datação de pagamento/chegada');
  if (f.cm_anual == null) falhas.push('cm_anual ausente — sem custo de capital');
  if (f.demanda.some((d) => d.qtde == null)) falhas.push('demanda com qtde nula — série inválida');
  if (f.recebimentos.some((r) => r.qtde == null)) falhas.push('recebimentos com qtde nula — reconstrução de estoque inválida');
  if (f.disparados.some((p) => p.valor_total == null)) falhas.push('disparados com valor_total nulo — compromissos inválidos');
  if (f.titulos_sayerlack.some((t) => t.valor == null)) falhas.push('titulos_sayerlack com valor nulo — conciliação inválida');
  if (f.pagos_nao_sayerlack.some((p) => p.valor == null)) falhas.push('pagos_nao_sayerlack com valor nulo — ritmo inválido');
  return falhas;
}

/**
 * Série diária de demanda do SKU entre [de, ate], com censura pelos dias de estoque reconstruído ≤ 0.
 * A reconstrução ancora no estoque de HOJE: monta [de, hoje], reconstrói para trás e só então recorta até `ate`.
 * Estoque de hoje ausente → série toda censurada e estoque NaN (nunca 0 fabricado).
 */
function serieDoSku(f: Fatos, sku: string, de: DataISO, ate: DataISO): { serie: SerieDiaria; estoqueFim: number[] } {
  const hoje = f.meta.hoje;
  const nTotal = diffDias(de, hoje) + 1;
  const n = diffDias(de, ate) + 1;
  if (nTotal < 1 || n < 1 || n > nTotal) throw new Error(`janela inválida ${de}..${ate} (hoje ${hoje})`);
  const atual = numOuNull(f.estoque.find((e) => e.sku === sku)?.estoque_fisico ?? null);
  if (atual == null) return { serie: new Array(n).fill(null), estoqueFim: new Array(n).fill(Number.NaN) };
  const dem = new Array<number>(nTotal).fill(0);
  const rec = new Array<number>(nTotal).fill(0);
  for (const d of f.demanda) if (d.sku === sku && d.data >= de && d.data <= hoje) dem[diffDias(de, d.data)] += exigir(d.qtde, 'demanda.qtde');
  for (const r of f.recebimentos) if (r.sku === sku && r.data >= de && r.data <= hoje) rec[diffDias(de, r.data)] += exigir(r.qtde, 'recebimentos.qtde');
  const estoqueFim = reconstruirEstoque(atual, dem, rec);
  return { serie: marcarCensura(dem, estoqueFim).slice(0, n), estoqueFim: estoqueFim.slice(0, n) };
}

/** Média e desvio-padrão amostral dos dias NÃO censurados da série as-of (R22). */
function momentosDaSerie(serie: SerieDiaria): { media: number | null; sigma: number | null } {
  const xs = serie.filter((v): v is number => v !== null);
  if (xs.length === 0) return { media: null, sigma: null };
  const media = xs.reduce((s, x) => s + x, 0) / xs.length;
  if (xs.length < 2) return { media, sigma: null };
  const sigma = Math.sqrt(xs.reduce((s, x) => s + (x - media) ** 2, 0) / (xs.length - 1));
  return { media, sigma };
}

function baseDeCaixa(f: Fatos, data: DataISO, momento: string, cfg: Config, reserva: number, lagPagamento: number): BaseCaixa {
  const ausencias: string[] = [];
  // as-of: só vale snapshot tirado ATÉ o momento do ciclo (o de 07h do próprio dia não vale para ciclo das 05h)
  const snap = f.snapshots
    .filter((s) => s.dia <= data && ts(s.snapshot_at) <= ts(momento))
    .sort((a, b) => ts(b.snapshot_at) - ts(a.snapshot_at))[0];
  if (!snap || diffDias(snap.dia, data) > 1 || snap.saldo_tesouraria == null) {
    ausencias.push('snapshot');
    return { saldoInicial: 0, inicio: data, dias: cfg.horizonteDias, fluxos: [], ausencias };
  }
  const fluxos: Fluxo[] = [];
  const fimJanela = addDias(data, cfg.horizonteDias);
  // R8 + R23: só títulos do CP (origem cp_omie) com vencimento DENTRO de [inicio, inicio+dias) descontam
  // o ritmo do mês — o ritmo é medido no CP; eventos recorrentes/eventuais não estão nele.
  const tituladoNaoSayPorMes: Record<string, number> = {};
  for (const sem of snap.dados) {
    // saídas passadas (atrasadas) ficam: caem no dia 0 (pior caso — ver PREMISSAS)
    for (const s of sem.saidas ?? []) {
      fluxos.push({ data: s.data, valor: -s.valor, camada: 'base_titulos' });
      if (s.origem === 'cp_omie' && s.data >= data && s.data < fimJanela) {
        const mes = s.data.slice(0, 7);
        tituladoNaoSayPorMes[mes] = (tituladoNaoSayPorMes[mes] ?? 0) + s.valor;
      }
    }
    // R20: entrada com data anterior ao ciclo NÃO entra (seria caixa que já devia estar no saldo — aprova a mais)
    const entradas = sem.entradas ?? [];
    const candidatas: Fluxo[] = entradas.every((e) => e.data)
      ? entradas.map((e) => ({ data: e.data as DataISO, valor: e.valor, camada: 'base_titulos' as const }))
      : fluxosDeSemanaAgregada(sem.inicio, sem.fim, sem.total_entradas ?? 0, 0).filter((x) => x.valor !== 0);
    fluxos.push(...candidatas.filter((x) => x.data >= data));
  }
  const anteriores = f.disparados.filter((p) => ts(p.momento) < ts(momento) && dataLocalSP(p.momento) >= addDias(data, -60));
  const titulosAteSnap = f.titulos_sayerlack.filter((t) => ts(t.created_at) <= ts(snap.snapshot_at) && t.nf);
  const conc = conciliarCompromissos(
    anteriores.map((p) => ({ pedidoId: p.id, valorTotal: exigir(p.valor_total, 'disparados.valor_total'), dataPedido: dataLocalSP(p.momento), nfs: p.nfs ?? [] })),
    titulosAteSnap.map((t) => ({ nf: t.nf as string, valor: exigir(t.valor, 'titulos_sayerlack.valor') })),
    data, lagPagamento, IDADE_A_FATURAR_DIAS,
  );
  fluxos.push(...conc.fluxos);
  if (conc.naoConciliado > 0.1 * reserva) ausencias.push('compromisso_nao_conciliado');
  const pagos = f.pagos_nao_sayerlack
    .filter((p) => p.data < data && p.data >= addDias(data, -180))
    .map((p) => ({ data: p.data, valor: exigir(p.valor, 'pagos_nao_sayerlack.valor') }));
  // sem histórico de pagamento a camada não existe — nunca "ritmo 0" calado
  if (pagos.length === 0) ausencias.push('ritmo_sem_historico');
  else fluxos.push(...projetarRitmo(data, cfg.horizonteDias, ritmoPorDiaDoMes(pagos, 6), tituladoNaoSayPorMes));
  return { saldoInicial: Number(snap.saldo_tesouraria), inicio: data, dias: cfg.horizonteDias, fluxos, ausencias };
}

function mediaCompraPorDiaUtil(f: Fatos, data: DataISO): number {
  const de = addDias(data, -90);
  const total = f.disparados
    .filter((p) => dataLocalSP(p.momento) >= de && dataLocalSP(p.momento) < data)
    .reduce((s, p) => s + exigir(p.valor_total, 'disparados.valor_total'), 0);
  let uteis = 0;
  for (let i = 0; i < 90; i++) if (ehDiaUtil(addDias(de, i))) uteis++;
  return uteis ? total / uteis : 0;
}

/** Reserva = (pagos não-Sayerlack por baixa + títulos Sayerlack por EMISSÃO) / 180 × dias; janela [data−180, data). */
export function reservaDe(f: Fatos, data: DataISO, momento: string, dias: number): number {
  const de = addDias(data, -180);
  const pagos = f.pagos_nao_sayerlack.filter((p) => p.data < data && p.data >= de);
  const say = f.titulos_sayerlack.filter((t) => t.data_emissao < data && t.data_emissao >= de && ts(t.created_at) <= ts(momento));
  const total = pagos.reduce((s, p) => s + exigir(p.valor, 'pagos_nao_sayerlack.valor'), 0)
    + say.reduce((s, t) => s + exigir(t.valor, 'titulos_sayerlack.valor'), 0);
  return (total / 180) * dias;
}

export function simularCiclo(f: Fatos, cicloId: number, cfg: Config): ResultadoCiclo {
  const ciclo = f.ciclos.find((c) => c.id === cicloId);
  if (!ciclo) throw new Error(`ciclo ${cicloId} não está nos fatos`);
  const data = ciclo.data_ciclo;
  const momento = ciclo.horario_disparo_real ?? ciclo.horario_geracao;
  const reserva = reservaDe(f, data, momento, cfg.reservaDias);
  const lags = { faturamentoP10: exigir(f.lags.faturamento_p10, 'lags.faturamento_p10'), vencimentoP10: exigir(f.lags.vencimento_p10, 'lags.vencimento_p10') };
  const L = exigir(f.lags.chegada_p50, 'lags.chegada_p50');
  const T = L + cfg.intervaloOportunidadeDias;
  const dataPagamento = dataPagamentoPrevista(data, lags);
  const hDia = exigir(f.cm_anual, 'cm_anual') / 365;
  const cands: Candidata[] = [];
  const semScore: { sku: string; motivo: string }[] = [];
  const fechamento: ResultadoCiclo['fechamento'] = [];
  const fechaOk = new Map<string, boolean>();
  let sensiveis = 0;
  for (const l of f.linhas.filter((x) => x.raiz === cicloId)) {
    const p = f.params.find((x) => x.sku === l.sku_codigo_omie);
    const qtde = numOuNull(l.qtde);
    if (qtde == null) {
      // sem quantidade não há embalagem para quebrar — a linha aparece, não some calada
      semScore.push({ sku: l.sku_codigo_omie, motivo: 'qtde_ausente' });
      continue;
    }
    const estoqueEfetivo = numOuNull(l.estoque_atual);
    const precoUnitario = precoOuNull(l.preco_unitario);
    const linha: LinhaMotor = {
      pedidoId: l.pedido_id, pedidoRaizId: l.raiz, sku: l.sku_codigo_omie, qtdeFinal: qtde,
      fatorEmbalagem: numOuNull(l.fator_embalagem_portal), precoUnitario,
      precoVendaMedio: precoOuNull(p?.preco_venda_medio ?? null),
      // NaN (não 0) quando ausente: veneno que nunca vira número plausível; a linha sai sem score abaixo
      estoqueEfetivo: estoqueEfetivo ?? Number.NaN,
      pontoPedido: numOuNull(l.ponto_pedido) ?? Number.NaN,
      precoCheioPromocao: l.modo_promocao ? precoOuNull(l.preco_sem_desconto) : null,
    };
    const embs = quebrarEmEmbalagens(linha, { fretePerc: cfg.fretePerc, dataPagamento });
    const { serie, estoqueFim } = serieDoSku(f, linha.sku, addDias(data, -180), addDias(data, -1));

    // Erro de fechamento (spec §7): reconstrução no fim de data−1 × estoque_fisico gravado pelo motor.
    const gravado = numOuNull(l.estoque_fisico);
    const reconstruido = estoqueFim[estoqueFim.length - 1];
    const erro = gravado != null && Number.isFinite(reconstruido) ? reconstruido - gravado : null;
    const ok = erro != null && Math.abs(erro) <= Math.max(passoDaLinha(linha), 0.1 * Math.abs(gravado as number));
    fechamento.push({ sku: linha.sku, erro, ok });
    fechaOk.set(linha.sku, (fechaOk.get(linha.sku) ?? true) && ok);

    if (estoqueEfetivo == null) {
      for (const e of embs) {
        semScore.push({ sku: e.sku, motivo: 'estoque_ausente' });
        cands.push({ ...e, deltaV: null, protegida: false, motivoSemScore: 'estoque_ausente' });
      }
      continue;
    }
    // R22: demanda as-of — média/desvio da própria série [data−180, data−1], nunca o params atual
    const { media: d, sigma } = momentosDaSerie(serie);
    const suficiente = d != null && historicoSuficiente(serie, cfg.minOcorrencias);
    const amostras = suficiente ? amostrasEmpiricas(serie, L, T) : [];
    const margem = linha.precoVendaMedio != null && precoUnitario != null ? linha.precoVendaMedio - precoUnitario : null;
    const params: ParamsValor = {
      margemUnit: margem, custoUnit: precoUnitario, hDia, diasAteChegada: L, demandaMediaDiaria: d ?? 0,
      diasJanela: T - L, horizontePromoDias: cfg.horizontePromoDias,
      promoBeneficioUnit: linha.precoCheioPromocao != null && precoUnitario != null ? Math.max(linha.precoCheioPromocao - precoUnitario, 0) : 0,
    };
    const qtdes = embs.map((e) => e.qtde);
    const valores = valorDasEmbalagens(estoqueEfetivo, qtdes, amostras, params);
    const gauss = suficiente && d != null && sigma != null
      ? valorDasEmbalagens(estoqueEfetivo, qtdes, amostrasGaussianas(d, sigma, L, T, 400), params)
      : null;
    const protegerAte = suficiente && d != null ? quantidadeProtegida(estoqueEfetivo, d, L, T) : 0;
    let acumulado = 0;
    embs.forEach((e, i) => {
      const v = valores[i];
      const g = gauss?.[i].deltaV;
      if (v.deltaV != null && g != null && Math.sign(v.deltaV) !== Math.sign(g)) sensiveis++;
      if (v.motivoSemScore) semScore.push({ sku: e.sku, motivo: v.motivoSemScore });
      cands.push({ ...e, deltaV: v.deltaV, protegida: acumulado < protegerAte, motivoSemScore: v.motivoSemScore });
      acumulado += e.qtde;
    });
  }
  const lagPagamento = lags.faturamentoP10 + lags.vencimentoP10;
  const base = baseDeCaixa(f, data, momento, cfg, reserva, lagPagamento);
  base.fluxos.push(...provisaoContinuidade(data, cfg.horizonteDias, mediaCompraPorDiaUtil(f, data), lagPagamento, 0));
  const r: ResultadoCorte = cortar(cands, base, reserva, cfg.minimoPedido);
  const valorMotor = cands.reduce((s, c) => s + (c.desembolso ?? 0), 0);
  const valorAceito = r.aceitas.reduce((s, c) => s + (c.desembolso ?? 0), 0);
  const cortesPorMotivo: Record<string, number> = {};
  for (const x of r.cortadas) cortesPorMotivo[x.motivo] = (cortesPorMotivo[x.motivo] ?? 0) + (x.c.desembolso ?? 0);
  const disparado = ciclo.status === 'disparado';
  const cortesDetalhe: DetalheCorte[] = r.cortadas.map((x) => {
    const linha = f.linhas.find((l) => l.raiz === x.c.pedidoRaizId && l.sku_codigo_omie === x.c.sku);
    const precoUnit = precoOuNull(linha?.preco_unitario ?? null);
    const fechamentoOk = fechaOk.get(x.c.sku) ?? false;
    const base0 = { sku: x.c.sku, k: x.c.k, qtde: x.c.qtde, valor: x.c.desembolso, motivo: x.motivo, precoUnit, fechamentoOk };
    const nulo = { classe: null, estoqueMedioCom: null, estoqueMedioSem: null };
    // R26: ciclo não disparado — a compra não aconteceu; tirar a embalagem da realidade não é contrafactual
    if (!disparado || x.motivo === 'sem_score') return { ...base0, ...nulo };
    // fechamento ruim: a trajetória reconstruída não bate com o gravado → o replay não mede nada
    if (!fechamentoOk) return { ...base0, ...nulo, classe: 'indeterminado' as const };
    return { ...base0, ...classificarCorteDoSku(f, x.c.sku, x.c.qtde, data, L, numOuNull(linha?.ponto_pedido ?? null)) };
  });
  return {
    cicloId, data, status: ciclo.status, valorMotor, valorAceito,
    aceitas: r.aceitas.length, cortadas: r.cortadas.length,
    embalagensSemDesembolso: cands.filter((c) => c.desembolso == null).length,
    protegidas: cands.filter((c) => c.protegida).length,
    cortesPorMotivo,
    estado: r.estado, scoreMarginal: r.scoreMarginal, escassezCaixa: r.escassezCaixa,
    semScore, sensiveisAoModelo: sensiveis, fechamento, cortesDetalhe,
  };
}

/** Replay com e sem `qtde` removida na chegada (mediana L), de `data` até `ate`. */
function replayComSem(f: Fatos, sku: string, qtde: number, data: DataISO, ate: DataISO, L: number, pontoPedido: number | null) {
  const { serie, estoqueFim } = serieDoSku(f, sku, addDias(data, -1), ate);
  const estoqueInicial = estoqueFim[0];
  const demanda = serie.slice(1);
  const recebimentos = f.recebimentos
    .filter((r) => r.sku === sku && r.data >= data && r.data <= ate)
    .map((r) => ({ dia: diffDias(data, r.data), qtde: exigir(r.qtde, 'recebimentos.qtde') }));
  const diaChegada = Math.min(L, demanda.length - 1);
  const politica = pontoPedido != null ? { pontoPedido, leadTimeDias: L } : null;
  const com = replaySku({ estoqueInicial, demanda, recebimentos, removido: null, politica: null });
  const sem = replaySku({ estoqueInicial, demanda, recebimentos, removido: { dia: diaChegada, qtde }, politica });
  return { com, sem };
}

/** Classificação do corte: replay até HOJE. */
function classificarCorteDoSku(
  f: Fatos, sku: string, qtde: number, data: DataISO, L: number, pontoPedido: number | null,
): { classe: ClasseCorte; estoqueMedioCom: number | null; estoqueMedioSem: number | null } {
  const ate = f.meta.hoje;
  if (diffDias(data, ate) < L + 1) return { classe: 'indeterminado', estoqueMedioCom: null, estoqueMedioSem: null };
  const { com, sem } = replayComSem(f, sku, qtde, data, ate, L, pontoPedido);
  return { classe: classificarCorte(com, sem), estoqueMedioCom: com.estoqueMedio, estoqueMedioSem: sem.estoqueMedio };
}

/** Valor cortado com preço, somado por (ciclo, SKU) — a unidade que vira episódio. */
function cortesPorCicloSku(ciclos: ResultadoCiclo[]) {
  const m = new Map<string, { cicloId: number; sku: string; data: DataISO; valor: number }>();
  for (const c of ciclos) for (const x of c.cortesDetalhe) {
    if (x.valor == null) continue; // sem preço: fora do valor (conta em cortesSemPreco)
    const k = `${c.cicloId}|${x.sku}`;
    const atual = m.get(k) ?? { cicloId: c.cicloId, sku: x.sku, data: c.data, valor: 0 };
    atual.valor += x.valor;
    m.set(k, atual);
  }
  return [...m.values()];
}

/**
 * R31: precisão por EPISÓDIO (dedup 7d dos cortes com preço dos ciclos efetivos). Classe do episódio:
 * teria_rompido se QUALQUER corte dele romperia; senão a classe do 1º corte (data, ciclo, k). Corte sem
 * classe (sem score) conta como indeterminado. Precisão ponderada pelo valor do episódio; cobertura =
 * classificados / episódios (null sem episódio).
 */
export function precisaoPorEpisodio(efetivos: ResultadoCiclo[]) {
  const episodios = deduplicarEpisodios(cortesPorCicloSku(efetivos), 7);
  const itens = episodios.map((ep) => {
    const cortes = efetivos
      .filter((c) => c.data >= ep.inicio && c.data <= ep.fim)
      .sort((a, b) => a.data.localeCompare(b.data) || a.cicloId - b.cicloId)
      .flatMap((c) => c.cortesDetalhe.filter((x) => x.sku === ep.sku && x.valor != null).sort((a, b) => a.k - b.k));
    const classe: ClasseCorte = cortes.some((x) => x.classe === 'teria_rompido') ? 'teria_rompido' : (cortes[0]?.classe ?? 'indeterminado');
    return { classe, valor: ep.valor };
  });
  const p = precisaoDoCorte(itens);
  return { ...p, cobertura: episodios.length > 0 ? p.n / episodios.length : null };
}

/** Soma o valor cortado do SKU dentro do ciclo e só então deduplica entre ciclos (gap 7d, valor máximo). */
function valorDeduplicado(ciclos: ResultadoCiclo[]): number {
  return deduplicarEpisodios(cortesPorCicloSku(ciclos), 7).reduce((s, e) => s + e.valor, 0);
}

/** CMV diário do universo do motor: Σ_sku demanda_media_diaria × preço (linha mais recente com preço); null se nenhum. */
function cmvDiarioDoUniverso(f: Fatos): number | null {
  const precoPorSku = new Map<string, { raiz: number; preco: number }>();
  for (const l of f.linhas) {
    const preco = precoOuNull(l.preco_unitario);
    if (preco == null) continue;
    const atual = precoPorSku.get(l.sku_codigo_omie);
    if (!atual || l.raiz > atual.raiz) precoPorSku.set(l.sku_codigo_omie, { raiz: l.raiz, preco });
  }
  let total = 0;
  let algum = false;
  for (const [sku, { preco }] of precoPorSku) {
    const d = numOuNull(f.params.find((p) => p.sku === sku)?.demanda_media_diaria ?? null);
    if (d == null) continue;
    total += d * preco;
    algum = true;
  }
  return algum ? total : null;
}

/**
 * R25: ΔDIO/caixa liberado por EPISÓDIO dos cortes efetivos. Por episódio, o 1º corte (1º ciclo do
 * episódio; todas as embalagens com preço daquele SKU nele, removidas juntas); replay de 30 dias fixos.
 */
function dioPorEpisodio(f: Fatos, efetivos: ResultadoCiclo[], L: number) {
  const unidades = cortesPorCicloSku(efetivos);
  const episodios: Episodio[] = deduplicarEpisodios(unidades, 7);
  let custoCom = 0;
  let custoSem = 0;
  let n = 0;
  let semHorizonte = 0;
  let indeterminados = 0;
  for (const ep of episodios) {
    const primeiro = unidades
      .filter((u) => u.sku === ep.sku && u.data === ep.inicio)
      .sort((a, b) => a.cicloId - b.cicloId)[0];
    const ciclo = efetivos.find((c) => c.cicloId === primeiro.cicloId)!;
    const cortes = ciclo.cortesDetalhe.filter((x) => x.sku === ep.sku && x.valor != null);
    if (addDias(ep.inicio, HORIZONTE_DIO_DIAS) > f.meta.hoje) { semHorizonte++; continue; }
    const preco = cortes[0]?.precoUnit ?? null;
    if (preco == null || !cortes.every((x) => x.fechamentoOk)) { indeterminados++; continue; }
    const qtde = cortes.reduce((s, x) => s + x.qtde, 0);
    const linha = f.linhas.find((l) => l.raiz === ciclo.cicloId && l.sku_codigo_omie === ep.sku);
    const ate = addDias(ep.inicio, HORIZONTE_DIO_DIAS - 1);
    const { com, sem } = replayComSem(f, ep.sku, qtde, ep.inicio, ate, L, numOuNull(linha?.ponto_pedido ?? null));
    if (com.indeterminado || sem.indeterminado || com.estoqueMedio == null || sem.estoqueMedio == null) { indeterminados++; continue; }
    custoCom += com.estoqueMedio * preco;
    custoSem += sem.estoqueMedio * preco;
    n++;
  }
  return { custoCom, custoSem, n, semHorizonte, indeterminados };
}

export function backtest(f: Fatos, cfg: Config) {
  const ciclos = f.ciclos.map((c) => simularCiclo(f, c.id, cfg));
  const efetivos = ciclos.filter((c) => c.status === 'disparado');
  const naoEfetivos = ciclos.filter((c) => c.status !== 'disparado');
  const itensClasse = efetivos.flatMap((c) => c.cortesDetalhe
    .filter((x) => x.classe && x.valor != null)
    .map((x) => ({ classe: x.classe as ClasseCorte, valor: x.valor as number })));
  const episodios = deduplicarEpisodios(cortesPorCicloSku(efetivos), 7);
  const precEp = precisaoPorEpisodio(efetivos);

  const L = exigir(f.lags.chegada_p50, 'lags.chegada_p50');
  const dio = dioPorEpisodio(f, efetivos, L);
  const cmvDiarioBase = cmvDiarioDoUniverso(f);
  const caixaLiberado = dio.n > 0 ? dio.custoCom - dio.custoSem : null;

  const avaliados = new Set<string>();
  const ruins = new Set<string>();
  for (const c of ciclos) for (const fe of c.fechamento) {
    if (fe.erro == null) continue;
    avaliados.add(fe.sku);
    if (!fe.ok) ruins.add(fe.sku);
  }

  const sensibilidade = [15, 30, 45].map((dias) => {
    const r = f.ciclos.filter((c) => c.status === 'disparado').map((c) => simularCiclo(f, c.id, { ...cfg, reservaDias: dias }));
    return { reservaDias: dias, valorAceito: r.reduce((s, x) => s + x.valorAceito, 0), inviaveis: r.filter((x) => x.estado.tipo === 'inviavel').length };
  });
  return {
    config: cfg,
    gerado_em: f.meta.gerado_em,
    premissas: PREMISSAS,
    ciclos,
    resumo: {
      nCiclos: ciclos.length,
      nDisparados: efetivos.length,
      valorMotorDisparados: efetivos.reduce((s, c) => s + c.valorMotor, 0),
      valorAceitoDisparados: efetivos.reduce((s, c) => s + c.valorAceito, 0),
      valorCortadoEfetivo: valorDeduplicado(efetivos),
      valorCortadoExpirado: valorDeduplicado(naoEfetivos),
      cortesSemPreco: ciclos.reduce((s, c) => s + c.cortesDetalhe.filter((x) => x.valor == null).length, 0),
      estados: ciclos.reduce<Record<string, number>>((m, c) => ({ ...m, [c.estado.tipo]: (m[c.estado.tipo] ?? 0) + 1 }), {}),
      precisao: precisaoDoCorte(itensClasse),
      precisaoEpisodios: { precisao: precEp.precisao, valorCortado: precEp.valorCortado, n: precEp.n, indeterminados: precEp.indeterminados },
      coberturaEpisodios: precEp.cobertura,
      episodios: episodios.length,
      sensiveisAoModelo: ciclos.reduce((s, c) => s + c.sensiveisAoModelo, 0),
      /** rótulo: "CMV diário do universo do motor" */
      cmvDiarioBase,
      caixaLiberado,
      deltaDio: dio.n > 0 ? deltaDio(dio.custoCom, dio.custoSem, cmvDiarioBase) : null,
      episodiosDio: dio.n,
      episodiosSemHorizonte: dio.semHorizonte,
      episodiosDioIndeterminados: dio.indeterminados,
      skusAvaliados: avaliados.size,
      skusFechamentoRuim: ruins.size,
    },
    sensibilidade,
  };
}

function main(argv: string[]) {
  let fatos: Fatos;
  let saida: string;
  if (argv[0] === '--banco') {
    saida = argv[1];
    if (!saida) throw new Error('uso: --banco <dir-saida>');
    const psql = join(homedir(), '.config/afiacao/psql-ro');
    const r = spawnSync(psql, ['-v', 'ON_ERROR_STOP=1', '-At', '-f', 'docs/superpowers/orcamento-compra/fatos.sql'], { encoding: 'utf8', maxBuffer: 1 << 30 });
    if (r.status !== 0) throw new Error(`psql saiu ${r.status}: ${(r.stderr ?? '').slice(0, 500)}`);
    fatos = extrairJson(r.stdout + (r.stderr ?? '')) as Fatos;
    mkdirSync(saida, { recursive: true });
    writeFileSync(join(saida, 'fatos.json'), JSON.stringify(fatos));
  } else {
    if (!argv[0] || !argv[1]) throw new Error('uso: <fatos.json> <dir-saida>');
    fatos = JSON.parse(readFileSync(argv[0], 'utf8')) as Fatos;
    saida = argv[1];
  }
  const falhas = preVoo(fatos);
  if (falhas.length) {
    console.error('PRÉ-VOO REPROVADO:\n- ' + falhas.join('\n- '));
    process.exit(2);
  }
  const resultado = backtest(fatos, CONFIG_PADRAO);
  mkdirSync(saida, { recursive: true });
  writeFileSync(join(saida, 'resultado.json'), JSON.stringify(resultado, null, 2));
  console.log(JSON.stringify(resultado.resumo));
  console.log('fim|ok');
}

if (import.meta.main) main(process.argv.slice(2));
