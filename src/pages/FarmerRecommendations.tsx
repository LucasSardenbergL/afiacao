import { useEffect, useState } from 'react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCrossSellEngine, type CustomerRecommendations, type Recommendation } from '@/hooks/useCrossSellEngine';
import { useAuth } from '@/contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import {
  Loader2, RefreshCw, TrendingUp, ShoppingCart, ArrowUpRight,
  DollarSign, Target, CheckCircle, X, Eye, Zap, BarChart3
} from 'lucide-react';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtPct = (v: number) => `${v.toFixed(1)}%`;

const FarmerRecommendations = () => {
  const navigate = useNavigate();
  const { isStaff, loading: authLoading } = useAuth();
  const { recommendations, loading, calculating, calculateRecommendations, markAsOffered, markAsAccepted, markAsRejected } = useCrossSellEngine();
  const [expandedClient, setExpandedClient] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && isStaff) {
      calculateRecommendations();
    }
  }, [authLoading, isStaff]);

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isStaff) { navigate('/', { replace: true }); return null; }

  const totalLIE = recommendations.reduce((s, cr) =>
    s + [...cr.crossSell, ...cr.upSell].reduce((s2, r) => s2 + r.lie, 0), 0
  );
  const totalCrossSell = recommendations.reduce((s, cr) => s + cr.crossSell.length, 0);
  const totalUpSell = recommendations.reduce((s, cr) => s + cr.upSell.length, 0);

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Recomendações LIE" showBack />

      <main className="px-4 py-4 space-y-4 max-w-lg mx-auto">
        {/* Summary Cards */}
        <div className="grid grid-cols-3 gap-2">
          <Card>
            <CardContent className="p-3 text-center">
              <DollarSign className="w-4 h-4 mx-auto text-emerald-600 mb-1" />
              <p className="text-lg font-bold text-emerald-700">{fmt(totalLIE)}</p>
              <p className="text-[10px] text-muted-foreground">LIE Total</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <ShoppingCart className="w-4 h-4 mx-auto text-blue-600 mb-1" />
              <p className="text-lg font-bold">{totalCrossSell}</p>
              <p className="text-[10px] text-muted-foreground">Cross-sell</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <ArrowUpRight className="w-4 h-4 mx-auto text-purple-600 mb-1" />
              <p className="text-lg font-bold">{totalUpSell}</p>
              <p className="text-[10px] text-muted-foreground">Up-sell</p>
            </CardContent>
          </Card>
        </div>

        {/* Recalculate */}
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={calculateRecommendations}
          disabled={calculating}
        >
          {calculating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
          Recalcular Recomendações
        </Button>

        {/* Client Recommendations */}
        {recommendations.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center">
              <Target className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p className="text-sm text-muted-foreground">
                Nenhuma recomendação disponível. Calcule os scores dos clientes primeiro no painel Farmer.
              </p>
            </CardContent>
          </Card>
        ) : (
          recommendations.map(cr => {
            const clientLIE = [...cr.crossSell, ...cr.upSell].reduce((s, r) => s + r.lie, 0);
            const isExpanded = expandedClient === cr.customerId;

            return (
              <Card key={cr.customerId} className="overflow-hidden">
                <CardContent
                  className="p-3 cursor-pointer"
                  onClick={() => setExpandedClient(isExpanded ? null : cr.customerId)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{cr.customerName}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Badge variant="outline" className="text-[10px]">
                          Health: {cr.healthScore.toFixed(0)}
                        </Badge>
                        {cr.crossSell.length > 0 && (
                          <Badge className="text-[10px] bg-blue-100 text-blue-800 border-blue-200">
                            {cr.crossSell.length} Cross
                          </Badge>
                        )}
                        {cr.upSell.length > 0 && (
                          <Badge className="text-[10px] bg-purple-100 text-purple-800 border-purple-200">
                            {cr.upSell.length} Up
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-emerald-700">{fmt(clientLIE)}</p>
                      <p className="text-[10px] text-muted-foreground">LIE potencial</p>
                    </div>
                  </div>
                </CardContent>

                {isExpanded && (
                  <div className="border-t bg-muted/30 p-3 space-y-3">
                    {/* Cross-sell */}
                    {cr.crossSell.length > 0 && (
                      <div>
                        <div className="flex items-center gap-1 mb-2">
                          <ShoppingCart className="w-3 h-3 text-blue-600" />
                          <span className="text-xs font-semibold text-blue-700">Cross-sell (Top 3)</span>
                        </div>
                        {cr.crossSell.map((rec, i) => (
                          <RecCard key={`cs-${i}`} rec={rec} onOffer={markAsOffered} onAccept={markAsAccepted} onReject={markAsRejected} />
                        ))}
                      </div>
                    )}

                    {/* Up-sell */}
                    {cr.upSell.length > 0 && (
                      <div>
                        <div className="flex items-center gap-1 mb-2">
                          <ArrowUpRight className="w-3 h-3 text-purple-600" />
                          <span className="text-xs font-semibold text-purple-700">Up-sell (Top 2)</span>
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
      </main>
      <BottomNav />
    </div>
  );
};

// ─── Recommendation Card ─────────────────────────────────────────────
const RecCard = ({
  rec,
  onOffer,
  onAccept,
  onReject,
}: {
  rec: Recommendation;
  onOffer: (id: string) => Promise<void>;
  onAccept: (id: string, margin?: number, time?: number) => Promise<void>;
  onReject: (id: string) => Promise<void>;
}) => {
  const isUpSell = rec.type === 'up_sell';

  return (
    <div className="bg-background rounded-lg border p-2.5 mb-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium truncate">{rec.productName}</p>
          {isUpSell && rec.currentProductName && (
            <p className="text-[10px] text-muted-foreground">
              ↑ substitui: {rec.currentProductName}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs font-bold text-emerald-700">{fmt(rec.lie)}</p>
          <p className="text-[9px] text-muted-foreground">LIE</p>
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-3 gap-1 mt-2 text-center">
        <div className="bg-muted/50 rounded px-1.5 py-1">
          <p className="text-[9px] text-muted-foreground">P(conv)</p>
          <p className="text-[10px] font-semibold">{fmtPct(rec.pij)}</p>
        </div>
        <div className="bg-muted/50 rounded px-1.5 py-1">
          <p className="text-[9px] text-muted-foreground">Margem Inc.</p>
          <p className="text-[10px] font-semibold">{fmt(rec.mij)}</p>
        </div>
        <div className="bg-muted/50 rounded px-1.5 py-1">
          <p className="text-[9px] text-muted-foreground">Complexidade</p>
          <p className="text-[10px] font-semibold">{rec.complexityFactor.toFixed(2)}</p>
        </div>
      </div>

      {/* Actions */}
      {rec.id && rec.status === 'pendente' && (
        <div className="flex gap-1 mt-2">
          <Button size="sm" variant="outline" className="flex-1 h-7 text-[10px]" onClick={() => onOffer(rec.id!)}>
            <Eye className="w-3 h-3 mr-1" /> Ofertar
          </Button>
          <Button size="sm" variant="default" className="flex-1 h-7 text-[10px]" onClick={() => onAccept(rec.id!)}>
            <CheckCircle className="w-3 h-3 mr-1" /> Aceito
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-[10px] px-2" onClick={() => onReject(rec.id!)}>
            <X className="w-3 h-3" />
          </Button>
        </div>
      )}

      {rec.status === 'ofertado' && (
        <Badge variant="outline" className="mt-2 text-[9px]">📤 Ofertado</Badge>
      )}
      {rec.status === 'aceito' && (
        <Badge className="mt-2 text-[9px] bg-emerald-100 text-emerald-800">✅ Aceito</Badge>
      )}
      {rec.status === 'rejeitado' && (
        <Badge variant="secondary" className="mt-2 text-[9px]">❌ Rejeitado</Badge>
      )}
    </div>
  );
};

export default FarmerRecommendations;
