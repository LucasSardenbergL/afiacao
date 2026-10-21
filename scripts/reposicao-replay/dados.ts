// Carregador validado dos CSVs do replay TSB (gerados por extrair.sh), contrato de unidade (§5.6) e LT documental (§5.9).
// Fail-closed: arquivo ausente, sem cabeçalho/colunas, sem marcador `fim|ok`, número ou data inválidos => ErroDadosReplay.
// Ausente (célula vazia) vira null, nunca 0.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CSVS_REPLAY, FRACAO_RECEBIMENTO_COMPLETO, LT_ABERTO_MIN_DU } from './config';
import { duEntre } from './du';
import {
  ErroDadosReplay,
  type AvisoDados,
  type Classe,
  type ClassificacaoHist,
  type Dados,
  type Data,
  type Equivalencia,
  type ItemLT,
  type LinhaVenda,
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
interface RecebLinha {
  trackingId: string;
  sku: string;
  t1: Data;
  t4: Data | null;
  pedida: number | null;
  recebida: number | null;
}

/** Agrupa por (tracking_id, sku); ltDu = du de t1 até o t4 do recebimento que leva o acumulado a >= 95% do pedido. */
export function montarItensLT(linhas: RecebLinha[], dataExtracao: Data): { itens: ItemLT[]; avisos: AvisoDados[] } {
  const grupos = new Map<string, RecebLinha[]>();
  for (const l of linhas) {
    const k = `${l.trackingId}\u0000${l.sku}`;
    const g = grupos.get(k);
    if (g) g.push(l);
    else grupos.set(k, [l]);
  }
  const itens: ItemLT[] = [];
  let t4AntesT1 = 0;
  let pedidaInvalida = 0;
  for (const g of grupos.values()) {
    const t1 = g.map((l) => l.t1).sort()[0];
    const antes = g.filter((l) => l.t4 !== null && l.t4 < l.t1).length;
    if (antes > 0) {
      t4AntesT1 += antes;
      continue;
    }
    const pedidas = g.map((l) => l.pedida).filter((p): p is number => p !== null);
    const pedida = pedidas.length ? Math.max(...pedidas) : null;
    if (pedida === null || !(pedida > 0)) {
      pedidaInvalida += g.length;
      continue;
    }
    const recs = g.filter((l) => l.t4 !== null).sort((a, b) => ((a.t4 as string) < (b.t4 as string) ? -1 : (a.t4 as string) > (b.t4 as string) ? 1 : 0));
    let acum = 0;
    let t4Completo: Data | null = null;
    for (const r of recs) {
      acum += r.recebida ?? 0;
      if (acum >= FRACAO_RECEBIMENTO_COMPLETO * pedida - 1e-9) {
        t4Completo = r.t4;
        break;
      }
    }
    const { trackingId, sku } = g[0];
    if (t4Completo !== null) itens.push({ trackingId, sku, t1, t4: t4Completo, ltDu: duEntre(t1, t4Completo), aberto: false });
    else itens.push({ trackingId, sku, t1, t4: null, ltDu: Math.max(duEntre(t1, dataExtracao), LT_ABERTO_MIN_DU), aberto: true });
  }
  itens.sort((a, b) => (a.t1 < b.t1 ? -1 : a.t1 > b.t1 ? 1 : a.trackingId < b.trackingId ? -1 : a.trackingId > b.trackingId ? 1 : a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  const avisos: AvisoDados[] = [];
  if (t4AntesT1 > 0) avisos.push({ codigo: 'T4_ANTES_DE_T1', n: t4AntesT1 });
  if (pedidaInvalida > 0) avisos.push({ codigo: 'QTD_PEDIDA_INVALIDA', n: pedidaInvalida });
  return { itens, avisos };
}

// ── carga ────────────────────────────────────────────────────────────────────────────────────────────────────────
function lerDataExtracao(dir: string): Data {
  const f = join(dir, 'extracao.log');
  if (!existsSync(f)) return invalido('extracao.log', 'ausente');
  const m = /^extracao em (\d{4}-\d{2}-\d{2})T/m.exec(readFileSync(f, 'utf8'));
  return m ? m[1] : invalido('extracao.log', 'linha "extracao em <data>T..." ausente');
}

function hashDosCsvs(dir: string): string {
  const h = createHash('sha256');
  for (const nome of [...CSVS_REPLAY].sort()) {
    const arq = `${nome}.csv`;
    if (!existsSync(join(dir, arq))) return invalido(arq, 'ausente');
    h.update(`${arq}\u0000`);
    h.update(readFileSync(join(dir, arq)));
    h.update('\u0000');
  }
  return h.digest('hex');
}

/** `dataExtracao` vem da 1ª linha de extracao.log (carimbo UTC do extrair.sh). */
export function carregarDados(dir: string): Dados {
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

  // recebimentos -> LT documental
  const rc = lerTabela(dir, 'recebimentos', ['tracking_id', 'sku', 't1', 't4', 'quantidade_pedida', 'quantidade_recebida'], false);
  const { itens: itensLT, avisos } = montarItensLT(
    rc.linhas.map((r) => ({
      trackingId: r[rc.col('tracking_id')],
      sku: r[rc.col('sku')],
      t1: data(rc.arquivo, 't1', r[rc.col('t1')]),
      t4: dataOuNull(rc.arquivo, 't4', r[rc.col('t4')]),
      pedida: numOuNull(rc.arquivo, 'quantidade_pedida', r[rc.col('quantidade_pedida')]),
      recebida: numOuNull(rc.arquivo, 'quantidade_recebida', r[rc.col('quantidade_recebida')]),
    })),
    dataExtracao,
  );

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

  return { vendas, itensLT, skus, zPorClasse, teto, equivalencias, sugestaoHoje, excluidos, classificacaoHist, avisos, dataExtracao, hashDados };
}
