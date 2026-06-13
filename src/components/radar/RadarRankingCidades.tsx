import { MapPin } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useRadarContagemMunicipios, type RadarMunicipioContagem } from '@/queries/useRadarContagemMunicipios';
import type { RadarFiltros } from '@/queries/useRadarLista';

export function RadarRankingCidades({
  filtros,
  hojeISO,
  onPick,
}: {
  filtros: RadarFiltros;
  hojeISO: string;
  onPick: (municipioNome: string) => void;
}) {
  const q = useRadarContagemMunicipios(filtros, hojeISO, true);
  const top = (q.data ?? []).slice(0, 8);
  const totalGeral = (q.data ?? []).reduce((s, m) => s + m.total, 0);
  const comTelGeral = (q.data ?? []).reduce((s, m) => s + m.com_telefone, 0);

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium flex items-center gap-1">
          <MapPin className="w-4 h-4" /> Onde caçar
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {q.isLoading ? '…' : `${totalGeral.toLocaleString('pt-BR')} empresas · ${comTelGeral.toLocaleString('pt-BR')} c/ telefone`}
        </span>
      </div>
      {q.isLoading ? (
        <div className="space-y-1">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-6" />)}</div>
      ) : top.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nenhuma cidade nestes filtros.</p>
      ) : (
        <ul className="space-y-0.5">
          {top.map((m: RadarMunicipioContagem) => (
            <li key={m.municipio_codigo}>
              <button
                onClick={() => onPick(m.municipio_nome)}
                className="w-full flex items-center justify-between text-sm px-2 py-1 rounded hover:bg-muted text-left"
              >
                <span className="truncate">{m.municipio_nome} <span className="text-muted-foreground">/{m.uf}</span></span>
                <span className="tabular-nums text-xs text-muted-foreground shrink-0 ml-2">
                  {m.total.toLocaleString('pt-BR')} · {m.com_telefone} 📞 · {m.a_contatar} a contatar
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
