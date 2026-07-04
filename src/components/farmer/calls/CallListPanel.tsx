// Lista de ligações + painel de detalhe (split estilo Gong) da página de Ligações.
// Extraído de src/pages/FarmerCalls.tsx (god-component split).
import { memo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Filter, Loader2, Phone, Clock, ChevronRight } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { CallDetailPanel } from './CallDetailPanel';
import { CALL_TYPES, CALL_RESULTS, fmt, formatTimer, type CallLog } from './types';

// memo: o pai (FarmerCalls) re-renderiza a 1Hz durante chamada ativa (cronômetro);
// com props estáveis (filteredLogs memoizado + setters), a lista não re-renderiza.
export const CallListPanel = memo(function CallListPanel({
  filterType, setFilterType, filteredLogs, loadingLogs, selectedCall, setSelectedCall,
}: {
  filterType: string;
  setFilterType: (s: string) => void;
  filteredLogs: CallLog[];
  loadingLogs: boolean;
  selectedCall: CallLog | null;
  setSelectedCall: (c: CallLog | null) => void;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
      {/* Call List */}
      <div className={cn('space-y-2', selectedCall ? 'lg:col-span-2' : 'lg:col-span-5')}>
        {/* Filters */}
        <div className="flex items-center gap-2">
          <Select value={filterType} onValueChange={setFilterType}>
            <SelectTrigger className="h-8 w-auto text-xs">
              <Filter className="w-3 h-3 mr-1" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os tipos</SelectItem>
              {CALL_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground ml-auto">{filteredLogs.length} ligações</span>
        </div>

        {loadingLogs ? (
          <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : filteredLogs.length === 0 ? (
          <Card><CardContent className="py-12 text-center">
            <Phone className="w-8 h-8 mx-auto mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">Nenhuma ligação registrada</p>
          </CardContent></Card>
        ) : (
          filteredLogs.map(log => {
            const typeInfo = CALL_TYPES.find(t => t.value === log.call_type);
            const resultInfo = CALL_RESULTS.find(r => r.value === log.call_result);
            const isSelected = selectedCall?.id === log.id;

            return (
              <Card key={log.id} className={cn('cursor-pointer transition-colors hover:border-primary/30', isSelected && 'border-primary ring-1 ring-primary/20')}
                onClick={() => setSelectedCall(isSelected ? null : log)}>
                <CardContent className="p-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-sm font-medium truncate">{log.customer_name}</p>
                        <Badge variant="outline" className={cn('text-[10px] shrink-0', typeInfo?.color)}>
                          {typeInfo?.label}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{resultInfo?.icon} {resultInfo?.label}</span>
                        <span>·</span>
                        <span><Clock className="w-3 h-3 inline mr-0.5" />{formatTimer(log.duration_seconds)}</span>
                      </div>
                      {Number(log.revenue_generated) > 0 && (
                        <p className="text-xs font-medium mt-1 status-success inline-block px-1.5 py-0.5 rounded">
                          {fmt(Number(log.revenue_generated))}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <span className="text-xs text-muted-foreground">
                        {format(new Date(log.created_at), 'dd/MM HH:mm', { locale: ptBR })}
                      </span>
                      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      {/* Detail panel (Gong-style) */}
      {selectedCall && (
        <div className="lg:col-span-3">
          <Card>
            <CardContent className="p-4">
              <CallDetailPanel call={selectedCall} onClose={() => setSelectedCall(null)} />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
});
