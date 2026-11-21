import { useState } from 'react';
import { AlertTriangle, Clock, RotateCw, Trash2 } from 'lucide-react';
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
  /** Há um envio deste checkout ainda amarrado (parcial/bloqueado). Descartar pede confirmação:
   *  o próximo pedido passa a ser NOVO, mesmo idêntico ao pendente. */
  envioPendente?: boolean;
}

export function RestoreDraftDialog({
  open,
  savedAt,
  customerName,
  itemCount,
  onRestore,
  onDiscard,
  envioPendente = false,
}: RestoreDraftDialogProps) {
  const [confirmandoDescarte, setConfirmandoDescarte] = useState(false);
  const ago = (() => {
    try {
      return formatDistanceToNow(new Date(savedAt), { locale: ptBR, addSuffix: true });
    } catch {
      return savedAt;
    }
  })();

  if (confirmandoDescarte) {
    return (
      <AlertDialog open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-status-warning" />
              Há um envio pendente para este pedido
            </AlertDialogTitle>
            <AlertDialogDescription>
              Parte deste pedido já foi enviada ao Omie. Se você descartar, o próximo pedido será tratado
              como <strong>NOVO</strong> — mesmo que seja igual — e o que já foi enviado não será reconhecido.
              Para concluir o pendente, volte e restaure.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmandoDescarte(false)}>Voltar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setConfirmandoDescarte(false); onDiscard(); }}
              className="gap-2 bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              <Trash2 className="w-4 h-4" />
              Descartar mesmo assim
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

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
          <AlertDialogCancel
            onClick={envioPendente ? () => setConfirmandoDescarte(true) : onDiscard}
            className="gap-2"
          >
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
