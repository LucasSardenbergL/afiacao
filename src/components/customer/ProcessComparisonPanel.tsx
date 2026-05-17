import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useProcessComparison, type ProcessComparisonResponse } from '@/hooks/useProcessComparison';
import {
  Sparkles, Loader2, AlertTriangle, TrendingUp, ShieldAlert,
  Lightbulb, Users, Target, Factory,
} from 'lucide-react';

interface Props {
  customerId: string;
}

const SEVERITY_COLOR: Record<string, string> = {
  baixa: 'border-muted-foreground/30 text-muted-foreground',
  media: 'border-status-warning text-status-warning',
  alta: 'border-status-error text-status-error',
};

const OPP_TYPE_LABEL: Record<string, string> = {
  upsell: 'Upsell',
  cross_sell: 'Cross-sell',
  process_improvement: 'Melhoria de processo',
  compliance: 'Compliance',
};

/**
 * Painel de comparação inteligente do processo do cliente.
 *
 * Vendedor clica botão → invoca Claude via edge fn → mostra:
 * - Summary executivo (top gap/oportunidade/risco + próxima ação)
 * - Lacunas vs processos padrão
 * - Oportunidades (upsell/cross-sell/processo/compliance)
 * - Riscos detectados
 * - Lookalikes anonimizados (ou mensagem "sem lookalike")
 */
export function ProcessComparisonPanel({ customerId }: Props) {
  const compare = useProcessComparison();
  const [result, setResult] = useState<ProcessComparisonResponse | null>(null);

  const handleCompare = () => {
    compare.mutate(customerId, {
      onSuccess: (data) => setResult(data),
    });
  };

  if (!result && !compare.isPending) {
    return (
      <Card className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-status-warning" />
          <h3 className="text-sm font-semibold">Comparação inteligente</h3>
        </div>
        <p className="text-2xs text-muted-foreground">
          Compara o processo deste cliente com processos padrão da fábrica + clientes parecidos (anonimizados).
          Identifica lacunas, oportunidades de upsell/cross-sell e riscos.
        </p>
        <Button size="sm" onClick={handleCompare} className="gap-1.5">
          <Sparkles className="w-3.5 h-3.5" />
          Comparar com padrões e clientes similares
        </Button>
      </Card>
    );
  }

  if (compare.isPending) {
    return (
      <Card className="p-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        Analisando processo + buscando lookalikes...
      </Card>
    );
  }

  if (!result) return null;

  const { analysis, lookalikes, metadata } = result;

  return (
    <div className="space-y-3">
      {/* Summary executivo */}
      <Card className="p-3 space-y-2 border-2 border-status-success/30">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Target className="w-4 h-4 text-status-success" />
            <h3 className="text-sm font-semibold">Resumo executivo</h3>
          </div>
          <Button size="sm" variant="outline" onClick={handleCompare} disabled={compare.isPending} className="text-2xs">
            Re-analisar
          </Button>
        </div>
        <div className="space-y-1.5 text-xs">
          {analysis.summary.top_gap && (
            <div>
              <span className="font-medium text-status-warning">⚠ Principal lacuna:</span> {analysis.summary.top_gap}
            </div>
          )}
          {analysis.summary.top_opportunity && (
            <div>
              <span className="font-medium text-status-success">💡 Principal oportunidade:</span> {analysis.summary.top_opportunity}
            </div>
          )}
          {analysis.summary.top_risk && (
            <div>
              <span className="font-medium text-status-error">⛔ Principal risco:</span> {analysis.summary.top_risk}
            </div>
          )}
          {analysis.summary.recommended_next_action && (
            <div className="mt-2 p-2 rounded bg-status-success-bg/40 border border-status-success/30">
              <span className="font-medium">→ Próxima ação:</span> {analysis.summary.recommended_next_action}
            </div>
          )}
        </div>
      </Card>

      {/* Standards comparados */}
      {analysis.matching_standards.length > 0 && (
        <Card className="p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <Factory className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="font-medium">Comparado contra {analysis.matching_standards.length} processo(s) padrão</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {analysis.matching_standards.map((s) => (
              <Badge key={s.standard_id} variant="outline" className="text-2xs">
                {s.name}{' '}
                <span className="ml-1 opacity-60">{Math.round(s.similarity_score * 100)}%</span>
              </Badge>
            ))}
          </div>
        </Card>
      )}

      {/* Gaps */}
      {analysis.gaps.length > 0 && (
        <Card className="p-3 space-y-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-status-warning" />
            <h4 className="text-sm font-semibold">Lacunas vs padrão ({analysis.gaps.length})</h4>
          </div>
          <div className="space-y-2">
            {analysis.gaps.map((g, i) => (
              <Card key={i} className="p-2.5 space-y-1 border-dashed">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={`text-2xs ${SEVERITY_COLOR[g.severity]}`}>{g.severity}</Badge>
                  <span className="text-xs font-medium">{g.area}</span>
                </div>
                <p className="text-xs text-foreground/80">{g.description}</p>
                <p className="text-2xs text-muted-foreground italic">Impacto: {g.impact}</p>
              </Card>
            ))}
          </div>
        </Card>
      )}

      {/* Opportunities */}
      {analysis.opportunities.length > 0 && (
        <Card className="p-3 space-y-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-status-success" />
            <h4 className="text-sm font-semibold">Oportunidades ({analysis.opportunities.length})</h4>
          </div>
          <div className="space-y-2">
            {analysis.opportunities.map((o, i) => (
              <Card key={i} className="p-2.5 space-y-1 border-dashed">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-2xs border-status-success text-status-success">
                    {OPP_TYPE_LABEL[o.type]}
                  </Badge>
                  {o.estimated_value && (
                    <Badge variant="outline" className="text-2xs">{o.estimated_value}</Badge>
                  )}
                </div>
                <p className="text-xs font-medium">{o.description}</p>
                <p className="text-2xs text-muted-foreground">{o.rationale}</p>
                {o.product_codes_suggested.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-1">
                    {o.product_codes_suggested.map((code) => (
                      <Badge key={code} variant="outline" className="text-[10px] font-mono">
                        {code}
                      </Badge>
                    ))}
                  </div>
                )}
              </Card>
            ))}
          </div>
        </Card>
      )}

      {/* Risks */}
      {analysis.risks.length > 0 && (
        <Card className="p-3 space-y-2">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-status-error" />
            <h4 className="text-sm font-semibold">Riscos detectados ({analysis.risks.length})</h4>
          </div>
          <div className="space-y-2">
            {analysis.risks.map((r, i) => (
              <Card key={i} className="p-2.5 space-y-1 border-dashed">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={`text-2xs ${SEVERITY_COLOR[r.severity]}`}>{r.severity}</Badge>
                  <span className="text-xs font-medium">{r.type}</span>
                </div>
                <p className="text-xs text-foreground/80">{r.description}</p>
                <p className="text-2xs text-status-success italic">→ {r.mitigation}</p>
              </Card>
            ))}
          </div>
        </Card>
      )}

      {/* Lookalikes */}
      {lookalikes.length > 0 ? (
        <Card className="p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-muted-foreground" />
            <h4 className="text-sm font-semibold">Clientes parecidos ({lookalikes.length})</h4>
          </div>
          <p className="text-2xs text-muted-foreground">
            Anonimizados. Mesmo segmento + tags compatíveis.
          </p>
          <div className="space-y-1.5">
            {lookalikes.map((l, i) => (
              <Card key={i} className="p-2.5 space-y-1 border-dashed bg-muted/20">
                <div className="text-xs font-medium">{l.anon_label}</div>
                <div className="text-2xs text-muted-foreground line-clamp-3">{l.process_summary}</div>
              </Card>
            ))}
          </div>
        </Card>
      ) : (
        <Card className="p-3 bg-muted/20">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Lightbulb className="w-3.5 h-3.5" />
            <span>
              Sem clientes parecidos cadastrados ainda
              {!metadata.customer_tags.length && ' (cliente sem tags em customer_segments)'}. Análise focada nos processos padrão.
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}
