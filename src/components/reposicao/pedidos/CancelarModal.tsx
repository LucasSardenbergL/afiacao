import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { PedidoSugerido } from './types';

export function CancelarModal({
  pedido,
  open,
  onOpenChange,
}: {
  pedido: PedidoSugerido | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [justificativa, setJustificativa] = useState('');

  useEffect(() => {
    if (!open) setJustificativa('');
  }, [open]);

  const cancelarMutation = useMutation({
    mutationFn: async () => {
      if (!pedido) return;
      const { error } = await supabase.rpc('cancelar_pedido_sugerido', {
        p_pedido_id: pedido.id,
        p_usuario: user?.email ?? 'sistema',
        p_justificativa: justificativa.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Pedido cancelado');
      queryClient.invalidateQueries({ queryKey: ['pedidos-ciclo'] });
      onOpenChange(false);
    },
    onError: (e: Error) => {
      toast.error(`Erro ao cancelar: ${e.message}`);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancelar pedido #{pedido?.id}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-sm font-medium">Justificativa <span className="text-destructive">*</span></label>
          <Textarea
            value={justificativa}
            onChange={(e) => setJustificativa(e.target.value)}
            placeholder="Explique o motivo do cancelamento..."
            rows={4}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Voltar</Button>
          <Button
            variant="destructive"
            disabled={!justificativa.trim() || cancelarMutation.isPending}
            onClick={() => cancelarMutation.mutate()}
          >
            {cancelarMutation.isPending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            Confirmar cancelamento
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
