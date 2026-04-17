import { useState, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import type {
  OmieCustomer,
  AddressData,
} from './types';

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
  const { toast } = useToast();
  const queryClient = useQueryClient();

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
     Faz merge de 3 fontes em paralelo (allSettled tolera falhas individuais):
       a) sales_orders local (últimas 100 ordens) → códigos de produto
       b) sales_price_history local → product_id (formato `pid:<uuid>`)
       c) Omie histórico de produtos (oben + colacor) → códigos Omie (`omie:<cod>`)
     A key inclui os 3 códigos relevantes do cliente para reagir a auto-create. */
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
      const omiePromises: Promise<any>[] = [];
      if (codigoOben) {
        omiePromises.push(supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'historico_produtos_cliente', codigo_cliente: codigoOben, account: 'oben' },
        }));
      }
      if (codigoColacor) {
        omiePromises.push(supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'historico_produtos_cliente', codigo_cliente: codigoColacor, account: 'colacor' },
        }));
      }

      const [ordersSettled, priceSettled, ...omieSettled] = await Promise.allSettled([
        localOrdersPromise,
        localPricePromise,
        ...omiePromises,
      ]);

      const history: Record<string, string> = {};

      if (ordersSettled.status === 'fulfilled' && ordersSettled.value?.data) {
        for (const order of ordersSettled.value.data as any[]) {
          const items = order.items as any[];
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
        for (const row of priceSettled.value.data as any[]) {
          if (!history[`pid:${row.product_id}`]) history[`pid:${row.product_id}`] = row.created_at;
        }
      }

      for (const res of omieSettled) {
        if (res.status === 'fulfilled' && res.value?.data?.history) {
          const h = res.value.data.history as Record<string, string>;
          for (const [omieCod, dateStr] of Object.entries(h)) {
            if (!history[`omie:${omieCod}`]) history[`omie:${omieCod}`] = dateStr;
          }
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
      } catch (e) { console.error(e); }
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
        .maybeSingle();
      if (mapping?.user_id) localUserId = mapping.user_id;
    }
    if (!localUserId && cust.cnpj_cpf) {
      const docClean = cust.cnpj_cpf.replace(/\D/g, '');
      if (docClean.length >= 11) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('user_id, requires_po')
          .or(`document.eq.${docClean},document.eq.${cust.cnpj_cpf}`)
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

  /** Auto-create customer in Colacor and Afiação if missing. Mutates `cust` in place. */
  const autoCreateInMissingAccounts = useCallback(async (cust: OmieCustomer) => {
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

    const promises: Promise<any>[] = [];

    if (!cust.codigo_cliente_colacor && cust.cnpj_cpf) {
      promises.push(
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'criar_cliente', account: 'colacor', ...customerPayload },
        }).then(res => {
          if (res.data?.codigo_cliente) {
            cust.codigo_cliente_colacor = res.data.codigo_cliente;
            cust.codigo_vendedor_colacor = res.data.codigo_vendedor || null;
            console.log(`[AutoCreate] Cliente criado na Colacor Vendas: ${res.data.codigo_cliente}`);
          }
        }).catch(e => console.warn('[AutoCreate] Erro ao criar na Colacor Vendas:', e))
      );
    }

    if (!cust.codigo_cliente_afiacao && cust.cnpj_cpf) {
      promises.push(
        supabase.functions.invoke('omie-sync', {
          body: { action: 'criar_cliente_afiacao', ...customerPayload },
        }).then(res => {
          if (res.data?.codigo_cliente) {
            cust.codigo_cliente_afiacao = res.data.codigo_cliente;
            cust.codigo_vendedor_afiacao = res.data.codigo_vendedor || null;
            console.log(`[AutoCreate] Cliente criado na Colacor Afiação: ${res.data.codigo_cliente}`);
          }
        }).catch(e => console.warn('[AutoCreate] Erro ao criar na Colacor Afiação:', e))
      );
    }

    if (promises.length > 0) await Promise.all(promises);
  }, []);

  /** Resolve last-practiced local prices into the omie_codigo_produto map */
  const resolveLocalPricesByOmieCode = useCallback(async (
    localPriceRows: Array<{ product_id: string; unit_price: number }> | null,
  ): Promise<Record<number, number>> => {
    if (!localPriceRows || localPriceRows.length === 0) return {};
    const localPricesByProduct: Record<string, number> = {};
    for (const row of localPriceRows) {
      if (!localPricesByProduct[row.product_id]) localPricesByProduct[row.product_id] = row.unit_price;
    }
    const result: Record<number, number> = {};
    const productIds = Object.keys(localPricesByProduct);
    if (productIds.length === 0) return result;
    const { data: productMappings } = await supabase
      .from('omie_products').select('id, omie_codigo_produto').in('id', productIds);
    if (productMappings) {
      for (const pm of productMappings) {
        const price = localPricesByProduct[pm.id];
        if (price && price > 0) result[pm.omie_codigo_produto] = price;
      }
    }
    return result;
  }, []);

  // Purchase history (local + Omie) agora vem do useQuery acima
  // (key: ['customer-purchase-history', customerUserId, codigoOben, codigoColacor])

  /* ─── Public actions ─── */

  const selectCustomer = useCallback(async (cust: OmieCustomer) => {
    setLoadingCustomer(true);
    setCustomerSearch('');
    setCustomers([]);
    setVendedorDivergencias([]);
    setSelectedAddress('');
    setRequiresPo(false);
    try {
      setSelectedCustomer(cust);

      const localUserId = await resolveLocalUserId(cust);

      if (localUserId) {
        setCustomerUserId(localUserId);
        // addresses + user-tools + purchase-history são carregados automaticamente via useQuery
        reloadPriceHistory?.();
        onLocalUserResolved?.(localUserId);
      }

      const settledResults = await Promise.allSettled([
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'buscar_precos_cliente', codigo_cliente: cust.codigo_cliente, account: 'oben' },
        }),
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'buscar_precos_cliente', codigo_cliente: cust.codigo_cliente, account: 'colacor' },
        }),
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'buscar_ultima_parcela', codigo_cliente: cust.codigo_cliente, account: 'oben' },
        }),
        supabase.functions.invoke('omie-vendas-sync', {
          body: { action: 'buscar_ultima_parcela', codigo_cliente: cust.codigo_cliente, account: 'colacor' },
        }),
        localUserId
          ? supabase.from('sales_price_history').select('product_id, unit_price, created_at')
              .eq('customer_user_id', localUserId).order('created_at', { ascending: false })
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

      const labels = [
        'preços Oben',
        'preços Colacor',
        'última parcela Oben',
        'última parcela Colacor',
        'histórico de preço local',
        'cliente Colacor',
        'cliente Afiação',
      ];
      const failedParts: string[] = [];
      const getResult = (idx: number): any => {
        const r = settledResults[idx];
        if (r.status === 'fulfilled') {
          const val: any = r.value;
          if (val && val.error) {
            console.error(`[selectCustomer] ${labels[idx]} retornou erro:`, val.error?.message || val.error);
            failedParts.push(labels[idx]);
            return { data: null };
          }
          return val ?? { data: null };
        }
        console.error(`[selectCustomer] ${labels[idx]} falhou:`, r.reason?.message || r.reason);
        failedParts.push(labels[idx]);
        return { data: null };
      };

      const priceOben = getResult(0);
      const priceColacor = getResult(1);
      const parcelaOben = getResult(2);
      const parcelaColacor = getResult(3);
      const localPriceResult = getResult(4);
      const colacorClientResult = getResult(5);
      const afiacaoClientResult = getResult(6);

      if (failedParts.length > 0) {
        toast({
          title: 'Alguns dados do cliente não foram carregados',
          description: `Falharam: ${failedParts.join(', ')}. Você pode continuar, mas preços/parcelas podem não refletir o contrato.`,
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

      await autoCreateInMissingAccounts(cust);

      setSelectedCustomer({ ...cust });

      // Save customer segment/tags to DB in background
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

      // Background: Omie history → purchase history
      loadOmiePurchaseHistory(cust);

      // Merge local "last-practiced" prices into Omie pricing maps
      const localPricesByOmie = await resolveLocalPricesByOmieCode(localPriceResult.data || null);

      const mergedOben: Record<number, number> = { ...localPricesByOmie };
      if (priceOben.data?.precos) {
        for (const [k, v] of Object.entries(priceOben.data.precos as Record<string, number>)) {
          if (v && v > 0) mergedOben[Number(k)] = v;
        }
      }
      setCustomerPricesOben(mergedOben);

      const mergedColacor: Record<number, number> = { ...localPricesByOmie };
      if (priceColacor.data?.precos) {
        for (const [k, v] of Object.entries(priceColacor.data.precos as Record<string, number>)) {
          if (v && v > 0) mergedColacor[Number(k)] = v;
        }
      }
      setCustomerPricesColacor(mergedColacor);

      if (parcelaOben.data?.ultima_parcela) setSelectedParcelaOben(parcelaOben.data.ultima_parcela);
      if (parcelaOben.data?.parcela_ranking) setCustomerParcelaRankingOben(parcelaOben.data.parcela_ranking.map((r: any) => r.codigo));
      if (parcelaColacor.data?.ultima_parcela) setSelectedParcelaColacor(parcelaColacor.data.ultima_parcela);
      if (parcelaColacor.data?.parcela_ranking) setCustomerParcelaRankingColacor(parcelaColacor.data.parcela_ranking.map((r: any) => r.codigo));
    } catch (error: any) {
      toast({ title: 'Erro', description: error.message, variant: 'destructive' });
    } finally {
      setLoadingCustomer(false);
    }

    if (cust.cnpj_cpf) {
      setValidatingVendedor(true);
      try {
        const { data: validacao, error } = await supabase.functions.invoke('omie-cliente', {
          body: { action: 'validar_vendedor', cnpj_cpf: cust.cnpj_cpf },
        });
        if (!error && validacao && !validacao.consistente) {
          setVendedorDivergencias(validacao.divergencias || []);
        }
      } catch (err) {
        console.error('Erro ao validar vendedor:', err);
      } finally {
        setValidatingVendedor(false);
      }
    }
  }, [
    resolveLocalUserId, autoCreateInMissingAccounts, resolveLocalPricesByOmieCode,
    loadLocalPurchaseHistory, loadOmiePurchaseHistory,
    onLocalUserResolved, reloadPriceHistory, toast,
  ]);

  const clearCustomer = useCallback(() => {
    setSelectedCustomer(null);
    setCustomerUserId(null);
    setCustomerPricesOben({});
    setCustomerPricesColacor({});
    setSelectedParcelaOben('999');
    setSelectedParcelaColacor('999');
    setCustomerParcelaRankingOben([]);
    setCustomerParcelaRankingColacor([]);
    setVendedorDivergencias([]);
    setSelectedAddress('');
    setCustomerPurchaseHistory({});
    setRequiresPo(false);
    // Limpa o cache de endereços e ferramentas do cliente anterior
    queryClient.removeQueries({ queryKey: ['customer-addresses'] });
    queryClient.removeQueries({ queryKey: ['user-tools'] });
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
    // Parcelas
    selectedParcelaOben, setSelectedParcelaOben,
    selectedParcelaColacor, setSelectedParcelaColacor,
    customerParcelaRankingOben,
    customerParcelaRankingColacor,
    // Addresses (lista vem do useQuery; selectedAddress permanece como state)
    addresses,
    selectedAddress, setSelectedAddress,
    // History
    customerPurchaseHistory, setCustomerPurchaseHistory,
    // Vendedor
    vendedorDivergencias, validatingVendedor,
    // Actions
    selectCustomer, clearCustomer,
  };
}
