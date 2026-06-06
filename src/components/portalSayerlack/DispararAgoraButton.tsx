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
import { isLensActive } from '@/lib/impersonation/lens-write-guard';

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
    ? `Vai enviar o pedido #${pedidoId} ao portal Sayerlack em segundo plano. A lista atualiza sozinha quando terminar (geralmente 30–90s). Confirmar?`
    : 'Isso vai disparar até 5 pedidos pendentes em paralelo, em segundo plano. A lista atualiza sozinha quando cada um terminar. Confirmar?';

  const handleClick = async () => {
    // Esta tela dispara um POST CRU pra edge function (não passa pelo write-guard do
    // client supabase, que só cobre PostgREST/storage/functions.invoke/rpc). Na lente
    // "ver como pessoa" (read-only), isso efetivaria um pedido REAL no portal Sayerlack
    // como o master → bloqueia explicitamente aqui.
    if (isLensActive()) {
      toast.error('Disparo indisponível na lente (somente leitura). Saia da lente para enviar.');
      setOpen(false);
      return;
    }
    setLoading(true);
    setOpen(false);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token ?? ANON_KEY;
      // Modo async: edge function retorna 202 em <2s e processa em background.
      // Não precisa de timeout longo aqui.
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 15_000);

      const payload: Record<string, unknown> = { async_mode: true };
      if (isIndividual) payload.pedido_id = pedidoId;

      const res = await fetch(
        `${SUPABASE_URL}/functions/v1/enviar-pedido-portal-sayerlack`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            apikey: ANON_KEY,
          },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        },
      );
      clearTimeout(timeout);

      const body = await res.json().catch(() => ({}));

      if (!res.ok && res.status !== 202) {
        toast.error(`Falha: ${body?.error ?? res.statusText}`);
      } else {
        const ids: number[] = Array.isArray(body?.pedido_ids) ? body.pedido_ids : [];
        if (ids.length === 0) {
          toast.info('Nenhum pedido pendente para disparar.');
        } else {
          toast.success(
            isIndividual
              ? `Pedido #${ids[0]} em processamento. Acompanhe na lista (atualiza sozinho).`
              : `${ids.length} pedido(s) em processamento. A lista atualiza sozinha conforme cada um terminar.`,
            { duration: 6000 },
          );
        }
        onSuccess?.();
      }
    } catch (err) {
      toast.error(`Falha ao disparar: ${err instanceof Error ? err.message : String(err)}`);
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
