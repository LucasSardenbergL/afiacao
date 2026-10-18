import { acompanharRegistro, aplicadorPadrao } from '@/lib/pwa-atualizacao';

/**
 * Registra o service worker (`/sw.js`, o SW ponte de `src/sw/sw.ts`) pela API
 * NATIVA e arma o acompanhamento da atualização (`pwa-atualizacao.ts`).
 *
 * POR QUE nativo, e não mais `registerSW` do `virtual:pwa-register` (2026-10-18,
 * parecer Codex): o wrapper do vite-plugin-pwa, no modo prompt, arma um
 * `controlling → location.reload()` ASSIM QUE vê um SW em waiting — antes de
 * qualquer clique. Com o SW ponte assumindo sozinho, esse listener viraria o
 * reload-surpresa que o modo prompt existe para evitar. Aqui, recarregar só
 * acontece pelo `aplicar` — clique em "Atualizar", exigência de build mínimo, ou o
 * momento seguro (app voltou do segundo plano após 30 min, fila offline vazia).
 *
 * SEM `updateViaCache` próprio, de propósito: mudar a opção em relação ao registro
 * antigo ('imports', o default) dispara um ciclo de update EXTRA na 1ª página do
 * build novo — medido na prova E2E de 2026-10-18: um 2º SW em waiting enquanto o
 * 1º ainda ativava, e a página nascendo sem controle (offline falhava). O `/sw.js`
 * já vem `no-cache` do host e o `push-sw.js` revalida por etag.
 *
 * Chamado SÓ em produção non-preview (main.tsx, guard `__PWA_ENABLED__`).
 */
export async function setupPwaUpdatePrompt(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  acompanharRegistro(reg, { aplicar: aplicadorPadrao(reg) });
}
