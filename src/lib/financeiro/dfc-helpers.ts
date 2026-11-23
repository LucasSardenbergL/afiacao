// DFC realizado (método direto) — monta o demonstrativo a partir de `v_fin_fluxo_caixa_realizado`.
// Política IFRS 18 / CPC 03 revisado: juros e parcela de empréstimo PAGOS em financiamento; juros e
// rendimentos RECEBIDOS em investimento; parcelamento de tributo em operacional (linha própria).
// A view já deduplica a ótica bancária e força transferência pela origem; aqui só se organiza.
// Regra money-path: mês sem linha é AUSÊNCIA de movimento registrado, não "R$ 0 conferido" — a tela
// diz que o saldo é o contábil do ERP. `pendente_identidade` e `nao_classificado` ficam VISÍVEIS e
// fora das três atividades (somá-los a uma delas afirmaria uma classificação que ninguém fez).

export type LinhaViewDFC = {
  company: string;
  mes: string; // 'YYYY-MM-01'
  fluxo_linha: string;
  atividade: string;
  entradas: number;
  saidas: number;
  liquido: number;
  lancamentos: number;
};

export type Atividade = 'operacional' | 'investimento' | 'financiamento';
export const ATIVIDADES: readonly Atividade[] = ['operacional', 'investimento', 'financiamento'];
export const ROTULO_ATIVIDADE: Record<Atividade, string> = {
  operacional: 'Atividades operacionais',
  investimento: 'Atividades de investimento',
  financiamento: 'Atividades de financiamento',
};

// Ordem do demonstrativo e rótulos. Linha que a view devolver e não estiver aqui entra no fim da
// atividade dela com o código cru — nunca some.
export const ROTULO_LINHA: Record<string, string> = {
  op_recebimento_clientes: 'Recebimentos de clientes',
  op_outros_recebimentos: 'Outros recebimentos',
  op_fornecedores: 'Pagamentos a fornecedores',
  op_pessoal: 'Pessoal e encargos',
  op_impostos: 'Tributos',
  op_impostos_parcelamento: 'Parcelamento de tributos',
  op_despesas: 'Despesas operacionais',
  op_tarifas_bancarias: 'Tarifas bancárias',
  op_adiantamentos: 'Adiantamentos',
  inv_imobilizado: 'Compra de imobilizado',
  inv_venda_ativo: 'Venda de ativos',
  inv_aplicacoes: 'Aplicações e resgates',
  inv_rendimentos: 'Juros e rendimentos recebidos',
  fin_captacao: 'Captação de empréstimos',
  fin_amortizacao: 'Pagamento de empréstimos (principal + juros)',
  fin_juros: 'Juros pagos',
  fin_aporte: 'Aporte de capital',
  fin_distribuicao: 'Distribuição de lucros',
  fin_intercompany: 'Mútuo entre empresas do grupo',
};
const ORDEM_LINHA = Object.keys(ROTULO_LINHA);

export type LinhaDFC = { linha: string; rotulo: string; porMes: Record<string, number>; total: number };
export type BlocoDFC = { atividade: Atividade; rotulo: string; linhas: LinhaDFC[]; porMes: Record<string, number>; total: number };
export type ForaDasAtividades = { porMes: Record<string, number>; total: number; entradas: number; saidas: number; lancamentos: number };

export type DFC = {
  meses: string[];
  blocos: BlocoDFC[];
  /** Σ das três atividades por mês — a variação de caixa explicada pelo demonstrativo. */
  variacao: { porMes: Record<string, number>; total: number };
  transferencias: ForaDasAtividades;
  pendenteIdentidade: ForaDasAtividades;
  naoClassificado: ForaDasAtividades;
};

const soma = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
const arred = (v: number) => Math.round(v * 100) / 100;

function vazioFora(): ForaDasAtividades {
  return { porMes: {}, total: 0, entradas: 0, saidas: 0, lancamentos: 0 };
}

function acumularFora(acc: ForaDasAtividades, r: LinhaViewDFC) {
  acc.porMes[r.mes] = arred((acc.porMes[r.mes] ?? 0) + r.liquido);
  acc.total = arred(acc.total + r.liquido);
  acc.entradas = arred(acc.entradas + r.entradas);
  acc.saidas = arred(acc.saidas + r.saidas);
  acc.lancamentos += r.lancamentos;
}

/**
 * Agrega as linhas da view (uma ou várias empresas — o caixa de cada CNPJ não é fungível, então o
 * consolidado é só soma de exibição) nos meses pedidos. `meses` define as colunas: mês sem movimento
 * fica ausente no `porMes` (a tela mostra "—", não 0).
 */
export function montarDFC(rows: LinhaViewDFC[], meses: string[]): DFC {
  const dentro = new Set(meses);
  const porLinha = new Map<string, LinhaDFC & { atividade: Atividade }>();
  const transferencias = vazioFora();
  const pendenteIdentidade = vazioFora();
  const naoClassificado = vazioFora();

  for (const r of rows) {
    if (!dentro.has(r.mes)) continue;
    if (r.fluxo_linha === 'transferencia_interna') { acumularFora(transferencias, r); continue; }
    if (r.fluxo_linha === 'pendente_identidade') { acumularFora(pendenteIdentidade, r); continue; }
    if (!(ATIVIDADES as readonly string[]).includes(r.atividade)) { acumularFora(naoClassificado, r); continue; }
    const atividade = r.atividade as Atividade;
    const item = porLinha.get(r.fluxo_linha) ?? { linha: r.fluxo_linha, rotulo: ROTULO_LINHA[r.fluxo_linha] ?? r.fluxo_linha, porMes: {}, total: 0, atividade };
    item.porMes[r.mes] = arred((item.porMes[r.mes] ?? 0) + r.liquido);
    item.total = arred(item.total + r.liquido);
    porLinha.set(r.fluxo_linha, item);
  }

  const ordem = (l: string) => { const i = ORDEM_LINHA.indexOf(l); return i === -1 ? ORDEM_LINHA.length : i; };
  const blocos: BlocoDFC[] = ATIVIDADES.map((atividade) => {
    const linhas = [...porLinha.values()]
      .filter((l) => l.atividade === atividade)
      .sort((a, b) => ordem(a.linha) - ordem(b.linha) || a.linha.localeCompare(b.linha))
      .map(({ atividade: _a, ...l }) => l);
    const porMes: Record<string, number> = {};
    for (const l of linhas) for (const [m, v] of Object.entries(l.porMes)) porMes[m] = arred((porMes[m] ?? 0) + v);
    return { atividade, rotulo: ROTULO_ATIVIDADE[atividade], linhas, porMes, total: arred(soma(porMes)) };
  });

  const variacaoPorMes: Record<string, number> = {};
  for (const b of blocos) for (const [m, v] of Object.entries(b.porMes)) variacaoPorMes[m] = arred((variacaoPorMes[m] ?? 0) + v);

  return {
    meses,
    blocos,
    variacao: { porMes: variacaoPorMes, total: arred(soma(variacaoPorMes)) },
    transferencias,
    pendenteIdentidade,
    naoClassificado,
  };
}

/** Os `n` meses FECHADOS anteriores a `hojeISO` ('YYYY-MM-DD'), em ordem crescente, como 'YYYY-MM-01'. */
export function mesesFechados(hojeISO: string, n: number): string[] {
  const [a, m] = hojeISO.split('-').map(Number);
  const out: string[] = [];
  for (let i = n; i >= 1; i--) {
    const d = new Date(Date.UTC(a, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`);
  }
  return out;
}
