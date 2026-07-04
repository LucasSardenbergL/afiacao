import { registerSW } from 'virtual:pwa-register';
import { toast } from 'sonner';

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
 */
/** id fixo → o Sonner deduplica: reabrir NÃO empilha, apenas atualiza o mesmo toast. */
const UPDATE_TOAST_ID = 'pwa-update-available';

export function setupPwaUpdatePrompt(): void {
  // Fica true enquanto houver um SW novo em waiting. NÃO usamos um latch
  // "shown" (que travaria o reaparecimento se o operador dispensasse o toast):
  // o id fixo evita empilhar, e o listener de 'online' reabre se ainda pendente.
  let needsUpdate = false;

  // registerSW roda ANTES de showPrompt no texto, mas onNeedRefresh só é chamado
  // depois (nunca no install) — por isso showPrompt é `function` (hoisted): quebra
  // o ciclo sem precisar de `let updateSW` (que o prefer-const rejeitaria).
  const updateSW = registerSW({
    onNeedRefresh() {
      needsUpdate = true;
      showPrompt();
    },
  });

  function showPrompt() {
    // Offline: reabre no evento 'online' (reload agora só re-serviria cache velho).
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    toast('Nova versão disponível', {
      id: UPDATE_TOAST_ID,
      description: 'Atualize quando terminar a tarefa atual.',
      duration: Infinity,
      action: {
        label: 'Atualizar',
        onClick: () => {
          void updateSW(true); // posta SKIP_WAITING e recarrega
        },
      },
    });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      if (needsUpdate) showPrompt();
    });
  }
}
