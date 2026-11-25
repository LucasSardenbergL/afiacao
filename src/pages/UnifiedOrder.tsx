import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle, Building2, Scissors, Wifi, Palette } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Badge } from '@/components/ui/badge';
import { track } from '@/lib/analytics';
import { registrarSucessoNoDestino } from '@/lib/nav/sensor-clientes';
import { estadoDaNavegacaoAtual } from '@/lib/nav/origem-atual';
import { caminhoInternoSeguro } from '@/lib/destino-pos-login';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RecommendationsPanel } from '@/components/RecommendationsPanel';
import { AddToolDialog } from '@/components/AddToolDialog';
import { UnifiedAIAssistant } from '@/components/UnifiedAIAssistant';
import { TintColorSelectDialog } from '@/components/TintColorSelectDialog';
import { CorPrimeiroDialog } from '@/components/tintColorSelect/CorPrimeiroDialog';
import { OrderSuccessDialog } from '@/components/OrderSuccessDialog';
import { AtpBackorderDialog } from '@/components/unified-order/AtpBackorderDialog';
import { cn } from '@/lib/utils';
import { useUnifiedOrder, type Product } from '@/hooks/useUnifiedOrder';
import { useOrderDeepLink } from '@/hooks/useOrderDeepLink';
import { useOrderDraft } from '@/hooks/useOrderDraft';
import { decidirParcelaDoRascunho, lerParcelasDoRascunho, type ParcelasDoRascunho } from '@/hooks/unifiedOrder/parcela-manual';
import { codigoClienteIdentifica, decidirRestore, resolverRestorePendente } from '@/hooks/unifiedOrder/restore-rascunho';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { useOfflineSubmit } from '@/hooks/useOfflineSubmit';
import { RestoreDraftDialog } from '@/components/unified-order/RestoreDraftDialog';
import { decidirDescarteRascunho } from '@/services/orderSubmission/checkout-envelope';
import { CustomerSearch } from '@/components/unified-order/CustomerSearch';
import { AlertaCreditoCliente } from '@/components/unified-order/AlertaCreditoCliente';
import { SeloSituacaoReceita } from '@/components/receita/SeloSituacaoReceita';
import { AvisoVinculoCredito } from '@/components/credito-vinculo/AvisoVinculoCredito';
import { TierClienteBadge } from '@/components/unified-order/TierClienteBadge';
import { ExcecaoCreditoDialog } from '@/components/unified-order/ExcecaoCreditoDialog';
import type { BloqueioCreditoPedido } from '@/services/orderSubmission';
import { CoresDoClienteCard } from '@/components/unified-order/CoresDoClienteCard';
import { chaveOcorrenciaCor } from '@/lib/unified-order/chave-ocorrencia-cor';
import { useCoresDoCliente } from '@/hooks/unifiedOrder/useCoresDoCliente';
import { useTintCoresDoClienteUmToque, type AlvoUmToque } from '@/hooks/useTintCoresDoClienteUmToque';
import type { CorDoCliente, OcorrenciaCor } from '@/lib/tint/cores-do-cliente';
import { termoBuscaCor } from '@/lib/tint/cores-do-cliente';
import { montarPlanoReplicacao, type ItemTinta } from '@/lib/pedido/replicar-pedido';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { ProductItemForm } from '@/components/unified-order/ProductItemForm';
import { useCurrentSpecsMap } from '@/hooks/useProductSpecLink';
import { useCatalisadorLinksMap } from '@/hooks/useCatalisadorLink';
import { naoConsegui } from '@/lib/leitura/estado-de-leitura';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { keyDeSku } from '@/lib/knowledge-base/spec-link';
import { montarSelosVendaAssistida } from '@/lib/venda-assistida/selos';
import type { ProdutoLinhaOmie } from '@/lib/venda-assistida/montar-embalagens';
import { ServiceItemForm } from '@/components/unified-order/ServiceItemForm';
import { CartItemList } from '@/components/unified-order/CartItemList';
import { CartSummaryBar } from '@/components/unified-order/CartSummaryBar';
import { BarraEnvioPedido } from '@/components/unified-order/BarraEnvioPedido';
import { motivosEnvioBloqueado, envioBloqueado, type EntradaMotivosEnvio } from '@/components/unified-order/motivos-envio';
import { shareOrderViaWhatsApp } from '@/utils/whatsappShare';
import { useRegisterShortcuts } from '@/components/shell/ShortcutsRegistry';

function OrderStepper({ step, isCustomerMode }: { step: number; isCustomerMode: boolean }) {
  const steps = isCustomerMode ? ['Itens', 'Revisão'] : ['Cliente', 'Itens', 'Revisão'];
  return (
    <ol aria-label="Etapas do pedido" className="flex items-center gap-2">
      {steps.map((s, i) => (
        <li key={s} className="flex items-center gap-2" aria-current={i === step ? 'step' : undefined}>
          <div className={cn('w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium transition-colors',
            i <= step ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
            {i < step ? <CheckCircle className="w-3.5 h-3.5" aria-hidden /> : i + 1}
          </div>
          <span className={cn('text-xs font-medium', i <= step ? 'text-foreground' : 'text-muted-foreground')}>
            {s}{i < step && <span className="sr-only"> (concluída)</span>}
          </span>
          {i < steps.length - 1 && <div aria-hidden className={cn('w-8 h-px', i < step ? 'bg-primary' : 'bg-border')} />}
        </li>
      ))}
    </ol>
  );
}

const SEM_DESCRICOES = new Map<number, string>();

/** Foca o campo marcado com `data-atalho` (cada um existe uma vez por vez na tela). */
function focarAtalho(alvo: 'busca-cliente' | 'busca-produto' | 'assistente-pedido') {
  document.querySelector<HTMLElement>(`[data-atalho="${alvo}"]`)?.focus();
}

const UnifiedOrder = () => {
  const h = useUnifiedOrder();
  const { isCustomerMode } = h;
  const { user } = useAuth();
  // Fichas técnicas (boletim↔SKU): mapa pequeno (só vínculos confirmados+aprovados), 1 query.
  const { byKey: fichasByKey } = useCurrentSpecsMap();
  // Casamento do catalisador (Fatia 3): mapa global keyDeCatalisador → SKUs (destrava preço catalisado).
  // `estado` é lido de propósito: sob falha (ou offline) o mapa sai VAZIO, o selo degrada a
  // "sob consulta" e o vendedor não distingue "este produto não tem casamento confirmado" de
  // "não consegui ler os casamentos" — e as duas pedem ações OPOSTAS (pedir o casamento ao
  // master × esperar/recarregar). O valor vazio é o fallback certo; o silêncio não era.
  const { byKey: catalisadorByKey, estado: estadoCatalisador } = useCatalisadorLinksMap();
  // Venda assistida: selo "preparado" por produto. Resolve estado+preço de cada boletim reusando o
  // catálogo JÁ carregado (zero query nova) e espalha por SKU. Vendedor-only.
  const selosByKey = useMemo(() => {
    const catalogByKey = new Map<string, ProdutoLinhaOmie>();
    for (const p of [...h.obenProducts, ...h.colacorProducts]) {
      catalogByKey.set(keyDeSku(p.account, p.omie_codigo_produto), {
        omie_codigo_produto: p.omie_codigo_produto,
        descricao: p.descricao,
        valor_unitario: p.valor_unitario,
        estoque: p.estoque ?? null, // ausente ≠ zero (follow-up #4087): não vira "Encomenda"
      });
    }
    // Preço-do-cliente (último praticado) POR CONTA — omie_codigo_produto colide entre Oben/Colacor,
    // então o helper lê do mapa da conta de cada SKU (não achata num Record só).
    const customerPricesByAccount = { oben: h.customerPricesOben, colacor: h.customerPricesColacor };
    return montarSelosVendaAssistida([...fichasByKey.values()], catalogByKey, customerPricesByAccount, catalisadorByKey);
  }, [fichasByKey, catalisadorByKey, h.obenProducts, h.colacorProducts, h.customerPricesOben, h.customerPricesColacor]);
  const [restoreOpen, setRestoreOpen] = useState(false);
  // Catálogo entregue à IA: memoizado pelas listas de origem (antes era copiado a cada render/tecla).
  const catalogoIA = useMemo(() => [...h.obenProducts, ...h.colacorProducts], [h.obenProducts, h.colacorProducts]);

  // Atalhos do balcão (staff): pular entre cliente, produto e assistente sem o mouse. O "?" lista.
  useRegisterShortcuts(useMemo(() => isCustomerMode ? [] : [
    { keys: 'c', label: 'Buscar cliente', group: 'Novo pedido', scope: 'page' as const, handler: () => focarAtalho('busca-cliente') },
    { keys: 'p', label: 'Buscar produto', group: 'Novo pedido', scope: 'page' as const, handler: () => focarAtalho('busca-produto') },
    { keys: 'a', label: 'Assistente de pedido', group: 'Novo pedido', scope: 'page' as const, handler: () => focarAtalho('assistente-pedido') },
  ], [isCustomerMode]));

  // Cliente escolhido → foco segue para a busca de produto (o próximo passo). Só com teclado
  // físico: no toque, focar abriria o teclado virtual por cima da tela.
  const codigoClienteAtual = h.selectedCustomer?.codigo_cliente ?? null;
  const codigoClienteAnterior = useRef(codigoClienteAtual);
  useEffect(() => {
    const anterior = codigoClienteAnterior.current;
    codigoClienteAnterior.current = codigoClienteAtual;
    if (codigoClienteAtual == null || codigoClienteAtual === anterior || isCustomerMode) return;
    if (!window.matchMedia?.('(pointer: fine)').matches) return;
    const id = requestAnimationFrame(() => focarAtalho('busca-produto'));
    return () => cancelAnimationFrame(id);
  }, [codigoClienteAtual, isCustomerMode]);

  // "Cores do cliente": histórico de cores + pré-preenchimento do dialog de tingir.
  const coresDoCliente = useCoresDoCliente(h.customerUserId);
  const [tintInitialSearch, setTintInitialSearch] = useState<string | null>(null);
  // Trava de crédito (Fase 2): bloqueio selecionado no painel de resultado → dialog de exceção.
  const [excecaoBloqueio, setExcecaoBloqueio] = useState<BloqueioCreditoPedido | null>(null);
  // Produto-base de uma ocorrência do histórico, se ainda for base tintométrica no catálogo.
  const baseDaOcorrencia = (oc: OcorrenciaCor) => {
    const pool = oc.account === 'colacor' ? h.colacorProducts : h.obenProducts;
    const product =
      oc.omieCodigoProduto != null
        ? pool.find((p) => p.omie_codigo_produto === oc.omieCodigoProduto)
        : undefined;
    return product?.is_tintometric && product.tint_type === 'base' ? product : undefined;
  };
  // Fase 2A — "Cores do cliente" em 1 toque: só as ocorrências VISÍVEIS (as mesmas
  // 4 por cor que o card mostra) e só da Oben (o tintométrico só existe lá).
  const alvosUmToque = useMemo<AlvoUmToque<Product>[]>(() => {
    const out: AlvoUmToque<Product>[] = [];
    for (const cor of coresDoCliente.coresFiltradas.slice(0, 20)) {
      cor.ocorrencias.slice(0, 4).forEach((oc, i) => {
        const product = oc.account === 'oben' ? baseDaOcorrencia(oc) : undefined;
        if (!product) return;
        // Identidade exata quando o item nasceu no app; do rótulo livre, o código extraído
        // só vale com nome compatível (Codex P1 rodada 2).
        out.push(
          oc.corId
            ? { key: chaveOcorrenciaCor(cor.nome, i), product, codigo: oc.corId, rotulo: null }
            : { key: chaveOcorrenciaCor(cor.nome, i), product, codigo: termoBuscaCor(cor.nome), rotulo: cor.nome },
        );
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- baseDaOcorrencia só lê os pools abaixo
  }, [coresDoCliente.coresFiltradas, h.obenProducts, h.colacorProducts]);
  const umToque = useTintCoresDoClienteUmToque(alvosUmToque);
  const handleAdicionarUmToque = (chave: string, oc: OcorrenciaCor) => {
    const pronto = umToque[chave];
    // Fail-closed: o estado pode ter mudado entre o render e o toque (preço recarregando).
    if (typeof pronto !== 'object') return;
    const resultado = h.addTintProductToCart(
      pronto.product,
      pronto.formulaId,
      pronto.corId,
      pronto.nomeCor,
      pronto.preco,
      pronto.custoCorantes,
      // Fonte do default (regra do maior), sem desconto: o gate revalida esta decisão.
      { source: pronto.fonte, discountPct: 0, precoSemDesconto: pronto.preco },
      oc.quantidade > 0 ? oc.quantidade : 1,
    );
    // Só anuncia (e conta) o que entrou de fato — o conflito já avisou por conta própria.
    if (resultado !== 'adicionado') return;
    track('tint.cor_confirmada', { fonte: pronto.fonte, alternativa: false, com_desconto: false, entrada: 'um_toque' });
    toast.success(`${pronto.corId} adicionada`, { description: pronto.product.descricao });
  };
  const [corPrimeiroAberto, setCorPrimeiroAberto] = useState(false);
  const handleRepetirCor = (cor: CorDoCliente, oc: OcorrenciaCor) => {
    const product = baseDaOcorrencia(oc);
    if (product) {
      track('pedido.repetir_cor');
      // Busca pelo CÓDIGO da cor, não pelo rótulo cru do histórico ("346J -
      // PLATINA BIANCA 900ML") — o rótulo não casa com cor_id/nome_cor do catálogo.
      setTintInitialSearch(termoBuscaCor(cor.nome));
      h.setTintPendingProduct(product);
      return;
    }
    // Degradação honesta: base fora do catálogo (inativa/outro painel) ou sem
    // fluxo de cor → pré-preenche a busca de produtos pra ela seguir manualmente.
    h.setProductSearch(oc.baseDescricao);
    if (oc.account === 'oben' || oc.account === 'colacor') h.setActiveTab(oc.account);
    toast.info('Base fora do fluxo automático de cor', {
      description: 'Pré-preenchi a busca de produtos com a base daquele pedido — adicione manualmente.',
    });
  };

  const [searchParams] = useSearchParams();
  const preselectCustomerId = searchParams.get('customer');
  const preselectedRef = useRef(false);

  // returnTo da fila (G1 Fase 3): só path interno (guard anti-open-redirect, vem da URL).
  // O guard é o mesmo do login: o caseiro deixava passar `/\host`, que o navegador lê como `//host`
  // e o react-router <6.30.6 manda para `location.assign` quando o pushState recusa a outra origem.
  const returnTo = caminhoInternoSeguro(searchParams.get('returnTo'));

  /* ─── "Repetir pedido" (?repeat=<sales_order_id>) ───
   * One-shot após cliente + catálogo prontos (padrão do deep-link): busca o
   * pedido antigo, monta o plano (helper puro) e aplica — itens comuns entram
   * direto (qtd antiga, PREÇO ATUAL do cliente); bases tintométricas entram
   * numa fila que abre o dialog de cor um a um (humano confirma cada tinta). */
  const repeatId = searchParams.get('repeat');
  const repeatHandled = useRef(false);
  const [tintQueue, setTintQueue] = useState<ItemTinta[]>([]);

  useEffect(() => {
    if (
      preselectCustomerId &&
      h.isStaff &&
      !h.selectedCustomer &&
      !preselectedRef.current
    ) {
      preselectedRef.current = true;
      void h.selectCustomerByUserId(preselectCustomerId);
    }
  }, [preselectCustomerId, h.isStaff, h.selectedCustomer, h.selectCustomerByUserId]);

  // Aplica a replicação quando tudo está pronto (cliente + catálogo da conta do pedido).
  useEffect(() => {
    if (!repeatId || repeatHandled.current || !h.isStaff || !h.selectedCustomer || !h.customerUserId) return;
    // Catálogo ainda carregando → espera (senão todo item cairia em "fora do catálogo").
    if (h.loadingObenProducts || h.loadingColacorProducts) return;
    repeatHandled.current = true;
    void (async () => {
      const { data: pedido, error } = await supabase
        .from('sales_orders')
        .select('id, account, items, omie_numero_pedido, customer_user_id')
        .eq('id', repeatId)
        .maybeSingle();
      if (error || !pedido) {
        toast.error('Não consegui carregar o pedido pra repetir.');
        return;
      }
      if (pedido.customer_user_id !== h.customerUserId) {
        toast.error('O pedido a repetir é de outro cliente.');
        return;
      }
      const catalogo = pedido.account === 'colacor' ? h.colacorProducts : h.obenProducts;
      const plano = montarPlanoReplicacao(pedido.items, catalogo);
      for (const d of plano.diretos) h.addProductToCart(d.product, d.quantidade);
      if (plano.tintas.length > 0) setTintQueue(plano.tintas);
      track('pedido.repetir_pedido');
      const pv = (pedido.omie_numero_pedido ?? '').replace(/^0+/, '');
      const partes = [
        plano.diretos.length > 0 ? `${plano.diretos.length} no carrinho` : null,
        plano.tintas.length > 0 ? `${plano.tintas.length} de tinta pra confirmar a cor` : null,
        plano.foraDoCatalogo.length > 0 ? `${plano.foraDoCatalogo.length} fora do catálogo` : null,
      ].filter(Boolean);
      if (partes.length === 0) {
        toast.info(`Pedido${pv ? ` ${pv}` : ''} sem itens replicáveis.`);
      } else {
        toast.success(`Pedido${pv ? ` ${pv}` : ''} replicado: ${partes.join(' · ')}`, {
          description: plano.foraDoCatalogo.length > 0 ? `Fora do catálogo: ${plano.foraDoCatalogo.join('; ')}` : undefined,
        });
      }
    })();
    // h é objeto novo a cada render; deps nos campos usados.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repeatId, h.isStaff, h.selectedCustomer, h.customerUserId, h.obenProducts, h.colacorProducts, h.loadingObenProducts, h.loadingColacorProducts]);

  // Fila de tintas da replicação: abre o dialog de cor um a um (o próximo
  // entra quando o atual fecha — confirmado OU cancelado, que é "pular").
  useEffect(() => {
    if (h.tintPendingProduct || tintQueue.length === 0) return;
    const [proxima, ...resto] = tintQueue;
    setTintQueue(resto);
    // Mesmo motivo do "Pedir de novo": pré-busca pelo código, não pelo rótulo cru.
    setTintInitialSearch(proxima.nomeCor ? termoBuscaCor(proxima.nomeCor) : null);
    // A qtd do pedido antigo viaja até a confirmação da cor (antes nascia com 1).
    h.setTintPendingProduct(proxima.product, proxima.quantidade);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h.tintPendingProduct, tintQueue]);

  useOrderDeepLink({
    selectedCustomer: h.selectedCustomer,
    addProductToCart: h.addProductToCart,
    obenProducts: h.obenProducts,
    colacorProducts: h.colacorProducts,
    loadingObenProducts: h.loadingObenProducts,
    loadingColacorProducts: h.loadingColacorProducts,
    loadingCustomer: h.loadingCustomer,
  });

  // ─── Auto-save de rascunho ───
  // Salva snapshot enquanto vendedor digita; mostra dialog para restaurar se voltar à tela com cart vazio.
  // Limpa após pedido enviado com sucesso (orderSuccessOpen = true).
  const draftScope = user?.id ?? 'anon';
  const { parcelasManuaisDaSelecao } = h;
  const draftPayload = useMemo(
    () => ({
      cart: h.cart,
      customerCodigoCliente: h.selectedCustomer?.codigo_cliente ?? null,
      customerName: h.selectedCustomer?.razao_social ?? null,
      notes: h.notes,
      ordemCompra: h.ordemCompra,
      // B7 (rodada 2): só o prazo escolhido À MÃO nesta seleção — o do histórico é reaplicado sozinho.
      parcelasManuais: parcelasManuaisDaSelecao(),
    }),
    [h.cart, h.selectedCustomer, h.notes, h.ordemCompra, parcelasManuaisDaSelecao],
  );
  const { draft, clear: clearDraft, dismiss: dismissDraft, gravarAgora: gravarRascunhoAgora } = useOrderDraft({
    scopeKey: draftScope,
    state: draftPayload,
    shouldSave: h.cart.length > 0,
    // A6 (rodada 2): limpa SÓ quando o envio foi confirmado em TODAS as contas. Pendência de ERP
    // (ou bloqueio) mantém o carrinho — apagar o rascunho perderia o pedido num refresh.
    clearTrigger: h.orderSuccessOpen && h.ultimoEnvioConfirmado,
  });

  // Ciclo único envelope × rascunho no ENVIO: o rascunho em disco é o carrinho exato do envelope
  // (gravado no commit) e morre com ele no sucesso total — sem depender do debounce nem do
  // clearTrigger desta página (que não roda se ela desmontou durante o envio).
  useEffect(() => {
    h.cicloRascunhoRef.current = {
      aoComprometer: () => gravarRascunhoAgora(draftPayload),
      aoConfirmarTudo: clearDraft,
    };
  }, [h.cicloRascunhoRef, gravarRascunhoAgora, draftPayload, clearDraft]);

  // Gate offline-first do envio: offline salva rascunho (já auto-salvo acima) e expõe
  // CTA de reconexão; nunca enfileira (submitOrder cria PV cobrado no Omie).
  const net = useNetworkStatus();
  const offlineSubmit = useOfflineSubmit({
    submit: h.submitOrder,
    online: net.online,
    hasContent: h.cart.length > 0,
  });

  // Oferece restore se houver draft pendente E o cart atual estiver vazio (entrou novo na tela).
  useEffect(() => {
    if (draft && h.cart.length === 0 && !restoreOpen) {
      setRestoreOpen(true);
    }
  }, [draft, h.cart.length, restoreOpen]);

  // Telemetria: pedido enviado com sucesso (dispara uma vez ao abrir o success dialog)
  useEffect(() => {
    if (h.orderSuccessOpen && h.lastOrderData) {
      // Sensor de Clientes (onda C): o "Novo pedido" da lista/360/cadastro só é sucesso no pedido ENVIADO.
      registrarSucessoNoDestino(estadoDaNavegacaoAtual(), 'novo_pedido');
      track('pedido.criado', {
        modo: isCustomerMode ? 'customer' : 'staff',
        num_itens: h.lastOrderData.items?.length ?? 0,
        valor_total: h.lastOrderData.total ?? 0,
        num_pedidos: h.lastOrderData.orderNumbers?.length ?? 0,
      });
    }
  }, [h.orderSuccessOpen, h.lastOrderData, isCustomerMode]);

  // Restore PENDENTE (follow-up Codex P1 do #4068): rascunho de A restaurado sem cliente na tela
  // punha o carrinho de A na tela e, se a vendedora selecionasse B, os itens (com preço negociado
  // para A) iam no pedido de B. Agora o restore inteiro espera o cliente DO rascunho.
  type DadosDoRascunho = { cart: unknown; notes: unknown; ordemCompra: unknown; parcelas: ParcelasDoRascunho | null };
  const restorePendenteRef = useRef<{ codigoCliente: number; nome: string | null; dados: DadosDoRascunho } | null>(null);
  // Aplica com os setters do render CORRENTE (os que marcam o prazo como "manual" na seleção nova).
  const aplicarDadosDoRascunho = (d: DadosDoRascunho, prazoVolta: boolean) => {
    if (Array.isArray(d.cart)) h.setCart(d.cart);
    if (typeof d.notes === 'string') h.setNotes(d.notes);
    if (typeof d.ordemCompra === 'string') h.setOrdemCompra(d.ordemCompra);
    // B7 (rodada 2): o prazo escolhido à mão volta pelos setters EXPORTADOS, então a `ultima_parcela`
    // do histórico não o sobrescreve. Só com cliente identificado (código 0 não identifica ninguém).
    // Follow-up do #4068: só volta o código que a lista do Omie DESTA conta ainda tem.
    if (prazoVolta && d.parcelas?.oben) reaplicarParcelaDoRascunho('oben', d.parcelas.oben);
    if (prazoVolta && d.parcelas?.colacor) reaplicarParcelaDoRascunho('colacor', d.parcelas.colacor);
  };
  // Lista POR CONTA (Codex P1): o `loadingFormas` global junta as duas consultas — a Colacor
  // carregando fazia o prazo da Oben, já conferível, sair como "inconferível".
  const decidirParcelaDaConta = (conta: 'oben' | 'colacor', codigo: string) => {
    const formas = conta === 'oben' ? h.sortedFormasPagamentoOben : h.sortedFormasPagamentoColacor;
    const estado = conta === 'oben' ? h.estadoFormasOben : h.estadoFormasColacor;
    return decidirParcelaDoRascunho(codigo, { formas, degradado: estado.degradado, carregada: !estado.erro });
  };
  const avisarParcelaRetirada = (conta: 'oben' | 'colacor', codigo: string) => {
    // Prova positiva (lista completa sem o código): bloqueia o envio enquanto ele estiver selecionado,
    // inclusive se a sugestão do histórico o trouxer de volta (Codex P1).
    h.marcarParcelaRetirada(conta, codigo);
    toast.warning(`Prazo ${conta === 'oben' ? 'Oben' : 'Colacor'} do rascunho não existe mais no Omie`, {
      description: `O prazo ${codigo} foi retirado. Escolha o prazo de novo antes de enviar.`,
    });
  };
  // Restore com a lista da conta ainda chegando: reaplica (preserva a escolha manual, como antes) e
  // confere quando ela chegar.
  const [parcelasAConferir, setParcelasAConferir] = useState<{ oben: string | null; colacor: string | null }>({ oben: null, colacor: null });
  const reaplicarParcelaDoRascunho = (conta: 'oben' | 'colacor', codigo: string) => {
    const decisao = decidirParcelaDaConta(conta, codigo);
    if (decisao === 'retirada') { avisarParcelaRetirada(conta, codigo); return; }
    (conta === 'oben' ? h.setSelectedParcelaOben : h.setSelectedParcelaColacor)(codigo);
    if (decisao === 'inconferivel') setParcelasAConferir(p => ({ ...p, [conta]: codigo }));
  };
  const conferirParcelasRef = useRef({ decidirParcelaDaConta, avisarParcelaRetirada });
  conferirParcelasRef.current = { decidirParcelaDaConta, avisarParcelaRetirada };
  useEffect(() => {
    for (const conta of ['oben', 'colacor'] as const) {
      const codigo = parcelasAConferir[conta];
      if (!codigo) continue;
      const decisao = conferirParcelasRef.current.decidirParcelaDaConta(conta, codigo);
      if (decisao === 'inconferivel') continue;
      setParcelasAConferir(p => ({ ...p, [conta]: null }));
      if (decisao === 'retirada') conferirParcelasRef.current.avisarParcelaRetirada(conta, codigo);
    }
  }, [parcelasAConferir, h.sortedFormasPagamentoOben, h.sortedFormasPagamentoColacor, h.estadoFormasOben, h.estadoFormasColacor]);
  // Troca de cliente: o que estava a conferir era da seleção anterior.
  useEffect(() => { setParcelasAConferir({ oben: null, colacor: null }); }, [h.selectedCustomer?.codigo_cliente]);
  const aplicarDadosRef = useRef(aplicarDadosDoRascunho);
  aplicarDadosRef.current = aplicarDadosDoRascunho;
  const codigoClienteSelecionado = h.selectedCustomer?.codigo_cliente ?? null;
  useEffect(() => {
    const pendente = restorePendenteRef.current;
    if (!pendente) return;
    const decisao = resolverRestorePendente(pendente.codigoCliente, codigoClienteSelecionado);
    if (decisao === 'esperar') return;
    restorePendenteRef.current = null;
    if (decisao === 'aplicar') { aplicarDadosRef.current(pendente.dados, true); return; }
    toast.info('Rascunho não restaurado', {
      description: `Ele é de ${pendente.nome ?? 'outro cliente'}. Selecione esse cliente e restaure de novo.`,
    });
  }, [codigoClienteSelecionado]);

  const handleRestore = () => {
    if (!draft) return;
    const { state } = draft;
    // O carrinho do rascunho foi precificado para o cliente DELE: aplicar sobre outro cliente já
    // selecionado (deep link, IA) misturaria preço/condição de um no pedido do outro (Codex P1).
    const codigoRascunho = state.customerCodigoCliente ?? null;
    const codigoAtual = h.selectedCustomer?.codigo_cliente ?? null;
    const decisao = decidirRestore(codigoRascunho, codigoAtual);
    if (decisao === 'recusar') {
      toast.error('Rascunho de outro cliente', {
        description: `Ele é de ${state.customerName ?? 'outro cliente'}. Troque para esse cliente para restaurá-lo.`,
      });
      return;
    }
    const dados: DadosDoRascunho = {
      cart: state.cart, notes: state.notes, ordemCompra: state.ordemCompra,
      parcelas: lerParcelasDoRascunho(state.parcelasManuais),
    };
    if (codigoAtual == null && state.customerName) h.setCustomerSearch(state.customerName);
    if (decisao === 'esperarCliente' && codigoClienteIdentifica(codigoRascunho)) {
      // Sem cliente na tela: pré-busca o cliente do rascunho e ESPERA a seleção dele.
      restorePendenteRef.current = { codigoCliente: codigoRascunho, nome: state.customerName ?? null, dados };
      toast.info('Selecione o cliente para restaurar', {
        description: `O rascunho é de ${state.customerName ?? 'outro cliente'} — o carrinho volta quando ele for selecionado.`,
      });
    } else {
      aplicarDadosDoRascunho(dados, codigoClienteIdentifica(codigoRascunho));
    }
    setRestoreOpen(false);
    // Não limpa o draft — ele será reescrito naturalmente conforme o vendedor edita.
  };

  // Ciclo ÚNICO envelope × rascunho (follow-up Codex do #4042). O diálogo já pediu confirmação
  // quando havia envio pendente; descartar zera os DOIS — senão o próximo pedido idêntico sai
  // como "já enviado" e não é criado.
  const handleDiscardDraft = () => {
    restorePendenteRef.current = null;
    clearDraft();
    h.descartarEnvelope();
    dismissDraft();
    setRestoreOpen(false);
  };

  // "Trocar e limpar": o hook zera carrinho + envelope; o rascunho em disco vai junto — restaurá-lo
  // depois e reenviar criaria checkout NOVO e duplicaria o PV/OS já enviados.
  const handleClearCustomer = () => {
    if (h.clearCustomer()) clearDraft(); // barrada com envio em voo → nada é apagado
  };

  // Orçamento: o rascunho segue o desfecho NA HORA (sem esperar o debounce de 600 ms).
  const handleSubmitQuote = () => h.submitQuote({
    aoGravar: (restante) => {
      if (restante === null || restante.length === 0) clearDraft();
      else gravarRascunhoAgora({ ...draftPayload, cart: restante });
    },
  });

  // C4 (rodada 2): "Novo pedido" na tela de sucesso — recomeça do zero sem recarregar a página.
  // O diálogo só oferece com envio CONFIRMADO em todas as contas: aí o hook já zerou carrinho,
  // campos do pedido, envelope e rascunho; aqui sai o resto (cliente, buscas). Com pendência de ERP
  // não há botão — limpar perderia o reenvio que não duplica.
  const handleNovoPedido = () => {
    if (!h.ultimoEnvioConfirmado) return;
    if (!h.iniciarNovoPedido()) return; // envio em voo ou envelope vivo → nada é apagado
    restorePendenteRef.current = null; // rascunho "esperando o cliente" do pedido anterior não volta
    coresDoCliente.setBusca('');
    h.setOrderSuccessOpen(false);
    // Sem os parâmetros do pedido anterior (?customer, ?repeat, ?origem…): recarregar não pode
    // voltar a selecionar A nem replicar o pedido antigo (Codex P2). O returnTo da fila fica.
    h.navigate(returnTo ? `/sales/new?returnTo=${encodeURIComponent(returnTo)}` : '/sales/new', { replace: true });
    window.scrollTo({ top: 0 });
  };

  if (h.authLoading) {
    return <PageSkeleton variant="form" />;
  }

  /* ─── Derived flags to keep UI clean ─── */
  const showCustomerSearch = !isCustomerMode;
  const showProductTabs = !isCustomerMode;
  const showAIAssistant = !isCustomerMode;
  const customerReady = !!h.selectedCustomer;
  // C5: a MESMA entrada alimenta a barra e o "Enviar pedido agora" da reconexão (Codex P1: o banner
  // testava só `submitting` e contornava os motivos).
  const entradaMotivosEnvio: EntradaMotivosEnvio = {
    temCliente: !!h.selectedCustomer, carregandoCliente: h.loadingCustomer,
    obenProductItems: h.obenProductItems, colacorProductItems: h.colacorProductItems,
    serviceItems: h.serviceItems, vendedorDivergencias: h.vendedorDivergencias,
    estadoVendedor: h.estadoVendedor,
    estadoFormasOben: isCustomerMode ? undefined : h.estadoFormasOben,
    estadoFormasColacor: isCustomerMode ? undefined : h.estadoFormasColacor,
    loadingFormas: h.loadingFormas, exigeCondicao: !isCustomerMode,
    selectedParcelaOben: h.selectedParcelaOben, selectedParcelaColacor: h.selectedParcelaColacor,
  };
  const reconexaoBloqueada = envioBloqueado(h.submitting, motivosEnvioBloqueado(entradaMotivosEnvio));
  const servicosAOrcar = h.serviceItems.filter(i => { const p = h.getServicePrice(i); return p === null || !(p > 0); }).length;

  return (
    <div className="max-w-5xl mx-auto space-y-4 pb-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-medium tracking-tight">
            {isCustomerMode ? 'Nova Ordem de Serviço' : 'Novo Pedido'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isCustomerMode
              ? 'Solicite afiação para suas ferramentas.'
              : 'Produtos Oben, Colacor e Afiação em um único pedido.'}
          </p>
        </div>
        <OrderStepper step={h.currentStep} isCustomerMode={isCustomerMode} />
      </header>

      {/* Só staff vê o selo da venda assistida (`canSeeVendaAssistida={h.isStaff}`), então só
          staff vê o aviso — alarme para quem não vê o sintoma é ruído. */}
      {h.isStaff && naoConsegui(estadoCatalisador) && (
        <AvisoLeituraFalhou
          oque="os casamentos de catalisador — produtos com catalisador aparecem como “sob consulta” mesmo tendo preço"
          estado={estadoCatalisador}
          testId="aviso-catalisador"
        />
      )}

      {offlineSubmit.showReconnectCta && (
        <div className="rounded-md border border-status-info-bold/30 bg-status-info-bg px-4 py-3 mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-status-info-bold">
            <Wifi className="w-4 h-4 shrink-0" />
            Conexão restabelecida. Seu pedido está salvo como rascunho.
          </div>
          <Button size="sm" onClick={offlineSubmit.onReconnectSubmit} disabled={reconexaoBloqueada} className="shrink-0">
            Enviar pedido agora
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {/* Customer search — staff only */}
          {showCustomerSearch && (
            <CustomerSearch
              selectedCustomer={h.selectedCustomer} customerUserId={h.customerUserId}
              customerSearch={h.customerSearch} onSearchChange={h.setCustomerSearch}
              customers={h.customers} searchingCustomers={h.searchingCustomers}
              loadingCustomer={h.loadingCustomer} validatingVendedor={h.validatingVendedor}
              vendedorDivergencias={h.vendedorDivergencias}
              estadoVendedor={h.estadoVendedor} onRevalidarVendedor={h.revalidarVendedor}
              onSelectCustomer={h.selectCustomer} onClearCustomer={handleClearCustomer}
              searchFalhou={h.customerSearchFalhou} onTentarDeNovo={h.tentarBuscaDeNovo} itensNoCarrinho={h.cart.length}
            />
          )}

          {/* Alerta de crédito (Fase 1 — informativo, não bloqueia) + situação na Receita (só alerta) + tier comercial */}
          {showCustomerSearch && h.selectedCustomer && (
            <div className="space-y-2">
              <AlertaCreditoCliente cliente={h.selectedCustomer} />
              {/* Só aviso (migration 20261106205557): possível vínculo com cliente que tem título vencido. */}
              <AvisoVinculoCredito documento={h.selectedCustomer.cnpj_cpf} superficie="pedido" />
              {!h.loadingCustomer && <SeloSituacaoReceita customerUserId={h.customerUserId} superficie="pedido" />}
              <TierClienteBadge
                customerUserId={h.customerUserId}
                customerName={h.selectedCustomer.nome_fantasia || h.selectedCustomer.razao_social}
              />
            </div>
          )}

          {/* Assistente IA — staff. Vem DEPOIS do Cliente: o passo 1 do stepper é Cliente e a busca
              é o caminho mais comum; a IA segue identificando cliente+itens de uma vez. */}
          {showAIAssistant && (
            <UnifiedAIAssistant
              products={catalogoIA}
              userTools={h.userTools}
              onItemsIdentified={h.handleUnifiedAIResult}
              onCustomerIdentified={h.handleAICustomerSelect}
              customerUserId={h.customerUserId}
              hasCustomerSelected={!!h.selectedCustomer}
              isLoading={h.submitting}
              precoNascimentoPorId={h.precoNascimentoPorId}
              // A5 (rodada 2): com envio em voo o "Adicionar" da sugestão desabilita (o hook também barra).
              precoLoading={h.precoPartidaLoading || h.submitting}
            />
          )}

          {/* Cores já pedidas pelo cliente — busca + re-pedido (staff) */}
          {showCustomerSearch && customerReady && (
            <CoresDoClienteCard
              cores={coresDoCliente.cores}
              coresFiltradas={coresDoCliente.coresFiltradas}
              busca={coresDoCliente.busca}
              onBuscaChange={coresDoCliente.setBusca}
              isLoading={coresDoCliente.isLoading}
              onRepetirCor={handleRepetirCor}
              umToque={umToque}
              onAdicionarUmToque={handleAdicionarUmToque}
            />
          )}

          {/* Fase 2A: entrada pela COR (a base sai da embalagem escolhida) — staff */}
          {showCustomerSearch && customerReady && (
            <Button variant="outline" className="w-full justify-start gap-2" onClick={() => setCorPrimeiroAberto(true)}>
              <Palette className="w-4 h-4" /> Pedir por cor
              <span className="text-xs text-muted-foreground font-normal">cor → produto → embalagem</span>
            </Button>
          )}

          {/* Item selection — adapted by role */}
          {customerReady && (
            <>
              {showProductTabs ? (
                /* Staff: full tabs with Oben, Colacor, Afiação */
                <Tabs value={h.activeTab} onValueChange={h.setActiveTab} className="space-y-3">
                  <TabsList className="w-full grid grid-cols-3">
                    <TabsTrigger value="oben" className="gap-1">
                      <Building2 className="w-3.5 h-3.5" /> Oben
                      {h.obenProductItems.length > 0 && <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1">{h.obenProductItems.length}</Badge>}
                    </TabsTrigger>
                    <TabsTrigger value="colacor" className="gap-1">
                      <Building2 className="w-3.5 h-3.5" /> Colacor
                      {h.colacorProductItems.length > 0 && <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1">{h.colacorProductItems.length}</Badge>}
                    </TabsTrigger>
                    <TabsTrigger value="services" className="gap-1">
                      <Scissors className="w-3.5 h-3.5" /> Afiação
                      {h.serviceItems.length > 0 && <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1">{h.serviceItems.length}</Badge>}
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value="oben">
                    <ProductItemForm title="Produtos Oben" products={h.filteredObenProducts} prices={h.customerPricesOben}
                      loading={h.estadoCatalogoOben === 'carregando'} productSearch={h.productSearch} onSearchChange={h.setProductSearch}
                      productItems={h.productItems} onAddProduct={h.addProductToCart}
                      customerPurchaseHistory={h.customerPurchaseHistory} customerPricesLoading={h.loadingCustomer}
                      specsByKey={fichasByKey} canSeeFicha={h.isStaff}
                      selosByKey={selosByKey} canSeeVendaAssistida={h.isStaff} customerUserId={h.customerUserId}
                      getPrecoNascimento={h.getProductPrice} precoLoading={h.precoPartidaLoading}
                      catalogoFalhou={h.estadoCatalogoOben === 'falhou'} onTentarDeNovo={() => { void h.tentarCatalogoDeNovo('oben'); }} />
                  </TabsContent>
                  <TabsContent value="colacor">
                    <ProductItemForm title="Produtos Colacor" products={h.filteredColacorProducts} prices={h.customerPricesColacor}
                      loading={h.estadoCatalogoColacor === 'carregando'} productSearch={h.productSearch} onSearchChange={h.setProductSearch}
                      productItems={h.productItems} onAddProduct={h.addProductToCart}
                      customerPurchaseHistory={h.customerPurchaseHistory} customerPricesLoading={h.loadingCustomer}
                      specsByKey={fichasByKey} canSeeFicha={h.isStaff}
                      selosByKey={selosByKey} canSeeVendaAssistida={h.isStaff} customerUserId={h.customerUserId}
                      getPrecoNascimento={h.getProductPrice} precoLoading={h.precoPartidaLoading}
                      catalogoFalhou={h.estadoCatalogoColacor === 'falhou'} onTentarDeNovo={() => { void h.tentarCatalogoDeNovo('colacor'); }} />
                  </TabsContent>
                  <TabsContent value="services">
                    <ServiceItemForm
                      customerUserId={h.customerUserId} loadingTools={h.loadingTools} loadingServicos={h.loadingServicos}
                      creatingLocalProfile={h.creatingLocalProfile} serviceItems={h.serviceItems} availableTools={h.availableTools}
                      userTools={h.userTools} cart={h.cart} submitting={h.submitting}
                      deliveryOption={h.deliveryOption} setDeliveryOption={h.setDeliveryOption}
                      addresses={h.addresses} selectedAddress={h.selectedAddress} setSelectedAddress={h.setSelectedAddress}
                      selectedTimeSlot={h.selectedTimeSlot} setSelectedTimeSlot={h.setSelectedTimeSlot}
                      showAddressOptions={h.showAddressOptions} setShowAddressOptions={h.setShowAddressOptions}
                      afiacaoPaymentMethod={h.afiacaoPaymentMethod} setAfiacaoPaymentMethod={h.setAfiacaoPaymentMethod}
                      onStaffAddTool={h.handleStaffAddTool} onAddService={h.addServiceToCart}
                      onRemoveFromCart={h.removeFromCart} onUpdateQuantity={h.updateQuantity}
                      onUpdateServiceServico={h.updateServiceServico} onUpdateServiceNotes={h.updateServiceNotes}
                      onUpdateServicePhotos={h.updateServicePhotos} onVoiceItemsIdentified={h.handleVoiceItemsIdentified}
                      getFilteredServicos={h.getFilteredServicos} getServicePrice={h.getServicePrice}
                      setAddToolDialogOpen={h.setAddToolDialogOpen}
                    />
                  </TabsContent>
                </Tabs>
              ) : (
                /* Customer: services only, no tabs */
                <ServiceItemForm
                  customerUserId={h.customerUserId} loadingTools={h.loadingTools} loadingServicos={h.loadingServicos}
                  creatingLocalProfile={h.creatingLocalProfile} serviceItems={h.serviceItems} availableTools={h.availableTools}
                  userTools={h.userTools} cart={h.cart} submitting={h.submitting}
                  deliveryOption={h.deliveryOption} setDeliveryOption={h.setDeliveryOption}
                  addresses={h.addresses} selectedAddress={h.selectedAddress} setSelectedAddress={h.setSelectedAddress}
                  selectedTimeSlot={h.selectedTimeSlot} setSelectedTimeSlot={h.setSelectedTimeSlot}
                  showAddressOptions={h.showAddressOptions} setShowAddressOptions={h.setShowAddressOptions}
                  afiacaoPaymentMethod={h.afiacaoPaymentMethod} setAfiacaoPaymentMethod={h.setAfiacaoPaymentMethod}
                  onStaffAddTool={h.handleStaffAddTool} onAddService={h.addServiceToCart}
                  onRemoveFromCart={h.removeFromCart} onUpdateQuantity={h.updateQuantity}
                  onUpdateServiceServico={h.updateServiceServico} onUpdateServiceNotes={h.updateServiceNotes}
                  onUpdateServicePhotos={h.updateServicePhotos} onVoiceItemsIdentified={h.handleVoiceItemsIdentified}
                  getFilteredServicos={h.getFilteredServicos} getServicePrice={h.getServicePrice}
                  setAddToolDialogOpen={h.setAddToolDialogOpen}
                />
              )}
            </>
          )}
        </div>

        <div className="space-y-4">
          {/* Cross-sell — staff only */}
          {!isCustomerMode && h.customerUserId && h.productItems.length > 0 && (
            <RecommendationsPanel customerId={h.customerUserId} basketProductIds={h.cartProductIds}
              onAddToCart={h.handleAddRecommendation} title="Combine com" compact maxItems={5} />
          )}

          <CartItemList
            cart={h.cart} obenProductItems={h.obenProductItems} colacorProductItems={h.colacorProductItems}
            serviceItems={h.serviceItems} obenSubtotal={h.obenSubtotal} colacorProdSubtotal={h.colacorProdSubtotal}
            serviceSubtotal={h.serviceSubtotalExibicao} totalEstimated={h.totalEstimated}
            deliveryOption={h.deliveryOption} selectedTimeSlot={h.selectedTimeSlot}
            onUpdateQuantity={h.updateQuantity} onUpdateProductPrice={h.updateProductPrice}
            onUpdateTintDiscount={h.updateTintDiscount} onAplicarDescontoCores={h.aplicarDescontoCores}
            onRemoveFromCart={h.removeFromCart} getServicePrice={h.getServicePrice}
            getCartIndex={(item) => h.cart.indexOf(item)}
            customerUserId={h.customerUserId}
            customerName={h.selectedCustomer?.razao_social ?? null}
            condicaoPrazoOben={h.selectedParcelaOben}
          />

          {/* estadoFormas + onRecarregarFormas: customer mode não escolhe condição de
              pagamento (a query nem roda — enabled=isStaff), então espelham o mesmo corte
              das formas ordenadas abaixo; `undefined` cai no default "sem degradação". */}
          {h.cart.length > 0 && h.selectedCustomer && (
            <CartSummaryBar
              cart={h.cart} obenProductItems={h.obenProductItems} colacorProductItems={h.colacorProductItems}
              serviceItems={h.serviceItems}
              sortedFormasPagamentoOben={isCustomerMode ? [] : h.sortedFormasPagamentoOben}
              sortedFormasPagamentoColacor={isCustomerMode ? [] : h.sortedFormasPagamentoColacor}
              selectedParcelaOben={h.selectedParcelaOben} setSelectedParcelaOben={h.setSelectedParcelaOben}
              selectedParcelaColacor={h.selectedParcelaColacor} setSelectedParcelaColacor={h.setSelectedParcelaColacor}
              loadingFormas={h.loadingFormas} customerParcelaRankingOben={h.customerParcelaRankingOben}
              customerParcelaRankingColacor={h.customerParcelaRankingColacor}
              avisoPrazo={isCustomerMode ? undefined : { cliente: h.selectedCustomer, onEstado: h.registrarEstadoPrazo }}
              estadoFormasOben={isCustomerMode ? undefined : h.estadoFormasOben}
              estadoFormasColacor={isCustomerMode ? undefined : h.estadoFormasColacor}
              onRecarregarFormas={isCustomerMode ? undefined : h.recarregarFormas}
              notes={h.notes} setNotes={h.setNotes}
               volumesOben={h.volumesOben}
               volumesColacor={h.volumesColacor}
              ordemCompra={h.ordemCompra} setOrdemCompra={h.setOrdemCompra}
              isOrdemCompraCustomer={h.isOrdemCompraCustomer}
              readyByDate={h.readyByDate} setReadyByDate={h.setReadyByDate}
              onSubmitQuote={handleSubmitQuote}
            />
          )}
        </div>
      </div>

      {/* C1/C2/C5 (rodada 2): total + Enviar presos ao fim da tela (filho direto da página — ver o
          componente). Aparece assim que há cliente OU carrinho, com o motivo quando está cinza. */}
      {(h.selectedCustomer || h.cart.length > 0) && (
        <BarraEnvioPedido
          {...entradaMotivosEnvio}
          submitting={h.submitting} totalEstimated={h.totalEstimated} servicosAOrcar={servicosAOrcar}
          onSubmit={offlineSubmit.onSubmit}
          onSubmitQuote={handleSubmitQuote}
          offline={offlineSubmit.offline}
        />
      )}

      {h.customerUserId && (
        <AddToolDialog open={h.addToolDialogOpen} onOpenChange={h.setAddToolDialogOpen}
          categories={h.toolCategories} targetUserId={h.customerUserId}
          onToolAdded={() => h.loadUserTools(h.customerUserId!)} />
      )}

      {h.lastOrderData && (
        <OrderSuccessDialog
          open={h.orderSuccessOpen}
          onOpenChange={h.setOrderSuccessOpen}
          customerName={h.lastOrderData.customerName}
          items={h.lastOrderData.items}
          total={h.lastOrderData.total}
          itensAOrcar={h.lastOrderData.itensAOrcar}
          orderNumbers={h.lastOrderData.orderNumbers}
          printDataList={h.lastOrderData.printDataList}
          envioConfirmado={h.ultimoEnvioConfirmado}
          onViewOrder={() => {
            h.setOrderSuccessOpen(false);
            h.navigate('/sales');
          }}
          onShare={() => {
            shareOrderViaWhatsApp({
              customerName: h.lastOrderData!.customerName,
              items: h.lastOrderData!.items,
              total: h.lastOrderData!.total,
              itensAOrcar: h.lastOrderData!.itensAOrcar,
              orderNumbers: h.lastOrderData!.orderNumbers,
            });
          }}
          returnTo={returnTo}
          onNovoPedido={handleNovoPedido}
          onVoltarFila={() => { h.setOrderSuccessOpen(false); if (returnTo) h.navigate(returnTo); }}
          bloqueiosCredito={h.bloqueiosCredito}
          onResolverBloqueio={(b) => { h.setOrderSuccessOpen(false); setExcecaoBloqueio(b); }}
        />
      )}

      {/* ATP fase 2: recusa de estoque do Oben → decisão explícita (backorder/voltar).
          Abre NO LUGAR do dialog de sucesso; ao fechar, o resumo do envio abre. */}
      <AtpBackorderDialog
        bloqueio={h.bloqueioAtp}
        descricaoPorSku={h.bloqueioAtp ? new Map(h.obenProductItems.map(c => [c.product.omie_codigo_produto, c.product.descricao])) : SEM_DESCRICOES}
        enviando={h.submitting}
        onAutorizar={(motivo) => { void h.autorizarBackorderAtp(motivo); }}
        onTentarNovamente={() => { void h.tentarNovamenteAtp(); }}
        onFechar={h.fecharBloqueioAtp}
      />

      {excecaoBloqueio && (
        <ExcecaoCreditoDialog
          open={!!excecaoBloqueio}
          onOpenChange={(o) => { if (!o) setExcecaoBloqueio(null); }}
          salesOrderId={excecaoBloqueio.salesOrderId}
          bloqueio={excecaoBloqueio}
          // Exceção criada: fecha e deixa o vendedor no wizard — o carrinho/checkout foram
          // preservados (allConfirmed=false), então o botão Enviar reusa o MESMO pedido.
          onExcecaoCriada={() => setExcecaoBloqueio(null)}
        />
      )}

      {draft && (
        <RestoreDraftDialog
          open={restoreOpen}
          savedAt={draft.savedAt}
          customerName={draft.state.customerName ?? undefined}
          itemCount={Array.isArray(draft.state.cart) ? draft.state.cart.length : 0}
          onRestore={handleRestore}
          onDiscard={handleDiscardDraft}
          envioPendente={decidirDescarteRascunho(h.envelopeCheckoutAtual()) === 'confirmar'}
        />
      )}

      <CorPrimeiroDialog
        open={corPrimeiroAberto}
        onClose={() => setCorPrimeiroAberto(false)}
        onConfirm={(formulaId, corId, nomeCor, precoFinal, custoCorantes, pricingMeta, product) => {
          // A base é a da embalagem escolhida — nunca há produto pendente nesta entrada.
          // Defesa em profundidade (Codex P1): só base tintométrica da Oben entra por aqui (o
          // diálogo já barra com `ehBaseTintometricaOben`; repetido inline para não criar aresta).
          if (!product || product.account !== 'oben' || !product.is_tintometric || product.tint_type !== 'base') return;
          // Conflito → o diálogo fica aberto com a escolha (Codex P1 rodada 3).
          const resultado = h.addTintProductToCart(product, formulaId, corId, nomeCor, precoFinal, custoCorantes, pricingMeta, 1);
          if (resultado !== 'adicionado') return resultado;
          setCorPrimeiroAberto(false);
          toast.success(`${corId} adicionada`, { description: product.descricao });
          return resultado;
        }}
      />

      {h.tintPendingProduct && (
        <TintColorSelectDialog
          product={h.tintPendingProduct}
          open={!!h.tintPendingProduct}
          onClose={() => { h.setTintPendingProduct(null); setTintInitialSearch(null); }}
          customerUserId={h.customerUserId}
          initialSearch={tintInitialSearch}
          onConfirm={(formulaId, corId, nomeCor, precoFinal, custoCorantes, pricingMeta, alternativeProduct) => {
            // Conflito → pendência intacta: o diálogo segue aberto e a fila de "Repetir pedido" não avança.
            const resultado = h.addTintProductToCart(alternativeProduct || h.tintPendingProduct!, formulaId, corId, nomeCor, precoFinal, custoCorantes, pricingMeta);
            if (resultado !== 'adicionado') return resultado;
            setTintInitialSearch(null);
            return resultado;
          }}
        />
      )}
    </div>
  );
};

export default UnifiedOrder;
