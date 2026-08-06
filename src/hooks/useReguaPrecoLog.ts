import { useCallback, useRef } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { registrarExibicaoRegua, registrarAplicacaoRegua, type ExibicaoReguaPayload } from '@/lib/regua-preco/regua-preco-log';

// `salespersonId` saiu do payload em FU4-F fase 2: quem o define é a RPC, com auth.uid(), para
// que o cliente não possa registrar em nome de outra vendedora.
type DadosExibicao = ExibicaoReguaPayload;

/**
 * Closed-loop da Régua. Dedup por (cliente + chave + sinal + precoReferencia): cada
 * combinação loga UMA vez por montagem do carrinho — o cliente entra na chave p/ NÃO
 * atribuir o log ao cliente anterior se o vendedor trocar sem desmontar (Codex P1).
 * Guarda o logId por (cliente, item) p/ casar o UPDATE no Aplicar.
 */
export function useReguaPrecoLog() {
  const { user } = useAuth();
  const logIds = useRef(new Map<string, string>());   // `${cliente}:${chaveItem}` → logId
  const jaLogado = useRef(new Set<string>());          // chave dedupe

  const marcarExibido = useCallback(async (chaveItem: string, dados: DadosExibicao) => {
    if (!user?.id) return;
    const chaveCliente = `${dados.customerUserId}:${chaveItem}`;
    const dedupeKey = `${chaveCliente}:${dados.result.sinal}:${dados.result.precoReferencia}`;
    if (jaLogado.current.has(dedupeKey)) return;
    jaLogado.current.add(dedupeKey);
    const id = await registrarExibicaoRegua(dados);
    if (id) logIds.current.set(chaveCliente, id);
  }, [user?.id]);

  const marcarAplicado = useCallback((chaveItem: string, customerUserId: string, precoFinal: number) => {
    const id = logIds.current.get(`${customerUserId}:${chaveItem}`);
    if (id) void registrarAplicacaoRegua(id, precoFinal);
  }, []);

  return { marcarExibido, marcarAplicado };
}
