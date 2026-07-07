import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { Printer, ArrowLeft } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { format } from 'date-fns';
import { janelaQueryDiaCivil, pedidoNoDiaCivil } from '@/lib/pedido/dia-civil';
import { openPrintOrder } from '@/components/OrderPrintLayout';
import {
  COMPANY_LABELS, COMPANY_COLORS, getPeriod,
  type CompanyFilter, type SalesOrderRow, type ProfileLite, type AddressLite,
  type FormaPagamento, type EnrichedOrder,
} from '@/components/sales/print/types';
import { buildPrintData, buildSingleOrderHtml, buildPrintDocument } from '@/components/sales/print/buildPrintHtml';
import { PrintFilters } from '@/components/sales/print/PrintFilters';
import { OrderGroup } from '@/components/sales/print/OrderGroup';

const SalesPrintDashboard = () => {
  const navigate = useNavigate();
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [selectedCompanies, setSelectedCompanies] = useState<CompanyFilter[]>(['oben', 'colacor', 'afiacao']);
  const [selectedPeriod, setSelectedPeriod] = useState<'all' | 'manha' | 'tarde'>('all');
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());

  // Janela de query = união do dia local (pedidos do wizard) com o dia UTC (pedidos do
  // sync Omie, created_at data-pura à meia-noite UTC). Mais larga que o dia exibido —
  // o pertencimento real é re-decidido em filteredOrders via pedidoNoDiaCivil.
  const { inicioIso: dayStart, fimIso: dayEnd } = janelaQueryDiaCivil(selectedDate);

  // Fetch company logos from Omie
  const { data: companyLogos = {} } = useQuery({
    queryKey: ['sales-print-company-logos'],
    queryFn: async () => {
      try {
        const { data } = await supabase.functions.invoke('omie-cliente', {
          body: { action: 'buscar_logos_empresas' },
        });
        return (data?.logos || {}) as Record<string, string | null>;
      } catch (_) { return {}; }
    },
    staleTime: 1000 * 60 * 60 * 24, // cache 24h
  });

  // Fetch sales_orders for the selected date
  // Fetch payment terms map (code -> description)
  const { data: formasMap = {} } = useQuery({
    queryKey: ['sales-print-formas-pagamento'],
    queryFn: async () => {
      const result: Record<string, string> = {};
      for (const acc of ['oben', 'colacor'] as const) {
        try {
          const { data } = await supabase.functions.invoke('omie-vendas-sync', {
            body: { action: 'listar_formas_pagamento', account: acc },
          });
          const formas = (data?.formas ?? []) as FormaPagamento[];
          formas.forEach((f) => { result[f.codigo] = f.descricao; });
        } catch (_) { /* ignore */ }
      }
      return result;
    },
    staleTime: 1000 * 60 * 30, // cache 30 min
  });

  const { data: salesOrders = [], isLoading: loadingSales } = useQuery({
    queryKey: ['sales-print', 'sales', dayStart],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('sales_orders')
        .select('*')
        .gte('created_at', dayStart)
        .lte('created_at', dayEnd)
        .neq('status', 'cancelado')
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data || []) as SalesOrderRow[];
    },
  });

  // Fetch afiação orders for the selected date
  const { data: afiacaoOrders = [], isLoading: loadingAfiacao } = useQuery({
    queryKey: ['sales-print', 'afiacao', dayStart],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .gte('created_at', dayStart)
        .lte('created_at', dayEnd)
        .neq('status', 'cancelado')
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data || []).map((o) => {
        const row = o as unknown as SalesOrderRow;
        return {
          ...row,
          account: 'afiacao',
          subtotal: row.total || 0,
        };
      }) as SalesOrderRow[];
    },
  });

  // Enrich orders with customer profile data
  const allOrdersRaw = useMemo(() => {
    const sales = salesOrders.map(o => ({
      ...o,
      _company: (o.account === 'colacor' ? 'colacor' : 'oben') as CompanyFilter,
    }));
    const afiacao = afiacaoOrders.map(o => ({
      ...o,
      _company: 'afiacao' as CompanyFilter,
    }));
    return [...sales, ...afiacao];
  }, [salesOrders, afiacaoOrders]);

  // Fetch customer profiles
  const customerIds = useMemo(() => {
    const ids = new Set<string>();
    allOrdersRaw.forEach(o => {
      if (o.customer_user_id) ids.add(o.customer_user_id);
      if (o.user_id) ids.add(o.user_id);
    });
    return [...ids];
  }, [allOrdersRaw]);

  const { data: profiles = [] } = useQuery({
    queryKey: ['sales-print-profiles', customerIds],
    queryFn: async () => {
      if (customerIds.length === 0) return [];
      const { data } = await supabase
        .from('profiles')
        .select('user_id, name, document, phone')
        .in('user_id', customerIds);
      return data || [];
    },
    enabled: customerIds.length > 0,
  });

  // Fetch customer addresses from local table
  const { data: customerAddresses = [] } = useQuery({
    queryKey: ['sales-print-addresses', customerIds],
    queryFn: async () => {
      if (customerIds.length === 0) return [];
      const { data } = await supabase
        .from('addresses')
        .select('user_id, street, number, complement, neighborhood, city, state, zip_code, is_default')
        .in('user_id', customerIds)
        .order('is_default', { ascending: false });
      return data || [];
    },
    enabled: customerIds.length > 0,
  });

  // Fetch omie_clientes mappings to get omie_codigo_cliente for address lookup
  const { data: omieClientes = [] } = useQuery({
    queryKey: ['sales-print-omie-clientes', customerIds],
    queryFn: async () => {
      if (customerIds.length === 0) return [];
      // P0-B follow-up: filtra a conta do espelho ('colacor' = colacor_sc físico) — o código é usado
      // p/ consultar endereço via `omie-cliente` (que bate na conta colacor_sc). Pós-constraint
      // composta, evita pegar o código de outra conta do user. Hoje inócuo (UNIQUE(user_id)).
      const { data } = await supabase
        .from('omie_clientes')
        .select('user_id, omie_codigo_cliente')
        .eq('empresa_omie', 'colacor')
        .in('user_id', customerIds);
      return data || [];
    },
    enabled: customerIds.length > 0,
  });

  const profileMap = useMemo(() => {
    const m = new Map<string, ProfileLite>();
    (profiles as ProfileLite[]).forEach(p => m.set(p.user_id, p));
    return m;
  }, [profiles]);

  const localAddressMap = useMemo(() => {
    const m = new Map<string, AddressLite>();
    (customerAddresses as AddressLite[]).forEach(a => {
      if (!m.has(a.user_id)) m.set(a.user_id, a);
    });
    return m;
  }, [customerAddresses]);

  // For customers without local addresses, fetch from Omie
  const customersMissingAddress = useMemo(() => {
    return customerIds.filter(id => !localAddressMap.has(id));
  }, [customerIds, localAddressMap]);

  // Build omie codigo_cliente map from omie_clientes table + order payloads as fallback
  const omieClienteMap = useMemo(() => {
    const m = new Map<string, number>();
    omieClientes.forEach(oc => m.set(oc.user_id, oc.omie_codigo_cliente));
    // Fallback: extract codigo_cliente from order payloads for customers not in omie_clientes
    allOrdersRaw.forEach(o => {
      const custId = o.customer_user_id || o.user_id;
      if (custId && !m.has(custId)) {
        const cc = o.omie_payload?.cabecalho?.codigo_cliente;
        if (cc) m.set(custId, cc);
      }
    });
    return m;
  }, [omieClientes, allOrdersRaw]);

  // Fetch addresses from Omie for ALL customers missing local address
  const { data: omieAddresses = {} } = useQuery({
    queryKey: ['sales-print-omie-addresses', customersMissingAddress, Array.from(omieClienteMap.entries())],
    queryFn: async () => {
      const result: Record<string, string> = {};
      for (const userId of customersMissingAddress) {
        let codigoCliente = omieClienteMap.get(userId);

        // If no codigo_cliente, try searching by document (CNPJ/CPF)
        if (!codigoCliente) {
          const profile = profileMap.get(userId);
          const doc = profile?.document;
          if (doc) {
            try {
              const { data } = await supabase.functions.invoke('omie-cliente', {
                body: { action: 'buscar_por_documento', documento: doc },
              });
              const cc = data?.cliente?.codigo_cliente_omie;
              if (cc) codigoCliente = cc;
            } catch (_) { /* ignore */ }
          }
        }

        if (!codigoCliente) continue;
        try {
          const { data } = await supabase.functions.invoke('omie-cliente', {
            body: { action: 'consultar_cliente', codigo_cliente: codigoCliente },
          });
          if (data?.cliente) {
            const c = data.cliente;
            const parts = [
              c.endereco,
              c.endereco_numero ? `nº ${c.endereco_numero}` : '',
              c.complemento,
              c.bairro ? `– ${c.bairro}` : '',
              c.cidade && c.estado ? `${c.cidade}/${c.estado}` : '',
              c.cep ? `CEP: ${c.cep}` : '',
            ].filter(Boolean);
            result[userId] = parts.join(', ');
          }
        } catch (e) {
          console.warn('Failed to fetch Omie address for', userId, e);
        }
      }
      return result;
    },
    enabled: customersMissingAddress.length > 0,
  });

  const addressMap = useMemo(() => {
    const m = new Map<string, string>();
    // First, local addresses
    (customerAddresses as AddressLite[]).forEach(a => {
      if (!m.has(a.user_id)) {
        m.set(a.user_id, `${a.street}, ${a.number}${a.complement ? ' - ' + a.complement : ''} – ${a.neighborhood}, ${a.city}/${a.state} – CEP: ${a.zip_code}`);
      }
    });
    // Then, Omie addresses for those missing locally
    for (const [userId, addr] of Object.entries(omieAddresses)) {
      if (!m.has(userId) && addr) m.set(userId, addr);
    }
    return m;
  }, [customerAddresses, omieAddresses]);

  // Enriched and filtered orders
  const filteredOrders = useMemo(() => {
    return allOrdersRaw
      // A janela de query é a união dos dois regimes (pega pedidos de dias vizinhos
      // na borda) — aqui cada pedido é atribuído ao SEU dia civil, sem duplicação.
      .filter(o => pedidoNoDiaCivil(o.created_at, selectedDate))
      .filter(o => selectedCompanies.includes(o._company))
      .filter(o => {
        if (selectedPeriod === 'all') return true;
        return getPeriod(o.created_at) === selectedPeriod;
      })
      .map(o => {
        const custId = o.customer_user_id || o.user_id || '';
        const profile = profileMap.get(custId);
        const addr = addressMap.get(custId);
        const fullAddress = o.customer_address || addr || '';

        // Extract cond_pagamento description from formas map
        const parcelaCode = o.omie_payload?.cabecalho?.codigo_parcela;
        const condPagamento = o.cond_pagamento
          || (parcelaCode && formasMap[parcelaCode])
          || parcelaCode
          || undefined;

        return {
          ...o,
          customer_name: o.customer_name || profile?.name || 'Cliente',
          customer_document: o.customer_document || profile?.document || '',
          customer_phone: o.customer_phone || profile?.phone || '',
          customer_address: fullAddress,
          cond_pagamento: condPagamento,
        };
      });
  }, [allOrdersRaw, selectedDate, selectedCompanies, selectedPeriod, profileMap, addressMap, formasMap]);

  // Group by company then period
  const grouped = useMemo(() => {
    const result: Record<CompanyFilter, { manha: typeof filteredOrders; tarde: typeof filteredOrders }> = {
      oben: { manha: [], tarde: [] },
      colacor: { manha: [], tarde: [] },
      afiacao: { manha: [], tarde: [] },
    };
    filteredOrders.forEach(o => {
      const period = getPeriod(o.created_at);
      result[o._company][period].push(o);
    });
    return result;
  }, [filteredOrders]);

  const toggleCompany = (c: CompanyFilter) => {
    setSelectedCompanies(prev =>
      prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]
    );
  };

  const toggleOrder = (id: string) => {
    setSelectedOrders(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedOrders.size === filteredOrders.length) {
      setSelectedOrders(new Set());
    } else {
      setSelectedOrders(new Set(filteredOrders.map(o => o.id)));
    }
  };

  const printSelected = () => {
    const toPrint = filteredOrders.filter(o => selectedOrders.has(o.id));
    if (toPrint.length === 0) return;

    // Build combined HTML for all selected orders
    const allPages = toPrint.map(o => {
      const printData = buildPrintData(o, o._company, companyLogos);
      return buildSingleOrderHtml(printData);
    });

    const html = buildPrintDocument(allPages, format(selectedDate, 'dd/MM/yyyy'));

    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(html);
      printWindow.document.close();
    }
  };

  const printSingle = (order: EnrichedOrder) => {
    openPrintOrder(buildPrintData(order, order._company, companyLogos));
  };

  const isLoading = loadingSales || loadingAfiacao;

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-6">
      <main className="space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/sales')}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-xl font-bold">Impressão de Pedidos</h1>
            <p className="text-sm text-muted-foreground">Selecione a data e empresa para imprimir</p>
          </div>
        </div>

        {/* Filters */}
        <PrintFilters
          selectedDate={selectedDate}
          setSelectedDate={setSelectedDate}
          selectedPeriod={selectedPeriod}
          setSelectedPeriod={setSelectedPeriod}
          selectedCompanies={selectedCompanies}
          toggleCompany={toggleCompany}
        />

        {/* Actions bar */}
        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" onClick={selectAll}>
            {selectedOrders.size === filteredOrders.length && filteredOrders.length > 0 ? 'Desmarcar todos' : 'Selecionar todos'}
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{selectedOrders.size} selecionado(s)</span>
            <Button onClick={printSelected} disabled={selectedOrders.size === 0} className="gap-2">
              <Printer className="h-4 w-4" />
              Imprimir selecionados
            </Button>
          </div>
        </div>

        {/* Orders grouped by company + period */}
        {isLoading ? (
          <PageSkeleton variant="list" />
        ) : filteredOrders.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              Nenhum pedido encontrado para esta data e filtros.
            </CardContent>
          </Card>
        ) : (
          selectedCompanies.map(company => {
            const companyOrders = [...grouped[company].manha, ...grouped[company].tarde];
            if (companyOrders.length === 0) return null;
            return (
              <Card key={company}>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Badge variant="outline" className={COMPANY_COLORS[company]}>{COMPANY_LABELS[company]}</Badge>
                    <span className="text-muted-foreground text-sm font-normal">{companyOrders.length} pedido(s)</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <OrderGroup company={company} period="manha" orders={grouped[company].manha} selectedOrders={selectedOrders} onToggleOrder={toggleOrder} onPrintSingle={printSingle} />
                  <OrderGroup company={company} period="tarde" orders={grouped[company].tarde} selectedOrders={selectedOrders} onToggleOrder={toggleOrder} onPrintSingle={printSingle} />
                </CardContent>
              </Card>
            );
          })
        )}
      </main>
    </div>
  );
};

export default SalesPrintDashboard;
