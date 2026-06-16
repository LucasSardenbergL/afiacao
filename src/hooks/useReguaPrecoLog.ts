import { useCallback, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { registrarExibicaoRegua, registrarAplicacaoRegua, type ExibicaoReguaPayload } from '@/lib/regua-preco/regua-preco-log';

type DadosExibicao = Omit<ExibicaoReguaPayload, 'salespersonId'>;

/**
 * Closed-loop da Régua. Dedup por (chave + sinal + precoReferencia): cada combinação
 * loga UMA vez por montagem do carrinho. Guarda o logId p/ casar o UPDATE no Aplicar.
 */
export function useReguaPrecoLog() {
  const { user } = useAuth();
  const logIds = useRef(new Map<string, string>());   // chaveItem → logId (último exibido)
  const jaLogado = useRef(new Set<string>());          // chave dedupe

  const marcarExibido = useCallback(async (chaveItem: string, dados: DadosExibicao) => {
    if (!user?.id) return;
    const dedupeKey = `${chaveItem}:${dados.result.sinal}:${dados.result.precoReferencia}`;
    if (jaLogado.current.has(dedupeKey)) return;
    jaLogado.current.add(dedupeKey);
    const id = await registrarExibicaoRegua({ ...dados, salespersonId: user.id });
    if (id) logIds.current.set(chaveItem, id);
  }, [user?.id]);

  const marcarAplicado = useCallback((chaveItem: string, precoFinal: number) => {
    const id = logIds.current.get(chaveItem);
    if (id) void registrarAplicacaoRegua(id, precoFinal);
  }, []);

  return { marcarExibido, marcarAplicado };
}
