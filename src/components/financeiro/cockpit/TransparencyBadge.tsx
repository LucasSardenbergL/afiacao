// Badge de transparência/confiabilidade + ícone de status de fechamento.
// Extraídos verbatim de src/pages/FinanceiroCockpit.tsx (god-component split).
import { AlertTriangle, Clock, Eye, Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { FinConfiabilidadeRow } from './types';

export function TransparencyBadge({ conf }: { conf: FinConfiabilidadeRow | null }) {
  if (!conf) return <Badge variant="outline" className="text-[9px]">Sem dados de confiabilidade</Badge>;

  const pctMap = conf.pct_valor_mapeado || 0;
  const pctConc = conf.pct_mov_conciliado || 0;
  const fech = conf.fechamento_status || 'sem_fechamento';
  const catHeur = conf.dre_categorias_heuristica || 0;

  const score = Math.round((pctMap * 0.4) + (pctConc * 0.3) + (fech === 'fechado' ? 30 : 0));
  const color = score >= 70 ? 'text-status-success' : score >= 40 ? 'text-status-warning' : 'text-status-error';
  const bg = score >= 70 ? 'bg-status-success-bg border-status-success/20' : score >= 40 ? 'bg-status-warning-bg border-status-warning/20' : 'bg-status-error-bg border-status-error/20';

  return (
    <div className={`inline-flex items-center gap-2 px-2 py-1 rounded border text-xs ${bg}`}>
      <span className={`font-semibold tabular-nums ${color}`}>{score}%</span>
      <span className="text-muted-foreground">confiável</span>
      <span className="text-muted-foreground">·</span>
      <span className="tabular-nums">{pctMap.toFixed(0)}% mapeado</span>
      <span className="text-muted-foreground">·</span>
      <span className="tabular-nums">{pctConc.toFixed(0)}% conciliado</span>
      {catHeur > 0 && (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="text-status-warning">{catHeur} cat. heurísticas</span>
        </>
      )}
      <span className="text-muted-foreground">·</span>
      <FechamentoIcon status={fech} />
    </div>
  );
}

function FechamentoIcon({ status }: { status: string }) {
  switch (status) {
    case 'fechado': return <span className="flex items-center gap-0.5 text-status-success"><Lock className="w-3 h-3" /> Fechado</span>;
    case 'em_revisao': return <span className="flex items-center gap-0.5 text-status-warning"><Eye className="w-3 h-3" /> Revisão</span>;
    case 'reaberto': return <span className="flex items-center gap-0.5 text-status-error"><AlertTriangle className="w-3 h-3" /> Reaberto</span>;
    default: return <span className="flex items-center gap-0.5 text-muted-foreground"><Clock className="w-3 h-3" /> Aberto</span>;
  }
}
