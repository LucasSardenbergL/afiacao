// Toolbar da listagem de pedidos: ações + filtro de empresa + busca.
// Extraída verbatim de src/pages/SalesOrders.tsx (god-component split).
import { useEffect, useRef, useState } from 'react';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Plus, Package, Printer, Building2, Search, Loader2 } from 'lucide-react';
import { type Account } from './types';

interface SalesOrdersToolbarProps {
  onNavigate: (path: string) => void;
  accountFilter: Account;
  setAccountFilter: (a: Account) => void;
  search: string;
  setSearch: (v: string) => void;
  /** Busca nova a caminho do servidor (a lista ainda mostra o resultado anterior). */
  buscando?: boolean;
}

export const BUSCA_DEBOUNCE_MS = 300;

export function SalesOrdersToolbar({
  onNavigate,
  accountFilter,
  setAccountFilter,
  search,
  setSearch,
  buscando = false,
}: SalesOrdersToolbarProps) {
  // O input é controlado por um rascunho LOCAL: cada tecla re-renderiza só a toolbar, e o termo
  // sobe (URL → query no servidor) quando a digitação pausa.
  const [rascunho, setRascunho] = useState(search);
  const atrasado = useDebouncedValue(rascunho, BUSCA_DEBOUNCE_MS);
  const atrasadoRef = useRef(atrasado);
  atrasadoRef.current = atrasado;
  useEffect(() => {
    if (atrasado !== search) setSearch(atrasado);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só a pausa da digitação sobe o termo
  }, [atrasado]);
  // Mudança de FORA (ex.: "Limpar filtros", voltar no histórico) reescreve o rascunho. A que nós
  // mesmos subimos chega igual ao `atrasado` e não mexe — senão apagaria o que foi digitado depois.
  useEffect(() => {
    if (search !== atrasadoRef.current) setRascunho(search);
  }, [search]);

  return (
    <>
      <div className="flex gap-2">
        <Button onClick={() => onNavigate('/sales/new')} className="gap-2 flex-1">
          <Plus className="w-4 h-4" />
          Novo Pedido
        </Button>
        <Button variant="outline" onClick={() => onNavigate('/sales/products')} className="gap-2">
          <Package className="w-4 h-4" />
          Catálogo
        </Button>
        <Button variant="outline" onClick={() => onNavigate('/sales/print')} className="gap-2">
          <Printer className="w-4 h-4" />
          Imprimir
        </Button>
      </div>

      {/* Account Filter — 3 empresas reais + Todos. Afiação foi unificada
          em Colacor SC (módulo, não empresa). Cada card preserva o badge
          "Afiação" quando _source='afiacao' pra distinção visual. */}
      <Tabs value={accountFilter} onValueChange={(v) => setAccountFilter(v as Account)}>
        <TabsList className="w-full grid grid-cols-4">
          <TabsTrigger value="all">Todos</TabsTrigger>
          <TabsTrigger value="oben" className="gap-1">
            <Building2 className="w-3 h-3" />
            Oben
          </TabsTrigger>
          <TabsTrigger value="colacor" className="gap-1">
            <Building2 className="w-3 h-3" />
            Colacor
          </TabsTrigger>
          <TabsTrigger value="colacor_sc" className="gap-1">
            <Building2 className="w-3 h-3" />
            Colacor SC
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Buscar por cliente, nº pedido, item ou valor..."
          value={rascunho}
          onChange={(e) => setRascunho(e.target.value)}
          className="pl-9 pr-9"
        />
        {buscando && (
          <Loader2
            aria-label="Buscando"
            className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground"
          />
        )}
      </div>
    </>
  );
}
