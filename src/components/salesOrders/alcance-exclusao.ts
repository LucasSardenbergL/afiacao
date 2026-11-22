// Alcance da exclusão em lote (diálogo de /sales): quantos pedidos, de quais empresas, e quantos
// selecionados NÃO estão na lista atual (a seleção sobrevive à troca de busca/aba). Calculado ao
// ABRIR o diálogo, não a cada render da lista.
import { rotuloEmpresa, type OrderFeedRow } from './types';

export interface AlcanceExclusao {
  total: number;
  porEmpresa: [string, number][];
  foraDaTela: number;
}
export const ALCANCE_VAZIO: AlcanceExclusao = { total: 0, porEmpresa: [], foraDaTela: 0 };

export function alcanceDaExclusao(selecionadas: OrderFeedRow[], naTela: OrderFeedRow[]): AlcanceExclusao {
  const visiveis = new Set(naTela.filter((o) => o.origin === 'sales').map((o) => o.id));
  const contagem = new Map<string, number>();
  for (const o of selecionadas) {
    const empresa = rotuloEmpresa(o.account);
    contagem.set(empresa, (contagem.get(empresa) ?? 0) + 1);
  }
  return {
    total: selecionadas.length,
    porEmpresa: [...contagem.entries()],
    foraDaTela: selecionadas.filter((o) => !visiveis.has(o.id)).length,
  };
}
