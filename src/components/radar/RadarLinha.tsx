import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import {
  idadeEmAnos, rotuloPorte, rotuloStatus, tomStatus, telefonePrincipal, seloRfb, scoreUI, selosFilial,
  type EstadoIrmaos, type IrmaosRaiz,
} from '@/lib/radar/ui-helpers';
import type { RadarEmpresa } from '@/queries/useRadarLista';
import { ehInedito, saiuDoDump, rotuloEfetivo, rotuloSaiuDoDump, type LoteIngest } from '@/lib/radar/lote-vigente';
import { ehSugerido, LIMIAR_SUGERIDO } from '@/lib/radar/sugeridos';
import { seloVinculo, type EstadoVinculos, type ResumoVinculoLista } from '@/lib/radar/vinculos';
import { ChipAtendimento } from './RadarAtendimentoLead';
import { Selo } from './Selo';
import { RadarTelefoneAcao } from './RadarTelefoneAcao';

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
  irmaos = null,
  irmaosEstado = 'ok',
  amostra = null,
  vinculo = null,
  vinculoEstado = 'carregando',
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
  /** Outros estabelecimentos da mesma raiz de CNPJ (selo "filial de cliente" / "+N da mesma empresa"); sem dado, sem selo. */
  irmaos?: IrmaosRaiz | null;
  /** Estado da página dos irmãos: 'falhou' vira o selo "filial?" (não consegui verificar ≠ não é filial). */
  irmaosEstado?: EstadoIrmaos;
  /** Sorteio da amostra de controle a que o lead pertence (selo "amostra"); null = não sorteado. */
  amostra?: string | null;
  /** Resumo do vínculo com cliente (selo "possível sucessor" / "possível vínculo"); null = sem vínculo na página lida. */
  vinculo?: ResumoVinculoLista | null;
  /** Estado da leitura do vínculo desta linha: 'falhou' mostra "vínculo?" — nunca vira "sem vínculo". */
  vinculoEstado?: EstadoVinculos;
}) {
  const idade = idadeEmAnos(empresa.data_abertura, hojeISO);
  const nome = empresa.nome_fantasia || empresa.razao_social || empresa.cnpj;
  const tel = telefonePrincipal(empresa);
  const rfb = seloRfb(empresa);
  const score = scoreUI(empresa.score, empresa.score_motivos);
  const sugerido = ehSugerido(empresa, lote);
  const filial = selosFilial(irmaos, irmaosEstado);
  const vinc = seloVinculo(vinculoEstado, vinculo);
  const motivos = empresa.score != null ? empresa.score_motivos ?? [] : [];
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
        {/* Pacote B3: o nome fica SOZINHO na 1ª linha. Antes ele dividia um flex com até 8 selos `shrink-0` e, no
            celular, o `truncate` o apagava — o vendedor via selos e não via a empresa. */}
        <div className="font-medium truncate">{nome}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          {empresa.ja_cliente && <Selo tom="muted">já é cliente</Selo>}
          {amostra && (
            <Selo tom="info" data-testid="selo-amostra"
              title={`Amostra de controle (${amostra}): lead fora do topo, sorteado para comparar a conversão com a do topo. Contate como qualquer outro.`}>
              amostra
            </Selo>
          )}
          {ehInedito(empresa, lote) && <Selo tom="info">inédito</Selo>}
          {saiuDoDump(empresa, lote) && <Selo tom="muted">{rotuloSaiuDoDump(rotuloEfetivo(empresa, lote) ?? empresa.ultimo_lote)}</Selo>}
          {sugerido && (
            <Selo tom="success"
              title={`Sugerido para cadastro: em conversa, não cliente, score ≥ ${LIMIAR_SUGERIDO}${empresa.rfb_situacao == null ? ' (RFB ainda não cruzada)' : ''}`}>
              sugerido p/ cadastro
            </Selo>
          )}
          {filial.map((s) => (
            <Selo key={s.chave} tom={s.tom} title={s.titulo} data-testid={`selo-filial-${s.chave}`}>{s.texto}</Selo>
          ))}
          {vinc && <Selo tom={vinc.tom} title={vinc.titulo} data-testid={`selo-vinculo-${vinc.chave}`}>{vinc.texto}</Selo>}
          {rfb && <Selo tom={rfb.tom} title={rfb.titulo} data-testid="selo-rfb">{rfb.texto}</Selo>}
          <ChipAtendimento cnpj={empresa.cnpj} />
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {[empresa.municipio_nome, empresa.uf].filter(Boolean).join(' · ')}
          {empresa.cnae_descricao ? ` · ${empresa.cnae_descricao}` : ''}
          {tel ? <span className="font-tabular"> · {tel}</span> : ''}
        </div>
        {/* Por que este lead (B3): o 1º motivo do score sempre visível — o `title` não aparece no toque. Na fila de
            qualificação ("só sugeridos") vão TODOS, para justificar o cadastro. */}
        {motivos.length > 0 && (
          <div className="text-xs text-muted-foreground truncate" data-testid="radar-score-motivos">
            {mostrarMotivos ? motivos.join(' · ') : motivos[0]}
          </div>
        )}
      </button>
      <div className="text-right text-xs text-muted-foreground shrink-0">
        <div className="flex items-center justify-end gap-1.5">
          <Selo tom={score.tom} title={score.detalhe} className="font-tabular" data-testid="radar-score">{score.texto}</Selo>
          <span>{idade != null ? `${idade} anos` : '—'} · {rotuloPorte(empresa.porte)}</span>
        </div>
        <Selo tom={tomStatus(empresa.prospeccao_status)} className="mt-0.5">{rotuloStatus(empresa.prospeccao_status)}</Selo>
      </div>
      <div className="w-8 flex justify-center">
        {tel && <RadarTelefoneAcao telefone={tel} />}
      </div>
    </div>
  );
}
