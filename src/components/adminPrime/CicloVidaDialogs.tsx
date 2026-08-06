// Ciclo de vida da assinatura Prime (staff): suspender / reativar / cancelar.
// Os guards vivem NO BANCO: suspensa exige suspensa_em; cancelada exige data_fim;
// a janela NUNCA pode deixar uso vivo fora do extrato (o banco barra e a UI
// traduz — daí o aviso de "estorne antes" nos dialogs de data retroativa).
//
// Reativação (decisão PR-2, minor 8 do review do PR-1): v1 sem histórico
// estruturado de suspensão — limpa suspensa_em e apensa o rastro na observacao.
// Meses do período suspenso REAPARECEM no extrato como "sem uso registrado"
// (fato: o banco barrava uso; nada de R$ é fabricado).
import { useState } from 'react';
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
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { hojeSP } from '@/lib/prime/competencia';
import { formatData } from '@/lib/prime/format';
import {
  useCancelarAssinatura,
  useReativarAssinatura,
  useSuspenderAssinatura,
  type PrimeAssinaturaComCliente,
} from '@/queries/usePrimeAdmin';

interface DialogAlvoProps {
  assinatura: PrimeAssinaturaComCliente | null;
  onFechar: () => void;
}

function nomeDe(a: PrimeAssinaturaComCliente): string {
  return a.cliente?.name ?? a.customer_user_id.slice(0, 8);
}

export function SuspenderDialog({ assinatura, onFechar }: DialogAlvoProps) {
  const suspender = useSuspenderAssinatura();
  const [data, setData] = useState(hojeSP());

  if (!assinatura) return null;

  const confirmar = () => {
    suspender.mutate(
      { id: assinatura.id, suspensaEm: data },
      { onSuccess: onFechar },
    );
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onFechar()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Suspender assinatura — {nomeDe(assinatura)}</DialogTitle>
          <DialogDescription>
            Suspensão CONGELA a franquia e o extrato a partir do mês da data escolhida
            (nenhum uso pode ser registrado enquanto suspensa). Se houver uso registrado
            depois dessa data, o banco barra — estorne antes ou escolha data posterior.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="susp-data">Suspensa a partir de</Label>
          <Input
            id="susp-data"
            type="date"
            value={data}
            min={assinatura.data_inicio}
            onChange={(e) => setData(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onFechar}>
            Voltar
          </Button>
          <Button
            variant="destructive"
            disabled={suspender.isPending || !data}
            onClick={confirmar}
          >
            {suspender.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Suspender
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ReativarDialog({ assinatura, onFechar }: DialogAlvoProps) {
  const reativar = useReativarAssinatura();

  if (!assinatura) return null;

  const confirmar = () => {
    const nota = `[Reativada em ${formatData(hojeSP())} — estava suspensa desde ${formatData(assinatura.suspensa_em)}]`;
    const observacao = [assinatura.observacao?.trim(), nota].filter(Boolean).join('\n');
    reativar.mutate({ id: assinatura.id, observacao }, { onSuccess: onFechar });
  };

  return (
    <AlertDialog open onOpenChange={(v) => !v && onFechar()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reativar assinatura — {nomeDe(assinatura)}</AlertDialogTitle>
          <AlertDialogDescription>
            Volta a aceitar registro de uso já neste mês. Os meses do período suspenso
            (desde {formatData(assinatura.suspensa_em)}) reaparecem no extrato como
            &quot;sem uso registrado&quot;. O rastro da suspensão fica anotado na observação.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Voltar</AlertDialogCancel>
          <AlertDialogAction disabled={reativar.isPending} onClick={confirmar}>
            {reativar.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Reativar
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function CancelarDialog({ assinatura, onFechar }: DialogAlvoProps) {
  const cancelar = useCancelarAssinatura();
  const [data, setData] = useState(hojeSP());

  if (!assinatura) return null;

  const confirmar = () => {
    cancelar.mutate({ id: assinatura.id, dataFim: data }, { onSuccess: onFechar });
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onFechar()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancelar assinatura — {nomeDe(assinatura)}</DialogTitle>
          <DialogDescription>
            Cancelamento é TERMINAL (novo ciclo = nova assinatura, só a partir do mês
            seguinte ao fim — a competência não pode duplicar no extrato). O banco exige a
            data de fim e barra janela que esconderia uso vivo — estorne antes se preciso.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="canc-data">Data de fim</Label>
          <Input
            id="canc-data"
            type="date"
            value={data}
            min={assinatura.data_inicio}
            onChange={(e) => setData(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onFechar}>
            Voltar
          </Button>
          <Button
            variant="destructive"
            disabled={cancelar.isPending || !data}
            onClick={confirmar}
          >
            {cancelar.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Cancelar assinatura
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
