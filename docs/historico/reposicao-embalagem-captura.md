# Captura mensal de preços Sayerlack (embalagem econômica) — Fase 1

> Spec: `docs/superpowers/specs/2026-07-14-sayerlack-captura-preco-embalagem-design.md` · Sessão: 2026-07-16 → 17

## Entregue (7 PRs, todos auto-merge no verde)

| PR | O quê |
|---|---|
| #1339 | Edge `sayerlack-captura-precos` (spike/full) + run-log (`sku_preco_captura_run[_item]`) + cron mensal `0 9 10-12 * *` (jobid 161) + stale 24→960h + hardening pós-Codex (P0 gate de persistência; identidade de cliente/item; budget com aborto limpo) |
| #1348 | `page.on('dialog')` aceita confirm() do portal + poll no cancel + guard `RASCUNHO_SUJO_INICIAL` |
| #1374 | Auto-limpeza segura de rascunho residual (`classificarLinhasRascunho`, só SKUs do mapa completo) + suíte do helper (paridade byte a byte src↔`_shared`) |
| #1383 | Placeholder do DataTables ("Nenhum dado disponível") ≠ linha — falso rascunho-sujo/cancel-não-comprovado |
| #1388 | Remoção em tiers (lixeira vs X-de-edição) + `trace_tail` no erro do run falho |
| #1392 | Budget 300s/330s/335s (full de 28 morreu órfão na persistência com 340s) |
| #1400 | Seleção EXATA no select2 (1ª opção era item errado — a conferência de identidade segurou) + eco da linha no "não confere" |

**Aplicado em prod:** migration (SQL Editor) ✓ validada via psql-ro · edge deployada (chat Lovable) ✓ · Publish ✓ verificado pelos bytes (`AdminReposicaoEmbalagem-BVtuSka8.js` contém "Atualizar do portal"). Kill-switch `embalagem_captura_automatica_habilitada` segue **false** (ligar é decisão do founder).

## Pendência única no fecho da sessão

**Spike-B final bloqueado pelo portal fora do ar** (run `883f850a` = `LOGIN_FAILED` limpo, confirmado pelo founder que o portal não funcionava no dia 17). Quando voltar: re-disparar o bloco do spike (`modo:spike, disparo:manual` — está no chat da sessão e na spec) e conferir: run `ok`, 2 preços WP01 vs tela, `linhas_finais_portal=0`. O cron dos dias 10-12 é o fallback natural.

## A saga dos 8 spikes (o que cada falha ensinou)

1. **v1** `CANCEL_NAO_COMPROVADO` — confirm() dismissado (default do puppeteer) → #1348
2. **v2** `RASCUNHO_SUJO_INICIAL` — órfã real do v1; guard correto
3. **v3** idem com grade limpa — 1º falso positivo (placeholder, ainda não sabíamos)
4. **v5** `RASCUNHO_SUJO_HUMANO` com "linha" = _"Nenhum dado disponível na tabela"_ — **o guard fail-safe entregou o diagnóstico** → #1383
5. **v6** cancel não comprova: linha auto-gravada (Seq) + ✖ de edição ≠ remoção → #1388 (e o full órfão → #1392)
6. **v7 (a5094f98)** — 1º trace completo: browser 100% ok; a **conferência de identidade** reprovou os 2 (select2 1ª opção = item errado) → **0 preços errados gravados**; precisão>recall funcionando → #1400
7. **v8** `LOGIN_FAILED` — portal fora do ar (externo)

## Padrões que nasceram aqui (reusáveis)

- **Helper compartilhado interpolado no Browserless** via `${fn.toString()}` — fonte única testável em vitest, com teste "self-contained" (sem crase/`${`)
- **Trace no erro do run** (`trace_tail`, últimos 8 passos): screenshot mostra o estado final; o trace mostra a SEQUÊNCIA
- **Guard fail-safe que relata o que viu** (a linha desconhecida no erro) transforma abort em diagnóstico
