import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPages } from '@/lib/postgrest';
import { STATUS_NAO_VENDA, STATUS_NAO_VENDA_POSTGREST } from '@/lib/farmer/universo-pedidos';
import { montarCestaRecompra } from '@/lib/whatsapp/cesta-recompra';
import type { CestaResult } from '@/lib/whatsapp/cesta-recompra';
import { filtrarCestaPorAtivos } from '@/lib/whatsapp/cesta-ativos';
import type { CrossSellCand } from '@/lib/whatsapp/cross-sell';
import { formatarPropostaRecompra } from '@/lib/whatsapp/proposta-format';
import type { PropostaFormatada } from '@/lib/whatsapp/proposta-format';
import { selecionarCrossSell } from '@/lib/whatsapp/cross-sell';
import { assembleLinesEContexto, buildCrossSellCandidatos } from '@/lib/whatsapp/proposta-preview-core';
import { hojeSP } from '@/lib/time/sp-day';
import type { PreviewOrder, PreviewItem, PreviewRec, PreviewProdById } from '@/lib/whatsapp/proposta-preview-core';

/**
 * A régua em memória do core (`assembleLinesEContexto` compara em caixa alta) DERIVADA da autoridade —
 * não uma cópia. A que morava aqui (`STATUS_CANCELAMENTO`: sinônimos de cancelado em caixa alta) só
 * tirava o cancelado: orçamento e rascunho podiam pôr SKU na cesta que vai ao cliente.
 */
const STATUS_NAO_VENDA_CAIXA_ALTA = new Set(STATUS_NAO_VENDA.map((s) => s.toUpperCase()));
const JANELA_FETCH_DIAS = 365;
const MAX_CROSS_SELL = 2;

function hojeIso(): string { return hojeSP(); } // o dia de SP (o UTC vira às 21h BRT)
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

      // 1) pedidos + itens recentes do cliente — PAGINADOS. O PostgREST capa em 1.000 linhas em silêncio, e
      //    os itens são lidos por CLIENTE (o histórico inteiro; o recorte da janela é o join em memória).
      //    Medido em prod (2026-10-03): 8 clientes passam de 1.000 itens (máx. 2.914), e nos 2 maiores a
      //    cesta perdia 18–23% dos SKUs da janela — saía de uma amostra arbitrária do histórico.
      const orders = await fetchAllPages<PreviewOrder>(
        (de, ate) =>
          supabase
            .from('sales_orders')
            .select('id, account, order_date_kpi, created_at, status')
            .eq('customer_user_id', customerUserId!)
            // A cesta sai do universo de VENDA — o mesmo do preço que a cota (`get_whatsapp_proposta_cotacao`,
            // canônico desde o #2726). Antes, a cesta de um universo e o preço de outro.
            .not('status', 'in', STATUS_NAO_VENDA_POSTGREST)
            .is('deleted_at', null)
            .gte('created_at', desde)
            .order('id', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: PreviewOrder[] | null; error: unknown }>,
        'sales_orders/proposta-preview',
      );
      if (orders.length === 0) return VAZIO;

      const itens = await fetchAllPages<PreviewItem>(
        (de, ate) =>
          supabase
            .from('order_items')
            .select('omie_codigo_produto, quantity, unit_price, sales_order_id')
            .eq('customer_user_id', customerUserId!)
            .order('id', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: PreviewItem[] | null; error: unknown }>,
        'order_items/proposta-preview',
      );

      // 2) composição PURA (join + account predominante + status) — testada
      const ctx = assembleLinesEContexto(orders, itens, STATUS_NAO_VENDA_CAIXA_ALTA);
      if (!ctx.account) return VAZIO;
      const { lines, account, statusesVistos, statusValidos } = ctx;

      // 3) cesta de recompra
      const cesta = montarCestaRecompra(lines, { account, hoje, statusValidos });
      const skus = [...new Set([...cesta.principal, ...cesta.secundarios].map(i => i.omie_codigo_produto))];

      // 4) nomes + ativos (omie_products por omie_codigo_produto) → filtra SKU inativo
      const nomesPorSku: Record<number, string> = {};
      const ativos = new Set<number>();
      if (skus.length > 0) {
        const { data: prodData, error: prodErr } = await supabase
          .from('omie_products')
          .select('omie_codigo_produto, descricao, ativo')
          .eq('account', account)
          .in('omie_codigo_produto', skus);
        // Falha aqui NÃO é "todo SKU inativo": sem o lance, `ativos` vazio tirava a cesta inteira e a
        // tela dizia "só SKUs inativos" — causa fabricada, e o vendedor pulava o cliente.
        if (prodErr) throw prodErr;
        for (const p of (prodData ?? []) as ProdRow[]) {
          nomesPorSku[p.omie_codigo_produto] = p.descricao;
          if (p.ativo) ativos.add(p.omie_codigo_produto);
        }
      }
      const { cesta: cestaFiltrada, removidos } = filtrarCestaPorAtivos(cesta, ativos);

      // 4b) cross-sell ("experimente também") — só com cesta-base; vazio quando não há rec, mas a FALHA
      //     de leitura lança (a proposta não sai com a seção omitida em silêncio)
      let crossSell: CrossSellCand[] = [];
      if (cestaFiltrada.principal.length > 0) {
        const cestaSkus = new Set([...cestaFiltrada.principal, ...cestaFiltrada.secundarios].map(i => i.omie_codigo_produto));
        const { data: recData, error: recErr } = await supabase
          .from('farmer_recommendations')
          .select('product_id, affinity_score, status, recommendation_type')
          .eq('customer_user_id', customerUserId!)
          // Só a geração VIGENTE. Desde 20260814223445 o recálculo aposenta a geração
          // anterior marcando-a `status='expirado'` — sem este filtro a proposta que vai
          // pro cliente no WhatsApp ofereceria SKU que o motor já descartou. Era inócuo
          // enquanto nada era expirado; passou a morder no instante em que algo é.
          .eq('status', 'pendente')
          // Só CROSS-SELL. A seção é "experimente também" — produto COMPLEMENTAR. Sem este
          // filtro o top-2 era ordenado por `affinity_score`, que carrega duas grandezas
          // incomensuráveis: medido em prod (07/09/2026) o up-sell varria a seção de 183 dos
          // 238 clientes, oferecendo a versão mais CARA do que o cliente já compra.
          // ⚠️ O `.eq()` NÃO projeta a coluna — ela precisa estar no `.select()` acima, senão o
          // helper recebe `undefined` e a seção vai a ZERO. Os dois andam juntos.
          .eq('recommendation_type', 'cross_sell');
        if (recErr) throw recErr;
        const recs = (recData ?? []) as PreviewRec[];
        const recIds = [...new Set(recs.map(r => r.product_id).filter((x): x is string => !!x))];
        if (recIds.length > 0) {
          const { data: prodById, error: prodByIdErr } = await supabase
            .from('omie_products')
            .select('id, omie_codigo_produto, descricao, ativo')
            .eq('account', account)
            .in('id', recIds);
          if (prodByIdErr) throw prodByIdErr;
          const candidatos = buildCrossSellCandidatos(recs, (prodById ?? []) as PreviewProdById[]);
          crossSell = selecionarCrossSell(cestaSkus, candidatos, MAX_CROSS_SELL);
        }
      }

      // 5) nome + documento do cliente + formata
      const { data: prof, error: profErr } = await supabase
        .from('profiles').select('name, razao_social, cnpj, document').eq('user_id', customerUserId!).maybeSingle();
      // nome e documento vão no ENVIO (`documento` do payload): falha não pode virar "cliente sem documento"
      if (profErr) throw profErr;
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
