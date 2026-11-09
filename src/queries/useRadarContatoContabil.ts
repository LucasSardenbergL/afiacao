import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { lerContatoContabil, type CampoContato, type LeituraContatoContabil } from '@/lib/radar/contato-contabil';
import { useRadarLista, type RadarFiltros } from '@/queries/useRadarLista';

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
 * Quantos leads do recorte atual são "para visitar" — SOB DEMANDA (pacote N). Antes era uma 2ª `radar_lista`
 * (`p_so_visitar`, até 200) a cada troca de filtro, com o chip ligado ou não: medido em prod 2026-11-08, só o
 * pré-corte dela (≈67 mil CNPJs com sinal × o recorte) custa ~5,5 s de seq scan em `radar_empresas`, antes da regra
 * por linha — contra o `statement_timeout` de 8 s do `authenticated`. Agora:
 *   - chip DESLIGADO: nenhuma leitura, nenhum número (o chip só convida);
 *   - chip LIGADO: o número sai da PRÓPRIA fila, que já é o recorte "para visitar" (mesma chave da lista da
 *     página — nenhuma chamada a mais): exato quando a fila acabou, "N+" enquanto há página seguinte.
 * `desligado`: visão "Meus atendimentos" (o chip não existe lá).
 */
export interface ContagemParaVisitar {
  isError: boolean;
  /** null = não contado (chip desligado, ou a fila ainda não chegou). */
  data: number | null;
  /** O que o chip mostra ao lado do rótulo: '' (desligado), '…', '?', 'N' ou 'N+'. */
  rotulo: string;
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

export function useRadarParaVisitarContagem(
  filtros: RadarFiltros,
  hojeISO: string,
  opcoes: { desligado?: boolean } = {},
): ContagemParaVisitar {
  const ligado = !opcoes.desligado && filtros.paraVisitar === true;
  // Observa a MESMA query da fila da página (mesmos filtros, visão 'fila'): o react-query deduplica pela chave.
  const lista = useRadarLista(filtros, hojeISO, { aguardar: !ligado });
  return rotuloDaContagem(ligado, lista);
}
