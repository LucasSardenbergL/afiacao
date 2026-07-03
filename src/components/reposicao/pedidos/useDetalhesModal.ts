// Lógica do modal de detalhes do pedido (queries, mutations, edição de itens, aprovação).
// Extraída verbatim de src/components/reposicao/pedidos/DetalhesModal.tsx (god-component split).
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import { PedidoSugerido, PedidoItem, CondicaoPagamento } from './types';
import { aprovarEDisparar } from './aprovar-disparar';
import { montarUpdateItem, podeEditarPrecoPedido, precoEditValido } from './preco-edit';
import { quantidadeCompraInteira } from '@/lib/reposicao/compras-otimizador-helpers';

export type Linha = PedidoItem & { _qtd: number; _preco: number; _valor: number };

interface UseDetalhesModalArgs {
  pedido: PedidoSugerido | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onApproved: () => void;
}

export function useDetalhesModal({ pedido, open, onOpenChange, onApproved }: UseDetalhesModalArgs) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [edits, setEdits] = useState<Record<number, number>>({});
  const [precoEdits, setPrecoEdits] = useState<Record<number, number>>({});
  const [obs, setObs] = useState('');
  const [condicaoCodigo, setCondicaoCodigo] = useState<string>('');
  const [removerItem, setRemoverItem] = useState<PedidoItem | null>(null);
  const [descontinuarItem, setDescontinuarItem] = useState<PedidoItem | null>(null);
  // Seleção em massa p/ remoção em lote (ids de pedido_compra_item).
  const [selecionados, setSelecionados] = useState<ReadonlySet<number>>(new Set());
  const [confirmarRemocaoLote, setConfirmarRemocaoLote] = useState(false);

  // Catálogo de condições de pagamento Omie (carregado uma vez)
  const { data: condicoes = [] } = useQuery({
    queryKey: ['condicoes-pagamento', pedido?.empresa],
    queryFn: async () => {
      if (!pedido) return [] as CondicaoPagamento[];
      const { data, error } = await supabase
        .from('omie_condicao_pagamento_catalogo')
        .select('codigo, descricao, num_parcelas, dias_parcelas')
        .eq('empresa', pedido.empresa)
        .eq('ativo', true)
        .order('descricao');
      if (error) throw error;
      return (data ?? []) as CondicaoPagamento[];
    },
    enabled: !!pedido && open,
  });

  const { data: itens, isLoading } = useQuery({
    queryKey: ['pedido-itens', pedido?.id],
    queryFn: async () => {
      if (!pedido) return [] as PedidoItem[];
      const { data, error } = await supabase
        .from('pedido_compra_item')
        .select('*')
        .eq('pedido_id', pedido.id)
        .order('id', { ascending: true });
      if (error) throw error;
      const baseItens = data ?? [];
      if (baseItens.length === 0) return [] as PedidoItem[];

      // Buscar estoque_minimo de sku_parametros (JOIN manual)
      const skuCodigos = baseItens.map((it) => Number(it.sku_codigo_omie)).filter((n) => !isNaN(n));
      const { data: params } = await supabase
        .from('sku_parametros')
        .select('sku_codigo_omie, estoque_minimo')
        .eq('empresa', pedido.empresa)
        .in('sku_codigo_omie', skuCodigos);
      const minMap = new Map<string, number>();
      (params ?? []).forEach((p) => {
        minMap.set(String(p.sku_codigo_omie), Number(p.estoque_minimo ?? 0));
      });

      return baseItens.map((it) => ({
        ...it,
        estoque_minimo: minMap.get(String(it.sku_codigo_omie)) ?? 0,
      })) as PedidoItem[];
    },
    enabled: !!pedido && open,
  });

  useEffect(() => {
    if (!open) {
      setEdits({});
      setPrecoEdits({});
      setObs('');
      setCondicaoCodigo('');
      setSelecionados(new Set());
      setConfirmarRemocaoLote(false);
    } else if (pedido) {
      setCondicaoCodigo(pedido.condicao_pagamento_codigo ?? '');
    }
  }, [open, pedido]);

  const linhas = useMemo<Linha[]>(() => {
    return (itens ?? []).map((it) => {
      // [QTDE-INTEIRA] default exibido sempre inteiro: ceila a poeira decimal do estoque do Omie
      // em linhas legadas (ex.: qtde_final 3,99996 → 4). edits[] já vem inteiro do onEditQty.
      const qtd = edits[it.id] ?? quantidadeCompraInteira(it.qtde_final ?? it.qtde_sugerida);
      const preco = precoEdits[it.id] ?? Number(it.preco_unitario ?? 0);
      return { ...it, _qtd: qtd, _preco: preco, _valor: qtd * preco };
    });
  }, [itens, edits, precoEdits]);

  const totalAtual = useMemo(
    () => linhas.reduce((acc, l) => acc + l._valor, 0),
    [linhas],
  );

  const salvarMutation = useMutation({
    mutationFn: async () => {
      if (!pedido) return;
      // Money-path: nunca gravar preço <= 0 (o disparo rejeita nValUnit=0 no Omie).
      const precoInvalido = Object.values(precoEdits).find((v) => !precoEditValido(v));
      if (precoInvalido !== undefined) {
        throw new Error('Custo inválido: informe um valor maior que zero.');
      }
      // União dos itens com ajuste de quantidade OU de preço.
      const idsEditados = new Set<number>([
        ...Object.keys(edits).map(Number),
        ...Object.keys(precoEdits).map(Number),
      ]);
      for (const itemId of idsEditados) {
        const item = (itens ?? []).find((i) => i.id === itemId);
        if (!item) continue; // item saiu do cache — não grava (evita zerar preço). Codex [P1].
        const update = montarUpdateItem(item, edits[itemId], precoEdits[itemId]);
        const { error } = await supabase
          .from('pedido_compra_item')
          .update(update)
          .eq('id', itemId);
        if (error) throw error;
      }
      // Header null-safe: _valor já trata custo desconhecido (preco_unitario null/0)
      // como 0, então valor_total = SUM(COALESCE(valor_linha,0)) — consistente com o
      // valor_linha null que montarUpdateItem grava nessas linhas (ausente ≠ zero).
      // Não trocar o `?? 0` do _valor por propagação de null (viraria NaN no total). Codex 019f146d.
      const novoTotal = linhas.reduce((acc, l) => acc + l._valor, 0);
      const { error: errPed } = await supabase
        .from('pedido_compra_sugerido')
        .update({ valor_total: novoTotal, atualizado_em: new Date().toISOString() })
        .eq('id', pedido.id);
      if (errPed) throw errPed;
    },
    onSuccess: () => {
      toast.success('Ajustes salvos');
      queryClient.invalidateQueries({ queryKey: ['pedido-itens', pedido?.id] });
      queryClient.invalidateQueries({ queryKey: ['pedidos-ciclo'] });
      setEdits({});
      setPrecoEdits({});
    },
    onError: (e: Error) => {
      logger.error('Erro ao salvar ajustes', { error: e });
      toast.error(`Erro ao salvar: ${e.message}`);
    },
  });

  const condicaoSelecionada = useMemo(
    () => condicoes.find((c) => c.codigo === condicaoCodigo) ?? null,
    [condicoes, condicaoCodigo],
  );

  const condicaoMudou = condicaoCodigo !== (pedido?.condicao_pagamento_codigo ?? '');

  const salvarCondicaoMutation = useMutation({
    mutationFn: async () => {
      if (!pedido || !condicaoSelecionada) return;
      const { error } = await supabase
        .from('pedido_compra_sugerido')
        .update({
          condicao_pagamento_codigo: condicaoSelecionada.codigo,
          condicao_pagamento_descricao: condicaoSelecionada.descricao,
          num_parcelas: condicaoSelecionada.num_parcelas,
          condicao_origem: 'manual_humano',
          atualizado_em: new Date().toISOString(),
        })
        .eq('id', pedido.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Condição de pagamento salva');
      queryClient.invalidateQueries({ queryKey: ['pedidos-ciclo'] });
    },
    onError: (e: Error) => {
      logger.error('Erro ao salvar condição', { error: e });
      toast.error(`Erro ao salvar condição: ${e.message}`);
    },
  });

  const aprovarMutation = useMutation({
    mutationFn: async () => {
      if (!pedido) return;
      if (!condicaoSelecionada) {
        throw new Error('Selecione uma condição de pagamento antes de aprovar');
      }
      // salvar ajustes primeiro se houver
      if (Object.keys(edits).length > 0) {
        await salvarMutation.mutateAsync();
      }
      // salvar condição se mudou ou se ainda não havia
      if (condicaoMudou) {
        await salvarCondicaoMutation.mutateAsync();
      }
      // Trilha canônica: APROVAR = DISPARAR NA HORA (RPC + edge + feedback).
      return aprovarEDisparar({
        pedidoId: pedido.id,
        empresa: pedido.empresa,
        usuario: user?.email ?? 'sistema',
      });
    },
    onSuccess: (result) => {
      if (result) {
        const { ok, tipo, mensagem } = result;
        if (!ok || tipo === 'error') toast.error(mensagem);
        else if (tipo === 'warning') toast.warning(mensagem);
        else if (tipo === 'info') toast.info(mensagem);
        else toast.success(mensagem);
      }
      queryClient.invalidateQueries({ queryKey: ['pedidos-ciclo'] });
      onApproved();
      onOpenChange(false);
    },
    onError: (e: Error) => {
      logger.error('Erro ao aprovar pedido', { error: e });
      toast.error(`Erro ao aprovar: ${e.message}`);
    },
  });

  // Recalcula valor total e status do pedido após remoção de item
  const recalcularPedido = async () => {
    if (!pedido) return;
    const { data: restantes, error } = await supabase
      .from('pedido_compra_item')
      .select('id, qtde_final, qtde_sugerida, preco_unitario')
      .eq('pedido_id', pedido.id);
    if (error) throw error;

    const itensRest = restantes ?? [];
    const novoTotal = itensRest.reduce((acc, it) => {
      const q = Number(it.qtde_final ?? it.qtde_sugerida ?? 0);
      const p = Number(it.preco_unitario ?? 0);
      return acc + q * p;
    }, 0);

    const updates: Record<string, unknown> = {
      valor_total: novoTotal,
      num_skus: itensRest.length,
      atualizado_em: new Date().toISOString(),
    };
    if (itensRest.length === 0) {
      updates.status = 'cancelado_humano';
      updates.cancelado_por = user?.email ?? 'sistema';
      updates.cancelado_em = new Date().toISOString();
      updates.justificativa_cancelamento = 'Todos os itens foram removidos manualmente';
      // Higiene de estado: cancelar limpa o sub-fluxo do portal (espelha cancelar_pedido_sugerido)
      // — senão um cancelado fica com status_envio_portal sujo e o check reposicao_portal_pipeline o conta.
      updates.status_envio_portal = 'nao_aplicavel';
      updates.portal_proximo_retry_em = null;
    }
    const { error: errPed } = await supabase
      .from('pedido_compra_sugerido')
      .update(updates)
      .eq('id', pedido.id);
    if (errPed) throw errPed;
    return { vazio: itensRest.length === 0 };
  };

  const removerItemMutation = useMutation({
    mutationFn: async (itemId: number) => {
      const { error } = await supabase.from('pedido_compra_item').delete().eq('id', itemId);
      if (error) throw error;
      return await recalcularPedido();
    },
    onSuccess: (res) => {
      toast.success(res?.vazio ? 'Item removido. Pedido cancelado (sem itens restantes).' : 'Item removido');
      queryClient.invalidateQueries({ queryKey: ['pedido-itens', pedido?.id] });
      queryClient.invalidateQueries({ queryKey: ['pedidos-ciclo'] });
      setRemoverItem(null);
      if (res?.vazio) onOpenChange(false);
    },
    onError: (e: Error) => {
      toast.error(`Erro ao remover item: ${e.message}`);
    },
  });

  // Só ids que ainda existem em linhas contam (item removido individualmente sai da
  // seleção sozinho — a seleção "válida" é derivada, não estado duplicado).
  const linhasSelecionadas = useMemo(
    () => linhas.filter((l) => selecionados.has(l.id)),
    [linhas, selecionados],
  );

  const toggleSelecionado = (id: number) => {
    setSelecionados((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Todos visíveis selecionados → limpa; senão seleciona todos.
  const toggleTodos = () => {
    setSelecionados((prev) => {
      const todos = linhas.length > 0 && linhas.every((l) => prev.has(l.id));
      return todos ? new Set() : new Set(linhas.map((l) => l.id));
    });
  };

  // Remoção em LOTE: mesma semântica de N remoções individuais, com UM delete (.in é
  // filtro simples — a armadilha PostgREST é o .or em UPDATE) e UM recálculo do cabeçalho.
  const removerLoteMutation = useMutation({
    mutationFn: async () => {
      const ids = linhasSelecionadas.map((l) => l.id);
      if (ids.length === 0) return { vazio: false, removidos: 0 };
      const { error } = await supabase.from('pedido_compra_item').delete().in('id', ids);
      if (error) throw error;
      const res = await recalcularPedido();
      return { vazio: res?.vazio ?? false, removidos: ids.length };
    },
    onSuccess: (res) => {
      toast.success(
        res.vazio
          ? `${res.removidos} itens removidos. Pedido cancelado (sem itens restantes).`
          : `${res.removidos} ${res.removidos === 1 ? 'item removido' : 'itens removidos'}`,
      );
      queryClient.invalidateQueries({ queryKey: ['pedido-itens', pedido?.id] });
      queryClient.invalidateQueries({ queryKey: ['pedidos-ciclo'] });
      setSelecionados(new Set());
      setConfirmarRemocaoLote(false);
      if (res.vazio) onOpenChange(false);
    },
    onError: (e: Error) => {
      toast.error(`Erro ao remover itens: ${e.message}`);
    },
  });

  const descontinuarMutation = useMutation({
    mutationFn: async (item: PedidoItem) => {
      // 1. descontinua o SKU
      const { error: errSku } = await supabase
        .from('sku_parametros')
        .update({
          tipo_reposicao: 'descontinuado',
          habilitado_reposicao_automatica: false,
        })
        .eq('empresa', pedido!.empresa)
        .eq('sku_codigo_omie', Number(item.sku_codigo_omie));
      if (errSku) throw errSku;
      // 2. remove a linha
      const { error: errDel } = await supabase.from('pedido_compra_item').delete().eq('id', item.id);
      if (errDel) throw errDel;
      return await recalcularPedido();
    },
    onSuccess: (res) => {
      toast.success(
        res?.vazio
          ? 'SKU descontinuado e item removido. Pedido cancelado (sem itens restantes).'
          : 'SKU descontinuado. Não será mais incluído em ciclos futuros.'
      );
      queryClient.invalidateQueries({ queryKey: ['pedido-itens', pedido?.id] });
      queryClient.invalidateQueries({ queryKey: ['pedidos-ciclo'] });
      setDescontinuarItem(null);
      if (res?.vazio) onOpenChange(false);
    },
    onError: (e: Error) => {
      toast.error(`Erro ao descontinuar SKU: ${e.message}`);
    },
  });

  const onEditQty = (id: number, raw: string) => {
    // [QTDE-INTEIRA] quantidade de pedido é sempre inteira (ceil; nunca fração). Campo vazio/NaN → 0.
    setEdits((prev) => ({ ...prev, [id]: quantidadeCompraInteira(Number(raw)) }));
  };

  const onEditPreco = (id: number, raw: string) => {
    setPrecoEdits((prev) => {
      if (raw.trim() === '') {
        // Campo vazio: remove o edit (volta ao placeholder), não vira 0. Codex [P2].
        const next = { ...prev };
        delete next[id];
        return next;
      }
      const v = Number(raw);
      return { ...prev, [id]: Number.isNaN(v) ? 0 : v };
    });
  };

  const podeEditar =
    pedido?.status === 'pendente_aprovacao' || pedido?.status === 'bloqueado_guardrail';
  const podeEditarCondicao = podeEditar || pedido?.status === 'aprovado_aguardando_disparo';
  // Custo de primeira compra (preço 0): definível na tela tb em falha_envio
  // (recupera o pedido sem flip de status no SQL). Ver preco-edit.ts.
  const podeEditarPreco = podeEditarPrecoPedido(pedido?.status);

  return {
    condicoes,
    itens,
    isLoading,
    edits,
    onEditQty,
    precoEdits,
    onEditPreco,
    obs,
    setObs,
    condicaoCodigo,
    setCondicaoCodigo,
    removerItem,
    setRemoverItem,
    descontinuarItem,
    setDescontinuarItem,
    linhas,
    totalAtual,
    condicaoSelecionada,
    condicaoMudou,
    salvarMutation,
    salvarCondicaoMutation,
    aprovarMutation,
    removerItemMutation,
    descontinuarMutation,
    podeEditar,
    podeEditarCondicao,
    podeEditarPreco,
    selecionados,
    toggleSelecionado,
    toggleTodos,
    linhasSelecionadas,
    confirmarRemocaoLote,
    setConfirmarRemocaoLote,
    removerLoteMutation,
  };
}
