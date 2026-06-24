// Lista de clientes (segmentos, busca, filtros, tabela densa, scroll infinito).
// Extraído verbatim de src/pages/AdminCustomers.tsx (god-component split).
import { useState, useMemo, useEffect } from 'react';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Loader2, Search, User, ChevronRight, Filter, Users, Save, Bookmark, X as XIcon,
} from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useUrlState } from '@/hooks/useUrlState';
import { useCustomerSegments } from '@/hooks/useCustomerSegments';
import { decodeHtmlEntities } from '@/lib/format';
import { fmt, HEALTH_CLASSES, formatDocument } from './config';
import type { Customer, ClientScore } from './types';

export function CustomerListView({
  customers,
  scores,
  loading,
  total,
  isCarteira,
  onSelect,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  customers: Customer[];
  scores: Map<string, ClientScore>;
  loading: boolean;
  total: number;
  isCarteira: boolean;
  onSelect: (c: Customer) => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  const sentinelRef = useInfiniteScroll(onLoadMore, hasNextPage && !isFetchingNextPage);
  // Filtros sincronizados com URL (compartilhável, sobrevive a F5)
  const [urlState, setUrlState] = useUrlState({ search: '', health: 'all' });
  const searchQuery = urlState.search;
  const filterHealth = urlState.health;
  const setFilterHealth = (v: string) => setUrlState({ health: v });

  // O input de busca tem estado LOCAL e empurra pra URL com debounce: escrever
  // na URL a cada tecla (history.replace) re-renderizava todos os subscribers
  // do router — sidebar inteira (~60 itens), breadcrumbs, mobile nav — por
  // caractere digitado. A URL continua sendo a fonte da verdade do filtro.
  //
  // Os DOIS efeitos abaixo têm deps mínimas DE PROPÓSITO (cada um reage só ao
  // seu gatilho). Incluir urlState.search nas deps do 1º faria ele rodar
  // também quando a URL muda por FORA (segmento/limpar/back) e re-empurrar o
  // termo antigo do debounce, revertendo a ação externa por ~300ms.
  const [searchInput, setSearchInput] = useState(searchQuery);
  const debouncedInput = useDebouncedValue(searchInput, 300);
  useEffect(() => {
    // Digitação → URL: dispara SÓ quando o termo debounced muda.
    if (debouncedInput !== urlState.search) setUrlState({ search: debouncedInput });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedInput]);
  useEffect(() => {
    // URL → input (segmento aplicado, "limpar filtros", back/forward). O guard
    // contra debouncedInput evita sobrescrever digitação em andamento na
    // janela entre o debounce expirar e a URL atualizar.
    if (urlState.search !== debouncedInput) setSearchInput(urlState.search);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlState.search]);

  const { segments, save: saveSegment, remove: removeSegment } = useCustomerSegments();
  const [savingSegment, setSavingSegment] = useState(false);
  const [newSegmentName, setNewSegmentName] = useState('');

  const filtered = useMemo(() => {
    let result = customers;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(c =>
        c.name.toLowerCase().includes(q) ||
        c.document?.includes(q) ||
        c.email?.toLowerCase().includes(q)
      );
    }
    if (filterHealth !== 'all') {
      result = result.filter(c => {
        const score = scores.get(c.user_id);
        // sem_historico tem filtro próprio; nos filtros de SAÚDE ele NÃO entra (o badge dele é
        // "Sem histórico", não uma classe de saúde) — senão o filtro "Crítico" mentiria (achado /codex).
        if (filterHealth === 'sem_historico') return score?.sales_history_status === 'sem_historico';
        if (score?.sales_history_status === 'sem_historico') return false;
        return score?.health_class === filterHealth;
      });
    }
    return result;
  }, [customers, searchQuery, filterHealth, scores]);

  if (loading) {
    // PageSkeleton (não Loader2 full-page) — convenção §9; mesma troca feita
    // nas outras telas deste PR.
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Clientes</h1>
          <p className="text-sm text-muted-foreground">
            {`${total} ${isCarteira ? 'clientes na carteira' : 'clientes na base'}`}
          </p>
        </div>
      </div>

      {/* Segmentos salvos (chips) */}
      {(segments.length > 0 || savingSegment || (searchQuery || filterHealth !== 'all')) && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <Bookmark className="w-3 h-3" />
            Segmentos
          </span>
          {segments.map((seg) => (
            <span
              key={seg.id}
              className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-md text-xs bg-muted hover:bg-muted/70 border border-border"
            >
              <button
                type="button"
                onClick={() => setUrlState({ search: seg.filters.search ?? '', health: seg.filters.health ?? 'all' })}
                className="font-medium"
                title="Aplicar segmento"
              >
                {seg.name}
              </button>
              <button
                type="button"
                onClick={() => removeSegment(seg.id)}
                className="text-muted-foreground hover:text-destructive p-0.5"
                aria-label={`Remover segmento ${seg.name}`}
              >
                <XIcon className="w-3 h-3" />
              </button>
            </span>
          ))}
          {(searchQuery || filterHealth !== 'all') && !savingSegment && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5"
              onClick={() => setSavingSegment(true)}
            >
              <Save className="w-3 h-3" />
              Salvar como segmento
            </Button>
          )}
          {savingSegment && (
            <span className="inline-flex items-center gap-1.5">
              <Input
                placeholder="Nome do segmento"
                value={newSegmentName}
                autoFocus
                onChange={(e) => setNewSegmentName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newSegmentName.trim()) {
                    saveSegment(newSegmentName.trim(), { search: searchQuery, health: filterHealth });
                    setNewSegmentName('');
                    setSavingSegment(false);
                  } else if (e.key === 'Escape') {
                    setNewSegmentName('');
                    setSavingSegment(false);
                  }
                }}
                className="h-7 w-48 text-xs"
              />
              <Button
                size="sm"
                variant="default"
                className="h-7"
                disabled={!newSegmentName.trim()}
                onClick={() => {
                  saveSegment(newSegmentName.trim(), { search: searchQuery, health: filterHealth });
                  setNewSegmentName('');
                  setSavingSegment(false);
                }}
              >
                Salvar
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                onClick={() => {
                  setNewSegmentName('');
                  setSavingSegment(false);
                }}
              >
                Cancelar
              </Button>
            </span>
          )}
        </div>
      )}

      {/* Search + Filters */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome, CPF/CNPJ ou e-mail..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-9 gap-1.5">
              <Filter className="w-3.5 h-3.5" />
              Saúde
              {filterHealth !== 'all' && (
                <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1">
                  {filterHealth === 'sem_historico' ? 'Sem histórico' : HEALTH_CLASSES[filterHealth]?.label}
                </Badge>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setFilterHealth('all')}>Todos</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setFilterHealth('saudavel')}>🟢 Saudável</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setFilterHealth('estavel')}>🔵 Estável</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setFilterHealth('atencao')}>🟡 Atenção</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setFilterHealth('critico')}>🔴 Crítico</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setFilterHealth('sem_historico')}>⚪ Sem histórico</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Dense Table */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Cliente</th>
                <th className="text-left px-3 py-2.5 font-medium text-muted-foreground hidden md:table-cell">Documento</th>
                <th className="text-center px-3 py-2.5 font-medium text-muted-foreground">Saúde</th>
                <th className="text-right px-3 py-2.5 font-medium text-muted-foreground hidden lg:table-cell">Gasto mensal</th>
                <th className="text-center px-3 py-2.5 font-medium text-muted-foreground hidden lg:table-cell">Dias s/ compra</th>
                <th className="text-right px-3 py-2.5 font-medium text-muted-foreground hidden md:table-cell">Prioridade</th>
                <th className="w-10 px-2"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((customer) => {
                const score = scores.get(customer.user_id);
                const healthInfo = score ? HEALTH_CLASSES[score.health_class] : undefined;
                const isSemHistorico = score?.sales_history_status === 'sem_historico';

                return (
                  <tr
                    key={customer.user_id}
                    className="border-b last:border-b-0 hover:bg-muted/30 cursor-pointer transition-colors"
                    onClick={() => onSelect(customer)}
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                          <User className="w-4 h-4 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium truncate text-foreground flex items-center gap-1.5">
                            <span className="truncate">{decodeHtmlEntities(customer.name)}</span>
                            {customer.coberto_de && (
                              <Badge variant="outline" className="text-[10px] shrink-0 text-status-info border-status-info/40">
                                cobertura
                              </Badge>
                            )}
                          </p>
                          {customer.phone && (
                            <p className="text-xs text-muted-foreground">{customer.phone}</p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 hidden md:table-cell">
                      <span className="text-xs text-muted-foreground font-mono">
                        {formatDocument(customer.document)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {isSemHistorico ? (
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">Sem histórico</Badge>
                      ) : (
                        <Badge variant="outline" className={cn('text-[10px]', healthInfo?.className)}>
                          {healthInfo?.label || 'N/A'}
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right hidden lg:table-cell">
                      <span className="text-xs font-medium tabular-nums">
                        {score ? fmt(score.avg_monthly_spend_180d) : '-'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-center hidden lg:table-cell">
                      {score?.days_since_last_purchase != null ? (
                        <span className={cn(
                          'text-xs font-medium tabular-nums',
                          score.days_since_last_purchase > 60 ? 'text-status-error' :
                          score.days_since_last_purchase > 30 ? 'text-status-warning' :
                          'text-muted-foreground'
                        )}>
                          {score.days_since_last_purchase}d
                        </span>
                      ) : '-'}
                    </td>
                    <td className="px-3 py-2.5 text-right hidden md:table-cell">
                      {score ? (
                        <span className="text-xs font-semibold tabular-nums">{score.priority_score.toFixed(1)}</span>
                      ) : '-'}
                    </td>
                    <td className="px-2 py-2.5">
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {filtered.length === 0 && (
          <EmptyState
            icon={searchQuery || filterHealth !== 'all' ? Search : Users}
            title={searchQuery || filterHealth !== 'all' ? 'Nenhum cliente com esses filtros' : 'Nenhum cliente na carteira'}
            description={
              searchQuery || filterHealth !== 'all'
                ? 'Tente buscar por nome, CNPJ ou e-mail; ou trocar o filtro de saúde.'
                : 'Quando um cliente for cadastrado ele vai aparecer aqui automaticamente.'
            }
            actionLabel={searchQuery || filterHealth !== 'all' ? 'Limpar filtros' : undefined}
            onAction={searchQuery || filterHealth !== 'all' ? () => setUrlState({ search: '', health: 'all' }) : undefined}
          />
        )}

        {/* Infinite scroll sentinel + fallback botão */}
        {hasNextPage && (
          <div ref={sentinelRef} className="py-4 flex justify-center border-t">
            {isFetchingNextPage ? (
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            ) : (
              <Button variant="outline" size="sm" onClick={onLoadMore}>
                Carregar mais
              </Button>
            )}
          </div>
        )}
        {!hasNextPage && customers.length > 0 && !isCarteira && (
          <p className="text-center text-xs text-muted-foreground py-4 border-t">
            Todos os clientes carregados ({total})
          </p>
        )}
      </Card>
    </div>
  );
}
