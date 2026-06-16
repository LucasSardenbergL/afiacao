// Dialogs de confirmação: remover linha e remover + descontinuar SKU.
// Extraídos verbatim de src/components/reposicao/pedidos/DetalhesModal.tsx (god-component split).
import { Loader2 } from 'lucide-react';
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
import { PedidoItem } from './types';

export function RemoverItemDialog({
  item,
  onOpenChange,
  pending,
  onConfirm,
}: {
  item: PedidoItem | null;
  onOpenChange: (v: boolean) => void;
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={!!item} onOpenChange={(v) => !v && onOpenChange(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remover este item do pedido?</AlertDialogTitle>
          <AlertDialogDescription>
            SKU <span className="font-mono">{item?.sku_codigo_omie}</span> — {item?.sku_descricao ?? '—'}.
            <br />O valor total do pedido será recalculado. Se for o último item, o pedido será cancelado automaticamente.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={onConfirm}>
            {pending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            Remover
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DescontinuarItemDialog({
  item,
  onOpenChange,
  pending,
  onConfirm,
}: {
  item: PedidoItem | null;
  onOpenChange: (v: boolean) => void;
  pending: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={!!item} onOpenChange={(v) => !v && onOpenChange(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Descontinuar SKU permanentemente?</AlertDialogTitle>
          <AlertDialogDescription>
            SKU <span className="font-mono">{item?.sku_codigo_omie}</span> — {item?.sku_descricao ?? '—'}.
            <br />
            <strong className="text-destructive">Tem certeza?</strong> Este SKU não será mais incluído em ciclos futuros de reposição automática.
            A linha também será removida deste pedido.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Voltar</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={onConfirm}
          >
            {pending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            Descontinuar e remover
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
