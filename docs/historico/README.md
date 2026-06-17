# docs/historico/ — diário de PR / entregas (movido do CLAUDE.md)

Registro consultável de **PRs/bugs/programas/auditorias já entregues** — a narrativa íntegra (problema → diagnóstico → fix → lição), movida das §5/§9/§10 do CLAUDE.md na frente 1 do refactor (2026-06-14/15; decisão do founder: **mover íntegro, zero descarte**). Consolidou a antiga `docs/registro/`.

**Não é lido a cada sessão** — o CLAUDE.md ficou só com regras vivas. Venha aqui quando precisar do **detalhe/contexto** de uma entrega. Ao concluir uma entrega nova, **registre aqui** (não no CLAUDE.md).

| Arquivo | O que tem |
| --- | --- |
| [bugs-resolvidos.md](bugs-resolvidos.md) | (era §10) cada bug/contradição/débito resolvido, com PR + lição (multi-domínio: KB, Radar, reposição, sync…) |
| [programas-vendas.md](programas-vendas.md) | WhatsApp + Motor de Rota; copiloto "Buddy" |
| [auditoria-ux-redesign.md](auditoria-ux-redesign.md) | (era §9/§9b/§11) auditoria UX 2026-05-13 + redesign visual v3 + premissas/glossário |
| [estoque-picking-recebimento.md](estoque-picking-recebimento.md) | offline-first + closed-loop (Picking Bridge Oben, Recebimento honesto) |
| [tintometrico.md](tintometrico.md) | vínculo `tint_skus`↔Omie (resgate de 62 cores que somem do seletor) + lições de matching de catálogo |
| [geocoding-cep.md](geocoding-cep.md) | geocoding por CEP do Roteirizador-campo (`cep_geo` SoT, gate CEP Aberto 91,5%, edge-proxy `cep-geo-resolver`, import da carteira) |
| [posthog-erro-email.md](posthog-erro-email.md) | ponte PostHog Error Tracking → e-mail (edge `posthog-error-webhook` + RPC `enfileirar_erro_app` dedupe/circuit-breaker + `dispatch-notifications`); fix do `listaUrl` do rollup; follow-ups do founder |

> **As 3 camadas do refactor:** lição durável reutilizável → `docs/agent/<dominio>.md` (carregada sob demanda); **narrativa histórica** → aqui; detalhe profundo (spec/plano) → `docs/superpowers/{specs,plans}/`. Plano: `docs/superpowers/plans/2026-06-14-refactor-claude-md.md`.
