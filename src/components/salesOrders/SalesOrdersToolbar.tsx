// Toolbar da listagem de pedidos: ações + filtro de empresa + busca.
// Extraída verbatim de src/pages/SalesOrders.tsx (god-component split).
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Plus, Package, Printer, Building2, Search } from 'lucide-react';
import { type Account } from './types';

interface SalesOrdersToolbarProps {
  onNavigate: (path: string) => void;
  accountFilter: Account;
  setAccountFilter: (a: Account) => void;
  search: string;
  setSearch: (v: string) => void;
}

export function SalesOrdersToolbar({
  onNavigate,
  accountFilter,
  setAccountFilter,
  search,
  setSearch,
}: SalesOrdersToolbarProps) {
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
          placeholder="Buscar por cliente, nº pedido ou item..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>
    </>
  );
}
