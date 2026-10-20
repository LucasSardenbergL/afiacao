import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { hojeSP } from '@/lib/time/sp-day';
import { registrarNoLedger } from '@/lib/analytics-ledger';
import { mensagemDeErro } from '@/lib/erro-mensagem';

export const RESULTADOS_CONTATO = [
  { valor: 'vendeu', rotulo: 'Vendeu' },
  { valor: 'vai_pedir', rotulo: 'Vai pedir' },
  { valor: 'sem_interesse', rotulo: 'Sem interesse' },
  { valor: 'nao_atendeu', rotulo: 'Não atendeu' },
] as const;

export type ResultadoContato = (typeof RESULTADOS_CONTATO)[number]['valor'];

export const rotuloResultado = (r: string): string =>
  RESULTADOS_CONTATO.find((x) => x.valor === r)?.rotulo ?? r;

/**
 * Contatos já registrados HOJE pela vendedora (por comprador → último resultado do dia).
 * Leitura de tabela (RLS: a farmer lê as suas; o master lê todas) — por isso funciona na
 * lente "Ver como" filtrando pelo `effectiveUserId`.
 */
export function useContatosDoDia() {
  const { user } = useAuth();
  const { effectiveUserId } = useImpersonation();
  const dono = effectiveUserId ?? user?.id ?? null;
  const dia = hojeSP();
  return useQuery({
    queryKey: ['venda-contatos-do-dia', dono, dia],
    enabled: !!dono,
    staleTime: 30_000,
    queryFn: async (): Promise<Map<string, string>> => {
      const { data, error } = await supabase
        .from('venda_contato')
        .select('comprador_id, resultado')
        .eq('farmer_user_id', dono!)
        .eq('dia', dia)
        .limit(1000);
      if (error) throw error;
      return new Map((data ?? []).map((r) => [r.comprador_id, r.resultado]));
    },
  });
}

/** Traduz a SQLSTATE de `venda_registrar_contato` para o que a vendedora precisa FAZER. */
export function mensagemDoErroContato(codigo: string | undefined, fallback: string): string {
  switch (codigo) {
    case '42501': return 'Este cliente não está na sua carteira — o contato não foi registrado.';
    case '22023': return 'Desfecho inválido — avise a equipe, isto é um bug.';
    default: return fallback;
  }
}

/**
 * Desfecho manual da ligação — 1 escritor por cliente/dia (`venda_registrar_contato`, §7.6).
 * O RPC fixa `auth.uid()`; na lente "Ver como" o write-guard bloqueia (e a UI já desabilita).
 * Último toque do dia vence (o servidor faz upsert).
 */
export function useRegistrarContato() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { compradorId: string; resultado: ResultadoContato; motivo?: string | null }) => {
      const { error } = await supabase.rpc('venda_registrar_contato', {
        p_comprador: v.compradorId,
        p_resultado: v.resultado,
        p_motivo: v.resultado === 'sem_interesse' ? (v.motivo ?? undefined) : undefined,
      });
      if (error) throw error;
      return v;
    },
    onSuccess: (v) => {
      toast.success(`Registrado: ${rotuloResultado(v.resultado)}`);
      void registrarNoLedger('venda.contato_registrado', v.compradorId, {
        resultado: v.resultado,
        com_motivo: !!v.motivo,
      });
      void qc.invalidateQueries({ queryKey: ['venda-contatos-do-dia'] });
    },
    onError: (e) => {
      const codigo = (e as { code?: string } | null)?.code;
      toast.error(mensagemDoErroContato(codigo, `Não consegui registrar o contato: ${mensagemDeErro(e) ?? "erro desconhecido"}`));
    },
  });
}
