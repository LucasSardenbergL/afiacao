import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCrossSellEngine } from '@/hooks/useCrossSellEngine';
import { useAuth } from '@/contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import {
  Loader2, RefreshCw, ShoppingCart, ArrowUpRight,
  Users, Target, Search, ChevronDown, ChevronUp, Filter,
  Plus,
} from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// `fmt` (moeda) saiu junto com o EIP/LIE: esta página não exibe mais nenhum valor monetário
// derivado de custo — a priorização é por afinidade, e afinidade não é dinheiro.

const StockBadge = ({ estoque }: { estoque: number | null }) => {
  if (estoque === null || estoque === undefined) return null;
  if (estoque > 10) return <Badge variant="outline" className="text-[8px] bg-status-success-bg text-status-success-foreground border-status-success/20">Em estoque</Badge>;
  if (estoque > 0) return <Badge variant="outline" className="text-[8px] bg-status-warning-bg text-status-warning-foreground border-status-warning/20">Estoque baixo</Badge>;
  return <Badge variant="outline" className="text-[8px] bg-status-error-bg text-status-error-foreground border-status-error/20">Sem estoque</Badge>;
};

const FarmerRecommendations = () => {
  const navigate = useNavigate();
  const { isStaff, loading: authLoading } = useAuth();
  const {
    recommendations, loading, calculating, calculateRecommendations,
  } = useCrossSellEngine();
  const [expandedClient, setExpandedClient] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'cross_sell' | 'up_sell'>('all');

  useEffect(() => {
    if (!authLoading && isStaff) calculateRecommendations();
  }, [authLoading, isStaff]);

  if (authLoading || loading) {
    return (
      <PageSkeleton variant="list" />
    );
  }
  if (!isStaff) { navigate('/', { replace: true }); return null; }

  // "EIP Total" (soma dos LIE em R$) saiu: sem custo no browser não existe lucro esperado, e
  // formatar o score de afinidade como BRL seria fabricar número. O KPI vira o nº de clientes
  // com oferta na fila — que é o que a vendedora realmente aciona.
  const totalClientes = recommendations.length;
  const totalCrossSell = recommendations.reduce((s, cr) => s + cr.crossSell.length, 0);
  const totalUpSell = recommendations.reduce((s, cr) => s + cr.upSell.length, 0);

  const filtered = recommendations.filter(cr => {
    if (searchQuery) {
      return cr.customerName.toLowerCase().includes(searchQuery.toLowerCase());
    }
    return true;
  }).filter(cr => {
    if (filterType === 'cross_sell') return cr.crossSell.length > 0;
    if (filterType === 'up_sell') return cr.upSell.length > 0;
    return true;
  });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Recomendações</h1>
          <p className="text-sm text-muted-foreground">Cross-sell e up-sell priorizados por afinidade com o cliente</p>
        </div>
        <Button variant="outline" size="sm" onClick={calculateRecommendations} disabled={calculating} className="gap-1.5">
          {calculating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Recalcular
        </Button>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-3 gap-3">
        <Card><CardContent className="p-3 text-center">
          <Users className="w-4 h-4 mx-auto mb-1 text-primary" />
          <p className="text-lg font-bold text-primary">{totalClientes}</p>
          <p className="text-[10px] text-muted-foreground">Clientes com oferta</p>
        </CardContent></Card>
        <Card><CardContent className="p-3 text-center">
          <ShoppingCart className="w-4 h-4 mx-auto mb-1 text-status-info" />
          <p className="text-lg font-bold">{totalCrossSell}</p>
          <p className="text-[10px] text-muted-foreground">Cross-sell</p>
        </CardContent></Card>
        <Card><CardContent className="p-3 text-center">
          <ArrowUpRight className="w-4 h-4 mx-auto mb-1 text-status-purple" />
          <p className="text-lg font-bold">{totalUpSell}</p>
          <p className="text-[10px] text-muted-foreground">Up-sell</p>
        </CardContent></Card>
      </div>

      {/* A ressalva do #1514 continua valendo, e ficou MAIS forte: a taxa de conversão é
          ARBITRADA (15% cross-sell / 10% up-sell), não medida — o desfecho das recomendações
          nunca foi registrado. Só mudou o que se exibe: não há mais valor em R$ a ressalvar,
          porque o custo saiu do browser e o ranking passou a ser de AFINIDADE.
          Ver docs/historico/farmer-aprendizado-conversao.md */}
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        A ordem usa taxa de conversão fixa, ainda não calibrada com histórico real. Use-a para{' '}
        <strong className="font-medium">priorizar</strong> a fila — não como previsão de fechamento.
      </p>

      {/* Search + Filters */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Buscar cliente..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} className="pl-9 h-9" />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-9 gap-1.5">
              <Filter className="w-3.5 h-3.5" /> Tipo
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setFilterType('all')}>Todos</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setFilterType('cross_sell')}>Cross-sell</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setFilterType('up_sell')}>Up-sell</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Client List */}
      {filtered.length === 0 ? (
        <Card><CardContent className="py-12 text-center">
          <Target className="w-8 h-8 mx-auto mb-3 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            Nenhuma recomendação disponível. Calcule os scores dos clientes primeiro.
          </p>
        </CardContent></Card>
      ) : (
        filtered.map(cr => {
          // Melhor probabilidade da carteira do cliente (%), não soma de LIE em R$.
          const melhorProb = Math.max(0, ...[...cr.crossSell, ...cr.upSell].map((r) => r.pij));
          const isExpanded = expandedClient === cr.customerId;

          return (
            <Card key={cr.customerId} className="overflow-hidden">
              <div
                className="p-3 cursor-pointer hover:bg-muted/20 transition-colors"
                onClick={() => setExpandedClient(isExpanded ? null : cr.customerId)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5 flex-1 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <Target className="w-4 h-4 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{cr.customerName}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <Badge variant="outline" className="text-[10px]">
                          Health: {cr.healthScore.toFixed(0)}
                        </Badge>
                        {cr.crossSell.length > 0 && (
                          <Badge variant="outline" className="text-[10px]">
                            {cr.crossSell.length} Cross
                          </Badge>
                        )}
                        {cr.upSell.length > 0 && (
                          <Badge variant="outline" className="text-[10px]">
                            {cr.upSell.length} Up
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="text-right">
                      <p className="text-sm font-bold text-primary">{melhorProb.toFixed(1)}%</p>
                      <p className="text-[10px] text-muted-foreground">melhor conversão</p>
                    </div>
                    {isExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                  </div>
                </div>
              </div>

              {isExpanded && (
                <div className="border-t bg-muted/10 p-3 space-y-3">
                  {/* Cross-sell */}
                  {cr.crossSell.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold flex items-center gap-1 mb-2">
                        <ShoppingCart className="w-3.5 h-3.5 text-status-info" /> Cross-sell ({cr.crossSell.length})
                      </p>
                      <div className="space-y-2">
                        {cr.crossSell.map(rec => {
                          const outOfStock = rec.estoque !== null && rec.estoque === 0;
                          const canOrder = !!rec.customerId && !!rec.productId && !outOfStock;
                          return (
                          <Card key={rec.productId} className="border-l-4 border-l-status-info">
                            <CardContent className="p-3">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <p className="text-sm font-medium truncate">{rec.productName}</p>
                                    <StockBadge estoque={rec.estoque} />
                                  </div>
                                  {/* A linha "Margem: R$ X" saiu daqui. Decisão do dono
                                      (2026-07-20): a vendedora vê apenas que a margem está
                                      NEGATIVA — sem reais, sem percentual (percentual inverte
                                      igual: custo = preço × (1 − margem%)). E neste motor nem
                                      esse caso aparece: só entra SKU que a RPC listou como
                                      vendável (margem canônica > 0). */}
                                  <p className="text-[10px] text-muted-foreground">{rec.clusterVolume}× /mês no cluster</p>
                                </div>
                                <div className="text-right shrink-0">
                                  <p className="text-sm font-bold text-primary">{rec.pij}%</p>
                                  <p className="text-[10px] text-muted-foreground">conversão</p>
                                </div>
                              </div>
                              <Button
                                size="sm"
                                variant="outline"
                                className="w-full mt-2 h-7 text-[10px] gap-1"
                                disabled={!canOrder}
                                onClick={() => {
                                  const params = new URLSearchParams();
                                  if (rec.customerId) params.set('customer', rec.customerId);
                                  if (rec.productId) params.set('product', rec.productId);
                                  navigate(`/sales/new?${params.toString()}`);
                                }}
                              >
                                <Plus className="w-3 h-3" />
                                {outOfStock ? 'Sem estoque' : 'Adicionar ao pedido'}
                              </Button>
                            </CardContent>
                          </Card>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Up-sell */}
                  {cr.upSell.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold flex items-center gap-1 mb-2">
                        <ArrowUpRight className="w-3.5 h-3.5 text-status-purple" /> Up-sell ({cr.upSell.length})
                      </p>
                      <div className="space-y-2">
                        {cr.upSell.map(rec => {
                          const outOfStock = rec.estoque !== null && rec.estoque === 0;
                          const canOrder = !!rec.customerId && !!rec.productId && !outOfStock;
                          return (
                          <Card key={rec.productId} className="border-l-4 border-l-status-purple">
                            <CardContent className="p-3">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <p className="text-sm font-medium truncate">{rec.productName}</p>
                                    <StockBadge estoque={rec.estoque} />
                                  </div>
                                  {/* "Linha superior", não "mais rentável": sem custo no browser
                                      o motor não compara margem entre dois SKUs — só sabe que o
                                      alternativo é vendável e tem preço materialmente maior. */}
                                  <p className="text-[10px] text-muted-foreground">
                                    Linha superior a: {rec.currentProductName}
                                  </p>
                                </div>
                                <div className="text-right shrink-0">
                                  <p className="text-sm font-bold text-primary">{rec.pij}%</p>
                                  <p className="text-[10px] text-muted-foreground">conversão</p>
                                </div>
                              </div>
                              <Button
                                size="sm"
                                variant="outline"
                                className="w-full mt-2 h-7 text-[10px] gap-1"
                                disabled={!canOrder}
                                onClick={() => {
                                  const params = new URLSearchParams();
                                  if (rec.customerId) params.set('customer', rec.customerId);
                                  if (rec.productId) params.set('product', rec.productId);
                                  navigate(`/sales/new?${params.toString()}`);
                                }}
                              >
                                <Plus className="w-3 h-3" />
                                {outOfStock ? 'Sem estoque' : 'Adicionar ao pedido'}
                              </Button>
                            </CardContent>
                          </Card>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {cr.crossSell.length === 0 && cr.upSell.length === 0 && (
                    <p className="text-sm text-muted-foreground text-center py-4">Sem recomendações detalhadas.</p>
                  )}
                </div>
              )}
            </Card>
          );
        })
      )}
    </div>
  );
};

export default FarmerRecommendations;
