# Boletim de saúde por módulo — 2026-07-09

Gerado por `bun scripts/boletim-modulos.ts boletim`. Fonte de ownership: `src/lib/modulos/manifesto.ts` (gate no CI).

Não classificados: 0

| Módulo | Arquivos | Testes (arq) | Densidade | LOC | Churn 30d | Churn 90d | Suíte | Erros TS | Erros lint | Riscos |
|---|---|---|---|---|---|---|---|---|---|---|
| loja-afiacao | 57 | 16 | 0.28 (proxy fraco) | 10610 | 41 | 175 | passou (16✓/0✗ arq) | 0 | 0 | — |
| tarefas | 22 | 8 | 0.36 (proxy fraco) | 4187 | 4 | 49 | passou (8✓/0✗ arq) | 0 | 0 | — |
| financeiro | 137 | 54 | 0.39 (proxy fraco) | 30188 | 104 | 441 | passou (54✓/0✗ arq) | 0 | 0 | money-path, auth-sensitive |
| vendas | 115 | 74 | 0.64 (proxy fraco) | 24856 | 283 | 544 | passou (74✓/0✗ arq) | 0 | 0 | money-path |
| farmer-inteligencia | 259 | 95 | 0.37 (proxy fraco) | 31727 | 216 | 750 | passou (95✓/0✗ arq) | 0 | 0 | — |
| caca | 14 | 10 | 0.71 (proxy fraco) | 3490 | 4 | 28 | passou (10✓/0✗ arq) | 0 | 0 | auth-sensitive |
| admin-crm | 50 | 6 | 0.12 (proxy fraco) | 7091 | 29 | 132 | passou (6✓/0✗ arq) | 0 | 0 | — |
| tintometrico | 37 | 16 | 0.43 (proxy fraco) | 8970 | 61 | 135 | passou (16✓/0✗ arq) | 0 | 0 | money-path |
| estoque-recebimento | 20 | 6 | 0.30 (proxy fraco) | 5029 | 5 | 87 | passou (6✓/0✗ arq) | 0 | 0 | money-path, offline-first |
| reposicao | 233 | 120 | 0.52 (proxy fraco) | 39358 | 177 | 956 | passou (120✓/0✗ arq) | 0 | 0 | money-path |
| producao | 5 | 0 | 0.00 (proxy fraco) | 998 | 6 | 10 | sem-testes | 0 | 0 | — |
| governanca | 83 | 27 | 0.33 (proxy fraco) | 11913 | 61 | 181 | passou (27✓/0✗ arq) | 0 | 0 | — |
| knowledge-base | 53 | 15 | 0.28 (proxy fraco) | 6448 | 63 | 125 | passou (15✓/0✗ arq) | 0 | 0 | — |
| telefonia-whatsapp-rota | 101 | 60 | 0.59 (proxy fraco) | 16126 | 115 | 374 | passou (60✓/0✗ arq) | 0 | 0 | auth-sensitive |
| plataforma | 199 | 72 | 0.36 (proxy fraco) | 45786 | 212 | 885 | passou (72✓/0✗ arq) | 0 | 0 | offline-first, auth-sensitive |

## Metodologia e limitações

- **Fatos**: nº de arquivos, LOC, resultado da suíte (1 run GLOBAL do vitest atribuído por dono do path), erros de tsc/eslint LOCALIZADOS por dono. O typecheck é um programa único — "Erros TS" é a LOCALIZAÇÃO do erro, não um "typecheck do módulo".
- **Proxies (fracos, rotulados)**: densidade testes/arquivos e churn git — indicam superfície de risco, não qualidade.
- **Desconhecidos (nunca fabricados)**: Cobertura = desconhecida (provider não instalado — decisão F1 p/ não tocar lockfile); bugs históricos por módulo = desconhecido (fonte docs/historico é prosa não-estruturada). Módulo sem teste aparece como `sem-testes`, jamais como aprovado.

## Avisos desta geração

- churn 30 days ago: 3 path(s) do git log sem dono atual (arquivos deletados/renomeados) — ignorados
- churn 90 days ago: 90 path(s) do git log sem dono atual (arquivos deletados/renomeados) — ignorados
