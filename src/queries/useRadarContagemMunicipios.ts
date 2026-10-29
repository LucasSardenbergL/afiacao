import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { comNulo } from '@/lib/rpc-args';
import { fetchAllPages, likePrefixPattern } from '@/lib/postgrest';
import { presetParaParams, digitosCnae } from '@/lib/radar/ui-helpers';
import { recorteDeLote, type LoteIngest, type RecorteLote } from '@/lib/radar/lote-vigente';
import { lerLoteVigente } from '@/queries/useRadarLoteVigente';
import { filtrarSugeridos } from '@/queries/useRadarSugeridos';
import type { RadarFiltros } from '@/queries/useRadarLista';

export interface RadarMunicipioContagem {
  municipio_codigo: string;
  municipio_nome: string;
  uf: string;
  lat: number | null;
  lng: number | null;
  total: number;
  com_telefone: number;
  a_contatar: number;
}

// Agrega por município respeitando os filtros ESTRUTURAIS (não a busca textual livre —
// busca por nome é p/ achar 1 empresa, não p/ ranking geográfico; omitir evita o ILIKE '%%' full-scan).
// Alimenta ranking ("onde caçar") + totalizador + mapa — um backend, três usos.
//
// Universo = o da FILA: o recorte de lote (foto vigente / só inéditos / incluir quem saiu) é o
// mesmo `recorteDeLote` de `useRadarLista`, sobre o lote lido por `lerLoteVigente` (mesma chave
// e cache) — ranking e mapa não recomputam "qual é o lote". Sem isto o totalizador contava os
// 52.011 que saíram do dump de 2026-08 (São Paulo 26.794 no ranking × 24.910 na fila).
export function useRadarContagemMunicipios(filtros: RadarFiltros, hojeISO: string, enabled: boolean) {
  const qc = useQueryClient();
  const p = presetParaParams(filtros.preset, hojeISO);
  const cnae = digitosCnae(filtros.cnae);
  const params = {
    p_uf: filtros.uf || null,
    p_cnae_exato: cnae.length === 7 ? cnae : null,
    p_cnae_prefix: cnae.length > 0 && cnae.length < 7 ? cnae : null,
    p_status: filtros.status || null,
    p_incluir_ja_clientes: filtros.incluirJaClientes,
    p_data_abertura_min: p.dataAberturaMin,
    p_data_abertura_max: p.dataAberturaMax,
    p_limit: 500,
  };
  const modoLote = { incluirSaiuDoDump: filtros.incluirSaiuDoDump, soIneditos: filtros.soIneditos };
  return useQuery({
    queryKey: ['radar', 'contagem-municipios', params, modoLote, filtros.soSugeridos],
    enabled,
    queryFn: async (): Promise<RadarMunicipioContagem[]> => {
      // Se a leitura do lote falha, o ranking falha junto — contar sem saber o lote seria
      // voltar a contar a foto velha.
      const lote = await lerLoteVigente(qc);
      const recorte = recorteDeLote(lote, modoLote);
      // "Só sugeridos": o MESMO predicado da fila e do card (`filtrarSugeridos`), agregado aqui —
      // a RPC não o conhece, e repeti-lo em SQL abriria um 2º lugar para divergir. O universo é
      // pequeno por construção (exige `em_conversa`; 0 sugeridos e 1 em conversa em prod,
      // 2026-10-21). Sem lote completo não há sugestão: falha como a fila, nunca conta a foto geral.
      if (filtros.soSugeridos) {
        if (!lote) throw new Error('Sem lote completo da RFB: "só sugeridos" fica indisponível até a carga do lote terminar.');
        return contarSugeridosPorMunicipio(lote, recorte, {
          uf: params.p_uf, cnaeExato: params.p_cnae_exato, cnaePrefixo: params.p_cnae_prefix,
          dataAberturaMin: params.p_data_abertura_min, dataAberturaMax: params.p_data_abertura_max,
        });
      }
      // NULL explícito em todo filtro ausente (os testes do lote vigente fixam esse contrato: o
      // recorte "sem lote" é NULL dito, não default implícito). Os args têm DEFAULT NULL na prod.
      type FiltroNulo =
        | 'p_uf' | 'p_cnae_exato' | 'p_cnae_prefix' | 'p_status'
        | 'p_data_abertura_min' | 'p_data_abertura_max' | 'p_lote' | 'p_primeira_vista_min';
      const { data, error } = await supabase.rpc(
        'radar_contagem_por_municipio',
        comNulo<'radar_contagem_por_municipio', FiltroNulo>({
          ...params,
          p_lote: recorte.ultimoLote,
          p_primeira_vista_min: recorte.primeiraVistaMin,
        }),
      );
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 60_000,
  });
}

export interface RadarMunicipioPenetracao {
  municipio_codigo: string;
  municipio_nome: string | null;
  uf: string;
  lat: number | null;
  lng: number | null;
  /** Empresas do LOTE VIGENTE no município (o mercado). null = município sem denominador. */
  empresas_lote: number | null;
  clientes: number | null;
  /** clientes / empresas_lote. null quando não há denominador — nunca 0%. */
  penetracao: number | null;
  /** Revendas de tinta/verniz. null = lote sem camada de concorrentes publicada (≠ zero revendas). */
  concorrentes: number | null;
}

/** Penetração por município (clientes ÷ empresas do lote vigente) + concorrentes, pela RPC
 *  `radar_penetracao_por_municipio`. Segue só a UF dos filtros: o denominador é o mercado do lote
 *  inteiro, não o recorte de CNAE/status da fila. Sem lote completo devolve null (camada indisponível),
 *  nunca uma penetração calculada sobre a foto velha. */
export function useRadarPenetracaoMunicipios(uf: string | null, enabled: boolean) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['radar', 'penetracao-municipios', uf],
    enabled,
    queryFn: async (): Promise<RadarMunicipioPenetracao[] | null> => {
      const lote = await lerLoteVigente(qc);
      if (!lote) return null;
      const { data, error } = await supabase.rpc(
        'radar_penetracao_por_municipio',
        comNulo<'radar_penetracao_por_municipio', 'p_uf'>({ p_lote: lote.mes_referencia, p_uf: uf, p_limit: 500 }),
      );
      if (error) throw error;
      return (data ?? []) as RadarMunicipioPenetracao[];
    },
    staleTime: 60_000,
  });
}

export type FaixaPenetracao = 'sem_cliente' | 'abaixo' | 'acima' | 'sem_dado';

/** Penetração do conjunto, PONDERADA (Σ clientes ÷ Σ empresas), só sobre quem tem denominador.
 *  null se ninguém tem — a média de nada não é 0%. */
export function penetracaoMedia(dados: readonly RadarMunicipioPenetracao[]): number | null {
  let clientes = 0;
  let empresas = 0;
  for (const m of dados) {
    if (m.empresas_lote == null || m.empresas_lote <= 0 || m.clientes == null) continue;
    clientes += m.clientes;
    empresas += m.empresas_lote;
  }
  return empresas > 0 ? clientes / empresas : null;
}

/** Faixa de um município contra a média do conjunto. `sem_cliente` é zero COM denominador (mercado sem
 *  nenhum cliente); `sem_dado` é ausência de denominador ou de média. */
export function faixaPenetracao(m: RadarMunicipioPenetracao, media: number | null): FaixaPenetracao {
  if (m.penetracao == null || media == null) return 'sem_dado';
  if (m.penetracao === 0) return 'sem_cliente';
  return m.penetracao < media ? 'abaixo' : 'acima';
}

/** "Onde o mercado é grande e a penetração é baixa": municípios com denominador e penetração abaixo da
 *  média, do maior mercado para o menor. Quem não tem denominador fica de fora — não é oportunidade
 *  medida, é ausência de dado. */
export function oportunidadesPenetracao(
  dados: readonly RadarMunicipioPenetracao[],
  n: number,
): RadarMunicipioPenetracao[] {
  const media = penetracaoMedia(dados);
  if (media == null) return [];
  return dados
    .filter((m) => m.penetracao != null && m.empresas_lote != null && m.penetracao < media)
    .sort((a, b) => (b.empresas_lote ?? 0) - (a.empresas_lote ?? 0) || a.municipio_codigo.localeCompare(b.municipio_codigo))
    .slice(0, n);
}

/** Penetração em % com 1 casa (pt-BR). null → '—' (sem denominador ≠ 0%). */
export function formatarPenetracao(p: number | null): string {
  if (p == null) return '—';
  return `${(p * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}

const LIMITE_MUNICIPIOS = 500;      // o mesmo p_limit da RPC

interface FiltrosEstruturais {
  uf: string | null;
  cnaeExato: string | null;
  cnaePrefixo: string | null;
  dataAberturaMin: string | null;
  dataAberturaMax: string | null;
}

/** Ranking/mapa sob "só sugeridos": as linhas que `filtrarSugeridos` aceita (+ os filtros estruturais
 *  que a RPC aplica: UF, CNAE, datas do preset; + o recorte de inéditos), agregadas por município com a
 *  mesma forma e ordem da RPC (total desc, código). Leitura por `fetchAllPages` (ordem estável por
 *  CNPJ): página perdida LANÇA — contagem parcial seria um número menor fabricado. */
async function contarSugeridosPorMunicipio(
  lote: LoteIngest,
  recorte: RecorteLote,
  f: FiltrosEstruturais,
): Promise<RadarMunicipioContagem[]> {
  const prefixo = f.cnaePrefixo ? likePrefixPattern(f.cnaePrefixo) : null;
  const linhas = await fetchAllPages((de, ate) => {
    let q = supabase
      .from('radar_empresas')
      .select('municipio_codigo,municipio_nome,uf,telefone1,telefone2,prospeccao_status');
    q = filtrarSugeridos(q, lote);
    if (f.uf) q = q.eq('uf', f.uf);
    if (f.cnaeExato) q = q.eq('cnae_principal', f.cnaeExato);
    else if (prefixo) q = q.like('cnae_principal', prefixo);
    if (f.dataAberturaMin) q = q.gte('data_abertura', f.dataAberturaMin);
    if (f.dataAberturaMax) q = q.lte('data_abertura', f.dataAberturaMax);
    if (recorte.primeiraVistaMin) q = q.gte('primeira_vista_em', recorte.primeiraVistaMin);
    return q.order('cnpj').range(de, ate);
  }, 'radar_empresas/ranking-sugeridos');

  const porMunicipio = new Map<string, RadarMunicipioContagem>();
  for (const l of linhas) {
    const codigo = l.municipio_codigo ?? '';
    const chave = `${codigo}|${l.uf ?? ''}`;
    const atual = porMunicipio.get(chave) ?? {
      municipio_codigo: codigo, municipio_nome: l.municipio_nome ?? '', uf: l.uf ?? '',
      lat: null, lng: null, total: 0, com_telefone: 0, a_contatar: 0,
    };
    atual.total += 1;
    if (l.telefone1 != null || l.telefone2 != null) atual.com_telefone += 1;
    if (l.prospeccao_status === 'a_contatar') atual.a_contatar += 1;
    porMunicipio.set(chave, atual);
  }
  // Corta ANTES de buscar coordenadas: no máximo 500 códigos no `.in()` (URL e leitura limitadas).
  const topo = [...porMunicipio.values()]
    .sort((a, b) => b.total - a.total || a.municipio_codigo.localeCompare(b.municipio_codigo))
    .slice(0, LIMITE_MUNICIPIOS);
  const codigos = [...new Set(topo.map((c) => c.municipio_codigo).filter(Boolean))];
  if (codigos.length > 0) {
    const geo = await fetchAllPages(
      (de, ate) => supabase.from('radar_municipios').select('codigo,nome,lat,lng').in('codigo', codigos).order('codigo').range(de, ate),
      'radar_municipios/ranking-sugeridos',
    );
    const porCodigo = new Map(geo.map((m) => [m.codigo, m]));
    for (const c of topo) {
      const m = porCodigo.get(c.municipio_codigo);
      if (m) { c.municipio_nome = m.nome ?? c.municipio_nome; c.lat = m.lat; c.lng = m.lng; }
    }
  }
  return topo;
}
