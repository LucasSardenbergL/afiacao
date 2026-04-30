import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Zap, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';

interface Props {
  onSuccess?: () => void;
  pedidoId?: number; // se fornecido, modo individual
  label?: string;
  variant?: 'default' | 'outline';
  size?: 'default' | 'sm';
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

export function DispararAgoraButton({
  onSuccess, pedidoId, label, variant = 'default', size = 'default',
}: Props) {
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const isIndividual = typeof pedidoId === 'number';
  const buttonLabel = label ?? (isIndividual ? 'Disparar este pedido agora' : 'Disparar agora');
  const dialogMsg = isIndividual
    ? `Vai tentar enviar o pedido #${pedidoId} ao portal Sayerlack agora. Pode levar 30–60 segundos. Confirmar?`
    : 'Isso vai processar até 5 pedidos pendentes em sequência. Cada pedido pode levar 30–60 segundos. Confirmar?';

  const handleClick = async () => {
    setLoading(true);
    setOpen(false);
    const t = toast.loading(isIndividual ? `Enviando pedido #${pedidoId}…` : 'Disparando lote…');
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token ?? ANON_KEY;
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 600_000);

      const res = await fetch(
        `${SUPABASE_URL}/functions/v1/enviar-pedido-portal-sayerlack`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            apikey: ANON_KEY,
          },
          body: JSON.stringify(isIndividual ? { pedido_id: pedidoId } : {}),
          signal: ctrl.signal,
        },
      );
      clearTimeout(timeout);

      const body = await res.json().catch(() => ({}));
      toast.dismiss(t);

      if (!res.ok) {
        toast.error(`Falha: ${body?.error ?? res.statusText}`);
      } else {
        const proc = body?.processados ?? (isIndividual ? 1 : 0);
        const ok = body?.sucesso ?? (body?.status === 'enviado_portal' ? 1 : 0);
        const fail = body?.falhas ?? (body?.status === 'falha_envio_portal' ? 1 : 0);
        toast.success(`${proc} processado(s), ${ok} sucesso, ${fail} falha(s)`);
        onSuccess?.();
      }
    } catch (err: any) {
      toast.dismiss(t);
      toast.error(`Falha ao chamar edge function: ${err?.message ?? err}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant={variant} size={size} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Zap className="h-4 w-4 mr-2" />}
          {buttonLabel}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Confirmar envio</AlertDialogTitle>
          <AlertDialogDescription>{dialogMsg}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={handleClick}>Confirmar</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
