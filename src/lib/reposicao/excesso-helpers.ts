/**
 * Fila de desova — excesso de estoque acima do `estoque_maximo` da política.
 *
 * O motor de reposição só COMPRA (dispara em estoque<=ponto e enche até o máximo); nada no app
 * media o caminho inverso — estoque ACIMA do próprio máximo. Medido em prod (2026-07-28, OBEN):
 * R$69,8k de capital excedente, dos quais ~R$24,5k a venda de 180d não digere. Este módulo é a
 * LEITURA dessa fila: helpers puros (vitest) consumidos por useExcessoEstoque.
 *
 * Regras money-path: cmc ausente ≠ zero (capital vira null + contagem separada, nunca R$0);
 * demanda <=0 não fabrica tempo de digestão (null = "sem giro", que é o caso MAIS estrutural).
 */

/** Acima deste tempo-para-digerir (dias corridos, pela demanda média 90d) o excesso é estrutural. */
export const LIMIAR_ESTRUTURAL_DIAS = 180;

/** Mapa canônico empresa→accounts do Omie (mesmo CASE da RPC gerar_pedidos_sugeridos_ciclo). */
export function accountsDaEmpresa(empresa: string): string[] {
  switch (empresa.toLowerCase()) {
    case "oben": return ["vendas", "oben"];
    case "colacor": return ["colacor_vendas", "colacor"];
    case "colacor_sc": return ["servicos", "colacor_sc"];
    default: return [empresa.toLowerCase()];
  }
}

export interface PosicaoEstoque {
  omie_codigo_produto: number;
  saldo: number | null;
  cmc: number | null;
  synced_at: string | null;
}

/**
 * 1 linha por SKU: a mais recente entre as accounts (o saldo OBEN vive em 'vendas' E 'oben',
 * quase-espelhos que podem divergir por SKU — mesmo DISTINCT ON ... synced_at DESC do motor).
 */
export function dedupePosicaoMaisRecente(rows: PosicaoEstoque[]): Map<number, PosicaoEstoque> {
  const porSku = new Map<number, PosicaoEstoque>();
  for (const r of rows) {
    const atual = porSku.get(r.omie_codigo_produto);
    if (!atual) { porSku.set(r.omie_codigo_produto, r); continue; }
    const tNovo = r.synced_at ? Date.parse(r.synced_at) : Number.NEGATIVE_INFINITY;
    const tAtual = atual.synced_at ? Date.parse(atual.synced_at) : Number.NEGATIVE_INFINITY;
    if (tNovo > tAtual) porSku.set(r.omie_codigo_produto, r);
  }
  return porSku;
}

export type SituacaoExcesso = "digerivel" | "estrutural" | "sem_giro";

export interface LinhaExcesso {
  excedenteUn: number;
  /** null = cmc ausente/zero (nunca fabrica R$0). */
  capitalExcedente: number | null;
  /** Dias corridos p/ a demanda média consumir o excedente; null = demanda <=0 (sem giro). */
  tempoDigerirDias: number | null;
  situacao: SituacaoExcesso;
}

/**
 * Excedente acima do máximo da política e o tempo que a demanda média leva para digeri-lo.
 * Devolve null quando NÃO há excesso (saldo <= máximo, ou dados insuficientes p/ afirmar excesso).
 */
export function calcularLinhaExcesso(args: {
  saldo: number | null;
  estoqueMaximo: number | null;
  demandaMediaDiaria: number | null;
  cmc: number | null;
}): LinhaExcesso | null {
  const { saldo, estoqueMaximo, demandaMediaDiaria, cmc } = args;
  if (saldo == null || estoqueMaximo == null) return null;
  if (!(Number.isFinite(saldo) && Number.isFinite(estoqueMaximo))) return null;
  const excedenteUn = saldo - estoqueMaximo;
  if (excedenteUn <= 0) return null;

  const capitalExcedente = cmc != null && cmc > 0 ? excedenteUn * cmc : null;

  const d = demandaMediaDiaria;
  const tempoDigerirDias = d != null && d > 0 ? Math.ceil(excedenteUn / d) : null;
  const situacao: SituacaoExcesso =
    tempoDigerirDias == null ? "sem_giro"
    : tempoDigerirDias > LIMIAR_ESTRUTURAL_DIAS ? "estrutural"
    : "digerivel";

  return { excedenteUn, capitalExcedente, tempoDigerirDias, situacao };
}

export interface KpisExcesso {
  capitalExcedenteRs: number;
  /** Parcela estrutural: sem giro OU tempo de digestão acima do limiar. */
  capitalEstruturalRs: number;
  skusN: number;
  estruturaisN: number;
  semCustoN: number;
}

export function somarKpisExcesso(
  linhas: Array<Pick<LinhaExcesso, "capitalExcedente" | "situacao">>,
): KpisExcesso {
  let capitalExcedenteRs = 0, capitalEstruturalRs = 0, estruturaisN = 0, semCustoN = 0;
  for (const l of linhas) {
    const estrutural = l.situacao !== "digerivel";
    if (estrutural) estruturaisN++;
    if (l.capitalExcedente == null) { semCustoN++; continue; }
    capitalExcedenteRs += l.capitalExcedente;
    if (estrutural) capitalEstruturalRs += l.capitalExcedente;
  }
  return { capitalExcedenteRs, capitalEstruturalRs, skusN: linhas.length, estruturaisN, semCustoN };
}

/** Ordena a fila por capital excedente desc; sem-custo (null) por último. Não muta a entrada. */
export function ordenarPorCapitalExcedente<T>(linhas: T[], capital: (l: T) => number | null): T[] {
  return [...linhas].sort((a, b) => (capital(b) ?? -1) - (capital(a) ?? -1));
}
