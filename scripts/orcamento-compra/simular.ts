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
import { deduplicarEpisodios, deltaDio, precisaoDoCorte } from '@/lib/reposicao/orcamento-compra/medicao';

export interface Config {
  reservaDias: number; fretePerc: number; minimoPedido: number; minOcorrencias: number;
  intervaloOportunidadeDias: number; horizonteDias: number; horizontePromoDias: number;
}
export const CONFIG_PADRAO: Config = {
  reservaDias: 30, fretePerc: 0.025, minimoPedido: 0, minOcorrencias: 3,
  intervaloOportunidadeDias: 1, horizonteDias: 91, horizontePromoDias: 90,
};

type Num = number | null;
export interface Fatos {
  meta: { gerado_em: string; hoje: DataISO };
  ciclos: { id: number; status: string; data_ciclo: DataISO; horario_geracao: string; horario_disparo_real: string | null; valor_total: Num; omie_pedido_compra_id: string | null }[];
  linhas: { raiz: number; pedido_id: number; sku_codigo_omie: string; qtde: Num; fator_embalagem_portal: Num; preco_unitario: Num; estoque_atual: Num; estoque_fisico: Num; ponto_pedido: Num; modo_promocao: string | null; preco_sem_desconto: Num }[];
  demanda: { sku: string; data: DataISO; qtde: Num }[];
  recebimentos: { sku: string; data: DataISO; qtde: Num }[];
  estoque: { sku: string; estoque_fisico: Num }[];
  params: { sku: string; preco_venda_medio: Num; demanda_media_diaria: Num; demanda_sigma_diario: Num }[];
  snapshots: { dia: DataISO; snapshot_at: string; saldo_tesouraria: Num; dados: { inicio: DataISO; fim: DataISO; total_entradas?: number; saidas?: { data: DataISO; valor: number; id_origem?: string }[]; entradas?: { data?: DataISO; valor: number }[] }[] }[];
  disparados: { id: number; valor_total: Num; momento: string; nfs: string[] }[];
  titulos_sayerlack: { id: string; nf: string | null; valor: Num; created_at: string }[];
  pagos_nao_sayerlack: { data: DataISO; valor: Num }[];
  lags: { faturamento_p10: Num; vencimento_p10: Num; chegada_p50: Num };
  cm_anual: Num;
}

export interface DetalheCorte {
  sku: string; k: number; valor: number; motivo: string; classe: ClasseCorte | null;
  /** estoque médio (un) no replay com/sem a embalagem; null se não classificado */
  estoqueMedioCom: number | null; estoqueMedioSem: number | null;
  precoUnit: number | null;
}

export interface ResultadoCiclo {
  cicloId: number; data: DataISO; status: string;
  /** Σ desembolso das embalagens COM preço; as sem preço contam em embalagensSemDesembolso */
  valorMotor: number; valorAceito: number; aceitas: number; cortadas: number;
  embalagensSemDesembolso: number;
  cortesPorMotivo: Record<string, number>;
  estado: EstadoCaixa; scoreMarginal: number | null; escassezCaixa: boolean;
  semScore: { sku: string; motivo: string }[];
  sensiveisAoModelo: number;
  /** erro = estoque reconstruído no fim de data−1 − estoque_fisico gravado na linha; null = não avaliável */
  fechamento: { sku: string; erro: number | null; ok: boolean }[];
  cortesDetalhe: DetalheCorte[];
}

const ts = (s: string) => Date.parse(s);

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
  const idsSay = new Set(f.titulos_sayerlack.map((t) => t.id));
  const fimJanela = addDias(data, cfg.horizonteDias);
  // R8: só títulos não-Sayerlack com vencimento DENTRO de [inicio, inicio+dias) descontam o ritmo do mês
  const tituladoNaoSayPorMes: Record<string, number> = {};
  for (const sem of snap.dados) {
    for (const s of sem.saidas ?? []) {
      fluxos.push({ data: s.data, valor: -s.valor, camada: 'base_titulos' });
      const naoSay = !s.id_origem || !idsSay.has(s.id_origem);
      if (naoSay && s.data >= data && s.data < fimJanela) {
        const mes = s.data.slice(0, 7);
        tituladoNaoSayPorMes[mes] = (tituladoNaoSayPorMes[mes] ?? 0) + s.valor;
      }
    }
    const entradas = sem.entradas ?? [];
    if (entradas.every((e) => e.data)) for (const e of entradas) fluxos.push({ data: e.data as DataISO, valor: e.valor, camada: 'base_titulos' });
    else fluxos.push(...fluxosDeSemanaAgregada(sem.inicio, sem.fim, sem.total_entradas ?? 0, 0).filter((x) => x.valor !== 0));
  }
  const anteriores = f.disparados.filter((p) => ts(p.momento) < ts(momento) && p.momento.slice(0, 10) >= addDias(data, -60));
  const titulosAteSnap = f.titulos_sayerlack.filter((t) => ts(t.created_at) <= ts(snap.snapshot_at) && t.nf);
  const conc = conciliarCompromissos(
    anteriores.map((p) => ({ pedidoId: p.id, valorTotal: exigir(p.valor_total, 'disparados.valor_total'), dataPedido: p.momento.slice(0, 10), nfs: p.nfs ?? [] })),
    titulosAteSnap.map((t) => ({ nf: t.nf as string, valor: exigir(t.valor, 'titulos_sayerlack.valor') })),
    data, lagPagamento,
  );
  fluxos.push(...conc.fluxos);
  if (conc.naoConciliado > 0.1 * reserva) ausencias.push('compromisso_nao_conciliado');
  const pagos = f.pagos_nao_sayerlack
    .filter((p) => p.data < data && p.data >= addDias(data, -180))
    .map((p) => ({ data: p.data, valor: exigir(p.valor, 'pagos_nao_sayerlack.valor') }));
  fluxos.push(...projetarRitmo(data, cfg.horizonteDias, ritmoPorDiaDoMes(pagos, 6), tituladoNaoSayPorMes));
  return { saldoInicial: Number(snap.saldo_tesouraria), inicio: data, dias: cfg.horizonteDias, fluxos, ausencias };
}

function mediaCompraPorDiaUtil(f: Fatos, data: DataISO): number {
  const de = addDias(data, -90);
  const total = f.disparados
    .filter((p) => p.momento.slice(0, 10) >= de && p.momento.slice(0, 10) < data)
    .reduce((s, p) => s + exigir(p.valor_total, 'disparados.valor_total'), 0);
  let uteis = 0;
  for (let i = 0; i < 90; i++) if (ehDiaUtil(addDias(de, i))) uteis++;
  return uteis ? total / uteis : 0;
}

export function reservaDe(f: Fatos, data: DataISO, dias: number): number {
  const pagos = f.pagos_nao_sayerlack.filter((p) => p.data < data && p.data >= addDias(data, -180));
  const say = f.titulos_sayerlack.filter((t) => t.created_at.slice(0, 10) < data && t.created_at.slice(0, 10) >= addDias(data, -180));
  const total = pagos.reduce((s, p) => s + exigir(p.valor, 'pagos_nao_sayerlack.valor'), 0)
    + say.reduce((s, t) => s + exigir(t.valor, 'titulos_sayerlack.valor'), 0);
  return (total / 180) * dias;
}

export function simularCiclo(f: Fatos, cicloId: number, cfg: Config): ResultadoCiclo {
  const ciclo = f.ciclos.find((c) => c.id === cicloId);
  if (!ciclo) throw new Error(`ciclo ${cicloId} não está nos fatos`);
  const data = ciclo.data_ciclo;
  const reserva = reservaDe(f, data, cfg.reservaDias);
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
    const estoqueEfetivo = numOuNull(l.estoque_atual);
    const precoUnitario = precoOuNull(l.preco_unitario);
    const linha: LinhaMotor = {
      pedidoId: l.pedido_id, pedidoRaizId: l.raiz, sku: l.sku_codigo_omie, qtdeFinal: numOuNull(l.qtde) ?? 0,
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
    const d = numOuNull(p?.demanda_media_diaria ?? null);
    // demanda média ausente = histórico insuficiente: sem amostras e sem proteção (nunca d = 0)
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
    const sigma = numOuNull(p?.demanda_sigma_diario ?? null);
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
  const momento = ciclo.horario_disparo_real ?? ciclo.horario_geracao;
  const lagPagamento = lags.faturamentoP10 + lags.vencimentoP10;
  const base = baseDeCaixa(f, data, momento, cfg, reserva, lagPagamento);
  base.fluxos.push(...provisaoContinuidade(data, cfg.horizonteDias, mediaCompraPorDiaUtil(f, data), lagPagamento, 0));
  const r: ResultadoCorte = cortar(cands, base, reserva, cfg.minimoPedido);
  const valorMotor = cands.reduce((s, c) => s + (c.desembolso ?? 0), 0);
  const valorAceito = r.aceitas.reduce((s, c) => s + (c.desembolso ?? 0), 0);
  const cortesPorMotivo: Record<string, number> = {};
  for (const x of r.cortadas) cortesPorMotivo[x.motivo] = (cortesPorMotivo[x.motivo] ?? 0) + (x.c.desembolso ?? 0);
  const cortesDetalhe: DetalheCorte[] = r.cortadas.map((x) => {
    const linha = f.linhas.find((l) => l.raiz === x.c.pedidoRaizId && l.sku_codigo_omie === x.c.sku);
    const precoUnit = precoOuNull(linha?.preco_unitario ?? null);
    const base0 = { sku: x.c.sku, k: x.c.k, valor: x.c.desembolso ?? 0, motivo: x.motivo, precoUnit };
    if (x.motivo === 'sem_score') return { ...base0, classe: null, estoqueMedioCom: null, estoqueMedioSem: null };
    // fechamento ruim: a trajetória reconstruída não bate com o gravado → o replay não mede nada
    if (!fechaOk.get(x.c.sku)) return { ...base0, classe: 'indeterminado' as const, estoqueMedioCom: null, estoqueMedioSem: null };
    return { ...base0, ...classificarCorteDoSku(f, x.c, data, L, numOuNull(linha?.ponto_pedido ?? null)) };
  });
  return {
    cicloId, data, status: ciclo.status, valorMotor, valorAceito,
    aceitas: r.aceitas.length, cortadas: r.cortadas.length,
    embalagensSemDesembolso: cands.filter((c) => c.desembolso == null).length,
    cortesPorMotivo,
    estado: r.estado, scoreMarginal: r.scoreMarginal, escassezCaixa: r.escassezCaixa,
    semScore, sensiveisAoModelo: sensiveis, fechamento, cortesDetalhe,
  };
}

/** Replay do SKU a partir do ciclo, com e sem a embalagem (a chegada real é aproximada pela mediana L). */
function classificarCorteDoSku(
  f: Fatos, c: Candidata, data: DataISO, L: number, pontoPedido: number | null,
): { classe: ClasseCorte; estoqueMedioCom: number | null; estoqueMedioSem: number | null } {
  const ate = f.meta.hoje;
  if (diffDias(data, ate) < L + 1) return { classe: 'indeterminado', estoqueMedioCom: null, estoqueMedioSem: null };
  const { serie, estoqueFim } = serieDoSku(f, c.sku, addDias(data, -1), ate);
  const estoqueInicial = estoqueFim[0];
  const demanda = serie.slice(1);
  const recebimentos = f.recebimentos
    .filter((r) => r.sku === c.sku && r.data >= data && r.data <= ate)
    .map((r) => ({ dia: diffDias(data, r.data), qtde: exigir(r.qtde, 'recebimentos.qtde') }));
  const diaChegada = Math.min(L, demanda.length - 1);
  const politica = pontoPedido != null ? { pontoPedido, leadTimeDias: L } : null;
  const com = replaySku({ estoqueInicial, demanda, recebimentos, removido: null, politica: null });
  const sem = replaySku({ estoqueInicial, demanda, recebimentos, removido: { dia: diaChegada, qtde: c.qtde }, politica });
  return { classe: classificarCorte(com, sem), estoqueMedioCom: com.estoqueMedio, estoqueMedioSem: sem.estoqueMedio };
}

/** Soma o valor cortado do SKU dentro do ciclo e só então deduplica entre ciclos (gap 7d, valor máximo). */
function valorDeduplicado(ciclos: ResultadoCiclo[]): number {
  const porCicloSku = new Map<string, { sku: string; data: DataISO; valor: number }>();
  for (const c of ciclos) for (const x of c.cortesDetalhe) {
    const k = `${c.cicloId}|${x.sku}`;
    const atual = porCicloSku.get(k) ?? { sku: x.sku, data: c.data, valor: 0 };
    atual.valor += x.valor;
    porCicloSku.set(k, atual);
  }
  return deduplicarEpisodios([...porCicloSku.values()], 7).reduce((s, e) => s + e.valor, 0);
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

export function backtest(f: Fatos, cfg: Config) {
  const ciclos = f.ciclos.map((c) => simularCiclo(f, c.id, cfg));
  const efetivos = ciclos.filter((c) => c.status === 'disparado');
  const naoEfetivos = ciclos.filter((c) => c.status !== 'disparado');
  const itensClasse = efetivos.flatMap((c) => c.cortesDetalhe.filter((x) => x.classe).map((x) => ({ classe: x.classe as ClasseCorte, valor: x.valor })));
  const episodios = deduplicarEpisodios(
    efetivos.flatMap((c) => c.cortesDetalhe.map((x) => ({ sku: x.sku, data: c.data, valor: x.valor }))), 7,
  );

  // ΔDIO / caixa liberado: só cortes efetivos classificados (≠ indeterminado) com os dois estoques médios
  let custoCom = 0;
  let custoSem = 0;
  let nDio = 0;
  for (const c of efetivos) for (const x of c.cortesDetalhe) {
    if (x.classe == null || x.classe === 'indeterminado' || x.estoqueMedioCom == null || x.estoqueMedioSem == null || x.precoUnit == null) continue;
    custoCom += x.estoqueMedioCom * x.precoUnit;
    custoSem += x.estoqueMedioSem * x.precoUnit;
    nDio++;
  }
  const cmvDiarioBase = cmvDiarioDoUniverso(f);
  const caixaLiberado = nDio > 0 ? custoCom - custoSem : null;

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
    ciclos,
    resumo: {
      nCiclos: ciclos.length,
      nDisparados: efetivos.length,
      valorMotorDisparados: efetivos.reduce((s, c) => s + c.valorMotor, 0),
      valorAceitoDisparados: efetivos.reduce((s, c) => s + c.valorAceito, 0),
      valorCortadoEfetivo: valorDeduplicado(efetivos),
      valorCortadoExpirado: valorDeduplicado(naoEfetivos),
      estados: ciclos.reduce<Record<string, number>>((m, c) => ({ ...m, [c.estado.tipo]: (m[c.estado.tipo] ?? 0) + 1 }), {}),
      precisao: precisaoDoCorte(itensClasse),
      episodios: episodios.length,
      sensiveisAoModelo: ciclos.reduce((s, c) => s + c.sensiveisAoModelo, 0),
      /** rótulo: "CMV diário do universo do motor" */
      cmvDiarioBase,
      caixaLiberado,
      deltaDio: nDio > 0 ? deltaDio(custoCom, custoSem, cmvDiarioBase) : null,
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
