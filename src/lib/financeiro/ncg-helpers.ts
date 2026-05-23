type CR = { saldo: number; status_titulo: string };
type CP = { saldo: number; status_titulo: string; categoria_codigo: string | null };

export type ClassificacaoCR = 'aco_cr_aberto' | 'nenhum';
export type ClassificacaoCP =
  | 'aco_adiantamento'
  | 'pco_cp_fornecedor'
  | 'pco_tributos'
  | 'nenhum';

export function classificarCR(cr: CR): ClassificacaoCR {
  const aberto = ['ABERTO', 'PARCIAL', 'VENCIDO'].includes(cr.status_titulo);
  if (aberto && cr.saldo > 0) return 'aco_cr_aberto';
  return 'nenhum';
}

export function classificarCP(
  cp: CP,
  adiantamento_codigos: string[],
): ClassificacaoCP {
  const aberto = ['ABERTO', 'PARCIAL', 'VENCIDO'].includes(cp.status_titulo);
  if (!aberto || cp.saldo <= 0) return 'nenhum';
  if (cp.categoria_codigo && adiantamento_codigos.includes(cp.categoria_codigo)) {
    return 'aco_adiantamento';
  }
  if (cp.categoria_codigo && cp.categoria_codigo.startsWith('3.99')) {
    return 'pco_tributos';
  }
  return 'pco_cp_fornecedor';
}

export type ACO = {
  cr_aberto: number;
  estoque: number;
  adiantamentos: number;
  total: number;
};

export type PCO = {
  cp_fornecedor: number;
  folha_30d: number;
  tributos_a_pagar: number;
  total: number;
};

export function calcularACO(input: {
  crs: CR[];
  cps: CP[];
  adiantamento_categorias_codigos: string[];
  estoque_valor: number;
}): ACO {
  let cr_aberto = 0;
  for (const cr of input.crs) {
    if (classificarCR(cr) === 'aco_cr_aberto') cr_aberto += cr.saldo;
  }
  let adiantamentos = 0;
  for (const cp of input.cps) {
    if (classificarCP(cp, input.adiantamento_categorias_codigos) === 'aco_adiantamento') {
      adiantamentos += cp.saldo;
    }
  }
  const total = cr_aberto + input.estoque_valor + adiantamentos;
  return { cr_aberto, estoque: input.estoque_valor, adiantamentos, total };
}

export function calcularPCO(input: {
  cps: CP[];
  adiantamento_categorias_codigos: string[];
  folha_30d: number;
}): PCO {
  let cp_fornecedor = 0;
  let tributos_a_pagar = 0;
  for (const cp of input.cps) {
    const c = classificarCP(cp, input.adiantamento_categorias_codigos);
    if (c === 'pco_cp_fornecedor') cp_fornecedor += cp.saldo;
    else if (c === 'pco_tributos') tributos_a_pagar += cp.saldo;
  }
  const total = cp_fornecedor + input.folha_30d + tributos_a_pagar;
  return { cp_fornecedor, folha_30d: input.folha_30d, tributos_a_pagar, total };
}

export function calcularPME(input: { estoque_valor: number; cmv_ttm: number }): number {
  if (input.cmv_ttm <= 0) return 0;
  return (input.estoque_valor / input.cmv_ttm) * 365;
}

export function calcularCCC(input: { pmr: number; pme: number; pmp: number }): number {
  return input.pmr + input.pme - input.pmp;
}
