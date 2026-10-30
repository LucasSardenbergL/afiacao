import { ChevronRight, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ReactNode } from 'react';
import { RadarOutcomeMenu } from './RadarOutcomeMenu';
import { avisoTelefoneCompartilhado } from '@/lib/radar/atendimento';
import { telefonePrincipal } from '@/lib/radar/ui-helpers';
import type { RadarEmpresa } from '@/queries/useRadarLista';

/**
 * Modo discagem: o telefone grande, Ligar, os desfechos e "Próximo" num painel só — o vendedor percorre a fila
 * sem caçar botão. O Ligar chega PRONTO da ficha (`ligar`, o `BotaoLigar` da telefonia: a ficha já tem essa aresta
 * entre módulos) e se recusa na lente "Ver como" na própria fonte (a ligação não passa pelo Supabase, então o
 * write-guard não a vê); os desfechos são o `RadarOutcomeMenu`, que fica desligado na lente.
 */
export function RadarModoDiscagem({
  empresa, ligar, compartilhado, compartilhadoFalhou = false, onProximo,
}: {
  empresa: RadarEmpresa;
  /** O botão Ligar do telefone principal (null sem telefone). */
  ligar: ReactNode;
  /** Telefone → em quantas OUTRAS raízes ele aparece (undefined = ainda não lido ou falhou). */
  compartilhado: Map<string, number> | undefined;
  /** A leitura do aviso de telefone FALHOU: diz que não verificou, em vez de calar. */
  compartilhadoFalhou?: boolean;
  onProximo?: () => void;
}) {
  const tel = telefonePrincipal(empresa);
  const aviso = tel && compartilhado ? avisoTelefoneCompartilhado(compartilhado.get(tel) ?? 0) : null;
  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-3" data-testid="radar-modo-discagem">
      {tel ? (
        <div className="space-y-1">
          <div className="text-2xl font-tabular tracking-wide" data-testid="radar-discagem-telefone">{tel}</div>
          {aviso && <p className="text-xs text-status-warning">{aviso}</p>}
          {compartilhadoFalhou && (
            <p className="text-xs text-muted-foreground">Não consegui verificar se este número aparece em outras empresas.</p>
          )}
          {empresa.telefone2 && empresa.telefone2 !== tel && (
            <p className="text-xs text-muted-foreground font-tabular">também: {empresa.telefone2}</p>
          )}
        </div>
      ) : (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <PhoneOff className="w-4 h-4" /> Sem telefone na Receita
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {tel && ligar}
        <RadarOutcomeMenu cnpj={empresa.cnpj} empresa={empresa} onRegistrado={() => onProximo?.()} />
        {onProximo && (
          <Button variant="ghost" size="touch" onClick={onProximo} className="ml-auto" title="Pular para o próximo lead da lista">
            Próximo <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        )}
      </div>
    </div>
  );
}
