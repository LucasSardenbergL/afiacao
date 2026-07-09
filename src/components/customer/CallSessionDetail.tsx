import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { formatDistanceToNow, format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import type { CustomerCallRow } from '@/hooks/useCustomerCalls';
import type { SpinAnalysis } from '@/lib/call/spin/types';

/**
 * Tipo local — espelha o AggregatedEntity de PR4 (`@/lib/call-session/aggregate-entities`)
 * que ainda não existe no branch. Substituir pelo import quando aquele módulo for criado.
 */
interface AggregatedEntity {
  type: string;
  value: string;
  context?: string;
  occurrences: number;
}

interface CallSessionDetailProps {
  call: CustomerCallRow | null;
  onClose: () => void;
}

interface TranscriptTurnLite {
  speaker: 'vendedor' | 'cliente';
  text: string;
  isFinal: boolean;
  startedAt: number;
}

const ENTITY_TYPE_LABEL: Record<string, string> = {
  competitor: 'Concorrentes',
  price: 'Preços',
  volume: 'Volumes',
  product: 'Produtos do concorrente',
  timeline: 'Prazos',
  decision_maker: 'Decisores',
};

export function CallSessionDetail({ call, onClose }: CallSessionDetailProps) {
  if (!call) return null;

  const transcript = (Array.isArray(call.transcript) ? call.transcript : []) as TranscriptTurnLite[];
  const analyses = (Array.isArray(call.analyses) ? call.analyses : []) as SpinAnalysis[];
  const entities = (Array.isArray(call.entities_extracted) ? call.entities_extracted : []) as AggregatedEntity[];

  const entitiesByType = entities.reduce((acc, e) => {
    if (!acc[e.type]) acc[e.type] = [];
    acc[e.type].push(e);
    return acc;
  }, {} as Record<string, AggregatedEntity[]>);

  const durationMin = Math.floor((call.duration_seconds ?? 0) / 60);
  const durationSec = (call.duration_seconds ?? 0) % 60;

  return (
    <Sheet open={!!call} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader className="space-y-1">
          <SheetTitle className="flex items-center gap-2">
            Chamada de {format(new Date(call.started_at), 'dd/MM/yyyy HH:mm', { locale: ptBR })}
            {call.call_backend && (
              <Badge variant="outline" className="text-2xs uppercase">{call.call_backend}</Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            {durationMin}min {durationSec}s · {formatDistanceToNow(new Date(call.started_at), { locale: ptBR, addSuffix: true })}
            {call.revenue_generated && Number(call.revenue_generated) > 0 && (
              <> · 💰 R$ {Number(call.revenue_generated).toLocaleString('pt-BR')}</>
            )}
          </SheetDescription>
        </SheetHeader>

        <Tabs defaultValue="transcript" className="mt-4">
          <TabsList className="w-full">
            <TabsTrigger value="transcript" className="flex-1">Transcript ({transcript.length})</TabsTrigger>
            <TabsTrigger value="analyses" className="flex-1">Análises ({analyses.length})</TabsTrigger>
            <TabsTrigger value="entities" className="flex-1">Entidades ({entities.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="transcript" className="space-y-2 mt-4">
            {transcript.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center py-8">Sem transcript registrado</div>
            ) : transcript.map((t, idx) => (
              <div key={idx} className={`text-xs ${t.speaker === 'vendedor' ? 'pl-0' : 'pl-8'}`}>
                <span className={`font-medium ${t.speaker === 'vendedor' ? 'text-blue-700' : 'text-emerald-700'}`}>
                  [{t.speaker.toUpperCase()}]
                </span>{' '}
                {t.text}
              </div>
            ))}
          </TabsContent>

          <TabsContent value="analyses" className="space-y-3 mt-4">
            {analyses.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center py-8">Sem análises do copilot</div>
            ) : analyses.map((a, idx) => (
              <div key={idx} className="rounded-md border border-border p-2.5 space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-2xs">{a.playbook}</Badge>
                  <Badge variant="outline" className="text-2xs">{a.spinStage}</Badge>
                  <span className="text-2xs text-muted-foreground">{Math.round(a.confidence * 100)}%</span>
                </div>
                <blockquote className="text-xs italic border-l-2 border-status-success pl-2">
                  "{a.nextBestAction.exactPhrasing}"
                </blockquote>
                {a.nextBestAction.commercialInsight && (
                  <div className="text-2xs text-amber-700 dark:text-amber-300">
                    💡 {a.nextBestAction.commercialInsight.dataPoint}
                  </div>
                )}
                {a.ticketLeverage.tactic !== 'none' && (
                  <div className="text-2xs text-orange-700 dark:text-orange-300">
                    💰 {a.ticketLeverage.suggestion}
                  </div>
                )}
              </div>
            ))}
          </TabsContent>

          <TabsContent value="entities" className="space-y-3 mt-4">
            {entities.length === 0 ? (
              <div className="text-xs text-muted-foreground text-center py-8">Sem entidades extraídas</div>
            ) : Object.entries(entitiesByType).map(([type, items]) => (
              <div key={type} className="space-y-1">
                <div className="text-2xs uppercase tracking-wide text-muted-foreground">
                  {ENTITY_TYPE_LABEL[type] ?? type}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {items.map((e, idx) => (
                    <Badge key={idx} variant="outline" className="text-2xs" title={e.context}>
                      {e.value} {e.occurrences > 1 && <span className="ml-1 opacity-60">×{e.occurrences}</span>}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}
