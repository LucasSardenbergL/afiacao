import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Loader2, ShieldAlert } from 'lucide-react';
import { formatBRL } from './shared';

// Botão "Disparar mesmo assim" — override consciente do gate de mínimo de faturamento
// Sayerlack, por pedido. Quem decide MOSTRAR (só gestor/master, só falha_envio+gate) é o
// caller; aqui é só o controle com a confirmação (AlertDialog) explicando o risco de o
// fornecedor não faturar. Compartilhado entre a lista de pedidos e a fila de atenção.
export function OverrideMinimoButton({
  fornecedorNome,
  valorTotal,
  onConfirm,
  disabled,
}: {
  fornecedorNome: string | null;
  valorTotal: number | null;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          className="border-status-warning/40 text-status-warning hover:bg-status-warning/10 hover:text-status-warning"
        >
          {disabled ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <ShieldAlert className="w-4 h-4 mr-1" />}
          Disparar mesmo assim
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Disparar abaixo do mínimo de faturamento?</AlertDialogTitle>
          <AlertDialogDescription>
            O pedido para <strong>{fornecedorNome ?? 'este fornecedor'}</strong> ({formatBRL(valorTotal)}) está
            abaixo do mínimo de faturamento da Sayerlack. Abaixo desse valor o fornecedor pode
            <strong> não faturar</strong> o pedido — ele fica parado lá até acumular mais itens.
            Confirme só se tiver certeza de que vale enviar assim mesmo.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={() => onConfirm()}>Confirmar e disparar</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
