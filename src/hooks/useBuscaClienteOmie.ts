import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { eqText, orFilter } from '@/lib/postgrest';

/** Resultado da busca de cliente (Omie ERP + perfis locais), antes de resolver user_id. */
export type ClienteBusca = {
  user_id: string;
  nome: string;
  documento: string | null;
  telefone: string | null;
  email: string | null;
  omie_codigo_cliente?: number;
};

export function useBuscaClienteOmie() {
  const buscar = useCallback(async (query: string): Promise<ClienteBusca[]> => {
    if (query.length < 2) return [];
    try {
      const { data: omieData } = await supabase.functions.invoke('omie-vendas-sync', {
        body: { action: 'listar_clientes', search: query },
      });
      const omieClientes = (omieData?.clientes || []) as Array<{
        codigo_cliente: number; razao_social?: string; nome_fantasia?: string;
        email?: string | null; telefone?: string | null; cnpj_cpf?: string | null;
      }>;
      let mappingByCode: Record<number, string> = {};
      if (omieClientes.length > 0) {
        const codigos = omieClientes.map((c) => c.codigo_cliente);
        const { data: mappings } = await supabase.from('omie_clientes')
          .select('user_id, omie_codigo_cliente').in('omie_codigo_cliente', codigos);
        mappingByCode = Object.fromEntries((mappings || []).map((m) => [m.omie_codigo_cliente, m.user_id]));
      }
      const omieMapped: ClienteBusca[] = omieClientes.map((c) => ({
        user_id: mappingByCode[c.codigo_cliente] || '',
        nome: c.nome_fantasia || c.razao_social || 'Cliente',
        documento: c.cnpj_cpf || null, telefone: c.telefone || null, email: c.email || null,
        omie_codigo_cliente: c.codigo_cliente,
      }));
      const { data: localProfiles } = await supabase.from('profiles')
        .select('user_id, name, email, phone').ilike('name', `%${query}%`).limit(10);
      const local: ClienteBusca[] = (localProfiles || []).map((p) => ({
        user_id: p.user_id, nome: p.name ?? 'Cliente', documento: null,
        telefone: p.phone ?? null, email: p.email ?? null,
      }));
      const seen = new Set(omieMapped.filter((c) => c.user_id).map((c) => c.user_id));
      return [...omieMapped, ...local.filter((p) => !seen.has(p.user_id))];
    } catch {
      return []; // best-effort (mesma postura do FarmerCalls)
    }
  }, []);

  /** Resolve o customer_user_id local (doc/omie code). Retorna null se não vinculado. */
  const resolver = useCallback(async (c: ClienteBusca): Promise<string | null> => {
    if (c.user_id) return c.user_id;
    if (c.documento) {
      const docClean = c.documento.replace(/\D/g, '');
      const { data: profile } = await supabase.from('profiles').select('user_id')
        .or(orFilter(eqText('document', docClean), eqText('document', c.documento)))
        .limit(1).maybeSingle();
      if (profile?.user_id) return profile.user_id;
    }
    if (c.omie_codigo_cliente) {
      const { data: mapping } = await supabase.from('omie_clientes').select('user_id')
        .eq('omie_codigo_cliente', c.omie_codigo_cliente).maybeSingle();
      if (mapping?.user_id) return mapping.user_id;
    }
    return null;
  }, []);

  return { buscar, resolver };
}
