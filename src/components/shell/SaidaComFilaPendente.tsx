import { useCallback, useState, type ReactNode } from 'react';
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
import { useAuth } from '@/contexts/AuthContext';
import { track } from '@/lib/analytics';
import { contarFila } from '@/lib/offline-queue';

/**
 * Sair com ações offline pendentes: AVISA, não bloqueia.
 *
 * A fila offline é do aparelho e cada item tem dono — depois do logout, os itens de quem saiu
 * ficam RETIDOS e só são enviados quando essa pessoa entrar de novo (ninguém mais os envia, e
 * nada é apagado). Bloquear o logout prenderia o coletor compartilhado do galpão enquanto a rede
 * não volta; então a saída segue, mas só depois de a pessoa SABER o que fica para trás.
 *
 * `sair` é a ação de logout do call-site (default: `signOut`); conta pela identidade REAL
 * (`useAuth().user`) — a lente "Ver como" não muda de quem são os itens.
 */
export function useSaidaComFilaPendente(sair?: () => void | Promise<void>): {
  pedirSaida: () => void;
  dialogoSaida: ReactNode;
} {
  const { user, signOut } = useAuth();
  const [pendentes, setPendentes] = useState(0);
  const acao = sair ?? signOut;

  const pedirSaida = useCallback(() => {
    const { meus } = contarFila(user?.id ?? null);
    if (meus === 0) {
      void acao();
      return;
    }
    track('offline.saida_com_pendencias', { pendentes: meus });
    setPendentes(meus);
  }, [user?.id, acao]);

  const confirmar = () => {
    track('offline.saida_com_pendencias_confirmada', { pendentes });
    setPendentes(0);
    void acao();
  };

  const dialogoSaida = (
    <AlertDialog open={pendentes > 0} onOpenChange={(aberto) => !aberto && setPendentes(0)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {pendentes === 1
              ? 'Há 1 ação salva offline ainda não enviada'
              : `Há ${pendentes} ações salvas offline ainda não enviadas`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            Elas ficam guardadas neste aparelho e só serão enviadas quando VOCÊ entrar de novo nele —
            ninguém mais pode enviá-las. Se possível, fique até a conexão voltar para sincronizar.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Ficar</AlertDialogCancel>
          <AlertDialogAction onClick={confirmar}>Sair mesmo assim</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { pedirSaida, dialogoSaida };
}
