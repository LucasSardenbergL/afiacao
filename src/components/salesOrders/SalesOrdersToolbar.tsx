// Toolbar da listagem de pedidos: filtro de empresa + busca (as ações ficam em SalesOrdersAcoes).
// Extraída verbatim de src/pages/SalesOrders.tsx (god-component split).
import { useEffect, useRef, useState } from 'react';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Plus, Package, Printer, Search, Loader2 } from 'lucide-react';
import { type Account } from './types';

interface SalesOrdersToolbarProps {
  accountFilter: Account;
  setAccountFilter: (a: Account) => void;
  search: string;
  setSearch: (v: string) => void;
  /** Busca nova a caminho do servidor (a lista ainda mostra o resultado anterior). */
  buscando?: boolean;
}

export const BUSCA_DEBOUNCE_MS = 300;

export function SalesOrdersToolbar({
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
    <div className="flex flex-col gap-2 md:flex-row md:items-center">
      {/* 3 empresas reais + Todos. Afiação foi unificada em Colacor SC (módulo, não empresa);
          a linha preserva a tag "Afiação" pra distinção visual. */}
      <Tabs value={accountFilter} onValueChange={(v) => setAccountFilter(v as Account)} className="shrink-0">
        <TabsList className="w-full justify-start overflow-x-auto md:w-auto">
          <TabsTrigger value="all">Todos</TabsTrigger>
          <TabsTrigger value="oben">Oben</TabsTrigger>
          <TabsTrigger value="colacor">Colacor</TabsTrigger>
          <TabsTrigger value="colacor_sc">Colacor SC</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="relative flex-1 md:max-w-md md:ml-auto">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          type="search"
          aria-label="Buscar pedidos"
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
    </div>
  );
}

/** Ações da página (cabeçalho): criar pedido é a principal; catálogo e impressão em lote, secundárias. */
export function SalesOrdersAcoes({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => onNavigate('/sales/products')} className="gap-1.5">
        <Package className="w-4 h-4" />
        Catálogo
      </Button>
      <Button variant="outline" size="sm" onClick={() => onNavigate('/sales/print')} className="gap-1.5">
        <Printer className="w-4 h-4" />
        Imprimir
      </Button>
      <Button size="sm" onClick={() => onNavigate('/sales/new')} className="gap-1.5">
        <Plus className="w-4 h-4" />
        Novo pedido
      </Button>
    </div>
  );
}
