import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Cobertura de carteira (carteira-Omie, Sub-PR B). "Tati cobre Regina de D1 a D2" = 1 linha.
 * Cobertura é VISIBILIDADE (a lista de sugestões de quem cobre passa a incluir a carteira
 * do coberto, selada), nunca muda a posse (farmer_id continua = dono original).
 * RLS (Sub-PR A) garante que só master OU o próprio coberto pode inserir.
 */

export interface ActiveCoverage {
  id: string;
  covered_user_id: string;
  valid_until: string | null;
}

/** user_ids cujas carteiras EU cubro agora (cobertura ativa e dentro da validade). */
export function useMyActiveCoverage() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-active-coverage', user?.id],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async (): Promise<ActiveCoverage[]> => {
      if (!user) return [];
      const nowIso = new Date().toISOString();
      const { data, error } = await supabase
        .from('carteira_coverage')
        .select('id, covered_user_id, valid_until')
        .eq('covering_user_id', user.id)
        .eq('active', true);
      if (error) throw error;
      return (data ?? []).filter((c) => !c.valid_until || c.valid_until > nowIso);
    },
  });
}

/** Coberturas que EU criei/sou parte (pra UI de gestão). Master vê todas via RLS. */
export function useCoverageList() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['coverage-list', user?.id],
    enabled: !!user,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('carteira_coverage')
        .select('id, covering_user_id, covered_user_id, valid_from, valid_until, active, created_at')
        .eq('active', true)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export interface Salesperson {
  user_id: string;
  name: string;
  role: string;
}

/** Vendedores (donos de carteira) pros selects de cobertura. Fonte enxuta: commercial_roles. */
export function useSalespeople() {
  return useQuery({
    queryKey: ['salespeople'],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<Salesperson[]> => {
      const { data: roles, error } = await supabase
        .from('commercial_roles')
        .select('user_id, commercial_role')
        .in('commercial_role', ['farmer', 'hunter', 'closer']);
      if (error) throw error;
      const ids = (roles ?? []).map((r) => r.user_id);
      if (ids.length === 0) return [];
      const { data: profs } = await supabase
        .from('profiles')
        .select('user_id, name, razao_social')
        .in('user_id', ids);
      const nameMap = new Map(
        (profs ?? []).map((p) => [p.user_id, p.razao_social || p.name || 'Sem nome']),
      );
      return (roles ?? []).map((r) => ({
        user_id: r.user_id,
        name: nameMap.get(r.user_id) ?? 'Sem nome',
        role: r.commercial_role,
      }));
    },
  });
}

export function useCreateCoverage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { covering_user_id: string; covered_user_id: string; valid_until: string | null }) => {
      if (!user) throw new Error('not authenticated');
      const { error } = await supabase.from('carteira_coverage').insert({
        covering_user_id: input.covering_user_id,
        covered_user_id: input.covered_user_id,
        valid_until: input.valid_until,
        active: true,
        created_by: user.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-active-coverage'] });
      qc.invalidateQueries({ queryKey: ['coverage-list'] });
    },
  });
}

export function useEndCoverage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (coverageId: string) => {
      const { error } = await supabase
        .from('carteira_coverage')
        .update({ active: false })
        .eq('id', coverageId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-active-coverage'] });
      qc.invalidateQueries({ queryKey: ['coverage-list'] });
    },
  });
}
