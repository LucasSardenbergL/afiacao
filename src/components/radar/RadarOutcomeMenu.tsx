import { useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, MessageCircle, PhoneMissed, Ban, ClipboardCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { Textarea } from '@/components/ui/textarea';
import {
  useRegistrarContatoRadar,
  useDesfazerContatoRadar,
} from '@/queries/useRegistrarContatoRadar';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { ACOES_CONTATO, type AcaoContato } from '@/lib/radar/ui-helpers';

const ICON_MAP = {
  message: MessageCircle,
  'phone-missed': PhoneMissed,
  check: CheckCircle2,
  ban: Ban,
} as const;

const LABEL_OK: Record<AcaoContato, string> = {
  em_conversa: 'Marcado: em conversa',
  contatado_sem_resposta: 'Marcado: não atendeu',
  virou_cliente: 'Marcado: virou cliente',
  descartado: 'Lead descartado',
};

export function RadarOutcomeMenu({ cnpj }: { cnpj: string }) {
  const reg = useRegistrarContatoRadar();
  const undo = useDesfazerContatoRadar();
  const { isImpersonating } = useImpersonation();
  const [confirmDescartar, setConfirmDescartar] = useState(false);
  const [motivo, setMotivo] = useState('');

  const registrar = async (acao: AcaoContato, nota?: string) => {
    try {
      const r = await reg.mutateAsync({ cnpj, acao, nota });
      if (!r.deduped) {
        toast.success(LABEL_OK[acao], {
          action: {
            label: 'Desfazer',
            onClick: async () => {
              const u = await undo.mutateAsync(r.id);
              toast[u.deleted ? 'success' : 'error'](
                u.deleted ? 'Desfeito' : 'Não foi possível desfazer',
              );
            },
          },
        });
      }
    } catch {
      toast.error('Não foi possível registrar');
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={reg.isPending || isImpersonating}
            title={isImpersonating ? 'Indisponível em modo Ver como' : 'Registrar contato'}
          >
            <ClipboardCheck className="w-4 h-4 mr-2" /> Registrar contato
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {ACOES_CONTATO.filter((a) => !a.confirmar).map((a) => {
            const Icon = ICON_MAP[a.icon];
            return (
              <DropdownMenuItem key={a.acao} onClick={() => registrar(a.acao)}>
                <Icon className="w-4 h-4 mr-2" /> {a.label}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-status-error"
            onClick={() => {
              setMotivo('');
              setConfirmDescartar(true);
            }}
          >
            <Ban className="w-4 h-4 mr-2" /> Descartar
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmDescartar} onOpenChange={setConfirmDescartar}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Descartar este lead?</AlertDialogTitle>
            <AlertDialogDescription>
              Sai da fila de prospecção. Você pode anotar o motivo (opcional).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            placeholder="Motivo (opcional)"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => registrar('descartado', motivo || undefined)}>
              Descartar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
