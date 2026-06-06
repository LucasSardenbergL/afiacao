import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { format, formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { AlertTriangle, CheckCircle2, Loader2, RotateCw } from 'lucide-react';
import { PedidoSugerido, StatusEnvioPortal } from './types';
import { portalStatusMeta, decidirAcaoPortal } from './shared';

const PROTOCOLO_RE = /^\d{3,12}$/;

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
  const [conciliarOpen, setConciliarOpen] = useState(false);
  const [conciliarProtocolo, setConciliarProtocolo] = useState('');

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['pedidos-ciclo'] });
  };

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
      invalidate();
      setConfirmReenvio(false);
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(`Erro ao marcar reenvio: ${e.message}`),
  });

  // Conciliação inline: reusa a edge `conciliar-pedido-portal` (mesma lógica que vivia
  // no PortalDetailDrawer da tela /admin/portal-sayerlack, aposentada no 3c).
  // A edge marca sucesso_portal + protocolo e dispara o Omie — com guard anti-PO-duplo
  // (não recria o PO se o pedido já tem omie_pedido_compra_id).
  const conciliarMutation = useMutation({
    mutationFn: async () => {
      if (!pedido) return null;
      const protocolo = conciliarProtocolo.trim();
      if (!PROTOCOLO_RE.test(protocolo)) {
        throw new Error('Protocolo deve ser numérico com 3 a 12 dígitos.');
      }
      const { data, error } = await supabase.functions.invoke('conciliar-pedido-portal', {
        body: { pedido_id: pedido.id, protocolo },
      });
      if (error) throw error;
      return { data, protocolo };
    },
    onSuccess: (res) => {
      if (!res || !pedido) return;
      const { data, protocolo } = res;
      const omie = data?.omie as
        | { ok?: boolean; skipped?: boolean; httpStatus?: number }
        | undefined;
      if (data?.already) {
        toast.success(`Pedido #${pedido.id} já estava conciliado com protocolo ${protocolo}.`);
      } else if (omie?.skipped) {
        toast.success(
          `Pedido #${pedido.id} conciliado com protocolo ${protocolo}. O pedido de compra já existia no Omie — não foi recriado.`,
        );
      } else if (omie?.ok === false) {
        toast.warning(
          `Pedido #${pedido.id} marcado como enviado, mas o disparo do Omie devolveu HTTP ${omie?.httpStatus}. Confira no Omie.`,
        );
      } else {
        toast.success(`Pedido #${pedido.id} conciliado com protocolo ${protocolo}. Omie disparado.`);
      }
      setConciliarOpen(false);
      setConciliarProtocolo('');
      invalidate();
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(`Falha ao conciliar: ${e.message}`),
  });

  if (!pedido) return null;
  const status = (pedido.status_envio_portal ?? 'nao_aplicavel') as StatusEnvioPortal;
  const acao = decidirAcaoPortal(status);
  const protocoloValido = PROTOCOLO_RE.test(conciliarProtocolo.trim());
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

          {/* Conciliação: instrução + aviso de risco quando ambíguo. */}
          {acao.kind === 'conciliar' && (
            <Alert variant={acao.warn ? 'destructive' : 'default'}>
              {acao.warn ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
              <AlertTitle>
                {acao.warn ? 'Confira no portal ANTES de conciliar' : 'Requer conciliação manual'}
              </AlertTitle>
              <AlertDescription>
                {acao.warn ? (
                  <>
                    O resultado do envio ficou <strong>ambíguo</strong> — o pedido <strong>pode já existir</strong> no
                    portal Sayerlack (risco de duplicar). Confira no portal ANTES de conciliar. Se ele já está lá,
                    copie o número e concilie abaixo. Se NÃO está, NÃO concilie — use "Forçar reenvio".
                  </>
                ) : (
                  <>
                    O portal aceitou o pedido mas não devolveu o número automaticamente. Confira no portal Sayerlack,
                    copie o número e concilie abaixo — isso registra o protocolo e o pedido no Omie.
                  </>
                )}
              </AlertDescription>
            </Alert>
          )}

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

          {/* Estado de conciliação → Conciliar (NUNCA reenvio cego: risco de PO duplo). */}
          {acao.kind === 'conciliar' && (
            <Button
              variant="default"
              className="bg-status-warning-bold hover:bg-status-warning-bold/90"
              onClick={() => setConciliarOpen(true)}
              disabled={conciliarMutation.isPending}
            >
              <CheckCircle2 className="w-4 h-4 mr-1" />
              Conciliar manualmente
            </Button>
          )}

          {/* Erro genuíno sem PO criado → reenvio é seguro (somente admin). */}
          {acao.kind === 'reenviar' && isAdmin && (
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

        {/* Dialog de conciliação inline */}
        <Dialog
          open={conciliarOpen}
          onOpenChange={(o) => {
            setConciliarOpen(o);
            if (!o) setConciliarProtocolo('');
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Conciliar pedido #{pedido.id}</DialogTitle>
              <DialogDescription>
                Informe o número do pedido como aparece no portal Sayerlack ("Pedido <strong>NNNNN</strong> criado com
                sucesso"). Após confirmar, o sistema marca como enviado e registra no Omie (sem recriar o pedido se ele
                já existir lá).
              </DialogDescription>
            </DialogHeader>
            {acao.kind === 'conciliar' && acao.warn && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  Confira no portal Sayerlack ANTES de conciliar — o pedido pode já existir lá (risco de duplicar).
                </AlertDescription>
              </Alert>
            )}
            <div className="space-y-2">
              <Label htmlFor="conciliar-protocolo">Número do protocolo</Label>
              <Input
                id="conciliar-protocolo"
                inputMode="numeric"
                pattern="\d*"
                placeholder="Ex.: 123456"
                value={conciliarProtocolo}
                onChange={(e) => setConciliarProtocolo(e.target.value.replace(/\D/g, ''))}
                disabled={conciliarMutation.isPending}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">Apenas dígitos, entre 3 e 12 caracteres.</p>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setConciliarOpen(false)}
                disabled={conciliarMutation.isPending}
              >
                Cancelar
              </Button>
              <Button
                onClick={() => conciliarMutation.mutate()}
                disabled={conciliarMutation.isPending || !protocoloValido}
              >
                {conciliarMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                Confirmar e registrar no Omie
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

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
