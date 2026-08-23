/**
 * Hook que busca sugestões de visita do dia, filtradas por cidade.
 *
 * 2 queries:
 * 1. Cidades disponíveis (count + top_score por city)
 * 2. Top 30 candidatos da cidade selecionada, depois aplica pickDailyMix.
 *
 * Default city = primeira da lista (cidade com mais candidatos).
 *
 * ⚠️ SEGURANÇA: o filtro por farmer_id (ownerIds) é display-only, NÃO é fronteira —
 * a RLS de customer_visit_scores é ampla (qualquer staff lê tudo). A impersonação
 * (effectiveUserId ≠ eu) é master-only e o master já lê tudo, então não há vazamento
 * novo. Endurecer a RLS dessa tabela é follow-up de segurança.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useCarteirasQueEuCubro } from '@/hooks/useCoverage';
import { pickDailyMix } from '@/lib/visit-scoring/mix-selector';
import type { MissionType, VisitScore } from '@/lib/visit-scoring/types';

export interface VisitSuggestion extends VisitScore {
  customer_name: string;
  customer_phone: string | null;
  score_breakdown: Record<string, unknown> | null;
  last_visit_at: string | null;
  /** dono original quando a sugestão vem de cobertura (farmer_id ≠ eu); null se for minha. */
  coberto_de: string | null;
  /** nome do dono coberto (pra o selo "Cobertura — {nome}"); null se for minha. */
  coberto_de_nome: string | null;
}

export interface CityWithCount {
  city: string;
  count: number;
  top_score: number;
}

/**
 * Insumos ausentes da missão VENCEDORA, lidos de `score_breakdown.insumos_ausentes` — a edge
 * grava a lista ali (visit-score-recalc-client/index.ts ≈ 415), espelhando
 * `VisitScore.insumos_ausentes` de @/lib/visit-scoring/types. `Array.isArray` degrada com
 * segurança tanto pra linha antiga sem a chave (calculada antes deste campo nascer) quanto pra
 * `score_breakdown` null — nunca lança, e nunca declara "medida por completo" por acidente de
 * formato. Fabricar `[]` aqui é a mesma classe de erro que este PR existe para matar, só que na
 * proveniência em vez do score.
 */
export function insumosAusentesVencedora(scoreBreakdown: Record<string, unknown> | null): string[] {
  const raw = (scoreBreakdown as { insumos_ausentes?: string[] } | null)?.insumos_ausentes;
  return Array.isArray(raw) ? raw : [];
}

export function useMyVisitSuggestions(opts: {
  city?: string;
  targetCount?: number;
} = {}) {
  const { user } = useAuth();
  const { isImpersonating, effectiveUserId } = useImpersonation();
  const userId = user?.id;
  const { coveredIds, coberturaIndisponivel } = useCarteirasQueEuCubro();
  const baseId = isImpersonating && effectiveUserId ? effectiveUserId : userId;
  // Opção A: farmer_id = dono. Minha lista = minha carteira + carteiras que eu cubro agora.
  // Em impersonação: escopar apenas ao alvo (ignorar cobertura do master).
  const ownerIds = isImpersonating && effectiveUserId ? [effectiveUserId] : (userId ? [userId, ...coveredIds] : []);
  const coveredKey = coveredIds.slice().sort().join(',');

  // Query 1: cidades disponíveis
  const citiesQuery = useQuery({
    queryKey: ['visit-cities', baseId, coveredKey],
    enabled: !!userId,
    staleTime: 60_000,
    queryFn: async (): Promise<CityWithCount[]> => {

      const { data, error } = await supabase.from('customer_visit_scores')
        .select('city, visit_score')
        .in('farmer_id', ownerIds)
        .gt('visit_score', 30)
        .not('city', 'is', null);
      if (error) throw error;
      const byCity = new Map<string, { count: number; top_score: number }>();
      for (const row of (data ?? []) as Array<{ city: string; visit_score: number }>) {
        const cur = byCity.get(row.city) ?? { count: 0, top_score: 0 };
        cur.count++;
        cur.top_score = Math.max(cur.top_score, row.visit_score);
        byCity.set(row.city, cur);
      }
      return Array.from(byCity.entries())
        .map(([city, v]) => ({ city, ...v }))
        .sort((a, b) => b.top_score - a.top_score);
    },
  });

  const selectedCity = opts.city ?? citiesQuery.data?.[0]?.city;

  // Query 2: top candidatos da cidade selecionada
  const suggestionsQuery = useQuery({
    queryKey: ['visit-suggestions', baseId, coveredKey, selectedCity, opts.targetCount],
    enabled: !!userId && !!selectedCity,
    staleTime: 60_000,
    queryFn: async (): Promise<VisitSuggestion[]> => {
      if (!selectedCity || !userId) return [];

      const { data: scoresData, error: scoresErr } = await supabase.from('customer_visit_scores')
        .select('customer_user_id, farmer_id, recuperacao_score, expansao_score, relacionamento_score, prospeccao_score, visit_score, primary_mission, city, neighborhood, days_since_last_visit, last_visit_at, score_breakdown')
        .in('farmer_id', ownerIds)
        .eq('city', selectedCity)
        .order('visit_score', { ascending: false })
        .limit(30);
      if (scoresErr) throw scoresErr;

      const scores = (scoresData ?? []) as Array<{
        customer_user_id: string;
        farmer_id: string;
        // ⚠️ `number | null`: colunas nullable no Postgres (conferido is_nullable=YES). expansao_score
        // é null em 100% da base hoje — coagir pra 0 aqui tornaria inertes os guards que leem
        // MissionResult a jusante (mesma classe do #1498/#1565).
        recuperacao_score: number | null;
        expansao_score: number | null;
        relacionamento_score: number | null;
        prospeccao_score: number | null;
        visit_score: number;
        primary_mission: MissionType;
        city: string | null;
        neighborhood: string | null;
        days_since_last_visit: number | null;
        last_visit_at: string | null;
        score_breakdown: Record<string, unknown> | null;
      }>;

      if (scores.length === 0) return [];

      // inclui os donos cobertos (farmer_id ≠ baseId) pra resolver o nome do selo de cobertura
      const coveredOwners = scores.filter(s => s.farmer_id !== baseId).map(s => s.farmer_id);
      const userIds = [...new Set([...scores.map(s => s.customer_user_id), ...coveredOwners])];

      const { data: profileData } = await supabase.from('profiles')
        .select('user_id, name, razao_social, phone')
        .in('user_id', userIds);

      const profileMap = new Map<string, { name: string; phone: string | null }>();
      for (const p of (profileData ?? []) as Array<{ user_id: string; name: string | null; razao_social: string | null; phone: string | null }>) {
        profileMap.set(p.user_id, {
          name: p.razao_social || p.name || 'Cliente sem nome',
          phone: p.phone,
        });
      }

      const visitScores: VisitScore[] = scores.map(s => ({
        customer_user_id: s.customer_user_id,
        scores: {
          // `?? []` só no array de ausentes; o SCORE preserva o null da coluna — coagir aqui
          // desfaria, na borda de leitura, exatamente o que a edge acabou de gravar com honestidade.
          recuperacao: { score: s.recuperacao_score, insumosAusentes: [] },
          expansao: { score: s.expansao_score, insumosAusentes: [] },
          relacionamento: { score: s.relacionamento_score, insumosAusentes: [] },
          prospeccao: { score: s.prospeccao_score, insumosAusentes: [] },
        },
        visit_score: s.visit_score,
        primary_mission: s.primary_mission,
        city: s.city,
        neighborhood: s.neighborhood,
        days_since_last_visit: s.days_since_last_visit,
        insumos_ausentes: insumosAusentesVencedora(s.score_breakdown),
      }));

      const picked = pickDailyMix(visitScores, opts.targetCount ?? 6);

      return picked.map(p => {
        const profile = profileMap.get(p.customer_user_id);
        const source = scores.find(s => s.customer_user_id === p.customer_user_id);
        return {
          ...p,
          customer_name: profile?.name ?? 'Cliente sem nome',
          customer_phone: profile?.phone ?? null,
          score_breakdown: source?.score_breakdown ?? null,
          last_visit_at: source?.last_visit_at ?? null,
          coberto_de: source && source.farmer_id !== baseId ? source.farmer_id : null,
          coberto_de_nome: source && source.farmer_id !== baseId
            ? (profileMap.get(source.farmer_id)?.name ?? null)
            : null,
        };
      });
    },
  });

  return {
    /** `erro`/`sem-rede` na cobertura: a lista está INCOMPLETA e a tela precisa dizer isso. */
    coberturaIndisponivel,
    cities: citiesQuery.data ?? [],
    suggestions: suggestionsQuery.data ?? [],
    selectedCity,
    isLoading: citiesQuery.isLoading || suggestionsQuery.isLoading,
  };
}
