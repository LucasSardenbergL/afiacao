// Lógica pura do Raio-X do estoque parado (spec 2026-10-14). Sem I/O:
// usada pelo gerador (Node), pela página (navegador) e pela medição.

export const TOP_N = 61;
export const DIAS_NOVO = 90;
export const DESTINOS = ['trocar', 'venda_dirigida', 'liquidar', 'manter_suspender_recompra', 'estrategico', 'erro_cadastro'];
export const ROTULOS = {
  trocar: 'Trocar', venda_dirigida: 'Venda dirigida', liquidar: 'Liquidar',
  manter_suspender_recompra: 'Manter · suspender recompra', estrategico: 'Estratégico',
  erro_cadastro: 'Erro de cadastro', novo_aguarde: 'Novo · aguarde', revisar: 'Revisar',
};
const RE_NAO_MERC = /MAQUINA|ESPECTRO|SOFTWARE|MOSTRUARIO|CARTELA|EXPOSITOR|DISPLAY/i;
const SEM_COMPRADOR = 'sem comprador em 12m';

function diasEntre(data, hoje) {
  if (!data) return null;
  return Math.floor((Date.parse(hoje) - Date.parse(data)) / 86400000);
}

export function categorizar(it) {
  const d = it.descricao ?? '';
  if (it.familia === 'Imobilizado') return { categoria: 'nao_mercadoria', motivo: 'família Imobilizado' };
  const m = d.match(RE_NAO_MERC);
  if (m && it.q12 === 0) return { categoria: 'nao_mercadoria', motivo: `descrição contém ${m[0].toUpperCase()} e sem venda em 12m` };
  if (it.familia === 'Concentrados MixMachine') return { categoria: 'insumo_maquina', motivo: 'concentrado da MixMachine' };
  if (it.familia === 'Concentrados LC' && /^AT[LP]/i.test(d)) return { categoria: 'insumo_maquina', motivo: 'concentrado ATL/ATP da 2ª máquina' };
  if (/1000 ?KG/i.test(d)) return { categoria: 'granel', motivo: 'granel 1.000 kg para fracionar' };
  return { categoria: 'mercadoria', motivo: '' };
}

export function cobertura(it) {
  return it.q12 > 0 ? it.saldo / (it.q12 / 365) : null;
}

export function sugerirDestino(it, hoje) {
  const cad = diasEntre(it.cadastro_em, hoje);
  const ent = diasEntre(it.ult_entrada, hoje);
  if (cad !== null && cad < DIAS_NOVO) return { destino: 'novo_aguarde', motivo: `cadastrado há ${cad} dias` };
  if (ent !== null && ent < DIAS_NOVO) {
    return { destino: 'novo_aguarde', motivo: `entrada há ${ent} dias${it.q12 === 0 ? ' — recompra de item sem venda em 12m? revisar' : ''}` };
  }
  if ((it.unidades_venda ?? []).some((u) => u !== it.unidade_estoque)) {
    return { destino: 'revisar', motivo: 'unidade da venda ≠ unidade do estoque — cobertura não confiável' };
  }
  const cob = cobertura(it);
  if (it.q12 === 0 && /sayerlack/i.test(it.fornecedor ?? '')) return { destino: 'trocar', motivo: 'Sayerlack · 0 vendas em 12m → troca por crédito' };
  if (it.q12 > 0 && cob > 365) return { destino: 'venda_dirigida', motivo: `cobertura ${Math.round(cob)} dias · ${it.ncli} cliente(s) compraram` };
  if (it.q12 > 0 && cob > 180) return { destino: 'manter_suspender_recompra', motivo: `cobertura ${Math.round(cob)} dias · vende, mas não recomprar` };
  if (it.q12 === 0) {
    return { destino: 'liquidar', motivo: `0 vendas em 12m · sem comprador · fornecedor ${it.fornecedor ?? '?'} — informe se aceita troca` };
  }
  return { destino: 'revisar', motivo: `fora do motor com cobertura ${Math.round(cob)} dias` };
}

export function classificar(fatos, hoje) {
  const itens = fatos.itens.map((it) => {
    const c = categorizar(it);
    const s = c.categoria === 'mercadoria' ? sugerirDestino(it, hoje) : { destino: null, motivo: '' };
    return {
      ...it,
      valor: it.saldo * it.cmc,
      cobertura: cobertura(it),
      categoria: c.categoria, motivo_categoria: c.motivo,
      destino_sugerido: s.destino, motivo_destino: s.motivo,
      top: false,
    };
  }).sort((a, b) => b.valor - a.valor);
  itens.filter((i) => i.categoria === 'mercadoria').slice(0, TOP_N).forEach((i) => { i.top = true; });
  return { meta: fatos.meta, itens };
}

const decidido = (d) => Boolean(d && DESTINOS.includes(d.destino));

export function placar(itens, decisoes) {
  const p = { total: 0, decidido: 0, pendente: 0, porDestino: {}, topTotal: 0, topDecidido: 0 };
  for (const i of itens) {
    if (i.categoria !== 'mercadoria') continue;
    const d = decisoes[i.sku];
    p.total += i.valor;
    if (i.top) p.topTotal += i.valor;
    if (decidido(d)) {
      p.decidido += i.valor;
      if (i.top) p.topDecidido += i.valor;
      p.porDestino[d.destino] = (p.porDestino[d.destino] ?? 0) + i.valor;
    }
  }
  p.pendente = p.total - p.decidido;
  return p;
}

export function listaTroca(itens, decisoes) {
  return itens
    .filter((i) => decisoes[i.sku]?.destino === 'trocar')
    .map(({ sku, codigo, descricao, saldo, valor, fornecedor }) => ({
      sku, codigo, descricao, saldo, valor, fornecedor: decisoes[sku].fornecedor_informado || fornecedor || '?',
    }))
    .sort((a, b) => a.fornecedor.localeCompare(b.fornecedor) || b.valor - a.valor);
}

export function vendaDirigidaPorCliente(itens, decisoes) {
  const grupos = new Map();
  for (const i of itens) {
    if (decisoes[i.sku]?.destino !== 'venda_dirigida') continue;
    const compradores = i.clientes?.length ? i.clientes : [{ nome: SEM_COMPRADOR, ult: null, qtd: 0 }];
    for (const c of compradores) {
      const g = grupos.get(c.nome) ?? { cliente: c.nome, valor: 0, itens: [] };
      g.itens.push({ codigo: i.codigo, descricao: i.descricao, saldo: i.saldo, valor: i.valor, ult: c.ult, qtd: c.qtd });
      g.valor += i.valor;
      grupos.set(c.nome, g);
    }
  }
  return [...grupos.values()].sort((a, b) => b.valor - a.valor);
}

export function diffContagem(it, qtdContada) {
  if (qtdContada === null || qtdContada === undefined || qtdContada === '') return null;
  const q = Number(qtdContada);
  if (!Number.isFinite(q)) return null;
  const dif = q - it.saldo;
  return { dif_un: dif, dif_valor: dif * it.cmc };
}

export function parseValorBR(s) {
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  if (s === null || s === undefined) return null;
  const limpo = String(s).replace(/R\$|\s/g, '');
  if (!/^\d{1,3}(\.\d{3})*(,\d+)?$|^\d+(,\d+)?$/.test(limpo)) return null;
  return Number(limpo.replace(/\./g, '').replace(',', '.'));
}

const CONTRADICAO = ['trocar', 'liquidar', 'manter_suspender_recompra'];
const LIMIAR_LIQUIDACAO = 0.9;

export function medir(retrato, decisoes, atual) {
  const m = { vendido: 0, liquidado: 0, margem_sacrificada: 0, trocado: 0, caixa_liberado: 0, parado: 0,
    reclassificado_nao_caixa: 0, contradicoes: [], sem_medicao: [] };
  for (const i of retrato.itens) {
    if (i.categoria === 'nao_mercadoria') { m.reclassificado_nao_caixa += i.valor; continue; }
    if (i.categoria !== 'mercadoria') continue;
    const d = decisoes[i.sku] ?? {};
    const a = atual[i.sku];
    if (!a) { m.sem_medicao.push(i.sku); m.parado += i.valor; continue; }
    const qtd = Math.min(a.qtd_vendida, i.saldo);
    const custo = qtd * i.cmc;
    const precoPeriodo = a.qtd_vendida > 0 ? a.receita / a.qtd_vendida : null;
    if (precoPeriodo !== null && i.preco_medio_12m && precoPeriodo < LIMIAR_LIQUIDACAO * i.preco_medio_12m) {
      m.liquidado += custo;
      m.margem_sacrificada += qtd * i.preco_medio_12m - (a.receita * qtd) / a.qtd_vendida;
    } else {
      m.vendido += custo;
    }
    if (d.destino === 'trocar' && typeof d.credito_troca === 'number') m.trocado += d.credito_troca;
    m.parado += Math.min(a.saldo, i.saldo) * i.cmc;
    if (CONTRADICAO.includes(d.destino) && d.decidido_em) {
      for (const p of a.compras ?? []) if (p > d.decidido_em) m.contradicoes.push({ sku: i.sku, destino: d.destino, pedido_em: p });
    }
  }
  m.caixa_liberado = m.vendido + m.liquidado + m.trocado;
  return m;
}
