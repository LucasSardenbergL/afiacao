// Onda B, item 3: a empresa da tarefa criada na 360 vem da PROVA (omie_customer_account_map_fresco),
// não de um `empresa="oben"` fixo. Uma conta → ela; várias → pergunta entre elas; nenhuma ou leitura
// falha → pergunta entre as 3 (escolha explícita de quem cria, nunca chute gravado).
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/** Mesmo vocabulário de `tarefas.empresa` (= `account` do mapa Omie). */
export type EmpresaKey = 'oben' | 'colacor' | 'colacor_sc';

export const EMPRESAS_TAREFA: readonly EmpresaKey[] = ['oben', 'colacor', 'colacor_sc'];

export type EmpresaDaTarefa =
  | { tipo: 'unica'; empresa: EmpresaKey }
  | { tipo: 'ambigua'; opcoes: EmpresaKey[] }
  | { tipo: 'sem_dado'; opcoes: EmpresaKey[] };

/** Pura: contas mapeadas do cliente → o que a tela pode afirmar sobre a empresa da tarefa. */
export function empresaDaTarefa(contas: Array<{ account: string }> | null | undefined): EmpresaDaTarefa {
  const vistas = new Set<EmpresaKey>();
  for (const c of contas ?? []) {
    if ((EMPRESAS_TAREFA as readonly string[]).includes(c.account)) vistas.add(c.account as EmpresaKey);
  }
  const opcoes = EMPRESAS_TAREFA.filter((e) => vistas.has(e));
  if (opcoes.length === 1) return { tipo: 'unica', empresa: opcoes[0] };
  if (opcoes.length > 1) return { tipo: 'ambigua', opcoes };
  return { tipo: 'sem_dado', opcoes: [...EMPRESAS_TAREFA] };
}

/** Contas Omie do cliente. Falha LANÇA — o chamador trata como `sem_dado` (pergunta, não chuta). */
export function useEmpresaDaTarefa(customerId: string | undefined) {
  return useQuery({
    queryKey: ['c360-empresa-tarefa', customerId],
    enabled: !!customerId,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<EmpresaDaTarefa> => {
      const { data, error } = await supabase
        .from('omie_customer_account_map_fresco')
        .select('account')
        .eq('user_id', customerId!);
      if (error) throw new Error(error.message);
      return empresaDaTarefa(data ?? []);
    },
  });
}
