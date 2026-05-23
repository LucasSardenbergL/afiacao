import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetFooter } from '@/components/ui/sheet';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { format, formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { AlertTriangle, Loader2, RotateCw } from 'lucide-react';
import { PedidoSugerido, StatusEnvioPortal } from './types';
import { portalStatusMeta } from './shared';

export function PortalDrawer({
  pedido,
  open,
  onOpenChange,
}: {
  pedido: PedidoSugerido | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { isAdmin } = useAuth();
  const [confirmReenvio, setConfirmReenvio] = useState(false);

  const reenviarMutation = useMutation({
    mutationFn: async () => {
      if (!pedido) return;
      const { error } = await supabase
        .from('pedido_compra_sugerido')
        .update({
          status_envio_portal: 'pendente_envio_portal',
          portal_tentativas: 0,
          portal_proximo_retry_em: null,
          portal_erro: null,
        })
        .eq('id', pedido.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Pedido marcado para reenvio. O cron / disparo manual fará o envio.');
      queryClient.invalidateQueries({ queryKey: ['pedidos-ciclo'] });
      setConfirmReenvio(false);
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(`Erro ao marcar reenvio: ${e.message}`),
  });

  if (!pedido) return null;
  const status = (pedido.status_envio_portal ?? 'nao_aplicavel') as StatusEnvioPortal;
  const tentativas = pedido.portal_tentativas ?? 0;
  const tentativasColor =
    tentativas <= 1 ? 'text-status-success' : tentativas === 2 ? 'text-status-warning' : 'text-destructive';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Detalhes do envio ao portal</SheetTitle>
          <SheetDescription>
            Pedido #{pedido.id} — {pedido.fornecedor_nome}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 py-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-muted-foreground text-xs">Status</div>
              <div className="mt-1">
                <Badge className={portalStatusMeta[status].className} variant="outline">
                  {portalStatusMeta[status].label}
                </Badge>
              </div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Protocolo do portal</div>
              <div className="font-mono font-medium">{pedido.portal_protocolo ?? '—'}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Enviado em</div>
              <div className="font-medium">
                {pedido.enviado_portal_em ? format(new Date(pedido.enviado_portal_em), 'dd/MM/yyyy HH:mm') : '—'}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Tentativas</div>
              <div className={`font-bold tabular-nums ${tentativasColor}`}>{tentativas}</div>
            </div>
            <div className="col-span-2">
              <div className="text-muted-foreground text-xs">Próximo retry</div>
              <div className="font-medium">
                {pedido.portal_proximo_retry_em
                  ? `próximo retry ${formatDistanceToNow(new Date(pedido.portal_proximo_retry_em), { addSuffix: true, locale: ptBR })}`
                  : '—'}
              </div>
            </div>
          </div>

          {pedido.portal_screenshot_url && (
            <div>
              <div className="text-muted-foreground text-xs mb-1">Screenshot do portal</div>
              <a href={pedido.portal_screenshot_url} target="_blank" rel="noreferrer">
                <img
                  src={pedido.portal_screenshot_url}
                  alt="Confirmação do portal"
                  className="rounded border max-h-72 w-auto"
                />
              </a>
            </div>
          )}

          {pedido.portal_erro && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Erro mais recente</AlertTitle>
              <AlertDescription className="whitespace-pre-wrap break-words">{pedido.portal_erro}</AlertDescription>
            </Alert>
          )}

          {pedido.portal_resposta != null && (
            <details className="rounded border bg-muted/30 p-3 text-xs">
              <summary className="cursor-pointer font-medium">Payload bruto da última tentativa</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-snug">
                {JSON.stringify(pedido.portal_resposta, null, 2)}
              </pre>
            </details>
          )}
        </div>

        <SheetFooter className="gap-2 flex-col sm:flex-row">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Fechar</Button>
          {isAdmin && status !== 'nao_aplicavel' && (
            <Button
              variant="secondary"
              onClick={() => setConfirmReenvio(true)}
              disabled={reenviarMutation.isPending}
            >
              <RotateCw className="w-4 h-4 mr-1" />
              Forçar reenvio ao portal
            </Button>
          )}
        </SheetFooter>

        <AlertDialog open={confirmReenvio} onOpenChange={setConfirmReenvio}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Forçar reenvio ao portal?</AlertDialogTitle>
              <AlertDialogDescription>
                Isso vai reenviar o pedido #{pedido.id} ao portal Sayerlack. Use apenas se você confirmou que o envio anterior não chegou. Confirmar?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={reenviarMutation.isPending}>Cancelar</AlertDialogCancel>
              <AlertDialogAction
                disabled={reenviarMutation.isPending}
                onClick={() => reenviarMutation.mutate()}
              >
                {reenviarMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                Confirmar reenvio
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  );
}
