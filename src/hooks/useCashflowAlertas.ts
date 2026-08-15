import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type Alerta = {
  id: string;
  company: string;
  tipo: string;
  severidade: 'info' | 'aviso' | 'critico';
  mensagem: string;
  valor: number | null;
  threshold: number | null;
  contexto: Record<string, unknown> | null;
  criado_em: string;
  dismissed_at: string | null;
  dismissed_until: string | null;
  acknowledged_at: string | null;
  resolvido_em: string | null;
};

export function useCashflowAlertas(company: string) {
  return useQuery({
    queryKey: ['fin_alertas', 'ativos', company],
    enabled: Boolean(company),
    queryFn: async (): Promise<Alerta[]> => {
      const { data, error } = await supabase
        .from('fin_alertas')
        .select('*')
        .eq('company', company)
        .is('dismissed_at', null)
        .order('criado_em', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Alerta[];
    },
  });
}

/**
 * Reconhecer ≠ resolver ≠ silenciar — os três estavam colapsados em `dismissed_at`, e a
 * semântica era INVERTIDA: o índice único é PARCIAL (`WHERE dismissed_at IS NULL`), então
 * gravar `dismissed_at` tira a linha do índice e o próximo tick do watchdog abre um episódio
 * NOVO com e-mail novo. Ou seja: o botão "dispensar" REARMAVA o alerta em ~30 min, e não
 * clicar era o que o silenciava para sempre (provado em prod no histórico do
 * `reposicao_portal_humano`: criado 23/07 17:30 → dispensado 00:30 → reaberto 02:30 com
 * e-mail). Quem encerra episódio agora é a MÁQUINA, e só com `status='ok'` explícito
 * (`resolvido_em`). O humano tem duas ações honestas:
 *
 *  - **reconhecer** (`acknowledged_at`): "eu vi, estou tratando" — cala lembrete e violação
 *    nova, mas NÃO cala escalada de gravidade (quem reconheceu um aviso não reconheceu o
 *    crítico que veio depois; a máquina zera o reconhecimento quando a gravidade sobe).
 *  - **silenciar até** (`dismissed_until`): soneca com vencimento, que agora GOVERNA o
 *    produtor — antes o watchdog ignorava essa coluna e o "snooze" não valia nada.
 *
 * Em nenhum dos dois o alerta some da lista: a condição continua quebrada, e escondê-la é o
 * que produziu 3 alertas presos por 20-30 dias sem ninguém saber.
 */
export type AcaoAlerta =
  /** "eu vi, estou tratando" — cala lembrete, NÃO cala escalada de gravidade. */
  | { tipo: 'reconhecer' }
  /** soneca com vencimento; a partir desta entrega, governa o produtor. */
  | { tipo: 'silenciar'; dias: number }
  /**
   * Encerramento administrativo. Continua existindo porque os alertas que NÃO vêm do vigia de
   * saúde de dados (caixa_negativo, ncg_deficit, concentracao_top1, inadimplencia_alta,
   * cobertura_baixa, saida_spike) não têm resolução automática — sem isto ficariam presos na
   * tela para sempre. Encerrar um alerta do vigia é inócuo hoje: a máquina reabre o episódio no
   * próximo tick e o anti-flap por (company,tipo) impede que a reabertura vire e-mail.
   */
  | { tipo: 'encerrar' };

export function useAcaoAlerta() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; acao: AcaoAlerta }) => {
      const userId = (await supabase.auth.getUser()).data.user?.id;
      const agora = new Date().toISOString();
      const patch =
        input.acao.tipo === 'silenciar'
          ? {
              dismissed_until: new Date(Date.now() + input.acao.dias * 24 * 60 * 60 * 1000).toISOString(),
              dismissed_by: userId,
            }
          : input.acao.tipo === 'encerrar'
            ? { dismissed_at: agora, dismissed_by: userId }
            : { acknowledged_at: agora, acknowledged_by: userId };
      const { error } = await supabase.from('fin_alertas').update(patch).eq('id', input.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['fin_alertas'] }),
  });
}
