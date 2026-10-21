# Atalhos soltos → registry (plano v2 · §3 pontuais)

2026-10-21. O plano v2 listava 3 arquivos com `keydown` solto, contra a convenção `useRegisterShortcuts` (o `?` lista o que está registrado).

## O que mudou

- **`CockpitGrid`**: os atalhos 1–6 (rolar até a zona e destacá-la) e o Esc do edit mode agora passam pelo registry, e aparecem no dialog `?` no grupo "Cockpit". Isso trouxe duas diferenças de comportamento, ambas a favor:
  - **Cmd/Ctrl+1–6 voltou a ser do navegador** (troca de aba). O listener antigo lia `Number(e.key)` sem olhar modificador, e rolava o cockpit no mesmo gesto.
  - `select` também bloqueia (o guard antigo só olhava input, textarea e contenteditable).
- **`HelpDrawer` e `ShortcutsDialog`**: saiu o Esc manual. O Radix (Sheet/Dialog) já fecha no Esc pelo `onOpenChange`, e os próprios comentários diziam "kept for completeness".

## Prova

`src/components/dashboard/__tests__/CockpitGrid.atalhos.test.tsx` (6 casos, com o registry real). Falsificado na mesma invocação: controle verde; o `CockpitGrid` da main ficou vermelho no caso Cmd/Ctrl+2; o ramo do edit mode sabotado ficou vermelho no caso do Esc.

Lição de teste: disparar `keyDown` no `window` quebrava o guard antigo (`window` não tem `tagName`) e dava um vermelho pela razão errada. No navegador o alvo é o `body` ou um elemento, e o teste usa `document.body`.

## Pontuais do §3 que não precisavam de PR

- Saldo bancário de `FinanceiroGestao`: já oculto (decisão do founder, 2026-10-19).
- "`manifesto.ts` diz 0 testes no `caca`": falso hoje. `contarArquivos` conta como teste todo `.test.` sob os globs de `codigo`, e os 11 testes do caça estão sob `src/lib/caca/**` e `src/components/caca/**`.
