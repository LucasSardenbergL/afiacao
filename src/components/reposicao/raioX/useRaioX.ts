// Hook de leitura do Raio-X do estoque parado (fase B). Lê fatos (RPC), decisões e classificações
// manuais, tudo PAGINADO (PostgREST capa em 1.000 linhas, inclusive `.rpc()`), e entrega itens já
// classificados + placar. A medição (`raio_x_medicao`) fica para o PR 4.
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ehFalhaDePagina, fetchAllPages } from '@/lib/postgrest';
import { hojeSP } from '@/lib/time/sp-day';
import { classificar } from '@/lib/reposicao/raio-x/classificar';
import { placar } from '@/lib/reposicao/raio-x/placar';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import type {
  ClassificacaoManual,
  DecisaoRow,
  Empresa,
  FatoSku,
  ItemRaioX,
  LinhaMedicao,
} from '@/lib/reposicao/raio-x/tipos';

type Pagina<T> = PromiseLike<{ data: T[] | null; error: unknown }>;
type LinhaManual = ClassificacaoManual & { sku_codigo_omie: number };

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
        fetchAllPages<FatoSku>(
          (de, ate) =>
            supabase
              .rpc('raio_x_estoque_fatos', { p_empresa: empresa as string })
              .order('sku_codigo_omie', { ascending: true })
              .range(de, ate),
          'raio_x_estoque_fatos',
        ),
      ),
  });

  const decisoesQ = useQuery({
    queryKey: ['raio-x', empresa, 'decisoes'],
    enabled,
    retry,
    queryFn: () =>
      ler(() =>
        fetchAllPages<DecisaoRow>(
          (de, ate) =>
            supabase
              .from('raio_x_decisao')
              .select('*')
              .eq('empresa', empresa as string)
              .order('sku_codigo_omie', { ascending: true })
              .range(de, ate),
          'raio_x_decisao',
        ),
      ),
  });

  const manuaisQ = useQuery({
    queryKey: ['raio-x', empresa, 'manuais'],
    enabled,
    retry,
    queryFn: () =>
      ler(() =>
        fetchAllPages<LinhaManual>(
          (de, ate) =>
            supabase
              .from('raio_x_classificacao_manual')
              .select('sku_codigo_omie, categoria, motivo')
              .eq('empresa', empresa as string)
              .order('sku_codigo_omie', { ascending: true })
              .range(de, ate),
          'raio_x_classificacao_manual',
        ),
      ),
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

  const placarCalc = useMemo(() => placar(itens, decisoes), [itens, decisoes]);

  const syncedHoras = useMemo(() => {
    let max: number | null = null;
    for (const f of fatos ?? []) {
      if (!f.synced_at) continue;
      const t = Date.parse(f.synced_at);
      if (!Number.isNaN(t) && (max === null || t > max)) max = t;
    }
    return max === null ? null : (Date.now() - max) / 3_600_000;
  }, [fatos]);

  const erro = fatosQ.error ?? decisoesQ.error ?? manuaisQ.error ?? null;

  return {
    itens: erro ? [] : itens,
    decisoes,
    placar: placarCalc,
    syncedHoras,
    isLoading: enabled && (fatosQ.isLoading || decisoesQ.isLoading || manuaisQ.isLoading),
    erro: erro as Error | null,
  };
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
        fetchAllPages<LinhaMedicao>(
          (de, ate) =>
            supabase
              .rpc('raio_x_medicao', { p_empresa: empresa as string })
              .order('sku_codigo_omie', { ascending: true })
              .range(de, ate),
          'raio_x_medicao',
        ),
      ),
  });
  return {
    linhas: q.error ? undefined : q.data,
    isLoading: empresa !== null && q.isLoading,
    erro: (q.error as Error | null) ?? null,
  };
}
