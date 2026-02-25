import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Plus, Info, TrendingUp, Package, ArrowUpRight, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { RecommendationItem } from '@/hooks/useRecommendationEngine';

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtPct = (v: number) => `${(v * 100).toFixed(0)}%`;

const EXPLANATION_ICONS: Record<string, typeof Sparkles> = {
  association: Package,
  cluster: TrendingUp,
  margin: ArrowUpRight,
  context: Sparkles,
};

interface RecommendationCardProps {
  item: RecommendationItem;
  onAdd?: (item: RecommendationItem) => void;
  onReject?: (item: RecommendationItem) => void;
  showAdminBreakdown?: boolean;
  compact?: boolean;
}

export function RecommendationCard({
  item,
  onAdd,
  onReject,
  showAdminBreakdown = false,
  compact = false,
}: RecommendationCardProps) {
  const ExplIcon = EXPLANATION_ICONS[item.explanation_key] || Sparkles;

  return (
    <Card className={cn(
      'transition-all hover:shadow-md border-l-4',
      item.recommendation_type === 'cross_sell' && 'border-l-blue-500',
      item.recommendation_type === 'cluster_based' && 'border-l-emerald-500',
      item.recommendation_type === 'repurchase' && 'border-l-amber-500',
    )}>
      <CardContent className={cn('flex flex-col gap-2', compact ? 'p-3' : 'p-4')}>
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <Badge variant="outline" className="text-[10px] shrink-0">
                {item.recommendation_type === 'cross_sell' ? 'Cross-sell' :
                 item.recommendation_type === 'repurchase' ? 'Recompra' : 'Cluster'}
              </Badge>
              <span className="text-[10px] text-muted-foreground">
                {item.codigo}
              </span>
            </div>
            <p className={cn('font-medium mt-1 truncate', compact ? 'text-sm' : 'text-base')}>
              {item.descricao}
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-base font-bold text-primary">{fmt(item.price)}</p>
            <p className="text-[10px] text-muted-foreground">{item.estoque} em estoque</p>
          </div>
        </div>

        {/* Explanation */}
        <div className="flex items-start gap-1.5 bg-muted/50 rounded-md px-2.5 py-1.5">
          <ExplIcon className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
          <p className="text-xs text-muted-foreground leading-relaxed">{item.explanation_text}</p>
        </div>

        {/* Metrics Row */}
        <div className="grid grid-cols-3 gap-2">
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground">Prob. conversão</p>
            <p className="text-sm font-semibold">{fmtPct(item.probability)}</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground">Margem</p>
            <p className="text-sm font-semibold">{fmt(item.margin)}</p>
          </div>
          <div className="text-center">
            <p className="text-[10px] text-muted-foreground">EIP</p>
            <p className="text-sm font-semibold text-primary">{fmt(item.eip)}</p>
          </div>
        </div>

        {/* Admin breakdown */}
        {showAdminBreakdown && item._admin && (
          <div className="border-t pt-2 mt-1">
            <p className="text-[10px] font-medium text-muted-foreground mb-1.5">Breakdown (Admin)</p>
            <div className="grid grid-cols-4 gap-1 text-[10px]">
              <div className="bg-muted rounded px-1.5 py-1 text-center">
                <span className="text-muted-foreground block">Assoc</span>
                <span className="font-mono font-semibold">{item._admin.assoc_score.toFixed(3)}</span>
              </div>
              <div className="bg-muted rounded px-1.5 py-1 text-center">
                <span className="text-muted-foreground block">Sim</span>
                <span className="font-mono font-semibold">{item._admin.sim_score.toFixed(3)}</span>
              </div>
              <div className="bg-muted rounded px-1.5 py-1 text-center">
                <span className="text-muted-foreground block">Ctx</span>
                <span className="font-mono font-semibold">{item._admin.ctx_score.toFixed(3)}</span>
              </div>
              <div className="bg-muted rounded px-1.5 py-1 text-center">
                <span className="text-muted-foreground block">Pen</span>
                <span className="font-mono font-semibold">{item._admin.penalties.toFixed(3)}</span>
              </div>
            </div>
            <div className="flex items-center gap-2 mt-1.5 text-[10px] text-muted-foreground">
              <Tooltip>
                <TooltipTrigger>
                  <Badge variant="secondary" className="text-[9px]">
                    Custo: {item._admin.cost_source}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Confiança: {(item._admin.cost_confidence * 100).toFixed(0)}%</p>
                  <p>Custo: {fmt(item._admin.cost_final)}</p>
                  <p>Família: {item._admin.familia || 'N/A'}</p>
                </TooltipContent>
              </Tooltip>
              <span>Score: {item.score_final.toFixed(4)}</span>
              <span>EILTV: {fmt(item._admin.eiltv)}</span>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 mt-1">
          {onAdd && (
            <Button size="sm" className="flex-1 h-8" onClick={() => onAdd(item)}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Adicionar ao pedido
            </Button>
          )}
          {onReject && (
            <Button size="sm" variant="ghost" className="h-8 px-3" onClick={() => onReject(item)}>
              Não agora
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
