# Modularização — diário do programa (F1→F4)

> Programa de separação do app em módulos avaliáveis (bugs/qualidade/velocidade por módulo). Specs em `docs/superpowers/specs/2026-07-08-modularizacao-f*`. Ordem executada (decisão do founder 2026-07-08, acatando parecer Codex): **F1→F2→F4**, com **F3 (mover código físico) adiada** para janela coordenada dedicada — e re-decidir lá se ainda vale.

## ✅ F2 — gate de fronteiras anti-vazamento com ratchet (2026-07-08, PR #1255)

- **Regra**: negócio importa só de si+plataforma; plataforma↛negócio exceto `COMPOSICAO_RAIZ` (`App.tsx`); `import type` conta (kind no diagnóstico); teste de A importando B = acoplamento A→B.
- **Baseline inventariada**: 284 arestas (219 runtime + 65 type, 58 pares). Aresta nova fora dela = CI vermelho; aresta resolvida não-removida = vermelho (burn-down). `bun scripts/fronteiras-modulos.ts gerar-baseline|relatorio`.
- **Extrator = parser TS** (dep já existente), não regex — risco nº1 era falso-negativo (Codex). `vi.mock`/`export * from`/multi-linha cobertos; css não é dependência arquitetural; não-resolvidos EXPOSTOS (4).
- **Falsificado**: sabotagem `export type … from` cross → vermelho com a aresta exata; revertido → verde.
- Pares mais quentes (alvos de burn-down): telefonia→reposicao (35) · farmer↔telefonia (26+17) · farmer→tarefas (13).

## ✅ F4 — bundle por módulo + dieta do entry (2026-07-08, PR #TBD-nesta-entrega)

- **Tooling**: `heavy bunx vite build --sourcemap` + `bun scripts/bundle-modulos.ts` → bytes por módulo/pacote, EAGER (entry+modulepreload) vs LAZY. Parser de sourcemap (VLQ) próprio, testado — zero dep nova.
- **Achados**: entry tinha ~48 KB fonte (~22%) de módulos de NEGÓCIO — causa = inversões plataforma→negócio da baseline F2 (o shell importa chips/hooks cross estáticos). Vendors pesados já estavam saudáveis (elevenlabs/charts/posthog/livekit/jssip todos lazy). Chunk lazy de ~74 kB gzip = stack react-markdown (candidato futuro).
- **Fix aplicado**: 3 chips do header (`ActiveOverrideBadge`, `PersonaSwitcherChip`, `MelhoriasPopover`) → `React.lazy` (idioma já existente no Layout). Entry **72.94→70.09 kB gzip (-3.9%)**; governanca eliminada do eager. `IncomingCallModal` segue eager DE PROPÓSITO (caminho de atender chamada — decisão de produto no código).
- **Fora desta fase (recomendação quantificada)**: os HOOKS do sino no AppShell (useFinanceiroAlertas/useTarefas/useReposicaoSessao/useTintAlertas/useCallLog/useWhatsappSla/useMelhorias) seguram ~30 KB fonte de negócio no eager — refactor do coração do shell (2º arquivo mais quente do repo) = PR dedicado com QA visual; queima também 7 inversões da baseline F2.
- **Lição de processo**: critério de aceite pré-medição (reverter se <5 kB gzip) foi EMENDADO às claras no spec quando a composição fina mostrou o teto teórico da cirurgia (~3 kB) — emenda documentada ≠ emenda silenciosa.

## ✅ F1 — manifesto + gate + boletim de saúde (2026-07-08, PR #1251, squash `f5535428`)

**Entregue** (só arquivos novos — zero toque em código quente, zero mudança em package.json/lockfile/CI):

- `src/lib/modulos/manifesto.ts` — 15 módulos (14 negócio ancorados no `mapa-do-app.md` + `plataforma`), ownership EXCLUSIVO (1 dono/arquivo), flags de risco (money-path/offline-first/auth-sensitive), `NAO_CLASSIFICADOS = []` (bootstrap fechou sem dívida).
- Gate `manifesto.gate.test.ts` — teste vitest comum (roda no CI de graça): órfão novo/sobreposição/glob-morto/entrada stale = vermelho. É o anti-apodrecimento do manifesto.
- `scripts/boletim-modulos.ts` — `boletim` (saúde por módulo: arquivos/testes/densidade/LOC/churn 30-90d/suíte/tsc/lint atribuídos por dono) e `test <id>` (roda SÓ os testes do módulo — ex.: caca = 10 arquivos/160 testes em 1.7s vs suíte de ~580 arquivos).
- `docs/modulos/boletim-inaugural.md` — evidência; boletins seguintes sob demanda (snapshot commitado recorrente = ímã de conflito).

**Leitura inaugural de risco:** reposição churn 956/90d (money-path) · vendas 283/30d · admin-crm densidade 0.12 · produção `sem-testes`.

**Lições/decisões que valem para as próximas fases:**

- **Honestidade de métrica é regra money-path aplicada ao tooling:** cobertura sem provider = `desconhecido` (instalar `@vitest/coverage-*` mexeria em lockfile = conflito com worktrees — adiado de propósito); módulo sem teste = `sem-testes`, nunca "passou"; typecheck é UM programa (`tsconfig.app.json`) → coluna reporta a LOCALIZAÇÃO dos erros por dono, nunca "typecheck do módulo X passou" (semi-ilusório documentado no próprio boletim).
- **Boletim roda a suíte GLOBAL 1× e atribui por path** (reporter JSON) — rodar 15 vitests separados seria mais lento (overhead de bootstrap; M2 8GB). Filtro por módulo é ferramenta de DEV, não de CI.
- **Consumer-grep corrige rascunho:** 3 atribuições erradas pegas na verificação (`fila` = fila de AÇÕES do vendedor → farmer, não fila de separação; `useCriticaFila` idem; `omieService` → plataforma). Regra que funcionou: dono = módulo das páginas consumidoras; genérico multi-módulo → plataforma; ambíguo real → `NAO_CLASSIFICADOS` datado.
- **Matcher próprio de globs restritos (~40 linhas)** em vez de dependência nova — gramática `dir/**` · `*` por segmento · path exato cobre tudo que o manifesto precisa.
- Export usado só por `scripts/` não conta para o knip (`project` = `src/**`) → API pública mínima; helper interno sem `export`.

**F2 (próxima):** fronteiras anti-vazamento (dependency-cruiser/eslint-boundaries) importando o MESMO manifesto. **F3:** só com janela coordenada entre worktrees (e re-decidir se ainda vale). **F4:** perf/bundle por módulo.
