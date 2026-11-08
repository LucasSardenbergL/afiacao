import { ChevronRight, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ReactNode } from 'react';
import { RadarOutcomeMenu } from './RadarOutcomeMenu';
import { avisoTelefoneCompartilhado } from '@/lib/radar/atendimento';
import { telefonePrincipal, type AcaoContato } from '@/lib/radar/ui-helpers';
import type { RadarEmpresa } from '@/queries/useRadarLista';

/**
 * Modo discagem: o telefone grande, Ligar, os desfechos e "Próximo" num painel só — o vendedor percorre a fila
 * sem caçar botão. A ação do telefone chega PRONTA da ficha (`ligar`, o `RadarTelefoneAcao`: `tel:` no celular,
 * copiar no desktop enquanto a telefonia está congelada) e se recusa na lente "Ver como" na própria fonte (a
 * ligação não passa pelo Supabase, então o write-guard não a vê); os desfechos são o `RadarOutcomeMenu`.
 */
export function RadarModoDiscagem({
  empresa, ligar, compartilhado, compartilhadoFalhou = false, avisoContabil = null, onProximo, nota, campoNota, onRegistrado,
  onDesfeito,
}: {
  /** Nota do próximo registro (B4) e o campo que a edita — o estado é da ficha. */
  nota?: string;
  campoNota?: ReactNode;
  /** Quem decide avançar depois do registro é a ficha (B6). Sem ele, avança como antes. */
  onRegistrado?: (acao: AcaoContato, info: { deduped: boolean }) => void;
  onDesfeito?: () => void;
  empresa: RadarEmpresa;
  /** A ação do telefone principal — ligar (celular) ou copiar (desktop); null sem telefone. */
  ligar: ReactNode;
  /** Telefone → em quantas OUTRAS raízes ele aparece (undefined = ainda não lido ou falhou). */
  compartilhado: Map<string, number> | undefined;
  /** A leitura do aviso de telefone FALHOU: diz que não verificou, em vez de calar. */
  compartilhadoFalhou?: boolean;
  /** O telefone principal parece ser da contabilidade (migration 20261109140000): o aviso fica sob o número. */
  avisoContabil?: ReactNode;
  onProximo?: () => void;
}) {
  const tel = telefonePrincipal(empresa);
  const aviso = tel && compartilhado ? avisoTelefoneCompartilhado(compartilhado.get(tel) ?? 0) : null;
  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-3" data-testid="radar-modo-discagem">
      {tel ? (
        <div className="space-y-1">
          <div className="text-2xl font-tabular tracking-wide" data-testid="radar-discagem-telefone">{tel}</div>
          {avisoContabil}
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
      {campoNota}
      <div className="flex flex-wrap items-center gap-2">
        {tel && ligar}
        <RadarOutcomeMenu cnpj={empresa.cnpj} empresa={empresa} nota={nota} onDesfeito={onDesfeito}
          onRegistrado={onRegistrado ?? (() => onProximo?.())} />
        {onProximo && (
          <Button variant="ghost" size="touch" onClick={onProximo} className="ml-auto" title="Pular para o próximo lead da lista">
            Próximo <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        )}
      </div>
    </div>
  );
}
