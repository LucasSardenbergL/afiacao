// Toolbar da listagem de pedidos: empresa + busca; status, período e ordem (as ações ficam em SalesOrdersAcoes).
// Extraída verbatim de src/pages/SalesOrders.tsx (god-component split).
import { useEffect, useRef, useState } from 'react';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Plus, Package, Printer, Search, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type Account } from './types';
import type { FiltroStatusFeed, OrdemFeed, PeriodoFeed } from './feed';

/** Chips de status, na ordem da tela. "Rascunhos" vem em destaque: é o que ainda pede ação. */
const CHIPS_STATUS: readonly { valor: FiltroStatusFeed; rotulo: string; destaque?: boolean }[] = [
  { valor: 'todos', rotulo: 'Todos' },
  { valor: 'rascunhos', rotulo: 'Rascunhos', destaque: true },
  { valor: 'em_andamento', rotulo: 'Em andamento' },
  { valor: 'faturados', rotulo: 'Faturados' },
  { valor: 'cancelados', rotulo: 'Cancelados' },
];

const ROTULO_PERIODO: Record<PeriodoFeed, string> = {
  tudo: 'Todo o período',
  hoje: 'Hoje',
  '7d': 'Últimos 7 dias',
  '30d': 'Últimos 30 dias',
};

const ROTULO_ORDEM: Record<OrdemFeed, string> = {
  recentes: 'Mais recentes',
  valor: 'Maior valor',
};

interface SalesOrdersToolbarProps {
  accountFilter: Account;
  setAccountFilter: (a: Account) => void;
  statusFilter: FiltroStatusFeed;
  setStatusFilter: (s: FiltroStatusFeed) => void;
  periodo: PeriodoFeed;
  setPeriodo: (p: PeriodoFeed) => void;
  ordem: OrdemFeed;
  setOrdem: (o: OrdemFeed) => void;
  search: string;
  setSearch: (v: string) => void;
  /** Busca nova a caminho do servidor (a lista ainda mostra o resultado anterior). */
  buscando?: boolean;
}

export const BUSCA_DEBOUNCE_MS = 300;

export function SalesOrdersToolbar({
  accountFilter,
  setAccountFilter,
  statusFilter,
  setStatusFilter,
  periodo,
  setPeriodo,
  ordem,
  setOrdem,
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
    <div className="space-y-2">
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

    <div className="flex flex-col gap-2 md:flex-row md:items-center">
      <div role="group" aria-label="Filtrar por status" className="flex flex-wrap items-center gap-1.5">
        {CHIPS_STATUS.map((chip) => {
          const ativo = statusFilter === chip.valor;
          return (
            <button
              key={chip.valor}
              type="button"
              aria-pressed={ativo}
              onClick={() => setStatusFilter(chip.valor)}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors',
                ativo
                  ? 'border-foreground/20 bg-foreground text-background'
                  : 'bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
                chip.destaque && !ativo && 'border-status-warning/40 text-status-warning hover:text-status-warning',
              )}
            >
              {chip.destaque && <span className="h-1.5 w-1.5 rounded-full bg-status-warning" aria-hidden />}
              {chip.rotulo}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2 md:ml-auto">
        <Select value={periodo} onValueChange={(v) => setPeriodo(v as PeriodoFeed)}>
          <SelectTrigger aria-label="Período" className="h-8 w-[9.5rem] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(ROTULO_PERIODO) as PeriodoFeed[]).map((p) => (
              <SelectItem key={p} value={p}>{ROTULO_PERIODO[p]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={ordem} onValueChange={(v) => setOrdem(v as OrdemFeed)}>
          <SelectTrigger aria-label="Ordenar por" className="h-8 w-[8.5rem] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(ROTULO_ORDEM) as OrdemFeed[]).map((o) => (
              <SelectItem key={o} value={o}>{ROTULO_ORDEM[o]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
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
