import { registerSW } from 'virtual:pwa-register';
import { acompanharRegistro, marcarAtualizacaoPronta } from '@/lib/pwa-atualizacao';

/**
 * Registra o service worker em modo PROMPT: quando uma nova versão instala e
 * fica em *waiting*, mostra um toast pro operador ATUALIZAR quando ele quiser —
 * em vez do reload-surpresa do antigo `registerType: 'autoUpdate'` + skipWaiting,
 * que recarregava o app no meio do turno e matava o estado local do formulário
 * (a fila offline sobrevive no localStorage; o lote meio-digitado, não).
 *
 * Chamado SÓ em produção non-preview (main.tsx, guard `__PWA_ENABLED__`): em dev
 * e no preview Lovable o plugin PWA não é incluído, então `virtual:pwa-register`
 * nem existe — o import dinâmico guardado é removido pelo DCE do Vite.
 *
 * Reload é seguro pra fila: as mutações pendentes ficam no localStorage e o
 * useOfflineFlush drena de novo ao remontar (confirmUnit/picking são idempotentes).
 * Por isso NÃO gateamos por fila pendente (gatear arriscaria "fila travada nunca
 * atualiza"); só exigimos estar ONLINE, senão o reload só re-serviria o cache velho.
 *
 * O toast, a checagem ativa de update e o estado exibido no menu moram em
 * `pwa-atualizacao.ts` (compartilhado com o fallback nativo do main.tsx). Antes,
 * ninguém chamava `registration.update()` e o iPhone ficava dias no build velho
 * — o porquê, medido, está no cabeçalho de lá.
 */
export function setupPwaUpdatePrompt(): void {
  // registerSW roda ANTES de `aplicar` no texto, mas os callbacks só são chamados
  // depois (registro assíncrono) — por isso `aplicar` é `function` (hoisted).
  const updateSW = registerSW({
    onNeedRefresh() {
      marcarAtualizacaoPronta(aplicar);
    },
    onRegisteredSW(_url, registro) {
      if (registro) acompanharRegistro(registro, { aplicar });
    },
  });

  function aplicar() {
    void updateSW(true); // posta SKIP_WAITING e recarrega no 'controlling'
  }
}
