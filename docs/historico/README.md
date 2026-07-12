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
| [reposicao-caixa-skill.md](reposicao-caixa-skill.md) | skill `reposicao-caixa` (decisão de compra ↔ caixa/NCG da Oben; custo marginal do caixa, gate de caixa como veto, antecipar aumento/promoção); lições do teste real: `custo_capital_efetivo_perc` é % a.a. (erro de 12×) + RPC de caixa gated a staff |
| [posthog-erro-email.md](posthog-erro-email.md) | ponte PostHog Error Tracking → e-mail (edge `posthog-error-webhook` + RPC `enfileirar_erro_app` dedupe/circuit-breaker + `dispatch-notifications`); fix do `listaUrl` do rollup; follow-ups do founder |
| [perf-ondas.md](perf-ondas.md) | auditoria de performance 2026-07-04 (5 PRs: telefonia fora do boot, contexts memoizados, virtualização, projeções/waterfall, optimistic recebimento, PWA prompt); bugs que o Codex pegou (efetivar NF-e sobre unidade não persistida; quebrar offline-first no 1º acesso); lições de método |
| [benchmark-concorrentes-marcenaria-2026-07.md](benchmark-concorrentes-marcenaria-2026-07.md) | **análise/proposta (NÃO iniciada)** — benchmark de 7 distribuidores de marcenaria (Leo Madeiras/GMAD/Rede PRÓ/Sim/W/Madeiranit/Gasômetro); tabela de 15 gaps com evidência `arquivo:linha` + parecer Codex; tese "Central da Ferramenta e Serviços" (reposicionar afiação/ROI, não copiar nesting/3D/BNPL); programa em 4 ondas priorizado |

> **As 3 camadas do refactor:** lição durável reutilizável → `docs/agent/<dominio>.md` (carregada sob demanda); **narrativa histórica** → aqui; detalhe profundo (spec/plano) → `docs/superpowers/{specs,plans}/`. Plano: `docs/superpowers/plans/2026-06-14-refactor-claude-md.md`.
