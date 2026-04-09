import { useState, useMemo } from 'react';
import { addDays } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Printer, CalendarIcon, Sun, Sunset, ArrowLeft, Building2 } from 'lucide-react';
import { format, startOfDay, endOfDay } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { openPrintOrder, type PrintOrderData } from '@/components/OrderPrintLayout';

type CompanyFilter = 'oben' | 'colacor' | 'afiacao';

const COMPANY_LABELS: Record<CompanyFilter, string> = {
  oben: 'Oben',
  colacor: 'Colacor',
  afiacao: 'Afiação',
};

const COMPANY_COLORS: Record<CompanyFilter, string> = {
  oben: 'bg-blue-100 text-blue-800 border-blue-300',
  colacor: 'bg-rose-100 text-rose-800 border-rose-300',
  afiacao: 'bg-amber-100 text-amber-800 border-amber-300',
};

interface SalesOrderRow {
  id: string;
  customer_user_id: string;
  items: any[];
  subtotal: number;
  total: number;
  desconto?: number;
  frete?: number;
  status: string;
  omie_numero_pedido: string | null;
  created_at: string;
  notes: string | null;
  account?: string;
  customer_name?: string;
  customer_document?: string;
  customer_phone?: string;
  customer_address?: string;
  vendedor_name?: string;
  cond_pagamento?: string;
}

function getPeriod(dateStr: string): 'manha' | 'tarde' {
  const h = new Date(dateStr).getHours();
  return h < 12 ? 'manha' : 'tarde';
}

function buildPrintData(order: SalesOrderRow, company: CompanyFilter): PrintOrderData {
  const isOben = company === 'oben';
  const companyMap: Record<CompanyFilter, { name: string; cnpj: string; phone: string; address: string }> = {
    oben: {
      name: 'OBEN COMÉRCIO LTDA',
      cnpj: '51.027.034/0001-00',
      phone: '(37) 9987-8190',
      address: 'Av. Primeiro de Junho, 70 – Centro, Divinópolis/MG – CEP: 35.500-002',
    },
    colacor: {
      name: 'COLACOR COMERCIAL LTDA',
      cnpj: '15.422.799/0001-81',
      phone: '(37) 3222-1035',
      address: 'Av. Primeiro de Junho, 48 – Centro, Divinópolis/MG – CEP: 35.500-002',
    },
    afiacao: {
      name: 'COLACOR S.C LTDA',
      cnpj: '55.555.305/0001-51',
      phone: '(37) 9987-8190',
      address: 'Av. Primeiro de Junho, 50 – Centro, Divinópolis/MG – CEP: 35.500-002',
    },
  };

  const c = companyMap[company];

  // Extract parcelaCode from omie_payload
  const payload = (order as any).omie_payload;
  const parcelaCode = payload?.cabecalho?.codigo_parcela || undefined;

  return {
    companyName: c.name,
    companyCnpj: c.cnpj,
    companyPhone: c.phone,
    companyAddress: c.address,
    orderNumber: order.omie_numero_pedido || order.id.slice(0, 8).toUpperCase(),
    date: format(new Date(order.created_at), "dd/MM/yyyy HH:mm", { locale: ptBR }),
    customerName: order.customer_name || 'Cliente',
    customerDocument: order.customer_document || '',
    customerPhone: order.customer_phone,
    customerAddress: order.customer_address,
    vendedorName: order.vendedor_name,
    condPagamento: order.cond_pagamento,
    parcelaCode,
    items: (order.items || []).map((it: any) => ({
      codigo: it.codigo || it.omie_codigo || '-',
      descricao: it.descricao || it.nome || '',
      quantidade: it.quantidade || 1,
      unidade: it.unidade || 'UN',
      valorUnitario: it.valor_unitario || 0,
      valorTotal: it.valor_total || 0,
      tintCorId: it.tint_cor_id,
      tintNomeCor: it.tint_nome_cor,
    })),
    subtotal: order.subtotal || 0,
    desconto: (order as any).desconto || 0,
    frete: (order as any).frete || 0,
    total: order.total || 0,
    observacoes: order.notes || undefined,
    isOben: isOben,
  };
}

const SalesPrintDashboard = () => {
  const navigate = useNavigate();
  const { isStaff } = useAuth();
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [selectedCompanies, setSelectedCompanies] = useState<CompanyFilter[]>(['oben', 'colacor', 'afiacao']);
  const [selectedPeriod, setSelectedPeriod] = useState<'all' | 'manha' | 'tarde'>('all');
  const [selectedOrders, setSelectedOrders] = useState<Set<string>>(new Set());

  const dayStart = startOfDay(selectedDate).toISOString();
  const dayEnd = endOfDay(selectedDate).toISOString();

  // Fetch sales_orders for the selected date
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
      return (data || []).map((o: any) => ({
        ...o,
        account: 'afiacao',
        subtotal: o.total || 0,
      })) as SalesOrderRow[];
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
      if ((o as any).user_id) ids.add((o as any).user_id);
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

  // Fetch customer addresses
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

  const profileMap = useMemo(() => {
    const m = new Map<string, any>();
    profiles.forEach(p => m.set(p.user_id, p));
    return m;
  }, [profiles]);

  const addressMap = useMemo(() => {
    const m = new Map<string, any>();
    customerAddresses.forEach(a => {
      // Keep the first (default or first found) per user
      if (!m.has(a.user_id)) m.set(a.user_id, a);
    });
    return m;
  }, [customerAddresses]);

  // Enriched and filtered orders
  const filteredOrders = useMemo(() => {
    return allOrdersRaw
      .filter(o => selectedCompanies.includes(o._company))
      .filter(o => {
        if (selectedPeriod === 'all') return true;
        return getPeriod(o.created_at) === selectedPeriod;
      })
      .map(o => {
        const custId = o.customer_user_id || (o as any).user_id;
        const profile = profileMap.get(custId);
        const addr = addressMap.get(custId);
        const fullAddress = (o as any).customer_address || (addr
          ? `${addr.street}, ${addr.number}${addr.complement ? ' - ' + addr.complement : ''} – ${addr.neighborhood}, ${addr.city}/${addr.state} – CEP: ${addr.zip_code}`
          : '');

        // Extract cond_pagamento from omie_payload if not set directly
        const payload = (o as any).omie_payload;
        const condPagamento = (o as any).cond_pagamento
          || payload?.cabecalho?.codigo_parcela
          || undefined;

        return {
          ...o,
          customer_name: (o as any).customer_name || profile?.name || 'Cliente',
          customer_document: (o as any).customer_document || profile?.document || '',
          customer_phone: (o as any).customer_phone || profile?.phone || '',
          customer_address: fullAddress,
          cond_pagamento: condPagamento,
        };
      });
  }, [allOrdersRaw, selectedCompanies, selectedPeriod, profileMap, addressMap]);

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
      const printData = buildPrintData(o, o._company);
      return buildSingleOrderHtml(printData);
    });

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Impressão de Pedidos - ${format(selectedDate, 'dd/MM/yyyy')}</title>
<style>
  @media print { @page { margin: 1.5cm; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .page-break { page-break-after: always; } }
  body { font-family: Helvetica, Arial, sans-serif; color: #1a1a1a; margin: 0; padding: 20px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; border-bottom: 1px solid #ccc; padding-bottom: 12px; }
  .company-name { font-size: 22px; font-weight: bold; }
  .company-info { font-size: 10px; color: #666; margin-top: 2px; }
  .order-box { background: #e91e63; color: white; border-radius: 4px; padding: 8px 20px; text-align: center; }
  .order-box .label { font-size: 9px; }
  .order-box .number { font-size: 18px; font-weight: bold; }
  .order-box .date { font-size: 9px; }
  .section-title { font-size: 11px; font-weight: bold; color: #e91e63; margin: 14px 0 6px; }
  .customer-name { font-size: 14px; font-weight: bold; }
  .customer-info { font-size: 11px; color: #333; margin-top: 2px; }
  .right-info { font-size: 11px; color: #666; text-align: right; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #2d2d2d; color: white; padding: 6px 4px; font-size: 10px; text-align: left; }
  .totals { display: flex; flex-direction: column; align-items: flex-end; margin-top: 12px; }
  .totals .row { display: flex; gap: 30px; font-size: 12px; padding: 3px 0; }
  .totals .total-row { border-top: 2px solid #2d2d2d; font-size: 15px; font-weight: bold; padding-top: 6px; margin-top: 4px; }
  .obs-box { background: #fafafa; border: 1px solid #ccc; border-radius: 2px; padding: 10px; font-size: 10px; white-space: pre-wrap; line-height: 1.5; }
  .footer { text-align: center; font-size: 8px; color: #999; margin-top: 30px; }
</style></head><body>
${allPages.join('\n<div class="page-break"></div>\n')}
<script>window.onload = function() { window.print(); }</script>
</body></html>`;

    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(html);
      printWindow.document.close();
    }
  };

  const printSingle = (order: typeof filteredOrders[0]) => {
    openPrintOrder(buildPrintData(order, order._company));
  };

  const isLoading = loadingSales || loadingAfiacao;

  const renderOrderGroup = (company: CompanyFilter, period: 'manha' | 'tarde', orders: typeof filteredOrders) => {
    if (orders.length === 0) return null;
    const periodLabel = period === 'manha' ? 'Manhã' : 'Tarde';
    const PeriodIcon = period === 'manha' ? Sun : Sunset;

    return (
      <div key={`${company}-${period}`} className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <PeriodIcon className="h-4 w-4" />
          <span>{periodLabel}</span>
          <Badge variant="secondary" className="text-xs">{orders.length}</Badge>
        </div>
        <div className="space-y-1.5">
          {orders.map(order => (
            <div
              key={order.id}
              className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors cursor-pointer"
              onClick={() => toggleOrder(order.id)}
            >
              <Checkbox
                checked={selectedOrders.has(order.id)}
                onCheckedChange={() => toggleOrder(order.id)}
                onClick={e => e.stopPropagation()}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium">
                    {order.omie_numero_pedido ? `#${order.omie_numero_pedido}` : order.id.slice(0, 8).toUpperCase()}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {format(new Date(order.created_at), 'HH:mm')}
                  </span>
                </div>
                <div className="text-sm text-muted-foreground truncate">{order.customer_name}</div>
              </div>
              <div className="text-right">
                <div className="text-sm font-medium">
                  {order.total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                </div>
                <div className="text-xs text-muted-foreground">{(order.items || []).length} itens</div>
              </div>
              <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={e => { e.stopPropagation(); printSingle(order); }}>
                <Printer className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-background pb-20">
      <Header />
      <main className="container max-w-4xl mx-auto px-4 py-6 space-y-6">
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
        <Card>
          <CardContent className="pt-4 space-y-4">
            {/* Date picker */}
            <div className="flex items-center gap-3 flex-wrap">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-[200px] justify-start text-left font-normal")}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {format(selectedDate, "dd 'de' MMMM, yyyy", { locale: ptBR })}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={selectedDate}
                    onSelect={d => d && setSelectedDate(d)}
                    initialFocus
                    className="p-3 pointer-events-auto"
                    locale={ptBR}
                  />
                </PopoverContent>
              </Popover>

              {/* Period filter */}
              <Tabs value={selectedPeriod} onValueChange={v => setSelectedPeriod(v as any)}>
                <TabsList>
                  <TabsTrigger value="all">Todos</TabsTrigger>
                  <TabsTrigger value="manha" className="gap-1"><Sun className="h-3 w-3" />Manhã</TabsTrigger>
                  <TabsTrigger value="tarde" className="gap-1"><Sunset className="h-3 w-3" />Tarde</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {/* Company toggles */}
            <div className="flex items-center gap-2 flex-wrap">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              {(['oben', 'colacor', 'afiacao'] as CompanyFilter[]).map(c => (
                <Badge
                  key={c}
                  variant="outline"
                  className={cn(
                    'cursor-pointer transition-all',
                    selectedCompanies.includes(c) ? COMPANY_COLORS[c] : 'opacity-40'
                  )}
                  onClick={() => toggleCompany(c)}
                >
                  {COMPANY_LABELS[c]}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>

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
          <div className="flex justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
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
                  {renderOrderGroup(company, 'manha', grouped[company].manha)}
                  {renderOrderGroup(company, 'tarde', grouped[company].tarde)}
                </CardContent>
              </Card>
            );
          })
        )}
      </main>
      <BottomNav />
    </div>
  );
};

// Build HTML for a single order page (without <html>/<body> wrappers)
function buildSingleOrderHtml(data: PrintOrderData): string {
  const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  // Build installment dates
  const parseParcelaDays = (codeOrDesc?: string): number[] => {
    if (!codeOrDesc) return [];
    const clean = codeOrDesc.trim();
    if (clean === '000' || clean === '999' || /vista/i.test(clean)) return [];
    const matches = clean.match(/\b(\d{1,3})\b/g);
    if (!matches) return [];
    return matches.map(s => parseInt(s, 10)).filter(n => n > 0 && n <= 365);
  };

  let days = parseParcelaDays(data.condPagamento);
  if (days.length === 0) days = parseParcelaDays(data.parcelaCode);
  let installmentText = '';
  if (days.length > 0) {
    const today = new Date();
    const parcValue = data.total && days.length > 0 ? data.total / days.length : 0;
    installmentText = days.map((d, i) => {
      const dueDate = addDays(today, d);
      const dateStr = `${String(dueDate.getDate()).padStart(2, '0')}/${String(dueDate.getMonth() + 1).padStart(2, '0')}/${dueDate.getFullYear()}`;
      const valStr = parcValue > 0 ? ` – ${fmt(parcValue)}` : '';
      return `${i + 1}ª parcela: ${dateStr}${valStr}`;
    }).join(' | ');
  }

  const itemsRows = data.items.map((item, i) => {
    const descLines = [item.descricao];
    if (item.tintCorId && item.tintNomeCor) {
      const corParts = item.tintNomeCor.split(' - ');
      const simplified = corParts.length > 2 ? corParts.slice(0, -1).join(' - ') : item.tintNomeCor;
      const embMatch = item.descricao.match(/\b(QT|GL|LT|BD|BH|5L)\b/i);
      const embalagem = embMatch ? embMatch[1].toUpperCase() : '';
      descLines.push(`Cor: ${item.tintCorId} - ${simplified}${embalagem ? ' - ' + embalagem : ''}`);
    }
    return `<tr style="background:${i % 2 === 1 ? '#f5f5f5' : '#fff'}">
      <td style="padding:6px 4px;border:1px solid #ddd;text-align:center;font-size:11px">${i + 1}</td>
      <td style="padding:6px 4px;border:1px solid #ddd;font-size:11px">${item.codigo}</td>
      <td style="padding:6px 4px;border:1px solid #ddd;font-size:11px">${descLines.join('<br/>')}</td>
      <td style="padding:6px 4px;border:1px solid #ddd;text-align:center;font-size:11px">${item.quantidade}</td>
      <td style="padding:6px 4px;border:1px solid #ddd;text-align:center;font-size:11px">${item.unidade}</td>
      <td style="padding:6px 4px;border:1px solid #ddd;text-align:right;font-size:11px">${fmt(item.valorUnitario)}</td>
      <td style="padding:6px 4px;border:1px solid #ddd;text-align:right;font-size:11px">${fmt(item.valorTotal)}</td>
    </tr>`;
  }).join('');

  const cnpjsComDesconto = ['03.422.099/0001-08', '07.311.465/0001-02', '24.521.946/0001-61'];
  const showDesconto = data.desconto > 0 && cnpjsComDesconto.includes(data.customerDocument || '');

  const obs = data.isOben
    ? 'RECIBO DE ENTREGA DE VENDA NÃO PRESENCIAL E-PTA-RE Nº: 45.000035717-51 / OBEN COMÉRCIO LTDA. TRANSPORTADORA: Transporte próprio: Oben Comercio Declaro que recebi as mercadorias constantes dessa Nota Fiscal, e que as mercadorias se destinam a uso e consumo, e que estão em perfeito estado e conferem com pedido feito no âmbito do comércio de telemarketing ou eletrônico e que foram recebidas no local por mim no local indicado acima.\n\nCPF/CNPJ:___________________________________ DATA DA ENTREGA:___/___/____\n\nNome/ASSINATURA:_________________________________________________' + (data.observacoes ? '\n\n' + data.observacoes : '')
    : data.observacoes || '';

  return `<div>
<div class="header">
  <div>
    <div class="company-name">${data.companyName}</div>
    <div class="company-info">CNPJ: ${data.companyCnpj} • Tel: ${data.companyPhone}</div>
    <div class="company-info">${data.companyAddress}</div>
  </div>
  <div class="order-box">
    <div class="label">PEDIDO DE VENDA</div>
    <div class="number">Nº ${data.orderNumber}</div>
    <div class="date">${data.date}</div>
  </div>
</div>
<div class="section-title">DADOS DO CLIENTE</div>
<div style="display:flex;justify-content:space-between">
  <div>
    <div class="customer-name">${data.customerName}</div>
    <div class="customer-info">CPF/CNPJ: ${data.customerDocument || 'N/A'}${data.customerPhone ? ' • Tel: ' + data.customerPhone : ''}</div>
    ${data.customerAddress ? `<div class="customer-info">${data.customerAddress}</div>` : ''}
  </div>
  <div class="right-info">
    ${data.vendedorName ? `Vendedor: ${data.vendedorName}<br/>` : ''}
    ${data.condPagamento ? `Cond. Pgto: ${data.condPagamento}` : ''}
  </div>
</div>
<div class="section-title">ITENS DO PEDIDO</div>
<table><thead><tr>
  <th style="width:30px;text-align:center">#</th>
  <th style="width:70px">Código</th>
  <th>Descrição</th>
  <th style="width:40px;text-align:center">Qtd</th>
  <th style="width:35px;text-align:center">Un</th>
  <th style="width:80px;text-align:right">Vlr Unit.</th>
  <th style="width:80px;text-align:right">Vlr Total</th>
</tr></thead><tbody>${itemsRows}</tbody></table>
<div class="totals">
  <div class="row"><span>Subtotal:</span><span>${fmt(data.subtotal)}</span></div>
  ${showDesconto ? `<div class="row"><span>Desconto:</span><span>- ${fmt(data.desconto)}</span></div>` : ''}
  
  <div class="row total-row"><span>TOTAL:</span><span>${fmt(data.total)}</span></div>
</div>
${obs ? `<div class="section-title">OBSERVAÇÕES</div><div class="obs-box">${obs.replace(/\n/g, '<br/>')}</div>` : ''}
<div class="footer">Documento gerado automaticamente pelo sistema • ${data.date}</div>
</div>`;
}

export default SalesPrintDashboard;
