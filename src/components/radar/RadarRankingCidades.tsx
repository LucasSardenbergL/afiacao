import { useMemo } from 'react';
import { MapPin } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useRadarContagemMunicipios,
  useRadarPenetracaoMunicipios,
  oportunidadesPenetracao,
  formatarPenetracao,
  type RadarMunicipioContagem,
} from '@/queries/useRadarContagemMunicipios';
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
  const pen = useRadarPenetracaoMunicipios(filtros.uf || null, true);
  const top = (q.data ?? []).slice(0, 8);
  const totalGeral = (q.data ?? []).reduce((s, m) => s + m.total, 0);
  const comTelGeral = (q.data ?? []).reduce((s, m) => s + m.com_telefone, 0);
  // Município fora da resposta da penetração fica SEM dado ('—'), não 0%.
  const penPorCodigo = useMemo(() => new Map((pen.data ?? []).map((m) => [m.municipio_codigo, m])), [pen.data]);
  const oportunidades = useMemo(() => oportunidadesPenetracao(pen.data ?? [], 5), [pen.data]);

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
                  {pen.data && <> · {formatarPenetracao(penPorCodigo.get(m.municipio_codigo)?.penetracao ?? null)} cli.</>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {oportunidades.length > 0 && (
        <div className="mt-3 pt-2 border-t">
          <p className="text-xs font-medium mb-1">Mercado grande, pouca penetração</p>
          <ul className="space-y-0.5">
            {oportunidades.map((m) => (
              <li key={m.municipio_codigo}>
                <button
                  onClick={() => { if (m.municipio_nome) onPick(m.municipio_nome); }}
                  className="w-full flex items-center justify-between text-sm px-2 py-1 rounded hover:bg-muted text-left"
                >
                  <span className="truncate">{m.municipio_nome ?? m.municipio_codigo} <span className="text-muted-foreground">/{m.uf}</span></span>
                  <span className="tabular-nums text-xs text-muted-foreground shrink-0 ml-2">
                    {(m.empresas_lote ?? 0).toLocaleString('pt-BR')} empresas · {formatarPenetracao(m.penetracao)} cli.
                    {m.concorrentes != null && <> · {m.concorrentes} revendas</>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
