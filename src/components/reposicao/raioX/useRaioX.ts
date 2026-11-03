// Hook de leitura do Raio-X do estoque parado (fase B). Lê fatos (RPC), decisões e classificações
// manuais, tudo PAGINADO (PostgREST capa em 1.000 linhas, inclusive `.rpc()`), e entrega itens já
// classificados + placar. A medição (`raio_x_medicao`) fica para o PR 4.
import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ehFalhaDePagina, fetchAllPages } from '@/lib/postgrest';
import { hojeSP } from '@/lib/time/sp-day';
import { alinharSugestaoAoServidor, aplicarCoorte, aplicarInequivoco, classificar } from '@/lib/reposicao/raio-x/classificar';
import { linhasForaDoEstoque, type ProdutoCadastro } from '@/lib/reposicao/raio-x/fila';
import { comoCoorte, comoDecisaoRow, comoFatoSku, comoInequivoco, comoLinhaManual, comoLinhaMedicao } from '@/lib/reposicao/raio-x/borda';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import { logger } from '@/lib/logger';
import { placar } from '@/lib/reposicao/raio-x/placar';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import type {
  ClassificacaoManual,
  DecisaoRow,
  Empresa,
  InequivocoSku,
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
  /** membros da coorte fora do estoque (saldo zerado): linhas históricas decidíveis, FORA de `itens` e do placar. */
  historicos: ItemRaioX[];
  decisoes: Map<number, DecisaoRow>;
  placar: ReturnType<typeof placar>;
  /** sem coorte congelada (ou indisponível) o placar usa o Top de hoje e diz isso. */
  coorteEstado: EstadoCoorte;
  /** RPC raio_x_inequivoco falhou (ex.: migration ainda não aplicada): selos ficam "—". */
  inequivocoIndisponivel: boolean;
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

  const decisoesQ = useQuery(opcoesDecisoes(empresa));

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

  const coorteQ = useQuery(opcoesCoorte(empresa));

  // Veredito "inequívoco" do servidor (PR 2). Falha NÃO derruba a aba: vira `inequivoco: null` (selo "—"), como a coorte.
  const inequivocoQ = useQuery({
    queryKey: ['raio-x', empresa, 'inequivoco'],
    enabled,
    retry,
    queryFn: () =>
      ler(() =>
        fetchAllPages(
          (de, ate) =>
            supabase
              .rpc('raio_x_inequivoco', { p_empresa: empresa as string })
              .order('sku_codigo_omie', { ascending: true })
              .range(de, ate),
          'raio_x_inequivoco',
        ).then((rows) => rows.map(comoInequivoco).filter((x): x is InequivocoSku => x !== null)),
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

  const coorte = coorteQ.data ?? null;
  const itensComCoorte = useMemo(() => aplicarCoorte(itens, coorte), [itens, coorte]);
  const mapaInequivoco = useMemo(
    // Refetch que FALHOU não pode servir o veredito velho do cache como se fosse atual (Codex P2-6): erro ⇒ null.
    () => (inequivocoQ.data && !inequivocoQ.isError ? new Map<number, InequivocoSku>(inequivocoQ.data.map((q) => [q.sku_codigo_omie, q])) : null),
    [inequivocoQ.data, inequivocoQ.isError],
  );
  const itensFinal = useMemo(
    () => alinharSugestaoAoServidor(aplicarInequivoco(itensComCoorte, mapaInequivoco)),
    [itensComCoorte, mapaInequivoco],
  );

  // Membros da coorte que zeraram o saldo (fora dos fatos): linha histórica para decidir (bug 2). Nome/código vêm do
  // cadastro (≤ 61 SKUs, uma página); falha na leitura do cadastro só tira o nome — a linha nasce com o nº do SKU.
  const ausentes = useMemo(() => {
    if (!coorte || !fatos) return [];
    const presentes = new Set(fatos.map((f) => f.sku_codigo_omie));
    return [...coorte.itens.keys()].filter((sku) => !presentes.has(sku)).sort((a, b) => a - b);
  }, [coorte, fatos]);
  const cadastroQ = useQuery({
    queryKey: ['raio-x', empresa, 'cadastro-ausentes', ausentes],
    enabled: enabled && ausentes.length > 0,
    retry,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('omie_products')
        .select('omie_codigo_produto, codigo, descricao, created_at')
        .eq('account', empresa as string)
        .in('omie_codigo_produto', ausentes)
        .order('created_at', { ascending: false })
        .range(0, 999);
      if (error) throw preservarCode(error);
      const m = new Map<number, ProdutoCadastro>();
      // mais recente primeiro (como o LATERAL de raio_x_estoque_fatos): o 1º de cada SKU vence
      for (const r of data ?? []) {
        if (!m.has(r.omie_codigo_produto)) m.set(r.omie_codigo_produto, { codigo: r.codigo, descricao: r.descricao });
      }
      return m;
    },
  });
  const historicos = useMemo(() => {
    if (ausentes.length === 0) return [];
    return linhasForaDoEstoque(coorte, new Set(itens.map((i) => i.sku_codigo_omie)), cadastroQ.data ?? new Map());
  }, [ausentes, coorte, itens, cadastroQ.data]);
  const placarCalc = useMemo(() => placar(itensComCoorte, decisoes, coorte), [itensComCoorte, decisoes, coorte]);

  // Só congela com os insumos ATUAIS e completos: refetch pendente serviria o cache anterior (Codex P1) e a
  // primeira escrita vence — uma lista errada não teria conserto.
  const insumosFrescos = [fatosQ, manuaisQ, coorteQ].every((q) => q.isSuccess && !q.isFetching);
  useCongelarCoorte(empresa, insumosFrescos && coorteQ.data === null, itens);

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
    itens: erro ? [] : itensFinal,
    historicos: erro ? [] : historicos,
    inequivocoIndisponivel: inequivocoQ.isError,
    decisoes,
    placar: placarCalc,
    coorteEstado,
    syncedHoras,
    isLoading: enabled && (fatosQ.isLoading || decisoesQ.isLoading || manuaisQ.isLoading || coorteQ.isLoading),
    erro: erro as Error | null,
  };
}

function opcoesDecisoes(empresa: Empresa | null) {
  return {
    queryKey: ['raio-x', empresa, 'decisoes'],
    enabled: empresa !== null,
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
  };
}

/** Coorte do Top 61 (≤ 61 linhas por empresa — cabe numa página; `.range` só por disciplina). */
function opcoesCoorte(empresa: Empresa | null) {
  return {
    queryKey: ['raio-x', empresa, 'coorte'],
    enabled: empresa !== null,
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
  };
}

/**
 * Pendentes do Top 61 congelado para o contador da aba ("Raio-X (49)"): só coorte + decisões (leituras pequenas, mesmo
 * cache da aba) — sem os fatos pesados. `null` = sem coorte congelada ou leitura indisponível (sem número, nunca 0).
 */
export function useRaioXPendentesTop(empresa: Empresa | null): number | null {
  const coorteQ = useQuery(opcoesCoorte(empresa));
  const decisoesQ = useQuery(opcoesDecisoes(empresa));
  const coorte = coorteQ.data;
  const decisoes = decisoesQ.data;
  return useMemo(() => {
    if (!coorte || !decisoes || coorteQ.isError || decisoesQ.isError) return null;
    const decididos = new Set(decisoes.filter((d) => d.destino).map((d) => d.sku_codigo_omie));
    return [...coorte.itens.keys()].filter((sku) => !decididos.has(sku)).length;
  }, [coorte, decisoes, coorteQ.isError, decisoesQ.isError]);
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
