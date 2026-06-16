// Drawer (Sheet) com detalhes de um alerta de notificação.
// Extraído verbatim de src/pages/AdminNotificacoes.tsx (god-component split).
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { Mail, Calendar as CalendarIcon, ExternalLink, AlertCircle } from 'lucide-react';
import { SeveridadeBadge, StatusBadge } from './badges';
import { fmtDate } from './format';
import type { AlertaRow } from './types';

interface AlertaDrawerProps {
  alerta: AlertaRow | null;
  onOpenChange: (open: boolean) => void;
}

export function AlertaDrawer({ alerta: drawerAlerta, onOpenChange }: AlertaDrawerProps) {
  return (
    <Sheet open={!!drawerAlerta} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto sm:max-w-lg">
        {drawerAlerta && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <SeveridadeBadge s={drawerAlerta.severidade} />
                <span className="truncate">{drawerAlerta.titulo}</span>
              </SheetTitle>
            </SheetHeader>

            <div className="space-y-4 mt-4 text-sm">
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">{drawerAlerta.empresa}</Badge>
                <Badge variant="secondary">{drawerAlerta.tipo}</Badge>
                <StatusBadge s={drawerAlerta.status} />
              </div>

              {drawerAlerta.fornecedor_nome && (
                <div><span className="font-medium">Fornecedor: </span>{drawerAlerta.fornecedor_nome}</div>
              )}

              <div>
                <div className="font-medium mb-1">Mensagem</div>
                <div className="whitespace-pre-wrap text-muted-foreground">
                  {drawerAlerta.mensagem || '(sem mensagem)'}
                </div>
              </div>

              {drawerAlerta.data_evento && (
                <div>
                  <span className="font-medium">Evento agendado: </span>
                  {fmtDate(drawerAlerta.data_evento)}
                </div>
              )}

              {drawerAlerta.metadata && Object.keys(drawerAlerta.metadata).length > 0 && (
                <div>
                  <div className="font-medium mb-1">Metadata</div>
                  <pre className="bg-muted rounded p-2 text-xs overflow-x-auto">
                    {JSON.stringify(drawerAlerta.metadata, null, 2)}
                  </pre>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
                <div><div className="font-medium text-foreground">Criado</div>{fmtDate(drawerAlerta.criado_em)}</div>
                <div><div className="font-medium text-foreground">Notificado</div>{fmtDate(drawerAlerta.notificado_em)}</div>
                <div><div className="font-medium text-foreground">Tentativas</div>{drawerAlerta.tentativas ?? 0}/3</div>
                <div><div className="font-medium text-foreground">Alerta ID</div>{drawerAlerta.id}</div>
              </div>

              <div className="flex flex-wrap gap-2 pt-2">
                {drawerAlerta.gmail_message_id && (
                  <Button asChild variant="outline" size="sm">
                    <a
                      href={`https://mail.google.com/mail/u/0/#all/${drawerAlerta.gmail_message_id}`}
                      target="_blank" rel="noreferrer"
                    >
                      <Mail className="w-3 h-3 mr-1" /> Abrir no Gmail <ExternalLink className="w-3 h-3 ml-1" />
                    </a>
                  </Button>
                )}
                {drawerAlerta.calendar_evento_id && (
                  <Button asChild variant="outline" size="sm">
                    <a
                      href={`https://calendar.google.com/calendar/u/0/r/eventedit/${drawerAlerta.calendar_evento_id}`}
                      target="_blank" rel="noreferrer"
                    >
                      <CalendarIcon className="w-3 h-3 mr-1" /> Abrir no Calendar <ExternalLink className="w-3 h-3 ml-1" />
                    </a>
                  </Button>
                )}
              </div>

              {drawerAlerta.erro_notificacao && (
                <div className="border border-destructive/30 bg-destructive/5 rounded p-3">
                  <div className="flex items-center gap-2 font-medium text-destructive mb-1">
                    <AlertCircle className="w-4 h-4" /> Erro de notificação
                  </div>
                  <div className="text-xs text-destructive/80 whitespace-pre-wrap">
                    {drawerAlerta.erro_notificacao}
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
