// O que a IA fez com CADA item (PR 3.1 do Novo Pedido, "IA honesta").
//
// Até aqui o assistente anunciava "N item(ns) adicionado(s)" contando o que foi PEDIDO, inclusive o
// produto fora do catálogo e a ferramenta já no pedido, que não entravam; e a quantidade que a IA
// assumia (o `1` do default) chegava igual a uma quantidade dita pelo vendedor. Estes componentes
// mostram o desfecho por item com o motivo, e marcam a quantidade inferida.
import { Check, Plus, Palette, X, AlertTriangle } from 'lucide-react';
import type { AIDescartado, DesfechoItemIA, RelatorioAdicaoIA } from './types';

/** Selo de quantidade que o vendedor NÃO disse (a IA assumiu). */
export function SeloQuantidadeInferida({ inferida }: { inferida: boolean | undefined }) {
  // Ausente = inferida (fail-closed): só some com a prova de que o vendedor disse a quantidade.
  if (inferida === false) return null;
  return (
    <span
      className="text-[10px] font-medium text-status-warning border border-status-warning/40 rounded px-1.5 py-0.5"
      title="O pedido não dizia a quantidade: a IA assumiu. Confira antes de fechar."
      data-testid="selo-quantidade-inferida"
    >
      qtd inferida
    </span>
  );
}

const ROTULO: Record<DesfechoItemIA, string> = {
  adicionado: 'Adicionado',
  somado: 'Somado',
  cor: 'Escolher a cor',
  descartado: 'Não entrou',
};

const ICONE: Record<DesfechoItemIA, typeof Check> = {
  adicionado: Check,
  somado: Plus,
  cor: Palette,
  descartado: X,
};

const COR: Record<DesfechoItemIA, string> = {
  adicionado: 'text-status-success',
  somado: 'text-status-info',
  cor: 'text-status-info',
  descartado: 'text-status-error',
};

export function RelatorioAdicaoLista({ relatorio }: { relatorio: RelatorioAdicaoIA }) {
  if (relatorio.itens.length === 0) return null;
  return (
    <ul className="space-y-1.5" aria-label="Resultado por item">
      {relatorio.itens.map((item, idx) => {
        const Icone = ICONE[item.desfecho];
        return (
          <li key={idx} className="bg-background rounded-lg p-2.5 border border-border text-sm" data-desfecho={item.desfecho}>
            <div className="flex items-start gap-2">
              <Icone className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${COR[item.desfecho]}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className={`text-xs font-medium ${COR[item.desfecho]}`}>{ROTULO[item.desfecho]}</span>
                  <span className="truncate">{item.descricao}</span>
                  <span className="text-xs text-muted-foreground">· Qtd {item.quantidade}</span>
                  {item.desfecho !== 'descartado' && <SeloQuantidadeInferida inferida={item.quantidadeInferida} />}
                </div>
                {item.motivo && <p className="text-xs text-muted-foreground mt-0.5">{item.motivo}</p>}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** O que a EDGE recebeu da IA e não devolveu como item (ferramenta fora do cadastro, produto inexistente). */
export function DescartadosIALista({ itens }: { itens: AIDescartado[] }) {
  if (itens.length === 0) return null;
  return (
    <div className="space-y-1.5" aria-label="Itens que a IA não conseguiu usar">
      <p className="text-xs font-medium text-status-error flex items-center gap-1.5">
        <AlertTriangle className="w-3.5 h-3.5" /> Não usados ({itens.length})
      </p>
      {itens.map((d, idx) => (
        <div key={idx} className="bg-background rounded-lg p-2.5 border border-border text-sm">
          <p className="truncate">{d.descricao}</p>
          <p className="text-xs text-muted-foreground">{d.motivo}</p>
        </div>
      ))}
    </div>
  );
}
