# Lente "Ver como pessoa" — impersonação (referência operacional)

> Como a lente separa LEITURA de ESCRITA/identidade. Lição durável carregada sob demanda. Specs: `docs/superpowers/specs/2026-05-25-ver-como-persona-impersonacao-design.md` + `2026-06-05-lente-ver-como-pessoa-*` + `2026-06-06-lente-fase-*`. Diário em `docs/historico/bugs-resolvidos.md`.

## O princípio (a regra-mãe)

- A lente deixa um **master "ver o app como" outra pessoa** (vendedor, gestor) para suporte/QA. É **leitura aumentada**, NUNCA troca de identidade.
- **`useAuth()` é SEMPRE o usuário REAL** — sessão, escrita, identidade e RLS são do master logado. Só **LEITURA** usa `effectiveUserId` / `display*` (`displayIsStaff`, `useDisplayAccess`).
- **Nunca decidir escrita ou identidade com `display*`.** Quem grava/autoriza é o `useAuth()` real. Decidir mutação com `display*` = vazamento (gravar como a persona impersonada, ou a persona enxergar escrita que não é dela).

## Write-guard + furos (a armadilha cara)

- O **write-guard** do client bloqueia mutação Supabase enquanto a lente está ativa (`isImpersonating` / `isLensActive()`).
- ⚠️ **Todo caminho que escapa do Supabase client fura o write-guard** e precisa gatear a lente **NA FONTE**:
  - **WebRTC** (a ligação não passa pelo Supabase) → `WebRTCCallContext.makeCall`/`acceptIncoming` guardam com `isLensActive()` na própria fonte.
  - mesma regra para `fetch` direto / edge invocada client-side / qualquer side-effect externo.
- UI mutante sob a lente fica **`disabled`** (ex.: painel de vínculo KB master-only → `disabled` quando `isImpersonating`), mas `disabled` é **cosmético**: a fronteira REAL é o gate no banco/fonte (RPC master-only, RLS), nunca a UI.

## UI lente-aware (topbar)

- `ActiveOverrideBadge` sinaliza a lente ativa.
- `DataHealthBadge` e `NetworkStatusIndicator` (Tipo/RTT) usam `displayIsStaff`/`useDisplayAccess` → respeitam a persona vista (ex.: "ver como" vendedora sales-only esconde o que ela não veria, senão a lente vaza acesso que a persona real não tem).
