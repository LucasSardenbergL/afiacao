import { useEffect, useState } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { useCrossSellEngine, type CustomerRecommendations, type Recommendation } from '@/hooks/useCrossSellEngine';
import { useAuth } from '@/contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import {
  Loader2, RefreshCw, TrendingUp, ShoppingCart, ArrowUpRight,
  DollarSign, Target, CheckCircle, X, Eye, Sparkles, Search,
  ChevronDown, ChevronUp, Filter, Package, Info,
} from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtPct = (v: number) => `${v.toFixed(1)}%`;

/* ─── Recommendation Card (Enterprise) ─── */
const RecCard = ({
  rec, onOffer, onAccept, onReject,
}: {
  rec: Recommendation;
  onOffer: (id: string) => Promise<void>;
  onAccept: (id: string, margin?: number, time?: number) => Promise<void>;
  onReject: (id: string) => Promise<void>;
}) => {
  const isUpSell = rec.type === 'up_sell';

  return (
    <div className="rounded-lg border bg-card p-3 mb-2 hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2.5 flex-1 min-w-0">
          <div className={cn(
            'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
            isUpSell ? 'bg-purple-50 text-purple-600' : 'bg-blue-50 text-blue-600'
          )}>
            {isUpSell ? <ArrowUpRight className="w-4 h-4" /> : <Package className="w-4 h-4" />}
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{rec.productName}</p>
            {isUpSell && rec.currentProductName && (
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Substitui: {rec.currentProductName}
              </p>
            )}
            {/* Why suggested */}
            <div className="flex items-center gap-1 mt-1">
              <Info className="w-3 h-3 text-muted-foreground" />
              <span className="text-[10px] text-muted-foreground">
                P(conv): {fmtPct(rec.pij)} · Margem inc.: {fmt(rec.mij)}
              </span>
            </div>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-bold text-primary">{fmt(rec.lie)}</p>
          <p className="text-[9px] text-muted-foreground">LIE</p>
        </div>
      </div>

      {/* Impact metrics */}
      <div className="grid grid-cols-3 gap-1.5 mt-2">
        <div className="bg-muted/50 rounded px-2 py-1 text-center">
          <p className="text-[9px] text-muted-foreground">Probabilidade</p>
          <p className="text-[11px] font-semibold">{fmtPct(rec.pij)}</p>
        </div>
        <div className="bg-muted/50 rounded px-2 py-1 text-center">
          <p className="text-[9px] text-muted-foreground">Margem Inc.</p>
          <p className="text-[11px] font-semibold">{fmt(rec.mij)}</p>
        </div>
        <div className="bg-muted/50 rounded px-2 py-1 text-center">
          <p className="text-[9px] text-muted-foreground">Complexidade</p>
          <p className="text-[11px] font-semibold">{rec.complexityFactor.toFixed(2)}</p>
        </div>
      </div>

      {/* Actions */}
      {rec.id && rec.status === 'pendente' && (
        <div className="flex gap-1.5 mt-2.5">
          <Button size="sm" variant="outline" className="flex-1 h-7 text-[11px]" onClick={() => onOffer(rec.id!)}>
            <Eye className="w-3 h-3 mr-1" /> Ofertar
          </Button>
          <Button size="sm" className="flex-1 h-7 text-[11px]" onClick={() => onAccept(rec.id!)}>
            <CheckCircle className="w-3 h-3 mr-1" /> Aceito
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-[11px] px-2" onClick={() => onReject(rec.id!)}>
            <X className="w-3 h-3" />
          </Button>
        </div>
      )}

      {rec.status === 'ofertado' && <Badge variant="outline" className="mt-2 text-[10px] status-pending">📤 Ofertado</Badge>}
      {rec.status === 'aceito' && <Badge variant="outline" className="mt-2 text-[10px] status-success">✅ Aceito</Badge>}
      {rec.status === 'rejeitado' && <Badge variant="secondary" className="mt-2 text-[10px]">❌ Rejeitado</Badge>}
    </div>
  );
};

/* ─── Main Page ─── */
const FarmerRecommendations = () => {
  const navigate = useNavigate();
  const { isStaff, loading: authLoading } = useAuth();
  const { recommendations, loading, calculating, calculateRecommendations, markAsOffered, markAsAccepted, markAsRejected } = useCrossSellEngine();
  const [expandedClient, setExpandedClient] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'cross_sell' | 'up_sell'>('all');

  useEffect(() => {
    if (!authLoading && isStaff) calculateRecommendations();
  }, [authLoading, isStaff]);

  if (authLoading || loading) {
    return <div className="flex items-center justify-center py-32"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
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
            <p className="text-sm text-muted-foreground">Cross-sell e up-sell priorizados por LIE</p>
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
            <p className="text-[10px] text-muted-foreground">LIE Total</p>
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

        {/* Client Recommendations */}
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
                            <Badge variant="outline" className="text-[10px] status-progress">
                              {cr.crossSell.length} Cross
                            </Badge>
                          )}
                          {cr.upSell.length > 0 && (
                            <Badge variant="outline" className="text-[10px] bg-purple-50 text-purple-700 border-purple-200">
                              {cr.upSell.length} Up
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="text-right">
                        <p className="text-sm font-bold text-primary">{fmt(clientLIE)}</p>
                        <p className="text-[10px] text-muted-foreground">LIE potencial</p>
                      </div>
                      {isExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                    </div>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t bg-muted/10 p-3 space-y-3">
                    {cr.crossSell.length > 0 && (
                      <div>
                        <div className="flex items-center gap-1 mb-2">
                          <ShoppingCart className="w-3 h-3 text-blue-600" />
                          <span className="text-xs font-semibold">Cross-sell</span>
                        </div>
                        {cr.crossSell.map((rec, i) => (
                          <RecCard key={`cs-${i}`} rec={rec} onOffer={markAsOffered} onAccept={markAsAccepted} onReject={markAsRejected} />
                        ))}
                      </div>
                    )}
                    {cr.upSell.length > 0 && (
                      <div>
                        <div className="flex items-center gap-1 mb-2">
                          <ArrowUpRight className="w-3 h-3 text-purple-600" />
                          <span className="text-xs font-semibold">Up-sell</span>
                        </div>
                        {cr.upSell.map((rec, i) => (
                          <RecCard key={`us-${i}`} rec={rec} onOffer={markAsOffered} onAccept={markAsAccepted} onReject={markAsRejected} />
                        ))}
                      </div>
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
