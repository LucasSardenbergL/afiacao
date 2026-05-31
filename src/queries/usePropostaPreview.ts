import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { montarCestaRecompra } from '@/lib/whatsapp/cesta-recompra';
import type { PedidoLine } from '@/lib/whatsapp/cesta-recompra';
import { filtrarCestaPorAtivos } from '@/lib/whatsapp/cesta-ativos';
import { formatarPropostaRecompra } from '@/lib/whatsapp/proposta-format';
import type { PropostaFormatada } from '@/lib/whatsapp/proposta-format';

// Status do Omie que NUNCA contam como compra válida (cancelamento/exclusão). Tudo o mais é
// permissivo no PREVIEW — a whitelist EXATA é decisão do founder no lançamento (surfaçamos os vistos).
const STATUS_CANCELAMENTO = new Set(['CANCELADO', 'CANCELADA', 'EXCLUIDO', 'EXCLUÍDO', 'CANCELED']);
const JANELA_FETCH_DIAS = 365;

function hojeIso(): string { return new Date().toISOString().slice(0, 10); }
function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

interface OrderRow { id: string; account: string; order_date_kpi: string | null; created_at: string; status: string }
interface ItemRow { omie_codigo_produto: number | null; quantity: number; unit_price: number; sales_order_id: string }
interface ProdRow { omie_codigo_produto: number; descricao: string; ativo: boolean }
interface ProfileRow { name: string | null; razao_social: string | null }

export interface PropostaPreview {
  proposta: PropostaFormatada;
  account: string | null;
  totalPedidos: number;
  removidosInativos: number;
  statusesVistos: string[];     // ajuda o founder a definir a whitelist real
  nomeCliente: string | null;
  semHistorico: boolean;
}

export function usePropostaPreview(customerUserId: string | undefined, opts?: { enabled?: boolean }) {
  return useQuery<PropostaPreview>({
    queryKey: ['proposta-preview', customerUserId],
    enabled: (opts?.enabled ?? true) && !!customerUserId,
    staleTime: 60_000,
    queryFn: async () => {
      const hoje = hojeIso();
      const desde = addDays(hoje, -JANELA_FETCH_DIAS);

      // 1) pedidos recentes do cliente (data canônica + account + status)
      const { data: ordersData, error: oErr } = await supabase
        .from('sales_orders')
        .select('id, account, order_date_kpi, created_at, status')
        .eq('customer_user_id', customerUserId!)
        .gte('created_at', desde);
      if (oErr) throw oErr;
      const orders = (ordersData ?? []) as OrderRow[];

      const vazio = (): PropostaPreview => ({
        proposta: { texto: '', itensPrincipais: 0, vazia: true },
        account: null, totalPedidos: 0, removidosInativos: 0, statusesVistos: [], nomeCliente: null, semHistorico: true,
      });
      if (orders.length === 0) return vazio();

      // account predominante + status vistos
      const porAccount = new Map<string, number>();
      const statusSet = new Set<string>();
      for (const o of orders) {
        porAccount.set(o.account, (porAccount.get(o.account) ?? 0) + 1);
        if (o.status) statusSet.add(o.status);
      }
      const account = [...porAccount.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const statusesVistos = [...statusSet].sort();
      const statusValidos = statusesVistos.filter(s => !STATUS_CANCELAMENTO.has(s.toUpperCase()));
      const orderById = new Map(orders.map(o => [o.id, o]));

      // 2) itens dos pedidos do cliente
      const { data: itemsData, error: iErr } = await supabase
        .from('order_items')
        .select('omie_codigo_produto, quantity, unit_price, sales_order_id')
        .eq('customer_user_id', customerUserId!);
      if (iErr) throw iErr;

      const lines: PedidoLine[] = [];
      for (const it of (itemsData ?? []) as ItemRow[]) {
        const ord = orderById.get(it.sales_order_id);
        if (!ord || it.omie_codigo_produto == null) continue;
        lines.push({
          omie_codigo_produto: it.omie_codigo_produto,
          quantity: it.quantity,
          unit_price: it.unit_price,
          order_date: (ord.order_date_kpi ?? ord.created_at).slice(0, 10),
          account: ord.account,
          status: ord.status,
        });
      }

      // 3) cesta
      const cesta = montarCestaRecompra(lines, { account, hoje, statusValidos });
      const skus = [...new Set([...cesta.principal, ...cesta.secundarios].map(i => i.omie_codigo_produto))];

      // 4) nomes + ativos (omie_products, dado sincronizado)
      const nomesPorSku: Record<number, string> = {};
      const ativos = new Set<number>();
      if (skus.length > 0) {
        const { data: prodData } = await supabase
          .from('omie_products')
          .select('omie_codigo_produto, descricao, ativo')
          .eq('account', account)
          .in('omie_codigo_produto', skus);
        for (const p of (prodData ?? []) as ProdRow[]) {
          nomesPorSku[p.omie_codigo_produto] = p.descricao;
          if (p.ativo) ativos.add(p.omie_codigo_produto);
        }
      }
      const { cesta: cestaFiltrada, removidos } = filtrarCestaPorAtivos(cesta, ativos);

      // 5) nome do cliente + formata
      const { data: prof } = await supabase
        .from('profiles').select('name, razao_social').eq('user_id', customerUserId!).maybeSingle();
      const p = (prof ?? null) as ProfileRow | null;
      const nomeCliente = p?.razao_social || p?.name || null;
      const primeiroNome = nomeCliente ? nomeCliente.split(' ')[0] : undefined;

      const proposta = formatarPropostaRecompra(cestaFiltrada, { nomesPorSku, primeiroNome });

      return {
        proposta, account, totalPedidos: cesta.totalPedidos, removidosInativos: removidos,
        statusesVistos, nomeCliente, semHistorico: false,
      };
    },
  });
}
