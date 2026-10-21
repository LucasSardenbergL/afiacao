// Borda da RPC `fin_consolidado_intercompany` → linhas do "DRE Consolidado" da tela Intercompany.
//
// O cast antigo (`cons as unknown as ConsolidadoRow[]`) afirmava as colunas {dre_linha, valor_bruto,
// eliminacoes, valor_liquido}; a RPC devolve {conta, total_bruto, eliminacoes, total_consolidado} desde a
// v2 (migration 20260518004300). A tela lia `undefined` e quebrava ao formatar.
//
// Dois cuidados de money-path ao voltar a exibir:
//  1. A RPC soma com COALESCE(SUM(...), 0): mês sem snapshot de NENHUMA empresa sai como 4 linhas de zero.
//     Por isso a cobertura vem dos snapshots do mês (lidos à parte pela tela): zero empresas ⇒ não há
//     consolidado (ausente ≠ zero); menos que todas ⇒ soma PARCIAL, dita na tela.
//  2. CMV é gravado POSITIVO nos snapshots (prod 2026-10-20: 91 linhas > 0, 23 = 0, nenhuma < 0), e a RPC
//     SOMA a eliminação intercompany ao CMV (`cmv` → +valor_elim) — o consolidado do CMV sai inflado em vez de
//     reduzido. Até a RPC ser corrigida, a eliminação e o líquido do CMV ficam `null` ("—") quando há
//     eliminação; sem eliminação, o líquido é o próprio bruto e segue exibido.
import type { Database } from '@/integrations/supabase/types';

type LinhaRpc = Database['public']['Functions']['fin_consolidado_intercompany']['Returns'][number];

export type LinhaConsolidado = {
  conta: string;
  bruto: number;
  /** `null` = valor conhecido como errado na RPC (ver cabeçalho) — exibir "—", nunca um número. */
  eliminacoes: number | null;
  consolidado: number | null;
};

export function paraLinhasConsolidado(linhas: readonly LinhaRpc[]): LinhaConsolidado[] {
  return linhas.map((l) => {
    const cmvComEliminacao = l.conta === 'cmv' && l.eliminacoes !== 0;
    return {
      conta: l.conta,
      bruto: l.total_bruto,
      eliminacoes: cmvComEliminacao ? null : l.eliminacoes,
      consolidado: cmvComEliminacao ? null : l.total_consolidado,
    };
  });
}

/** Empresas sem snapshot de competência no mês (cobertura do consolidado). */
export function empresasSemSnapshot<C extends string>(todas: readonly C[], comSnapshot: readonly string[]): C[] {
  const tem = new Set(comSnapshot);
  return todas.filter((c) => !tem.has(c));
}
