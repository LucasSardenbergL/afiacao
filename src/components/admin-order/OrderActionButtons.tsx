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
import { Loader2, Save, RefreshCw, Trash2 } from 'lucide-react';

interface Props {
  saving: boolean;
  syncingOmie: boolean;
  deleting: boolean;
  onSave: (syncToOmie: boolean) => void;
  onDelete: () => void;
}

export const OrderActionButtons = ({ saving, syncingOmie, deleting, onSave, onDelete }: Props) => {
  return (
    <div className="space-y-3 mb-6">
      <Button
        className="w-full"
        size="lg"
        onClick={() => onSave(true)}
        disabled={saving || syncingOmie}
      >
        {syncingOmie ? (
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        ) : (
          <RefreshCw className="w-4 h-4 mr-2" />
        )}
        Salvar e Sincronizar com Omie
      </Button>

      <Button
        variant="outline"
        className="w-full"
        size="lg"
        onClick={() => onSave(false)}
        disabled={saving || syncingOmie || deleting}
      >
        {saving && !syncingOmie ? (
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
        ) : (
          <Save className="w-4 h-4 mr-2" />
        )}
        Salvar Apenas Localmente
      </Button>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="destructive"
            className="w-full"
            size="lg"
            disabled={saving || syncingOmie || deleting}
          >
            {deleting ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4 mr-2" />
            )}
            Excluir Pedido
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir pedido?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação irá excluir o pedido permanentemente do aplicativo e a OS correspondente no Omie. Não é possível desfazer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete}>Excluir</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
