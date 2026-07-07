// Lista de cidades do Radar para o seletor do Roteirizador ("Visitas em campo"),
// com cache PERSISTENTE no localStorage (stale-while-revalidate) para o seletor
// abrir INSTANTÂNEO em re-aberturas/sessões seguintes. A query (RPC
// radar_contagem_por_municipio sem filtro) já tem fast-path no banco, mas ainda
// lê ~75 MB em cache-frio (~1-2s) — então exibimos o snapshot local na hora e
// revalidamos em segundo plano. ⚠️ Cache isolado por usuário (chave + queryKey
// com user.id) para nunca vazar entre contas.
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import type { CityOption } from '@/components/reposicao/routePlanner/types';
import { parseCidadesCache, serializeCidadesCache } from '@/lib/route/cidades-cache';

interface RawCidadeRow {
  municipio_codigo: string;
  municipio_nome: string;
  uf: string;
  lat: number | null;
  lng: number | null;
  total: number;
  com_telefone: number;
  a_contatar: number;
}

const TTL_MS = 48 * 60 * 60 * 1000; // 48h: snapshot reaproveitável
const STALE_MS = 30 * 60 * 1000; // 30min: quando começa a revalidar em background
const cacheKey = (uid: string) => `radar-cidades-rota:v1:${uid}`;

async function fetchCidadesRota(): Promise<CityOption[]> {
  const { data, error } = await supabase.rpc(
    'radar_contagem_por_municipio',
    { p_limit: 500 } as never,
  );
  if (error) throw error;
  const rows = (data ?? []) as RawCidadeRow[];
  return rows.map((r) => ({
    codigo: r.municipio_codigo,
    nome: r.municipio_nome,
    uf: r.uf,
    total: r.total,
    comTelefone: r.com_telefone,
    aContatar: r.a_contatar,
  }));
}

export function useRadarCidadesRota() {
  const { user } = useAuth();
  const uid = user?.id ?? null;

  // Snapshot local (instantâneo) — lido 1× por uid; alimenta initialData.
  const initial = useMemo(() => {
    if (!uid || typeof localStorage === 'undefined') return null;
    return parseCidadesCache(localStorage.getItem(cacheKey(uid)), Date.now(), TTL_MS);
  }, [uid]);

  return useQuery({
    queryKey: ['radar-cidades-rota', uid],
    enabled: !!uid,
    queryFn: async () => {
      const data = await fetchCidadesRota();
      if (uid && typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(cacheKey(uid), serializeCidadesCache(data, Date.now()));
        } catch {
          /* quota cheia: segue sem persistir (cache em memória continua valendo) */
        }
      }
      return data;
    },
    // Mostra o snapshot local na hora; revalida em background se passou do staleTime.
    initialData: initial?.data,
    initialDataUpdatedAt: initial?.ts,
    staleTime: STALE_MS,
    gcTime: TTL_MS,
  });
}
