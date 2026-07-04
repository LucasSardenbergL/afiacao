// Pedidos programados (Lider): queries + mutations da tela /sales/programados.
// Tabelas novas ainda fora dos tipos gerados do Supabase → casts `as never` no .from()
// (mesmo padrão do order_feed em useSalesOrders) com tipos locais na borda.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { track } from '@/lib/analytics';
import { ilikeOr, isSearchablePostgrestTerm } from '@/lib/postgrest';
import type { EnvioCalendario, StatusEnvio } from '@/lib/pedidosProgramados/calendario';

export interface PedidoProgramado {
  id: string;
  cliente_ref: string;
  arquivo_path: string;
  numero_pedido_compra: string | null;
  versao: string | null;
  data_emissao_cliente: string | null;
  status: 'extraindo' | 'erro_extracao' | 'ativo' | 'concluido' | 'cancelado';
  erro_motivo: string | null;
  created_at: string;
}

export interface ProdutoMapeado {
  id: string;
  omie_codigo_produto: number;
  codigo: string;
  descricao: string;
  unidade: string | null;
  account: 'oben' | 'colacor';
  ativo: boolean | null;
}

export interface PedidoProgramadoItem {
  id: string;
  pedido_programado_id: string;
  envio_id: string | null;
  codigo_item_cliente: string;
  num_ordem_cliente: string | null;
  descricao_cliente: string;
  quantidade: number;
  unidade: string | null;
  data_entrega_cliente: string | null;
  cod_forn: string | null;
  preco_pdf: number | null;
  preco_final: number | null;
  mapa_id: string | null;
  mapa: { id: string; ultimo_preco: number | null; omie_products: ProdutoMapeado | null } | null;
}

export interface PedidoProgramadoEnvio {
  id: string;
  pedido_programado_id: string;
  data_envio: string;
  status: 'agendado' | 'enviado' | 'erro' | 'cancelado';
  erro_motivo: string | null;
  sales_orders_map: Record<string, string>;
  created_at: string;
}

export interface PedidoProgramadoConfig {
  account: 'oben' | 'colacor';
  codigo_cliente_omie: number | null;
  customer_user_id: string | null;
  obs_venda: string | null;
  dados_adicionais_nf: string | null;
  codigo_parcela: string | null;
}

// .from() sem tipos gerados (tabelas novas): cast único aqui.
const t = (name: string) => supabase.from(name as never);

export function usePedidosProgramadosLista() {
  return useQuery({
    queryKey: ['pedidos-programados'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await t('pedidos_programados')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as PedidoProgramado[];
    },
  });
}

export function usePedidoProgramadoDetalhe(id: string | undefined) {
  return useQuery({
    queryKey: ['pedido-programado', id],
    enabled: !!id,
    staleTime: 30_000,
    queryFn: async () => {
      const [header, itens, envios] = await Promise.all([
        t('pedidos_programados').select('*').eq('id', id!).single(),
        t('pedidos_programados_itens')
          .select('*, mapa:cliente_item_mapa(id, ultimo_preco, omie_products(id, omie_codigo_produto, codigo, descricao, unidade, account, ativo))')
          .eq('pedido_programado_id', id!)
          .order('data_entrega_cliente', { ascending: true, nullsFirst: false })
          .order('codigo_item_cliente', { ascending: true }),
        t('pedidos_programados_envios')
          .select('*')
          .eq('pedido_programado_id', id!)
          .order('data_envio', { ascending: true }),
      ]);
      if (header.error) throw header.error;
      if (itens.error) throw itens.error;
      if (envios.error) throw envios.error;
      const normalizados = ((itens.data ?? []) as unknown as PedidoProgramadoItem[]).map((it) => ({
        ...it,
        // numeric do PostgREST pode vir string — converter na borda (contrato do helpers.ts)
        quantidade: Number(it.quantidade),
        preco_pdf: it.preco_pdf === null ? null : Number(it.preco_pdf),
        preco_final: it.preco_final === null ? null : Number(it.preco_final),
      }));
      return {
        pedido: header.data as unknown as PedidoProgramado,
        itens: normalizados,
        envios: (envios.data ?? []) as unknown as PedidoProgramadoEnvio[],
      };
    },
  });
}

export function usePedidosProgramadosConfig() {
  return useQuery({
    queryKey: ['pedidos-programados-config'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await t('pedidos_programados_config').select('*');
      if (error) throw error;
      return (data ?? []) as unknown as PedidoProgramadoConfig[];
    },
  });
}

// Calendário de faturamento: 1 query por mês visível ('YYYY-MM').
// queryKey com prefixo 'pedidos-programados' → invalidação automática pelas
// mutations existentes (invalidar() usa exatamente esse prefixo).
interface EnvioCalendarioRow {
  id: string;
  pedido_programado_id: string;
  data_envio: string;
  status: StatusEnvio;
  erro_motivo: string | null;
  pedido: { numero_pedido_compra: string | null } | null;
  itens: Array<{
    quantidade: number | string;
    preco_final: number | string | null;
    mapa: { omie_products: { account: 'oben' | 'colacor' } | null } | null;
  }>;
}

const CAPA_POSTGREST = 1000;

export function usePedidosProgramadosCalendario(mes: string) {
  return useQuery({
    queryKey: ['pedidos-programados', 'calendario', mes],
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const [ano, m] = mes.split('-').map(Number);
      const ultimoDia = new Date(ano, m, 0).getDate(); // dia 0 do mês seguinte = último do mês
      const { data, error } = await t('pedidos_programados_envios')
        .select(
          'id, pedido_programado_id, data_envio, status, erro_motivo, ' +
            'pedido:pedidos_programados(numero_pedido_compra), ' +
            'itens:pedidos_programados_itens(quantidade, preco_final, mapa:cliente_item_mapa(omie_products(account)))',
        )
        .gte('data_envio', `${mes}-01`)
        .lte('data_envio', `${mes}-${String(ultimoDia).padStart(2, '0')}`)
        .order('data_envio', { ascending: true })
        .limit(CAPA_POSTGREST);
      if (error) throw error;
      const rows = (data ?? []) as unknown as EnvioCalendarioRow[];
      const envios: EnvioCalendario[] = rows.map((r) => ({
        id: r.id,
        pedido_programado_id: r.pedido_programado_id,
        numero_pedido_compra: r.pedido?.numero_pedido_compra ?? null,
        data_envio: r.data_envio,
        status: r.status,
        erro_motivo: r.erro_motivo,
        itens: (r.itens ?? []).map((it) => ({
          // numeric do PostgREST pode vir string — converter na borda (padrão do arquivo)
          quantidade: Number(it.quantidade),
          preco_final: it.preco_final === null ? null : Number(it.preco_final),
          account: it.mapa?.omie_products?.account ?? null,
        })),
      }));
      // Capa silenciosa do PostgREST: impossível no volume atual, mas nunca confiar em silêncio
      return { envios, truncado: rows.length === CAPA_POSTGREST };
    },
  });
}

// Busca de produto para mapeamento: sugestão exata por COD.FORN + busca textual
// account-aware. `.or()` SEMPRE via helpers de @/lib/postgrest (regra do repo).
export function useBuscaProdutoMapeamento(termo: string, codForn: string | null) {
  const termoUtil = isSearchablePostgrestTerm(termo);
  return useQuery({
    queryKey: ['pp-busca-produto', termo, codForn],
    enabled: termoUtil || !!codForn,
    staleTime: 60_000,
    queryFn: async () => {
      const sel = 'id, omie_codigo_produto, codigo, descricao, unidade, account, ativo';
      const sugestoes = codForn
        ? ((await supabase.from('omie_products').select(sel).eq('codigo', codForn).limit(4)).data ?? [])
        : [];
      const busca = termoUtil
        ? ((await supabase
            .from('omie_products')
            .select(sel)
            .or(ilikeOr(['codigo', 'descricao'], termo))
            .order('descricao', { ascending: true })
            .limit(20)).data ?? [])
        : [];
      return {
        sugestoes: sugestoes as unknown as ProdutoMapeado[],
        busca: busca as unknown as ProdutoMapeado[],
      };
    },
  });
}

export function usePedidosProgramadosMutations(pedidoId?: string) {
  const qc = useQueryClient();
  const invalidar = () => {
    qc.invalidateQueries({ queryKey: ['pedidos-programados'] });
    if (pedidoId) qc.invalidateQueries({ queryKey: ['pedido-programado', pedidoId] });
  };

  const uploadPdf = useMutation({
    mutationFn: async (file: File) => {
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user?.id;
      if (!uid) throw new Error('Sessão expirada — entre de novo.');
      const path = `lider/${crypto.randomUUID()}.pdf`;
      const { error: upErr } = await supabase.storage
        .from('pedidos-programados')
        .upload(path, file, { contentType: 'application/pdf', upsert: false });
      if (upErr) throw upErr;
      const { data: header, error: insErr } = await t('pedidos_programados')
        .insert({ arquivo_path: path, created_by: uid, status: 'extraindo' } as never)
        .select('id')
        .single();
      if (insErr || !header) throw insErr ?? new Error('Header não criado');
      const headerId = (header as { id: string }).id;
      const { data: fnData, error: fnErr } = await supabase.functions.invoke('pedido-programado-extrair', {
        body: { pedido_programado_id: headerId },
      });
      if (fnErr) throw new Error(`Extração falhou: ${fnErr.message}`);
      if (fnData?.error) throw new Error(`Extração falhou: ${fnData.error}`);
      track('pedidos_programados.upload');
      return { headerId, duplicadoDe: (fnData?.duplicado_de ?? null) as string | null };
    },
    onSuccess: ({ duplicadoDe }) => {
      invalidar();
      if (duplicadoDe) {
        toast.warning('Já existe um pedido ativo com esse nº de PC — confira se é revisão (VERSAO) e cancele o antigo se for.');
      } else {
        toast.success('PDF extraído.');
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const atualizarItem = useMutation({
    mutationFn: async (p: { id: string; quantidade?: number; preco_final?: number | null }) => {
      const patch: Record<string, unknown> = {};
      if (p.quantidade !== undefined) patch.quantidade = p.quantidade;
      if (p.preco_final !== undefined) patch.preco_final = p.preco_final;
      const { error } = await t('pedidos_programados_itens').update(patch as never).eq('id', p.id);
      if (error) throw error;
    },
    onSuccess: invalidar,
    onError: (e: Error) => toast.error(e.message),
  });

  const mapearItem = useMutation({
    mutationFn: async (p: { clienteRef: string; codigoItemCliente: string; omieProductId: string }) => {
      const { data: mapa, error: mapaErr } = await t('cliente_item_mapa')
        .upsert(
          { cliente_ref: p.clienteRef, codigo_item_cliente: p.codigoItemCliente, omie_product_id: p.omieProductId } as never,
          { onConflict: 'cliente_ref,codigo_item_cliente' },
        )
        .select('id, ultimo_preco')
        .single();
      if (mapaErr || !mapa) throw mapaErr ?? new Error('De-para não salvo');
      const m = mapa as { id: string; ultimo_preco: number | null };
      // Aplica a TODOS os itens pendentes deste pedido com o mesmo código do cliente
      const { error: updErr } = await t('pedidos_programados_itens')
        .update({ mapa_id: m.id } as never)
        .eq('pedido_programado_id', pedidoId!)
        .eq('codigo_item_cliente', p.codigoItemCliente)
        .is('envio_id', null);
      if (updErr) throw updErr;
      track('pedidos_programados.mapear_item');
    },
    onSuccess: () => { invalidar(); toast.success('Item mapeado.'); },
    onError: (e: Error) => toast.error(e.message),
  });

  const criarEnvio = useMutation({
    mutationFn: async (p: { itens: PedidoProgramadoItem[]; dataEnvio: string }) => {
      const { data: envio, error: envErr } = await t('pedidos_programados_envios')
        .insert({ pedido_programado_id: pedidoId!, data_envio: p.dataEnvio } as never)
        .select('id')
        .single();
      if (envErr || !envio) throw envErr ?? new Error('Envio não criado');
      const envioId = (envio as { id: string }).id;
      const { error: updErr } = await t('pedidos_programados_itens')
        .update({ envio_id: envioId } as never)
        .in('id', p.itens.map((i) => i.id));
      if (updErr) throw updErr;
      // Memória de preço: o preço final agendado vira o ultimo_preco do de-para
      for (const it of p.itens) {
        if (it.mapa_id && typeof it.preco_final === 'number' && it.preco_final > 0) {
          const { error: memErr } = await t('cliente_item_mapa')
            .update({ ultimo_preco: it.preco_final } as never)
            .eq('id', it.mapa_id);
          if (memErr) throw memErr;
        }
      }
      track('pedidos_programados.criar_envio', { itens: p.itens.length });
      return envioId;
    },
    onSuccess: () => { invalidar(); toast.success('Envio agendado.'); },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelarEnvio = useMutation({
    mutationFn: async (envioId: string) => {
      // Guard money-path: envio 'erro' PARCIALMENTE enviado (ex.: Oben foi ao Omie,
      // Colacor falhou) NÃO pode ser cancelado — devolver os itens ao pool permitiria
      // re-agendá-los e criar pedido DUPLICADO real no ERP. Resolver no Omie primeiro
      // (excluir o pedido lá) ou reprocessar o restante com "Enviar agora".
      const { data: envioRow, error: envErr } = await t('pedidos_programados_envios')
        .select('sales_orders_map').eq('id', envioId).single();
      if (envErr) throw envErr;
      const mapa = ((envioRow as { sales_orders_map: Record<string, string> | null })?.sales_orders_map) ?? {};
      const salesOrderIds = Object.values(mapa);
      if (salesOrderIds.length > 0) {
        const { data: enviados, error: soErr } = await supabase
          .from('sales_orders')
          .select('id, account, omie_numero_pedido, omie_pedido_id')
          .in('id', salesOrderIds)
          .not('omie_pedido_id', 'is', null);
        if (soErr) throw soErr;
        if (enviados && enviados.length > 0) {
          const detalhe = enviados
            .map((s) => `${s.account} (PV ${s.omie_numero_pedido ?? s.omie_pedido_id})`)
            .join(', ');
          throw new Error(
            `Envio já criou pedido no Omie: ${detalhe}. Cancele/exclua o pedido no Omie antes, ou use "Enviar agora" para completar o restante.`,
          );
        }
      }
      const { error: e1 } = await t('pedidos_programados_itens')
        .update({ envio_id: null } as never)
        .eq('envio_id', envioId);
      if (e1) throw e1;
      const { error: e2 } = await t('pedidos_programados_envios')
        .update({ status: 'cancelado' } as never)
        .eq('id', envioId)
        .in('status', ['agendado', 'erro']);
      if (e2) throw e2;
      track('pedidos_programados.cancelar_envio');
    },
    onSuccess: () => { invalidar(); toast.success('Envio cancelado — itens voltaram ao pool.'); },
    onError: (e: Error) => toast.error(e.message),
  });

  const enviarAgora = useMutation({
    mutationFn: async (envioId: string) => {
      const { data, error } = await supabase.functions.invoke('pedido-programado-enviar', {
        body: { envio_id: envioId },
      });
      if (error) throw error;
      const r = (data?.resultados ?? [])[0] as { ok: boolean; motivo?: string } | undefined;
      if (r && !r.ok) throw new Error(r.motivo ?? 'Envio falhou');
      track('pedidos_programados.enviar_agora');
    },
    onSuccess: () => { invalidar(); toast.success('Enviado ao Omie.'); },
    onError: (e: Error) => { invalidar(); toast.error(e.message); },
  });

  const cancelarPedido = useMutation({
    mutationFn: async () => {
      // Cancela o PEDIDO (header) — fluxo de revisão de PDF (VERSAO nova substitui a antiga).
      // Guard: qualquer envio 'enviado' ou 'erro' (pode ter parcial no Omie) bloqueia;
      // envios 'agendado' são cancelados junto (itens voltam ao pool e morrem com o header).
      const { data: envios, error: envErr } = await t('pedidos_programados_envios')
        .select('id, status').eq('pedido_programado_id', pedidoId!);
      if (envErr) throw envErr;
      const rows = (envios ?? []) as unknown as Array<{ id: string; status: string }>;
      const travado = rows.find((e) => e.status === 'enviado' || e.status === 'erro');
      if (travado) {
        throw new Error(
          `Há envio ${travado.status} neste pedido — resolva-o (Omie/Enviar agora) antes de cancelar o pedido.`,
        );
      }
      const agendados = rows.filter((e) => e.status === 'agendado').map((e) => e.id);
      if (agendados.length > 0) {
        const { error: e1 } = await t('pedidos_programados_itens')
          .update({ envio_id: null } as never).in('envio_id', agendados);
        if (e1) throw e1;
        const { error: e2 } = await t('pedidos_programados_envios')
          .update({ status: 'cancelado' } as never).in('id', agendados);
        if (e2) throw e2;
      }
      const { error: e3 } = await t('pedidos_programados')
        .update({ status: 'cancelado' } as never).eq('id', pedidoId!);
      if (e3) throw e3;
      track('pedidos_programados.cancelar_pedido');
    },
    onSuccess: () => { invalidar(); toast.success('Pedido programado cancelado.'); },
    onError: (e: Error) => toast.error(e.message),
  });

  const salvarConfig = useMutation({
    mutationFn: async (cfg: PedidoProgramadoConfig) => {
      const { error } = await t('pedidos_programados_config').upsert(cfg as never, { onConflict: 'account' });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pedidos-programados-config'] });
      toast.success('Config salva.');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return { uploadPdf, atualizarItem, mapearItem, criarEnvio, cancelarEnvio, cancelarPedido, enviarAgora, salvarConfig };
}
