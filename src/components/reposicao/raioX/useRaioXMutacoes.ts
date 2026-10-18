// Mutações do Raio-X (fase B, PR 3): decidir (money-path — `raio_x_decidir` pode mexer em sku_parametros,
// o motor de compras), contar e classificar. Cada uma invalida o PREFIXO ['raio-x', empresa] (fatos,
// decisões, manuais e o selo do pedido — Ruling S1) e avisa por toast. A empresa é a do ITEM, passada por
// quem abriu, nunca relida do seletor na hora do clique.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import type { Database } from '@/integrations/supabase/types';
import { track } from '@/lib/analytics';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import type { DecidirArgs } from '@/lib/reposicao/raio-x/decisao';
import type { Categoria, Empresa } from '@/lib/reposicao/raio-x/tipos';

type Fns = Database['public']['Functions'];

export const MSG_RX001 = 'Este SKU não tem parâmetro de reposição — desmarque "tirar do motor"';
const MSG_SEM_PERMISSAO = 'Sem permissão para decidir no Raio-X (exige acesso a custo).';

/** Toast de erro: SQLSTATE conhecida vira texto acionável; o resto usa a mensagem do servidor. */
function avisarErro(e: unknown, fallback: string) {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'RX001') toast.error(MSG_RX001);
  else if (code === '42501') toast.error(MSG_SEM_PERMISSAO);
  else toast.error(mensagemDeErro(e) ?? fallback);
}

const numeroValido = (n: number | null) => n === null || (Number.isFinite(n) && n >= 0);

export type AcaoDecisao = 'decidir' | 'restaurar' | 'tirar_agora';

export function useRaioXMutacoes(empresa: Empresa) {
  const qc = useQueryClient();
  const invalidar = () => qc.invalidateQueries({ queryKey: ['raio-x', empresa] });

  const mDecidir = useMutation({
    mutationFn: async ({ args }: { args: DecidirArgs; acao: AcaoDecisao }) => {
      // Os tipos gerados declaram tudo não-nulo; a RPC aceita NULL (destino/observação/fornecedor/crédito).
      const params = {
        p_empresa: empresa,
        p_sku: args.sku,
        p_destino: args.destino,
        p_categoria: args.categoria,
        p_observacao: args.observacao,
        p_fornecedor: args.fornecedor,
        // Crédito só faz sentido em troca (a RPC grava o que vier; a regra é nossa).
        p_credito_troca: args.destino === 'trocar' ? args.creditoTroca : null,
        p_tirar_do_motor: args.tirarDoMotor,
        p_restaurar_motor: args.restaurarMotor,
      } as unknown as Fns['raio_x_decidir']['Args'];
      const { data, error } = await supabase.rpc('raio_x_decidir', params);
      if (error) throw error;
      return data as { tirou_do_motor?: boolean } | null;
    },
    onSuccess: (row, { args, acao }) => {
      void invalidar();
      toast.success(acao === 'restaurar' ? 'Motor restaurado' : acao === 'tirar_agora' ? 'Tirado do motor' : 'Decisão salva');
      track('raio_x.decisao', {
        empresa,
        destino: args.destino,
        tirou_do_motor: row?.tirou_do_motor ?? args.tirarDoMotor,
        acao,
      });
    },
    onError: (e) => avisarErro(e, 'Não foi possível salvar a decisão.'),
  });

  const mContar = useMutation({
    mutationFn: async ({ sku, qtd }: { sku: number; qtd: number | null }) => {
      const params = { p_empresa: empresa, p_sku: sku, p_qtd: qtd } as unknown as Fns['raio_x_contar']['Args'];
      const { error } = await supabase.rpc('raio_x_contar', params);
      if (error) throw error;
    },
    onSuccess: () => {
      void invalidar();
      toast.success('Contagem salva');
    },
    onError: (e) => avisarErro(e, 'Não foi possível salvar a contagem.'),
  });

  const mClassificar = useMutation({
    mutationFn: async ({ sku, categoria, motivo }: { sku: number; categoria: Categoria; motivo: string }) => {
      const { error } = await supabase.rpc('raio_x_classificar', {
        p_empresa: empresa,
        p_sku: sku,
        p_categoria: categoria,
        p_motivo: motivo,
      });
      if (error) throw error;
    },
    onSuccess: (_d, { categoria }) => {
      void invalidar();
      toast.success('Categoria marcada');
      track('raio_x.reclassificacao', { empresa, categoria });
    },
    onError: (e) => avisarErro(e, 'Não foi possível reclassificar.'),
  });

  /** Resolve `true` se gravou. Erro já virou toast; nunca rejeita. Número inválido não sai do cliente. */
  const decidir = async (args: DecidirArgs, acao: AcaoDecisao = 'decidir'): Promise<boolean> => {
    if (args.tirarDoMotor && args.restaurarMotor) return false; // a RPC recusaria (22023)
    if (!numeroValido(args.creditoTroca)) {
      toast.error('Crédito de troca inválido.');
      return false;
    }
    try {
      await mDecidir.mutateAsync({ args, acao });
      return true;
    } catch {
      return false;
    }
  };

  const contar = async (sku: number, qtd: number | null): Promise<boolean> => {
    if (!numeroValido(qtd)) {
      toast.error('Quantidade inválida.');
      return false;
    }
    try {
      await mContar.mutateAsync({ sku, qtd });
      return true;
    } catch {
      return false;
    }
  };

  const classificar = async (sku: number, categoria: Categoria, motivo: string): Promise<boolean> => {
    const m = motivo.trim();
    if (!m) return false; // CHECK do banco (23514): motivo obrigatório
    try {
      await mClassificar.mutateAsync({ sku, categoria, motivo: m });
      return true;
    } catch {
      return false;
    }
  };

  return {
    decidir,
    contar,
    classificar,
    pendente: mDecidir.isPending || mContar.isPending || mClassificar.isPending,
  };
}
