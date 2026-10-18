import { useMemo } from 'react';
import type { DecisaoRow, ItemRaioX } from '@/lib/reposicao/raio-x/tipos';
import { fornecedorEfetivo } from '@/lib/reposicao/raio-x/decisao';
import { RaioXLista } from './RaioXLista';
import { colDecidir, colValor, rotuloDestino, textoVenda, type Coluna } from './RaioXLinha';

const colunasBase: Coluna[] = [
  colValor,
  { titulo: 'Saldo', className: 'text-right', render: (i) => `${i.saldo} ${i.unidade_estoque ?? ''}`.trim() },
  { titulo: 'Venda 12m', render: (i) => textoVenda(i) },
  { titulo: 'Fornecedor', render: (i, d) => fornecedorEfetivo(i, d) ?? '—' },
  {
    titulo: 'Destino',
    render: (i, d) => {
      const r = rotuloDestino(i, d);
      return <span className={r.decidido ? 'text-status-success' : 'text-muted-foreground'} title={i.motivo_destino}>{r.texto}</span>;
    },
  },
];

/** Segmento 1: mercadoria parada, por R$. "Decidir" abre o Sheet de decisão. */
export function RaioXMercadoria({ itens, decisoes, onDecidir }: {
  itens: ItemRaioX[];
  decisoes: Map<number, DecisaoRow>;
  onDecidir: (i: ItemRaioX) => void;
}) {
  const colunas = useMemo(() => [...colunasBase, colDecidir(onDecidir)], [onDecidir]);
  return <RaioXLista itens={itens} decisoes={decisoes} colunas={colunas} />;
}
