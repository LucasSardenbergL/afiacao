# Fase 2 — LEIA PRIMEIRO (handoff de contexto)

> Sessão nova começando? **Leia este arquivo antes de tocar em qualquer coisa.** Ele existe pra a gente não perder o objetivo principal nem re-descobrir o que já foi decidido.

---

## ⭐ OBJETIVO PRINCIPAL (não perca isto de vista)

Construir a **rotina comercial que se retroalimenta**: a IA capta o sinal de **cada ligação** da vendedora (farmer) e devolve isso em **(a)** o que oferecer na próxima ligação e **(b)** inteligência de compra/catálogo. O comercial **aprende sozinho** a cada ligação.

> **Founder, 1ª mensagem (verbatim):** *"…tem que ter algum rotina comercial se possível atrelada as ligações das farmers para antever algo que elas possam oferecer no momento da ligação delas, ou seja, o comercial tem que se retro alimentar."*
>
> **Founder, ao detalhar a captura:** *"eu queria que a IA percebesse o que ela fizesse… ela mesma preenche isso… dados referentes a preço, marca que o cliente tá utilizando, produto que ofertamos e não temos, novos produtos."*

## ⚠️ O QUE NÃO ESQUECER

1. **O coração do pedido é o LOOP** (a **Fatia 2** — captura inteligente do sinal). A **Fatia 1** (oferta na ligação) é só o **primeiro passo visível** — NÃO pare nela achando que o objetivo foi cumprido.
2. **A vendedora NÃO preenche nada manualmente.** A IA capta da **gravação** (a ligação já é gravada/transcrita). Mandar a farmer digitar = desperdício, e o founder rejeitou isso explicitamente.
3. Os **4 sinais** que a Fatia 2 precisa extrair da gravação: 💰 **preço** (cliente/concorrente) · 🏷️ **marca/produto que o cliente usa** · 📦 **produto que ofertamos mas não temos** (gap de catálogo) · 🆕 **demanda por produto novo**. Servem pra próxima ligação **E** pra decisão de compra/estoque.

## Decomposição (2 fatias — founder escolheu fazer faseado)

| Fatia | O que é | Estado |
|---|---|---|
| **Fatia 1 — Oferta viva na ligação** | Oferta campeã + gancho, **pré-gerada de madrugada** pros top ~25 da agenda, mostrada automática na tela de ligação | **Planejada, pronta pra implementar** |
| **Fatia 2 — Captura inteligente** | A IA ouve a gravação e extrai os 4 sinais → retroalimenta oferta/agenda + sinal de catálogo | **Esboçada** (spec §11) — desenhar em spec próprio quando chegar a vez |

## Estado do mundo (2026-06-15)

- **Fase 1 (fornecedores fora da carteira): NO AR em produção** ✅ — 519 fornecedores fora da carteira, carteira limpa. (PRs #880/#886 na main.) **Pré-requisito cumprido:** a Fatia 1 opera sobre uma carteira já sem ruído de fornecedor.
- **Fatia 1:** spec + plano completos e commitados.
- **Fatia 2:** só o esboço (spec §11).

## Documentos (leia nesta ordem)

1. **Spec da Fatia 1:** `docs/superpowers/specs/2026-06-15-rotina-comercial-oferta-na-ligacao-design.md` (decisões §2, desenho §4, Fatia 2 esboçada §11, riscos §12).
2. **Plano da Fatia 1 (6 tasks, código real):** `docs/superpowers/plans/2026-06-15-fase2-oferta-na-ligacao.md` — executar com **superpowers:subagent-driven-development**.

## Como retomar

- **Implementar a Fatia 1:** seguir o plano task-por-task (Task 1 = helper puro TDD → … → Task 6 = rollout). Branch atual: **`claude/fase2-oferta-ligacao`** (já contém spec+plano).
- **Depois da Fatia 1:** brainstorming → spec da **Fatia 2** (o loop). É o que fecha o objetivo principal.

## Contexto técnico-chave (pra não re-descobrir)

**~90% da Fatia 1 já existe (reuso):**
- `generate-tactical-plan` (edge LLM, gateway Lovable) — gera o gancho (`offer_transition`) + objeções + perguntas.
- `ActivePlanCard` (`src/components/farmer/copilot/`) — **já aparece sozinho** na ligação via `getActivePlan` (`useFarmerCopilot:118`). Hoje mostra a tática, não a oferta.
- `useBundleEngine`/`useCrossSellEngine` → `farmer_bundle_recommendations`/`farmer_recommendations`.
- Gate de R$/h (`useTacticalPlan.checkEfficiency`, threshold 50) + agenda `priority_score` (`useFarmerScoring`).

**O loop está quebrado em 5 gaps (mapeados no brainstorming):** o principal é **não existe análise pós-call** → `farmer_calls.entities_extracted` fica NULL → `signal_modifiers` nasce vazio → nada retroalimenta. Fechar isso é a **Fatia 2** (a edge de análise da gravação alimenta o `scoring-recalc-client`, que **já existe**).

**Decisões cravadas pelo founder (não re-perguntar):** oferta+gancho (não leque) · pré-gerado top-25 · gate de R$/h · sem registro manual (IA capta) · captura = Fatia 2 com os 4 sinais.

**Riscos abertos da Fatia 1 (plano §12):** a montagem de contexto do `generate-tactical-plan` vive no **front** → o cron precisa dela **server-side** (o plano resolve com um modo self-contained `{customerId, farmerId}` na edge, deixando o front intacto).

## Pendência operacional do founder (Fase 1, paralelo)
Checar no campo se as **10 moveleiras** em exceção ainda operam (kit de manutenção já entregue: `DELETE fornecedor_excecao + aplicar_exclusao_fornecedores()` pra remover; `reverter_exclusao_fornecedor()` pra trazer de volta).
