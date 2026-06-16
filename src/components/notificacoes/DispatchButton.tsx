// Botão "Disparar agora" com confirmação (AlertDialog).
// Extraído verbatim de src/pages/AdminNotificacoes.tsx (god-component split).
import { Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

interface DispatchButtonProps {
  isPending: boolean;
  onDispatch: () => void;
}

export function DispatchButton({ isPending, onDispatch }: DispatchButtonProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button disabled={isPending}>
          <Zap className="w-4 h-4 mr-2" />
          {isPending ? 'Disparando...' : 'Disparar agora'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disparar notificações</AlertDialogTitle>
          <AlertDialogDescription>
            Isso vai processar todos os alertas pendentes imediatamente. Confirma?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={onDispatch}>Disparar</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
