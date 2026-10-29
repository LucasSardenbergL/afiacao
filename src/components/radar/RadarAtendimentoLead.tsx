import { toast } from 'sonner';
import { Hand, Loader2, Unlock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { podeGerirRadar } from '@/lib/radar/acesso';
import { CLASSE_TOM } from '@/lib/radar/ui-helpers';
import { diaMes, mensagemRecusa, rotuloAtendimento } from '@/lib/radar/atendimento';
import { useRadarAtendimentosAtivos, useRadarDefinirAtendimento } from '@/queries/useRadarAtendimentos';

/** Chip "em atendimento por X até dd/mm" / "com você até dd/mm" — lista e ficha. Sem dado, sem chip. */
export function ChipAtendimento({ cnpj, className }: { cnpj: string; className?: string }) {
  const q = useRadarAtendimentosAtivos();
  const a = q.data?.get(cnpj);
  if (!a) return null;
  return (
    <span
      className={cn('shrink-0 rounded border px-1.5 py-px text-[11px] leading-4', CLASSE_TOM[a.ehMeu ? 'success' : 'warning'], className)}
      title={`Assumido em ${diaMes(a.assumidoEm)}; expira 7 dias depois do último contato do dono`}
      data-testid="radar-atendimento"
    >
      {rotuloAtendimento(a)}
    </span>
  );
}

/**
 * Bloco da ficha: quem está atendendo + Assumir/Renovar/Liberar. A escrita decide com o usuário REAL (`useAuth`) e
 * fica desligada na lente "Ver como"; a fronteira é a RPC `radar_definir_atendimento` (gate + dono + gestor).
 */
export function RadarAtendimentoLead({ cnpj, jaCliente }: { cnpj: string; jaCliente: boolean }) {
  const { role, commercialRole } = useAuth();
  const { isImpersonating } = useImpersonation();
  const q = useRadarAtendimentosAtivos();
  const definir = useRadarDefinirAtendimento();
  const a = q.data?.get(cnpj) ?? null;
  const gestor = podeGerirRadar({ role, commercialRole });

  const agir = async (acao: 'assumir' | 'liberar') => {
    try {
      const r = await definir.mutateAsync({ cnpj, acao });
      if (!r.ok) { toast.info(mensagemRecusa(r)); return; }
      if (acao === 'liberar') toast.success('Lead liberado');
      else toast.success(r.renovado ? 'Atendimento renovado' : 'Lead assumido', {
        description: r.expiraEm ? `Fica com você até ${diaMes(r.expiraEm)} (renova a cada contato)` : undefined,
      });
    } catch (e) {
      toast.error('Não foi possível atualizar o atendimento', { description: e instanceof Error ? e.message : undefined });
    }
  };

  const ocupado = definir.isPending || isImpersonating;
  const titulo = isImpersonating ? 'Indisponível em modo Ver como' : undefined;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="radar-atendimento-lead">
      {q.isError ? (
        <span className="text-xs text-status-error">Não consegui ver se alguém está atendendo este lead.</span>
      ) : a ? (
        <ChipAtendimento cnpj={cnpj} />
      ) : q.isSuccess ? (
        <span className="text-xs text-muted-foreground">Ninguém está atendendo este lead.</span>
      ) : null}
      {!jaCliente && (!a || a.ehMeu) && (
        <Button size="sm" variant="outline" disabled={ocupado || q.isLoading} onClick={() => agir('assumir')} title={titulo}>
          {definir.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Hand className="w-4 h-4 mr-1" />}
          {a?.ehMeu ? 'Renovar' : 'Assumir'}
        </Button>
      )}
      {a && (a.ehMeu || gestor) && (
        <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => agir('liberar')} title={titulo}>
          <Unlock className="w-4 h-4 mr-1" /> Liberar
        </Button>
      )}
    </div>
  );
}
