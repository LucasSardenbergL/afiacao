// Pedidos programados (Lider): queries + mutations da tela /sales/programados.
// Tabelas tipadas pelo types.ts gerado → `.from()` TIPADO do supabase-js (coluna, argumento e
// retorno checados pelo typecheck). Nenhum `as never`/`as unknown as`: o que o banco entrega
// como texto (`status`, `account`) viaja como `string` até a borda que precisa do union, e lá
// é ESTREITADO por guarda de tipo (`ehStatusEnvio`), nunca por cast.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Json, Tables, TablesUpdate } from '@/integrations/supabase/types';
import { toast } from 'sonner';
import { track } from '@/lib/analytics';
import { ilikeOr, isSearchablePostgrestTerm } from '@/lib/postgrest';
import { isOmieIncerto, type AccountPP } from '@/lib/pedidosProgramados/helpers';
import { ehStatusEnvio, type EnvioCalendario } from '@/lib/pedidosProgramados/calendario';

// Linha do banco como o types.ts a conhece. `status` é texto no banco
// ('extraindo' | 'erro_extracao' | 'ativo' | 'concluido' | 'cancelado'); as telas indexam
// `Record<string, …>` e comparam por igualdade, então o tipo largo é o honesto aqui.
type PedidoProgramado = Tables<'pedidos_programados'>;

export type ProdutoMapeado = Pick<
  Tables<'omie_products'>,
  'id' | 'omie_codigo_produto' | 'codigo' | 'descricao' | 'unidade' | 'account' | 'ativo'
>;
const COLUNAS_PRODUTO = 'id, omie_codigo_produto, codigo, descricao, unidade, account, ativo';

export interface PedidoProgramadoItem extends Tables<'pedidos_programados_itens'> {
  mapa: { id: string; ultimo_preco: number | null; omie_products: ProdutoMapeado | null } | null;
}

// 'processando' = claim transitório do edge (migration 20260704070000): o runner é o
// dono do envio até o release; cancelamentos (CAS em agendado/erro) não o enxergam.
type PedidoProgramadoEnvio = Tables<'pedidos_programados_envios'>;

export type PedidoProgramadoConfig = Omit<Tables<'pedidos_programados_config'>, 'account' | 'updated_at'> & {
  account: AccountPP;
};

// sales_orders_map é jsonb (`Json` no types): só o objeto {account: sales_order_id} é o
// contrato — qualquer outra forma (null, array, escalar) rende mapa vazio, sem cast.
function idsDoMapaDePedidos(j: Json | null): string[] {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return [];
  return Object.values(j).filter((v): v is string => typeof v === 'string');
}

function comoAccountPP(s: string | null | undefined): AccountPP | null {
  return s === 'oben' || s === 'colacor' ? s : null;
}

export function usePedidosProgramadosLista() {
  return useQuery({
    queryKey: ['pedidos-programados'],
    staleTime: 60_000,
    queryFn: async (): Promise<PedidoProgramado[]> => {
      const { data, error } = await supabase
        .from('pedidos_programados')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return data ?? [];
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
        supabase.from('pedidos_programados').select('*').eq('id', id!).single(),
        supabase
          .from('pedidos_programados_itens')
          .select(`*, mapa:cliente_item_mapa(id, ultimo_preco, omie_products(${COLUNAS_PRODUTO}))`)
          .eq('pedido_programado_id', id!)
          .order('data_entrega_cliente', { ascending: true, nullsFirst: false })
          .order('codigo_item_cliente', { ascending: true }),
        supabase
          .from('pedidos_programados_envios')
          .select('*')
          .eq('pedido_programado_id', id!)
          .order('data_envio', { ascending: true }),
      ]);
      if (header.error) throw header.error;
      if (itens.error) throw itens.error;
      if (envios.error) throw envios.error;
      const normalizados: PedidoProgramadoItem[] = (itens.data ?? []).map((it) => ({
        ...it,
        // numeric do PostgREST pode vir string — converter na borda (contrato do helpers.ts)
        quantidade: Number(it.quantidade),
        preco_pdf: it.preco_pdf === null ? null : Number(it.preco_pdf),
        preco_final: it.preco_final === null ? null : Number(it.preco_final),
        mapa: it.mapa
          ? { id: it.mapa.id, ultimo_preco: it.mapa.ultimo_preco, omie_products: it.mapa.omie_products ?? null }
          : null,
      }));
      const enviosDoPedido: PedidoProgramadoEnvio[] = envios.data ?? [];
      return {
        pedido: header.data,
        itens: normalizados,
        envios: enviosDoPedido,
      };
    },
  });
}

export function usePedidosProgramadosConfig() {
  return useQuery({
    queryKey: ['pedidos-programados-config'],
    staleTime: 60_000,
    queryFn: async (): Promise<PedidoProgramadoConfig[]> => {
      const { data, error } = await supabase.from('pedidos_programados_config').select('*');
      if (error) throw error;
      // `account` é texto no banco; a config só existe para as 2 contas do programa — linha
      // fora delas não tem tela e não entra (precisão > recall, sem fabricar conta).
      return (data ?? []).flatMap((c) => {
        const account = comoAccountPP(c.account);
        return account ? [{ ...c, account }] : [];
      });
    },
  });
}

// Calendário de faturamento: 1 query por mês visível ('YYYY-MM').
// queryKey com prefixo 'pedidos-programados' → invalidação automática pelas
// mutations existentes (invalidar() usa exatamente esse prefixo).
const CAPA_POSTGREST = 1000;

export function usePedidosProgramadosCalendario(mes: string) {
  return useQuery({
    queryKey: ['pedidos-programados', 'calendario', mes],
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const [ano, m] = mes.split('-').map(Number);
      const ultimoDia = new Date(ano, m, 0).getDate(); // dia 0 do mês seguinte = último do mês
      const { data, error } = await supabase
        .from('pedidos_programados_envios')
        // Literal ÚNICO: concatenado com `+` o supabase-js não infere as colunas (GenericStringError)
        .select(
          'id, pedido_programado_id, data_envio, status, erro_motivo, pedido:pedidos_programados(numero_pedido_compra), itens:pedidos_programados_itens(quantidade, preco_final, mapa:cliente_item_mapa(omie_products(account)))',
        )
        .gte('data_envio', `${mes}-01`)
        .lte('data_envio', `${mes}-${String(ultimoDia).padStart(2, '0')}`)
        .order('data_envio', { ascending: true })
        .limit(CAPA_POSTGREST);
      if (error) throw error;
      const rows = data ?? [];
      const envios: EnvioCalendario[] = rows.map((r) => {
        // Status fora do vocabulário do calendário: o banco mudou e esta tela não sabe
        // desenhá-lo — erro visível (react-query) em vez de dot/badge inventado.
        if (!ehStatusEnvio(r.status)) throw new Error(`Envio ${r.id} com status desconhecido: ${r.status}`);
        return {
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
            account: comoAccountPP(it.mapa?.omie_products?.account),
          })),
        };
      });
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
      // O `await` INLINE tornava o `error` inalcançável por construção (ninguém guardava a
      // resposta): uma falha de RLS/timeout saía como "nenhum produto encontrado" na tela de
      // mapeamento, e o operador amarraria o item do cliente ao SKU errado — ou criaria um
      // mapeamento novo para um produto que já existe. Guardar a resposta e lançar deixa o
      // react-query mostrar o erro em vez de uma lista vazia convincente.
      let sugestoes: ProdutoMapeado[] = [];
      if (codForn) {
        const resp = await supabase.from('omie_products').select(COLUNAS_PRODUTO).eq('codigo', codForn).limit(4);
        if (resp.error) throw resp.error;
        sugestoes = resp.data ?? [];
      }
      let busca: ProdutoMapeado[] = [];
      if (termoUtil) {
        const resp = await supabase
          .from('omie_products')
          .select(COLUNAS_PRODUTO)
          .or(ilikeOr(['codigo', 'descricao'], termo))
          .order('descricao', { ascending: true })
          .limit(20);
        if (resp.error) throw resp.error;
        busca = resp.data ?? [];
      }
      return { sugestoes, busca };
    },
  });
}

export function usePedidosProgramadosMutations(pedidoId?: string) {
  const qc = useQueryClient();
  const invalidar = () => {
    qc.invalidateQueries({ queryKey: ['pedidos-programados'] });
    if (pedidoId) qc.invalidateQueries({ queryKey: ['pedido-programado', pedidoId] });
  };

  // Devolve itens dos envios ao pool. Retorna false em vez de lançar quando usada
  // como LIMPEZA de um abort (o erro acionável é o do abort, não o da limpeza).
  const desanexarItens = async (envioIds: string[]): Promise<boolean> => {
    if (envioIds.length === 0) return true;
    const { error } = await supabase
      .from('pedidos_programados_itens')
      .update({ envio_id: null })
      .in('envio_id', envioIds);
    return !error;
  };
  const NOTA_LIMPEZA = ' Atenção: itens podem ter ficado presos em envio cancelado — recarregue.';

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
      const { data: header, error: insErr } = await supabase
        .from('pedidos_programados')
        .insert({ arquivo_path: path, created_by: uid, status: 'extraindo' })
        .select('id')
        .single();
      if (insErr || !header) throw insErr ?? new Error('Header não criado');
      const headerId = header.id;
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
      const patch: TablesUpdate<'pedidos_programados_itens'> = {};
      if (p.quantidade !== undefined) patch.quantidade = p.quantidade;
      if (p.preco_final !== undefined) patch.preco_final = p.preco_final;
      const { error } = await supabase.from('pedidos_programados_itens').update(patch).eq('id', p.id);
      if (error) throw error;
    },
    onSuccess: invalidar,
    onError: (e: Error) => toast.error(e.message),
  });

  const mapearItem = useMutation({
    mutationFn: async (p: { clienteRef: string; codigoItemCliente: string; omieProductId: string }) => {
      const { data: mapa, error: mapaErr } = await supabase
        .from('cliente_item_mapa')
        .upsert(
          { cliente_ref: p.clienteRef, codigo_item_cliente: p.codigoItemCliente, omie_product_id: p.omieProductId },
          { onConflict: 'cliente_ref,codigo_item_cliente' },
        )
        .select('id, ultimo_preco')
        .single();
      if (mapaErr || !mapa) throw mapaErr ?? new Error('De-para não salvo');
      // Aplica a TODOS os itens pendentes deste pedido com o mesmo código do cliente
      const { error: updErr } = await supabase
        .from('pedidos_programados_itens')
        .update({ mapa_id: mapa.id })
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
      const { data: envio, error: envErr } = await supabase
        .from('pedidos_programados_envios')
        .insert({ pedido_programado_id: pedidoId!, data_envio: p.dataEnvio })
        .select('id')
        .single();
      if (envErr || !envio) throw envErr ?? new Error('Envio não criado');
      const envioId = envio.id;
      // Anexa SÓ itens ainda livres (.is null) e confere a contagem via representation:
      // um item capturado por outra via no meio (re-anexo do edge, outro envio) não pode
      // entrar aqui — envio com item já enviado ao Omie duplicaria o PV no reenvio.
      const { data: anexados, error: updErr } = await supabase
        .from('pedidos_programados_itens')
        .update({ envio_id: envioId })
        .in('id', p.itens.map((i) => i.id))
        .is('envio_id', null)
        .select('id');
      if (updErr) throw updErr;
      if ((anexados ?? []).length !== p.itens.length) {
        // rollback: envio pela metade não pode ficar 'agendado' (o cron o enviaria parcial)
        const soltos = await desanexarItens([envioId]);
        const { error: cancErr } = await supabase
          .from('pedidos_programados_envios')
          .update({ status: 'cancelado' }).eq('id', envioId);
        throw new Error(
          'Alguns itens mudaram de estado enquanto você agendava (outro envio ou cancelamento em andamento) — recarregue e re-selecione.' +
          (soltos && !cancErr ? '' : NOTA_LIMPEZA),
        );
      }
      // Memória de preço: o preço final agendado vira o ultimo_preco do de-para
      for (const it of p.itens) {
        if (it.mapa_id && typeof it.preco_final === 'number' && it.preco_final > 0) {
          const { error: memErr } = await supabase
            .from('cliente_item_mapa')
            .update({ ultimo_preco: it.preco_final })
            .eq('id', it.mapa_id);
          if (memErr) throw memErr;
        }
      }
      track('pedidos_programados.criar_envio', { itens: p.itens.length });
      return envioId;
    },
    onSuccess: () => toast.success('Envio agendado.'),
    onError: (e: Error) => toast.error(e.message),
    // rollback parcial já mutou estado no banco → refetch sempre
    onSettled: invalidar,
  });

  const cancelarEnvio = useMutation({
    mutationFn: async (envioId: string) => {
      // Guard money-path: envio 'erro' PARCIALMENTE enviado (ex.: Oben foi ao Omie,
      // Colacor falhou) NÃO pode ser cancelado — devolver os itens ao pool permitiria
      // re-agendá-los e criar pedido DUPLICADO real no ERP. Resolver no Omie primeiro
      // (excluir o pedido lá) ou reprocessar o restante com "Enviar agora".
      const { data: envioAtual, error: envErr } = await supabase
        .from('pedidos_programados_envios')
        .select('status, erro_motivo, sales_orders_map').eq('id', envioId).single();
      if (envErr) throw envErr;
      // Claim ativo (edge processando AGORA): o CAS abaixo já barraria, mas a mensagem
      // dedicada explica o estado — e o watchdog devolve claim órfão pra 'erro' em ~15min.
      if (envioAtual.status === 'processando') {
        throw new Error(
          'Este envio está sendo processado agora (claim do runner) — aguarde o resultado. Se travar, o watchdog o devolve para "erro" em ~15 min.',
        );
      }
      // Incerteza-Omie persistida (marcador escrito pelo edge/watchdog): o PV pode existir
      // no ERP SEM omie_pedido_id gravado — o guard abaixo não o veria. Bloquear até resolver.
      if (isOmieIncerto(envioAtual.erro_motivo)) {
        throw new Error(
          'Este envio falhou SEM confirmação do Omie — o pedido pode existir lá sem registro aqui. Confira no Omie (ou use "Enviar agora", que é idempotente) antes de cancelar.',
        );
      }
      // PV real já criado? Vínculo AUTORITATIVO = coluna (UNIQUE, migration 20260704070000)
      // ∪ sales_orders_map legado: a união cobre a janela de deploy em que o edge velho
      // (que só escreve o map) ainda roda com a migration aplicada — e o caso de map
      // perdido (write falhou) que só a coluna enxerga. Precisão > recall.
      const idsDoMapa = idsDoMapaDePedidos(envioAtual.sales_orders_map);
      const [porColuna, porMapa] = await Promise.all([
        supabase
          .from('sales_orders')
          .select('id, account, omie_numero_pedido, omie_pedido_id')
          .eq('pedido_programado_envio_id', envioId)
          .not('omie_pedido_id', 'is', null),
        idsDoMapa.length > 0
          ? supabase
              .from('sales_orders')
              .select('id, account, omie_numero_pedido, omie_pedido_id')
              .in('id', idsDoMapa)
              .not('omie_pedido_id', 'is', null)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (porColuna.error) throw porColuna.error;
      if (porMapa.error) throw porMapa.error;
      const enviados = [...(porColuna.data ?? []), ...(porMapa.data ?? [])]
        .filter((s, i, arr) => arr.findIndex((x) => x.id === s.id) === i);
      if (enviados.length > 0) {
        const detalhe = enviados
          .map((s) => `${s.account} (PV ${s.omie_numero_pedido ?? s.omie_pedido_id})`)
          .join(', ');
        throw new Error(
          `Envio já criou pedido no Omie: ${detalhe}. Cancele/exclua o pedido no Omie antes, ou use "Enviar agora" para completar o restante.`,
        );
      }
      // TOCTOU: cancelar o envio PRIMEIRO, via compare-and-set (o filtro de status
      // re-verifica no banco) + .select p/ contar linhas — PostgREST não erra em
      // UPDATE de 0 linhas. Só desanexa itens depois do CAS confirmar; na ordem
      // antiga, um envio que virasse 'enviado' no meio devolvia itens JÁ ENVIADOS
      // ao pool → envio novo → sales_order novo → PV_ novo → duplicata real no Omie.
      const { data: cas, error: e2 } = await supabase
        .from('pedidos_programados_envios')
        .update({ status: 'cancelado' })
        .eq('id', envioId)
        .in('status', ['agendado', 'erro'])
        .select('id');
      if (e2) throw e2;
      if ((cas ?? []).length !== 1) {
        throw new Error('Este envio mudou de estado enquanto você decidia (cron/Enviar agora) — recarregue e confira antes de repetir.');
      }
      if (!(await desanexarItens([envioId]))) {
        throw new Error('Envio cancelado, mas os itens não voltaram ao pool.' + NOTA_LIMPEZA);
      }
      track('pedidos_programados.cancelar_envio');
    },
    onSuccess: () => toast.success('Envio cancelado — itens voltaram ao pool.'),
    onError: (e: Error) => toast.error(e.message),
    // abort pós-CAS já mutou estado no banco → refetch sempre, não só no sucesso
    onSettled: invalidar,
  });

  const enviarAgora = useMutation({
    mutationFn: async (envioId: string) => {
      const { data, error } = await supabase.functions.invoke('pedido-programado-enviar', {
        body: { envio_id: envioId },
      });
      if (error) throw error;
      const r = (data?.resultados ?? [])[0] as { ok: boolean; motivo?: string } | undefined;
      // r ausente = o edge não achou o envio em status processável (cancelado/enviado
      // por outra via na corrida) — sucesso silencioso aqui seria toast mentiroso.
      if (!r) throw new Error('Este envio não está mais agendado/erro (enviado, cancelado ou em processamento por outra via) — recarregue.');
      if (!r.ok) throw new Error(r.motivo ?? 'Envio falhou');
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
      const { data: envios, error: envErr } = await supabase
        .from('pedidos_programados_envios')
        .select('id, status').eq('pedido_programado_id', pedidoId!);
      if (envErr) throw envErr;
      const rows = envios ?? [];
      // 'processando' bloqueia como 'enviado'/'erro': é o edge criando PV no Omie AGORA
      // (claim) — sem isto o header cancelaria com envio em voo.
      const travado = rows.find((e) => e.status === 'enviado' || e.status === 'erro' || e.status === 'processando');
      if (travado) {
        throw new Error(
          travado.status === 'processando'
            ? 'Há envio sendo processado agora neste pedido (indo ao Omie) — aguarde o resultado antes de cancelar.'
            : `Há envio ${travado.status} neste pedido — resolva-o (Omie/Enviar agora) antes de cancelar o pedido.`,
        );
      }
      const agendados = rows.filter((e) => e.status === 'agendado').map((e) => e.id);
      // TOCTOU: 3 barreiras compare-and-set, desanexo dos itens por ÚLTIMO (janela
      // de pool mínima). Qualquer abort no meio desanexa só o que NÓS cancelamos
      // (limpeza) e deixa header/estado do concorrente intactos.
      let cancelados: string[] = [];
      if (agendados.length > 0) {
        // Barreira 1: cancela envios re-condicionando o status no banco. Se o cron
        // enviou um deles entre o SELECT e aqui, ele NÃO volta no representation.
        const { data: cas, error: e2 } = await supabase
          .from('pedidos_programados_envios')
          .update({ status: 'cancelado' })
          .in('id', agendados)
          .eq('status', 'agendado')
          .select('id');
        if (e2) throw e2;
        cancelados = (cas ?? []).map((r) => r.id);
        if (cancelados.length !== agendados.length) {
          const limpo = await desanexarItens(cancelados);
          throw new Error(
            'Um envio mudou de estado durante o cancelamento (o cron pode tê-lo enviado agora) — recarregue e confira os envios antes de repetir.' +
            (limpo ? '' : NOTA_LIMPEZA),
          );
        }
      }
      // Barreira 2: envio novo criado (ou claim iniciado) por outra via entre o guard
      // e aqui. Predicado positivo (sem negação NULL-blind — regra PostgREST do repo).
      const { data: restantes, error: eRest } = await supabase
        .from('pedidos_programados_envios')
        .select('id')
        .eq('pedido_programado_id', pedidoId!)
        .in('status', ['agendado', 'processando', 'enviado', 'erro']);
      if (eRest) throw eRest;
      if ((restantes ?? []).length > 0) {
        const limpo = await desanexarItens(cancelados);
        throw new Error(
          'Surgiu um envio novo neste pedido durante o cancelamento — recarregue e resolva-o antes de cancelar.' +
          (limpo ? '' : NOTA_LIMPEZA),
        );
      }
      // Barreira 3: o header só cancela se ainda está num status cancelável pela UI.
      const { data: casHeader, error: e3 } = await supabase
        .from('pedidos_programados')
        .update({ status: 'cancelado' })
        .eq('id', pedidoId!)
        .in('status', ['ativo', 'erro_extracao'])
        .select('id');
      if (e3) throw e3;
      if ((casHeader ?? []).length !== 1) {
        const limpo = await desanexarItens(cancelados);
        throw new Error('O pedido mudou de estado durante o cancelamento — recarregue.' + (limpo ? '' : NOTA_LIMPEZA));
      }
      // Itens ao pool só com TODAS as barreiras passadas (o pedido já está cancelado;
      // se falhar aqui, os itens morrem presos com ele — sem risco de re-agendamento).
      await desanexarItens(cancelados);
      track('pedidos_programados.cancelar_pedido');
    },
    onSuccess: () => toast.success('Pedido programado cancelado.'),
    onError: (e: Error) => toast.error(e.message),
    // abort entre barreiras já mutou estado no banco → refetch sempre
    onSettled: invalidar,
  });

  const salvarConfig = useMutation({
    mutationFn: async (cfg: PedidoProgramadoConfig) => {
      const { error } = await supabase.from('pedidos_programados_config').upsert(cfg, { onConflict: 'account' });
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
