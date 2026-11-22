// Linha de um pedido (venda ou afiação) na listagem.
// Densa e escaneável: no desktop é uma linha de tabela (cliente · PV · empresa · status · total ·
// ações); no celular, um card de 2 linhas. UM só markup — a grade muda de forma por breakpoint
// (grid-template-areas), então nenhum dado aparece duplicado no DOM.
import { memo, useEffect, useRef } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Trash2, Share2, Pencil, Printer, MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatPrecoOuAusente } from '@/lib/format';
import { formatarDataPedido, horaDoPedido } from '@/lib/pedido/data-pedido';
import { ORDER_STATUS, type OrderStatus } from '@/types';
import { track } from '@/lib/analytics';
import { chaveDaLinha, podeExcluirPedido, rotuloEmpresa, statusDoPedido, tomDoStatus, type OrderFeedRow, type TomStatus } from './types';

type AcaoPedido = 'compartilhar' | 'imprimir' | 'editar' | 'excluir';

/**
 * Alvo de toque: o visual fica pequeno (denso), mas em ponteiro grosso o botão volta aos 44px que o
 * `min-h-0` anularia (src/index.css, WCAG 2.5.5).
 */
const TOQUE_44 = '[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11';
const rastrearAcao = (acao: AcaoPedido, via: 'hover' | 'menu') => track('sales.pedido_acao', { acao, via });

/**
 * Grade compartilhada entre a linha e o cabeçalho de colunas da listagem (SalesOrders) — as duas
 * PRECISAM usar a mesma, senão as colunas desalinham. Literal completo: o Tailwind lê o fonte.
 */
export const GRADE_LINHA_PEDIDO =
  "grid items-center gap-x-3 grid-cols-[1rem_auto_auto_minmax(0,1fr)_auto] [grid-template-areas:'check_cliente_cliente_cliente_total''check_pv_empresa_status_acoes'] md:grid-cols-[1rem_minmax(0,1fr)_4.5rem_5.5rem_8.5rem_7rem_7.5rem] md:[grid-template-areas:'check_cliente_pv_empresa_status_total_acoes']";

const COR_DO_TOM: Record<TomStatus, { ponto: string; texto: string }> = {
  success: { ponto: 'bg-status-success', texto: 'text-status-success' },
  warning: { ponto: 'bg-status-warning', texto: 'text-status-warning' },
  error: { ponto: 'bg-status-error', texto: 'text-status-error' },
  info: { ponto: 'bg-status-info', texto: 'text-status-info' },
  neutral: { ponto: 'bg-muted-foreground/40', texto: 'text-muted-foreground' },
};

/** Pedido de venda que ainda pode ser editado (mesma regra de antes — mudar é decisão de negócio). */
const STATUS_NAO_EDITAVEIS = ['cancelado', 'entregue', 'faturado'];

function rotuloItens(quantidade: number): string {
  return `${quantidade.toLocaleString('pt-BR')} ${quantidade === 1 ? 'item' : 'itens'}`;
}

/** "Verniz, Seladora +2" — prévia do que foi vendido, pra achar o pedido de olho. */
function previaProdutos(nomes: readonly string[]): string | null {
  const limpos = nomes.filter((n) => n && n.trim());
  if (limpos.length === 0) return null;
  const primeiros = limpos.slice(0, 2).join(', ');
  return limpos.length > 2 ? `${primeiros} +${limpos.length - 2}` : primeiros;
}

/**
 * Permanência do ponteiro (ou do foco) antes de aquecer o cache do detalhe: varrer a lista com o
 * mouse não dispara as leituras de pedido, payload, perfil e descontos de cada linha que cruza.
 */
export const ATRASO_PREFETCH_MS = 250;

// Os callbacks recebem o PEDIDO (e não são closures por linha): a página passa as MESMAS funções a
// todas as linhas, e o `memo` só re-renderiza a linha cujas props de dado mudaram (ex.: `checked`).
interface SalesOrderCardProps {
  order: OrderFeedRow;
  customerName: string;
  checked: boolean;
  onSelectChange: (order: OrderFeedRow, checked: boolean) => void;
  onShare: (order: OrderFeedRow) => void;
  /**
   * Pede a exclusão: a CONFIRMAÇÃO mora na página (um diálogo só, fora das linhas — dentro da linha
   * o clique no fundo do diálogo caía no onClick dela e abria o detalhe). `gatilho` recebe o foco
   * de volta quando o diálogo fecha.
   */
  onPedirExclusao: (order: OrderFeedRow, gatilho: HTMLElement | null) => void;
  /** Exclusão deste pedido em voo: o "Excluir…" fica travado e diz "Excluindo…". */
  excluindo?: boolean;
  onNavigate: (path: string) => void;
  onOpenDetail: (order: OrderFeedRow, chave: string) => void;
  onPrint: (order: OrderFeedRow) => void;
  /**
   * Aquece o cache do detalhe — imprimir/abrir ficam instantâneos. Só depois de ATRASO_PREFETCH_MS
   * com o ponteiro (ou o foco) parado na linha; sair antes cancela.
   */
  onPrefetch?: (order: OrderFeedRow) => void;
  /**
   * Filtro novo a caminho e esta linha é do filtro ANTERIOR (keepPreviousData): nada de selecionar,
   * abrir ou agir sobre ela até a lista certa chegar. A seleção já feita fica como está.
   */
  suspenso?: boolean;
  /** Lista sem grupos por dia ("Maior valor"): a linha mostra a data no lugar só da hora. */
  mostrarData?: boolean;
  /**
   * Roving tabindex: só UMA linha da lista fica no Tab (a ativa); as outras se alcançam por j/k ou ↑/↓.
   */
  focavel?: boolean;
  /** A linha recebeu foco (clique, Tab, j/k): vira a linha ativa da página (pela chave). */
  onFocusLinha?: (chave: string) => void;
  /** ↑/↓ com o foco na linha: move para a vizinha (o mesmo que k/j). */
  onMover?: (delta: 1 | -1) => void;
}

export const SalesOrderCard = memo(function SalesOrderCard({
  order,
  customerName,
  checked,
  onSelectChange,
  onShare,
  onPedirExclusao,
  excluindo = false,
  onNavigate,
  onOpenDetail,
  onPrint,
  onPrefetch,
  suspenso = false,
  mostrarData = false,
  focavel = false,
  onFocusLinha,
  onMover,
}: SalesOrderCardProps) {
  const gatilhoRef = useRef<HTMLButtonElement>(null);
  const chave = chaveDaLinha(order);
  // Prefetch adiado: um timer por linha, que só cai quando NEM o ponteiro NEM o foco seguem na linha
  // (sair com o mouse não cancela o que o foco do teclado ainda sustenta — Codex) e ao desmontar.
  const timerPrefetch = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presenca = useRef({ ponteiro: false, foco: false });
  const sair = (modo: 'ponteiro' | 'foco') => {
    presenca.current[modo] = false;
    if (presenca.current.ponteiro || presenca.current.foco) return;
    if (timerPrefetch.current !== null) clearTimeout(timerPrefetch.current);
    timerPrefetch.current = null;
  };
  const entrar = (modo: 'ponteiro' | 'foco') => {
    presenca.current[modo] = true;
    if (!onPrefetch || timerPrefetch.current !== null) return;
    timerPrefetch.current = setTimeout(() => {
      timerPrefetch.current = null;
      onPrefetch(order);
    }, ATRASO_PREFETCH_MS);
  };
  useEffect(() => {
    const timer = timerPrefetch;
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);
  const isAfiacao = order.origin === 'afiacao';
  // A seleção só serve à exclusão em lote: só entra quem a edge pode excluir.
  const exclusao = podeExcluirPedido(order);
  const isSelectable = exclusao.ok;
  const podeEditar = !isAfiacao && !STATUS_NAO_EDITAVEIS.includes(order.status);
  // Afiação usa o vocabulário de ORDER_STATUS; o tom (cor só no que pede atenção) é o mesmo da venda.
  const status = isAfiacao && order.status in ORDER_STATUS
    ? { label: ORDER_STATUS[order.status as OrderStatus].label }
    : statusDoPedido(order.status);
  const cor = COR_DO_TOM[tomDoStatus(order.status)];
  const pv = order.order_number ? order.order_number.replace(/^0+/, '') || '0' : null;
  // item_quantity da view = soma das quantidades (o mesmo que o reduce antigo fazia).
  const quantidade = Number(order.item_quantity);
  const itens = Number.isFinite(quantidade) ? rotuloItens(quantidade) : null;
  const produtos = previaProdutos(order.item_names ?? []);
  const hora = mostrarData ? formatarDataPedido(order.created_at, 'dd/MM/yyyy HH:mm') : horaDoPedido(order.created_at);
  const detalhe = [produtos, hora].filter(Boolean).join(' · ');
  const nomeAcessivel = pv ? `pedido ${pv} de ${customerName}` : `pedido de ${customerName}`;

  const abrir = (origem: 'linha' | 'nome' | 'teclado') => {
    if (suspenso) return;
    track('sales.pedido_aberto', { origem });
    if (isAfiacao) onNavigate(`/orders/${order.id}`);
    else onOpenDetail(order, chave);
  };
  const editar = (via: 'hover' | 'menu') => {
    rastrearAcao('editar', via);
    onNavigate(`/sales/edit/${order.id}`);
  };
  const compartilhar = (via: 'hover' | 'menu') => {
    rastrearAcao('compartilhar', via);
    onShare(order);
  };
  const imprimir = (via: 'hover' | 'menu') => {
    rastrearAcao('imprimir', via);
    onPrint(order);
  };
  const parar = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      role="row"
      tabIndex={focavel ? 0 : -1}
      data-linha-pedido={chave}
      aria-label={`${nomeAcessivel}, ${status.label}, ${formatPrecoOuAusente(Number(order.total))}`}
      className={cn(
        GRADE_LINHA_PEDIDO,
        'group gap-y-1 px-3 py-2.5 transition-colors md:py-2',
        'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        // j/k rolam a linha para a vista: a margem desconta a barra fixa + título do dia (+ faixa "Ver como").
        'scroll-mt-[calc(theme(spacing.topbar)+4.5rem)]',
        suspenso ? 'cursor-wait' : 'cursor-pointer hover:bg-muted/40',
        checked && 'bg-muted/60 hover:bg-muted/60',
      )}
      onClick={() => abrir('linha')}
      onMouseEnter={() => entrar('ponteiro')}
      onMouseLeave={() => sair('ponteiro')}
      onFocus={(e) => {
        // Foco num controle de DENTRO da linha também a torna ativa (Tab até o "⋯" conta).
        onFocusLinha?.(chave);
        if (e.target === e.currentTarget) entrar('foco');
      }}
      onBlur={(e) => {
        // j/k passando rápido pela linha não aquece; o foco indo para um controle de dentro, sim.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) sair('foco');
      }}
      onKeyDown={(e) => {
        // Só quando o foco está NA linha (Enter num botão interno é do botão), sem modificador
        // (Ctrl/Alt/Meta/Shift+seta são do sistema ou do leitor de tela) e se ninguém já tratou.
        if (e.target !== e.currentTarget || e.defaultPrevented) return;
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          abrir('teclado');
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          onMover?.(e.key === 'ArrowDown' ? 1 : -1);
        }
      }}
    >
      <div role="cell" className="[grid-area:check] flex items-center self-center">
        {isSelectable && (
          <Checkbox
            checked={checked}
            disabled={suspenso}
            onClick={parar}
            onCheckedChange={(v) => onSelectChange(order, !!v)}
            aria-label={`Selecionar ${nomeAcessivel}`}
          />
        )}
      </div>

      <div role="cell" className="[grid-area:cliente] min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            disabled={suspenso}
            onClick={(e) => {
              parar(e);
              abrir('nome');
            }}
            // A área de toque cresce por um ::after (±12px) — o texto continua denso; o truncate mora no
            // span de dentro porque overflow:hidden no botão cortaria o ::after.
            className="relative min-h-0 min-w-0 max-w-full rounded-sm text-left text-sm font-medium hover:underline focus-visible:ring-offset-0 after:absolute after:inset-x-0 after:-inset-y-3 after:content-['']"
          >
            <span className="block truncate">{customerName}</span>
          </button>
          {/* Afiação opera sob Colacor SC — a tag distingue serviço de venda. */}
          {isAfiacao && (
            <span className="shrink-0 rounded border border-dashed px-1 text-[11px] leading-4 text-muted-foreground">
              Afiação
            </span>
          )}
        </div>
        {/* No celular também (compacto): a hora e o que foi vendido acham o pedido de olho. */}
        {detalhe && <p className="truncate text-[11px] leading-4 text-muted-foreground md:text-xs">{detalhe}</p>}
      </div>

      <div role="cell" className="[grid-area:pv] text-xs text-muted-foreground md:text-sm">
        {pv ? (
          <>
            <span className="md:hidden">PV </span>
            <span className="font-tabular text-foreground md:text-muted-foreground">{pv}</span>
          </>
        ) : (
          <span className="hidden md:inline">—</span>
        )}
      </div>

      <div role="cell" className="[grid-area:empresa] truncate text-xs text-muted-foreground md:text-sm">
        <span className="md:hidden" aria-hidden>· </span>
        {rotuloEmpresa(order.account)}
      </div>

      <div role="cell" className="[grid-area:status] min-w-0 pl-1 md:pl-0">
        <span className={cn('inline-flex items-center gap-1.5 text-xs md:text-sm', cor.texto)}>
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', cor.ponto)} aria-hidden />
          <span className="truncate">{status.label}</span>
        </span>
      </div>

      <div role="cell" className="[grid-area:total] text-right">
        <p className="font-tabular text-sm font-semibold">{formatPrecoOuAusente(Number(order.total))}</p>
        {itens && <p className="text-[11px] leading-4 text-muted-foreground">{itens}</p>}
      </div>

      <div role="cell" className="[grid-area:acoes] flex items-center justify-end gap-0.5" onClick={parar}>
        {/* Atalhos no desktop: aparecem no hover/foco da linha; no toque, tudo fica no "⋯". */}
        {/* Só com ponteiro FINO: em tablet de toque (md + coarse) os 44px de cada botão invadiriam o Total,
            e um alvo invisível (opacity-0) levaria o toque. */}
        <div className="hidden items-center gap-0.5 transition-opacity md:[@media(pointer:fine)]:flex md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
          <Button variant="ghost" size="icon" className={cn('h-7 w-7 min-h-0', TOQUE_44)} disabled={suspenso} onClick={() => compartilhar('hover')} title="Compartilhar via WhatsApp" aria-label={`Compartilhar ${nomeAcessivel}`}>
            <Share2 className="h-3.5 w-3.5" />
          </Button>
          {!isAfiacao && (
            <Button variant="ghost" size="icon" className={cn('h-7 w-7 min-h-0', TOQUE_44)} disabled={suspenso} onClick={() => imprimir('hover')} title="Imprimir pedido" aria-label={`Imprimir ${nomeAcessivel}`}>
              <Printer className="h-3.5 w-3.5" />
            </Button>
          )}
          {podeEditar && (
            <Button variant="ghost" size="icon" className={cn('h-7 w-7 min-h-0', TOQUE_44)} disabled={suspenso} onClick={() => editar('hover')} title="Editar pedido" aria-label={`Editar ${nomeAcessivel}`}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button ref={gatilhoRef} disabled={suspenso} variant="ghost" size="icon" className={cn('h-7 w-7 min-h-0', TOQUE_44)} aria-label={`Mais ações do ${nomeAcessivel}`}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={parar}>
            {podeEditar && (
              <DropdownMenuItem onSelect={() => editar('menu')}>
                <Pencil className="mr-2 h-3.5 w-3.5" /> Editar
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => compartilhar('menu')}>
              <Share2 className="mr-2 h-3.5 w-3.5" /> Compartilhar no WhatsApp
            </DropdownMenuItem>
            {!isAfiacao && (
              <DropdownMenuItem onSelect={() => imprimir('menu')}>
                <Printer className="mr-2 h-3.5 w-3.5" /> Imprimir
              </DropdownMenuItem>
            )}
            {!isAfiacao && (
              <>
                <DropdownMenuSeparator />
                {exclusao.ok ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      rastrearAcao('excluir', 'menu');
                      onPedirExclusao(order, gatilhoRef.current);
                    }}
                    disabled={excluindo}
                    className="text-status-error focus:text-status-error"
                  >
                    <Trash2 className="mr-2 h-3.5 w-3.5" /> {excluindo ? 'Excluindo…' : 'Excluir…'}
                  </DropdownMenuItem>
                ) : (
                  // Desabilitado COM o motivo: a vendedora sabe o que fazer em vez de tentar e levar erro.
                  <DropdownMenuItem disabled className="flex-col items-start gap-0.5">
                    <span className="flex items-center">
                      <Trash2 className="mr-2 h-3.5 w-3.5" /> Excluir
                    </span>
                    <span className="max-w-[15rem] whitespace-normal text-[11px] leading-snug">{exclusao.motivo}</span>
                  </DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

    </div>
  );
});
