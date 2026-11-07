import { useState } from 'react';
import { toast } from 'sonner';
import { Hand, Loader2, Unlock, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { podeGerirRadar } from '@/lib/nav/acesso-radar';
import { CLASSE_TOM } from '@/lib/radar/ui-helpers';
import {
  diaMes, mensagemRecusa, mensagemRecusaAtribuicao, rotuloAtendimento, type VendedorAtribuivel,
} from '@/lib/radar/atendimento';
import {
  useRadarAtendimentosAtivos, useRadarAtribuirAtendimento, useRadarDefinirAtendimento, useRadarVendedoresAtribuiveis,
} from '@/queries/useRadarAtendimentos';

/**
 * Chip "em atendimento por X até dd/mm" / "com você até dd/mm" — lista e ficha. Lead livre: sem chip. Leitura que
 * FALHOU vira chip "atendimento?" — nunca "livre", que é o retrabalho que o recurso existe para evitar.
 */
export function ChipAtendimento({ cnpj, className }: { cnpj: string; className?: string }) {
  const q = useRadarAtendimentosAtivos();
  if (q.isError) {
    return (
      <span className={cn('shrink-0 rounded border px-1.5 py-px text-[11px] leading-4', CLASSE_TOM.muted, className)}
        title="Não consegui ver se alguém está atendendo este lead" data-testid="radar-atendimento-erro">
        atendimento?
      </span>
    );
  }
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
        <span className="text-xs text-status-error" data-testid="radar-atendimento-lead-erro">
          Não consegui ver se alguém está atendendo este lead.{' '}
          <button type="button" className="underline" onClick={() => void q.refetch()}>Tentar de novo</button>
        </span>
      ) : a ? (
        <ChipAtendimento cnpj={cnpj} />
      ) : q.isSuccess ? (
        <span className="text-xs text-muted-foreground">Ninguém está atendendo este lead.</span>
      ) : null}
      {!jaCliente && (!a || a.ehMeu) && (
        // Posse DESCONHECIDA (leitura falhou) não é "livre": assumir às cegas pode passar por cima de um colega (pacote F,
        // achado 7). O botão fica, desligado e com o motivo.
        <Button size="sm" variant="outline" disabled={ocupado || q.isLoading || q.isError} onClick={() => agir('assumir')}
          title={q.isError ? 'Indisponível: não consegui ver se alguém está atendendo este lead' : titulo}>
          {definir.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Hand className="w-4 h-4 mr-1" />}
          {a?.ehMeu ? 'Renovar' : 'Assumir'}
        </Button>
      )}
      {!jaCliente && gestor && (
        <AtribuirLead cnpj={cnpj} donoAtualId={a?.donoUserId ?? null} desabilitado={ocupado || q.isLoading} titulo={titulo} />
      )}
      {a && (a.ehMeu || gestor) && (
        <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => agir('liberar')} title={titulo}>
          <Unlock className="w-4 h-4 mr-1" /> Liberar
        </Button>
      )}
    </div>
  );
}

const ROTULO_PAPEL: Record<string, string> = {
  master: 'master', gerencial: 'gestor', estrategico: 'gestor', super_admin: 'gestor',
  farmer: 'farmer', hunter: 'hunter', closer: 'closer',
};

/**
 * Gestor/master passa o lead a qualquer vendedor (pedido do founder, 2026-11-06). A lista e a escrita são gateadas
 * no banco (`radar_vendedores_atribuiveis` / `radar_atribuir_atendimento`, gate de gestor); aqui só se esconde o que o
 * servidor recusaria. Se o lead está com outro, a posse dele fecha como `reatribuido` e fica registrado quem passou.
 */
function AtribuirLead({ cnpj, donoAtualId, desabilitado, titulo }: {
  cnpj: string; donoAtualId: string | null; desabilitado: boolean; titulo: string | undefined;
}) {
  const [aberto, setAberto] = useState(false);
  const vendedores = useRadarVendedoresAtribuiveis(aberto);
  const atribuir = useRadarAtribuirAtendimento();

  const escolher = async (v: VendedorAtribuivel) => {
    setAberto(false);
    const nome = v.nome ?? 'o vendedor';
    try {
      const r = await atribuir.mutateAsync({ cnpj, donoUserId: v.userId });
      if (!r.ok) { toast.info(mensagemRecusaAtribuicao(r, nome)); return; }
      if (r.jaEraDono) { toast.info(`O lead já está com ${r.donoNome ?? nome}`); return; }
      toast.success(`Lead atribuído a ${r.donoNome ?? nome}`, {
        description: [
          r.tirouDeOutro ? `Saiu de ${r.anteriorNome ?? 'outro vendedor'}.` : null,
          r.expiraEm ? `Fica com ${r.donoNome ?? nome} até ${diaMes(r.expiraEm)} (renova a cada contato dele).` : null,
        ].filter(Boolean).join(' ') || undefined,
      });
    } catch (e) {
      toast.error('Não foi possível atribuir o lead', { description: e instanceof Error ? e.message : undefined });
    }
  };

  return (
    <Popover open={aberto} onOpenChange={setAberto}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" disabled={desabilitado || atribuir.isPending} title={titulo ?? 'Passar o atendimento para um vendedor'}>
          {atribuir.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <UserPlus className="w-4 h-4 mr-1" />}
          Atribuir
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Buscar vendedor…" />
          <CommandList>
            {vendedores.isLoading ? (
              <div className="p-3 text-xs text-muted-foreground">Carregando vendedores…</div>
            ) : vendedores.isError ? (
              <div className="p-3 text-xs text-status-error" data-testid="radar-atribuir-erro">
                Não consegui carregar os vendedores{vendedores.error instanceof Error ? `: ${vendedores.error.message}` : ''}
              </div>
            ) : (
              <>
                <CommandEmpty>Nenhum vendedor encontrado.</CommandEmpty>
                <CommandGroup>
                  {(vendedores.data ?? []).map((v) => (
                    <CommandItem
                      key={v.userId}
                      value={`${v.nome ?? ''} ${v.userId}`}
                      disabled={v.userId === donoAtualId}
                      onSelect={() => { void escolher(v); }}
                    >
                      <span className="truncate">{v.nome ?? 'Sem nome'}</span>
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        {v.userId === donoAtualId ? 'atual' : (v.papel ? ROTULO_PAPEL[v.papel] ?? v.papel : '')}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
