// Teclado da listagem /sales: atalhos pelo registro do app (o diálogo `?` os descobre sozinho) e
// comandos no Cmd-K — nada de listener `keydown` solto.
//
// Padrão de foco: ROVING TABINDEX por linha (uma só linha no Tab; j/k e ↑/↓ movem). Não é
// `role="grid"`: o grid do APG exige navegação 2-D por CÉLULA, e cada linha já tem controles próprios
// (caixa de seleção, "⋯") — a célula-a-célula brigaria com eles. A semântica de leitura é de TABELA
// (table/row/cell/columnheader), com a linha focável lida pelo nome (pedido, cliente, status, total).
//
// `Enter` mora na própria linha (onKeyDown do elemento focado, como um botão): no registro global o
// `preventDefault` valeria para a página toda e engoliria o Enter dos botões e diálogos.
import { useMemo, useRef, useState, type RefObject } from 'react';
import { toast } from 'sonner';
import { useRegisterShortcuts, type Shortcut } from '@/components/shell/ShortcutsRegistry';
import { useRegisterCommands, type Command } from '@/components/shell/CommandsRegistry';
import { track } from '@/lib/analytics';
import { chaveDaLinha, podeExcluirPedido, type OrderFeedRow } from './types';
import type { FiltroStatusFeed } from './feed';

export const SELETOR_LINHA = '[data-linha-pedido]';

/**
 * WCAG 2.1.4 (atalho de uma letra): a tecla só é da lista quando o foco está NELA ou em lugar nenhum
 * (body). Com o foco em outro controle (botão "Catálogo", menu lateral, menu "⋯", diálogo), a letra é
 * desse controle — e o registro nem consome o evento (`enabled` roda antes do preventDefault).
 */
function focoLivreOuNaLista(lista: HTMLElement | null): boolean {
  const el = document.activeElement;
  if (!el || el === document.body) return true;
  return !!lista?.contains(el);
}

interface Params {
  listaRef: RefObject<HTMLElement>;
  buscaRef: RefObject<HTMLInputElement>;
  orders: OrderFeedRow[];
  selectedIds: ReadonlySet<string>;
  toggleSelect: (order: OrderFeedRow, checked: boolean) => void;
  navigate: (path: string) => void;
  setStatusFilter: (s: FiltroStatusFeed) => void;
  limparFiltros: () => void;
  comFiltro: boolean;
  /** Filtro novo a caminho: as linhas na tela são do filtro anterior — nada de selecionar. */
  buscando: boolean;
  /** Painel ou diálogo aberto por cima da lista: os atalhos da lista saem do ar. */
  bloqueado: boolean;
}

export function useTecladoPedidos(p: Params) {
  // Os handlers leem o estado MAIS RECENTE por ref: o registro não precisa re-registrar a cada render.
  const atual = useRef(p);
  atual.current = p;
  // Região de status (sr-only) da página: a seleção por "x" não muda o nome da linha — anuncia aqui.
  const [anuncio, setAnuncio] = useState('');

  const acoes = useMemo(() => {
    const linhas = () =>
      Array.from(atual.current.listaRef.current?.querySelectorAll<HTMLElement>(SELETOR_LINHA) ?? []);
    /** Linha ativa = a que tem o foco (ou contém o foco). */
    const linhaAtiva = (): HTMLElement | null => {
      const el = document.activeElement;
      const linha = el instanceof HTMLElement ? el.closest<HTMLElement>(SELETOR_LINHA) : null;
      return linha && atual.current.listaRef.current?.contains(linha) ? linha : null;
    };
    const mover = (delta: 1 | -1) => {
      const todas = linhas();
      if (todas.length === 0) return;
      const ativa = linhaAtiva();
      const i = ativa ? todas.indexOf(ativa) : -1;
      // Sem linha ativa: j entra pela primeira, k também (não há "antes da primeira").
      const alvo = i < 0 ? todas[0] : todas[Math.min(Math.max(i + delta, 0), todas.length - 1)];
      // A margem de rolagem da linha (scroll-mt) desconta a barra fixa e o título do dia grudado.
      alvo.focus();
      alvo.scrollIntoView?.({ block: 'nearest' });
    };
    const selecionar = (e: KeyboardEvent) => {
      // Tecla segurada: o auto-repeat marcaria e desmarcaria no mesmo gesto.
      if (e.repeat) return;
      const { orders, buscando, selectedIds, toggleSelect } = atual.current;
      const ativa = linhaAtiva();
      if (!ativa || buscando) return;
      const order = orders.find((o) => chaveDaLinha(o) === ativa.dataset.linhaPedido);
      if (!order) return;
      const regra = podeExcluirPedido(order);
      if (!regra.ok) {
        // A seleção só serve à exclusão em lote: quem não sai do app não entra nela — e diz por quê.
        toast.info('Este pedido não entra na seleção', { description: regra.motivo });
        return;
      }
      const marcar = !selectedIds.has(order.id);
      track('sales.pedido_acao', { acao: marcar ? 'selecionar' : 'desmarcar', via: 'teclado' });
      toggleSelect(order, marcar);
      const pv = order.order_number ? ` ${order.order_number.replace(/^0+/, '') || '0'}` : '';
      setAnuncio(`Pedido${pv} ${marcar ? 'selecionado' : 'desmarcado'}`);
    };
    const buscar = () => {
      const campo = atual.current.buscaRef.current;
      if (!campo) return;
      track('sales.pedido_acao', { acao: 'buscar', via: 'teclado' });
      campo.focus();
      campo.select();
    };
    const novo = () => {
      track('sales.pedido_acao', { acao: 'novo', via: 'teclado' });
      atual.current.navigate('/sales/new');
    };
    return {
      mover,
      selecionar,
      buscar,
      novo,
      proxima: () => mover(1),
      anterior: () => mover(-1),
      vale: () => focoLivreOuNaLista(atual.current.listaRef.current),
    };
  }, []);

  const atalhos = useMemo<Shortcut[]>(() => (p.bloqueado ? [] : [
    { keys: '/', label: 'Buscar pedido', group: 'Pedidos', handler: acoes.buscar, enabled: acoes.vale },
    { keys: 'j', label: 'Próximo pedido', group: 'Pedidos', handler: acoes.proxima, enabled: acoes.vale },
    { keys: 'k', label: 'Pedido anterior', group: 'Pedidos', handler: acoes.anterior, enabled: acoes.vale },
    { keys: 'x', label: 'Selecionar o pedido em foco (Enter abre)', group: 'Pedidos', handler: acoes.selecionar, enabled: acoes.vale },
    { keys: 'n', label: 'Novo pedido', group: 'Pedidos', handler: acoes.novo, enabled: acoes.vale },
  ]), [p.bloqueado, acoes]);
  useRegisterShortcuts(atalhos);

  // Só `comFiltro` muda a lista; as funções vêm por ref — dependências instáveis re-registrariam o
  // comando a cada render (e o registro re-renderiza quem o usa: laço).
  const { comFiltro } = p;
  const comandos = useMemo<Command[]>(() => {
    const comando = (id: string, label: string, acao: string, fazer: () => void, keywords?: string[]): Command => ({
      id, label, group: 'Ações', keywords,
      perform: (fechar) => { fechar(); track('sales.pedido_acao', { acao, via: 'comando' }); fazer(); },
    });
    return [
      comando('sales.filtrar-rascunhos', 'Pedidos: filtrar rascunhos', 'filtrar_rascunhos',
        () => atual.current.setStatusFilter('rascunhos'), ['rascunho', 'pendente']),
      comando('sales.filtrar-em-andamento', 'Pedidos: filtrar em andamento', 'filtrar_em_andamento',
        () => atual.current.setStatusFilter('em_andamento'), ['andamento', 'aberto']),
      ...(comFiltro ? [comando('sales.limpar-filtros', 'Pedidos: limpar filtros', 'limpar_filtros', () => atual.current.limparFiltros())] : []),
    ];
  }, [comFiltro]);
  useRegisterCommands(comandos);

  return { mover: acoes.mover, anuncio };
}
