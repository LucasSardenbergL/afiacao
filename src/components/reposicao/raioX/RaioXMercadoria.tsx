import type { DecisaoRow, ItemRaioX } from '@/lib/reposicao/raio-x/tipos';
import { RaioXLista } from './RaioXLista';
import { colValor, rotuloDestino, textoVenda, type Coluna } from './RaioXLinha';

const colunas: Coluna[] = [
  colValor,
  { titulo: 'Saldo', className: 'text-right', render: (i) => `${i.saldo} ${i.unidade_estoque ?? ''}`.trim() },
  { titulo: 'Venda 12m', render: (i) => textoVenda(i) },
  { titulo: 'Fornecedor', render: (i, d) => d?.fornecedor_informado || i.fornecedor || '—' },
  {
    titulo: 'Destino',
    render: (i, d) => {
      const r = rotuloDestino(i, d);
      return <span className={r.decidido ? 'text-status-success' : 'text-muted-foreground'} title={i.motivo_destino}>{r.texto}</span>;
    },
  },
];

/** Segmento 1: mercadoria parada, por R$. Somente leitura (decidir é o PR 3). */
export function RaioXMercadoria({ itens, decisoes }: { itens: ItemRaioX[]; decisoes: Map<number, DecisaoRow> }) {
  return <RaioXLista itens={itens} decisoes={decisoes} colunas={colunas} />;
}
