import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { RecommendationCard } from '@/components/RecommendationCard';
import { useRecommendationEngine, type RecommendationItem } from '@/hooks/useRecommendationEngine';
import { useUserRole } from '@/hooks/useUserRole';
import { Sparkles, RefreshCw, Loader2, AlertCircle, Target } from 'lucide-react';
import { toast } from 'sonner';

interface RecommendationsPanelProps {
  customerId: string;
  basketProductIds?: string[];
  onAddToCart?: (item: RecommendationItem) => void;
  compact?: boolean;
  maxItems?: number;
  title?: string;
}

export function RecommendationsPanel({
  customerId,
  basketProductIds = [],
  onAddToCart,
  compact = false,
  maxItems,
  title = 'Sugestões para este cliente',
}: RecommendationsPanelProps) {
  const { isAdmin } = useUserRole();
  const {
    recommendations, meta, loading, error,
    fetchRecommendations, logAccept, logReject,
  } = useRecommendationEngine();
  const [showAdmin, setShowAdmin] = useState(false);

  useEffect(() => {
    if (customerId) {
      fetchRecommendations(customerId, basketProductIds);
    }
  }, [customerId, basketProductIds.join(',')]);

  const handleAdd = async (item: RecommendationItem) => {
    await logAccept(customerId, item.product_id);
    onAddToCart?.(item);
    toast.success('Produto adicionado', { description: item.descricao });
  };

  const handleReject = async (item: RecommendationItem) => {
    await logReject(customerId, item.product_id);
    toast.info('Recomendação descartada');
  };

  const displayItems = maxItems ? recommendations.slice(0, maxItems) : recommendations;

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Sparkles className="w-4 h-4" /> {title}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-24 w-full" />)}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-6 text-center">
          <AlertCircle className="w-5 h-5 mx-auto mb-2 text-destructive" />
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => fetchRecommendations(customerId, basketProductIds)}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" /> Tentar novamente
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (displayItems.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <Target className="w-6 h-6 mx-auto mb-2 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            Sem sugestões para este cliente no momento.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-primary" /> {title}
            {meta && (
              <Badge variant="outline" className="text-[10px] ml-1">
                {meta.mode === 'profit' ? 'Lucro' : 'LTV'} · {meta.total_candidates} avaliados
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-3">
            {isAdmin && (
              <div className="flex items-center gap-1.5">
                <Switch id="admin-mode" checked={showAdmin} onCheckedChange={setShowAdmin} />
                <Label htmlFor="admin-mode" className="text-[10px] text-muted-foreground">Admin</Label>
              </div>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => fetchRecommendations(customerId, basketProductIds)}
              disabled={loading}
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {displayItems.map(item => (
          <RecommendationCard
            key={item.product_id}
            item={item}
            onAdd={onAddToCart ? handleAdd : undefined}
            onReject={handleReject}
            showAdminBreakdown={showAdmin && isAdmin}
            compact={compact}
          />
        ))}
      </CardContent>
    </Card>
  );
}
