import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import { maskDocument } from '@/lib/format';
import { eqText, orFilter } from '@/lib/postgrest';
import { deveCriarClienteNaConta } from './ensure-helpers';
import { montarPrecosLocaisPorConta, type PrecosLocaisPorConta } from './precos-por-conta';
import type {
  OmieCustomer,
  AddressData,
} from './types';

/* Types for purchase-history merge (jsonb items + price history rows) */
interface SalesOrderItemSnapshot {
  codigo?: string;
  product_code?: string;
  product_id?: string;
}
interface SalesOrderHistoryRow {
  items: SalesOrderItemSnapshot[] | null;
  created_at: string;
}
interface SalesPriceHistoryRow {
  product_id: string;
  created_at: string;
}

/* Shapes returned by `supabase.functions.invoke()` calls used here. */
interface FunctionInvokeResult<T = unknown> {
  data: T | null;
  error?: { message?: string } | null;
}

interface ParcelaRankingItem {
  codigo: string;
  count: number;
}

interface ParcelaResponse {
  ultima_parcela?: string | null;
  parcela_ranking?: ParcelaRankingItem[];
}

interface UseCustomerSelectionArgs {
  /** Called after a customer is selected and a local user id was resolved.
   *  The hook owner uses this to load tools, addresses, price history, etc. */
  onLocalUserResolved?: (localUserId: string) => void;
  /** Optional: re-load price history (from the parent's usePriceHistory hook) */
  reloadPriceHistory?: () => void;
}

export function useCustomerSelection({
  onLocalUserResolved,
  reloadPriceHistory,
}: UseCustomerSelectionArgs = {}) {
  const queryClient = useQueryClient();

  /* Token de geração: descarta conclusões de uma seleção antiga quando o
     usuário troca de cliente no meio (corrida A→B). Cada selectCustomer
     incrementa o token; awaits que voltam com token vencido não setam estado. */
  const selectionTokenRef = useRef(0);

  /* Promise RETIDA do auto-cadastro em background (Etapa 3 do spec
     preco-realtime): a seleção dispara o ensure SEM esperar (o spinner do
     cliente não paga mais ~2-4s de WRITE no Omie) e o submit faz JOIN nela
     via waitForAccountEnsure — recebendo o cliente PÓS-ensure (a closure de
     selectedCustomer pode ser a cópia anterior aos códigos criados). O
     preflight fail-closed do submit (Etapa 2a) segue como rede.
     TOKEN-STAMP (revisão adversarial): a retenção carrega o token da seleção
     que a criou — o join só devolve o cliente se ele ainda é a seleção
     CORRENTE. Identidade por documento NÃO serve de guard aqui: existem
     duplicatas mesmo-CNPJ em prod (plantadas pelo bug histórico de
     auto-criação) e o AI-flow monta cliente com documento vazio. */
  const ensureAccountsRef = useRef<{ token: number; promise: Promise<OmieCustomer | null> }>({
    token: 0,
    promise: Promise.resolve(null),
  });

  /* ─── State ─── */
  const [customerSearch, setCustomerSearch] = useState('');
  const [customers, setCustomers] = useState<OmieCustomer[]>([]);
  const [searchingCustomers, setSearchingCustomers] = useState(false);

  const [selectedCustomer, setSelectedCustomer] = useState<OmieCustomer | null>(null);
  const [loadingCustomer, setLoadingCustomer] = useState(false);
  const [customerUserId, setCustomerUserId] = useState<string | null>(null);
  const [requiresPo, setRequiresPo] = useState<boolean>(false);

  const [customerPricesOben, setCustomerPricesOben] = useState<Record<number, number>>({});
  const [customerPricesColacor, setCustomerPricesColacor] = useState<Record<number, number>>({});
  // Data do último praticado por omie_code (order_date_kpi) — alimenta a janela de 180d
  // da partida por tier. Confinada por conta como o preço (colisão cross-account).
  const [customerPriceDatesOben, setCustomerPriceDatesOben] = useState<Record<number, string>>({});
  const [customerPriceDatesColacor, setCustomerPriceDatesColacor] = useState<Record<number, string>>({});

  const [selectedParcelaOben, setSelectedParcelaOben] = useState<string>('999');
  const [selectedParcelaColacor, setSelectedParcelaColacor] = useState<string>('999');
  const [customerParcelaRankingOben, setCustomerParcelaRankingOben] = useState<string[]>([]);
  const [customerParcelaRankingColacor, setCustomerParcelaRankingColacor] = useState<string[]>([]);

  /* ─── Addresses (react-query, 5min stale) ─── */
  const { data: addresses = [] } = useQuery<AddressData[]>({
    queryKey: ['customer-addresses', customerUserId],
    enabled: !!customerUserId,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('addresses')
        .select('*')
        .eq('user_id', customerUserId!)
        .order('is_default', { ascending: false });
      if (error) throw error;
      return (data || []).map((addr) => ({
        id: addr.id, label: addr.label, street: addr.street, number: addr.number,
        complement: addr.complement, neighborhood: addr.neighborhood, city: addr.city,
        state: addr.state, zipCode: addr.zip_code,
      }));
    },
  });
  const [selectedAddress, setSelectedAddress] = useState<string>('');

  // Auto-select first address when list loads and none is selected
  useEffect(() => {
    if (addresses.length > 0 && !selectedAddress) {
      setSelectedAddress(addresses[0].id);
    }
  }, [addresses, selectedAddress]);

  /* ─── Purchase history (react-query, 2min stale) ─────────────────────────
     Fase 1: SÓ fontes LOCAIS (rápidas, estáveis):
       a) sales_orders local (últimas 100 ordens) → códigos de produto
       b) sales_price_history local → product_id (formato `pid:<uuid>`)
     O histórico do Omie (`historico_produtos_cliente`, até 5 ListarPedidos/conta)
     foi REMOVIDO daqui — era o maior gerador da colisão de rate-limit (~40s). A
     completude do Omie volta na Fase 2 (chamada atômica account-aware).
     A key inclui os códigos do cliente para reagir a auto-create. */
  const codigoOben = selectedCustomer?.codigo_cliente ?? null;
  const codigoColacor = selectedCustomer?.codigo_cliente_colacor ?? null;
  const { data: customerPurchaseHistory = {} } = useQuery<Record<string, string>>({
    queryKey: ['customer-purchase-history', customerUserId, codigoOben, codigoColacor],
    enabled: !!customerUserId || !!codigoOben || !!codigoColacor,
    staleTime: 2 * 60 * 1000,
    queryFn: async () => {
      const localOrdersPromise = customerUserId
        ? supabase.from('sales_orders')
            .select('items, created_at')
            .eq('customer_user_id', customerUserId)
            .neq('status', 'orcamento')
            .order('created_at', { ascending: false })
            .limit(100)
        : Promise.resolve({ data: null });
      const localPricePromise = customerUserId
        ? supabase.from('sales_price_history')
            .select('product_id, created_at')
            .eq('customer_user_id', customerUserId)
            .order('created_at', { ascending: false })
        : Promise.resolve({ data: null });

      const [ordersSettled, priceSettled] = await Promise.allSettled([
        localOrdersPromise,
        localPricePromise,
      ]);

      const history: Record<string, string> = {};

      if (ordersSettled.status === 'fulfilled' && ordersSettled.value?.data) {
        for (const order of ordersSettled.value.data as unknown as SalesOrderHistoryRow[]) {
          const items = order.items as SalesOrderItemSnapshot[] | null;
          if (Array.isArray(items)) {
            for (const item of items) {
              const code = item.codigo || item.product_code || '';
              if (code && !history[code]) history[code] = order.created_at;
              const pid = item.product_id || '';
              if (pid && !history[`pid:${pid}`]) history[`pid:${pid}`] = order.created_at;
            }
          }
        }
      }

      if (priceSettled.status === 'fulfilled' && priceSettled.value?.data) {
        for (const row of priceSettled.value.data as unknown as SalesPriceHistoryRow[]) {
          if (!history[`pid:${row.product_id}`]) history[`pid:${row.product_id}`] = row.created_at;
        }
      }

      return history;
    },
  });

  const [vendedorDivergencias, setVendedorDivergencias] = useState<string[]>([]);
  const [validatingVendedor, setValidatingVendedor] = useState(false);

  /* ─── Customer search (debounced) ─── */
  useEffect(() => {
    if (customerSearch.length < 2) { setCustomers([]); return; }
    const timeout = setTimeout(async () => {
      setSearchingCustomers(true);
      try {
        const { data, error } = await supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'listar_clientes', search: customerSearch },
        });
        if (!error && data?.clientes) {
          const clientes = data.clientes as OmieCustomer[];
          if (clientes.length > 0) {
            const codigos = clientes.map(c => c.codigo_cliente);
            const { data: mappings } = await supabase
              .from('omie_clientes')
              .select('user_id, omie_codigo_cliente')
              // P0-B: a busca é na conta OBEN; sem empresa_omie o código colidiria com colacor e
              // anexaria o customer_user_id ERRADO (item 2). Fail-safe: 0 linhas oben hoje → sem mapa.
              .eq('empresa_omie', 'oben')
              .in('omie_codigo_cliente', codigos);
            if (mappings) {
              for (const c of clientes) {
                const m = mappings.find(mm => mm.omie_codigo_cliente === c.codigo_cliente);
                if (m) c.local_user_id = m.user_id;
              }
            }
          }
          setCustomers(clientes);
        }
      } catch (e) {
        logger.error('Customer search failed', {
          stage: 'customer_search',
          searchTermLength: customerSearch.length,
          error: e,
        });
      }
      finally { setSearchingCustomers(false); }
    }, 500);
    return () => clearTimeout(timeout);
  }, [customerSearch]);

  /* ─── Helpers ─── */

  // loadAddresses agora é o useQuery acima (key: ['customer-addresses', customerUserId])


  /** Resolve local user id from omie_clientes mapping or profiles.document.
   *  Also captures requires_po flag when fetched from profiles. */
  const resolveLocalUserId = useCallback(async (cust: OmieCustomer): Promise<string | null> => {
    let localUserId = cust.local_user_id || null;
    if (!localUserId) {
      const { data: mapping } = await supabase
        .from('omie_clientes')
        .select('user_id')
        .eq('omie_codigo_cliente', cust.codigo_cliente)
        // P0-B: filtra a conta OBEN (cust.codigo_cliente é o slot oben) — sem isso um código colacor
        // colidente mapearia o user errado (item 2). Fail-safe: 0 oben → cai no match por documento abaixo.
        .eq('empresa_omie', 'oben')
        .maybeSingle();
      if (mapping?.user_id) localUserId = mapping.user_id;
    }
    if (!localUserId && cust.cnpj_cpf) {
      const docClean = cust.cnpj_cpf.replace(/\D/g, '');
      if (docClean.length >= 11) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('user_id, requires_po')
          .or(orFilter(eqText('document', docClean), eqText('document', cust.cnpj_cpf)))
          .limit(1)
          .maybeSingle();
        if (profile?.user_id) localUserId = profile.user_id;
        if (profile?.requires_po) setRequiresPo(true);
      }
    }
    // If we found localUserId via mapping route, fetch requires_po now
    if (localUserId) {
      const { data: poProfile } = await supabase
        .from('profiles')
        .select('requires_po')
        .eq('user_id', localUserId)
        .maybeSingle();
      if (poProfile?.requires_po) setRequiresPo(true);
    }
    return localUserId;
  }, []);

  /** Auto-create customer in Colacor and Afiação if missing. Mutates `cust` in place.
   *  Tri-state (deveCriarClienteNaConta): conta cujo LOOKUP falhou NÃO cria às
   *  cegas — ausência não confirmada; criar em cima de erro de leitura
   *  duplicaria no Omie um cliente que já existe. */
  const autoCreateInMissingAccounts = useCallback(async (
    cust: OmieCustomer,
    lookupFailed: { colacor: boolean; afiacao: boolean },
  ) => {
    const customerPayload = {
      document: cust.cnpj_cpf,
      razao_social: cust.razao_social,
      nome_fantasia: cust.nome_fantasia,
      endereco: cust.endereco,
      endereco_numero: cust.endereco_numero,
      bairro: cust.bairro,
      cidade: cust.cidade,
      estado: cust.estado,
      cep: cust.cep,
      telefone: cust.telefone,
      contato: cust.contato,
    };

    const promises: Promise<unknown>[] = [];

    if (
      deveCriarClienteNaConta({
        codigoExistente: cust.codigo_cliente_colacor,
        temDocumento: !!cust.cnpj_cpf,
        lookupFalhou: lookupFailed.colacor,
      })
    ) {
      promises.push(
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'criar_cliente', account: 'colacor', ...customerPayload },
        }).then(res => {
          if (res.data?.codigo_cliente) {
            cust.codigo_cliente_colacor = res.data.codigo_cliente;
            cust.codigo_vendedor_colacor = res.data.codigo_vendedor || null;
            logger.info('Customer auto-created on Colacor Vendas', {
              stage: 'auto_create_colacor',
              customerCnpjCpf: maskDocument(cust.cnpj_cpf),
              codigoClienteColacor: res.data.codigo_cliente,
            });
          }
        }).catch(e => logger.warn('Auto-create customer on Colacor Vendas failed (continuing)', {
          stage: 'auto_create_colacor',
          customerCnpjCpf: maskDocument(cust.cnpj_cpf),
          error: e,
        }))
      );
    }

    if (
      deveCriarClienteNaConta({
        codigoExistente: cust.codigo_cliente_afiacao,
        temDocumento: !!cust.cnpj_cpf,
        lookupFalhou: lookupFailed.afiacao,
      })
    ) {
      promises.push(
        supabase.functions.invoke('omie-sync', {
          body: { action: 'criar_cliente_afiacao', ...customerPayload },
        }).then(res => {
          if (res.data?.codigo_cliente) {
            cust.codigo_cliente_afiacao = res.data.codigo_cliente;
            cust.codigo_vendedor_afiacao = res.data.codigo_vendedor || null;
            logger.info('Customer auto-created on Colacor Afiação', {
              stage: 'auto_create_afiacao',
              customerCnpjCpf: maskDocument(cust.cnpj_cpf),
              codigoClienteAfiacao: res.data.codigo_cliente,
            });
          }
        }).catch(e => logger.warn('Auto-create customer on Colacor Afiação failed (continuing)', {
          stage: 'auto_create_afiacao',
          customerCnpjCpf: maskDocument(cust.cnpj_cpf),
          error: e,
        }))
      );
    }

    if (promises.length > 0) await Promise.all(promises);
  }, []);

  /** Resolve o último preço praticado local em DOIS mapas account-aware
   *  (oben/colacor). O product_id (uuid de omie_products) já é por-conta;
   *  trazemos `account` p/ NÃO achatar omie_codigo_produto (colide entre as
   *  contas Omie) num Record único — separação em montarPrecosLocaisPorConta. */
  const resolveLocalPricesByOmieCode = useCallback(async (
    localPriceRows: Array<{ product_id: string; unit_price: number; ultimo_praticado_em?: string | null }> | null,
  ): Promise<PrecosLocaisPorConta> => {
    const vazio: PrecosLocaisPorConta = { oben: {}, colacor: {}, datasOben: {}, datasColacor: {} };
    if (!localPriceRows || localPriceRows.length === 0) return vazio;
    const localPricesByProduct: Record<string, number> = {};
    const datasByProduct: Record<string, string | null> = {};
    for (const row of localPriceRows) {
      // get_ultimos vem DISTINCT ON (product_id) ORDER BY data DESC → a 1ª linha por
      // produto é a mais recente; capturamos a data DELA junto com o preço.
      if (!localPricesByProduct[row.product_id]) {
        localPricesByProduct[row.product_id] = row.unit_price;
        datasByProduct[row.product_id] = row.ultimo_praticado_em ?? null;
      }
    }
    const productIds = Object.keys(localPricesByProduct);
    if (productIds.length === 0) return vazio;
    const { data: productMappings, error } = await supabase
      .from('omie_products').select('id, omie_codigo_produto, account').in('id', productIds);
    // Falha do mapeamento → degrada honesto (cada conta cai p/ o preço de tabela
    // `valor_unitario`, nunca R$0), mas deixa RASTRO: sem ele o preço-cliente
    // sumiria silencioso mesmo com a RPC tendo retornado preços (Codex P2).
    if (error) {
      logger.warn('resolveLocalPricesByOmieCode: mapeamento omie_products falhou (degrada p/ preço de tabela)', {
        stage: 'resolve_local_prices_omie_map',
        productIdsCount: productIds.length,
        error,
      });
    }
    return montarPrecosLocaisPorConta(localPricesByProduct, productMappings ?? [], datasByProduct);
  }, []);

  // Purchase history (local + Omie) agora vem do useQuery acima
  // (key: ['customer-purchase-history', customerUserId, codigoOben, codigoColacor])

  /* ─── Public actions ─── */

  const selectCustomer = useCallback(async (cust: OmieCustomer) => {
    // Token desta seleção. Se o usuário trocar de cliente no meio, conclusões
    // atrasadas desta chamada são descartadas (não sobrescrevem o cliente novo).
    const myToken = ++selectionTokenRef.current;
    const isStale = () => selectionTokenRef.current !== myToken;

    // Fecha a janela da seleção ANTERIOR: até esta seleção reter o próprio
    // ensure (após os lookups, ~1-10s), o join do submit NÃO pode devolver o
    // ensure do cliente antigo — devolve null e o submit usa o preflight
    // fail-closed como rede.
    ensureAccountsRef.current = { token: myToken, promise: Promise.resolve(null) };

    setLoadingCustomer(true);
    setCustomerSearch('');
    setCustomers([]);
    setVendedorDivergencias([]);
    setSelectedAddress('');
    setRequiresPo(false);
    // Limpa estado do cliente ANTERIOR — não deve aparecer preço/parcela/vínculo
    // do cliente antigo enquanto os dados do novo carregam.
    setCustomerUserId(null);
    setCustomerPricesOben({});
    setCustomerPricesColacor({});
    setCustomerPriceDatesOben({});
    setCustomerPriceDatesColacor({});
    setSelectedParcelaOben('999');
    setSelectedParcelaColacor('999');
    setCustomerParcelaRankingOben([]);
    setCustomerParcelaRankingColacor([]);
    try {
      setSelectedCustomer(cust);

      const localUserId = await resolveLocalUserId(cust);
      if (isStale()) return;

      if (localUserId) {
        setCustomerUserId(localUserId);
        // addresses + user-tools + purchase-history são carregados automaticamente via useQuery
        reloadPriceHistory?.();
        onLocalUserResolved?.(localUserId);
      }

      // ── Fase 1: preço-cliente = ÚLTIMO PREÇO PRATICADO (fonte LOCAL) ──
      // O `buscar_precos_cliente` (Omie ListarPedidos) foi REMOVIDO do caminho de
      // seleção. Causava ~40s + preço pulando: o app disparava várias ListarPedidos
      // CONCORRENTES na mesma conta (preço + parcela + histórico×5páginas), o Omie
      // barrava com "Já existe uma requisição desse método" e o callOmieVendasApi
      // re-tentava 5-15s×3 → empilhava. Agora o preço vem de `order_items` via a RPC
      // `get_ultimos_precos_cliente` (FONTE DE VERDADE, ordenada por order_date_kpi). NÃO
      // mais `sales_price_history`: o writer legado omie-analytics-sync (aposentado) poluiu
      // a sph com created_at = data de CARGA, e a leitura por created_at mascarava o preço
      // real (456 grupos; migration 20260625120000). A `buscar_ultima_parcela` fica
      // (1 ListarPedidos/conta, já sem colisão) p/ preservar a sugestão de prazo.
      const settledResults = await Promise.allSettled([
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'buscar_ultima_parcela', codigo_cliente: cust.codigo_cliente, account: 'oben' },
        }),
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'buscar_ultima_parcela', codigo_cliente: cust.codigo_cliente, account: 'colacor' },
        }),
        localUserId
          ? supabase.rpc('get_ultimos_precos_cliente', { p_customer: localUserId })
          : Promise.resolve({ data: null }),
        cust.cnpj_cpf
          ? supabase.functions.invoke('omie-vendas-sync', {
              body: { action: 'buscar_cliente', document: cust.cnpj_cpf, account: 'colacor' },
            })
          : Promise.resolve({ data: null }),
        cust.cnpj_cpf
          ? supabase.functions.invoke('omie-sync', {
              body: { action: 'buscar_cliente_por_documento', document: cust.cnpj_cpf },
            })
          : Promise.resolve({ data: null }),
      ]);
      if (isStale()) return;

      const labels = [
        'última parcela Oben',
        'última parcela Colacor',
        'histórico de preço local',
        'cliente Colacor',
        'cliente Afiação',
      ];
      const failedParts: string[] = [];
      // Índices falhos registrados À PARTE dos labels: o tri-state do
      // auto-cadastro deriva DAQUI (por posição no allSettled), não das
      // strings de log — renomear um label não pode desarmar o guard
      // anti-duplicação silenciosamente (revisão adversarial).
      const failedIdxs = new Set<number>();
      const getResult = <T = unknown>(idx: number): FunctionInvokeResult<T> => {
        const r = settledResults[idx];
        if (r.status === 'fulfilled') {
          const val = r.value as FunctionInvokeResult<T> | null | undefined;
          if (val && val.error) {
            logger.warn('selectCustomer: settled call returned error (tolerated)', {
              stage: 'select_customer_settle',
              part: labels[idx],
              customerCnpjCpf: maskDocument(cust.cnpj_cpf),
              codigoCliente: cust.codigo_cliente,
              error: val.error,
            });
            failedParts.push(labels[idx]);
            failedIdxs.add(idx);
            return { data: null };
          }
          return val ?? { data: null };
        }
        logger.warn('selectCustomer: settled call rejected (tolerated)', {
          stage: 'select_customer_settle',
          part: labels[idx],
          customerCnpjCpf: maskDocument(cust.cnpj_cpf),
          codigoCliente: cust.codigo_cliente,
          error: r.reason,
        });
        failedParts.push(labels[idx]);
        failedIdxs.add(idx);
        return { data: null };
      };

      const parcelaOben = getResult<ParcelaResponse>(0);
      const parcelaColacor = getResult<ParcelaResponse>(1);
      const localPriceResult = getResult<Array<{ product_id: string; unit_price: number; ultimo_praticado_em?: string | null }>>(2);
      const colacorClientResult = getResult<{
        cliente?: { codigo_cliente?: number | null; codigo_vendedor?: number | null };
      }>(3);
      const afiacaoClientResult = getResult<{
        codigo_cliente?: number | null;
        codigo_vendedor?: number | null;
      }>(4);

      // Aviso SÓ pra falha que afeta o preço na tela agora. As falhas dos lookups de
      // CÓDIGO por-conta ('cliente Colacor'/'cliente Afiação') NÃO alarmam na seleção:
      //  • o preço-cliente vem do histórico LOCAL (não dessas chamadas);
      //  • o submit fail-closed (Etapa 2a) bloqueia com mensagem PRECISA se você fechar
      //    pedido NAQUELA conta sem a identidade resolvida (é onde o aviso é acionável).
      // 'última parcela ...' também não alarma — a sugestão de prazo cai no padrão, e o
      // vendedor confirma o prazo no fluxo do pedido. (Todas as falhas seguem logadas.)
      if (failedParts.includes('histórico de preço local')) {
        toast.warning('Histórico de preço não carregou', {
          description: 'Usando o preço de tabela. Re-selecione o cliente para tentar de novo.',
        });
      }

      if (colacorClientResult?.data?.cliente) {
        cust.codigo_cliente_colacor = colacorClientResult.data.cliente.codigo_cliente;
        cust.codigo_vendedor_colacor = colacorClientResult.data.cliente.codigo_vendedor || null;
      }
      if (afiacaoClientResult?.data?.codigo_cliente) {
        cust.codigo_cliente_afiacao = afiacaoClientResult.data.codigo_cliente;
        cust.codigo_vendedor_afiacao = afiacaoClientResult.data.codigo_vendedor || null;
      }

      // ── Publica preço (LOCAL) + parcela ANTES do auto-cadastro ──
      // Fase 1: o preço-cliente = último preço praticado lido de `order_items` (FONTE DE VERDADE,
      // via RPC get_ultimos_precos_cliente — NÃO mais `sales_price_history`, poluída pelo writer
      // legado aposentado). Rápido, estável, determinístico. Sem overlay do Omie (removido p/ matar
      // a colisão de rate-limit). ACCOUNT-AWARE (Fase 2): cada conta recebe SÓ os preços praticados
      // nela — omie_codigo_produto colide entre Oben e Colacor (contas Omie separadas), então
      // achatar num mapa só vazaria o preço de uma conta no produto de mesmo código da outra.
      const precosPorConta = await resolveLocalPricesByOmieCode(localPriceResult.data || null);
      if (isStale()) return;

      setCustomerPricesOben({ ...precosPorConta.oben });
      setCustomerPricesColacor({ ...precosPorConta.colacor });
      setCustomerPriceDatesOben({ ...precosPorConta.datasOben });
      setCustomerPriceDatesColacor({ ...precosPorConta.datasColacor });

      if (parcelaOben.data?.ultima_parcela) setSelectedParcelaOben(parcelaOben.data.ultima_parcela);
      if (parcelaOben.data?.parcela_ranking) setCustomerParcelaRankingOben(parcelaOben.data.parcela_ranking.map((r: ParcelaRankingItem) => r.codigo));
      if (parcelaColacor.data?.ultima_parcela) setSelectedParcelaColacor(parcelaColacor.data.ultima_parcela);
      if (parcelaColacor.data?.parcela_ranking) setCustomerParcelaRankingColacor(parcelaColacor.data.parcela_ranking.map((r: ParcelaRankingItem) => r.codigo));

      // Reflete os códigos por-conta já resolvidos pelos lookups (preço já visível).
      setSelectedCustomer({ ...cust });

      // Save customer segment/tags to DB in background (fire-and-forget)
      if (cust.codigo_cliente && (cust.tags?.length || cust.atividade)) {
        supabase.functions.invoke('omie-vendas-sync', {
          body: {
            action: 'salvar_segmento_cliente',
            codigo_cliente: cust.codigo_cliente,
            account: 'oben',
            tags: cust.tags || [],
            atividade: cust.atividade || '',
          },
        }).catch(() => {});
      }

      // ── Etapa 3 (spec preco-realtime): auto-cadastro em BACKGROUND ──
      // A promise fica retida em ensureAccountsRef e o submit faz join nela —
      // a seleção não espera mais o WRITE no Omie (~2-4s no caminho do
      // spinner). Tri-state: conta cujo lookup FALHOU não cria às cegas (o
      // preflight fail-closed do submit bloqueia a conta, se usada).
      // Índices 3/4 = posições dos lookups de cliente no Promise.allSettled acima.
      const LOOKUP_IDX_CLIENTE_COLACOR = 3;
      const LOOKUP_IDX_CLIENTE_AFIACAO = 4;
      const lookupFailed = {
        colacor: failedIdxs.has(LOOKUP_IDX_CLIENTE_COLACOR),
        afiacao: failedIdxs.has(LOOKUP_IDX_CLIENTE_AFIACAO),
      };
      ensureAccountsRef.current = {
        token: myToken,
        promise: autoCreateInMissingAccounts(cust, lookupFailed)
          .then(() => {
            // Reflete códigos recém-criados (purchase-history reage à key);
            // conclusão atrasada de cliente trocado não sobrescreve (guard).
            if (!isStale()) setSelectedCustomer({ ...cust });
            return cust;
          })
          .catch((e) => {
            // autoCreate já isola falhas por conta; este catch é só pra ref
            // nunca rejeitar sem handler (o join do submit trata null).
            logger.warn('Ensure de cadastro em background falhou', {
              stage: 'ensure_accounts_background',
              customerCnpjCpf: maskDocument(cust.cnpj_cpf),
              error: e,
            });
            return cust;
          }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro desconhecido';
      if (!isStale()) toast.error('Erro', { description: message });
    } finally {
      // Só apaga o "Buscando…" se esta ainda é a seleção corrente.
      if (!isStale()) setLoadingCustomer(false);
    }

    if (isStale()) return;
    if (cust.cnpj_cpf) {
      setValidatingVendedor(true);
      try {
        const { data: validacao, error } = await supabase.functions.invoke('omie-cliente', {
          body: { action: 'validar_vendedor', cnpj_cpf: cust.cnpj_cpf },
        });
        if (isStale()) return;
        if (!error && validacao && !validacao.consistente) {
          setVendedorDivergencias(validacao.divergencias || []);
        }
      } catch (err) {
        logger.error('Vendedor validation call failed', {
          stage: 'validate_vendedor',
          customerCnpjCpf: maskDocument(cust.cnpj_cpf),
          codigoCliente: cust.codigo_cliente,
          error: err,
        });
      } finally {
        if (!isStale()) setValidatingVendedor(false);
      }
    }
  }, [
    resolveLocalUserId, autoCreateInMissingAccounts, resolveLocalPricesByOmieCode,
    onLocalUserResolved, reloadPriceHistory,
  ]);

  /** Join da Etapa 3: o submit espera o ensure em background terminar e
   *  recebe o cliente com os códigos por-conta atualizados — SÓ se a retenção
   *  ainda é da seleção corrente (token-stamp); senão null (e o preflight
   *  fail-closed do submit cobre). */
  const waitForAccountEnsure = useCallback(async (): Promise<OmieCustomer | null> => {
    const retained = ensureAccountsRef.current;
    const cliente = await retained.promise;
    return retained.token === selectionTokenRef.current ? cliente : null;
  }, []);

  const clearCustomer = useCallback(() => {
    // Invalida qualquer selectCustomer em voo: suas conclusões viram stale e não
    // ressuscitam o cliente que estamos limpando. Como o finally da seleção pula
    // o setLoadingCustomer(false) quando stale, zeramos os flags de loading aqui.
    selectionTokenRef.current++;
    ensureAccountsRef.current = { token: selectionTokenRef.current, promise: Promise.resolve(null) };
    setSelectedCustomer(null);
    setLoadingCustomer(false);
    setValidatingVendedor(false);
    setCustomerUserId(null);
    setCustomerPricesOben({});
    setCustomerPricesColacor({});
    setCustomerPriceDatesOben({});
    setCustomerPriceDatesColacor({});
    setSelectedParcelaOben('999');
    setSelectedParcelaColacor('999');
    setCustomerParcelaRankingOben([]);
    setCustomerParcelaRankingColacor([]);
    setVendedorDivergencias([]);
    setSelectedAddress('');
    setRequiresPo(false);
    // Limpa o cache de endereços, ferramentas e histórico do cliente anterior
    queryClient.removeQueries({ queryKey: ['customer-addresses'] });
    queryClient.removeQueries({ queryKey: ['user-tools'] });
    queryClient.removeQueries({ queryKey: ['customer-purchase-history'] });
  }, [queryClient]);

  return {
    // Search
    customerSearch, setCustomerSearch,
    customers, searchingCustomers,
    // Selection
    selectedCustomer, setSelectedCustomer,
    loadingCustomer,
    customerUserId, setCustomerUserId,
    requiresPo,
    // Prices
    customerPricesOben, setCustomerPricesOben,
    customerPricesColacor, setCustomerPricesColacor,
    // Datas do último praticado (janela 180d da partida por tier)
    customerPriceDatesOben, customerPriceDatesColacor,
    // Parcelas
    selectedParcelaOben, setSelectedParcelaOben,
    selectedParcelaColacor, setSelectedParcelaColacor,
    customerParcelaRankingOben,
    customerParcelaRankingColacor,
    // Addresses (lista vem do useQuery; selectedAddress permanece como state)
    addresses,
    selectedAddress, setSelectedAddress,
    // History (vem do useQuery; sem setter público)
    customerPurchaseHistory,
    // Vendedor
    vendedorDivergencias, validatingVendedor,
    // Actions
    selectCustomer, clearCustomer, waitForAccountEnsure,
  };
}
