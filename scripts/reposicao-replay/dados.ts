// Carregador validado dos CSVs do replay TSB (gerados por extrair.sh), contrato de unidade (§5.6) e LT documental (§5.9).
// Fail-closed: arquivo ausente, sem cabeçalho/colunas, sem marcador `fim|ok`, número ou data inválidos => ErroDadosReplay.
// Ausente (célula vazia) vira null, nunca 0.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CSV_POSICAO_ABERTURA, CSV_POSICAO_CONFERENCIA, CSVS_REPLAY, FATOR_DOC_MIN_DOCUMENTOS, FATOR_DOC_MIN_PARTICIPACAO, JANELAS, LT_ABERTO_MIN_DU, LT_FRACAO_COMPLETA } from './config';
import { duEntre } from './calendario';
import {
  ErroDadosReplay,
  type AvisoDados,
  type Classe,
  type ClassificacaoHist,
  type Dados,
  type Data,
  type Equivalencia,
  type EventoRecebimento,
  type ItemLT,
  type LinhaVenda,
  type ObsLtMotorBruta,
  type PrecoCompraDoc,
  type PrecosEmbalagem,
  type Sku,
  type TetoConfig,
} from './tipos';

export { ErroDadosReplay } from './tipos';

// ── leitura de CSV ───────────────────────────────────────────────────────────────────────────────────────────────
interface Tabela {
  arquivo: string;
  linhas: string[][];
  col: (nome: string) => number;
}

const invalido = (arquivo: string, detalhe?: string): never => {
  throw new ErroDadosReplay(`CSV_INVALIDO:${arquivo}${detalhe ? `: ${detalhe}` : ''}`);
};

/** Parser CSV (delimitador `|`, aspas duplas como no `copy ... csv` do psql, aspas internas dobradas). */
function parseRegistros(texto: string): string[][] {
  const regs: string[][] = [];
  let reg: string[] = [];
  let campo = '';
  let emAspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (emAspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else emAspas = false;
      } else campo += c;
    } else if (c === '"') emAspas = true;
    else if (c === '|') {
      reg.push(campo);
      campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      reg.push(campo);
      campo = '';
      regs.push(reg);
      reg = [];
    } else campo += c;
  }
  if (emAspas) return invalido('?', 'aspas não fechadas');
  if (campo !== '' || reg.length > 0) {
    reg.push(campo);
    regs.push(reg);
  }
  return regs;
}

function lerTabela(dir: string, nome: string, obrigatorias: string[], permiteVazia: boolean): Tabela {
  const arquivo = `${nome}.csv`;
  const caminho = join(dir, arquivo);
  if (!existsSync(caminho)) return invalido(arquivo, 'ausente');
  let regs: string[][];
  try {
    regs = parseRegistros(readFileSync(caminho, 'utf8'));
  } catch (e) {
    if (e instanceof ErroDadosReplay) return invalido(arquivo, 'aspas não fechadas');
    throw e;
  }
  const ult = regs[regs.length - 1];
  if (!ult || ult.length !== 2 || ult[0] !== 'fim' || ult[1] !== 'ok') return invalido(arquivo, 'marcador fim|ok ausente');
  regs.pop();
  const cab = regs.shift();
  if (!cab) return invalido(arquivo, 'sem cabeçalho');
  const idx = new Map(cab.map((c, i) => [c, i]));
  for (const o of obrigatorias) if (!idx.has(o)) return invalido(arquivo, `coluna ausente: ${o}`);
  regs.forEach((r, i) => {
    if (r.length !== cab.length) invalido(arquivo, `linha ${i + 2} com ${r.length} colunas (esperado ${cab.length})`);
  });
  if (regs.length === 0 && !permiteVazia) return invalido(arquivo, 'sem linhas de dados');
  return { arquivo, linhas: regs, col: (n) => idx.get(n) as number };
}

const ehVazio = (s: string): boolean => s.trim() === '';

function numOuNull(arq: string, nome: string, s: string): number | null {
  if (ehVazio(s)) return null;
  if (!/^-?\d+(\.\d+)?$/.test(s.trim())) return invalido(arq, `número inválido em ${nome}: '${s}'`);
  return Number(s);
}
function num(arq: string, nome: string, s: string): number {
  const v = numOuNull(arq, nome, s);
  return v === null ? invalido(arq, `${nome} vazio`) : v;
}
function dataOuNull(arq: string, nome: string, s: string): Data | null {
  if (ehVazio(s)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.trim()) || Number.isNaN(Date.parse(`${s.trim()}T00:00:00Z`)))
    return invalido(arq, `data inválida em ${nome}: '${s}'`);
  return s.trim();
}
function data(arq: string, nome: string, s: string): Data {
  const v = dataOuNull(arq, nome, s);
  return v === null ? invalido(arq, `${nome} vazio`) : v;
}
function bool(arq: string, nome: string, s: string): boolean {
  if (s === 't' || s === 'true') return true;
  if (s === 'f' || s === 'false') return false;
  return invalido(arq, `booleano inválido em ${nome}: '${s}'`);
}
function classeOuNull(arq: string, nome: string, s: string): Classe | null {
  if (ehVazio(s)) return null;
  if (s === 'A' || s === 'B' || s === 'C') return s;
  return invalido(arq, `classe inválida em ${nome}: '${s}'`);
}
const textoOuNull = (s: string): string | null => (ehVazio(s) ? null : s);

// ── contrato de unidade (§5.6) ───────────────────────────────────────────────────────────────────────────────────
/**
 * Divisor NF → estoque, ou null se a conversão é incoerente (SKU sai do replay; nunca se chuta).
 *  - unidades iguais (após trim/caixa): divisor 1. O `fator_conversao` do portal (litro → balde de 5 L; o motor o usa só
 *    para o múltiplo de compra, db/embalagem-motor-rpc.sql ~L219) NÃO converte a venda;
 *  - unidades diferentes: exige fator finito > 0 e <> 1 (1 é "sem fator" para o motor); quantidade_estoque = quantidade_nf / fator;
 *  - sem unidade_nf (SKU sem venda): sem o que converter => 1, a menos que haja venda da coorte (aí é incoerente);
 *  - sem unidade_estoque com unidade_nf presente: incoerente.
 */
export function divisorDeUnidade(
  unidadeNf: string | null,
  unidadeEstoque: string | null,
  fator: number | null,
  temVendaNoEscopo: boolean,
): number | null {
  const nf = unidadeNf?.trim().toUpperCase() ?? null;
  const est = unidadeEstoque?.trim().toUpperCase() ?? null;
  if (nf === null) return temVendaNoEscopo ? null : 1;
  if (est === null) return null;
  if (nf === est) return 1;
  if (fator !== null && Number.isFinite(fator) && fator > 0 && fator !== 1) return fator;
  return null;
}

// ── LT documental (§5.9) ─────────────────────────────────────────────────────────────────────────────────────────
export interface RecebLinha {
  trackingId: string;
  sku: string;
  t1: Data;
  t4: Data | null;
  /** Quantidade da linha da NF (`nQtdeNFe`), na unidade da NF (`unidadeNfe`); null = ausente. */
  pedida: number | null;
  /** Quantidade que o Omie deu entrada (`nQtdeRecebida`), na unidade de ESTOQUE; null = ausente. */
  recebida: number | null;
  /** Faturamento (t2); null = ausente. */
  t2: Data | null;
  /**
   * Identidade documental canônica do recebimento (md5 de empresa + SKU + `nfe_chave_acesso`, ou `tracking:<id>` sem
   * chave), a mesma de `v_sku_leadtime_efetivo`. Uma NF que fatura N pedidos aparece sob N tracking_id com o mesmo docId.
   */
  docId: string;
  /** Unidade da NF de entrada (`sku_leadtime_history.sku_unidade`); null = ausente. */
  unidadeNfe: string | null;
  /** Pedido encerrado no Omie (`purchase_orders_tracking.encerrado_omie_em` presente): evidência documental de que não está aberto. */
  encerrado: boolean;
  /** `purchase_orders_tracking.status` (ex.: CRIADO, FATURADO, RECEBIDO). */
  status: string;
  /** `sku_leadtime_history.valor_total` (R$ da linha); null/ausente = sem valor. Só alimenta o preco_compra_real do EOQ. */
  valor?: number | null;
  /**
   * R32: quantidade do PEDIDO de compra (`purchase_orders_tracking.raw_data->'produtos_consulta'[].nQtde`, somada nas
   * linhas do pedido com `nCodProd` = SKU) e a unidade dela (`cUnidade`); null = não casou (fallback na quantidade da NF).
   */
  pedidoQtd?: number | null;
  pedidoUnidade?: string | null;
}

const normUn = (u: string | null): string | null => (u === null ? null : u.trim().toUpperCase() || null);

/**
 * Fator NF → estoque por (SKU, unidade da NF). Unidades iguais: 1 (contrato §5.6). Diferentes: fator DOCUMENTAL = a razão
 * recebida/pedida modal dos documentos recebidos do SKU (o `fator_conversao` do portal é 1 em quase toda a coorte e não
 * converte), aceita só com >= FATOR_DOC_MIN_DOCUMENTOS documentos e a moda cobrindo >= FATOR_DOC_MIN_PARTICIPACAO deles;
 * senão null (indeterminado). Um recebimento parcial tem razão ABAIXO da moda, por isso fica detectável.
 */
export function fatoresNfParaEstoque(linhas: RecebLinha[], unidadeEstoque: Map<string, string | null>): Map<string, number | null> {
  const chave = (l: RecebLinha) => `${l.sku}\u0000${normUn(l.unidadeNfe) ?? ''}`;
  const razoes = new Map<string, Map<string, number[]>>(); // chave -> (docId -> razões)
  for (const l of linhas) {
    if (l.t4 === null || l.t4 < l.t1 || l.pedida === null || !(l.pedida > 0) || l.recebida === null || !(l.recebida > 0)) continue;
    if (l.t4 > JANELAS.calibracaoFim) continue; // R33: só documentos recebidos até 30/04 (sem olhar a avaliação)
    const k = chave(l);
    let m = razoes.get(k);
    if (!m) razoes.set(k, (m = new Map()));
    const doc = `${l.docId}\u0000${l.trackingId}`;
    const a = m.get(doc);
    if (a) a.push(l.recebida / l.pedida);
    else m.set(doc, [l.recebida / l.pedida]);
  }
  const out = new Map<string, number | null>();
  for (const l of linhas) {
    const k = chave(l);
    if (out.has(k)) continue;
    const nf = normUn(l.unidadeNfe);
    const est = normUn(unidadeEstoque.get(l.sku) ?? null);
    if (nf !== null && est !== null && nf === est) {
      out.set(k, 1);
      continue;
    }
    const docs = [...(razoes.get(k)?.values() ?? [])].map((r) => r.reduce((x, y) => x + y, 0) / r.length);
    if (docs.length < FATOR_DOC_MIN_DOCUMENTOS) {
      out.set(k, null);
      continue;
    }
    const baldes = new Map<string, number[]>();
    for (const r of docs) {
      const b = r.toPrecision(3);
      const a = baldes.get(b);
      if (a) a.push(r);
      else baldes.set(b, [r]);
    }
    const moda = [...baldes.values()].sort((x, y) => y.length - x.length)[0];
    if (moda.length / docs.length < FATOR_DOC_MIN_PARTICIPACAO) {
      out.set(k, null);
      continue;
    }
    const ord = [...moda].sort((x, y) => x - y);
    out.set(k, ord[Math.floor((ord.length - 1) / 2)]);
  }
  return out;
}

/**
 * Itens de LT por documento-SKU (tracking_id + sku), §5.9:
 *  - FECHA no t4 do recebimento documental que leva o acumulado recebido (unidade de estoque) a >= 95% da quantidade
 *    pedida convertida para a unidade de estoque (Σ pedida × fator NF→estoque). `ltDu = duEntre(t1, esse t4)`.
 *  - Nunca chega a 95% => ABERTO (aviso RECEBIMENTO_PARCIAL); conversão indeterminada => não prova que fechou, ABERTO
 *    (aviso CONVERSAO_INDETERMINADA). Exceção documental: pedido ENCERRADO no Omie fecha no último t4 (o saldo não vem
 *    mais; aviso PARCIAL_ENCERRADO_OMIE).
 *  - Sem t4: SEMPRE na amostra como aberto, `ltDu = max(du de t1 até a extração, 15)` — sem corte por atraso (achado 5
 *    do Codex). Só sai com evidência documental de que não é pedido aberto: encerrado no Omie (SEM_T4_ENCERRADO_OMIE) ou
 *    status RECEBIDO (SEM_T4_STATUS_RECEBIDO), contados.
 * Limitação: a "quantidade pedida" é a da linha da NF (`nQtdeNFe`); a do pedido de compra não está no histórico.
 */
export function montarItensLT(
  linhas: RecebLinha[],
  dataExtracao: Data,
  unidadeEstoque: Map<string, string | null> = new Map(),
): { itens: ItemLT[]; avisos: AvisoDados[] } {
  // R17 — t1 FABRICADO: a edge grava `t1 = pedidoCasado?.t1 ?? nfe.t2_data_faturamento` (docs/agent/reposicao.md, "presente
  // ≠ confiável"), e a produção deixa lt_bruto_dias_uteis NULL nesse caso, que v_sku_leadtime_estatisticas descarta. Com t2
  // presente e t1 = t2 o "LT" seria só a logística (curto, otimista): a linha sai do LT. Continua valendo como chegada FÍSICA
  // (eventosDeRecebimento não passa por aqui).
  const fatores = fatoresNfParaEstoque(linhas, unidadeEstoque);
  const fatorDe = (l: RecebLinha): number | null => fatores.get(`${l.sku}\u0000${normUn(l.unidadeNfe) ?? ''}`) ?? null;
  let t1Fabricado = 0;
  const grupos = new Map<string, RecebLinha[]>();
  for (const l of linhas) {
    if (l.t2 !== null && l.t1 === l.t2) {
      t1Fabricado++;
      continue;
    }
    const k = `${l.trackingId}\u0000${l.sku}`;
    const g = grupos.get(k);
    if (g) g.push(l);
    else grupos.set(k, [l]);
  }
  const itens: ItemLT[] = [];
  const cont = { t4AntesT1: 0, encerradoSemT4: 0, recebidoSemT4: 0, parcial: 0, indeterminada: 0, parcialEncerrado: 0, pedidaDaNf: 0 };
  for (const g of grupos.values()) {
    const t1 = g.map((l) => l.t1).sort()[0];
    const antes = g.filter((l) => l.t4 !== null && l.t4 < l.t1).length;
    if (antes > 0) {
      cont.t4AntesT1 += antes;
      continue;
    }
    const { trackingId, sku } = g[0];
    const t2s = g.map((l) => l.t2).filter((t): t is Data => t !== null).sort();
    const t2 = t2s.length ? t2s[t2s.length - 1] : null;
    const encerrado = g.some((l) => l.encerrado);
    const aberto = (): ItemLT => ({ trackingId, sku, t1, t2, t4: null, ltDu: Math.max(duEntre(t1, dataExtracao), LT_ABERTO_MIN_DU), aberto: true });
    const recebidas = g.filter((l): l is RecebLinha & { t4: Data } => l.t4 !== null).sort((a, b) => (a.t4 < b.t4 ? -1 : a.t4 > b.t4 ? 1 : 0));
    if (recebidas.length === 0) {
      if (encerrado) cont.encerradoSemT4++;
      else if (g.some((l) => l.status.trim().toUpperCase() === 'RECEBIDO')) cont.recebidoSemT4++;
      else itens.push(aberto());
      continue;
    }
    // quantidade pedida na unidade de estoque. R32: a do PEDIDO de compra quando casou (mesma em todas as linhas do pedido:
    // conta uma vez); a unidade dele converte por 1 (= estoque) ou pelo fator NF→estoque (= unidade da NF); outra unidade
    // => indeterminada. Sem casar: fallback Σ quantidade da NF × fator (aviso PEDIDA_DA_NF).
    let pedidaEst: number | null = 0;
    const comPedido = g.find((l) => l.pedidoQtd !== undefined && l.pedidoQtd !== null);
    if (comPedido) {
      const q = comPedido.pedidoQtd as number;
      const up = normUn(comPedido.pedidoUnidade ?? null);
      const ue = normUn(unidadeEstoque.get(sku) ?? null);
      const f = up !== null && up === ue ? 1 : up !== null && up === normUn(comPedido.unidadeNfe) ? fatorDe(comPedido) : null;
      pedidaEst = q > 0 && f !== null ? q * f : null;
    } else {
      cont.pedidaDaNf++;
      for (const l of g) {
        const f = fatorDe(l);
        if (pedidaEst === null || l.pedida === null || !(l.pedida > 0) || f === null) pedidaEst = null;
        else pedidaEst += l.pedida * f;
      }
    }
    let t4Completo: Data | null = null;
    if (pedidaEst !== null) {
      let acum = 0;
      for (const l of recebidas) {
        if (l.recebida !== null && l.recebida > 0) acum += l.recebida;
        if (acum >= LT_FRACAO_COMPLETA * pedidaEst - 1e-9) {
          t4Completo = l.t4;
          break;
        }
      }
    }
    if (t4Completo !== null) {
      itens.push({ trackingId, sku, t1, t2, t4: t4Completo, ltDu: duEntre(t1, t4Completo), aberto: false });
      continue;
    }
    if (pedidaEst === null) cont.indeterminada++;
    else cont.parcial++;
    if (encerrado) {
      const t4 = recebidas[recebidas.length - 1].t4;
      cont.parcialEncerrado++;
      itens.push({ trackingId, sku, t1, t2, t4, ltDu: duEntre(t1, t4), aberto: false });
    } else itens.push(aberto());
  }
  itens.sort((a, b) => (a.t1 < b.t1 ? -1 : a.t1 > b.t1 ? 1 : a.trackingId < b.trackingId ? -1 : a.trackingId > b.trackingId ? 1 : a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  const avisos: AvisoDados[] = [];
  const add = (codigo: string, n: number) => {
    if (n > 0) avisos.push({ codigo, n });
  };
  add('T4_ANTES_DE_T1', cont.t4AntesT1);
  add('T1_FABRICADO', t1Fabricado);
  add('SEM_T4_ENCERRADO_OMIE', cont.encerradoSemT4);
  add('SEM_T4_STATUS_RECEBIDO', cont.recebidoSemT4);
  add('RECEBIMENTO_PARCIAL', cont.parcial);
  add('CONVERSAO_INDETERMINADA', cont.indeterminada);
  add('PARCIAL_ENCERRADO_OMIE', cont.parcialEncerrado);
  add('PEDIDA_DA_NF', cont.pedidaDaNf);
  return { itens, avisos };
}

/**
 * preco_compra_real por documento, como v_sku_leadtime_efetivo (achado 2 do Codex): as cópias de um documento só dão
 * preço se concordam em quantidade recebida e valor (a view anula o campo quando divergem) e todas têm t4; preço =
 * valor ÷ recebida, só com os dois > 0 (o FILTER da produção). `desde` = maior t4 das cópias (o preço é conhecido em
 * d > desde). Saída ordenada por (sku, desde). Linha sem `valor` (ausente) não fabrica preço.
 */
export function precosCompraPorDocumento(linhas: readonly RecebLinha[]): PrecoCompraDoc[] {
  const porDoc = new Map<string, RecebLinha[]>();
  for (const l of linhas) {
    const g = porDoc.get(l.docId);
    if (g) g.push(l);
    else porDoc.set(l.docId, [l]);
  }
  const out: PrecoCompraDoc[] = [];
  for (const ls of porDoc.values()) {
    const r0 = ls[0].recebida;
    const v0 = ls[0].valor ?? null;
    if (r0 === null || v0 === null || !(r0 > 0) || !(v0 > 0)) continue;
    if (!ls.every((l) => l.recebida === r0 && (l.valor ?? null) === v0 && l.t4 !== null && l.sku === ls[0].sku)) continue;
    let desde = ls[0].t4!;
    for (const l of ls) if (l.t4! > desde) desde = l.t4!;
    out.push({ sku: ls[0].sku, desde, preco: v0 / r0 });
  }
  return out.sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : a.desde < b.desde ? -1 : a.desde > b.desde ? 1 : a.preco - b.preco));
}

/**
 * precos_app.csv (achado 9): uma linha por captura (capturado_em/preco vazios = membro sem captura). staleDias é o
 * mesmo em todas as linhas; elegivel_catalogo é por SKU. Arquivo só com cabeçalho => null (sem grupo, sem troca).
 */
function lerPrecosEmbalagem(dir: string): PrecosEmbalagem | null {
  const t = lerTabela(dir, 'precos_app', ['grupo_id', 'sku', 'fator_para_base', 'capturado_em', 'preco', 'elegivel_catalogo', 'stale_dias'], true);
  if (t.linhas.length === 0) return null;
  let staleDias: number | null = null;
  const elegivel = new Map<string, boolean>();
  const capturas = new Map<string, { data: Data; preco: number }[]>();
  for (const r of t.linhas) {
    const sku = r[t.col('sku')];
    if (ehVazio(sku)) invalido(t.arquivo, 'sku vazio');
    const st = num(t.arquivo, 'stale_dias', r[t.col('stale_dias')]);
    if (!(st > 0) || !Number.isInteger(st)) invalido(t.arquivo, `stale_dias inválido: ${st}`);
    if (staleDias !== null && st !== staleDias) invalido(t.arquivo, 'stale_dias divergente entre linhas');
    staleDias = st;
    const el = bool(t.arquivo, 'elegivel_catalogo', r[t.col('elegivel_catalogo')]);
    if (elegivel.has(sku) && elegivel.get(sku) !== el) invalido(t.arquivo, `elegivel_catalogo divergente em ${sku}`);
    elegivel.set(sku, el);
    const d = dataOuNull(t.arquivo, 'capturado_em', r[t.col('capturado_em')]);
    const p = numOuNull(t.arquivo, 'preco', r[t.col('preco')]);
    if ((d === null) !== (p === null)) invalido(t.arquivo, `captura incompleta em ${sku}`);
    if (d === null || p === null) continue;
    if (!(p > 0)) invalido(t.arquivo, `preco <= 0 em ${sku}`);
    const l = capturas.get(sku) ?? [];
    l.push({ data: d, preco: p });
    capturas.set(sku, l);
  }
  for (const l of capturas.values()) l.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  return { staleDias: staleDias!, elegivel, capturas };
}

/**
 * Chegadas físicas para a reconstrução do estoque, deduplicadas pela IDENTIDADE DOCUMENTAL canônica do recebimento
 * (`docId` + SKU; achado 6 do Codex — revoga a chave (sku, t4, quantidade) da R9). Só linhas com `t4`, `recebida` > 0,
 * t4 >= t1 e SKU no contrato de unidade. `recebida` já está na unidade de ESTOQUE (o Omie converte na entrada): entra sem
 * o divisor NF→estoque da venda. Por documento:
 *  - todas as linhas com a mesma quantidade = cópias do mesmo recebimento sob vários tracking_id => UM evento
 *    (COPIAS_DO_DOCUMENTO_FUNDIDAS conta as cópias descartadas);
 *  - quantidades diferentes = linhas de pedidos distintos da mesma NF => soma (DOCUMENTO_COM_LINHAS_DIVERGENTES);
 *  - t4 divergente entre as linhas: entra no 1º (T4_DIVERGENTE_NO_DOCUMENTO).
 * Documentos distintos com a mesma quantidade no mesmo dia são eventos distintos.
 * Limitação: dois pedidos da MESMA NF com a mesma quantidade do mesmo SKU são indistinguíveis de cópias (viram 1).
 */
export function eventosDeRecebimento(linhas: RecebLinha[], divisor: Map<string, number>): { eventos: EventoRecebimento[]; avisos: AvisoDados[] } {
  const docs = new Map<string, (RecebLinha & { t4: Data; recebida: number })[]>();
  for (const l of linhas) {
    if (l.t4 === null || l.recebida === null || !(l.recebida > 0) || l.t4 < l.t1) continue;
    if (!divisor.has(l.sku)) continue;
    const k = `${l.sku}\u0000${l.docId}`;
    const g = docs.get(k);
    const v = l as RecebLinha & { t4: Data; recebida: number };
    if (g) g.push(v);
    else docs.set(k, [v]);
  }
  const eventos: EventoRecebimento[] = [];
  let copias = 0;
  let divergentes = 0;
  let t4Divergente = 0;
  for (const g of docs.values()) {
    const t4s = [...new Set(g.map((l) => l.t4))].sort();
    if (t4s.length > 1) t4Divergente++;
    const qtds = new Set(g.map((l) => l.recebida));
    let quantidade: number;
    if (qtds.size === 1) {
      quantidade = g[0].recebida;
      copias += g.length - 1;
    } else {
      divergentes++;
      quantidade = g.reduce((s, l) => s + l.recebida, 0);
    }
    eventos.push({ sku: g[0].sku, data: t4s[0], quantidade });
  }
  eventos.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : a.quantidade - b.quantidade));
  const avisos: AvisoDados[] = [];
  if (copias > 0) avisos.push({ codigo: 'COPIAS_DO_DOCUMENTO_FUNDIDAS', n: copias });
  if (divergentes > 0) avisos.push({ codigo: 'DOCUMENTO_COM_LINHAS_DIVERGENTES', n: divergentes });
  if (t4Divergente > 0) avisos.push({ codigo: 'T4_DIVERGENTE_NO_DOCUMENTO', n: t4Divergente });
  return { eventos, avisos };
}

// ── carga ────────────────────────────────────────────────────────────────────────────────────────────────────────
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const FMT_SP = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
/** Dia de São Paulo de um instante UTC (`YYYY-MM-DDTHH:MM:SSZ`). */
export function dataSP(isoUtc: string): Data {
  if (!ISO_UTC.test(isoUtc) || Number.isNaN(Date.parse(isoUtc))) throw new ErroDadosReplay(`INSTANTE_INVALIDO:${isoUtc}`);
  return FMT_SP.format(new Date(isoUtc));
}

/**
 * R40: data da extração = o dia de SÃO PAULO do carimbo UTC do extracao.log (o "hoje" da produção). O dia UTC simulava
 * uma passada do dia seguinte quando a extração rodava depois das 21:00 de SP.
 */
function lerDataExtracao(dir: string): Data {
  const f = join(dir, 'extracao.log');
  if (!existsSync(f)) return invalido('extracao.log', 'ausente');
  const m = /^extracao em (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/m.exec(readFileSync(f, 'utf8'));
  return m ? dataSP(m[1]) : invalido('extracao.log', 'linha "extracao em <YYYY-MM-DDTHH:MM:SSZ>" ausente');
}

/** R40: a execução do motor de sugestao_hoje é do dia (SP) da extração e não houve passada de sku_parametros depois dela. */
function lerMotor(dir: string, dataExtracao: Data): NonNullable<Dados['motor']> {
  const t = lerTabela(dir, 'motor', ['horario_geracao', 'ultima_passada'], false);
  if (t.linhas.length !== 1) return invalido(t.arquivo, `esperada 1 linha, veio ${t.linhas.length}`);
  const horarioGeracao = t.linhas[0][t.col('horario_geracao')];
  const ultimaPassada = t.linhas[0][t.col('ultima_passada')];
  if (!ISO_UTC.test(horarioGeracao) || !ISO_UTC.test(ultimaPassada)) return invalido(t.arquivo, `instante fora do formato UTC: ${horarioGeracao} / ${ultimaPassada}`);
  if (ultimaPassada > horarioGeracao) {
    throw new ErroDadosReplay(`PASSADA_ENTRE_MOTOR_E_EXTRACAO: a passada de ${ultimaPassada} é posterior à execução do motor de ${horarioGeracao} — re-extraia depois de uma nova execução do motor`);
  }
  if (dataSP(horarioGeracao) !== dataExtracao) {
    throw new ErroDadosReplay(`MOTOR_DE_OUTRO_DIA: a execução do motor (${horarioGeracao}, dia ${dataSP(horarioGeracao)} em SP) não é do dia da extração (${dataExtracao} em SP)`);
  }
  return { horarioGeracao, ultimaPassada };
}

/** R43: linhas de v_sku_leadtime_efetivo para o LT do F0 (t2, t4 e lt obrigatórios; fornecedor pode faltar). */
function lerLtMotor(dir: string): ObsLtMotorBruta[] {
  const t = lerTabela(dir, 'lt_motor', ['sku', 'fornecedor', 't2', 't4', 'lt'], false);
  return t.linhas.map((r) => {
    const f = r[t.col('fornecedor')];
    return {
      sku: r[t.col('sku')],
      fornecedor: ehVazio(f) ? null : num(t.arquivo, 'fornecedor', f),
      t2: data(t.arquivo, 't2', r[t.col('t2')]),
      t4: data(t.arquivo, 't4', r[t.col('t4')]),
      lt: num(t.arquivo, 'lt', r[t.col('lt')]),
    };
  });
}

function hashDosCsvs(dir: string): string {
  const h = createHash('sha256');
  const opcionais = [CSV_POSICAO_ABERTURA, CSV_POSICAO_AQUECIMENTO_FIM, CSV_POSICAO_CONFERENCIA].filter((n) => existsSync(join(dir, `${n}.csv`)));
  for (const nome of [...CSVS_REPLAY, ...opcionais].sort()) {
    const arq = `${nome}.csv`;
    if (!existsSync(join(dir, arq))) return invalido(arq, 'ausente');
    h.update(`${arq}\u0000`);
    h.update(readFileSync(join(dir, arq)));
    h.update('\u0000');
  }
  return h.digest('hex');
}

/**
 * Posição datada do Omie (`nCodProd|cCodigo|nSaldo`, marcador fim|ok) → mapa SKU → saldo. `nCodProd` = sku_codigo_omie.
 * Arquivo ausente => null (opcional). nSaldo vazio fica fora do mapa (ausente ≠ 0). nCodProd repetido => CSV inválido.
 */
/** Saldos (`nSaldo`) do CSV de posição; os CMCs (`nCMC`, R45) vão para `cmcs` se fornecido. Vazio fica fora (nunca 0). */
function lerPosicaoOmie(dir: string, nome: string, cmcs?: Map<string, number>): Map<string, number> | null {
  if (!existsSync(join(dir, `${nome}.csv`))) return null;
  const t = lerTabela(dir, nome, ['nCodProd', 'cCodigo', 'nSaldo', 'nCMC'], false);
  const out = new Map<string, number>();
  const vistos = new Set<string>();
  for (const r of t.linhas) {
    const cod = r[t.col('nCodProd')].trim();
    if (!/^\d+$/.test(cod)) invalido(t.arquivo, `nCodProd inválido: '${cod}'`);
    if (vistos.has(cod)) invalido(t.arquivo, `nCodProd duplicado: ${cod}`);
    vistos.add(cod);
    const v = numOuNull(t.arquivo, 'nSaldo', r[t.col('nSaldo')]);
    if (v !== null) out.set(cod, v);
    const c = numOuNull(t.arquivo, 'nCMC', r[t.col('nCMC')]);
    if (c !== null && !(c > 0)) invalido(t.arquivo, `nCMC ≤ 0 em ${cod} (o extrator grava vazio)`);
    if (c !== null && cmcs) cmcs.set(cod, c);
  }
  return out;
}

/** R45: o nCMC das posições datadas do Omie (as três da âncora/conferência), por data crescente. */
function lerCmcOmie(dir: string): NonNullable<Dados['cmcOmie']> {
  const out: NonNullable<Dados['cmcOmie']> = [];
  for (const nome of [CSV_POSICAO_ABERTURA, CSV_POSICAO_AQUECIMENTO_FIM, CSV_POSICAO_CONFERENCIA]) {
    const cmc = new Map<string, number>();
    if (lerPosicaoOmie(dir, nome, cmc) === null) continue;
    if (cmc.size > 0) out.push({ data: nome.slice('posicao_omie_'.length), cmc });
  }
  return out.sort((a, b) => (a.data < b.data ? -1 : 1));
}

/** `dataExtracao` vem da 1ª linha de extracao.log (carimbo UTC do extrair.sh). */
/** Posição do Omie no fim do aquecimento (31/01): início da conferência R31. */
export const CSV_POSICAO_AQUECIMENTO_FIM = `posicao_omie_${JANELAS.aquecimentoFim}`;
/** Dados + a posição de 31/01 (conferência R31; opcional, null se não extraída). */
export type DadosCarregados = Dados & { posicaoAquecimentoFim: Map<string, number> | null };

export function carregarDados(dir: string): DadosCarregados {
  const dataExtracao = lerDataExtracao(dir);
  const hashDados = hashDosCsvs(dir);

  // config_custos: z por classe (OBEN, 1 linha)
  const cc = lerTabela(dir, 'config_custos', ['z_classe_a', 'z_classe_b', 'z_classe_c'], false);
  if (cc.linhas.length !== 1) invalido(cc.arquivo, 'esperada exatamente 1 linha');
  const zPorClasse: Record<Classe, number> = {
    A: num(cc.arquivo, 'z_classe_a', cc.linhas[0][cc.col('z_classe_a')]),
    B: num(cc.arquivo, 'z_classe_b', cc.linhas[0][cc.col('z_classe_b')]),
    C: num(cc.arquivo, 'z_classe_c', cc.linhas[0][cc.col('z_classe_c')]),
  };

  // teto
  const tt = lerTabela(dir, 'teto', ['key', 'value'], false);
  const tetoKv = new Map(tt.linhas.map((r) => [r[tt.col('key')], r[tt.col('value')]]));
  const pega = (k: string): string => tetoKv.get(`reposicao_teto_cobertura_oben_${k}`) ?? invalido(tt.arquivo, `chave ausente: ${k}`);
  const ativaTxt = pega('ativa');
  if (ativaTxt !== 'true' && ativaTxt !== 'false') invalido(tt.arquivo, `ativa inválida: '${ativaTxt}'`);
  const teto: TetoConfig = {
    ativa: ativaTxt === 'true',
    diasB: num(tt.arquivo, 'dias_b', pega('dias_b')),
    diasC: num(tt.arquivo, 'dias_c', pega('dias_c')),
  };

  // skus (bruto)
  const sk = lerTabela(
    dir,
    'skus',
    ['sku', 'descricao', 'grupo_codigo', 'classe_abc_hoje', 'classe_forcada', 'minimo_forcado', 'minimo_operacional', 'multiplo_embalagem', 'unidade_nf', 'unidade_estoque', 'fator_conversao', 'cmc', 'saldo_hoje', 'habilitado', 'ativo', 'custo_pedido_aplicado', 'custo_capital_perc', 'es_hoje', 'pp_hoje', 'max_hoje', 'grupo_embalagem_id'],
    false,
  );
  const skusBrutos = new Map<string, Sku>();
  for (const r of sk.linhas) {
    const g = (n: string) => r[sk.col(n)];
    const sku = g('sku');
    if (ehVazio(sku)) invalido(sk.arquivo, 'sku vazio');
    if (skusBrutos.has(sku)) invalido(sk.arquivo, `sku duplicado: ${sku}`);
    skusBrutos.set(sku, {
      sku,
      descricao: g('descricao'),
      grupo: textoOuNull(g('grupo_codigo')),
      classeAbcHoje: classeOuNull(sk.arquivo, 'classe_abc_hoje', g('classe_abc_hoje')),
      classeForcada: classeOuNull(sk.arquivo, 'classe_forcada', g('classe_forcada')),
      minimoForcado: numOuNull(sk.arquivo, 'minimo_forcado', g('minimo_forcado')),
      minimoOperacional: numOuNull(sk.arquivo, 'minimo_operacional', g('minimo_operacional')),
      multiplo: numOuNull(sk.arquivo, 'multiplo_embalagem', g('multiplo_embalagem')),
      cmc: numOuNull(sk.arquivo, 'cmc', g('cmc')),
      saldoHoje: numOuNull(sk.arquivo, 'saldo_hoje', g('saldo_hoje')),
      ativo: bool(sk.arquivo, 'ativo', g('ativo')),
      habilitado: bool(sk.arquivo, 'habilitado', g('habilitado')),
      unidadeNf: textoOuNull(g('unidade_nf')),
      unidadeEstoque: textoOuNull(g('unidade_estoque')),
      fatorConversao: numOuNull(sk.arquivo, 'fator_conversao', g('fator_conversao')),
      grupoEmbalagemId: textoOuNull(g('grupo_embalagem_id')),
      f0: {
        custoPedido: num(sk.arquivo, 'custo_pedido_aplicado', g('custo_pedido_aplicado')),
        custoCapitalPerc: num(sk.arquivo, 'custo_capital_perc', g('custo_capital_perc')),
      },
      hoje: {
        es: numOuNull(sk.arquivo, 'es_hoje', g('es_hoje')),
        pp: numOuNull(sk.arquivo, 'pp_hoje', g('pp_hoje')),
        max: numOuNull(sk.arquivo, 'max_hoje', g('max_hoje')),
      },
    });
  }

  // vendas
  const vd = lerTabela(dir, 'vendas', ['linha_id', 'sku', 'data', 'quantidade', 'valor', 'cmc_linha', 'no_escopo'], false);
  const vistos = new Set<string>();
  const vendasBrutas = vd.linhas.map((r) => {
    const linhaId = r[vd.col('linha_id')];
    if (vistos.has(linhaId)) invalido(vd.arquivo, `linha_id duplicado: ${linhaId}`);
    vistos.add(linhaId);
    const esc = r[vd.col('no_escopo')];
    if (esc !== '0' && esc !== '1') invalido(vd.arquivo, `no_escopo inválido: '${esc}'`);
    const sku = r[vd.col('sku')];
    if (esc === '1' && !skusBrutos.has(sku)) invalido(vd.arquivo, `venda no_escopo de sku fora de skus.csv: ${sku}`);
    return {
      linhaId,
      sku,
      data: data(vd.arquivo, 'data', r[vd.col('data')]),
      quantidade: num(vd.arquivo, 'quantidade', r[vd.col('quantidade')]),
      valor: num(vd.arquivo, 'valor', r[vd.col('valor')]),
      cmcLinha: numOuNull(vd.arquivo, 'cmc_linha', r[vd.col('cmc_linha')]),
      noEscopo: esc === '1',
    } satisfies LinhaVenda;
  });

  // contrato de unidade: quem sai e o divisor de quem fica
  const comVenda = new Set(vendasBrutas.filter((v) => v.noEscopo).map((v) => v.sku));
  const skus = new Map<string, Sku>();
  const divisor = new Map<string, number>();
  const excluidos: { sku: string; motivo: string }[] = [];
  for (const [sku, s] of skusBrutos) {
    const d = divisorDeUnidade(s.unidadeNf, s.unidadeEstoque, s.fatorConversao, comVenda.has(sku));
    if (d === null) excluidos.push({ sku, motivo: 'UNIDADE_INCOERENTE' });
    else {
      skus.set(sku, s);
      divisor.set(sku, d);
    }
  }
  const vendas = vendasBrutas.map((v) => {
    const d = divisor.get(v.sku);
    if (d === undefined) return v.noEscopo ? { ...v, noEscopo: false } : v; // SKU excluído: sai do escopo (valor preservado p/ o Pareto)
    return v.noEscopo ? { ...v, quantidade: v.quantidade / d } : v;
  });

  // recebimentos -> LT documental e chegadas físicas
  const rc = lerTabela(dir, 'recebimentos', ['tracking_id', 'sku', 't1', 't4', 'quantidade_pedida', 'quantidade_recebida', 't2', 'doc_md5', 'unidade_nfe', 'encerrado_omie', 'status_tracking', 'valor_total', 'pedido_qtd', 'pedido_unidade', 'origem_compra'], false);
  const recLinhas: RecebLinha[] = rc.linhas.map((r) => {
    const docId = r[rc.col('doc_md5')];
    if (ehVazio(docId)) invalido(rc.arquivo, `doc_md5 vazio em ${r[rc.col('tracking_id')]}`);
    return {
      trackingId: r[rc.col('tracking_id')],
      sku: r[rc.col('sku')],
      t1: data(rc.arquivo, 't1', r[rc.col('t1')]),
      t4: dataOuNull(rc.arquivo, 't4', r[rc.col('t4')]),
      pedida: numOuNull(rc.arquivo, 'quantidade_pedida', r[rc.col('quantidade_pedida')]),
      recebida: numOuNull(rc.arquivo, 'quantidade_recebida', r[rc.col('quantidade_recebida')]),
      t2: dataOuNull(rc.arquivo, 't2', r[rc.col('t2')]),
      docId,
      unidadeNfe: textoOuNull(r[rc.col('unidade_nfe')]),
      encerrado: bool(rc.arquivo, 'encerrado_omie', r[rc.col('encerrado_omie')]),
      status: r[rc.col('status_tracking')],
      valor: numOuNull(rc.arquivo, 'valor_total', r[rc.col('valor_total')]),
      pedidoQtd: numOuNull(rc.arquivo, 'pedido_qtd', r[rc.col('pedido_qtd')]),
      pedidoUnidade: textoOuNull(r[rc.col('pedido_unidade')]),
    };
  });
  // R38: a produção só usa `origem_compra = 'normal'` no LT e no preço de compra (v_sku_leadtime_efetivo →
  // v_sku_leadtime_history_normal). Hoje 100% das linhas são normal; outra origem (ou vazia) PARA a carga (fail-closed) em vez
  // de filtrar em silêncio: o recebimento físico dela continuaria no estoque e só o LT/preço sairiam — decisão a tomar quando
  // aparecer, não por omissão.
  const naoNormal = rc.linhas.filter((r) => r[rc.col('origem_compra')] !== 'normal');
  if (naoNormal.length > 0) {
    const porOrigem = new Map<string, number>();
    for (const r of naoNormal) porOrigem.set(r[rc.col('origem_compra')] || '(vazia)', (porOrigem.get(r[rc.col('origem_compra')] || '(vazia)') ?? 0) + 1);
    throw new ErroDadosReplay(`ORIGEM_COMPRA_NAO_NORMAL: ${naoNormal.length} linha(s) em ${rc.arquivo} (${[...porOrigem].map(([o, n]) => `${o} ${n}`).join(', ')})`);
  }
  const unidadeEstoque = new Map([...skusBrutos].map(([k, s]) => [k, s.unidadeEstoque] as const));
  const { itens: itensLT, avisos: avisosLT } = montarItensLT(recLinhas, dataExtracao, unidadeEstoque);
  const { eventos: recebimentos, avisos: avisosFisicos } = eventosDeRecebimento(recLinhas, divisor);
  const avisos = [...avisosLT, ...avisosFisicos];

  // equivalencias (vazia é aceita)
  const eq = lerTabela(dir, 'equivalencias', ['sku', 'sku_equivalente', 'fator', 'grupo_id', 'fator_para_base_sku', 'fator_para_base_equivalente', 'unidades_omie_sku', 'unidades_omie_equivalente'], true);
  const equivalencias: Equivalencia[] = eq.linhas.map((r) => {
    const fator = num(eq.arquivo, 'fator', r[eq.col('fator')]);
    if (!(fator > 0)) invalido(eq.arquivo, `fator <= 0 em ${r[eq.col('sku')]}`);
    return {
      sku: r[eq.col('sku')],
      skuEquivalente: r[eq.col('sku_equivalente')],
      fator,
      grupoId: r[eq.col('grupo_id')],
      fatorParaBaseSku: num(eq.arquivo, 'fator_para_base_sku', r[eq.col('fator_para_base_sku')]),
      fatorParaBaseEquivalente: num(eq.arquivo, 'fator_para_base_equivalente', r[eq.col('fator_para_base_equivalente')]),
      unidadesOmieSku: numOuNull(eq.arquivo, 'unidades_omie_sku', r[eq.col('unidades_omie_sku')]),
      unidadesOmieEquivalente: numOuNull(eq.arquivo, 'unidades_omie_equivalente', r[eq.col('unidades_omie_equivalente')]),
    };
  });

  // sugestao_hoje
  const sg = lerTabela(dir, 'sugestao_hoje', ['sku', 'posicao', 'qtde_final'], true);
  const sugestaoHoje = new Map<string, { posicao: number; qtdeFinal: number }>();
  for (const r of sg.linhas) {
    const sku = r[sg.col('sku')];
    if (sugestaoHoje.has(sku)) invalido(sg.arquivo, `sku duplicado: ${sku}`);
    sugestaoHoje.set(sku, { posicao: num(sg.arquivo, 'posicao', r[sg.col('posicao')]), qtdeFinal: num(sg.arquivo, 'qtde_final', r[sg.col('qtde_final')]) });
  }

  // classificacao_hist
  const ch = lerTabela(dir, 'classificacao_hist', ['tipo', 'chave', 'classe_atual', 'classe_abc', 'classe_xyz', 'classe_pendente', 'meses_consecutivos', 'data_ultima_mudanca', 'valor'], false);
  const classificacaoHist: ClassificacaoHist = { regras: {}, porSku: new Map() };
  for (const r of ch.linhas) {
    const tipo = r[ch.col('tipo')];
    const chave = r[ch.col('chave')];
    if (tipo === 'regra') classificacaoHist.regras[chave] = r[ch.col('valor')];
    else if (tipo === 'sku') {
      if (classificacaoHist.porSku.has(chave)) invalido(ch.arquivo, `sku duplicado: ${chave}`);
      classificacaoHist.porSku.set(chave, {
        classeAtual: r[ch.col('classe_atual')],
        classeAbc: r[ch.col('classe_abc')],
        classeXyz: r[ch.col('classe_xyz')],
        classePendente: textoOuNull(r[ch.col('classe_pendente')]),
        mesesConsecutivos: num(ch.arquivo, 'meses_consecutivos', r[ch.col('meses_consecutivos')]),
        dataUltimaMudanca: dataOuNull(ch.arquivo, 'data_ultima_mudanca', r[ch.col('data_ultima_mudanca')]),
        valor: numOuNull(ch.arquivo, 'valor', r[ch.col('valor')]),
      });
    } else invalido(ch.arquivo, `tipo desconhecido: '${tipo}'`);
  }

  // demanda_insumo (R16): fração em [0, 1]; arquivo só com cabeçalho é válido (nenhum SKU com insumo)
  const di = lerTabela(dir, 'demanda_insumo', ['sku', 'share_insumo'], true);
  const shareInsumo = new Map<string, number>();
  for (const r of di.linhas) {
    const sku = r[di.col('sku')];
    const v = num(di.arquivo, 'share_insumo', r[di.col('share_insumo')]);
    if (!(v >= 0 && v <= 1)) invalido(di.arquivo, `share_insumo fora de [0,1] em ${sku}: ${v}`);
    if (shareInsumo.has(sku)) invalido(di.arquivo, `sku duplicado: ${sku}`);
    shareInsumo.set(sku, v);
  }

  // parametros_view (R19): a sugestão da view de produção no instante da extração (referência primária da paridade)
  const pv = lerTabela(dir, 'parametros_view', ['sku', 'es', 'pp', 'max', 'status'], false);
  const parametrosView: Dados['parametrosView'] = new Map();
  for (const r of pv.linhas) {
    const sku = r[pv.col('sku')];
    const status = r[pv.col('status')];
    if (ehVazio(status)) invalido(pv.arquivo, `status vazio em ${sku}`);
    if (parametrosView.has(sku)) invalido(pv.arquivo, `sku duplicado: ${sku}`);
    const v = { es: numOuNull(pv.arquivo, 'es', r[pv.col('es')]), pp: numOuNull(pv.arquivo, 'pp', r[pv.col('pp')]), max: numOuNull(pv.arquivo, 'max', r[pv.col('max')]), status };
    if (status === 'OK' && (v.es === null || v.pp === null || v.max === null)) invalido(pv.arquivo, `status OK sem parâmetro em ${sku}`);
    parametrosView.set(sku, v);
  }

  const posicaoAbertura = lerPosicaoOmie(dir, CSV_POSICAO_ABERTURA);
  const posicaoConferencia = lerPosicaoOmie(dir, CSV_POSICAO_CONFERENCIA);
  const posicaoAquecimentoFim = lerPosicaoOmie(dir, CSV_POSICAO_AQUECIMENTO_FIM);
  const precosCompra = precosCompraPorDocumento(recLinhas);
  const precosEmbalagem = lerPrecosEmbalagem(dir);

  const motor = lerMotor(dir, dataExtracao);
  const cmcOmie = lerCmcOmie(dir);
  const ltMotor = lerLtMotor(dir);
  return { vendas, itensLT, recebimentos, skus, zPorClasse, teto, equivalencias, sugestaoHoje, excluidos, classificacaoHist, shareInsumo, parametrosView, avisos, dataExtracao, posicaoAbertura, posicaoConferencia, posicaoAquecimentoFim, precosCompra, precosEmbalagem, motor, ltMotor, cmcOmie, hashDados };
}
