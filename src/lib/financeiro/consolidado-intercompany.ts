// Borda da RPC `fin_consolidado_intercompany` → linhas do "DRE Consolidado" da tela Intercompany.
//
// O cast antigo (`cons as unknown as ConsolidadoRow[]`) afirmava as colunas {dre_linha, valor_bruto,
// eliminacoes, valor_liquido}; a RPC devolve {conta, total_bruto, eliminacoes, total_consolidado} desde a
// v2 (migration 20260518004300). A tela lia `undefined` e quebrava ao formatar.
//
// Contrato desde a migration 20261021120000 (ver docs/historico/consolidado-ic-sinal-cmv.md):
//  • Receita e CMV caem pelo MESMO valor eliminado (antes o CMV subia — o sinal estava trocado e a tela
//    escondia o CMV consolidado com "—"). Despesas e resultado: eliminação 0.
//  • `total_bruto` NULL = conta sem snapshot no mês (ausente ≠ zero; antes era COALESCE → 0).
//  • `eliminacoes`/`total_consolidado` NULL nas 4 linhas = eliminação PENDENTE: há par intercompany
//    confirmado que não dá para eliminar (sem contrapartida, valor divergente, CP em outro mês, categoria
//    fora de receita/CMV...). A tela mostra "—" e diz por quê; nunca um número.
// Os tipos gerados dizem `number` para as colunas de RETURNS TABLE, mas o banco devolve NULL: a entrada
// aceita qualquer JSON nas colunas de valor e lê com leitor anulável, que recusa string/NaN.
import type { Json } from '@/integrations/supabase/types';
import { anulavel, numero } from '@/lib/financeiro/borda-json';

type ValorBanco = Json | undefined;
export type LinhaRpcConsolidado = {
  conta: string;
  total_bruto: ValorBanco;
  eliminacoes: ValorBanco;
  total_consolidado: ValorBanco;
};

export type LinhaConsolidado = {
  conta: string;
  /** `null` = conta sem snapshot no mês — exibir "—". */
  bruto: number | null;
  /** `null` = eliminação pendente (ver cabeçalho) — exibir "—", nunca um número. */
  eliminacoes: number | null;
  consolidado: number | null;
};

const numeroOuNulo = anulavel(numero);

export function paraLinhasConsolidado(linhas: readonly LinhaRpcConsolidado[]): LinhaConsolidado[] {
  return linhas.map((l, i) => ({
    conta: l.conta,
    bruto: numeroOuNulo(l.total_bruto, `consolidado[${i}].total_bruto`),
    eliminacoes: numeroOuNulo(l.eliminacoes, `consolidado[${i}].eliminacoes`),
    consolidado: numeroOuNulo(l.total_consolidado, `consolidado[${i}].total_consolidado`),
  }));
}

/** Há par intercompany confirmado que a RPC não conseguiu eliminar: o consolidado do mês é desconhecido. */
export function eliminacaoPendente(linhas: readonly LinhaConsolidado[]): boolean {
  return linhas.some((l) => l.eliminacoes === null);
}

/** Empresas sem snapshot de competência no mês (cobertura do consolidado). */
export function empresasSemSnapshot<C extends string>(todas: readonly C[], comSnapshot: readonly string[]): C[] {
  const tem = new Set(comSnapshot);
  return todas.filter((c) => !tem.has(c));
}

/**
 * O que a tela pode mostrar do consolidado. `semSnapshot` null = a leitura da cobertura falhou: sem saber
 * quais empresas estão na soma, os valores NÃO aparecem (achado Codex adversarial; a RPC já devolve NULL
 * no mês sem snapshot, e este gate segue como 2ª camada). Nenhuma empresa com DRE no mês também esconde;
 * parte delas exibe com aviso de soma parcial.
 */
export function exibicaoConsolidado(
  linhas: number,
  semSnapshot: readonly string[] | null,
  totalEmpresas: number,
): 'nada' | 'indisponivel' | 'parcial' | 'completo' {
  if (linhas === 0) return 'nada';
  if (semSnapshot === null) return 'indisponivel';
  if (semSnapshot.length >= totalEmpresas) return 'nada';
  return semSnapshot.length > 0 ? 'parcial' : 'completo';
}
