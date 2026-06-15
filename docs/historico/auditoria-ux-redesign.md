# Auditoria UX + Redesign visual + Premissas — registro histórico

> Movido do CLAUDE.md (§9-intro, §9b, §11) em 2026-06-14. A auditoria UX (2026-05-13) e o redesign visual v3 foram ENTREGUES — isto é o registro. As **convenções vivas** que saíram disso (useUrlState, text-status-*, PageSkeleton, sonner, etc.) ficaram no CLAUDE.md §9 "Padrões e convenções".

## §9 — Auditoria UX (intro + fases)
## 9. Auditoria UX (entregue)

Quatro fases concluídas. Artefatos em `docs/ux-audit/`:

- ✅ **Fase 0** — Setup + este CLAUDE.md
- ✅ **Fase 1** — Inventário de telas em [docs/ux-audit/01-inventario.md](docs/ux-audit/01-inventario.md)
- ✅ **Fase 2** — Auditoria heurística (Nielsen + critérios de domínio D1-D6) das 10 telas top em [docs/ux-audit/02-heuristica.md](docs/ux-audit/02-heuristica.md)
- ✅ **Fase 3** — Roadmap ICE com top 20 intervenções em [docs/ux-audit/03-roadmap.md](docs/ux-audit/03-roadmap.md)
- ✅ **Fase 4** — Execução completa em [docs/ux-audit/04-execucao.md](docs/ux-audit/04-execucao.md) (20/20 itens entregues; alguns como scaffold pendente decisão de produto/schema)


## §9b — Redesign visual + telemetria
## 9b. Redesign visual + telemetria (entregue após a auditoria UX)

Trabalho posterior à Fase 4, no mesmo branch. Artefatos em `docs/visual-direction/`:

- ✅ **Direção visual** — reposicionamento "fintech/SaaS premium" (Vercel/Mercury/Stripe Dashboard). Tokens v3 em `src/index.css`, Geist + Newsreader, dark mode, sidebar light, paleta low-fatigue. Spec em `01-direcao.md` / `02-tokens.md`
- ✅ **Validação** — contraste WCAG calculado (`03-validacao.md`), audit de cores hardcoded (19 telas migradas + sweep de resíduos de sed)
- ✅ **Identidade** — wordmark Colacor, monogramas por empresa, sidebar enxuta (`04-identidade.md`)
- ✅ **Polish via skill `frontend-design`** — 7 quick wins aplicados, 13 itens documentados em `05-revisao-skill.md` (todos implementados em rodada posterior: serif display, atmosphere em cockpits, status-bold, kpi-delta, favoritos, etc.)
- ✅ **Search global no Cmd-K** — `useGlobalSearch` busca clientes/fórmulas/pedidos no Supabase; recentes em localStorage
- ✅ **Telemetria PostHog** — ver §2. Dashboard "Afiação — Adoção UX" criado (project 423408)
- 🟡 **Scaffolds pendentes de sprint próprio**: TouchPickingView **auto-detect mobile** (a confirmação offline de item já está integrada; falta só o roteamento automático mobile vs `/admin/estoque/picking/mobile`), segmentos de cliente / histórico NF-e em schema (hoje localStorage). Recebimento + picking + **envio de pedido (mesma-sessão, #261)** offline já **integrados** (ver §6 item 1). `submitOrder` offline cross-sessão foi avaliado e **deliberadamente não feito** (ver §6 item 1 — ganho marginal × risco no caminho do dinheiro). Scaffolds órfãos (`useBulkSelection`, `useOptimisticMutation`, `useKeyboardShortcuts`, `tint-cache`) foram deletados em PR #25 — re-criar quando voltarem a ter consumidor real.

> PR #4 foi mergeado em 2026-05-14. Auditoria pós-merge (PRs #24-33) capturou 4 issues bloqueantes que o PR #4 introduziu (SQL injection em useGlobalSearch, exposição de profiles sem gate, 66 classes Tailwind quebradas, PostHog DEV pollution) — todos corrigidos. **Lição operacional**: `bun lint && bun build` precisa virar required check no GitHub. ✅ **Feito** — CI (`.github/workflows/ci.yml`) + branch protection exigindo o check `validate` (ver §10). Disciplina: não bypassar com `--admin` de rotina.

---


## §11 — Premissas de auditoria + Glossário
## 11. Premissas de auditoria (confirmadas 2026-05-13)

Sem perguntas pendentes. Tudo confirmado pelo briefing oficial:

- **Empresas**: Colacor (indústria, vende industrializados) · Oben (distribuidora, compra e revende) · Colacor SC (serviços). `Afiação Colacor` no código vai virar `Colacor` em rename futuro.
- **5 personas operacionais** mapeadas via roles existentes + `commercial_roles` + futuro "departamento" (ver §5). Auditoria UX assume persona dominante conhecida por tela.
- **Offline-first em picking e recebimento**: ~~gap crítico (Workbox hoje `NetworkOnly`)~~ → ✅ **ENTREGUE** (NetworkFirst + fila offline + optimistic; ver §6 item 1). *[premissa de 2026-05-13, resolvida.]*
- **<100ms percebido em scan de barcode**: zero código. Propor implementação com optimistic UI.
- **Densidade alta operacional**: `density-compact` global é direção correta; auditar onde ainda é "consumer-grade" (`EmptyState.tsx`, `BottomNav.tsx`, `Header.tsx` legado).
- **WCAG AA mínimo, AAA em críticas**: focus-visible OK; **touch-targets 32px globais ficam abaixo** — propor variante 44px+ para telas mobile operacionais (separador, vendedor externo). Confirmado.
- **Mobile-first em chão, desktop-first em analítico**: AppShell hoje é desktop-first em ambos — auditar telas mobile-críticas.
- **Cmd-k global + atalhos consistentes**: `cmdk` instalado, `Command` shadcn presente, nada montado. Propor.
- **Optimistic UI em mutações operacionais**: princípio do briefing — auditar uso de `onMutate`/`onError` rollback no React Query (hoje esparso).
- **RLS em todas as tabelas**: fora do escopo desta auditoria UX. Se cruzar com tabela sem RLS, registro em "Observações fora do escopo" da fase.
- **Inspirações**: Linear · Notion · Carbon (IBM) · Polaris · Retool. DesignSystem.tsx atual declara HubSpot Canvas + Gong — realinhar.

### Glossário — termos que vão aparecer no roadmap

Pra ficar claro quando os termos entrarem na Fase 3:

- **Cmd-K (command palette)** — overlay de busca/comando que abre com `⌘K` ou `Ctrl+K`. Permite navegar para qualquer tela, executar ação ou buscar registro digitando 2-3 letras. É o padrão de Linear, Notion, Slack, Raycast: substitui menu, busca e atalhos numa única superfície. No nosso caso já temos a base (`cmdk` lib + `Command` shadcn), falta montar no AppShell com registry de comandos por persona.
- **BarcodeDetector API** — API nativa do navegador (Chrome/Edge/Android) que lê códigos de barras e QR direto da câmera, sem biblioteca pesada nem servidor. Latência típica <50ms. Substitui ZXing/Quagga e é o caminho moderno pra picking/recebimento. Tem fallback necessário para Safari/iOS onde a API ainda não está estável.
- **Optimistic UI** — atualizar a tela imediatamente como se a operação tivesse dado certo, e só reverter se o servidor recusar. No React Query: `useMutation({ onMutate, onError })`. Crítico para scan/picking — sem isso o usuário espera 200-800ms a cada bipe.
- **FEFO** (First Expire, First Out) — termo já no domínio: priorizar saída do lote com validade mais próxima. Já implementado em `RecebimentoConferencia` e visível como KPI em `AdminEstoquePicking` (lote_fefo).

Tudo isso vira critério ativo da Fase 2 (heurística D1–D6) e priorização ICE da Fase 3.

