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

// Confirmação em LOTE: mesma semântica de N remoções individuais (delete + recálculo do
// cabeçalho; pedido vazio cancela), mas com UMA confirmação. Lista até 5 SKUs + excedente.
export function RemoverItensLoteDialog({
  itens,
  onOpenChange,
  pending,
  onConfirm,
}: {
  itens: PedidoItem[] | null;
  onOpenChange: (v: boolean) => void;
  pending: boolean;
  onConfirm: () => void;
}) {
  const lista = itens ?? [];
  const n = lista.length;
  const rotulo = `${n} ${n === 1 ? 'item' : 'itens'}`;
  return (
    <AlertDialog open={n > 0} onOpenChange={(v) => !v && onOpenChange(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remover {rotulo} do pedido?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              <ul className="list-disc pl-5 space-y-0.5">
                {lista.slice(0, 5).map((it) => (
                  <li key={it.id}>
                    <span className="font-mono">{it.sku_codigo_omie}</span> — {it.sku_descricao ?? '—'}
                  </li>
                ))}
              </ul>
              {n > 5 && <p className="mt-1">+{n - 5} outro(s)</p>}
              <p className="mt-2">
                O valor total do pedido será recalculado. Se remover todos os itens, o pedido será
                cancelado automaticamente.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={onConfirm}>
            {pending && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            Remover {rotulo}
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
