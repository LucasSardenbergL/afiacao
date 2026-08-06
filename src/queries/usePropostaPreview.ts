import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { montarCestaRecompra } from '@/lib/whatsapp/cesta-recompra';
import type { CestaResult } from '@/lib/whatsapp/cesta-recompra';
import { filtrarCestaPorAtivos } from '@/lib/whatsapp/cesta-ativos';
import type { CrossSellCand } from '@/lib/whatsapp/cross-sell';
import { formatarPropostaRecompra } from '@/lib/whatsapp/proposta-format';
import type { PropostaFormatada } from '@/lib/whatsapp/proposta-format';
import { selecionarCrossSell } from '@/lib/whatsapp/cross-sell';
import { assembleLinesEContexto, buildCrossSellCandidatos } from '@/lib/whatsapp/proposta-preview-core';
import type { PreviewOrder, PreviewItem, PreviewRec, PreviewProdById } from '@/lib/whatsapp/proposta-preview-core';

// Status do Omie que NUNCA contam como compra válida. Permissivo no PREVIEW — a whitelist EXATA é
// decisão do founder no lançamento (surfaçamos os status vistos pra ele definir).
const STATUS_CANCELAMENTO = new Set(['CANCELADO', 'CANCELADA', 'EXCLUIDO', 'EXCLUÍDO', 'CANCELED']);
const JANELA_FETCH_DIAS = 365;
const MAX_CROSS_SELL = 2;

function hojeIso(): string { return new Date().toISOString().slice(0, 10); }
function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

interface ProdRow { omie_codigo_produto: number; descricao: string; ativo: boolean }
interface ProfileRow { name: string | null; razao_social: string | null; cnpj: string | null; document: string | null }

export interface PropostaPreview {
  proposta: PropostaFormatada;
  account: string | null;
  totalPedidos: number;
  removidosInativos: number;
  crossSellCount: number;
  statusesVistos: string[];     // ajuda o founder a definir a whitelist real
  nomeCliente: string | null;
  semHistorico: boolean;
  // estrutura pro ENVIO (PR-4): a recotação cota EXATAMENTE o que o preview mostrou
  cesta: CestaResult;
  nomesPorSku: Record<number, string>;
  crossSell: CrossSellCand[];
  documentoCliente: string | null; // cnpj/document do profile — âncora P0-B do orçamento
}

const CESTA_VAZIA: CestaResult = { principal: [], secundarios: [], totalPedidos: 0, confianca: 'baixa' };
const VAZIO: PropostaPreview = {
  proposta: { texto: '', itensPrincipais: 0, vazia: true },
  account: null, totalPedidos: 0, removidosInativos: 0, crossSellCount: 0, statusesVistos: [], nomeCliente: null, semHistorico: true,
  cesta: CESTA_VAZIA, nomesPorSku: {}, crossSell: [], documentoCliente: null,
};

export function usePropostaPreview(customerUserId: string | undefined, opts?: { enabled?: boolean }) {
  return useQuery<PropostaPreview>({
    queryKey: ['proposta-preview', customerUserId],
    enabled: (opts?.enabled ?? true) && !!customerUserId,
    staleTime: 60_000,
    queryFn: async () => {
      const hoje = hojeIso();
      const desde = addDays(hoje, -JANELA_FETCH_DIAS);

      // 1) pedidos + itens recentes do cliente
      const { data: ordersData, error: oErr } = await supabase
        .from('sales_orders')
        .select('id, account, order_date_kpi, created_at, status')
        .eq('customer_user_id', customerUserId!)
        .gte('created_at', desde);
      if (oErr) throw oErr;
      const orders = (ordersData ?? []) as PreviewOrder[];
      if (orders.length === 0) return VAZIO;

      const { data: itemsData, error: iErr } = await supabase
        .from('order_items')
        .select('omie_codigo_produto, quantity, unit_price, sales_order_id')
        .eq('customer_user_id', customerUserId!);
      if (iErr) throw iErr;

      // 2) composição PURA (join + account predominante + status) — testada
      const ctx = assembleLinesEContexto(orders, (itemsData ?? []) as PreviewItem[], STATUS_CANCELAMENTO);
      if (!ctx.account) return VAZIO;
      const { lines, account, statusesVistos, statusValidos } = ctx;

      // 3) cesta de recompra
      const cesta = montarCestaRecompra(lines, { account, hoje, statusValidos });
      const skus = [...new Set([...cesta.principal, ...cesta.secundarios].map(i => i.omie_codigo_produto))];

      // 4) nomes + ativos (omie_products por omie_codigo_produto) → filtra SKU inativo
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

      // 4b) cross-sell ("experimente também") — só com cesta-base; degrada honesto (vazio sem rec)
      let crossSell: CrossSellCand[] = [];
      if (cestaFiltrada.principal.length > 0) {
        const cestaSkus = new Set([...cestaFiltrada.principal, ...cestaFiltrada.secundarios].map(i => i.omie_codigo_produto));
        const { data: recData } = await supabase
          .from('farmer_recommendations')
          .select('product_id, lie, status')
          .eq('customer_user_id', customerUserId!);
        const recs = (recData ?? []) as PreviewRec[];
        const recIds = [...new Set(recs.map(r => r.product_id).filter((x): x is string => !!x))];
        if (recIds.length > 0) {
          const { data: prodById } = await supabase
            .from('omie_products')
            .select('id, omie_codigo_produto, descricao, ativo')
            .eq('account', account)
            .in('id', recIds);
          const candidatos = buildCrossSellCandidatos(recs, (prodById ?? []) as PreviewProdById[]);
          crossSell = selecionarCrossSell(cestaSkus, candidatos, MAX_CROSS_SELL);
        }
      }

      // 5) nome + documento do cliente + formata
      const { data: prof } = await supabase
        .from('profiles').select('name, razao_social, cnpj, document').eq('user_id', customerUserId!).maybeSingle();
      const p = (prof ?? null) as ProfileRow | null;
      const nomeCliente = p?.razao_social || p?.name || null;
      const documentoCliente = p?.cnpj || p?.document || null;
      const primeiroNome = nomeCliente ? nomeCliente.split(' ')[0] : undefined;

      const proposta = formatarPropostaRecompra(cestaFiltrada, { nomesPorSku, primeiroNome, crossSell });

      return {
        proposta, account, totalPedidos: cesta.totalPedidos, removidosInativos: removidos,
        crossSellCount: crossSell.length, statusesVistos, nomeCliente, semHistorico: false,
        cesta: cestaFiltrada, nomesPorSku, crossSell, documentoCliente,
      };
    },
  });
}
