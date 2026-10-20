import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { BotaoLigar } from '@/components/call/BotaoLigar';
import { cn } from '@/lib/utils';
import {
  idadeEmAnos, rotuloPorte, rotuloStatus, tomStatus, CLASSE_TOM, telefonePrincipal, seloRfb, scoreUI,
} from '@/lib/radar/ui-helpers';
import type { RadarEmpresa } from '@/queries/useRadarLista';
import { ehInedito, saiuDoDump, rotuloSaiuDoDump, type LoteIngest } from '@/lib/radar/lote-vigente';
import { ehSugerido, LIMIAR_SUGERIDO } from '@/lib/radar/sugeridos';

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
  lote = null,
  mostrarMotivos = false,
}: {
  empresa: RadarEmpresa;
  hojeISO: string;
  selecionada: boolean;
  onSelecionar: (v: boolean) => void;
  onAbrir: () => void;
  /** Lote vigente (foto da RFB) — dá os selos "inédito", "saiu do dump em <mês>" e "sugerido"; sem ele, nenhum selo. */
  lote?: LoteIngest | null;
  /** Fila de qualificação ("só sugeridos"): os motivos do score viram TEXTO na linha, para justificar o cadastro. */
  mostrarMotivos?: boolean;
}) {
  const idade = idadeEmAnos(empresa.data_abertura, hojeISO);
  const nome = empresa.nome_fantasia || empresa.razao_social || empresa.cnpj;
  const tel = telefonePrincipal(empresa);
  const rfb = seloRfb(empresa);
  const score = scoreUI(empresa.score, empresa.score_motivos);
  const sugerido = ehSugerido(empresa, lote);
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
          {ehInedito(empresa, lote) && (
            <Badge variant="info" className="shrink-0">inédito</Badge>
          )}
          {saiuDoDump(empresa, lote) && (
            <Badge variant="outline" className="shrink-0 text-muted-foreground font-normal">{rotuloSaiuDoDump(empresa.ultimo_lote)}</Badge>
          )}
          {sugerido && (
            <Badge
              variant="success"
              className="shrink-0"
              title={`Sugerido para cadastro: em conversa, não cliente, score ≥ ${LIMIAR_SUGERIDO}${empresa.rfb_situacao == null ? ' (RFB ainda não cruzada)' : ''}`}
            >
              sugerido p/ cadastro
            </Badge>
          )}
          {rfb && (
            <span
              className={cn('shrink-0 rounded border px-1.5 py-px text-[11px] leading-4', CLASSE_TOM[rfb.tom])}
              title={rfb.titulo}
              data-testid="selo-rfb"
            >
              {rfb.texto}
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {[empresa.municipio_nome, empresa.uf].filter(Boolean).join(' · ')}
          {empresa.cnae_descricao ? ` · ${empresa.cnae_descricao}` : ''}
          {tel ? <span className="font-tabular"> · {tel}</span> : ''}
        </div>
        {mostrarMotivos && empresa.score != null && empresa.score_motivos && empresa.score_motivos.length > 0 && (
          <div className="text-xs text-muted-foreground truncate" data-testid="radar-score-motivos">
            {empresa.score_motivos.join(' · ')}
          </div>
        )}
      </button>
      <div className="text-right text-xs text-muted-foreground shrink-0">
        <div className="flex items-center justify-end gap-1.5">
          <span
            className={cn('inline-block rounded border px-1.5 py-px text-[11px] leading-4 font-tabular', CLASSE_TOM[score.tom])}
            title={score.detalhe}
            data-testid="radar-score"
          >
            {score.texto}
          </span>
          <span>{idade != null ? `${idade} anos` : '—'} · {rotuloPorte(empresa.porte)}</span>
        </div>
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
