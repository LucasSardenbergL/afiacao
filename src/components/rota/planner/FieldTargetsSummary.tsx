// Resumo do universo de alvos do contexto campo: contagens + aviso honesto de
// truncamento ("mostrando X de N prospects"). Os controles de filtro vivem no
// AlvosFiltros. prospectsDisponiveis = soma do total das cidades (radar_contagem).
import { Users, Target, AlertTriangle } from 'lucide-react';

export function FieldTargetsSummary({
  totalClientes,
  totalProspects,
  prospectsDisponiveis,
}: {
  totalClientes: number;
  totalProspects: number;
  prospectsDisponiveis: number;
}) {
  const total = totalClientes + totalProspects;
  // Truncou se carregamos menos prospects do que o Radar tem nas cidades.
  const truncou = prospectsDisponiveis > totalProspects;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-sm">
        <span className="font-semibold text-foreground">{total} alvos</span>
        <span className="flex items-center gap-1 text-orange-600">
          <Users className="w-3.5 h-3.5" /> {totalClientes} clientes
        </span>
        <span className="flex items-center gap-1 text-yellow-600">
          <Target className="w-3.5 h-3.5" /> {totalProspects} prospects
        </span>
      </div>
      {truncou && (
        <div className="flex items-center gap-2 rounded-md bg-status-warning-bg px-3 py-2 text-xs text-status-warning">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          Mostrando {totalProspects} de {prospectsDisponiveis} prospects — refine por bairro/filtro.
        </div>
      )}
    </div>
  );
}
