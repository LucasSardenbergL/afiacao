import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { decisaoLegivel, recusaDaDecisao, type DecisaoPoABaixar, type ItemPoABaixar } from './po-a-baixar';

// Registro da DECISÃO da equipe na fila "PO a baixar no Omie" — o sensor com denominador da Entrega A. A declaração
// não muda nada no Omie, no motor nem na fila: a fila só sai por releitura. Writer único no banco:
// `reposicao_po_a_baixar_registrar_decisao` (idempotente pela `intencao`).
//
// A `intencao` é por (item, decisão) e sobrevive à FALHA: se a resposta se perdeu, o próximo clique reenvia a mesma
// intenção e o banco reconhece o retry em vez de gravar duas linhas. Só o sucesso (ou recusa de domínio) a descarta.

const CHAVE_FILA = ['pedidos-ciclo', 'po-a-baixar'] as const;

interface Variaveis {
  item: ItemPoABaixar;
  decisao: DecisaoPoABaixar;
}

export function useDecisaoPoABaixar(empresa: string) {
  const qc = useQueryClient();
  const intencoes = useRef(new Map<string, string>());

  const mutation = useMutation({
    mutationFn: async ({ item, decisao }: Variaveis) => {
      if (!item.chave || !item.propostaVersao) {
        throw new Error('item da fila sem identidade ou versão da proposta — recarregue a página');
      }
      const k = `${item.tipo}:${item.chave}:${decisao}`;
      let intencao = intencoes.current.get(k);
      if (!intencao) {
        intencao = crypto.randomUUID();
        intencoes.current.set(k, intencao);
      }
      const { data, error } = await supabase.rpc('reposicao_po_a_baixar_registrar_decisao', {
        p_empresa: empresa,
        p_tipo: item.tipo,
        p_chave: item.chave,
        p_decisao: decisao,
        p_proposta_versao: item.propostaVersao,
        p_intencao: intencao,
      });
      if (error) {
        if (recusaDaDecisao(error) != null) intencoes.current.delete(k);
        throw error;
      }
      intencoes.current.delete(k);
      return data;
    },
    onSuccess: (_data, { item, decisao }) => {
      track('reposicao.po_a_baixar_decisao', { tipo: item.tipo, decisao, resultado: 'registrada' });
      toast.success(`Registrado: ${decisaoLegivel(decisao)}`);
    },
    onError: (erro, { item, decisao }) => {
      const recusa = recusaDaDecisao(erro);
      track('reposicao.po_a_baixar_decisao', { tipo: item.tipo, decisao, resultado: recusa ? 'recusada' : 'falhou' });
      if (recusa) toast.warning(recusa);
      else toast.error(`Não foi possível registrar: ${mensagemDeErro(erro) ?? 'erro desconhecido'}`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: CHAVE_FILA }),
  });

  return {
    decidir: (item: ItemPoABaixar, decisao: DecisaoPoABaixar) => mutation.mutate({ item, decisao }),
    /** Chave (`tipo:chave`) do item com registro em voo — o card desabilita só esse. */
    decidindo: mutation.isPending && mutation.variables ? `${mutation.variables.item.tipo}:${mutation.variables.item.chave}` : null,
  };
}
