import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { track } from '@/lib/analytics';

/**
 * Dados + escrita da exceção de crédito (trava Fase 2). Separado do dialog de
 * propósito: o componente decide a VISÃO pelo acesso de exibição da lente
 * (display*), e este hook escreve com a identidade REAL (useAuth) — o guardião
 * display-access-no-write barra mutação no mesmo arquivo que decide exibição.
 */

export interface ContextoBloqueioCredito {
  account: 'oben' | 'colacor';
  omieCodigoCliente: number;
  nomeCliente: string;
  /** Snapshot do gate. null = não informado (nunca fabricar 0). */
  vencido: number | null;
  titulos: number | null;
}

/** Último bloqueio registrado pelo gate para o pedido (evidência p/ o fluxo /sales). */
export function useBloqueioCreditoLog(salesOrderId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['bloqueio-credito-log', salesOrderId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('venda_bloqueio_credito_log')
        .select('company, omie_codigo_cliente, vencido, titulos, created_at')
        .eq('sales_order_id', salesOrderId)
        .in('acao', ['bloqueado', 'bloqueado_edicao'])
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      return data?.[0] ?? null;
    },
  });
}

/** Exceção ainda válida do pedido (evita dupla aprovação; instrui o reenvio). */
export function useExcecaoCreditoVigente(salesOrderId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['excecao-credito', salesOrderId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('venda_excecao_credito')
        .select('id, valido_ate, motivo')
        .eq('sales_order_id', salesOrderId)
        .gt('valido_ate', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      return data?.[0] ?? null;
    },
  });
}

/**
 * Nomes de quem pode aprovar (visão do vendedor): masters via user_roles (SELECT
 * staff-wide) + gestores comerciais que a RLS deixar ver — commercial_roles só
 * expõe a linha do PRÓPRIO usuário a staff comum (limitação anotada na spec §8b).
 */
export function useAprovadoresCredito(enabled: boolean) {
  return useQuery({
    queryKey: ['aprovadores-excecao-credito'],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const [masters, comerciais] = await Promise.all([
        supabase.from('user_roles').select('user_id').eq('role', 'master'),
        supabase
          .from('commercial_roles')
          .select('user_id')
          .in('commercial_role', ['gerencial', 'estrategico', 'super_admin']),
      ]);
      if (masters.error) throw new Error(masters.error.message);
      const ids = [
        ...new Set([
          ...(masters.data ?? []).map((r) => r.user_id),
          ...(comerciais.data ?? []).map((r) => r.user_id),
        ]),
      ];
      if (ids.length === 0) return [];
      const { data: profs, error } = await supabase
        .from('profiles')
        .select('user_id, name, razao_social')
        .in('user_id', ids);
      if (error) throw new Error(error.message);
      const nomes = new Map((profs ?? []).map((p) => [p.user_id, p.razao_social || p.name || '']));
      return ids
        .map((id) => nomes.get(id) || '')
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    },
  });
}

/** Escrita da exceção — identidade REAL (RLS WITH CHECK + trigger anti-forje no banco). */
export function useAprovarExcecaoCredito(salesOrderId: string) {
  const { user } = useAuth();
  const { isImpersonating } = useImpersonation();
  const queryClient = useQueryClient();
  const [salvando, setSalvando] = useState(false);

  const aprovar = async (
    ctx: ContextoBloqueioCredito,
    motivo: string,
    validadeDias: number,
  ): Promise<boolean> => {
    if (!user || !motivo.trim()) return false;
    // Write-guard da lente: aprovar exceção é ato de AUTORIA (aprovado_por = quem
    // insere) — na lente "Ver como" a escrita fica bloqueada na fonte.
    if (isImpersonating) {
      toast.error('Saia da lente "Ver como" para aprovar exceção', {
        description: 'A aprovação é registrada em SEU nome — não dá para aprovar impersonando.',
      });
      return false;
    }
    setSalvando(true);
    try {
      // Folga de 5min: o CHECK valido_ate ≤ created_at+30d compara com o now() do
      // SERVIDOR (trigger força created_at) — relógio do client adiantado violaria o teto.
      const validoAte = new Date(Date.now() + validadeDias * 86_400_000 - 5 * 60_000);
      const { error } = await supabase.from('venda_excecao_credito').insert({
        sales_order_id: salesOrderId,
        company: ctx.account,
        omie_codigo_cliente: ctx.omieCodigoCliente,
        nome_cliente: ctx.nomeCliente || null,
        vencido_no_momento: ctx.vencido, // null quando o gate não informou — nunca 0 fabricado
        motivo: motivo.trim(),
        valido_ate: validoAte.toISOString(),
        aprovado_por: user.id, // o trigger do banco força auth.uid() de qualquer forma
      });
      if (error) {
        const rls = /row-level security/i.test(error.message);
        toast.error(rls ? 'Sem permissão de gestor para aprovar exceção' : 'Erro ao aprovar exceção', {
          description: rls ? 'Só gestor comercial ou master aprova.' : error.message,
        });
        return false;
      }
      track('venda.excecao_credito_criada', {
        account: ctx.account,
        validade_dias: validadeDias,
        vencido: ctx.vencido,
      });
      toast.success('Exceção aprovada para este pedido', {
        description: 'Agora é só reenviar o pedido — o gate vai encontrar a exceção.',
      });
      queryClient.invalidateQueries({ queryKey: ['excecao-credito', salesOrderId] });
      return true;
    } finally {
      setSalvando(false);
    }
  };

  return { aprovar, salvando };
}
