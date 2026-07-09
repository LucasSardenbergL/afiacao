// Helpers puros do seletor de cidade do contexto "Visitas em campo".
// Derivam a UF da lista de cidades JÁ cacheada (useRadarCidadesRota.uf) — sem
// ida ao banco. Selecionar UF filtra o CityMultiSelector.
import type { CityOption } from '@/components/rota/planner/types';

/** UFs distintas presentes nas cidades (uppercase, ordenadas, sem vazios). */
export function ufsDe(cidades: CityOption[]): string[] {
  const set = new Set<string>();
  for (const c of cidades) {
    const uf = c.uf?.trim().toUpperCase();
    if (uf) set.add(uf);
  }
  return [...set].sort();
}

/** Filtra as cidades pela UF (case-insensitive). uf null/'' → todas. */
export function filtrarCidadesPorUf(cidades: CityOption[], uf: string | null): CityOption[] {
  if (!uf) return cidades;
  const alvo = uf.trim().toUpperCase();
  return cidades.filter((c) => c.uf?.trim().toUpperCase() === alvo);
}
