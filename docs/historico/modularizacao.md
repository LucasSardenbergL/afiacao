# Modularização — diário do programa (F1→F4)

> Programa de separação do app em módulos avaliáveis (bugs/qualidade/velocidade por módulo). Spec e plano da F1 em `docs/superpowers/{specs,plans}/2026-07-08-modularizacao-f1-*`. Ordem comprometida: F1→F2→F3→F4; **parecer Codex a revisitar após a F2**: F4 antes de F3 e F3 (mover código físico) como *opcional* — "manifesto+fronteiras resolvem 80%; F3 é o maior risco de merge".

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
