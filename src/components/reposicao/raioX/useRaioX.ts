import { comoCoorte, comoDecisaoRow, comoFatoSku, comoLinhaManual, comoLinhaMedicao } from '@/lib/reposicao/raio-x/borda';
// Hook de leitura do Raio-X do estoque parado (fase B). Lê fatos (RPC), decisões e classificações
// manuais, tudo PAGINADO (PostgREST capa em 1.000 linhas, inclusive `.rpc()`), e entrega itens já
// classificados + placar. A medição (`raio_x_medicao`) fica para o PR 4.
import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ehFalhaDePagina, fetchAllPages } from '@/lib/postgrest';
import { hojeSP } from '@/lib/time/sp-day';
import { aplicarCoorte, classificar } from '@/lib/reposicao/raio-x/classificar';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import { logger } from '@/lib/logger';
import { placar } from '@/lib/reposicao/raio-x/placar';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import type {
  ClassificacaoManual,
  DecisaoRow,
  Empresa,
  ItemRaioX,
  LinhaMedicao,
} from '@/lib/reposicao/raio-x/tipos';


/** Devolve um Error que carrega o `code` (SQLSTATE) do PostgrestError, mesmo vindo embrulhado por fetchAllPages. */
function preservarCode(e: unknown): Error {
  const origem = ehFalhaDePagina(e) ? (e.cause ?? e) : e;
  const code = (origem as { code?: unknown } | null)?.code;
  const msg = (origem as { message?: unknown } | null)?.message;
  const erro = new Error(typeof msg === 'string' && msg ? msg : mensagemDeErro(e) ?? 'Falha ao ler o Raio-X');
  if (typeof code === 'string') (erro as Error & { code?: string }).code = code;
  return erro;
}

async function ler<T>(f: () => Promise<T[]>): Promise<T[]> {
  try {
    return await f();
  } catch (e) {
    if (ehFalhaDePagina(e)) throw preservarCode(e);
    throw e;
  }
}

const semPermissao = (e: unknown) => (e as { code?: string } | null)?.code === '42501';
const retry = (n: number, e: unknown) => !semPermissao(e) && n < 2;

export function useRaioX(empresa: Empresa | null): {
  itens: ItemRaioX[];
  decisoes: Map<number, DecisaoRow>;
  placar: ReturnType<typeof placar>;
  /** sem coorte congelada (ou indisponível) o placar usa o Top de hoje e diz isso. */
  coorteEstado: EstadoCoorte;
  syncedHoras: number | null;
  isLoading: boolean;
  erro: Error | null;
} {
  const enabled = empresa !== null;

  const fatosQ = useQuery({
    queryKey: ['raio-x', empresa, 'fatos'],
    enabled,
    retry,
    queryFn: () =>
      ler(() =>
        fetchAllPages(
          (de, ate) =>
            supabase
              .rpc('raio_x_estoque_fatos', { p_empresa: empresa as string })
              .order('sku_codigo_omie', { ascending: true })
              .range(de, ate),
          'raio_x_estoque_fatos',
        ).then((rows) => rows.map(comoFatoSku)),
      ),
  });

  const decisoesQ = useQuery({
    queryKey: ['raio-x', empresa, 'decisoes'],
    enabled,
    retry,
    queryFn: () =>
      ler(() =>
        fetchAllPages(
          (de, ate) =>
            supabase
              .from('raio_x_decisao')
              .select('*')
              .eq('empresa', empresa as string)
              .order('sku_codigo_omie', { ascending: true })
              .range(de, ate),
          'raio_x_decisao',
        ).then((rows) => rows.map(comoDecisaoRow)),
      ),
  });

  const manuaisQ = useQuery({
    queryKey: ['raio-x', empresa, 'manuais'],
    enabled,
    retry,
    queryFn: () =>
      ler(() =>
        fetchAllPages(
          (de, ate) =>
            supabase
              .from('raio_x_classificacao_manual')
              .select('sku_codigo_omie, categoria, motivo')
              .eq('empresa', empresa as string)
              .order('sku_codigo_omie', { ascending: true })
              .range(de, ate),
          'raio_x_classificacao_manual',
        ).then((rows) => rows.map(comoLinhaManual)),
      ),
  });

  // Coorte do Top 61 (≤ 61 linhas por empresa — cabe numa página; `.range` só por disciplina).
  const coorteQ = useQuery({
    queryKey: ['raio-x', empresa, 'coorte'],
    enabled,
    retry,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('raio_x_coorte_top')
        .select('sku_codigo_omie, posicao, valor, congelada_em')
        .eq('empresa', empresa as string)
        .order('posicao', { ascending: true })
        .range(0, 999);
      if (error) throw preservarCode(error);
      return comoCoorte(data ?? []);
    },
  });

  const fatos = fatosQ.data;
  const decisoesData = decisoesQ.data;
  const manuaisData = manuaisQ.data;

  const decisoes = useMemo(
    () => new Map<number, DecisaoRow>((decisoesData ?? []).map((d) => [d.sku_codigo_omie, d])),
    [decisoesData],
  );

  const itens = useMemo(() => {
    if (!empresa || !fatos || !manuaisData) return [];
    const manuais = new Map<number, ClassificacaoManual>(
      manuaisData.map((m) => [m.sku_codigo_omie, { categoria: m.categoria, motivo: m.motivo }]),
    );
    return classificar(fatos, manuais, empresa, hojeSP());
  }, [fatos, manuaisData, empresa]);

  const coorte = coorteQ.data ?? null;
  const itensComCoorte = useMemo(() => aplicarCoorte(itens, coorte), [itens, coorte]);
  const placarCalc = useMemo(() => placar(itensComCoorte, decisoes, coorte), [itensComCoorte, decisoes, coorte]);

  useCongelarCoorte(empresa, coorteQ.isSuccess && coorteQ.data === null, itens);

  const syncedHoras = useMemo(() => {
    let max: number | null = null;
    for (const f of fatos ?? []) {
      if (!f.synced_at) continue;
      const t = Date.parse(f.synced_at);
      if (!Number.isNaN(t) && (max === null || t > max)) max = t;
    }
    return max === null ? null : (Date.now() - max) / 3_600_000;
  }, [fatos]);

  // A coorte NÃO derruba a aba: falha (ex.: migração ainda não aplicada) vira "coorte indisponível" no placar,
  // que então mede contra o Top de hoje e DIZ isso. Os fatos/decisões continuam fail-closed.
  const erro = fatosQ.error ?? decisoesQ.error ?? manuaisQ.error ?? null;
  const coorteEstado: EstadoCoorte = coorteQ.isError ? 'indisponivel' : coorte ? 'congelada' : 'nao_congelada';

  return {
    itens: erro ? [] : itensComCoorte,
    decisoes,
    placar: placarCalc,
    coorteEstado,
    syncedHoras,
    isLoading: enabled && (fatosQ.isLoading || decisoesQ.isLoading || manuaisQ.isLoading || coorteQ.isLoading),
    erro: erro as Error | null,
  };
}

export type EstadoCoorte = 'congelada' | 'nao_congelada' | 'indisponivel';

/**
 * Congela a coorte do Top 61 UMA vez por empresa: na 1ª leitura sem coorte, manda os SKUs do Top de hoje. O
 * servidor grava posição + valor (saldo × cmc lidos LÁ, nunca do cliente) só se a empresa ainda não tem coorte
 * — primeira escrita vence, as demais são no-op. Sob a lente "Ver como" não escreve (write-guard).
 */
function useCongelarCoorte(empresa: Empresa | null, semCoorte: boolean, itens: ItemRaioX[]) {
  const qc = useQueryClient();
  const tentou = useRef<Set<Empresa>>(new Set());
  useEffect(() => {
    if (!empresa || !semCoorte || tentou.current.has(empresa) || isLensActive()) return;
    const skus = itens.filter((i) => i.top_atual).map((i) => i.sku_codigo_omie);
    if (skus.length === 0) return;
    tentou.current.add(empresa);
    void (async () => {
      const { error } = await supabase.rpc('raio_x_congelar_coorte', { p_empresa: empresa, p_skus: skus });
      if (error) {
        logger.warn('Raio-X: não congelou a coorte do Top 61', { empresa, error: error.message });
        return;
      }
      await qc.invalidateQueries({ queryKey: ['raio-x', empresa, 'coorte'] });
    })();
  }, [empresa, semCoorte, itens, qc]);
}

/** Medição do que o Raio-X liberou (`raio_x_medicao`). Falha vira `erro` — nunca lista vazia fingindo "nada liberado". */
export function useRaioXMedicao(empresa: Empresa | null): {
  linhas: LinhaMedicao[] | undefined;
  isLoading: boolean;
  erro: Error | null;
} {
  const q = useQuery({
    queryKey: ['raio-x', empresa, 'medicao'],
    enabled: empresa !== null,
    retry,
    queryFn: () =>
      ler(() =>
        fetchAllPages(
          (de, ate) =>
            supabase
              .rpc('raio_x_medicao', { p_empresa: empresa as string })
              .order('sku_codigo_omie', { ascending: true })
              .range(de, ate),
          'raio_x_medicao',
        ).then((rows) => rows.map(comoLinhaMedicao)),
      ),
  });
  return {
    linhas: q.error ? undefined : q.data,
    isLoading: empresa !== null && q.isLoading,
    erro: (q.error as Error | null) ?? null,
  };
}
