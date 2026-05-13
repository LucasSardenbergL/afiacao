import { Clock, RotateCw, Trash2 } from 'lucide-react';
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
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';

interface RestoreDraftDialogProps {
  open: boolean;
  savedAt: string;
  customerName?: string;
  itemCount?: number;
  onRestore: () => void;
  onDiscard: () => void;
}

export function RestoreDraftDialog({
  open,
  savedAt,
  customerName,
  itemCount,
  onRestore,
  onDiscard,
}: RestoreDraftDialogProps) {
  const ago = (() => {
    try {
      return formatDistanceToNow(new Date(savedAt), { locale: ptBR, addSuffix: true });
    } catch {
      return savedAt;
    }
  })();

  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-muted-foreground" />
            Restaurar pedido em andamento?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Você tinha um pedido aberto {customerName ? <strong>com {customerName}</strong> : null}
            {itemCount !== undefined && itemCount > 0 ? (
              <> contendo <strong>{itemCount} {itemCount === 1 ? 'item' : 'itens'}</strong></>
            ) : null}
            , salvo automaticamente {ago}.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onDiscard} className="gap-2">
            <Trash2 className="w-4 h-4" />
            Descartar
          </AlertDialogCancel>
          <AlertDialogAction onClick={onRestore} className="gap-2">
            <RotateCw className="w-4 h-4" />
            Restaurar
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
