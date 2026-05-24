// Aba "Otimização" (adaptativa) da tela FarmerLOCC.
// Extraída verbatim de src/pages/FarmerLOCC.tsx (god-component split).
import { memo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Brain, Clock, Shield, Users } from 'lucide-react';
import { type AlgorithmConfig } from '@/hooks/useFarmerScoring';
import { type FarmerMetrics } from '@/hooks/useFarmerMetrics';
import { WeightBar } from './primitives';

export const AdaptiveTab = memo(({ config, metrics, navigate }: { config: AlgorithmConfig; metrics: FarmerMetrics; navigate: (path: string) => void }) => (
  <>
    <Card>
      <CardHeader className="p-3 pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Brain className="w-4 h-4" /> Otimização Adaptativa
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-0 space-y-3">
        <div>
          <p className="text-[10px] text-muted-foreground mb-1">Pesos do Health Score</p>
          <WeightBar label="RF (Recência)" value={config.health_w_rf * 100} />
          <WeightBar label="M (Monetário)" value={config.health_w_m * 100} />
          <WeightBar label="G (Margem)" value={config.health_w_g * 100} />
          <WeightBar label="X (Mix)" value={config.health_w_x * 100} />
          <WeightBar label="S (Atendimento)" value={config.health_w_s * 100} />
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground mb-1">Pesos do Priority Score</p>
          <WeightBar label="Churn Risk" value={config.priority_w_churn * 100} />
          <WeightBar label="Recover" value={config.priority_w_recover * 100} />
          <WeightBar label="Expansion" value={config.priority_w_expansion * 100} />
          <WeightBar label="Efficiency" value={config.priority_w_eff * 100} />
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground mb-1">Quotas da Agenda</p>
          <WeightBar label="Risco/Recuperação" value={config.agenda_pct_risco * 100} color="bg-destructive" />
          <WeightBar label="Expansão" value={config.agenda_pct_expansao * 100} color="bg-status-success" />
          <WeightBar label="Follow-up" value={config.agenda_pct_followup * 100} color="bg-status-info" />
        </div>
      </CardContent>
    </Card>

    {/* Portfolio Recommendation */}
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-2 mb-2">
          <Users className="w-4 h-4 text-primary" />
          <span className="text-xs font-semibold">Recomendação de Carteira</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge className={
            metrics.portfolioRecommendation === 'expand' ? 'bg-status-success-bg text-status-success-fg' :
            metrics.portfolioRecommendation === 'reduce' ? 'bg-status-error-bg text-status-error-fg' :
            'bg-status-info-bg text-status-info-fg'
          }>
            {metrics.portfolioRecommendation === 'expand' ? '📈 Expandir' :
             metrics.portfolioRecommendation === 'reduce' ? '📉 Reduzir' :
             '➡️ Manter'}
          </Badge>
          <span className="text-[10px] text-muted-foreground">
            Atual: {metrics.currentActiveClients} · Ideal: {metrics.optimalClientsCount}
          </span>
        </div>
        {metrics.weights.suggested_calls_per_day && (
          <p className="text-[10px] text-muted-foreground mt-2">
            💡 Ligações sugeridas/dia: <strong>{metrics.weights.suggested_calls_per_day}</strong> ·
            Portfólio sugerido: <strong>{metrics.weights.suggested_portfolio_size}</strong>
          </p>
        )}
      </CardContent>
    </Card>

    {/* Frequency suggestion */}
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-2 mb-1">
          <Clock className="w-4 h-4 text-primary" />
          <span className="text-xs font-semibold">Frequência Ótima de Contato</span>
        </div>
        <p className="text-sm font-bold">{metrics.optimalFrequencyPerMonth.toFixed(1)}x/mês</p>
        <p className="text-[10px] text-muted-foreground">
          Baseado em {metrics.daysOfData} dias de dados e {metrics.totalCalls} ligações
        </p>
      </CardContent>
    </Card>

    <Button variant="outline" className="w-full" onClick={() => navigate('/farmer/governance')}>
      <Shield className="w-4 h-4 mr-2" /> Propor Alteração de Pesos
    </Button>
  </>
));
AdaptiveTab.displayName = 'AdaptiveTab';
