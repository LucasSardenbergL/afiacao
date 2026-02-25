import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RecommendationsPanel } from '@/components/RecommendationsPanel';
import { useCrossSellEngine, type CustomerRecommendations } from '@/hooks/useCrossSellEngine';
import { useAuth } from '@/contexts/AuthContext';
import { useUserRole } from '@/hooks/useUserRole';
import { useNavigate } from 'react-router-dom';
import {
  Loader2, RefreshCw, TrendingUp, ShoppingCart, ArrowUpRight,
  DollarSign, Target, Search, ChevronDown, ChevronUp, Filter,
  Package, Sparkles,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const FarmerRecommendations = () => {
  const navigate = useNavigate();
  const { isStaff, loading: authLoading } = useAuth();
  const { isAdmin } = useUserRole();
  const {
    recommendations, loading, calculating, calculateRecommendations,
  } = useCrossSellEngine();
  const [expandedClient, setExpandedClient] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'cross_sell' | 'up_sell'>('all');
  const [activeTab, setActiveTab] = useState<'engine' | 'legacy'>('engine');

  useEffect(() => {
    if (!authLoading && isStaff) calculateRecommendations();
  }, [authLoading, isStaff]);

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!isStaff) { navigate('/', { replace: true }); return null; }

  const totalLIE = recommendations.reduce((s, cr) =>
    s + [...cr.crossSell, ...cr.upSell].reduce((s2, r) => s2 + r.lie, 0), 0);
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
          <p className="text-sm text-muted-foreground">Cross-sell e up-sell priorizados por EIP</p>
        </div>
        <Button variant="outline" size="sm" onClick={calculateRecommendations} disabled={calculating} className="gap-1.5">
          {calculating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Recalcular
        </Button>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-3 gap-3">
        <Card><CardContent className="p-3 text-center">
          <DollarSign className="w-4 h-4 mx-auto mb-1 text-primary" />
          <p className="text-lg font-bold text-primary">{fmt(totalLIE)}</p>
          <p className="text-[10px] text-muted-foreground">EIP Total</p>
        </CardContent></Card>
        <Card><CardContent className="p-3 text-center">
          <ShoppingCart className="w-4 h-4 mx-auto mb-1 text-blue-600" />
          <p className="text-lg font-bold">{totalCrossSell}</p>
          <p className="text-[10px] text-muted-foreground">Cross-sell</p>
        </CardContent></Card>
        <Card><CardContent className="p-3 text-center">
          <ArrowUpRight className="w-4 h-4 mx-auto mb-1 text-purple-600" />
          <p className="text-lg font-bold">{totalUpSell}</p>
          <p className="text-[10px] text-muted-foreground">Up-sell</p>
        </CardContent></Card>
      </div>

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
          const clientLIE = [...cr.crossSell, ...cr.upSell].reduce((s, r) => s + r.lie, 0);
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
                      <p className="text-sm font-bold text-primary">{fmt(clientLIE)}</p>
                      <p className="text-[10px] text-muted-foreground">EIP potencial</p>
                    </div>
                    {isExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                  </div>
                </div>
              </div>

              {isExpanded && (
                <div className="border-t bg-muted/10 p-3">
                  <RecommendationsPanel
                    customerId={cr.customerId}
                    title="Motor Híbrido — Sugestões"
                    compact
                  />
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
