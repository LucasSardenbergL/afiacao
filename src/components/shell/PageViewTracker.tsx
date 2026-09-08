import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { pageview } from '@/lib/analytics';
import { registrarNavegacaoNoLedger } from '@/lib/analytics-ledger';

/**
 * Dispara a telemetria de navegação a cada mudança de rota. Monta no AppShell
 * uma vez — ou seja, só na área autenticada, que é o que a RPC do ledger exige.
 *
 * DOIS canos, de propósito, com formatos DIFERENTES:
 *
 * 1. `$pageview` (PostHog) — URL crua, alta granularidade, e assumidamente
 *    CENSURÁVEL: `us.i.posthog.com` está em listas de bloqueio, e a medição de
 *    2026-09-07 mostrou 91% das sessões do único usuário ativo invisíveis neste
 *    canal (`docs/historico/proxy-posthog-reavaliado.md`).
 * 2. `navegacao.rota_servida` (ledger no nosso Postgres) — rota CANÔNICA, uma
 *    linha por rota/titular/dia. É o canal que responde "quanto do que
 *    entregamos chega a ser aberto" mesmo com o rastreador bloqueado.
 *
 * ⚠️ O ledger recebe só `pathname`: a querystring é argumento, não tela, e é
 * onde os ids viajam. O `$pageview` continua com a URL crua porque lá o dado
 * não vira acervo nosso.
 *
 * NOTA (herdada): ignoramos query params em alguns casos pra reduzir cardinality
 * (ex: ?cor=12345 na busca de fórmulas). Por enquanto o $pageview envia URL crua
 * — refinar se PostHog mostrar alta cardinality em "Pages".
 */
export function PageViewTracker() {
  const location = useLocation();

  useEffect(() => {
    pageview(location.pathname + location.search);
  }, [location.pathname, location.search]);

  // Separado do efeito acima porque a dependência é OUTRA: o ledger não deve
  // reenviar quando só a querystring muda (mesma tela, outro argumento).
  useEffect(() => {
    void registrarNavegacaoNoLedger(location.pathname);
  }, [location.pathname]);

  return null;
}
