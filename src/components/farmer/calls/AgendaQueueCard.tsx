// Fila de "Próximas ligações" (agenda priorizada) da página de Ligações.
// Extraída de src/pages/FarmerCalls.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { PhoneCall, Loader2, CheckCircle, Phone, FileText, AlertTriangle, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Dialer } from '@/components/call/Dialer';
import type { AgendaItem, ClientScore } from '@/hooks/useFarmerScoring';
import { AGENDA_TYPE_META } from './types';

type DialerEndData = { duration: number; state: string; audioLink: string | null };

export function AgendaQueueCard({
  agenda, clientScores, agendaLoading, erro, onRetry, onCallEnd, onRegister,
}: {
  agenda: AgendaItem[];
  clientScores: ClientScore[];
  agendaLoading: boolean;
  /**
   * Falha da leitura do scoring (`useFarmerScoring.erro`). Sem ela, `agenda === []` por falha de
   * transporte caía no empty state de SUCESSO abaixo — um check verde dizendo "Nenhuma ligação
   * pendente na agenda. Bom trabalho!". Parabenização FABRICADA, na tela cujo propósito é a
   * fila de ligações (§7 do money-path: nunca zero fabricado; aqui, nunca um elogio fabricado).
   */
  erro?: string | null;
  onRetry?: () => void;
  onCallEnd: (item: AgendaItem, phone: string, data: DialerEndData) => void;
  onRegister: (item: AgendaItem, phone: string | null | undefined) => void;
}) {
  // Com fila em mãos o erro é de RELEITURA: mantém a fila e avisa que pode estar velha
  // (último dado bom + aviso de stale). Sem fila, "indisponível com o motivo" + retry.
  const semAgendaLida = !!erro && agenda.length === 0;
  const agendaPodeEstarVelha = !!erro && agenda.length > 0;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <PhoneCall className="w-4 h-4 text-primary" />
          Próximas ligações
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {agendaPodeEstarVelha && (
          <div
            role="alert"
            data-testid="aviso-agenda-stale"
            className="flex items-center gap-2 rounded-md border border-status-warning/30 bg-status-warning/5 px-3 py-2 text-xs text-status-warning"
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">A última leitura da carteira falhou — a fila abaixo pode estar desatualizada.</span>
            {onRetry && (
              <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-xs" onClick={onRetry}>
                <RefreshCw className="h-3 w-3 mr-1" />
                Tentar novamente
              </Button>
            )}
          </div>
        )}
        {agendaLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : semAgendaLida ? (
          <div
            role="alert"
            data-testid="aviso-agenda"
            className="rounded-md border border-status-error/30 bg-status-error/5 p-3 space-y-2"
          >
            <p className="text-sm">
              Não consegui ler a sua carteira — a fila de ligações fica indisponível até a
              leitura voltar. Isto NÃO quer dizer que não há ninguém para ligar.
            </p>
            {onRetry && (
              <Button size="sm" variant="outline" onClick={onRetry}>
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                Tentar novamente
              </Button>
            )}
          </div>
        ) : agenda.length === 0 ? (
          <div className="text-center py-6">
            <CheckCircle className="w-6 h-6 mx-auto mb-2 text-primary/60" />
            <p className="text-sm text-muted-foreground">Nenhuma ligação pendente na agenda. Bom trabalho!</p>
          </div>
        ) : (
          agenda.slice(0, 5).map(item => {
            const meta = AGENDA_TYPE_META[item.agendaType] || AGENDA_TYPE_META.follow_up;
            const Icon = meta.icon;
            const score = clientScores.find(c => c.customer_user_id === item.customer_user_id);
            const phone = score?.customer_phone;

            return (
              <div key={item.customer_user_id} className="flex items-center gap-3 rounded-lg border p-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <p className="text-sm font-medium truncate">{item.customer_name}</p>
                    <Badge variant="outline" className={cn('text-[10px] shrink-0', meta.color)}>
                      <Icon className="w-3 h-3 mr-0.5" /> {meta.label}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>Prioridade: {item.priorityScore.toFixed(1)}</span>
                    {phone && (
                      <>
                        <span>·</span>
                        <span>{phone}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {phone ? (
                    <Dialer
                      phoneNumber={phone}
                      customerName={item.customer_name}
                      compact
                      onCallEnd={(data) => onCallEnd(item, phone, data)}
                    />
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span><Button size="icon" variant="ghost" className="h-8 w-8" disabled><Phone className="w-4 h-4" /></Button></span>
                      </TooltipTrigger>
                      <TooltipContent><p className="text-xs">Sem telefone cadastrado</p></TooltipContent>
                    </Tooltip>
                  )}
                  <Button size="sm" variant="outline" className="h-8 text-xs gap-1" onClick={() => onRegister(item, phone)}>
                    <FileText className="w-3 h-3" /> Registrar
                  </Button>
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
