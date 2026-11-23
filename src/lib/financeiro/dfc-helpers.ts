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

type Atividade = 'operacional' | 'investimento' | 'financiamento';
const ATIVIDADES: readonly Atividade[] = ['operacional', 'investimento', 'financiamento'];
const ROTULO_ATIVIDADE: Record<Atividade, string> = {
  operacional: 'Atividades operacionais',
  investimento: 'Atividades de investimento',
  financiamento: 'Atividades de financiamento',
};

// Ordem do demonstrativo e rótulos. Linha que a view devolver e não estiver aqui entra no fim da
// atividade dela com o código cru — nunca some.
const ROTULO_LINHA: Record<string, string> = {
  op_recebimento_clientes: 'Recebimentos de clientes',
  op_outros_recebimentos: 'Outros recebimentos',
  op_fornecedores: 'Pagamentos a fornecedores',
  op_pessoal: 'Pessoal e encargos',
  op_impostos: 'Tributos sobre vendas e demais',
  op_impostos_lucro: 'IRPJ e CSLL',
  op_impostos_parcelamento: 'Parcelamento de tributos',
  op_despesas: 'Despesas operacionais',
  op_tarifas_bancarias: 'Tarifas bancárias',
  op_adiantamentos: 'Adiantamentos',
  inv_imobilizado: 'Compra de imobilizado',
  inv_venda_ativo: 'Venda de ativos',
  inv_aplicacoes: 'Aplicações e resgates',
  inv_rendimentos: 'Juros e rendimentos recebidos',
  fin_captacao: 'Captação de empréstimos',
  fin_amortizacao: 'Parcelas de empréstimo (principal + juros, sem abertura)',
  fin_juros: 'Juros pagos',
  fin_aporte: 'Aporte de capital',
  fin_distribuicao: 'Distribuição de lucros',
  fin_intercompany: 'Mútuo entre empresas do grupo',
};
const ORDEM_LINHA = Object.keys(ROTULO_LINHA);

type LinhaDFC = { linha: string; rotulo: string; porMes: Record<string, number>; total: number };
/** `total` null = nenhuma observação na janela (R$ 0 seria afirmar movimento conferido — Codex). */
type BlocoDFC = { atividade: Atividade; rotulo: string; linhas: LinhaDFC[]; porMes: Record<string, number>; total: number | null };
type ForaDasAtividades = { porMes: Record<string, number>; total: number; entradas: number; saidas: number; lancamentos: number };
type ItemFora = ForaDasAtividades & { linha: string; rotulo: string; explicacao: string };

// Fora das três atividades, na ordem da tela. Linha que não é op_/inv_/fin_ nem está aqui cai em
// `nao_classificado` (nunca some).
const FORA_DAS_ATIVIDADES: ReadonlyArray<{ linha: string; rotulo: string; explicacao: string }> = [
  { linha: 'transferencia_interna', rotulo: 'Transferências entre contas da empresa', explicacao: 'Saem e entram no mesmo CNPJ — não mudam o caixa da empresa.' },
  { linha: 'equivalente_caixa', rotulo: 'Aplicações de liquidez (equivalentes de caixa)', explicacao: 'Resgate ou aplicação de liquidez imediata — troca entre caixa e equivalente.' },
  { linha: 'pendente_identidade', rotulo: 'Pendente de identidade', explicacao: 'Baixa sem identificador do Omie igual a uma baixa já contada (provável versão antiga) — fora para não dobrar.' },
  { linha: 'pendente_revisao', rotulo: 'Pendente de revisão', explicacao: 'Baixa sem identificador num título que já tem outra baixa de valor diferente — pode ser parcela legítima; revise no Omie.' },
  { linha: 'nao_classificado', rotulo: 'Não classificado', explicacao: 'Categoria sem decisão no mapa de fluxo — entra aqui até alguém classificar.' },
];

export type DFC = {
  meses: string[];
  blocos: BlocoDFC[];
  /** Σ das três atividades por mês — a variação de caixa explicada pelo demonstrativo. */
  variacao: { porMes: Record<string, number>; total: number | null };
  /** false = a view não devolveu NENHUMA linha na janela (empresa sem espelho, ou leitura sem permissão). */
  temDados: boolean;
  /** Na ordem de FORA_DAS_ATIVIDADES; só os que tiveram movimento na janela. */
  fora: ItemFora[];
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
  const fora = new Map<string, ForaDasAtividades>();
  const conhecidosFora = new Set(FORA_DAS_ATIVIDADES.map((f) => f.linha));

  for (const r of rows) {
    if (!dentro.has(r.mes)) continue;
    if (!(ATIVIDADES as readonly string[]).includes(r.atividade)) {
      const chave = conhecidosFora.has(r.fluxo_linha) ? r.fluxo_linha : 'nao_classificado';
      const acc = fora.get(chave) ?? vazioFora();
      acumularFora(acc, r);
      fora.set(chave, acc);
      continue;
    }
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
    return { atividade, rotulo: ROTULO_ATIVIDADE[atividade], linhas, porMes, total: linhas.length > 0 ? arred(soma(porMes)) : null };
  });

  const variacaoPorMes: Record<string, number> = {};
  for (const b of blocos) for (const [m, v] of Object.entries(b.porMes)) variacaoPorMes[m] = arred((variacaoPorMes[m] ?? 0) + v);

  return {
    meses,
    blocos,
    variacao: { porMes: variacaoPorMes, total: Object.keys(variacaoPorMes).length > 0 ? arred(soma(variacaoPorMes)) : null },
    temDados: rows.some((r) => dentro.has(r.mes)),
    fora: FORA_DAS_ATIVIDADES.filter((f) => fora.has(f.linha)).map((f) => ({ ...f, ...fora.get(f.linha)! })),
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
