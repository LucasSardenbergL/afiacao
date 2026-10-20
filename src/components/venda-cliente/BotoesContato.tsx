import { useState } from 'react';
import { CheckCircle2, CalendarClock, XCircle, PhoneMissed, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { MOTIVOS_RECUSA } from '@/hooks/useFarmerDesfecho';
import { useRegistrarContato, rotuloResultado, type ResultadoContato } from '@/hooks/useRegistrarContato';
import { useContatosDoDia } from '@/hooks/useContatosDoDia';

const ICONE: Record<ResultadoContato, typeof CheckCircle2> = {
  vendeu: CheckCircle2,
  vai_pedir: CalendarClock,
  sem_interesse: XCircle,
  nao_atendeu: PhoneMissed,
};

const TOM: Record<ResultadoContato, string> = {
  vendeu: 'text-status-success',
  vai_pedir: 'text-status-info',
  sem_interesse: 'text-status-error',
  nao_atendeu: 'text-muted-foreground',
};

const ORDEM: ResultadoContato[] = ['vendeu', 'vai_pedir', 'sem_interesse', 'nao_atendeu'];
const TITULO_LENTE = 'Indisponível em modo Ver como';

interface Props {
  compradorId: string;
  /** `grade` = ficha (4 botões de toque); `menu` = linha da fila (compacto). */
  variante?: 'grade' | 'menu';
}

/**
 * Desfecho da ligação em 1 toque (§7.6): vendeu · vai pedir · sem interesse (+motivo) · não atendeu.
 * Escritor único `venda_registrar_contato` (auth.uid() fixo); bloqueado na lente "Ver como".
 * Último toque do dia vence — o botão já registrado fica marcado.
 */
export function BotoesContato({ compradorId, variante = 'grade' }: Props) {
  const { isImpersonating } = useImpersonation();
  const registrar = useRegistrarContato();
  const contatos = useContatosDoDia();
  const atual = contatos.data?.get(compradorId) ?? null;
  const [pedindoMotivo, setPedindoMotivo] = useState(false);
  const bloqueado = isImpersonating || registrar.isPending;

  const enviar = (resultado: ResultadoContato, motivo?: string | null) => {
    if (isImpersonating) return;
    setPedindoMotivo(false);
    registrar.mutate({ compradorId, resultado, motivo });
  };

  if (variante === 'menu') {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            disabled={isImpersonating}
            title={isImpersonating ? TITULO_LENTE : 'Registrar desfecho'}
            aria-label="Registrar desfecho da ligação"
          >
            <MoreHorizontal className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="text-2xs">Como foi a ligação?</DropdownMenuLabel>
          {ORDEM.filter((r) => r !== 'sem_interesse').map((r) => {
            const Icone = ICONE[r];
            return (
              <DropdownMenuItem key={r} onClick={() => enviar(r)}>
                <Icone className={cn('w-4 h-4 mr-2', TOM[r])} /> {rotuloResultado(r)}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <XCircle className={cn('w-4 h-4 mr-2', TOM.sem_interesse)} /> Sem interesse
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {MOTIVOS_RECUSA.map((m) => (
                <DropdownMenuItem key={m.valor} onClick={() => enviar('sem_interesse', m.valor)}>{m.rotulo}</DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => enviar('sem_interesse', null)}>Sem motivo</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <p className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">Como foi a ligação?</p>
        {atual && (
          <p className="text-2xs text-muted-foreground">
            Registrado hoje: <span className={cn('font-medium', TOM[atual as ResultadoContato])}>{rotuloResultado(atual)}</span>
          </p>
        )}
      </div>
      {pedindoMotivo ? (
        <div className="rounded-md border p-2 space-y-2" role="group" aria-label="Motivo do sem interesse">
          <p className="text-2xs text-muted-foreground px-1">Por que não quis?</p>
          <div className="grid grid-cols-2 gap-1.5">
            {MOTIVOS_RECUSA.map((m) => (
              <Button key={m.valor} size="touch" variant="outline" className="px-3 text-sm" disabled={bloqueado}
                onClick={() => enviar('sem_interesse', m.valor)}>
                {m.rotulo}
              </Button>
            ))}
          </div>
          <div className="flex justify-between">
            <Button size="sm" variant="ghost" onClick={() => setPedindoMotivo(false)}>Voltar</Button>
            <Button size="sm" variant="ghost" disabled={bloqueado} onClick={() => enviar('sem_interesse', null)}>
              Registrar sem motivo
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          {ORDEM.map((r) => {
            const Icone = ICONE[r];
            const marcado = atual === r;
            return (
              <Button
                key={r}
                size="touch"
                variant={marcado ? 'secondary' : 'outline'}
                aria-pressed={marcado}
                disabled={bloqueado}
                title={isImpersonating ? TITULO_LENTE : undefined}
                className="justify-start gap-2 px-3 text-sm"
                onClick={() => (r === 'sem_interesse' ? setPedindoMotivo(true) : enviar(r))}
              >
                <Icone className={cn('w-4 h-4', TOM[r])} /> {rotuloResultado(r)}
              </Button>
            );
          })}
        </div>
      )}
      {isImpersonating && (
        <p className="text-2xs text-muted-foreground">Na lente "Ver como" o desfecho fica bloqueado — só a própria vendedora registra.</p>
      )}
    </div>
  );
}
