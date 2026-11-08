import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { lerContatoContabil, type CampoContato, type LeituraContatoContabil } from '@/lib/radar/contato-contabil';
import { identidadeDoLote, parametrosDaLista, type RadarFiltros } from '@/queries/useRadarLista';
import { lerLoteVigente, useRadarLoteVigente } from '@/queries/useRadarLoteVigente';

const chave = (cnpj: string | null) => ['radar', 'contato-contabil', cnpj] as const;
/** O que muda quando o vendedor corrige: a ficha, a contagem "para visitar", a fila filtrada e o card. */
const PREFIXOS_RELER = [['radar', 'para-visitar'], ['radar', 'lista'], ['radar', 'prospectar-hoje']] as const;

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
    ]),
  });
}

/**
 * Quantos leads do recorte atual são "para visitar" — a MESMA `radar_lista` da fila, com os MESMOS parâmetros
 * (`parametrosDaLista`) e `p_so_visitar`: o recorte é idêntico por construção. Só os CNPJs, até 200: `200` lê-se
 * "200 ou mais" (a fila pagina; contar além disso seria outra RPC). `desligado`: visão "Meus atendimentos".
 */
export const TETO_CONTAGEM_VISITAR = 200;
export function useRadarParaVisitarContagem(filtros: RadarFiltros, hojeISO: string, opcoes: { desligado?: boolean } = {}) {
  const qc = useQueryClient();
  const qLote = useRadarLoteVigente();
  const loteDaChave = qLote.data === undefined ? 'sem-leitura' : identidadeDoLote(qLote.data);
  // A contagem é do recorte SEM o chip (ligado ou não, o número é o mesmo): trocar o chip não relê.
  const base: RadarFiltros = { ...filtros, paraVisitar: false };
  return useQuery({
    queryKey: ['radar', 'para-visitar', base, hojeISO, loteDaChave] as const,
    enabled: !opcoes.desligado && !qLote.isPending,
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<number> => {
      const lote = await lerLoteVigente(qc);
      if (base.soSugeridos && !lote) throw new Error('Sem lote completo da RFB: "só sugeridos" fica indisponível.');
      const p = { ...parametrosDaLista({ ...base, paraVisitar: true }, lote, hojeISO, 0), p_limit: TETO_CONTAGEM_VISITAR };
      // Ordem estável + teto explícito: a função já devolve no máximo p_limit; o range diz isso ao gate de paginação.
      const { data, error } = await supabase.rpc('radar_lista', p).select('cnpj')
        .order('cnpj', { ascending: true }).range(0, TETO_CONTAGEM_VISITAR - 1);
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('radar_lista: resposta fora da forma esperada (lista)');
      return data.length;
    },
  });
}
