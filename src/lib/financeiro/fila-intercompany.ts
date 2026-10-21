// Ações da fila de reconciliação intercompany (/financeiro/intercompany/fila) por linha de fin_ic_matches.
//
// Venda intragrupo SEM COBRANÇA (migration 20261021190000, docs/historico/consolidado-ic-venda-sem-cobranca.md):
// um CP intragrupo sem CR do vendedor porque o founder decidiu não cobrar. Marcado, o DRE consolidado o
// elimina só do CMV do destino. O trigger do banco é quem governa (só master, só a partir de
// `sem_contrapartida` CP-only); esta função só decide o que a tela OFERECE, para não oferecer o que o banco
// recusa nem o que só gera pendência:
//  • "Aprovar" (manual_matched) só em linha com os DOIS lados — confirmar um lado só deixa o mês inteiro
//    como "eliminação pendente" no consolidado.
//  • "Sem cobrança" só para o master, em `sem_contrapartida` com CP e sem CR.
//  • "Desfazer" só para o master, na linha marcada; ela volta a `sem_contrapartida` e a próxima rodada do
//    fin-ic-reconcile a refaz (pode casar o CP com um CR que tenha aparecido).
export type AcaoFilaIc = 'aprovar' | 'ignorar' | 'sem_cobranca' | 'desfazer_sem_cobranca';

export type LinhaFilaIc = { status: string; cr_id: string | null; cp_id: string | null };

const STATUS_SEM_COBRANCA = 'intragrupo_sem_cobranca';

export function acoesDaLinhaIc(linha: LinhaFilaIc, isMaster: boolean): AcaoFilaIc[] {
  if (linha.status === 'manual_matched' || linha.status === 'desconsiderado') return [];
  if (linha.status === STATUS_SEM_COBRANCA) return isMaster ? ['desfazer_sem_cobranca'] : [];
  const doisLados = linha.cr_id !== null && linha.cp_id !== null;
  const acoes: AcaoFilaIc[] = doisLados ? ['aprovar', 'ignorar'] : ['ignorar'];
  if (isMaster && linha.status === 'sem_contrapartida' && linha.cr_id === null && linha.cp_id !== null) {
    acoes.push('sem_cobranca');
  }
  return acoes;
}
