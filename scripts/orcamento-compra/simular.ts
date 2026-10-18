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
import { conciliarCompromissos, projetarRitmo, ritmoPorDiaDoMes } from '@/lib/reposicao/orcamento-compra/camadas';
import { cortar, type BaseCaixa, type Candidata, type ResultadoCorte } from '@/lib/reposicao/orcamento-compra/corte';
import { classificarCorte, replaySku, type ClasseCorte } from '@/lib/reposicao/orcamento-compra/replay';
import { vincularNfs, type NfVinculada, type ViaNf } from '@/lib/reposicao/orcamento-compra/vinculo-nf';
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

/** R59: idade máxima (h) da última publicação de encerrados em relação ao gerado_em dos fatos — o completo roda ~1×/dia. */
export const ENCERRADOS_IDADE_MAX_H = 48;

/** Horizonte FIXO do replay do ΔDIO/caixa liberado (R25). */
const HORIZONTE_DIO_DIAS = 30;

/** O que o backtest assume e NÃO reconstrói as-of — vai no resultado.json (R22). */
export const PREMISSAS: string[] = [
  'preco_venda_medio é o atual (v_sku_parametros_sugeridos), não o vigente na data do ciclo',
  'lags p10 (pedido→faturamento, emissão→vencimento) e p50 (pedido→chegada) as-of por ciclo: só observações concluídas antes do dia do ciclo, com pedido/emissão nos 180 dias anteriores; menos de 10 observações = ausência lags_insuficientes (R39)',
  'cm_anual (custo de capital) é o atual de empresa_configuracao_custos',
  'reserva = saída média diária: pagos não-Sayerlack por data de baixa + títulos Sayerlack por data de EMISSÃO (criados até o momento do ciclo)',
  'recebimentos = quantidade PEDIDA (produtos_consulta.nQtde) na data t4 do tracking; pedido sem t4 não entra (o erro de fechamento pega o buraco)',
  'replay do corte: Σ das embalagens cortadas do SKU no ciclo removidas juntas (R32) no t4 real do pedido; sem t4, na chegada mediana as-of, marcada aproximada (R33)',
  'saídas atrasadas do snapshot (data < dia do ciclo) entram no dia 0; se já estavam pagas, contam em dobro (viés conservador)',
  'pedido disparado sem NF, ou com NF sem título no CP até o snapshot, com menos de 15 dias (p90 pedido→faturamento) entra inteiro como compromisso a faturar e não torna o ciclo indeterminado; com 15 dias ou mais, é não conciliado (a lista de NFs do pedido é a de hoje, não a do ciclo)',
  'compromisso = pedido disparado nos 180 dias anteriores ao ciclo (qualquer idade, R38) × (1 + frete) (R41), menos só os títulos Sayerlack da NF que estão representados no snapshot (id_origem) ou liquidados antes do dia do snapshot (R35); título existente fora da trajetória não desconta',
  'títulos Sayerlack identificados pelo fornecedor (todos os ids do CP, sem janela de data) não abatem o ritmo não-Sayerlack (R34)',
  'semana do snapshot com total_saidas maior que o detalhe: a diferença sai no 1º dia da semana (R42)',
  'continuidade do motor = compra disparada × (1 + frete) por dia útil nos 90 dias anteriores (R54); se o 1º disparado é mais recente, média por dia útil desde ele; sem disparado anterior = ausência continuidade_sem_historico (R50); a compra aceita consome a provisão, mais cedo primeiro (R40)',
  'disparado ENCERRADO no Omie e sem evidência de NF (tracking, vínculo R57/R58 ou NF de qualquer identificador Sayerlack do pedido, em qualquer data) sai do compromisso (R59); só vale com a última passada de encerrados PUBLICADA há no máximo 48h (habilitada após os controles positivo/negativo). LOOK-AHEAD: o sinal é o de HOJE (encerrado_omie_em é quando a passada de encerrados do sync o viu, não a data real do encerramento, que o Omie não expõe) — o ciclo anterior ao encerramento já o trata como fora do caixa; com NF segue a conciliação normal; a continuidade do motor (R54) segue contando o encerrado (conservador)',
  'pai split_em_filhos com filho disparado conta como disparado (R45); momento as-of do ciclo = horario_geracao (R52)',
  'NF de disparado sem NF no tracking (R57/R58): por contrato só se TODO identificador Sayerlack do pedido (cContrato, protocolo do portal) tem NF — reenvio sem NF pode estar em aberto; por substituto só se o pedido não tem identificador Sayerlack, o manual tem itens idênticos em até 21 dias, NF por contrato e dono fora do motor, com unicidade; a NF só vale se faturada ANTES do dia do ciclo; conciliar continua exigindo título as-of',
  'obsolescência = 0 no custo de carregamento',
  'corte guloso com score ajustado não-crescente por SKU: heurística não-ótima (score marginal, não preço-sombra)',
  'intervalo de oportunidade de 1 dia (o motor roda todo dia): domina o corte econômico — a embalagem marginal só compra 1 dia de cobertura extra (R49)',
  'margem cheia sobre o backlog: unidade que cobre venda já feita sem estoque conta a margem inteira, sem desconto por cancelamento (R49)',
  'promoção tudo-ou-nada: a embalagem inteira ganha o desconto se o tempo médio de consumo (sem limite de janela) cabe no horizonte da promoção (R43/R49)',
  'demanda média/desvio do ciclo derivados da série as-of [data−180, data−1] (dias não censurados); params.demanda_media_diaria só no CMV diário do resumo',
];

type Num = number | null;
export interface ObsLag { t1: DataISO; fim: DataISO; dias: number }
type Saida = { data: DataISO; valor: number; id_origem?: string; origem?: string };
export interface Fatos {
  /** R59: registro da última passada de encerrados do Omie (OBEN, reposicao_encerrados_omie_publicacao); null = nunca rodou */
  meta: { gerado_em: string; hoje: DataISO; encerrados_publicacao?: { status: string; publicado_em: string | null } | null };
  ciclos: {
    id: number; status: string; data_ciclo: DataISO; horario_geracao: string; horario_disparo_real: string | null; valor_total: Num; omie_pedido_compra_id: string | null;
    /** R45: filhos de split (status de cada um); ausente/vazio = pedido não splitado */
    filhos?: { id: number; status: string }[] | null;
  }[];
  linhas: { raiz: number; pedido_id: number; sku_codigo_omie: string; qtde: Num; fator_embalagem_portal: Num; preco_unitario: Num; estoque_atual: Num; estoque_fisico: Num; ponto_pedido: Num; modo_promocao: string | null; preco_sem_desconto: Num }[];
  demanda: { sku: string; data: DataISO; qtde: Num }[];
  recebimentos: { sku: string; data: DataISO; qtde: Num }[];
  estoque: { sku: string; estoque_fisico: Num }[];
  params: { sku: string; preco_venda_medio: Num; demanda_media_diaria: Num; demanda_sigma_diario: Num }[];
  snapshots: { dia: DataISO; snapshot_at: string; saldo_tesouraria: Num; dados: { inicio: DataISO; fim: DataISO; total_entradas?: number; total_saidas?: number; saidas?: Saida[]; entradas?: { data?: DataISO; valor: number }[] }[] }[];
  /** omie_pedido = omie_pedido_compra_id; protocolo = portal_protocolo (R57); encerrado_omie = encerrado_omie_em do tracking não nulo HOJE (R59) */
  disparados: { id: number; valor_total: Num; momento: string; nfs: string[]; omie_pedido?: string | null; protocolo?: string | null; encerrado_omie?: boolean }[];
  /** R57/R58: pedidos Omie Sayerlack (tracking, codigo > 0) com contrato, origem no motor e itens */
  pedidos_omie_sayerlack?: { codigo: string; t1: DataISO; contrato: string | null; do_motor: boolean; itens: { prod: string; qtde: Num }[] }[];
  /** R57: pares (nNumPedCompra, NF, faturamento) de itensRecebimento do tracking Sayerlack, órfãs incluídas */
  nfs_do_contrato?: { contrato: string; nf: string; data: DataISO | null }[];
  /** data_baixa = data_baixa_final de v_titulo_baixas (null = sem baixa); valor_baixado idem (R35) */
  titulos_sayerlack: { id: string; nf: string | null; valor: Num; data_emissao: DataISO; created_at: string; data_baixa: DataISO | null; valor_baixado: Num }[];
  /** R34: TODOS os ids de título do fornecedor Sayerlack no CP, sem janela de data */
  ids_sayerlack: string[];
  /** R33: recebimento real (t4, data local SP) por pedido (pai, filho ou não splitado); null = sem t4 */
  chegadas: { pedido_id: number; t4: DataISO | null }[];
  pagos_nao_sayerlack: { data: DataISO; valor: Num }[];
  /** R39: observações de lag (t1 = pedido/emissão, fim = dia em que a observação ficou conhecida, dias = lag) */
  lag_obs: { faturamento: ObsLag[]; vencimento: ObsLag[]; chegada: ObsLag[] };
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
  /** R33: true = remoção na chegada mediana L (pedido sem t4); null = não classificado */
  chegadaAproximada: boolean | null;
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
  if (!f.lag_obs || !f.lag_obs.faturamento?.length || !f.lag_obs.vencimento?.length || !f.lag_obs.chegada?.length) falhas.push('lags ausentes — sem datação de pagamento/chegada');
  if (!Array.isArray(f.ids_sayerlack) || !Array.isArray(f.chegadas)) falhas.push('ids_sayerlack/chegadas ausentes — fatos.sql antigo');
  if (f.cm_anual == null) falhas.push('cm_anual ausente — sem custo de capital');
  if (!Array.isArray(f.pedidos_omie_sayerlack) || !Array.isArray(f.nfs_do_contrato)) falhas.push('pedidos_omie_sayerlack/nfs_do_contrato ausentes — fatos.sql antigo (R57/R58)');
  if (f.disparados.some((p) => typeof p.encerrado_omie !== 'boolean')) falhas.push('disparados sem encerrado_omie — fatos.sql antigo (R59)');
  else {
    // a coluna só vale como "o conjunto de agora" se a ÚLTIMA passada publicou e é recente — abstenção ou
    // falha depois de uma publicação deixaria marca velha valendo (Codex 2026-10-18 P1)
    const pub = f.meta.encerrados_publicacao;
    const idadeH = pub?.publicado_em ? (ts(f.meta.gerado_em) - ts(pub.publicado_em)) / 3_600_000 : Number.NaN;
    if (pub?.status !== 'publicado') falhas.push(`passada de encerrados do Omie não publicada (R59: ${pub?.status ?? 'nunca rodou'}) — sinal ausente não é "nenhum encerrado"`);
    else if (!(idadeH >= 0 && idadeH <= ENCERRADOS_IDADE_MAX_H)) falhas.push(`publicação de encerrados do Omie fora de ${ENCERRADOS_IDADE_MAX_H}h (R59) — conjunto velho não vale como o de hoje`);
  }
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

/** Mínimo de observações para um lag as-of (R39). */
export const MIN_OBS_LAG = 10;

/** percentile_disc(p): 1º valor cuja posição acumulada ≥ p. */
function percentilDisc(xs: number[], p: number): number {
  const o = [...xs].sort((a, b) => a - b);
  return o[Math.max(0, Math.ceil(p * o.length) - 1)];
}

/**
 * R39: lags as-of do ciclo — observações com t1 em [data−180, data) e concluídas ANTES do dia do ciclo.
 * Menos de MIN_OBS_LAG observações → null (nunca o p10 de hoje).
 */
export function lagsAsOf(f: Fatos, data: DataISO): { faturamentoP10: number | null; vencimentoP10: number | null; chegadaP50: number | null } {
  const de = addDias(data, -180);
  const calc = (obs: ObsLag[], p: number) => {
    const xs = obs.filter((o) => o.t1 >= de && o.t1 < data && o.fim < data).map((o) => Number(o.dias)).filter(Number.isFinite);
    return xs.length >= MIN_OBS_LAG ? percentilDisc(xs, p) : null;
  };
  return { faturamentoP10: calc(f.lag_obs.faturamento, 0.1), vencimentoP10: calc(f.lag_obs.vencimento, 0.1), chegadaP50: calc(f.lag_obs.chegada, 0.5) };
}

/** R45: pai splitado com filho disparado conta como disparado (a linhagem é pelos filhos). */
export function statusEfetivo(c: Fatos['ciclos'][number]): string {
  if (c.status === 'split_em_filhos' && (c.filhos ?? []).some((x) => x.status === 'disparado')) return 'disparado';
  return c.status;
}

const JANELA_SUBSTITUTO_DIAS = 21;
const memoVinculos = new WeakMap<Fatos, Map<number, { nfs: NfVinculada[]; via: ViaNf }>>();
/** R57/R58: vínculos NF↔disparado além do tracking, calculados uma vez por conjunto de fatos */
export function vinculosDe(f: Fatos): Map<number, { nfs: NfVinculada[]; via: ViaNf }> {
  const memo = memoVinculos.get(f);
  if (memo) return memo;
  const v = vincularNfs(
    f.disparados.map((d) => ({ id: d.id, omiePedido: d.omie_pedido ?? null, protocolo: d.protocolo ?? null, nfs: d.nfs ?? [] })),
    (f.pedidos_omie_sayerlack ?? []).map((p) => ({
      codigo: p.codigo, t1: p.t1, contrato: p.contrato, doMotor: p.do_motor,
      // ausente ≠ zero: qtde nula vira NaN e a assinatura de itens recusa o casamento
      itens: p.itens.map((i) => ({ prod: i.prod, qtde: i.qtde == null ? Number.NaN : Number(i.qtde) })),
    })),
    (f.nfs_do_contrato ?? []).flatMap((x) => (x.data ? [{ contrato: x.contrato, nf: x.nf, data: x.data }] : [])),
    { janelaSubstitutoDias: JANELA_SUBSTITUTO_DIAS },
  );
  memoVinculos.set(f, v);
  return v;
}

/**
 * R59: disparado encerrado no Omie (sinal de HOJE) e sem NENHUMA evidência de faturamento HOJE não é
 * compromisso de caixa. Evidência = NF no tracking, vínculo R57/R58 em qualquer data, OU qualquer NF de
 * qualquer identificador Sayerlack do pedido (cContrato do pedido Omie, protocolo do portal): o R57 recusa
 * vincular quando um reenvio não tem NF, mas a NF do outro identificador prova que houve faturamento
 * (Codex 2026-10-18 P1). Com evidência, segue a conciliação normal.
 */
export function foraDoCaixa(f: Fatos, p: Fatos['disparados'][number]): boolean {
  if (p.encerrado_omie !== true) return false;
  if ((p.nfs ?? []).length > 0 || (vinculosDe(f).get(p.id)?.nfs ?? []).length > 0) return false;
  const ids = new Set<string>();
  if (p.protocolo) ids.add(p.protocolo.trim());
  for (const o of f.pedidos_omie_sayerlack ?? []) if (p.omie_pedido != null && o.codigo === p.omie_pedido && o.contrato) ids.add(o.contrato.trim());
  return !(f.nfs_do_contrato ?? []).some((x) => ids.has(x.contrato.trim()));
}

function baseDeCaixa(f: Fatos, data: DataISO, momento: string, cfg: Config, reserva: number, lagPagamento: number, idsSay: Set<string>): BaseCaixa {
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
  // R8 + R23 + R34: só títulos do CP (origem cp_omie) NÃO-Sayerlack (pelo id do fornecedor) com vencimento
  // DENTRO de [inicio, inicio+dias) descontam o ritmo do mês — o ritmo é medido no CP não-Sayerlack.
  const tituladoNaoSayPorMes: Record<string, number> = {};
  const representados = new Set<string>();
  for (const sem of snap.dados) {
    // saídas passadas (atrasadas) ficam: caem no dia 0 (pior caso — ver PREMISSAS)
    let detalhado = 0;
    for (const s of sem.saidas ?? []) {
      fluxos.push({ data: s.data, valor: -s.valor, camada: 'base_titulos' });
      detalhado += s.valor;
      if (s.id_origem != null) representados.add(String(s.id_origem));
      if (s.origem === 'cp_omie' && !(s.id_origem != null && idsSay.has(String(s.id_origem))) && s.data >= data && s.data < fimJanela) {
        const mes = s.data.slice(0, 7);
        tituladoNaoSayPorMes[mes] = (tituladoNaoSayPorMes[mes] ?? 0) + s.valor;
      }
    }
    // R42: total_saidas sem (ou além do) detalhe → a diferença sai no 1º dia da semana, nunca 0
    const faltante = Number(sem.total_saidas ?? 0) - detalhado;
    if (faltante > 0.005) fluxos.push(...fluxosDeSemanaAgregada(sem.inicio, sem.fim, 0, faltante).filter((x) => x.valor !== 0));
    // R20: entrada com data anterior ao ciclo NÃO entra (seria caixa que já devia estar no saldo — aprova a mais)
    const entradas = sem.entradas ?? [];
    const candidatas: Fluxo[] = entradas.every((e) => e.data)
      ? entradas.map((e) => ({ data: e.data as DataISO, valor: e.valor, camada: 'base_titulos' as const }))
      : fluxosDeSemanaAgregada(sem.inicio, sem.fim, sem.total_entradas ?? 0, 0).filter((x) => x.valor !== 0);
    fluxos.push(...candidatas.filter((x) => x.data >= data));
  }
  // R38: sem corte por idade — todo disparado dos 180 dias anteriores ao ciclo (antes do momento) é compromisso
  // R59: menos o encerrado no Omie sem NF nenhuma (tracking ou vínculo R57/R58 de qualquer data) — nunca virou caixa
  const anteriores = f.disparados.filter((p) => ts(p.momento) < ts(momento) && dataLocalSP(p.momento) >= addDias(data, -180) && !foraDoCaixa(f, p));
  // R35: título só desconta o compromisso se está REPRESENTADO na base (id_origem nas saídas do snapshot) ou
  // já LIQUIDADO antes do dia do snapshot (então saiu do saldo). Existir no CP não comprova nenhum dos dois.
  const descontoDe = (t: Fatos['titulos_sayerlack'][number]): number => {
    const valor = exigir(t.valor, 'titulos_sayerlack.valor');
    if (representados.has(t.id)) return valor;
    const baixado = numOuNull(t.valor_baixado);
    if (t.data_baixa != null && t.data_baixa < snap.dia && baixado != null) return Math.min(valor, baixado);
    return 0;
  };
  const titulosAteSnap = f.titulos_sayerlack.filter((t) => ts(t.created_at) <= ts(snap.snapshot_at) && t.nf);
  const conc = conciliarCompromissos(
    anteriores.map((p) => ({
      pedidoId: p.id,
      // R41: o desembolso do pedido inclui o frete, como o das candidatas
      valorTotal: exigir(p.valor_total, 'disparados.valor_total') * (1 + cfg.fretePerc),
      // R57/R58: NF vinculada por contrato/substituto só vale se já existia antes do dia do ciclo (as-of)
      dataPedido: dataLocalSP(p.momento), nfs: [...(p.nfs ?? []), ...(vinculosDe(f).get(p.id)?.nfs ?? []).filter((v) => v.data < data).map((v) => v.nf)],
    })),
    // título sem desconto entra com 0: a NF fica "sem título" — a faturar se recente, senão não conciliada
    titulosAteSnap.map((t) => ({ nf: t.nf as string, valor: descontoDe(t) })),
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

/**
 * R50: compra disparada por dia útil em [data−90, data). Se o 1º disparado anterior ao ciclo é mais recente
 * que data−90 (janela incompleta), a média é sobre os dias úteis desde ele; sem disparado anterior → null
 * (ausência continuidade_sem_historico, nunca provisão 0 calada).
 */
/** R54: `fretePerc` obrigatório — a provisão é consumida pelo desembolso aceito, que leva frete. */
export function continuidadePorDiaUtil(f: Fatos, data: DataISO, fretePerc: number): number | null {
  const anteriores = f.disparados.map((p) => ({ dia: dataLocalSP(p.momento), p })).filter((x) => x.dia < data);
  if (anteriores.length === 0) return null;
  const primeiro = anteriores.reduce((m, x) => (x.dia < m ? x.dia : m), anteriores[0].dia);
  const de = primeiro > addDias(data, -90) ? primeiro : addDias(data, -90);
  const total = anteriores.filter((x) => x.dia >= de).reduce((s, x) => s + exigir(x.p.valor_total, 'disparados.valor_total'), 0);
  let uteis = 0;
  for (let d = de; d < data; d = addDias(d, 1)) if (ehDiaUtil(d)) uteis++;
  return uteis ? (total * (1 + fretePerc)) / uteis : null;
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
  // R52: as-of = a decisão do motor (geração), não o disparo humano
  const momento = ciclo.horario_geracao;
  const status = statusEfetivo(ciclo);
  const reserva = reservaDe(f, data, momento, cfg.reservaDias);
  const asOf = lagsAsOf(f, data);
  const lagsPagamentoOk = asOf.faturamentoP10 != null && asOf.vencimentoP10 != null;
  // sem lags de pagamento o caixa é indeterminado; a data usada (o próprio dia) é só registro, o mais cedo possível
  const lags = { faturamentoP10: asOf.faturamentoP10 ?? 0, vencimentoP10: asOf.vencimentoP10 ?? 0 };
  const L = asOf.chegadaP50;
  const T = L == null ? null : L + cfg.intervaloOportunidadeDias;
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

    if (estoqueEfetivo == null || L == null || T == null) {
      // R39: sem lag de chegada as-of não há janela de valor — sem score, nunca L inventado
      const motivo = estoqueEfetivo == null ? 'estoque_ausente' : 'lags_insuficientes';
      for (const e of embs) {
        semScore.push({ sku: e.sku, motivo });
        cands.push({ ...e, deltaV: null, protegida: false, motivoSemScore: motivo });
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
  const base = baseDeCaixa(f, data, momento, cfg, reserva, lagPagamento, new Set(f.ids_sayerlack.map(String)));
  if (!lagsPagamentoOk) base.ausencias.push('lags_insuficientes');
  const porDiaUtil = continuidadePorDiaUtil(f, data, cfg.fretePerc);
  // R40: a continuidade vai para o corte, que a substitui pela compra aceita (nunca cumulativa)
  if (porDiaUtil == null) base.ausencias.push('continuidade_sem_historico');
  else base.continuidade = { porDiaUtil, lagDias: lagPagamento };
  const r: ResultadoCorte = cortar(cands, base, reserva, cfg.minimoPedido);
  const valorMotor = cands.reduce((s, c) => s + (c.desembolso ?? 0), 0);
  const valorAceito = r.aceitas.reduce((s, c) => s + (c.desembolso ?? 0), 0);
  const cortesPorMotivo: Record<string, number> = {};
  for (const x of r.cortadas) cortesPorMotivo[x.motivo] = (cortesPorMotivo[x.motivo] ?? 0) + (x.c.desembolso ?? 0);
  const disparado = status === 'disparado';
  type Medida = Pick<DetalheCorte, 'classe' | 'estoqueMedioCom' | 'estoqueMedioSem' | 'chegadaAproximada'>;
  const nulo: Medida = { classe: null, estoqueMedioCom: null, estoqueMedioSem: null, chegadaAproximada: null };
  // R32: UM replay por (ciclo, SKU) removendo a soma de TODAS as embalagens cortadas do SKU — inclusive as
  // sem score (R48: conservador, elas também não seriam compradas). Medir uma a uma aprova conjunto inseguro.
  const medidaPorSku = new Map<string, Medida>();
  for (const sku of new Set(r.cortadas.map((x) => x.c.sku))) {
    const doSku = r.cortadas.filter((x) => x.c.sku === sku);
    // R26: ciclo não disparado — a compra não aconteceu; tirar a embalagem da realidade não é contrafactual
    if (!disparado || doSku.every((x) => x.motivo === 'sem_score')) { medidaPorSku.set(sku, nulo); continue; }
    // fechamento ruim: a trajetória reconstruída não bate com o gravado → o replay não mede nada
    if (!(fechaOk.get(sku) ?? false)) { medidaPorSku.set(sku, { ...nulo, classe: 'indeterminado' }); continue; }
    const linha = f.linhas.find((l) => l.raiz === cicloId && l.sku_codigo_omie === sku);
    const qtde = doSku.reduce((s, x) => s + x.c.qtde, 0);
    medidaPorSku.set(sku, classificarCorteDoSku(f, cicloId, sku, qtde, data, L, numOuNull(linha?.ponto_pedido ?? null)));
  }
  const cortesDetalhe: DetalheCorte[] = r.cortadas.map((x) => {
    const linha = f.linhas.find((l) => l.raiz === x.c.pedidoRaizId && l.sku_codigo_omie === x.c.sku);
    const base0 = {
      sku: x.c.sku, k: x.c.k, qtde: x.c.qtde, valor: x.c.desembolso, motivo: x.motivo,
      precoUnit: precoOuNull(linha?.preco_unitario ?? null), fechamentoOk: fechaOk.get(x.c.sku) ?? false,
    };
    // R48: sem score é revisão humana — sem classe própria (a quantidade dele já está no replay do SKU)
    return { ...base0, ...(x.motivo === 'sem_score' ? nulo : (medidaPorSku.get(x.c.sku) as Medida)) };
  });
  return {
    cicloId, data, status, valorMotor, valorAceito,
    aceitas: r.aceitas.length, cortadas: r.cortadas.length,
    embalagensSemDesembolso: cands.filter((c) => c.desembolso == null).length,
    protegidas: cands.filter((c) => c.protegida).length,
    cortesPorMotivo,
    estado: r.estado, scoreMarginal: r.scoreMarginal, escassezCaixa: r.escassezCaixa,
    semScore, sensiveisAoModelo: sensiveis, fechamento, cortesDetalhe,
  };
}

/**
 * R33: dia (relativo a `data`) em que a compra do SKU chegou de fato — t4 do pedido (pai/filho) que contém a
 * linha; sem t4 → a chegada mediana L as-of, marcada aproximada; sem nenhum dos dois → null.
 */
function chegadaDoSku(f: Fatos, cicloId: number, sku: string, data: DataISO, L: number | null): { dia: number | null; aproximada: boolean } {
  const pedidos = new Set(f.linhas.filter((l) => l.raiz === cicloId && l.sku_codigo_omie === sku).map((l) => l.pedido_id));
  const t4s = f.chegadas.filter((c) => pedidos.has(c.pedido_id) && c.t4 != null).map((c) => c.t4 as DataISO).sort();
  // mais de um pedido com o SKU: a remoção mais cedo é a conservadora
  if (t4s.length > 0) return { dia: diffDias(data, t4s[0]), aproximada: false };
  return { dia: L, aproximada: true };
}

/** Replay com e sem `qtde` removida no dia `diaChegada`, de `data` até `ate`. */
function replayComSem(f: Fatos, sku: string, qtde: number, data: DataISO, ate: DataISO, diaChegada: number, leadTime: number, pontoPedido: number | null) {
  const { serie, estoqueFim } = serieDoSku(f, sku, addDias(data, -1), ate);
  const estoqueInicial = estoqueFim[0];
  const demanda = serie.slice(1);
  const recebimentos = f.recebimentos
    .filter((r) => r.sku === sku && r.data >= data && r.data <= ate)
    .map((r) => ({ dia: diffDias(data, r.data), qtde: exigir(r.qtde, 'recebimentos.qtde') }));
  const politica = pontoPedido != null ? { pontoPedido, leadTimeDias: leadTime } : null;
  const com = replaySku({ estoqueInicial, demanda, recebimentos, removido: null, politica: null });
  const sem = replaySku({ estoqueInicial, demanda, recebimentos, removido: { dia: diaChegada, qtde }, politica });
  return { com, sem };
}

/** Classificação do corte (Σ qtde cortada do SKU no ciclo): replay até HOJE, remoção na chegada real (R33). */
function classificarCorteDoSku(
  f: Fatos, cicloId: number, sku: string, qtde: number, data: DataISO, L: number | null, pontoPedido: number | null,
): { classe: ClasseCorte; estoqueMedioCom: number | null; estoqueMedioSem: number | null; chegadaAproximada: boolean } {
  const ate = f.meta.hoje;
  const chegada = chegadaDoSku(f, cicloId, sku, data, L);
  const indet = { classe: 'indeterminado' as const, estoqueMedioCom: null, estoqueMedioSem: null, chegadaAproximada: chegada.aproximada };
  // sem chegada conhecida, ou chegada que ainda não aconteceu até hoje → a remoção não é mensurável
  if (chegada.dia == null || chegada.dia < 0 || diffDias(data, ate) < chegada.dia + 1) return indet;
  const { com, sem } = replayComSem(f, sku, qtde, data, ate, chegada.dia, L ?? chegada.dia, pontoPedido);
  return { classe: classificarCorte(com, sem), estoqueMedioCom: com.estoqueMedio, estoqueMedioSem: sem.estoqueMedio, chegadaAproximada: chegada.aproximada };
}

/** O corte é do orçamento (econômico/financeiro/mínimo, com preço) — sem score é revisão humana (R48). */
const corteMedido = (x: DetalheCorte) => x.valor != null && x.motivo !== 'sem_score';

/** Valor cortado com preço, somado por (ciclo, SKU) — a unidade que vira episódio. `filtro` escolhe os cortes. */
function cortesPorCicloSku(ciclos: ResultadoCiclo[], filtro: (x: DetalheCorte) => boolean = corteMedido) {
  const m = new Map<string, { cicloId: number; sku: string; data: DataISO; valor: number }>();
  for (const c of ciclos) for (const x of c.cortesDetalhe) {
    if (x.valor == null || !filtro(x)) continue; // sem preço: fora do valor (conta em cortesSemPreco)
    const k = `${c.cicloId}|${x.sku}`;
    const atual = m.get(k) ?? { cicloId: c.cicloId, sku: x.sku, data: c.data, valor: 0 };
    atual.valor += x.valor;
    m.set(k, atual);
  }
  return [...m.values()];
}

/**
 * R31 + R37 + R48: precisão por EPISÓDIO (dedup 7d dos cortes do orçamento com preço, ciclos efetivos; sem
 * score fica fora — revisão humana). Classe do episódio pelo PIOR caso: teria_rompido se qualquer corte
 * romperia; senão indeterminado se qualquer corte é indeterminado/sem classe; senão adiado se algum foi
 * adiado; senão eliminado. Precisão ponderada pelo valor do episódio; cobertura = classificados / episódios.
 */
export function precisaoPorEpisodio(efetivos: ResultadoCiclo[]) {
  const episodios = deduplicarEpisodios(cortesPorCicloSku(efetivos), 7);
  const itens = episodios.map((ep) => {
    const cortes = efetivos
      .filter((c) => c.data >= ep.inicio && c.data <= ep.fim)
      .sort((a, b) => a.data.localeCompare(b.data) || a.cicloId - b.cicloId)
      .flatMap((c) => c.cortesDetalhe.filter((x) => x.sku === ep.sku && corteMedido(x)));
    const tem = (k: ClasseCorte) => cortes.some((x) => x.classe === k);
    const classe: ClasseCorte = tem('teria_rompido') ? 'teria_rompido'
      : cortes.length === 0 || tem('indeterminado') || cortes.some((x) => x.classe == null) ? 'indeterminado'
        : tem('adiado') ? 'adiado' : 'eliminado';
    return { classe, valor: ep.valor };
  });
  const p = precisaoDoCorte(itens);
  return { ...p, cobertura: episodios.length > 0 ? p.n / episodios.length : null };
}

/** Soma o valor cortado do SKU dentro do ciclo e só então deduplica entre ciclos (gap 7d, valor máximo). */
function valorDeduplicado(ciclos: ResultadoCiclo[]): number {
  return deduplicarEpisodios(cortesPorCicloSku(ciclos), 7).reduce((s, e) => s + e.valor, 0);
}

/** R46: cobertura mínima (SKUs com dados completos ÷ SKUs do universo) para o ΔDIO existir. */
export const COBERTURA_MIN_CMV = 0.8;

/**
 * R46: CMV diário do universo do motor sobre o subconjunto de SKUs com dados COMPLETOS (preço da linha mais
 * recente e demanda_media_diaria): Σ demanda × preço. Cobertura = completos ÷ SKUs do universo.
 */
function cmvDiarioDoUniverso(f: Fatos): { cmv: number | null; completos: Set<string>; cobertura: number | null } {
  const universo = new Set(f.linhas.map((l) => l.sku_codigo_omie));
  const precoPorSku = new Map<string, { raiz: number; preco: number }>();
  for (const l of f.linhas) {
    const preco = precoOuNull(l.preco_unitario);
    if (preco == null) continue;
    const atual = precoPorSku.get(l.sku_codigo_omie);
    if (!atual || l.raiz > atual.raiz) precoPorSku.set(l.sku_codigo_omie, { raiz: l.raiz, preco });
  }
  let total = 0;
  const completos = new Set<string>();
  for (const [sku, { preco }] of precoPorSku) {
    const d = numOuNull(f.params.find((p) => p.sku === sku)?.demanda_media_diaria ?? null);
    if (d == null) continue;
    total += d * preco;
    completos.add(sku);
  }
  return { cmv: completos.size > 0 ? total : null, completos, cobertura: universo.size > 0 ? completos.size / universo.size : null };
}

/**
 * R25: ΔDIO/caixa liberado por EPISÓDIO dos cortes efetivos. Por episódio, o 1º corte (1º ciclo do
 * episódio; todas as embalagens do orçamento com preço daquele SKU nele, removidas juntas, na chegada real
 * — R33); replay de 30 dias fixos. `noCmv` (R46): numerador do ΔDIO só com SKUs do subconjunto do CMV.
 */
function dioPorEpisodio(f: Fatos, efetivos: ResultadoCiclo[], noCmv: Set<string>) {
  const unidades = cortesPorCicloSku(efetivos);
  const episodios: Episodio[] = deduplicarEpisodios(unidades, 7);
  let custoCom = 0;
  let custoSem = 0;
  let custoComCmv = 0;
  let custoSemCmv = 0;
  let nCmv = 0;
  let n = 0;
  let semHorizonte = 0;
  let indeterminados = 0;
  for (const ep of episodios) {
    const primeiro = unidades
      .filter((u) => u.sku === ep.sku && u.data === ep.inicio)
      .sort((a, b) => a.cicloId - b.cicloId)[0];
    const ciclo = efetivos.find((c) => c.cicloId === primeiro.cicloId)!;
    const cortes = ciclo.cortesDetalhe.filter((x) => x.sku === ep.sku && corteMedido(x));
    if (addDias(ep.inicio, HORIZONTE_DIO_DIAS) > f.meta.hoje) { semHorizonte++; continue; }
    const preco = cortes[0]?.precoUnit ?? null;
    const L = lagsAsOf(f, ciclo.data).chegadaP50;
    if (preco == null || L == null || !cortes.every((x) => x.fechamentoOk)) { indeterminados++; continue; }
    const qtde = cortes.reduce((s, x) => s + x.qtde, 0);
    const linha = f.linhas.find((l) => l.raiz === ciclo.cicloId && l.sku_codigo_omie === ep.sku);
    const ate = addDias(ep.inicio, HORIZONTE_DIO_DIAS - 1);
    const chegada = chegadaDoSku(f, ciclo.cicloId, ep.sku, ep.inicio, L);
    if (chegada.dia == null || chegada.dia < 0 || chegada.dia > HORIZONTE_DIO_DIAS - 1) { indeterminados++; continue; }
    const { com, sem } = replayComSem(f, ep.sku, qtde, ep.inicio, ate, chegada.dia, L, numOuNull(linha?.ponto_pedido ?? null));
    if (com.indeterminado || sem.indeterminado || com.estoqueMedio == null || sem.estoqueMedio == null) { indeterminados++; continue; }
    custoCom += com.estoqueMedio * preco;
    custoSem += sem.estoqueMedio * preco;
    n++;
    if (noCmv.has(ep.sku)) {
      custoComCmv += com.estoqueMedio * preco;
      custoSemCmv += sem.estoqueMedio * preco;
      nCmv++;
    }
  }
  return { custoCom, custoSem, n, semHorizonte, indeterminados, custoComCmv, custoSemCmv, nCmv };
}

export function backtest(f: Fatos, cfg: Config) {
  const ciclos = f.ciclos.map((c) => simularCiclo(f, c.id, cfg));
  const efetivos = ciclos.filter((c) => c.status === 'disparado');
  const naoEfetivos = ciclos.filter((c) => c.status !== 'disparado');
  const itensClasse = efetivos.flatMap((c) => c.cortesDetalhe
    .filter((x) => x.classe && corteMedido(x))
    .map((x) => ({ classe: x.classe as ClasseCorte, valor: x.valor as number })));
  const episodios = deduplicarEpisodios(cortesPorCicloSku(efetivos), 7);
  const precEp = precisaoPorEpisodio(efetivos);

  const cmv = cmvDiarioDoUniverso(f);
  const dio = dioPorEpisodio(f, efetivos, cmv.completos);
  const cmvDiarioBase = cmv.cmv;
  const caixaLiberado = dio.n > 0 ? dio.custoCom - dio.custoSem : null;
  // R46: ΔDIO só com cobertura do CMV ≥ 80% e numerador/denominador sobre o mesmo subconjunto de SKUs
  const deltaDioComparavel = cmv.cobertura != null && cmv.cobertura >= COBERTURA_MIN_CMV && dio.nCmv > 0
    ? deltaDio(dio.custoComCmv, dio.custoSemCmv, cmvDiarioBase)
    : null;
  // R51: aceito só conta onde a guarda de caixa deu veredito (viável/inviável)
  const comGuarda = (c: ResultadoCiclo) => c.estado.tipo !== 'indeterminado';
  // R48: sem score = revisão humana (fora do valor cortado e da precisão)
  const semScoreEfetivos = efetivos.flatMap((c) => c.cortesDetalhe.filter((x) => x.motivo === 'sem_score'));

  const avaliados = new Set<string>();
  const ruins = new Set<string>();
  for (const c of ciclos) for (const fe of c.fechamento) {
    if (fe.erro == null) continue;
    avaliados.add(fe.sku);
    if (!fe.ok) ruins.add(fe.sku);
  }

  const sensibilidade = [15, 30, 45].map((dias) => {
    const r = f.ciclos.filter((c) => statusEfetivo(c) === 'disparado').map((c) => simularCiclo(f, c.id, { ...cfg, reservaDias: dias }));
    return {
      reservaDias: dias,
      valorAceito: r.filter(comGuarda).reduce((s, x) => s + x.valorAceito, 0),
      valorAceitoSemGuarda: r.filter((x) => !comGuarda(x)).reduce((s, x) => s + x.valorAceito, 0),
      inviaveis: r.filter((x) => x.estado.tipo === 'inviavel').length,
      indeterminados: r.filter((x) => !comGuarda(x)).length,
    };
  });
  return {
    config: cfg,
    gerado_em: f.meta.gerado_em,
    premissas: PREMISSAS,
    /** R57/R58: lista auditável dos vínculos (disparado, via, NF, data em que a NF passou a existir) */
    vinculosNf: [...vinculosDe(f)].map(([id, v]) => ({ id, ...v })).sort((a, b) => a.id - b.id),
    ciclos,
    resumo: {
      nCiclos: ciclos.length,
      nDisparados: efetivos.length,
      /** R57/R58: disparados sem NF no tracking que ganharam NF por contrato / por substituto (antes do filtro as-of) */
      vinculosNf: [...vinculosDe(f).values()].reduce((acc, v) => ({ ...acc, [v.via]: acc[v.via] + 1 }), { contrato: 0, substituto: 0 }),
      valorMotorDisparados: efetivos.reduce((s, c) => s + c.valorMotor, 0),
      /** motor nos disparados COM guarda de caixa (denominador do aceito) */
      valorMotorComGuarda: efetivos.filter(comGuarda).reduce((s, c) => s + c.valorMotor, 0),
      valorAceitoDisparados: efetivos.filter(comGuarda).reduce((s, c) => s + c.valorAceito, 0),
      /** R51: aceito em ciclos indeterminados — sem guarda de caixa, só o gate econômico decidiu */
      valorAceitoSemGuarda: efetivos.filter((c) => !comGuarda(c)).reduce((s, c) => s + c.valorAceito, 0),
      ciclosSemGuarda: efetivos.filter((c) => !comGuarda(c)).length,
      valorCortadoEfetivo: valorDeduplicado(efetivos),
      valorCortadoExpirado: valorDeduplicado(naoEfetivos),
      cortesSemPreco: ciclos.reduce((s, c) => s + c.cortesDetalhe.filter((x) => x.valor == null).length, 0),
      revisaoHumana: {
        embalagens: semScoreEfetivos.length,
        semPreco: semScoreEfetivos.filter((x) => x.valor == null).length,
        /** dedup. por episódio, como o valor cortado */
        valor: deduplicarEpisodios(cortesPorCicloSku(efetivos, (x) => x.motivo === 'sem_score'), 7).reduce((s, e) => s + e.valor, 0),
      },
      cortesChegadaAproximada: efetivos.reduce((s, c) => s + c.cortesDetalhe.filter((x) => corteMedido(x) && x.chegadaAproximada === true).length, 0),
      estados: ciclos.reduce<Record<string, number>>((m, c) => ({ ...m, [c.estado.tipo]: (m[c.estado.tipo] ?? 0) + 1 }), {}),
      precisao: precisaoDoCorte(itensClasse),
      precisaoEpisodios: { precisao: precEp.precisao, valorCortado: precEp.valorCortado, n: precEp.n, indeterminados: precEp.indeterminados },
      coberturaEpisodios: precEp.cobertura,
      episodios: episodios.length,
      sensiveisAoModelo: ciclos.reduce((s, c) => s + c.sensiveisAoModelo, 0),
      /** rótulo: "CMV diário do universo do motor" */
      cmvDiarioBase,
      /** R46: SKUs com preço e demanda ÷ SKUs do universo do motor; < 80% → ΔDIO null */
      cmvCobertura: cmv.cobertura,
      caixaLiberado,
      /** R53: positivo = MENOS estoque; soma dos episódios medidos ÷ CMV diário, não média do período */
      deltaDio: deltaDioComparavel,
      episodiosDio: dio.n,
      episodiosDioNoCmv: dio.nCmv,
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
