// Card de um experimento A/B comercial.
// Extraído verbatim de src/pages/FarmerLOCC.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { BarChart3, CheckCircle, Play, XCircle } from 'lucide-react';
import { type Experiment } from '@/hooks/useFarmerExperiments';
import { metricLabels, statusColors } from './helpers';

export const ExperimentCard = ({ experiment, onStart, onMeasure, onCancel, disabled }: {
  experiment: Experiment;
  onStart: (id: string) => void;
  onMeasure: (id: string) => void;
  onCancel: (id: string) => void;
  disabled?: boolean;
}) => {
  const sc = statusColors[experiment.status] || statusColors.rascunho;

  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold truncate">{experiment.title}</p>
            <p className="text-[10px] text-muted-foreground truncate">{experiment.hypothesis}</p>
          </div>
          <Badge className={`text-[9px] ${sc}`}>{experiment.status}</Badge>
        </div>

        <div className="grid grid-cols-3 gap-1 text-center mb-2">
          <div className="bg-muted/50 rounded p-1">
            <p className="text-[9px] text-muted-foreground">Métrica</p>
            <p className="text-[10px] font-semibold">{metricLabels[experiment.primary_metric]}</p>
          </div>
          <div className="bg-muted/50 rounded p-1">
            <p className="text-[9px] text-muted-foreground">Controle</p>
            <p className="text-[10px] font-semibold">{experiment.control_count || 0}</p>
          </div>
          <div className="bg-muted/50 rounded p-1">
            <p className="text-[9px] text-muted-foreground">Teste</p>
            <p className="text-[10px] font-semibold">{experiment.test_count || 0}</p>
          </div>
        </div>

        {experiment.status === 'ativo' && (
          <div className="grid grid-cols-3 gap-1 text-center mb-2">
            <div className="bg-status-info-bg rounded p-1">
              <p className="text-[9px] text-muted-foreground">Controle</p>
              <p className="text-[10px] font-bold">{Number(experiment.control_metric_value).toFixed(2)}</p>
            </div>
            <div className="bg-status-success-bg rounded p-1">
              <p className="text-[9px] text-muted-foreground">Teste</p>
              <p className="text-[10px] font-bold">{Number(experiment.test_metric_value).toFixed(2)}</p>
            </div>
            <div className="bg-purple-50 rounded p-1">
              <p className="text-[9px] text-muted-foreground">Lift</p>
              <p className="text-[10px] font-bold">{Number(experiment.lift_pct).toFixed(1)}%</p>
            </div>
          </div>
        )}

        {experiment.status === 'concluido' && (
          <div className="mb-2">
            <div className="flex items-center gap-2">
              {experiment.winner === 'teste' && <CheckCircle className="w-4 h-4 text-status-success" />}
              {experiment.winner === 'controle' && <CheckCircle className="w-4 h-4 text-status-info" />}
              {experiment.winner === 'inconclusivo' && <XCircle className="w-4 h-4 text-status-warning" />}
              <span className="text-xs font-semibold">
                Vencedor: {experiment.winner === 'teste' ? '🏆 Teste' : experiment.winner === 'controle' ? '🏆 Controle' : '⚖️ Inconclusivo'}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1 text-center mt-1">
              <div className="bg-muted/50 rounded p-1">
                <p className="text-[9px] text-muted-foreground">Lift</p>
                <p className="text-[10px] font-bold">{Number(experiment.lift_pct).toFixed(1)}%</p>
              </div>
              <div className="bg-muted/50 rounded p-1">
                <p className="text-[9px] text-muted-foreground">p-value</p>
                <p className="text-[10px] font-bold">{experiment.p_value != null ? Number(experiment.p_value).toFixed(4) : '-'}</p>
              </div>
              <div className="bg-muted/50 rounded p-1">
                <p className="text-[9px] text-muted-foreground">Signif.</p>
                <p className="text-[10px] font-bold">{experiment.p_value != null ? `${((1 - Number(experiment.p_value)) * 100).toFixed(1)}%` : '-'}</p>
              </div>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-1">
          {experiment.status === 'rascunho' && (
            <Button size="sm" className="flex-1 h-7 text-[10px]" onClick={() => onStart(experiment.id)} disabled={disabled} title={disabled ? 'Indisponível em modo Ver como' : undefined}>
              <Play className="w-3 h-3 mr-1" /> Iniciar
            </Button>
          )}
          {experiment.status === 'ativo' && (
            <>
              <Button size="sm" variant="outline" className="flex-1 h-7 text-[10px]" onClick={() => onMeasure(experiment.id)} disabled={disabled} title={disabled ? 'Indisponível em modo Ver como' : undefined}>
                <BarChart3 className="w-3 h-3 mr-1" /> Medir
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-[10px] px-2" onClick={() => onCancel(experiment.id)} disabled={disabled} title={disabled ? 'Indisponível em modo Ver como' : undefined}>
                <XCircle className="w-3 h-3" />
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
};
