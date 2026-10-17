import type { DecisaoRow, ItemRaioX } from '@/lib/reposicao/raio-x/tipos';
import { useIsTouchDevice } from '@/hooks/useIsTouchDevice';
import { CartaoItem, LinhaTabela, type Coluna } from './RaioXLinha';

/** Tabela no desktop; cards em `pointer:coarse`. */
export function RaioXLista({ itens, decisoes, colunas }: { itens: ItemRaioX[]; decisoes: Map<number, DecisaoRow>; colunas: Coluna[] }) {
  const touch = useIsTouchDevice();
  if (touch) {
    return (
      <ul className="space-y-2">
        {itens.map((i) => <CartaoItem key={i.sku_codigo_omie} item={i} decisao={decisoes.get(i.sku_codigo_omie)} colunas={colunas} />)}
      </ul>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="p-2 font-medium">SKU</th>
            {colunas.map((c) => <th key={c.titulo} className={`p-2 font-medium ${c.className ?? ''}`}>{c.titulo}</th>)}
          </tr>
        </thead>
        <tbody>
          {itens.map((i) => <LinhaTabela key={i.sku_codigo_omie} item={i} decisao={decisoes.get(i.sku_codigo_omie)} colunas={colunas} />)}
        </tbody>
      </table>
    </div>
  );
}
