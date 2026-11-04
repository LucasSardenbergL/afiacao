import { Skeleton } from '@/components/ui/skeleton';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { estadoDeLeitura, naoConsegui } from '@/lib/leitura/estado-de-leitura';
import { cn } from '@/lib/utils';
import { CLASSE_TOM } from '@/lib/radar/ui-helpers';
import { evidenciaVinculo, rotuloForca, tituloVinculo } from '@/lib/radar/vinculos';
import { useRadarPossiveisVinculos } from '@/queries/useRadarPossiveisVinculos';

/**
 * "Já é cliente?" na ficha: o lead parece suceder (ou ser da mesma pessoa que) um cliente nosso. Mostra a EVIDÊNCIA
 * que casou e manda conferir — é pista, nunca veredito. Erro de leitura não vira "cliente novo".
 */
export function RadarVinculosLead({ cnpj }: { cnpj: string }) {
  const q = useRadarPossiveisVinculos(cnpj);
  const estado = estadoDeLeitura(q);
  if (estado === 'carregando') return <Skeleton className="h-5 w-40" />;
  if (naoConsegui(estado) && !q.data) {
    return <AvisoLeituraFalhou oque="se este CNPJ tem vínculo com um cliente" estado={estado} className="mb-0" />;
  }
  const vinculos = q.data ?? [];
  if (vinculos.length === 0) {
    return (
      <span className="text-xs text-muted-foreground" data-testid="radar-vinculos-vazio">
        Nenhum vínculo com cliente encontrado
      </span>
    );
  }
  return (
    <ul className="space-y-1.5" data-testid="radar-vinculos">
      {vinculos.map((v) => (
        <li key={v.clienteCnpj} className="text-sm">
          <span
            className={cn(
              'mr-1.5 inline-block rounded border px-1.5 py-px text-[11px] leading-4',
              CLASSE_TOM[v.forca === 'forte' ? 'warning' : 'info'],
            )}
          >
            {rotuloForca(v.forca)}
          </span>
          {tituloVinculo(v)}
          <div className="text-xs text-muted-foreground">
            {evidenciaVinculo(v)}. Confira com o cliente antes de tratar como cliente novo.
          </div>
        </li>
      ))}
    </ul>
  );
}
