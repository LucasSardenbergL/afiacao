// Painel de detalhe de ligação (inspirado no Gong).
// Extraído de src/pages/FarmerCalls.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { DollarSign, ArrowUpRight, FileText, Mic } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { CALL_TYPES, CALL_RESULTS, fmt, formatTimer, type CallLog } from './types';

export function CallDetailPanel({ call }: { call: CallLog; onClose: () => void }) {
  const typeInfo = CALL_TYPES.find(t => t.value === call.call_type);
  const resultInfo = CALL_RESULTS.find(r => r.value === call.call_result);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-foreground">{call.customer_name}</h3>
        <span className="text-xs text-muted-foreground">
          {format(new Date(call.created_at), "dd/MM/yy 'às' HH:mm", { locale: ptBR })}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Badge variant="outline" className={cn('text-[10px]', typeInfo?.color)}>
          {typeInfo?.label}
        </Badge>
        <Badge variant="outline" className="text-[10px]">
          {resultInfo?.icon} {resultInfo?.label}
        </Badge>
        {call.attempt_number > 1 && (
          <Badge variant="secondary" className="text-[10px]">#{call.attempt_number}</Badge>
        )}
      </div>

      {/* Timeline / Player area (Gong-style) */}
      <Card className="bg-muted/30">
        <CardContent className="p-4">
          <div className="flex items-center justify-center gap-6">
            <div className="text-center">
              <p className="text-2xl font-mono font-bold">{formatTimer(call.duration_seconds)}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">Duração da ligação</p>
            </div>
            {call.follow_up_duration_seconds > 0 && (
              <>
                <Separator orientation="vertical" className="h-10" />
                <div className="text-center">
                  <p className="text-2xl font-mono font-bold">{formatTimer(call.follow_up_duration_seconds)}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">Follow-up</p>
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Metrics */}
      {(call.revenue_generated > 0 || call.margin_generated > 0) && (
        <div className="grid grid-cols-2 gap-3">
          <Card>
            <CardContent className="p-3 text-center">
              <DollarSign className="w-4 h-4 mx-auto text-muted-foreground mb-1" />
              <p className="text-sm font-bold">{fmt(call.revenue_generated)}</p>
              <p className="text-[10px] text-muted-foreground">Receita gerada</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <ArrowUpRight className="w-4 h-4 mx-auto text-muted-foreground mb-1" />
              <p className="text-sm font-bold">{fmt(call.margin_generated)}</p>
              <p className="text-[10px] text-muted-foreground">Margem gerada</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Transcript placeholder */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5" /> Transcrição
          </CardTitle>
        </CardHeader>
        <CardContent>
          {call.notes ? (
            <p className="text-sm text-foreground whitespace-pre-wrap">{call.notes}</p>
          ) : (
            <div className="text-center py-6">
              <Mic className="w-6 h-6 mx-auto mb-2 text-muted-foreground/40" />
              <p className="text-xs text-muted-foreground">Nenhuma transcrição disponível</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">Use o Copilot para transcrever em tempo real.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Next steps placeholder */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Próximos passos</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">Nenhum próximo passo registrado.</p>
        </CardContent>
      </Card>
    </div>
  );
}
