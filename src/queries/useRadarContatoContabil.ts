import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { lerContatoContabil, type CampoContato, type LeituraContatoContabil } from '@/lib/radar/contato-contabil';
import { useRadarLista, type RadarFiltros } from '@/queries/useRadarLista';
import {
  formatarContadoEm, paramsDaContagem, type FiltroNuloContagem, type RadarMunicipioContagem,
} from '@/queries/useRadarContagemMunicipios';
import { recorteDeLote } from '@/lib/radar/lote-vigente';
import { lerLoteVigente } from '@/queries/useRadarLoteVigente';
import { comNulo } from '@/lib/rpc-args';

const chave = (cnpj: string | null) => ['radar', 'contato-contabil', cnpj] as const;
/** O que muda quando o vendedor corrige: a ficha, o card e — só sob o chip "para visitar" — a fila. */
const PREFIXOS_RELER = [['radar', 'prospectar-hoje']] as const;
/** A correção muda quem é "para visitar"; as outras filas não dependem dela (a linha não muda): não relê. */
const ehFilaParaVisitar = (k: readonly unknown[]) => (k[2] as RadarFiltros | undefined)?.paraVisitar === true;

/**
 * Por contato ATUAL do lead (telefone1, telefone2, e-mail): é da contabilidade? (RPC
 * `radar_contato_contabil_da_empresa`, migration 20261109140000). Erro de leitura é `isError` — a ficha diz que não
 * conseguiu verificar, nunca "contato direto".
 */
export function useRadarContatoContabil(cnpj: string | null) {
  return useQuery({
    queryKey: chave(cnpj),
    enabled: !!cnpj,
    staleTime: 10 * 60_000,
    retry: 1,
    queryFn: async (): Promise<LeituraContatoContabil> => {
      // No máximo 3 linhas (telefone1, telefone2, e-mail); o range explicita o teto.
      const { data, error } = await supabase
        .rpc('radar_contato_contabil_da_empresa', { p_cnpj: cnpj as string })
        .range(0, 2);
      if (error) throw error;
      return lerContatoContabil(data);
    },
  });
}

export interface CorrecaoContabil {
  cnpj: string;
  campo: CampoContato;
  /** true = é da contabilidade · false = não é · null = voltar ao automático. */
  veredito: boolean | null;
  /** A correção que estava na tela (a RPC recusa sobrescrever uma mais nova). */
  correcaoVista: number | null;
  /** O que o automático dizia (sensor de acerto no PostHog; o ledger grava o do servidor). */
  automatico: boolean | null;
}

type RespostaCorrecao = { ok: true; semMudanca: boolean } | { ok: false; motivo: string };

function lerRespostaCorrecao(data: unknown): RespostaCorrecao {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('radar_contato_contabil_corrigir: resposta fora da forma esperada');
  }
  const d = data as Record<string, unknown>;
  if (d.ok === true) return { ok: true, semMudanca: d.sem_mudanca === true };
  if (d.ok === false && typeof d.motivo === 'string') return { ok: false, motivo: d.motivo };
  throw new Error('radar_contato_contabil_corrigir: resposta fora da forma esperada (ok)');
}

/** "É / não é da contabilidade" — o único escritor é a RPC `radar_contato_contabil_corrigir` (ledger append-only). */
export function useCorrigirContatoContabil() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: CorrecaoContabil): Promise<RespostaCorrecao> => {
      const { data, error } = await supabase.rpc('radar_contato_contabil_corrigir', {
        p_cnpj: v.cnpj, p_campo: v.campo,
        // O tipo gerado diz `boolean`, mas o SQL aceita NULL de propósito: NULL = "desfazer", volta ao automático.
        p_veredito: v.veredito as boolean,
        // Omitir = DEFAULT NULL (nenhuma correção vista) — o mesmo que mandar null.
        p_correcao_vista: v.correcaoVista ?? undefined,
      });
      if (error) throw error;
      return lerRespostaCorrecao(data);
    },
    onSuccess: (r, v) => {
      track('radar.contato_contabil_corrigido', {
        campo: v.campo, veredito: v.veredito, automatico: v.automatico, ok: r.ok, motivo: r.ok ? null : r.motivo,
      });
      if (!r.ok) {
        toast.warning('Outra pessoa corrigiu este contato antes', { description: 'Atualizei a ficha; confira e corrija de novo se precisar.' });
      } else if (!r.semMudanca) {
        toast.success(v.veredito === null ? 'Voltou ao sinal automático' : v.veredito ? 'Marcado como contato da contabilidade' : 'Marcado como contato da empresa');
      }
    },
    onError: (e) => {
      toast.error('Não consegui salvar a correção', { description: mensagemDeErro(e) ?? undefined });
    },
    onSettled: (_r, _e, v) => Promise.all([
      qc.invalidateQueries({ queryKey: chave(v.cnpj) }),
      ...PREFIXOS_RELER.map((p) => qc.invalidateQueries({ queryKey: p })),
      qc.invalidateQueries({ queryKey: ['radar', 'lista'], predicate: (q) => ehFilaParaVisitar(q.queryKey) }),
    ]),
  });
}

/**
 * Quantos leads do recorte atual são "para visitar". Pacote N: era uma 2ª `radar_lista` (`p_so_visitar`) a cada troca
 * de filtro — medido em prod 2026-11-08, ~5,5 s só de pré-corte em `radar_empresas`, contra o `statement_timeout` de
 * 8 s do `authenticated`. Agora (migration 20261111160000, dimensão "visitar" no agregado por município):
 *   - chip DESLIGADO: o número sai do AGREGADO (`radar_contagem_por_municipio`, `p_so_agregado` — recorte que cairia
 *     no caminho vivo devolve 0 linhas, nunca o seq scan), só quando o recorte da fila cabe nele (`cabeNoAgregado`).
 *     É a contagem do último cálculo (`contadoEm`): correção feita depois entra no próximo. Fora do agregado, ou sem a
 *     dimensão calculada: sem número (ausente ≠ zero) — o chip só convida;
 *   - chip LIGADO: o número sai da PRÓPRIA fila, que já é o recorte (mesma chave da lista da página — nenhuma chamada
 *     a mais): exato quando a fila acabou, "N+" enquanto há página seguinte.
 * `desligado`: visão "Meus atendimentos" (o chip não existe lá).
 */
export interface ContagemParaVisitar {
  isError: boolean;
  /** null = não contado (fora do agregado, dimensão indisponível, ou a fila ainda não chegou). */
  data: number | null;
  /** O que o chip mostra ao lado do rótulo: '' (sem número), '…', '?', 'N' ou 'N+'. */
  rotulo: string;
  /** Quando o número do agregado foi contado (ISO); null = o número é da fila ao vivo, ou não há número. */
  contadoEm?: string | null;
}

export function rotuloDaContagem(
  ligado: boolean,
  lista: { isPending: boolean; isError: boolean; data?: { pages: unknown[][] }; hasNextPage: boolean },
): ContagemParaVisitar {
  if (!ligado) return { isError: false, data: null, rotulo: '' };
  if (lista.isError) return { isError: true, data: null, rotulo: '?' };
  if (lista.isPending || !lista.data) return { isError: false, data: null, rotulo: '…' };
  const n = lista.data.pages.reduce((t, p) => t + p.length, 0);
  return { isError: false, data: n, rotulo: lista.hasNextPage ? `${n}+` : String(n) };
}

/** O recorte da FILA cabe no agregado por município? A `radar_lista` aplica também a busca textual, o nome de cidade
 *  digitado (sem código) e "só sugeridos" — que o agregado não conhece. Com eles o número do agregado seria de OUTRO
 *  recorte: sem número. (Data/CNAE fora dos agregados quem decide é o servidor: `p_so_agregado` → 0 linhas.) */
export function cabeNoAgregado(filtros: RadarFiltros): boolean {
  if (filtros.busca.trim() !== '') return false;
  if (filtros.soSugeridos) return false;
  if (filtros.municipio.trim() !== '' && !filtros.municipioCodigo) return false;
  return true;
}

/** O número do agregado na resposta (`p_limit` 1): o total do recorte inteiro, se a dimensão serviu. Resposta vazia
 *  = recorte fora dos agregados (ou vazio): sem número, nunca 0. */
export function totalVisitarDoAgregado(
  linhas: readonly Pick<RadarMunicipioContagem, 'para_visitar_total' | 'visitar_contado_em'>[],
): { n: number; contadoEm: string } | null {
  const l = linhas[0];
  if (!l || l.para_visitar_total == null || l.visitar_contado_em == null) return null;
  return { n: l.para_visitar_total, contadoEm: l.visitar_contado_em };
}

export function rotuloDoAgregado(q: {
  isError: boolean;
  data?: { n: number; contadoEm: string } | null;
}): ContagemParaVisitar {
  // Chip desligado é convite: falha ou ausência não vira "?" nem 0 — só some o número.
  if (q.isError || !q.data) return { isError: q.isError, data: null, rotulo: '', contadoEm: null };
  return { isError: false, data: q.data.n, rotulo: q.data.n.toLocaleString('pt-BR'), contadoEm: q.data.contadoEm };
}

/** Texto do `title` do chip (o número desligado é do último cálculo; o ligado é da fila ao vivo). */
export function dicaDoChip(ligado: boolean, c: ContagemParaVisitar): string {
  const base = 'Leads cujo telefone e e-mail da Receita parecem ser da contabilidade: vá ao endereço em vez de ligar.';
  if (c.isError && ligado) return 'Não consegui contar os leads para visitar neste recorte';
  if (ligado) return base;
  if (c.data != null && c.contadoEm) {
    return `${base} ${c.data.toLocaleString('pt-BR')} neste recorte na contagem de ${formatarContadoEm(c.contadoEm)}`
      + ' (correções feitas depois entram no próximo cálculo). Ligue para ver a lista.';
  }
  return `${base} Ligue para ver quantos há neste recorte.`;
}

export function useRadarParaVisitarContagem(
  filtros: RadarFiltros,
  hojeISO: string,
  opcoes: { desligado?: boolean } = {},
): ContagemParaVisitar {
  const qc = useQueryClient();
  const ligado = !opcoes.desligado && filtros.paraVisitar === true;
  // Observa a MESMA query da fila da página (mesmos filtros, visão 'fila'): o react-query deduplica pela chave.
  const lista = useRadarLista(filtros, hojeISO, { aguardar: !ligado });
  const params = {
    ...paramsDaContagem(filtros, hojeISO),
    p_municipio_codigo: filtros.municipioCodigo || null,
    p_limit: 1,
    p_so_agregado: true,
  };
  const modoLote = { incluirSaiuDoDump: filtros.incluirSaiuDoDump, soIneditos: filtros.soIneditos };
  const agregado = useQuery({
    queryKey: ['radar', 'contagem-municipios', 'para-visitar', params, modoLote],
    enabled: !opcoes.desligado && !ligado && cabeNoAgregado(filtros),
    staleTime: 60_000,
    retry: 1,
    queryFn: async () => {
      const lote = await lerLoteVigente(qc);
      const recorte = recorteDeLote(lote, modoLote);
      const { data, error } = await supabase.rpc(
        'radar_contagem_por_municipio',
        comNulo<'radar_contagem_por_municipio', FiltroNuloContagem | 'p_municipio_codigo'>({
          ...params, p_lote: recorte.ultimoLote, p_primeira_vista_min: recorte.primeiraVistaMin,
        }),
      )
        // p_limit 1 + a janela do total: no máximo 1 linha — o range explicita o teto (gate de paginação).
        .range(0, 0);
      if (error) throw error;
      return totalVisitarDoAgregado(data ?? []);
    },
  });
  if (ligado) return rotuloDaContagem(true, lista);
  if (opcoes.desligado || !cabeNoAgregado(filtros)) return rotuloDaContagem(false, lista);
  return rotuloDoAgregado(agregado);
}
