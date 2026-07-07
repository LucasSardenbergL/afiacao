import { useState, useCallback } from 'react';
import { invokeFunction } from '@/lib/invoke-function';
import type { ResultadoExtracao } from '@/lib/knowledge-base/aprovacao-fila';
import type { KbExtractedSpec } from '@/lib/knowledge-base/specs-types';
import { normalizeExtractedSpec } from '@/lib/knowledge-base/specs-types';

/** Erro ocorrido durante a extração de um documento específico. */
interface BatchExtractErro {
  documentId: string;
  error: string;
}

/** Estado corrente do processo de extração em lote. */
export interface BatchExtractState {
  /** Indica se o lote está em execução. */
  rodando: boolean;
  /** Total de documentos passados ao `run`. */
  total: number;
  /** Quantos documentos já foram processados (sucesso + erro). */
  feitos: number;
  /** Extrações bem-sucedidas acumuladas. */
  resultados: ResultadoExtracao[];
  /** Documentos que falharam, com mensagem de erro. */
  erros: BatchExtractErro[];
}

/**
 * Resposta da edge function `kb-extract-specs`.
 *
 * Dois formatos possíveis (ambos HTTP 200, NÃO são erros):
 *  - `{ specs, cached?, usage? }` → extração OK ou cache-hit
 *  - `{ status: 'extracting' }` → claim perdido (outra aba já está extraindo);
 *    neste caso `specs` é undefined. Não contar como resultado nem como erro —
 *    simplesmente incrementar `feitos`.
 */
interface ExtractResponse {
  specs?: KbExtractedSpec;
  status?: 'extracting';
  cached?: boolean;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
}

/** Opções para a chamada `run`. */
interface RunOpts {
  /** Se true, passa `force: true` para a edge, que ignora o cache/claim existente. */
  force?: boolean;
}

/** Concorrência máxima de chamadas simultâneas à edge function. */
const CONCORRENCIA = 3;

const ESTADO_INICIAL: BatchExtractState = {
  rodando: false,
  total: 0,
  feitos: 0,
  resultados: [],
  erros: [],
};

/**
 * Executa a extração de fichas técnicas em lote sobre uma lista de documentos.
 *
 * - Respeita concorrência máxima de 3 chamadas simultâneas à `kb-extract-specs`.
 * - Acumula resultados e erros de forma incremental (atualiza `feitos` a cada doc).
 * - Estado é efêmero (client-side apenas; nada é persistido).
 * - `reset()` zera o estado para permitir nova execução.
 */
export function useBatchExtract(): BatchExtractState & {
  run: (documentIds: string[], opts?: RunOpts) => Promise<ResultadoExtracao[]>;
  reset: () => void;
  removerResultados: (documentIds: string[]) => void;
} {
  const [estado, setEstado] = useState<BatchExtractState>(ESTADO_INICIAL);

  const reset = useCallback(() => {
    setEstado(ESTADO_INICIAL);
  }, []);

  /**
   * Remove resultados específicos do estado (ex.: os aprovados em lote) SEM apagar os demais.
   * ⚠️ Diferente de `reset()`, que zerava TUDO — incluindo as fichas 'a revisar' ainda não
   * salvas, que sumiam ao aprovar o lote e exigiam re-extração (gasto de API à toa).
   */
  const removerResultados = useCallback((documentIds: string[]) => {
    const ids = new Set(documentIds);
    setEstado((prev) => ({
      ...prev,
      resultados: prev.resultados.filter((r) => !ids.has(r.documentId)),
    }));
  }, []);

  const run = useCallback(async (documentIds: string[], opts?: RunOpts): Promise<ResultadoExtracao[]> => {
    if (documentIds.length === 0) return [];

    // Inicializa o estado antes de começar
    setEstado({
      rodando: true,
      total: documentIds.length,
      feitos: 0,
      resultados: [],
      erros: [],
    });

    // Acumuladores locais para o retorno final
    const resultadosAcumulados: ResultadoExtracao[] = [];
    const errosAcumulados: BatchExtractErro[] = [];

    // Pool de concorrência: índice compartilhado entre os workers
    let indice = 0;

    /**
     * Cada worker consome o próximo documentId disponível até esgotar a lista.
     * Atualiza o estado React de forma incremental após cada documento.
     */
    async function worker(): Promise<void> {
      while (true) {
        // Reserva o próximo índice de forma exclusiva
        const meuIndice = indice;
        indice += 1;

        if (meuIndice >= documentIds.length) break;

        const documentId = documentIds[meuIndice];

        try {
          const response = await invokeFunction<ExtractResponse>('kb-extract-specs', {
            documentId,
            ...(opts?.force ? { force: true } : {}),
          });

          // `status: 'extracting'` → claim perdido (outra aba extrai). Não é erro,
          // não produz spec. Só incrementa `feitos`.
          if (response.status === 'extracting' || !response.specs) {
            setEstado(prev => ({ ...prev, feitos: prev.feitos + 1 }));
            continue;
          }

          const resultado: ResultadoExtracao = {
            documentId,
            spec: normalizeExtractedSpec(response.specs),
          };
          resultadosAcumulados.push(resultado);

          setEstado(prev => ({
            ...prev,
            feitos: prev.feitos + 1,
            resultados: [...prev.resultados, resultado],
          }));
        } catch (err) {
          const mensagem = err instanceof Error ? err.message : String(err);
          errosAcumulados.push({ documentId, error: mensagem });

          setEstado(prev => ({
            ...prev,
            feitos: prev.feitos + 1,
            erros: [...prev.erros, { documentId, error: mensagem }],
          }));
        }
      }
    }

    // Dispara exatamente CONCORRENCIA workers em paralelo
    const workers = Array.from({ length: Math.min(CONCORRENCIA, documentIds.length) }, worker);
    await Promise.all(workers);

    // Marca o lote como concluído
    setEstado(prev => ({ ...prev, rodando: false }));

    return resultadosAcumulados;
  }, []);

  return { ...estado, run, reset, removerResultados };
}
