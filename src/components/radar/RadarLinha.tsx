import { Badge } from '@/components/ui/badge';
import { idadeEmAnos, rotuloPorte } from '@/lib/radar/ui-helpers';
import type { RadarEmpresa } from '@/queries/useRadarLista';

const STATUS_LABEL: Record<string, string> = {
  a_contatar: 'A contatar',
  contatado_sem_resposta: 'Não atendeu',
  em_conversa: 'Em conversa',
  descartado: 'Descartado',
  virou_cliente: 'Virou cliente',
};

export function RadarLinha({
  empresa,
  hojeISO,
  onAbrir,
}: {
  empresa: RadarEmpresa;
  hojeISO: string;
  onAbrir: () => void;
}) {
  const idade = idadeEmAnos(empresa.data_abertura, hojeISO);
  return (
    <button
      onClick={onAbrir}
      className="w-full text-left border-b px-3 py-2 hover:bg-accent/50 transition-colors grid grid-cols-[1fr_auto] gap-2 items-center"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">
            {empresa.nome_fantasia || empresa.razao_social || empresa.cnpj}
          </span>
          {empresa.ja_cliente && (
            <Badge variant="secondary" className="shrink-0">
              já é cliente
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {[empresa.municipio_nome, empresa.uf].filter(Boolean).join(' · ')}
          {empresa.cnae_descricao ? ` · ${empresa.cnae_descricao}` : ''}
        </div>
      </div>
      <div className="text-right text-xs text-muted-foreground shrink-0">
        <div>
          {idade != null ? `${idade} anos` : '—'} · {rotuloPorte(empresa.porte)}
        </div>
        <div>{STATUS_LABEL[empresa.prospeccao_status] ?? empresa.prospeccao_status}</div>
      </div>
    </button>
  );
}
