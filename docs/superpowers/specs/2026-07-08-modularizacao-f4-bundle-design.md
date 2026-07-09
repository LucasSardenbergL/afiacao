# Modularização — F4: velocidade / bundle por módulo (design)

> Fase 4 do programa (F1 #1251 · F2 #1255; F3 adiada por decisão do founder em 2026-07-08 — janela coordenada). Diário: `docs/historico/modularizacao.md`.

## Medição real (2026-07-08, build de produção + sourcemap)

- Build: 314 chunks JS; **159 pages lazy** (code-splitting por página já saudável); `manualChunks` do vite.config já isola vendors pesados (elevenlabs 119 kB gzip, charts 114, posthog 63 — todos fora do boot ✓).
- **Boot real** (`dist/index.html`): entry `index-*.js` **72.9 kB gzip** + 7 vendors preload (react 53.5, ui 47.4, supabase 45.7, query/dates/icons/utils) + CSS 24.5.
- **Problema encontrado**: o entry contém **~47 KB raw (~22%) de módulos de NEGÓCIO** — financeiro 16 KB, governanca 11 KB, telefonia 8 KB, tarefas 5 KB, farmer/reposicao/tint/estoque ~8 KB — que todo usuário paga no boot.
- **Causa raiz = inversões plataforma→negócio da baseline F2**: `AppShell`/`AppShellLayout` importam ESTATICAMENTE hooks do sino de alertas (useFinanceiroAlertas, useTarefas, useReposicaoSessao, useTintAlertas, useCallLog, useWhatsappSla, useMelhorias) e 6 componentes cross (PersonaSwitcherChip, ActiveOverrideBadge, MelhoriasPopover, CallCopilotHud, IncomingCallModal, TransferSpikePanel). F2 apontou as arestas; F4 confirma o custo em bytes.
- Achado secundário (sem ação nesta fase): chunk lazy compartilhado de ~73.8 kB gzip é o stack react-markdown (micromark/mdast/unified) — candidato futuro.

## Decisões

1. **Tooling durável primeiro**: `bundle` por módulo — parser de sourcemap v3 (decoder VLQ próprio, ~40 linhas, zero dep nova) que atribui os bytes de cada chunk ao módulo dono (manifesto F1) ou ao pacote npm; distingue **eager** (entry + modulepreload do `dist/index.html`) de lazy. Vive em `src/lib/modulos/bundle.ts` (puro, testado) + subcomando no script.
2. **Fix cirúrgico mínimo**: os **6 componentes** cross do shell → `React.lazy` + `Suspense` (fallback null/preservando layout). Os **hooks** do sino NÃO são tocados nesta fase (refactor do coração do AppShell — 2º arquivo mais quente do repo — exige PR dedicado com QA visual; ficam como recomendação quantificada no diário).
3. **Prova de ganho**: rebuild + medição antes/depois no PR. **Ganho pífio (<5 kB gzip no boot) → reverter o fix** e reportar honestamente (tooling fica mesmo assim).
4. `React.lazy(() => import(...))` mantém as mesmas arestas na baseline F2 (import() é aresta runtime) — sem retrabalho de baseline.

## Critérios de aceite

1. Parser de sourcemap com testes (VLQ: valores negativos, multi-segmento, linha vazia, source ausente).
2. Relatório `bundle` gerado do build real, com eager/lazy por módulo e "desconhecido" onde o map não cobrir (regra money-path do tooling).
3. Antes/depois medido do fix; reversão se pífio.
4. Bateria global verde; knip limpo nos arquivos novos; QA mínima dos 6 componentes lazy (render sem crash — testes existentes do shell).
