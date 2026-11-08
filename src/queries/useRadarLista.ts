import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { isSearchablePostgrestTerm, sanitizeForPostgrestOr } from '@/lib/postgrest';
import { presetParaParams, digitosCnae, cnaeSecundarioCompleto, versaoDaFila, recorteDeUf, type PresetRadar, type RegiaoRadar } from '@/lib/radar/ui-helpers';
import { lerLoteVigente, useRadarLoteVigente } from '@/queries/useRadarLoteVigente';
import { recorteDeLote, type LoteIngest } from '@/lib/radar/lote-vigente';
import { LIMIAR_SUGERIDO } from '@/lib/radar/sugeridos';
import type { Database } from '@/integrations/supabase/types';

export type RadarEmpresa = Database['public']['Tables']['radar_empresas']['Row'];

export interface RadarFiltros {
  busca: string;
  uf: string;            // '' = todas
  municipio: string;     // '' = todos
  cnae: string;          // '' = todos — CNAE PRINCIPAL (código completo = exato; parcial = família)
  status: string;        // '' = qualquer; senão um prospeccao_status
  incluirJaClientes: boolean;
  comTelefone: boolean;  // só empresas com telefone1 OU telefone2
  preset: PresetRadar;
  incluirSaiuDoDump: boolean; // default false: a fila é a FOTO VIGENTE (ultimo_lote = lote vigente)
  soIneditos: boolean;        // só quem entrou no universo NESTE lote (primeira_vista_em >= iniciado_em)
  soSugeridos: boolean;       // só os "sugeridos para cadastro" (predicado do card: em conversa · não cliente · score ≥ limiar · foto vigente)
  // Opcionais: quem monta RadarFiltros sem eles (ranking, mapa, testes antigos) recebe o recorte de antes.
  regiao?: RegiaoRadar;        // 'atuacao' = MG e vizinhos (default da TELA); ausente/'brasil' = todas as UFs. UF escolhida vence.
  incluirSemContato?: boolean; // false (default da tela) = esconde quem não tem telefone NEM e-mail
  cnaeSecundario?: string;     // CNAE entre os SECUNDÁRIOS (só código completo filtra); combina com `cnae` (E)
  // Cidade escolhida no ranking/mapa: o CÓDIGO RFB (4 dígitos), filtro exato. Quando presente vence `municipio`
  // (que fica só como rótulo): o nome se repete entre UFs — "SANTA LUZIA" de MG trazia a da BA.
  municipioCodigo?: string;
  // "Para visitar" (migration 20261109140000): todo contato do lead tem indício de contabilidade e há endereço. O
  // recorte é do SERVIDOR (p_so_visitar), antes da paginação. Ausente = a fila de antes.
  paraVisitar?: boolean;
}

const PAGE = 50;

/**
 * Filtros da visão "Meus atendimentos" (pacote B2): NEUTROS. A visão é "o que eu assumi", não um recorte da fila —
 * um lead assumido que é já-cliente, de fora da região, de lote antigo ou sem contato continua sendo meu. Só os
 * descartados ficam de fora (o default da RPC). O recorte "é meu" vem de `p_so_meus`, NO SERVIDOR.
 */
export const FILTROS_MEUS_ATENDIMENTOS: RadarFiltros = {
  busca: '', uf: '', municipio: '', municipioCodigo: '', cnae: '', cnaeSecundario: '', status: '',
  incluirJaClientes: true, comTelefone: false, preset: 'score',
  incluirSaiuDoDump: true, soIneditos: false, soSugeridos: false,
  regiao: 'brasil', incluirSemContato: true,
};

/** Id da rodada mais recente do score (ledger `radar.score_recalcular`). Revisado a cada 10 min: a rodada
 *  diária (03:30 BRT) ou uma manual troca a versão da fila e reinicia a paginação. */
function useRadarRodadaScore() {
  return useQuery({
    queryKey: ['radar', 'rodada-score'],
    refetchInterval: 10 * 60_000,
    retry: 1,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('acoes_execucoes')
        .select('id')
        .eq('acao', 'radar.score_recalcular')
        .eq('status', 'sucesso')
        .order('iniciado_em', { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      return data?.[0]?.id ?? null;
    },
  });
}

/** Identidade de um lote para a paginação: mês E início da carga (recarga do mesmo mês é outra foto). */
export const identidadeDoLote = (l: { mes_referencia: string; iniciado_em: string } | null) =>
  l ? `${l.mes_referencia}@${l.iniciado_em}` : 'sem-lote';

type ParametrosLista = Database['public']['Functions']['radar_lista']['Args'];

/**
 * Os filtros da tela → argumentos da RPC `radar_lista` (migration 20261103131500). A lista lia
 * `radar_empresas` pelo PostgREST; sob o RLS da tabela o ILIKE da busca (não-leakproof) não vira
 * condição de índice e cada busca era seq scan dos 731 MB (medido em prod 2026-11-03). A RPC roda
 * como dono, com o mesmo gate da policy, e aplica estes mesmos recortes — `undefined` = sem filtro
 * (o supabase-js omite a chave e o parâmetro cai no DEFAULT NULL).
 */
export function parametrosDaLista(
  filtros: RadarFiltros,
  lote: LoteIngest | null,
  hojeISO: string,
  pagina: number,
  soMeus = false,
): ParametrosLista {
  const p = presetParaParams(filtros.preset, hojeISO);
  // A RPC só ordena DESC NULLS LAST (todos os presets de hoje). Preset novo ascendente tem de mudar a RPC
  // antes — virar a fila em silêncio seria pior que falhar.
  if (p.orderAsc) throw new Error(`radar_lista não ordena ascendente (preset ${filtros.preset})`);
  // Termo: o mesmo sanitizador do `.or()` de antes; só-wildcard (`*`/`%%`) sanitiza pra vazio = lista base (#1062).
  const termo = (t: string) => (isSearchablePostgrestTerm(t.trim()) ? sanitizeForPostgrestOr(t.trim()) : undefined);
  const recorteUf = recorteDeUf(filtros);
  // CNAE: o banco guarda 7 dígitos puros; o usuário digita o formato oficial (3101-2/00). Completo (7) =
  // match exato; parcial = a família (prefixo).
  const cnaeDigitos = digitosCnae(filtros.cnae);
  // "Só sugeridos" é o predicado do card "Sugeridos para cadastro" (`filtrarSugeridos`): fixa
  // status/ja_cliente/lote na RPC e vence os filtros de status. Sem lote completo o hook já falhou antes.
  const sugeridos = lote && filtros.soSugeridos ? lote : null;
  // Foto VIGENTE / só inéditos / incluir quem saiu: o MESMO recorte do ranking e do mapa (`recorteDeLote`).
  const recorte = recorteDeLote(lote, filtros);
  return {
    p_busca: termo(filtros.busca),
    // Município: o banco guarda em MAIÚSCULAS (dump RFB); ILIKE parcial. Limitação conhecida: não é
    // acento-insensitive ("sao" não casa "SÃO") — v2 com unaccent. Cidade escolhida pelo código: exata, e o
    // nome digitado sai (código mal formado vai assim mesmo: a RPC grita 22023 em vez de contar zero).
    p_municipio: filtros.municipioCodigo ? undefined : termo(filtros.municipio),
    p_municipio_codigo: filtros.municipioCodigo || undefined,
    p_uf: recorteUf.tipo === 'uf' ? recorteUf.uf : undefined,
    p_ufs: recorteUf.tipo === 'lista' ? [...recorteUf.ufs] : undefined,
    p_cnae_exato: cnaeDigitos.length === 7 ? cnaeDigitos : undefined,
    p_cnae_prefixo: cnaeDigitos.length > 0 && cnaeDigitos.length < 7 ? cnaeDigitos : undefined,
    p_cnae_secundario: cnaeSecundarioCompleto(filtros.cnaeSecundario) ?? undefined,
    p_status: !sugeridos && filtros.status ? filtros.status : undefined,
    p_incluir_ja_clientes: !sugeridos && filtros.incluirJaClientes,
    p_ultimo_lote: !sugeridos && recorte.ultimoLote ? recorte.ultimoLote : undefined,
    p_primeira_vista_min: recorte.primeiraVistaMin ?? undefined,
    p_sugeridos_lote: sugeridos ? sugeridos.mes_referencia : undefined,
    p_sugeridos_score_min: sugeridos ? LIMIAR_SUGERIDO : undefined,
    // "com telefone" / "sem contato" escondido (só `false` explícito esconde; ausente = recorte antigo).
    p_com_telefone: filtros.comTelefone,
    p_com_contato: filtros.incluirSemContato === false,
    p_data_abertura_min: p.dataAberturaMin ?? undefined,
    p_data_abertura_max: p.dataAberturaMax ?? undefined,
    p_ordem: p.orderColumn,
    p_offset: pagina * PAGE,
    p_limit: PAGE,
    // "Meus atendimentos" (B2, migration 20261106212329): o recorte é do servidor, ANTES da paginação — filtrar os
    // 50 carregados daria falso vazio. Na fila vai `undefined` (a chave some): a chamada da fila é a de antes e não
    // depende da migration.
    p_so_meus: soMeus ? true : undefined,
    // Idem "para visitar": fora do chip, a chave some e a chamada é a de antes.
    p_so_visitar: filtros.paraVisitar ? true : undefined,
  };
}

/** Chave das páginas da visão "Meus atendimentos" (7º elemento da queryKey da lista). */
export const CHAVE_VISAO_MEUS = 'meus';

export function useRadarLista(
  filtros: RadarFiltros,
  hojeISO: string,
  opcoes: { soMeus?: boolean; aguardar?: boolean } = {},
) {
  const soMeus = opcoes.soMeus === true;
  // `aguardar`: o chamador ainda não sabe o recorte (ex.: o território do vendedor, pacote F) — buscar agora seria
  // buscar a fila ERRADA e jogá-la fora em seguida.
  const aguardar = opcoes.aguardar === true;
  const qc = useQueryClient();
  const rodada = useRadarRodadaScore();
  const versao = versaoDaFila(filtros.preset, rodada.data);
  // A paginação é presa ao LOTE (Codex, código 2026-10-20, achado 5): o lote entra na chave, então
  // quando o vigente vira a fila recomeça do topo em vez de colar páginas de setembro nas de agosto.
  // Mesma chave/cache do `lerLoteVigente` — observar aqui não custa leitura extra.
  const qLote = useRadarLoteVigente();
  const loteDaChave = qLote.data === undefined ? 'sem-leitura' : identidadeDoLote(qLote.data);
  return useInfiniteQuery({
    queryKey: ['radar', 'lista', filtros, hojeISO, versao, loteDaChave, soMeus ? CHAVE_VISAO_MEUS : 'fila'],
    // Fila por score espera a versão (sucesso OU erro) para não buscar duas vezes na abertura; leitura do
    // ledger que falha degrada para 'sem-rodada' — a lista continua, só sem o reinício automático.
    // Idem o lote: espera a 1ª leitura assentar (sucesso OU erro — no erro a própria lista falha ao
    // reler, como antes), senão a abertura buscaria a página 0 duas vezes.
    enabled: !aguardar && (filtros.preset !== 'score' || !rodada.isPending) && !qLote.isPending,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      // Lote vigente ANTES de montar a query: mesma chave/cache do `useRadarLoteVigente`
      // (lido uma vez, não por componente). Se a leitura do lote falha, a lista falha junto —
      // mostrar a fila sem saber o lote seria mostrar a foto velha de novo (52.011 leads com
      // ultimo_lote=2026-05 na fila de 2026-08, medido 2026-10-19).
      const lote = await lerLoteVigente(qc);
      // Corrida: a página SEGUINTE releu o lote (cache vencido) e ele já é outro, mas a chave ainda
      // não mudou. Montá-la colaria o lote novo nas páginas do velho — recusa; a troca de chave que
      // vem logo atrás recomeça a fila do topo.
      if ((pageParam as number) > 0 && identidadeDoLote(lote) !== loteDaChave) {
        throw new Error('O lote vigente da RFB mudou durante a rolagem — a fila recomeça do topo.');
      }
      // "Só sugeridos" sem lote completo: não há foto, logo não há sugestão (`ehSugerido(e, null)`
      // recusa todos). Ignorar o toggle mostraria a fila GERAL sob o rótulo (Codex, código
      // 2026-10-20) — a lista FALHA com o motivo antes de montar a consulta, inclusive via URL.
      if (filtros.soSugeridos && !lote) {
        throw new Error('Sem lote completo da RFB: "só sugeridos" fica indisponível até a carga do lote terminar.');
      }
      // A RPC pagina e ordena (preset DESC NULLS LAST, cnpj): um `.order()` aqui REORDENARIA a página.
      const { data, error } = await supabase.rpc('radar_lista', parametrosDaLista(filtros, lote, hojeISO, pageParam as number, soMeus));
      if (error) throw error;
      return data as RadarEmpresa[];
    },
    getNextPageParam: (last, pages) => (last.length === PAGE ? pages.length : undefined),
    staleTime: 30_000,
  });
}
