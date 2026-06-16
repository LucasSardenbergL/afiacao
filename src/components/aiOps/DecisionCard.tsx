// Card de decisão de IA (cliente, score, evidências, ações, métricas expandidas).
// Extraído verbatim de src/pages/AIops.tsx (god-component split).
import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Phone, ChevronDown, ChevronUp, CheckCircle2, XCircle } from 'lucide-react';
import { actionIcons, actionLabels, confidenceBadge } from './config';
import { EvidenceItem } from './EvidenceItem';
import type { AIDecision, Evidence } from './types';

export function DecisionCard({
  decision,
  customerName,
  onAccept,
  onDismiss,
}: {
  decision: AIDecision;
  customerName: string;
  customerPhone?: string | null;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const ActionIcon = actionIcons[decision.suggested_action] || Phone;
  const conf = confidenceBadge[decision.confidence] || confidenceBadge.baixa;

  return (
    <Card className="transition-shadow hover:shadow-md">
      <CardContent className="p-4">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="font-semibold text-base truncate">{customerName}</h3>
              <Badge variant={conf.variant} className="text-2xs shrink-0">
                {conf.label}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground leading-snug">{decision.primary_reason}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="text-right">
              <div className="text-lg font-bold text-primary">{decision.score_final.toFixed(0)}</div>
              <div className="text-2xs text-muted-foreground">score</div>
            </div>
          </div>
        </div>

        {/* Evidences (first 2 always visible) */}
        <div className="mt-3 space-y-1">
          {(decision.evidences as Evidence[]).slice(0, expanded ? 4 : 2).map((ev, i) => (
            <EvidenceItem key={i} evidence={ev} />
          ))}
        </div>

        {/* Actions */}
        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="gap-1.5"
              onClick={onAccept}
              disabled={decision.status !== 'pending'}
            >
              <ActionIcon className="w-3.5 h-3.5" />
              {actionLabels[decision.suggested_action]}
            </Button>
            {decision.status === 'pending' && (
              <Button size="sm" variant="ghost" onClick={onDismiss}>
                <XCircle className="w-3.5 h-3.5 mr-1" />
                Dispensar
              </Button>
            )}
            {decision.status === 'accepted' && (
              <Badge variant="default" className="gap-1">
                <CheckCircle2 className="w-3 h-3" /> Aceito
              </Badge>
            )}
            {decision.status === 'dismissed' && (
              <Badge variant="secondary" className="gap-1">
                <XCircle className="w-3 h-3" /> Dispensado
              </Badge>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
        </div>

        {/* Expanded metrics */}
        {expanded && (
          <div className="mt-3 pt-3 border-t border-border grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div>
              <div className="text-muted-foreground text-2xs">Pedidos 90d</div>
              <div className="font-medium">{decision.customer_metrics?.pedidos_90d ?? 0}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-2xs">Faturamento 90d</div>
              <div className="font-medium">
                R$ {Number(decision.customer_metrics?.faturamento_90d ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground text-2xs">Ticket médio</div>
              <div className="font-medium">
                R$ {Number(decision.customer_metrics?.ticket_medio_90d ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground text-2xs">Intervalo médio</div>
              <div className="font-medium">
                {decision.customer_metrics?.intervalo_medio_dias
                  ? `${Math.round(decision.customer_metrics.intervalo_medio_dias)} dias`
                  : 'N/A'}
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
