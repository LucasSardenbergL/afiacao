import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { BotaoLigar } from '@/components/call/BotaoLigar';
import { cn } from '@/lib/utils';
import {
  idadeEmAnos, rotuloPorte, rotuloStatus, tomStatus, CLASSE_TOM, telefonePrincipal,
} from '@/lib/radar/ui-helpers';
import type { RadarEmpresa } from '@/queries/useRadarLista';

/**
 * Linha da lista. Checkbox e botão de abrir são IRMÃOS (não aninhados): a linha inteira
 * era um <button> e um checkbox dentro dele é inválido em HTML e dispara os dois cliques.
 */
export function RadarLinha({
  empresa,
  hojeISO,
  selecionada,
  onSelecionar,
  onAbrir,
}: {
  empresa: RadarEmpresa;
  hojeISO: string;
  selecionada: boolean;
  onSelecionar: (v: boolean) => void;
  onAbrir: () => void;
}) {
  const idade = idadeEmAnos(empresa.data_abertura, hojeISO);
  const nome = empresa.nome_fantasia || empresa.razao_social || empresa.cnpj;
  const tel = telefonePrincipal(empresa);
  return (
    <div
      className={cn(
        'grid grid-cols-[auto_1fr_auto_auto] gap-2 items-center border-b px-2 py-1.5 transition-colors',
        selecionada ? 'bg-accent/40' : 'hover:bg-accent/30',
      )}
      data-cnpj={empresa.cnpj}
    >
      <Checkbox
        checked={selecionada}
        onCheckedChange={(v) => onSelecionar(v === true)}
        aria-label={`Selecionar ${nome}`}
        className="ml-1"
      />
      <button onClick={onAbrir} className="min-w-0 text-left py-0.5">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{nome}</span>
          {empresa.ja_cliente && (
            <Badge variant="secondary" className="shrink-0">já é cliente</Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {[empresa.municipio_nome, empresa.uf].filter(Boolean).join(' · ')}
          {empresa.cnae_descricao ? ` · ${empresa.cnae_descricao}` : ''}
          {tel ? <span className="font-tabular"> · {tel}</span> : ''}
        </div>
      </button>
      <div className="text-right text-xs text-muted-foreground shrink-0">
        <div>{idade != null ? `${idade} anos` : '—'} · {rotuloPorte(empresa.porte)}</div>
        <span className={cn('inline-block mt-0.5 rounded border px-1.5 py-px text-[11px] leading-4', CLASSE_TOM[tomStatus(empresa.prospeccao_status)])}>
          {rotuloStatus(empresa.prospeccao_status)}
        </span>
      </div>
      <div className="w-8 flex justify-center">
        {tel && <BotaoLigar telefone={tel} nomeCliente={empresa.razao_social || nome} variant="icon" />}
      </div>
    </div>
  );
}
