// Lógica da tela de edição de pedido de venda (load, edição de itens, save no Omie).
// Extraída verbatim de src/pages/SalesOrderEdit.tsx (god-component split).
import { useState, useEffect, useMemo, useReducer, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { itensPedidoDoJson, omiePayloadDoJson } from '@/lib/pedido/itens-json';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { track } from '@/lib/analytics';
import type { Product } from '@/hooks/useUnifiedOrder';
import { paginateAll } from '@/hooks/unifiedOrder/catalog-helpers';
import { buildExclusionQuery } from '@/hooks/unifiedOrder/types';
import {
  bloqueioDaEdicao,
  contaDaEdicao,
  type OrderItem,
  type SalesOrder,
  type FormasPagamentoResponse,
  type OmieProduct,
} from './types';
import {
  invalidPricedOrderItemIndices, invalidOrderPriceMessage, invalidQuantityOrderItemIndices, subtotalDaEdicao,
} from './priceGuard';
import { totalLinhaOuAusente } from '@/lib/format';
import { mesmosItens, valoresDaEdicaoLocal } from './edicaoLocal';
import {
  comPrazo, invalidarCachesDoPedido, lerFalhaDoEnvio, PRAZOS, TRAVA_CONCORRENTE, TRAVA_DIVERGENTE,
  type TravaDoEnvio,
} from './envioEdicao';
import { encerrarEnvio, estadoDoPedido, iniciarEnvio, marcarDivergente, ouvirRegistro } from './registroEnvios';
import { precoDeNascimento, type InsumosDoNascimento } from '@/lib/pricing/precoDeNascimento';
import { carregarPrecosPraticados } from '@/hooks/unifiedOrder/precos-praticados';
import { buscarMultConfig, buscarTierPorConta } from '@/hooks/useClienteTier';

/** Recusas que a edge `alterar_pedido` dá ANTES de tocar o Omie: o desfecho é conhecido (nada mudou). Qualquer
 *  outro `blocked` (ou nenhum, sem `success: true`) é desfecho desconhecido. */
const RECUSAS_ANTES_DO_OMIE = [
  'credito', 'tint_preco', 'atp', 'desconto_omie', 'edicao_concorrente', 'versao_ausente',
  'gemeo_omie', 'etapa_omie', 'leitura_omie_incompleta', 'cliente_omie', 'origem_omie', 'status_pedido',
  'conta_desconhecida', 'pedido_excluido',
];

/** `blocked` da edge `alterar_pedido` que trazem `motivo` legível (edge v1.48, ./edicao-omie.ts). */
const BLOQUEIOS_COM_MOTIVO = [
  'gemeo_omie', 'etapa_omie', 'leitura_omie_incompleta', 'cliente_omie',
  'origem_omie', 'status_pedido', 'conta_desconhecida', 'pedido_excluido', 'versao_ausente',
];
import {
  lerRespostaFormas,
  condicoesDoClienteIndisponiveis,
  mensagemCondicoesIndisponiveis,
} from '@/services/orderSubmission/formasDegradacao';

export function useSalesOrderEdit() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  useAuth(); // mantém o hook montado pra refresh de token; isStaff não é usado

  const [order, setOrder] = useState<SalesOrder | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [items, setItems] = useState<OrderItem[]>([]);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formas, setFormas] = useState<Array<{ codigo: string; descricao: string }>>([]);
  const [selectedParcela, setSelectedParcela] = useState('');
  // Degradação da listagem (edge #1597) + a condição ORIGINAL do pedido. Guardar o original
  // é o que permite provar, sob degradação, que a lista exibida não contém a condição deste
  // pedido — e barrar a TROCA por uma genérica (money-path §7: a degradação tem de chegar
  // à tela; §2: ausente ≠ zero, aqui "lista genérica" ≠ "condições do cliente").
  const [formasDegradadas, setFormasDegradadas] = useState(false);
  const [formasErro, setFormasErro] = useState(false);
  const [formasMotivo, setFormasMotivo] = useState<string | null>(null);
  const [parcelaOriginal, setParcelaOriginal] = useState('');
  // #30: o salvar falhou DEPOIS de mexer no Omie (ou outra edição ganhou a vez). O formulário na tela
  // é um retrato velho — reenviá-lo regravaria itens que o Omie já não tem. Só recarregar destrava.
  const [precisaRecarregar, setPrecisaRecarregar] = useState<TravaDoEnvio | null>(null);
  // A página remonta a cada `:id` (SalesOrderEdit.tsx): a instância é de UM pedido. Depois de um `await`,
  // se ela desmontou (o vendedor abriu outro pedido), o salvar não publica toast, navegação nem estado — só
  // o que é do PEDIDO (registroEnvios: em voo / divergente) e a invalidação do cache.
  const montadoRef = useRef(true);
  useEffect(() => {
    montadoRef.current = true;
    return () => {
      montadoRef.current = false;
      // Leituras de preço em voo desta instância não publicam aviso na tela do próximo pedido.
      cargaPrecoRef.current++;
    };
  }, []);
  const [, reler] = useReducer((x: number) => x + 1, 0);
  useEffect(() => ouvirRegistro(reler), []);
  // #48: trava síncrona do envio — o `saving` do React só chega no próximo render, um 2º clique ou
  // uma edição no mesmo tick ainda passariam.
  const envioEmVooRef = useRef(false);
  const queryClient = useQueryClient();
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [productSearch, setProductSearch] = useState('');
  const [catalogProducts, setCatalogProducts] = useState<OmieProduct[]>([]);
  // Tint color dialog
  const [tintPendingProduct, setTintPendingProduct] = useState<OmieProduct | null>(null);
  const [customerUserId, setCustomerUserId] = useState<string | null>(null);
  // Insumos do preço de NASCIMENTO do produto adicionado — os mesmos do Novo Pedido (último praticado
  // do cliente, tier × multiplicador). `null` = ainda carregando: "Adicionar" espera, como no wizard,
  // para o item não nascer pela tabela por uma corrida.
  const [insumosPreco, setInsumosPreco] = useState<InsumosDoNascimento | null>(null);
  // Token da carga: a resposta tardia do pedido ANTERIOR (mesma instância da rota) não pode
  // sobrescrever os insumos do pedido aberto agora — o item de B nasceria com o preço de A.
  const cargaPrecoRef = useRef(0);

  useEffect(() => {
    if (id) loadOrder();
  }, [id]);

  const loadOrder = async () => {
    if (!id) return;
    // Geração da carga nasce ANTES do 1º await: uma resposta tardia de qualquer leitura do pedido
    // anterior (sales_orders, payload, profiles, preços) não publica sobre o pedido aberto agora
    // (Codex r3: atrasar só `profiles` de A fazia A pegar o token depois de B).
    const minhaCarga = ++cargaPrecoRef.current;
    const velha = () => cargaPrecoRef.current !== minhaCarga;
    // #15: o editor é o MESMO componente quando a rota troca de :id — sem zerar, o pedido B abria com a
    // parcela, as formas, o catálogo e o rascunho do pedido A até as leituras de B chegarem (e, se B
    // não tem parcela, ficava com a de A para sempre).
    setLoading(true);
    setOrder(null);
    setItems([]);
    setNotes('');
    setCustomerName('');
    setCustomerUserId(null);
    setSelectedParcela('');
    setParcelaOriginal('');
    setFormas([]);
    setFormasDegradadas(false);
    setFormasErro(false);
    setFormasMotivo(null);
    setCatalogProducts([]);
    setTintPendingProduct(null);
    setShowAddProduct(false);
    setProductSearch('');
    setPrecisaRecarregar(null);
    setInsumosPreco(null);
    // Envio deste pedido ainda voando (outra tela, mesma aba): ler agora daria o carrinho de ANTES do envio.
    // A tela fica carregando; o efeito de `envioDeOutraTela` chama loadOrder de novo quando ele termina.
    if (estadoDoPedido(id).emVoo) return;
    try {
      const { data, error } = await supabase
        .from('sales_orders')
        .select('id, customer_user_id, created_by, items, subtotal, total, status, notes, account, omie_pedido_id, omie_numero_pedido, created_at, updated_at, hash_payload')
        .eq('id', id)
        .single();
      if (error) throw error;
      if (velha()) return;
      const row = data;
      // omie_payload não é mais legível por .select() (fechado ao customer no PR0.0-bis); o staff
      // o recupera pelo canal SECDEF. Indispensável ANTES de montar o pedido: handleSave faz merge
      // {...order.omie_payload, cabecalho:{codigo_parcela}} — sem o payload atual, salvar APAGARIA
      // o resto do payload. Falha do canal ⇒ fail-closed (o pedido não carrega).
      const { data: pl, error: plErr } = await supabase.rpc('staff_get_sales_order_payload', { p_order_ids: [id] });
      if (plErr) throw plErr;
      if (velha()) return;
      const payload = omiePayloadDoJson(pl?.[0]?.omie_payload ?? null, `sales_orders ${row.id}`);
      const o: SalesOrder = {
        id: row.id,
        customer_user_id: row.customer_user_id,
        items: itensPedidoDoJson(row.items, `sales_orders ${row.id}`),
        subtotal: row.subtotal,
        total: row.total,
        status: row.status,
        notes: row.notes,
        account: row.account,
        omie_pedido_id: row.omie_pedido_id,
        omie_numero_pedido: row.omie_numero_pedido,
        omie_payload: payload,
        origem_omie: typeof row.hash_payload === 'string' && row.hash_payload.startsWith('omie_'),
        created_at: row.created_at,
        updated_at: row.updated_at ?? null,
      };
      setOrder(o);
      setItems(o.items || []);
      setNotes(o.notes || '');
      const parcela = o.omie_payload?.cabecalho?.codigo_parcela;
      if (parcela) { setSelectedParcela(parcela); setParcelaOriginal(parcela); }

      const { data: profile } = await supabase
        .from('profiles')
        .select('name')
        .eq('user_id', o.customer_user_id)
        .single();
      if (velha()) return;
      if (profile) setCustomerName(profile.name || '');
      setCustomerUserId(o.customer_user_id);
      carregarInsumosPreco(o.customer_user_id, row.created_by ?? null, minhaCarga).catch((e) => {
        // Rede de segurança: nunca deixa "Adicionar" preso em "carregando" — degrada para a tabela pura.
        console.error('[edição] insumos de preço do cliente (falha inesperada)', e);
        if (cargaPrecoRef.current === minhaCarga) {
          setInsumosPreco({ precos: { oben: {}, colacor: {} }, datas: { oben: {}, colacor: {} }, tierPorConta: null, multConfig: null });
        }
      });

      // #4: conta fora de oben|colacor não vira Oben — sem conta provada não há catálogo nem condição
      // certos para oferecer (a edge recusa igual: `conta_desconhecida`). A tela abre travada.
      const account = contaDaEdicao(o.account);
      if (!account) return;

      // Load formas + products in parallel.
      const [formasRes, products] = await Promise.all([
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'listar_formas_pagamento', account },
        }),
        // Catálogo vendável PAGINADO (.range): o PostgREST capa em 1000 linhas/request
        // e a busca "Adicionar produto" é client-side sobre `catalogProducts` — um único
        // .limit(1000) deixaria ~1140 produtos colacor (2140 ativos) invisíveis pra venda.
        // `account` já é a conta NORMALIZADA ('colacor'|'oben'), a MESMA que
        // omie_products.account armazena (analytics-sync grava 'colacor'/'oben'; NÃO
        // re-mapear p/ 'colacor_vendas' — não existe nesta coluna → 0 vendáveis). Espelha
        // o catálogo de criação (useProductCatalog: paginateAll + buildExclusionQuery).
        paginateAll(async (from, to) => {
          const base = supabase.from('omie_products')
            .select('id, omie_codigo_produto, codigo, descricao, unidade, valor_unitario, estoque, ativo, account, is_tintometric, tint_type')
            .eq('account', account)
            .eq('ativo', true);
          const { data, error } = await buildExclusionQuery(base)
            .order('descricao')
            .order('id')
            .range(from, to);
          if (error) throw error;
          // data null SEM error = malformada, não página vazia: devolvê-la ao paginateAll
          // encerraria o catálogo de edição PARCIAL em silêncio (classe #1338→#1564).
          if (data == null) throw new Error('omie_products (edição): data null sem error — malformada, não é fim');
          return data;
        }),
      ]);
      if (velha()) return; // catálogo/formas da conta do pedido anterior não publicam

      // ── Duas metades do mesmo site, de PRs diferentes (money-path §9). Elas não são
      // alternativas: tratam falhas DIFERENTES, e resolver por um lado reverteria a outra.
      //
      // (a) #1605 — TRANSPORTE falhou. `functions.invoke` NÃO lança: devolve
      // `{ data: null, error }`. Sem esta linha a falha escapava do `catch` abaixo,
      // `setFormas` nunca era chamado e o editor abria com a lista VAZIA — indistinguível
      // de "esta conta não tem forma cadastrada". Lançar leva ao toast "Erro ao carregar
      // pedido", que é a verdade.
      // ⚠️ Mas o `setOrder` acima já rodou: o throw NÃO impede a tela de abrir, só pula o
      // resto do load. O toast some em segundos e o que fica é uma tela sem card de
      // pagamento — a mesma omissão, agora silenciosa. Por isso o estado de erro é gravado
      // ANTES de lançar: o aviso persiste na tela depois que o toast passa (§7).
      if (formasRes.error) {
        setFormasErro(true);
        setFormasMotivo(formasRes.error.message ?? null);
        throw formasRes.error;
      }
      // (b) este PR — transporte OK, o OMIE é que degradou. O edge #1597 responde 200 com 8
      // condições genéricas hardcoded e declara `degraded`/`source`/`motivo`. Ler só
      // `formas` devolveria uma lista indistinguível da real; aqui a tela ABRE e avisa.
      const estadoFormas = lerRespostaFormas(formasRes.data as FormasPagamentoResponse | null);
      if (estadoFormas.formas.length > 0) setFormas(estadoFormas.formas);
      setFormasDegradadas(estadoFormas.degradado);
      // Sem erro de transporte e sem degradação declarada, lista vazia é ambígua (edge
      // antiga com 200 vazio) — avisa em vez de sumir o card e sugerir "não tem condição".
      setFormasErro(!estadoFormas.degradado && estadoFormas.formas.length === 0);
      setFormasMotivo(estadoFormas.motivo);
      setCatalogProducts(products);
    } catch (e) {
      if (velha()) return; // a falha do pedido anterior não é notícia sobre o aberto agora
      console.error(e);
      toast.error('Erro ao carregar pedido');
    } finally {
      // Só a carga ATUAL encerra o carregamento: a anterior terminando antes deixaria a tela de B
      // "pronta" sem o pedido B.
      if (!velha()) setLoading(false);
    }
  };

  const carregarInsumosPreco = async (cliente: string | null, criador: string | null, carga: number) => {
    const vazio: InsumosDoNascimento = {
      precos: { oben: {}, colacor: {} }, datas: { oben: {}, colacor: {} }, tierPorConta: null, multConfig: null,
    };
    // Legado: orçamento que nasceu sem cliente grava `customer_user_id = user.id` (submitQuote). Ler o
    // histórico/tier dessa identidade daria o preço do VENDEDOR — sem cliente provado, tabela pura.
    if (!cliente || (criador !== null && cliente === criador)) {
      setInsumosPreco(vazio); // síncrono: ainda é a carga atual
      return;
    }
    const [precos, tier, mult] = await Promise.allSettled([
      carregarPrecosPraticados(cliente), buscarTierPorConta(cliente), buscarMultConfig(),
    ]);
    if (cargaPrecoRef.current !== carga) return; // outro pedido foi aberto: esta resposta é velha
    if (precos.status === 'rejected' || tier.status === 'rejected' || mult.status === 'rejected') {
      console.error('[edição] insumos de preço do cliente', { precos: precos.status, tier: tier.status, mult: mult.status });
      toast.warning('Preço do cliente não carregou por completo', {
        description: precos.status === 'rejected'
          ? 'Produto adicionado agora não considera o último preço praticado com este cliente. Confira o preço antes de salvar.'
          : 'Produto adicionado agora não considera o tier do cliente. Confira o preço antes de salvar.',
      });
    }
    setInsumosPreco({
      precos: precos.status === 'fulfilled' ? { oben: precos.value.oben, colacor: precos.value.colacor } : vazio.precos,
      datas: precos.status === 'fulfilled' ? { oben: precos.value.datasOben, colacor: precos.value.datasColacor } : vazio.datas,
      tierPorConta: tier.status === 'fulfilled' ? tier.value : null,
      multConfig: mult.status === 'fulfilled' ? mult.value : null,
    });
  };

  const updateItem = (index: number, field: 'quantidade' | 'valor_unitario', value: number | null) => {
    if (envioEmVooRef.current) return; // #48: o que mudar agora não iria na requisição em voo
    setItems(prev => prev.map((item, i) => {
      if (i !== index) return item;
      // Quantidade não aceita null no shape: ilegível vira NaN, que o guard de quantidade recusa.
      const updated: OrderItem = field === 'quantidade'
        ? { ...item, quantidade: value ?? Number.NaN }
        : { ...item, valor_unitario: value };
      // Fase 3: editar o PREÇO de um item tint na mão invalida a prova da fonte
      // do picker — o item vira fonte 'manual' EXPLÍCITA (não "sem metadados",
      // que é reservado ao legado pré-Fase-3). O gate valida 'manual' pelo piso
      // min(calc, tabela): subir é livre; baixar além do piso atual bloqueia.
      if (field === 'valor_unitario' && item.tint_cor_id) {
        updated.tint_price_source = 'manual';
        delete updated.tint_discount_pct;
        delete updated.tint_preco_sem_desconto;
      }
      // `qtd * null` e 0 em JavaScript: a linha exibiria "R$ 0,00" para um item cujo preco
      // ninguem apurou. Sem preco nao ha total — o campo mostra "-" e o guard barra o salvar.
      updated.valor_total = totalLinhaOuAusente(updated.quantidade, updated.valor_unitario);
      return updated;
    }));
  };

  const removeItem = (index: number) => {
    if (envioEmVooRef.current) return;
    if (items.length <= 1) {
      toast.error('O pedido precisa ter pelo menos 1 item');
      return;
    }
    setItems(prev => prev.filter((_, i) => i !== index));
  };

  /** O preço que o clique em "Adicionar" vai aplicar — a busca mostra ESTE, não a tabela (Codex r3).
   *  `null` = ainda carregando ou sem preço sabido. Base tintométrica: o preço sai do diálogo de cor. */
  const precoPrevisto = (product: OmieProduct): number | null => {
    if (product.is_tintometric && product.tint_type === 'base') return null; // sai do diálogo de cor
    if (!insumosPreco) return null;
    return precoDeNascimento(product, insumosPreco, new Date());
  };

  const addProduct = (product: OmieProduct) => {
    if (envioEmVooRef.current) return;
    // If tintometric base, open color dialog
    if (product.is_tintometric && product.tint_type === 'base') {
      setTintPendingProduct(product);
      setShowAddProduct(false);
      setProductSearch('');
      return;
    }
    const exists = items.some(i => i.omie_codigo_produto === product.omie_codigo_produto && !i.tint_cor_id);
    if (exists) {
      toast.error('Este produto já está no pedido');
      return;
    }
    if (!insumosPreco) {
      toast.info('Carregando o preço do cliente — tente adicionar de novo em instantes.');
      return;
    }
    // Mesma decisão do Novo Pedido: último praticado ≤180d > tabela × mult(tier) > tabela.
    // `null` = sem preço sabido (o guard do salvar barra) — nunca R$ 0,00.
    const preco = precoDeNascimento(product, insumosPreco, new Date());
    const newItem: OrderItem = {
      product_id: product.id,
      omie_codigo_produto: product.omie_codigo_produto,
      codigo: product.codigo,
      descricao: product.descricao,
      unidade: product.unidade || 'UN',
      quantidade: 1,
      valor_unitario: preco,
      valor_total: totalLinhaOuAusente(1, preco),
    };
    setItems(prev => [...prev, newItem]);
    setShowAddProduct(false);
    setProductSearch('');
    toast.success(`"${product.descricao}" adicionado`);
  };

  const handleTintConfirm = (
    formulaId: string,
    corId: string,
    nomeCor: string,
    precoFinal: number,
    _custoCorantes: number,
    pricingMeta?: { source: string | null; discountPct: number; precoSemDesconto: number | null },
    alternativeProduct?: Product,
  ) => {
    if (envioEmVooRef.current || !tintPendingProduct) return 'conflito' as const;
    // #10: a cor/fórmula/preço confirmados são da base ALTERNATIVA. Sem ela no catálogo desta conta, cair
    // na base original gravaria o SKU de uma base com o preço e a fórmula de outra — recusa.
    const product = alternativeProduct
      ? catalogProducts.find(p => p.id === alternativeProduct.id) ?? null
      : tintPendingProduct;
    if (!product) {
      toast.error('A base escolhida não está no catálogo desta empresa — o item não foi adicionado.', {
        description: 'Escolha a cor na base original ou adicione a outra base pela busca de produtos.',
      });
      return 'conflito' as const; // o diálogo não conta como cor confirmada (tint.cor_confirmada)
    }
    const newItem: OrderItem = {
      product_id: product.id,
      omie_codigo_produto: product.omie_codigo_produto,
      codigo: product.codigo,
      descricao: product.descricao,
      unidade: product.unidade || 'UN',
      quantidade: 1,
      valor_unitario: precoFinal,
      valor_total: precoFinal,
      tint_cor_id: corId,
      tint_nome_cor: nomeCor,
      // espelha o balcão (submitOrder.ts): grava a fórmula p/ auditoria e re-precificação.
      tint_formula_id: formulaId,
      // Fase 3: fonte/desconto declarados — o gate do submit revalida esta decisão.
      ...(pricingMeta?.source ? {
        tint_price_source: pricingMeta.source,
        tint_discount_pct: pricingMeta.discountPct,
        ...(pricingMeta.precoSemDesconto != null ? { tint_preco_sem_desconto: pricingMeta.precoSemDesconto } : {}),
      } : {}),
    };
    setItems(prev => [...prev, newItem]);
    setTintPendingProduct(null);
    toast.success(`"${product.descricao}" com cor ${corId} adicionado`);
    return 'adicionado' as const;
  };

  const tintProductAsProduct = useMemo((): Product | null => {
    if (!tintPendingProduct) return null;
    return {
      id: tintPendingProduct.id,
      codigo: tintPendingProduct.codigo,
      descricao: tintPendingProduct.descricao,
      unidade: tintPendingProduct.unidade,
      valor_unitario: tintPendingProduct.valor_unitario,
      estoque: tintPendingProduct.estoque ?? null, // ausente ≠ zero (follow-up #4087)
      ativo: tintPendingProduct.ativo ?? true,
      omie_codigo_produto: tintPendingProduct.omie_codigo_produto,
      account: tintPendingProduct.account,
      is_tintometric: tintPendingProduct.is_tintometric ?? undefined,
      tint_type: tintPendingProduct.tint_type ?? undefined,
    };
  }, [tintPendingProduct]);

  const filteredProducts = useMemo(() => {
    if (!productSearch || productSearch.length < 2) return [];
    const q = productSearch.toLowerCase();
    return catalogProducts.filter(p =>
      p.descricao?.toLowerCase().includes(q) || p.codigo?.toLowerCase().includes(q)
    ).slice(0, 20);
  }, [productSearch, catalogProducts]);

  // `s + null` e 0 em JavaScript — o item sem preco somaria silenciosamente nada e o
  // subtotal ficaria MENOR que a verdade sem sinal nenhum. Aqui a linha sem total fica
  // explicitamente de fora; quem barra o salvar e o guard de preco, logo abaixo.
  const subtotal = useMemo(() => subtotalDaEdicao(items), [items]);
  const invalidQuantityItemIndices = useMemo(() => invalidQuantityOrderItemIndices(items), [items]);
  // Índices dos itens com preço inválido (≤ 0 / NaN) — MESMA fonte para o bloqueio no
  // save e para o destaque na UI (aria-invalid + botão travado).
  const invalidPriceItemIndices = useMemo(() => invalidPricedOrderItemIndices(items), [items]);

  // Prova positiva de que a lista exibida não serve para ESTE pedido: degradação declarada
  // + a condição já gravada nele ausente da lista. Só a conjunção — no caminho bom, código
  // ausente é parcela inativada no Omie (`cInativo === 'S'` é filtrado), estado legítimo.
  const condicaoDoPedidoAusente = useMemo(
    () => condicoesDoClienteIndisponiveis(
      { formas, degradado: formasDegradadas, motivo: formasMotivo },
      [parcelaOriginal],
    ),
    [formas, formasDegradadas, formasMotivo, parcelaOriginal],
  );
  // Trava o SELETOR (não a edição inteira): sem a lista real, trocar a condição por uma
  // genérica altera o prazo de um pedido já negociado. Não mexer é seguro — `selectedParcela`
  // continua sendo o código original e vai íntegro ao Omie. Editar item/observação segue livre.
  const parcelaTravada = condicaoDoPedidoAusente.length > 0;

  // Estado do PEDIDO (registroEnvios), relido a cada aviso do registro: divergente vale mais que a trava local
  // (recarregar não a tira); envio em voo de OUTRA tela deste mesmo pedido congela sem mensagem de erro.
  // Pelo `id` da ROTA, não por `order`: a tela que ainda carrega também tem de ver o envio em voo (Codex
  // 2026-11-26 — com `order` nulo ela não via o envio terminar e abria com o carrinho de antes).
  const doRegistro = id ? estadoDoPedido(id) : { emVoo: false, divergente: false };
  const travaEfetiva: TravaDoEnvio | null = doRegistro.divergente ? TRAVA_DIVERGENTE : precisaRecarregar;
  const envioDeOutraTela = doRegistro.emVoo && !saving;
  // Quando o envio de OUTRA tela deste pedido termina, o que esta tela copiou ao abrir ficou velho: relê o
  // pedido antes de liberar os campos (Codex 2026-11-26: liberava com R$ 100 depois do envio de R$ 150).
  const outraTelaEnviandoRef = useRef(false);
  useEffect(() => {
    if (outraTelaEnviandoRef.current && !envioDeOutraTela && !envioEmVooRef.current) void loadOrder();
    outraTelaEnviandoRef.current = envioDeOutraTela;
  }, [envioDeOutraTela]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    if (!order || envioEmVooRef.current) return;
    const trava = travaEfetiva;
    if (trava) {
      toast.error(trava.mensagem);
      return;
    }
    // Fail-closed no caminho que grava: o botão some quando bloqueado, mas a trava é aqui.
    const bloqueio = bloqueioDaEdicao(order);
    if (bloqueio) {
      toast.error(bloqueio);
      return;
    }
    if (items.length === 0) {
      toast.error('O pedido precisa ter pelo menos 1 item');
      return;
    }
    // Guard money-path: nenhum item de produto pode ser salvo com preço ≤ 0 (esvaziar o
    // campo vira Number("")||0 = 0). Bloqueia ANTES de qualquer update local ou sync ao
    // Omie, nos dois caminhos (com e sem omie_pedido_id) — fail-closed imperativo, não só UI.
    if (invalidPriceItemIndices.length > 0) {
      toast.error(invalidOrderPriceMessage(invalidPriceItemIndices.map((i) => items[i])));
      return;
    }
    if (invalidQuantityItemIndices.length > 0) {
      const nomes = invalidQuantityItemIndices.map((i) => items[i].descricao || items[i].codigo || 'item sem nome').join(', ');
      toast.error(`Defina uma quantidade maior que zero antes de salvar. Itens: ${nomes}.`);
      return;
    }
    // Total indeterminado não se grava (ausente ≠ zero): com os guards acima é inalcançável, mas
    // o caminho local grava `subtotal`/`total` direto — a trava fica junto da gravação.
    if (subtotal === null) {
      toast.error('Não consegui calcular o total do pedido. Confira preço e quantidade dos itens.');
      return;
    }
    // Guard money-path da condição de pagamento: o seletor travado é feedback; a proteção
    // é aqui, no caminho que grava (§5). Sob lista degradada que não contém a condição do
    // pedido, a ÚNICA parcela aceitável é a original — qualquer outra veio das 8 genéricas.
    if (parcelaTravada && selectedParcela !== parcelaOriginal) {
      toast.error(mensagemCondicoesIndisponiveis(condicaoDoPedidoAusente));
      return;
    }
    const account = contaDaEdicao(order.account);
    if (!account) return; // inalcançável: bloqueioDaEdicao já recusou a conta
    // Registro de envio só no caminho que toca o Omie (efeito irreversível fora do banco).
    const viaOmie = !!order.omie_pedido_id;
    if (viaOmie && !iniciarEnvio(order.id)) {
      toast.error('Um salvamento deste pedido ainda está em andamento. Aguarde terminar.');
      return;
    }
    envioEmVooRef.current = true;
    setSaving(true);
    const pedidoEnviado = order.id;
    const naTela = () => montadoRef.current;
    try {

      if (order.omie_pedido_id) {
        // ── Fase 3 (refactor exigido pelo gate — achado Codex P1): o edge vem
        // PRIMEIRO, aguardado. O jsonb persistido fica INTACTO até o sucesso —
        // ele é o BASELINE que o gate tint usa p/ distinguir item intocado de
        // alterado e p/ impedir o preço-cliente de se autovalidar. No sucesso o
        // EDGE persiste items/notes/payload (write-back do alterar_pedido);
        // bloqueio/erro → permanecer na tela, local intacto, nada de "salvo!".
        toast.info('Validando e sincronizando com o Omie...');
        const despacho = await comPrazo(supabase.functions.invoke('omie-vendas-sync', {
          body: {
            action: 'alterar_pedido',
            account,
            sales_order_id: order.id,
            items: items.map(i => ({
              product_id: i.product_id,
              omie_codigo_produto: i.omie_codigo_produto,
              codigo: i.codigo,
              descricao: i.descricao,
              unidade: i.unidade,
              quantidade: i.quantidade,
              valor_unitario: i.valor_unitario,
              ...(i.tint_cor_id ? {
                tint_cor_id: i.tint_cor_id,
                tint_nome_cor: i.tint_nome_cor,
                // Fase 3: o gate do edge revalida a fonte declarada (ou o piso, se legado)
                ...(i.tint_formula_id ? { tint_formula_id: i.tint_formula_id } : {}),
                ...(i.tint_price_source ? {
                  tint_price_source: i.tint_price_source,
                  tint_discount_pct: i.tint_discount_pct ?? 0,
                  ...(i.tint_preco_sem_desconto != null ? { tint_preco_sem_desconto: i.tint_preco_sem_desconto } : {}),
                } : {}),
              } : {}),
            })),
            // Sempre, como na main: o ERP recebe a MESMA nota que o app guarda e o cupom imprime (Codex
            // 2026-11-27 — omitir a intocada deixava o PV com uma nota e o cupom com outra).
            observacao: notes,
            // #7: a versão da linha que este formulário viu. A edge reserva o pedido por ela ANTES de tocar
            // o Omie — outra edição (ou envio/exclusão) no meio do caminho faz a reserva não casar.
            versao: order.updated_at ?? null,
            // Só a parcela que o VENDEDOR escolheu: sem mudança, a edge herda a condição VIVA do PV
            // (`parcelaEfetiva`). Reenviar a do recibo regravaria um prazo que o financeiro já trocou
            // no Omie (Codex r3).
            codigo_parcela: selectedParcela && selectedParcela !== parcelaOriginal ? selectedParcela : undefined,
            // Gate ATP fase 2: esta via entende blocked:'atp' (aumento de
            // exposição Oben na edição é bloqueado na fronteira).
            atp_capaz: true,
          },
        }), PRAZOS.envioMs);
        // #16: depois do despacho, QUALQUER desfecho pode ter mudado o pedido (no Omie ou no write-back) —
        // a lista e o detalhe deste pedido saem do cache em todas as rotas, sem segurar a navegação.
        void invalidarCachesDoPedido(queryClient, pedidoEnviado);
        if (!despacho.ok) {
          // Sem resposta no prazo: o Omie pode ter mudado ou não — desconhecido é divergente (#30).
          marcarDivergente(pedidoEnviado);
          if (!naTela()) return;
          toast.error('O Omie não respondeu a tempo — o app não sabe se o pedido mudou', {
            description: TRAVA_DIVERGENTE.mensagem,
            duration: 12000,
          });
          setSaving(false);
          return;
        }
        const { data, error } = despacho.valor;
        if (error) {
          const falha = await lerFalhaDoEnvio(error);
          const mensagem = falha.mensagem || error.message || 'Erro desconhecido';
          if (falha.exigeRecarregar) {
            // #30: o Omie pode já ter mudado (ou o desfecho é desconhecido) — o formulário velho não pode ser
            // reenviado, nem depois de recarregar o app.
            marcarDivergente(pedidoEnviado);
          }
          if (!naTela()) return;
          toast.error('Erro ao sincronizar com Omie: ' + mensagem, { duration: 12000 });
          setSaving(false);
          return;
        }
        if (!naTela()) {
          // A tela deste pedido já fechou: só o que é do pedido. Fora `success: true` e as recusas que a edge
          // dá ANTES de tocar o Omie, o desfecho é desconhecido — o pedido fica divergente.
          const d = data as { success?: unknown; blocked?: unknown } | null;
          if (d?.success !== true && !(typeof d?.blocked === 'string' && RECUSAS_ANTES_DO_OMIE.includes(d.blocked))) {
            marcarDivergente(pedidoEnviado);
          }
          return;
        }
        if ((data as { blocked?: string } | null)?.blocked === 'credito') {
          // Trava Fase 2 (edge devolve 200 estruturado): o gate barrou o AUMENTO —
          // o Omie NÃO foi atualizado e o pedido local seguiu intacto.
          toast.error('Edição bloqueada por crédito — o Omie NÃO foi atualizado', {
            description:
              'Aumento de valor para cliente com vencido 60+ exige exceção de gestor ' +
              '(Pedidos → abrir o pedido → botão Crédito). Após aprovar, salve o pedido de novo.',
            duration: 12000,
          });
          setSaving(false);
          return;
        }
        if ((data as { blocked?: string } | null)?.blocked === 'tint_preco') {
          // Gate tint Fase 3: item de tinta com preço obsoleto/fórmula morta —
          // o Omie NÃO foi atualizado e o pedido local seguiu intacto.
          const bloqueios = (data as { bloqueios?: Array<{ cor_id?: string }> }).bloqueios;
          const cores = [...new Set((bloqueios ?? []).map(b => b.cor_id).filter(Boolean))].join(', ');
          toast.error('Edição bloqueada: preço de tinta desatualizado — o Omie NÃO foi atualizado', {
            description:
              `${cores ? `Cor ${cores}: ` : ''}o preço/fórmula mudou desde a criação do pedido. ` +
              'Remova o item de tinta e adicione de novo pela tela (o preço recalcula), então salve.',
            duration: 12000,
          });
          setSaving(false);
          return;
        }
        if ((data as { blocked?: string } | null)?.blocked === 'atp') {
          // Gate ATP fase 2: a edição AUMENTOU a exposição Oben (quantidade maior
          // ou SKU novo) — o Omie NÃO foi atualizado. Sem override na edição: a
          // válvula é um pedido novo pelo balcão (lá reserva/backorder existem).
          const aumentos = (data as { aumentos?: Array<{ omie_codigo_produto?: number; quantidade_atual?: number; quantidade_nova?: number }> }).aumentos;
          const detalhe = (aumentos ?? [])
            .map(a => `${a.omie_codigo_produto}: ${a.quantidade_atual ?? '—'} → ${a.quantidade_nova ?? '—'}`)
            .join('; ');
          toast.error('Edição bloqueada: aumento sem estoque reservado — o Omie NÃO foi atualizado', {
            description:
              `${detalhe ? `Aumentos: ${detalhe}. ` : ''}Reduza para as quantidades originais e, para o excedente, ` +
              'crie um pedido novo pelo balcão (lá a reserva de estoque e o backorder explícito existem).',
            duration: 12000,
          });
          setSaving(false);
          return;
        }
        if ((data as { blocked?: string } | null)?.blocked === 'desconto_omie') {
          // Guard money-path da edge: a edição EXCLUI e reinclui os itens no Omie sem o desconto, então
          // salvar por aqui apagaria o desconto comercial do pedido. O Omie NÃO foi atualizado e o pedido
          // local seguiu intacto. Sem override no app — pedido com desconto se altera no Omie.
          // Só `ilegivel` NÃO afirma que há desconto: diz que não foi possível verificar.
          const bloqueio = data as { itens?: Array<{ motivo?: string }>; capa?: { motivo?: string } | null };
          const motivos = [...(bloqueio.itens ?? []).map(i => i.motivo), bloqueio.capa?.motivo];
          const comprovado = motivos.includes('desconto');
          track('pedido.edicao_bloqueada', {
            motivo: 'desconto_omie',
            comprovado,
            itens: bloqueio.itens?.length ?? 0,
            empresa: account,
          });
          toast.error(
            comprovado
              ? 'Edição bloqueada: este pedido tem desconto de item no Omie — o Omie NÃO foi atualizado'
              : 'Edição bloqueada: não foi possível verificar o desconto dos itens no Omie — o Omie NÃO foi atualizado',
            {
              description:
                'Salvar por aqui reenviaria os itens sem desconto e apagaria o desconto comercial do pedido. ' +
                'Faça a alteração direto no Omie.',
              duration: 12000,
            },
          );
          setSaving(false);
          return;
        }
        const recusa = data as { blocked?: string; motivo?: string } | null;
        if (recusa?.blocked === 'edicao_concorrente') {
          track('pedido.edicao_bloqueada', { motivo: recusa.blocked, empresa: account });
          setPrecisaRecarregar(TRAVA_CONCORRENTE);
          toast.error('O pedido mudou enquanto você editava — o Omie NÃO foi atualizado', {
            description: recusa.motivo ?? 'Recarregue o pedido para ver a versão atual antes de salvar.',
            duration: 12000,
          });
          setSaving(false);
          return;
        }
        if (recusa?.blocked && BLOQUEIOS_COM_MOTIVO.includes(recusa.blocked)) {
          // Travas da edge v1.48 (./edicao-omie.ts): gêmeo avançado, etapa viva, PV de outro cliente,
          // leitura incompleta, origem/status/conta. O motivo vem da edge — a tela só o mostra.
          track('pedido.edicao_bloqueada', { motivo: recusa.blocked, empresa: account });
          toast.error('Edição recusada — o Omie NÃO foi atualizado', {
            description: recusa.motivo ?? 'A edge recusou a edição sem dizer o motivo. Recarregue e tente de novo.',
            duration: 12000,
          });
          setSaving(false);
          return;
        }
        if ((data as { success?: unknown } | null)?.success !== true) {
          // 200 sem recusa conhecida e sem `success: true` literal (HTML de proxy, `"false"`, corpo vazio): o
          // desfecho no Omie é DESCONHECIDO — nem sucesso, nem "tente de novo" (Codex 2026-11-26).
          marcarDivergente(pedidoEnviado);
          toast.error('O app não conseguiu confirmar o resultado no Omie', {
            description: TRAVA_DIVERGENTE.mensagem,
            duration: 12000,
          });
          setSaving(false);
          return;
        }
        // Sucesso: o edge já persistiu items/subtotal/notes/omie_payload.
        // #16: lista, soma, detalhe e descontos estão frescos por 60 s — sem invalidar, a lista mostraria
        // (e imprimiria/compartilharia) o valor de antes logo depois do "atualizado".
        toast.success('Pedido atualizado e sincronizado com o Omie!');
        navigate('/sales');
      } else {
        const updatedPayloadLocal = {
          ...(order.omie_payload || {}),
          cabecalho: {
            ...(order.omie_payload?.cabecalho || {}),
            ...(selectedParcela ? { codigo_parcela: selectedParcela } : {}),
          },
        };
        // Só observação/parcela mudou → items/subtotal/total NÃO entram no UPDATE (o líquido gravado,
        // com desconto/frete do cabeçalho, fica intacto). Itens mudaram num pedido com ajuste → recusa.
        const valores = valoresDaEdicaoLocal({
          itensOriginais: order.items ?? [],
          itensNovos: items,
          subtotalOriginal: order.subtotal,
          totalOriginal: order.total,
          subtotalNovo: subtotal,
        });
        if (!valores.ok) {
          toast.error(valores.motivo);
          setSaving(false);
          return;
        }
        // A decisão "sem PV" foi tomada com a foto da abertura da tela: o UPDATE só vale se a linha
        // AINDA está assim — sem PV, não excluída, mesmo status. Outra aba que converteu o orçamento
        // nesse meio-tempo faz o UPDATE não casar nenhuma linha (Codex 2026-11-26). O carimbo
        // `envio_omie_reivindicado_em` NÃO entra no filtro: `authenticated` não tem SELECT nessa coluna
        // (42501 em todo salvar) e um envio recusado o deixa preso para sempre. Em vez dele, `updated_at`
        // (trigger em TODO UPDATE, SELECT concedido): o claim de um envio feito depois da abertura muda a
        // versão e o UPDATE não casa — sem dois totais confirmados para a mesma venda (Codex r3).
        // Residual: tela aberta DURANTE o voo (claim já feito, write-back ainda não) não é vista.
        const condicoes = supabase
          .from('sales_orders')
          .update({
            ...(valores.valores ?? {}),
            notes: notes || null,
            omie_payload: updatedPayloadLocal,
          })
          .eq('id', order.id)
          .is('omie_pedido_id', null)
          .is('deleted_at', null)
          .eq('status', order.status);
        // Sem prazo e sem o registro de envio, como na main: este caminho não toca o Omie, e a trava de versão
        // (`updated_at` + 1 linha) já faz um 2º salvar com retrato velho não gravar nada (Codex 2026-11-27 —
        // o prazo aqui criava liberação adiada e releituras que soltavam o total antigo).
        const { data: gravadas, error } = await (order.updated_at
          ? condicoes.eq('updated_at', order.updated_at)
          : condicoes.is('updated_at', null)
        ).select('id');
        // #16 também aqui: o detalhe e a lista em cache (60 s) imprimiriam o valor de antes (Codex r9).
        void invalidarCachesDoPedido(queryClient, pedidoEnviado);
        if (error) throw error;
        if (!naTela()) return;
        if ((gravadas ?? []).length !== 1) {
          setPrecisaRecarregar(TRAVA_CONCORRENTE);
          toast.error('O pedido mudou enquanto você editava (foi enviado, alterado em outra aba, excluído ou mudou de status). Nada foi gravado — recarregue a página.');
          setSaving(false);
          return;
        }
        toast.success('Pedido atualizado localmente');
        navigate('/sales');
      }
    } catch (e) {
      console.error(e);
      if (!montadoRef.current) return;
      const message = e instanceof Error ? e.message : 'Erro ao salvar pedido';
      toast.error(message);
      setSaving(false);
    } finally {
      envioEmVooRef.current = false;
      if (viaOmie) encerrarEnvio(pedidoEnviado);
    }
  };

  const motivoBloqueio = order ? bloqueioDaEdicao(order) : null;
  const isBlocked = motivoBloqueio !== null;
  // #48: durante o envio e depois de uma falha que exige recarregar, nada no formulário muda.
  const formularioTravado = isBlocked || saving || travaEfetiva !== null || envioDeOutraTela;
  const temAlteracaoPendente = useMemo(() => {
    if (!order || isBlocked) return false;
    return !mesmosItens(order.items ?? [], items)
      || notes !== (order.notes ?? '')
      || selectedParcela !== parcelaOriginal;
  }, [order, isBlocked, items, notes, selectedParcela, parcelaOriginal]);
  // #48: fechar/recarregar a aba com alteração não salva pede confirmação do navegador. A navegação
  // dentro do app não é interceptável aqui (BrowserRouter sem data router) — a tela mostra o aviso.
  useEffect(() => {
    if (!temAlteracaoPendente) return;
    const aviso = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', aviso);
    return () => window.removeEventListener('beforeunload', aviso);
  }, [temAlteracaoPendente]);

  return {
    order,
    customerName,
    items,
    notes,
    setNotes,
    loading,
    saving,
    formas,
    selectedParcela,
    setSelectedParcela,
    formasDegradadas,
    formasErro,
    formasMotivo,
    condicaoDoPedidoAusente,
    parcelaTravada,
    showAddProduct,
    setShowAddProduct,
    productSearch,
    setProductSearch,
    tintPendingProduct,
    setTintPendingProduct,
    customerUserId,
    updateItem,
    removeItem,
    addProduct,
    precoPrevisto,
    handleTintConfirm,
    tintProductAsProduct,
    filteredProducts,
    subtotal,
    invalidPriceItemIndices,
    handleSave,
    isBlocked,
    motivoBloqueio,
    invalidQuantityItemIndices,
    formularioTravado,
    precisaRecarregar: travaEfetiva,
    envioDeOutraTela,
    recarregar: loadOrder,
    temAlteracaoPendente,
  };
}
