// Busca de produto para adicionar ao pedido.
// Extraída verbatim de src/pages/SalesOrderEdit.tsx (god-component split).
import { Input } from '@/components/ui/input';
import { Search } from 'lucide-react';
import { type OmieProduct } from './types';

interface AddProductSearchProps {
  productSearch: string;
  setProductSearch: (v: string) => void;
  filteredProducts: OmieProduct[];
  onAddProduct: (p: OmieProduct) => void;
}

export function AddProductSearch({ productSearch, setProductSearch, filteredProducts, onAddProduct }: AddProductSearchProps) {
  return (
    <div className="border rounded-lg p-3 bg-muted/30 space-y-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Buscar produto por nome ou código..."
          value={productSearch}
          onChange={(e) => setProductSearch(e.target.value)}
          className="pl-8 h-8 text-sm"
          autoFocus
        />
      </div>
      {filteredProducts.length > 0 && (
        <div className="max-h-48 overflow-y-auto space-y-1">
          {filteredProducts.map((p) => (
            <button
              key={p.id}
              onClick={() => onAddProduct(p)}
              className="w-full text-left px-2 py-1.5 rounded hover:bg-accent text-sm flex items-center justify-between gap-2"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium text-wrap break-words">{p.descricao}</p>
                <p className="text-xs text-muted-foreground">{p.codigo} • {p.unidade} • Estoque: <span className={p.estoque > 0 ? 'text-green-600 font-medium' : 'text-red-500 font-medium'}>{p.estoque ?? 0}</span></p>
              </div>
              <span className="text-xs font-medium shrink-0">
                R$ {(p.valor_unitario || 0).toFixed(2)}
              </span>
            </button>
          ))}
        </div>
      )}
      {productSearch.length >= 2 && filteredProducts.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-2">Nenhum produto encontrado</p>
      )}
      {productSearch.length < 2 && (
        <p className="text-xs text-muted-foreground text-center py-1">Digite pelo menos 2 caracteres</p>
      )}
    </div>
  );
}
