import { useEffect, useRef } from 'react';
import { useMyPositivacao } from '@/hooks/useMyPositivacao';
import { estadoDeLeitura, naoConsegui } from '@/lib/leitura/estado-de-leitura';
import { track } from '@/lib/analytics';

/**
 * SENSOR do placar de positivação — só mede, não desenha.
 *
 * O `carteira.positivacao_vista` morava dentro do `PositivacaoHero`, que só existe no ramo de
 * SUCESSO: quem não recebia `kpis` (leitura falhou) não emitia nada. A série de adoção ficava sem
 * denominador — e sem denominador, zero não julga desenho nenhum (`docs/historico/fase-sem-sinal.md`).
 * "Mês parado", "não consegui ler", "sem rede" e "nunca abriu a tela" chegavam ao PostHog como o
 * mesmo silêncio.
 *
 * O #1886 consertou o que a tela MOSTRA no erro (`AvisoLeituraFalhou`) e não tocou no que ela
 * MEDE — são trabalhos diferentes, e é por isso que este sensor é um hook e não mais um
 * componente de estado: desenhar já tem dono, medir não tinha. O estado vem do primitivo
 * COMPARTILHADO (`estadoDeLeitura`, do próprio #1886) em vez de uma segunda conta minha: duas
 * derivações do mesmo estado divergiriam no primeiro caso de borda, e a de borda aqui é o offline.
 *
 * Por que o vocabulário do primitivo vai CRU no evento (`pronta`/`erro`/`sem-rede`) em vez de um
 * booleano: 'sem-rede' e 'erro' doem diferente. Um vendedor em campo sem sinal não é a RPC
 * quebrada, e colapsar os dois faria a série culpar o backend por cobertura de celular.
 *
 * ⚠️ No erro os números vão em `null`, NUNCA `0` (§2 do money-path — ausente ≠ zero): zero somaria
 * falha de leitura como se fosse carteira sem positivação, fabricando exatamente o número que o
 * sensor existe para medir.
 *
 * Chama `useMyPositivacao()` por dentro de propósito — o react-query deduplica pela queryKey, e
 * assim o host ganha o sensor com UMA linha, sem reestruturar o que já tem.
 */
type EstadoSinal = 'pronta' | 'erro' | 'sem-rede';

export function useSinalPositivacao(isHunter: boolean): EstadoSinal | null {
  const query = useMyPositivacao();
  const { data } = query;
  const leitura = estadoDeLeitura(query);

  // `carregando` e `desabilitada` não são desfecho — nada a medir ainda. E `pronta` com `data`
  // NULL é a RPC dizendo "você não é staff" (retorna NULL sem uid/sem role): ausência de acesso,
  // não um estado do placar. Só emite quem chegou a um DESFECHO.
  const estado: EstadoSinal | null = naoConsegui(leitura)
    ? leitura
    : leitura === 'pronta' && data != null
      ? 'pronta'
      : null;

  const trackedEstado = useRef<EstadoSinal | null>(null);
  useEffect(() => {
    // Um evento por estado RESOLVIDO. A guarda por ESTADO (e não por booleano "já emitiu") deixa
    // passar a transição sem-rede → pronta dentro da mesma montagem, que é o dado que separa uma
    // falha transitória de uma carteira de fato parada.
    if (!estado || trackedEstado.current === estado) return;
    trackedEstado.current = estado;
    track('carteira.positivacao_vista', {
      estado,
      pct: data ? data.pctPositivacao : null,
      positivados: data ? data.positivados : null,
      total_eligible: data ? data.totalEligible : null,
      a_positivar: data ? data.aPositivar.length : null,
      is_hunter: isHunter,
    });
  }, [estado, data, isHunter]);

  return estado;
}
