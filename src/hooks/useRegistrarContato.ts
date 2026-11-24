import { useSyncExternalStore } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { registrarNoLedger } from '@/lib/analytics-ledger';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { registrarUsoClientes, type FichaClientes } from '@/lib/nav/sensor-clientes';

const RESULTADOS_CONTATO = [
  { valor: 'vendeu', rotulo: 'Vendeu' },
  { valor: 'vai_pedir', rotulo: 'Vai pedir' },
  { valor: 'sem_interesse', rotulo: 'Sem interesse' },
  { valor: 'nao_atendeu', rotulo: 'Não atendeu' },
] as const;

export type ResultadoContato = (typeof RESULTADOS_CONTATO)[number]['valor'];

export const rotuloResultado = (r: string): string =>
  RESULTADOS_CONTATO.find((x) => x.valor === r)?.rotulo ?? r;

/** Traduz a SQLSTATE de `venda_registrar_contato` para o que a vendedora precisa FAZER. */
function mensagemDoErroContato(codigo: string | undefined, fallback: string): string {
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
    // `superficie` (opcional) = de qual tela de Clientes veio: o sensor conta o desfecho na gravação confirmada.
    mutationFn: async (v: { compradorId: string; resultado: ResultadoContato; motivo?: string | null; superficie?: FichaClientes }) => {
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
      if (v.superficie) registrarUsoClientes({ acao: 'ficha_acao', ficha: v.superficie, tipo: 'registrar_desfecho', fase: 'sucesso' });
      void registrarNoLedger('venda.contato_registrado', v.compradorId, {
        resultado: v.resultado,
        com_motivo: !!v.motivo,
      });
      void qc.invalidateQueries({ queryKey: ['venda-contatos-do-dia'] });
      void qc.invalidateQueries({ queryKey: ['ultimo-contato-clientes'] });
      void qc.invalidateQueries({ queryKey: ['c360-interactions'] });
    },
    // Callbacks do HOOK (não os do `mutate`): disparam mesmo se o botão desmontar no meio — senão a trava
    // por cliente ficaria presa até recarregar a página.
    onSettled: (_d, _e, v) => liberarContato(v.compradorId),
    onError: (e) => {
      const codigo = (e as { code?: string } | null)?.code;
      toast.error(mensagemDoErroContato(codigo, `Não consegui registrar o contato: ${mensagemDeErro(e) ?? "erro desconhecido"}`));
    },
  });
}

/**
 * Gravações de desfecho EM VOO, por cliente — compartilhado entre TODAS as instâncias dos botões (fila,
 * ficha da ligação, 360). Serializa por cliente: sem isto, o menu aceitava um 2º desfecho enquanto o 1º
 * gravava, e o "último toque vence" do servidor decidia pela ordem de chegada na rede, não pela intenção.
 * Registro em módulo (síncrono): a trava vale já no 2º toque, antes de qualquer re-render.
 */
const emVoo = new Set<string>();
const ouvintes = new Set<() => void>();
const avisar = () => ouvintes.forEach((f) => f());

/** Marca o cliente como gravando; `false` se já havia gravação em voo para ele (não grave de novo). */
export function travarContato(compradorId: string): boolean {
  if (emVoo.has(compradorId)) return false;
  emVoo.add(compradorId);
  avisar();
  return true;
}

export function liberarContato(compradorId: string): void {
  if (emVoo.delete(compradorId)) avisar();
}

export function useGravandoContato(compradorId: string): boolean {
  return useSyncExternalStore(
    (f) => { ouvintes.add(f); return () => { ouvintes.delete(f); }; },
    () => emVoo.has(compradorId),
  );
}
