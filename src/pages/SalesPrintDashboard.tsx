import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { lerContatoOperacional, type ContatoOperacional } from '@/lib/contato-cliente';
import { STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';
import { useQuery } from '@tanstack/react-query';
import { Printer, ArrowLeft } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { format } from 'date-fns';
import { janelaQueryDiaCivil, pedidoNoDiaCivil } from '@/lib/pedido/dia-civil';
import { openPrintOrder } from '@/components/OrderPrintLayout';
import {
  COMPANY_LABELS, COMPANY_COLORS, getPeriod,
  type CompanyFilter, type SalesOrderRow, type ProfileLite, type AddressLite,
  type EnrichedOrder, itemDaOsParaImpressao, itensOuIlegivel,
} from '@/components/sales/print/types';
import { omiePayloadDoJson } from '@/lib/pedido/itens-json';
import { lerRespostaFormas } from '@/services/orderSubmission/formasDegradacao';
import { AvisoFormasPagamento } from '@/components/sales/AvisoFormasPagamento';
import { buildPrintData, buildSingleOrderHtml, buildPrintDocument } from '@/components/sales/print/buildPrintHtml';
import { buscarDescontosItens } from '@/components/sales/print/buscarDescontosItens';
import { leituraDoPedido, mensagemAvisoDesconto, type LeituraDescontosItens } from '@/components/sales/print/descontoCupom';
import { PrintFilters } from '@/components/sales/print/PrintFilters';
import { OrderGroup } from '@/components/sales/print/OrderGroup';
import { toast } from 'sonner';
import { chaveParcela, descricaoDaParcela } from '@/components/sales/print/parcelas';
import { coletarEmLotesConcorrente, CONCORRENCIA_LOTES } from '@/lib/lotes';

// #36: `.in('user_id', ids)` com o dia inteiro de clientes estoura a URL do PostgREST (~8 KB) em dia cheio —
// a leitura falhava inteira. Mesmo lote de `IDS_POR_LOTE_EXCLUSAO` (useSalesOrders): 100 UUIDs ≈ 3,7 KB.
const IDS_POR_LOTE = 100;

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
  // O mapa código→descrição rotula a condição de pagamento na VIA IMPRESSA que vai ao
  // cliente. Sob degradação (edge #1597), as "formas" são 8 genéricas HARDCODED, não as
  // do Omie — usá-las aqui fabricaria um rótulo ("30/60 dias") para um código cuja
  // descrição real ninguém leu. Money-path §2, ausente ≠ zero: a conta degradada não entra
  // no mapa, o código cru aparece na via (dado bruto verdadeiro) e a tela avisa o porquê.
  const { data: formasPagamento, isError: formasFalharam, refetch: recarregarFormas } = useQuery({
    queryKey: ['sales-print-formas-pagamento'],
    queryFn: async () => {
      const mapa: Record<string, string> = {};
      const contasDegradadas: string[] = [];
      for (const acc of ['oben', 'colacor'] as const) {
        try {
          const { data } = await supabase.functions.invoke('omie-vendas-sync', {
            body: { action: 'listar_formas_pagamento', account: acc },
          });
          const estado = lerRespostaFormas(data);
          if (estado.degradado) { contasDegradadas.push(acc); continue; }
          // L2-c: chave POR CONTA — o código da Colacor não sobrescreve o da Oben.
          estado.formas.forEach((f) => { mapa[chaveParcela(acc, f.codigo)] = f.descricao; });
        } catch (_) { contasDegradadas.push(acc); }
      }
      return { mapa, contasDegradadas };
    },
    staleTime: 1000 * 60 * 30, // cache 30 min
  });
  // useMemo estabiliza a referência: `?? {}` criaria um objeto novo a cada render e
  // invalidaria o useMemo de `filteredOrders`, que tem `formasMap` nas deps.
  const formasMap = useMemo(() => formasPagamento?.mapa ?? {}, [formasPagamento]);
  // L2-d: a query que FALHOU (sem `data`) é as duas contas sem descrição — nunca "nenhuma degradada".
  const contasComFormasDegradadas = formasFalharam ? ['oben', 'colacor'] : (formasPagamento?.contasDegradadas ?? []);

  const { data: salesOrders = [], isLoading: loadingSales, error: erroSales, refetch: recarregarSales } = useQuery({
    queryKey: ['sales-print', 'sales', dayStart],
    queryFn: async () => {
      // Colunas explícitas (PR0.0-bis): omie_payload fechado à leitura de `authenticated` —
      // um `.select('*')` daria 42501 (o * inteiro cai).
      const { data, error } = await supabase
        .from('sales_orders')
        .select('id, customer_user_id, account, omie_numero_pedido, created_at, items, subtotal, total, discount, notes, status, order_date_kpi')
        .gte('created_at', dayStart)
        .lte('created_at', dayEnd)
        // Imprime o que foi VENDIDO no dia: o universo canônico. O `.neq('cancelado')` deixava
        // orçamento e rascunho saírem na folha, e o pedido apagado também.
        .not('status', 'in', STATUS_NAO_VENDA_POSTGREST)
        .is('deleted_at', null)
        .order('created_at', { ascending: true });
      if (error) throw error;
      // Snapshot de entrega do pedido pelo contexto OPERACIONAL (onda D): objeto = o pedido; a
      // leitura fora da carteira fica no ledger. Falha LANÇA — folha sem endereço não sai calada.
      const snap = await lerContatoOperacional('pedido', (data ?? []).map((r) => r.id), 'impressao_pedido');
      const rows: SalesOrderRow[] = (data ?? []).map((r) => ({
        ...r,
        ...itensOuIlegivel(r.items, `sales_orders ${r.id}`),
        // A coluna é `discount`; o cupom lê `desconto` — sem isto o desconto do cabeçalho sumia (Codex).
        desconto: r.discount ?? undefined,
        customer_document: snap.get(r.id)?.pedido_documento ?? undefined,
        customer_phone: snap.get(r.id)?.pedido_telefone ?? undefined,
        customer_address: snap.get(r.id)?.pedido_endereco ?? undefined,
      }));
      // A impressão lê cabecalho.codigo_parcela e cabecalho.codigo_cliente do payload —
      // recupera em LOTE pelo canal staff SECDEF e re-injeta em cada linha.
      const ids = rows.map((r) => r.id);
      if (ids.length === 0) return rows;
      const { data: pl, error: plErr } = await supabase.rpc('staff_get_sales_order_payload', { p_order_ids: ids });
      if (plErr) {
        // Degrada honestamente: impressão sem codigo_parcela/codigo_cliente, mas SINALIZA
        // (supabase.rpc RETORNA o erro, não lança). Uma regressão de gate/grant apareceria aqui.
        console.warn('[SalesPrintDashboard] payload staff indisponível (impressão sem parcela):', plErr);
        return rows;
      }
      const payloadMap = new Map(
        (pl ?? []).map((p) => [p.id, omiePayloadDoJson(p.omie_payload, `sales_orders ${p.id}`)]),
      );
      return rows.map((r) => ({ ...r, omie_payload: payloadMap.get(r.id) ?? undefined }));
    },
  });

  // Fetch afiação orders for the selected date
  const { data: afiacaoOrders = [], isLoading: loadingAfiacao, error: erroAfiacao, refetch: recarregarAfiacao } = useQuery({
    queryKey: ['sales-print', 'afiacao', dayStart],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('orders')
        // Onda D 4b-3: só o que a folha usa. O `*` trazia `orders.address` (rua da OS) para o navegador
        // ANTES do ledger; o endereço impresso da OS vem dos `enderecos` da `contato_cliente_operacional`
        // (ordem_servico/lista_os, abaixo), que registra a exceção fora da carteira.
        .select('id, user_id, created_at, items, total, notes, status')
        .gte('created_at', dayStart)
        .lte('created_at', dayEnd)
        .neq('status', 'cancelado')
        .order('created_at', { ascending: true });
      if (error) throw error;
      // `orders` (afiação) NÃO tem `customer_user_id` nem `omie_numero_pedido`: antes um cast a
      // vestia de `SalesOrderRow` e os dois chegavam `undefined`. O cliente é `user_id` (os
      // consumidores já liam `customer_user_id || user_id`).
      return (data || []).map((o): SalesOrderRow => {
        const lido = itensOuIlegivel(o.items, `orders ${o.id}`);
        return {
          ...o,
          customer_user_id: o.user_id,
          omie_numero_pedido: null,
          ...lido,
          items: lido.items.map(itemDaOsParaImpressao),
          account: 'afiacao',
          subtotal: o.total || 0,
        };
      });
    },
  });

  // Enrich orders with customer profile data
  // Empresa do cupom vem do pedido (revisão /sales #26): antes `colacor ? colacor : oben`, e qualquer
  // outra conta saía com o CNPJ da Oben. Conta que não é oben/colacor e pedido de itens ilegíveis
  // (#27) ficam FORA da folha — contados no aviso, nunca impressos como outra empresa ou vazios.
  // (`colacor_sc` em sales_orders: 0 linhas em 2026-11-27; aqui não vira 'afiacao' porque essa chave
  // também desliga a leitura do desconto de item, que é da venda.)
  const { allOrdersRaw, foraDaImpressao } = useMemo(() => {
    const fora: string[] = [];
    const sales: EnrichedOrder[] = [];
    // Só o dia civil escolhido entra no aviso — a janela da query inclui horas dos dias vizinhos (Codex).
    for (const o of salesOrders.filter((p) => pedidoNoDiaCivil(p.created_at, selectedDate))) {
      if (o.itensIlegiveis) fora.push(`${o.omie_numero_pedido ?? o.id.slice(0, 8)}: itens ilegíveis`);
      else if (o.account === 'oben' || o.account === 'colacor') sales.push({ ...o, _company: o.account });
      else fora.push(`${o.omie_numero_pedido ?? o.id.slice(0, 8)}: empresa não reconhecida (${o.account ?? 'vazia'})`);
    }
    const afiacao: EnrichedOrder[] = [];
    for (const o of afiacaoOrders.filter((p) => pedidoNoDiaCivil(p.created_at, selectedDate))) {
      if (o.itensIlegiveis) fora.push(`OS ${o.id.slice(0, 8)}: itens ilegíveis`);
      else afiacao.push({ ...o, _company: 'afiacao' });
    }
    return { allOrdersRaw: [...sales, ...afiacao], foraDaImpressao: fora };
  }, [salesOrders, afiacaoOrders, selectedDate]);

  // Fetch customer profiles
  const customerIds = useMemo(() => {
    const ids = new Set<string>();
    allOrdersRaw.forEach(o => {
      if (o.customer_user_id) ids.add(o.customer_user_id);
      if (o.user_id) ids.add(o.user_id);
    });
    return [...ids];
  }, [allOrdersRaw]);

  // Contato do cliente (documento, telefone, endereços) pelo contexto OPERACIONAL — objeto = o
  // pedido/OS impresso, nunca o cliente solto (onda D). Nome segue de `profiles` (identidade).
  const salesIdsImpressao = useMemo(() => salesOrders.map((o) => o.id), [salesOrders]);
  const osIdsImpressao = useMemo(() => afiacaoOrders.map((o) => o.id), [afiacaoOrders]);
  const { data: contatoPorCliente, isError: contatoFalhou, refetch: recarregarContato } = useQuery({
    queryKey: ['sales-print-contato', salesIdsImpressao, osIdsImpressao],
    queryFn: async () => {
      const [pedidos, oss] = await Promise.all([
        lerContatoOperacional('pedido', salesIdsImpressao, 'impressao_pedido'),
        lerContatoOperacional('ordem_servico', osIdsImpressao, 'lista_os'),
      ]);
      const m = new Map<string, ContatoOperacional>();
      for (const c of [...pedidos.values(), ...oss.values()]) m.set(c.customer_user_id, c);
      return m;
    },
    enabled: salesIdsImpressao.length + osIdsImpressao.length > 0,
  });

  const { data: nomes = [], isError: nomesFalharam, refetch: recarregarNomes } = useQuery({
    queryKey: ['sales-print-profiles', customerIds],
    queryFn: async () => {
      if (customerIds.length === 0) return [];
      // L2-d: o erro LANÇA — antes `{ data }` sem `error` virava [] e a folha saía com "Cliente" no lugar do nome.
      return coletarEmLotesConcorrente(customerIds, IDS_POR_LOTE, CONCORRENCIA_LOTES, async (lote) => {
        const { data, error } = await supabase
          .from('profiles')
          .select('user_id, name')
          .in('user_id', lote);
        if (error) throw error;
        return data ?? [];
      });
    },
    enabled: customerIds.length > 0,
  });
  const profiles = useMemo((): ProfileLite[] => nomes.map((p) => {
    const c = contatoPorCliente?.get(p.user_id);
    return { ...p, document: c?.document ?? null, phone: c?.phone ?? null } as ProfileLite;
  }), [nomes, contatoPorCliente]);

  const customerAddresses = useMemo((): AddressLite[] =>
    [...(contatoPorCliente?.values() ?? [])].flatMap((c) =>
      c.enderecos.map((e) => ({ ...e, user_id: c.customer_user_id }) as AddressLite)),
  [contatoPorCliente]);

  // Código do cliente (conta colacor_sc) p/ address lookup — via view fresca account-correta.
  const { data: omieClientes = [], isError: codigosOmieFalharam, refetch: recarregarCodigosOmie } = useQuery({
    queryKey: ['sales-print-omie-map-fresco', customerIds],
    queryFn: async () => {
      if (customerIds.length === 0) return [];
      // P0-B-bis PR-4 (#12): o código é usado p/ consultar endereço via `omie-cliente` (que bate na conta
      // colacor_sc) → lê da view fresca omie_customer_account_map_fresco com account=colacor_sc
      // (document-first, TTL 7d). O filtro antigo .eq('empresa_omie','colacor') era inócuo (o espelho é
      // 100% 'colacor' rotulado). Miss na fresca → sem código → cai no fallback por documento (fail-closed).
      return coletarEmLotesConcorrente(customerIds, IDS_POR_LOTE, CONCORRENCIA_LOTES, async (lote) => {
        const { data, error } = await supabase
          .from('omie_customer_account_map_fresco')
          .select('user_id, omie_codigo_cliente')
          .eq('account', 'colacor_sc')
          .in('user_id', lote);
        if (error) throw error;
        return data ?? [];
      });
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
    // view fresca é nulável (user_id/omie_codigo_cliente string|null / number|null) → guarda os dois;
    // linha sem par completo cai no fallback por payload/documento abaixo (fail-closed).
    omieClientes.forEach(oc => {
      if (oc.user_id != null && oc.omie_codigo_cliente != null) m.set(oc.user_id, oc.omie_codigo_cliente);
    });
    // Fallback: extract codigo_cliente from order payloads for customers not in omie_clientes
    allOrdersRaw.forEach(o => {
      const custId = o.customer_user_id || o.user_id;
      if (custId && !m.has(custId)) {
        const cc = o.omie_payload?.cabecalho?.codigo_cliente;
        if (typeof cc === 'number' && cc) m.set(custId, cc);
      }
    });
    return m;
  }, [omieClientes, allOrdersRaw]);

  // Um pedido (sales_order) impresso por cliente: o objeto da exceção operacional no endereço Omie.
  const pedidoPorCliente = useMemo(() => {
    const m = new Map<string, string>();
    salesOrders.forEach((o) => {
      const cid = o.customer_user_id || o.user_id;
      if (cid && !m.has(cid)) m.set(cid, o.id);
    });
    return m;
  }, [salesOrders]);

  // Fetch addresses from Omie for ALL customers missing local address
  const { data: leituraEnderecosOmie, isError: enderecosOmieFalharam, refetch: recarregarEnderecosOmie } = useQuery({
    queryKey: ['sales-print-omie-addresses', customersMissingAddress, Array.from(omieClienteMap.entries()), Array.from(pedidoPorCliente.entries())],
    queryFn: async () => {
      const result: Record<string, string> = {};
      // L2-d: o cliente cuja consulta FALHOU é contado — "sem endereço" calado não é a mesma coisa.
      let falhas = 0;
      for (const userId of customersMissingAddress) {
        const codigoCliente = omieClienteMap.get(userId);

        // (O fallback por documento via `buscar_por_documento` saiu na onda D 4b-2: a ação pública só
        // devolve `{existe, razao_social}`, nunca o código — era caminho morto que expunha o documento.)
        if (!codigoCliente) continue;
        // Fora da carteira, a edge mascara o endereço Omie; o pedido impresso abre pela exceção operacional
        // (`contato_cliente_operacional`, ledger), e só se o documento do pedido casar com o da Omie.
        const pedidoId = pedidoPorCliente.get(userId);
        try {
          const { data, error } = await supabase.functions.invoke('omie-cliente', {
            body: {
              action: 'consultar_cliente',
              codigo_cliente: codigoCliente,
              ...(pedidoId ? { operacional: { objeto_tipo: 'pedido', objeto_id: pedidoId, motivo: 'impressao_pedido' } } : {}),
            },
          });
          if (error) { falhas++; continue; }
          // Resposta mascarada (fora da carteira, sem exceção) não tem rua: não imprime só cidade/UF como
          // se fosse o endereço de entrega (Codex P2) — a folha fica "sem endereço", como antes da Omie.
          if (data?.cliente?.endereco) {
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
          falhas++;
        }
      }
      return { enderecos: result, falhas };
    },
    enabled: customersMissingAddress.length > 0,
  });
  const omieAddresses = useMemo(() => leituraEnderecosOmie?.enderecos ?? {}, [leituraEnderecosOmie]);
  const enderecosOmieSemLeitura = enderecosOmieFalharam ? customersMissingAddress.length : (leituraEnderecosOmie?.falhas ?? 0);

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
          || descricaoDaParcela(formasMap, o._company, parcelaCode)
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

  // Desconto de cada item (order_items.desconto_valor): o jsonb `items`, de onde saem as linhas do
  // cupom, é BRUTO. Lido em lote para os pedidos de venda da janela; afiação (tabela `orders`) não
  // tem order_items. Leitura que ainda não aconteceu vira AVISO na impressão, nunca "sem desconto".
  const salesOrderIds = useMemo(() => salesOrders.map((o) => o.id), [salesOrders]);
  const descontosQuery = useQuery({
    queryKey: ['sales-print', 'descontos-itens', salesOrderIds],
    queryFn: () => buscarDescontosItens(salesOrderIds),
    enabled: salesOrderIds.length > 0,
  });
  const leituraDescontosDo = (o: EnrichedOrder): LeituraDescontosItens =>
    o._company === 'afiacao' ? { estado: 'nao-se-aplica' } : leituraDoPedido(descontosQuery.data, o.id);

  // O aviso é da EQUIPE, não do papel: saiu cupom sem a quebra de um desconto que existe ou que não
  // se conseguiu ler (ex.: cabeçalho ainda bruto até o deploy/reprocess do #2469 alcançá-lo).
  const avisarDescontos = (avisos: Array<string | undefined>) => {
    const aviso = mensagemAvisoDesconto(avisos);
    if (aviso) toast.warning(aviso.titulo, { description: aviso.descricao });
  };

  // L2-d: sem o nome (profiles) ou o contato (documento/endereço) a via sairia com "Cliente" e sem endereço —
  // a impressão espera a leitura, em vez de imprimir o que não leu.
  const bloqueioImpressao = nomesFalharam || contatoFalhou
    ? 'Não consegui ler o nome ou o contato dos clientes — a folha sairia sem esses dados. Tente de novo antes de imprimir.'
    : null;

  const printSelected = () => {
    if (bloqueioImpressao) { toast.error(bloqueioImpressao); return; }
    const toPrint = filteredOrders.filter(o => selectedOrders.has(o.id));
    if (toPrint.length === 0) return;

    // Build combined HTML for all selected orders
    const printData = toPrint.map(o => buildPrintData(o, o._company, companyLogos, leituraDescontosDo(o)));
    const allPages = printData.map((d) => buildSingleOrderHtml(d));

    const html = buildPrintDocument(allPages, format(selectedDate, 'dd/MM/yyyy'));

    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(html);
      printWindow.document.close();
    }
    avisarDescontos(printData.map((d) => d.avisoDesconto));
  };

  const printSingle = (order: EnrichedOrder) => {
    if (bloqueioImpressao) { toast.error(bloqueioImpressao); return; }
    const printData = buildPrintData(order, order._company, companyLogos, leituraDescontosDo(order));
    openPrintOrder(printData);
    avisarDescontos([printData.avisoDesconto]);
  };

  const isLoading = loadingSales || loadingAfiacao;
  // L2-d: a falha de qualquer das duas leituras do dia NÃO é "Nenhum pedido encontrado".
  const leiturasDoDiaFalharam = [
    erroSales ? 'pedidos de venda' : null,
    erroAfiacao ? 'ordens de serviço de afiação' : null,
  ].filter((x): x is string => x !== null);
  const avisosDeLeitura = [
    nomesFalharam ? { chave: 'nomes', texto: 'Os nomes dos clientes não carregaram.', recarregar: recarregarNomes } : null,
    contatoFalhou ? { chave: 'contato', texto: 'O documento, o telefone e o endereço dos clientes não carregaram.', recarregar: recarregarContato } : null,
    codigosOmieFalharam ? { chave: 'codigos', texto: 'Os códigos Omie dos clientes não carregaram: o endereço do Omie pode faltar na folha.', recarregar: recarregarCodigosOmie } : null,
    enderecosOmieSemLeitura > 0 ? {
      chave: 'enderecos',
      texto: `${enderecosOmieSemLeitura === 1 ? '1 endereço do Omie não carregou' : `${enderecosOmieSemLeitura} endereços do Omie não carregaram`}: a folha desses clientes sai sem endereço.`,
      recarregar: recarregarEnderecosOmie,
    } : null,
  ].filter((x): x is NonNullable<typeof x> => x !== null);

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

        {/* Degradação da listagem de condições: a via impressa sai com o CÓDIGO da parcela
            em vez da descrição — melhor um código cru verdadeiro que um rótulo genérico
            errado no documento que vai ao cliente. */}
        <AvisoFormasPagamento
          degradado={contasComFormasDegradadas.length > 0}
          onRecarregar={() => { void recarregarFormas(); }}
          texto={
            'Condições do Omie indisponíveis para '
            + contasComFormasDegradadas.map((c) => (c === 'oben' ? 'Oben' : 'Colacor')).join(' e ')
            + '. A impressão mostra o CÓDIGO da condição no lugar da descrição, para não '
            + 'imprimir um prazo que não foi conferido.'
          }
        />

        {leiturasDoDiaFalharam.length > 0 && (
          <div role="alert" data-testid="leitura-do-dia-falhou" className="rounded-md border border-status-error/40 p-3 text-sm text-status-error space-y-2">
            <p>
              Não consegui ler os {leiturasDoDiaFalharam.join(' e as ')} deste dia — a lista abaixo está incompleta
              {leiturasDoDiaFalharam.length === 2 ? ' (vazia)' : ''}, não é "sem pedido".
            </p>
            <Button variant="outline" size="sm" onClick={() => { if (erroSales) void recarregarSales(); if (erroAfiacao) void recarregarAfiacao(); }}>
              Tentar de novo
            </Button>
          </div>
        )}

        {avisosDeLeitura.map((a) => (
          <div key={a.chave} role="alert" data-testid={`aviso-leitura-${a.chave}`} className="rounded-md border border-status-warning/40 p-3 text-sm text-status-warning flex items-center justify-between gap-3">
            <span>{a.texto}</span>
            <Button variant="outline" size="sm" onClick={() => { void a.recarregar(); }}>Tentar de novo</Button>
          </div>
        ))}

        {foraDaImpressao.length > 0 && (
          <div role="alert" data-testid="fora-da-impressao" className="rounded-md border border-status-warning/40 p-3 text-sm text-status-warning">
            {foraDaImpressao.length === 1 ? '1 pedido do dia ficou' : `${foraDaImpressao.length} pedidos do dia ficaram`} fora
            da impressão: {foraDaImpressao.join(' · ')}.
          </div>
        )}

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
            <Button onClick={printSelected} disabled={selectedOrders.size === 0 || bloqueioImpressao !== null} className="gap-2">
              <Printer className="h-4 w-4" />
              Imprimir selecionados
            </Button>
          </div>
        </div>

        {/* Orders grouped by company + period */}
        {isLoading ? (
          <PageSkeleton variant="list" />
        ) : filteredOrders.length === 0 && leiturasDoDiaFalharam.length === 0 ? (
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
