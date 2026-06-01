import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, MessageCircle, PhoneMissed, Ban, ClipboardCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useRegistrarContato, useDesfazerContato } from '@/queries/useRegistrarContato';
import type { OutcomeStatus } from '@/lib/route/route-outcome';

const LABEL: Record<OutcomeStatus, string> = {
  convertido: 'Pedido registrado ✓',
  respondido: 'Marcado: vai pensar',
  sem_resposta: 'Marcado: não atendeu',
  opt_out: 'Cliente não quer mais ligações',
};

interface OutcomeMenuProps {
  customerUserId: string;
  customerName: string;
  dataRota: string;        // 'yyyy-mm-dd' (a data_rota da fila)
  bucket?: string | null;
  valor?: number | null;
}

/** Menu de resultado da ligação (closed-loop PR2c). 1 toque → grava em route_contact_log via RPC. */
export function OutcomeMenu({ customerUserId, customerName, dataRota, bucket, valor }: OutcomeMenuProps) {
  const reg = useRegistrarContato();
  const undo = useDesfazerContato();
  const [confirmOptOut, setConfirmOptOut] = useState(false);

  const registrar = async (status: OutcomeStatus) => {
    try {
      const r = await reg.mutateAsync({ customerUserId, status, dataRota, bucket, valor });
      if (!r.deduped) {
        toast.success(LABEL[status], {
          action: {
            label: 'Desfazer',
            onClick: async () => {
              const u = await undo.mutateAsync(r.id);
              toast[u.deleted ? 'success' : 'error'](u.deleted ? 'Registro desfeito' : 'Não foi possível desfazer');
            },
          },
        });
      }
    } catch {
      toast.error('Não foi possível registrar o resultado');
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8" title="Registrar resultado" disabled={reg.isPending}>
            <ClipboardCheck className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => registrar('convertido')}>
            <CheckCircle2 className="w-4 h-4 mr-2 text-status-success-bold" /> Fechou pedido
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => registrar('respondido')}>
            <MessageCircle className="w-4 h-4 mr-2" /> Falou, vai pensar
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => registrar('sem_resposta')}>
            <PhoneMissed className="w-4 h-4 mr-2" /> Não atendeu
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setConfirmOptOut(true)} className="text-status-error">
            <Ban className="w-4 h-4 mr-2" /> Não quer ser ligado
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOptOut} onOpenChange={setConfirmOptOut}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Não ligar novamente para {customerName}?</AlertDialogTitle>
            <AlertDialogDescription>
              O cliente sai da fila de ligação permanentemente. A reversão é feita pelo gestor.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => registrar('opt_out')}>Confirmar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
