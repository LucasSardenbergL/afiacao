# G1 — Fila Única de Ação no "Meu Dia" (Waze comercial interno) — Design

- **Data:** 2026-06-04
- **Status:** Em revisão (saída do brainstorming, antes do plano de implementação)
- **Origem:** inspiração na startup **Biglink** ("Waze do marketing" — plataforma de *Marketing Mix Modeling*: integra dados de mídia/vendas/CRM e recomenda em tempo real onde alocar verba). Decisão do founder: **NÃO** copiar martech de mídia (a Colacor vende relacional B2B, não anuncia); **trazer o "efeito Waze" pro motor comercial interno** — a vendedora abre o dia e o sistema diz a próxima melhor jogada.
- **Segunda opinião:** Codex (consult, 2026-06-04) — incorporada (ver §12 e Anexo).
- **Idioma/contexto:** ver `CLAUDE.md`. Acesso a banco é só via Lovable SQL Editor; migrations custom exigem o ritual `lovable-db-operator`.

---

## 1. Contexto & motivação

Mapeamento do código (2026-06-04) revelou que a Colacor **já construiu quase todas as peças** de inteligência comercial, mas elas estão **(1) fragmentadas** em telas separadas, **(2) rodando em batch noturno**, e **(3) nunca foram usadas de verdade** pelas vendedoras (cemitério de features). Peças existentes:

- Recomendação/cross-sell: `association_rules`, edge `recommend`, `useCrossSellEngine`, `useBundleEngine`, Mix/Gap (`useMyMixGap`).
- Scoring/preditivo: `farmer_client_scores`, `customer_visit_scores`, `useMyVisitSuggestions` (recalc por cron noturno).
- Copilot turn-by-turn: `src/components/farmer/copilot/` (`DirectionIndicator`).
- Filas dispersas: `useRouteContactList` (ligar), `useTarefas` (cobrar), `useMyVisitSuggestions` (visitar), `useProximaAcao` (financeiro/A4).
- Agregador: `MeuDia.tsx` → `CommercialDashboard` → dashboards por `commercial_role` (`FarmerDashboardV2`/`HunterDashboard`/`CloserDashboard`/`MasterDashboard`). Hoje juntam **cards paralelos**, não uma fila priorizada.
- Realtime: infra existe (`useCockpitChannel`, `useWhatsappConversations`/`useWhatsappThread` com `.channel`), mas só em chat/inbox/recebimento/cockpit — **não** no motor comercial.

**O gap real não é construir motores. É orquestrar + ativar os que já existem** — exatamente a dor que a Biglink vende resolver: *"tinham os números, não conseguiam decidir."*

## 2. Decisão estratégica

- **Frente A** (extrair mais de quem **já** é cliente) primeiro; **Frente B** (captação de clientes novos / look-alike dos melhores) depois. O lucro/margem por cliente que a Frente A consolida vira o combustível do look-alike da Frente B.
- Dentro de A, ordem **revista com o Codex**: **G1 (fila única) → instrumentação → G4 seletivo (1-2 cockpits) → G1 refinado com uso real → G2 realtime → G3 preditivo**.
- **Filosofia (decisão do founder, validada):** **núcleo sólido → piloto com 1 vendedora (5-10 dias úteis) → refinar com uso real → estado-da-arte depois.** Isto vira deliberadamente a ordem "estado da arte antes de qualquer uso" — que é o padrão que gerou o cemitério de features.

## 3. Escopo do G1 v1

**Entra:**
- Uma **fila única de ações** liderando o "Meu Dia" da vendedora, alimentada por 4 fontes (§4).
- **Loop de feedback fechado** por ação (Fazer / Concluir / Adiar / Dispensar + motivo), com estado persistido (§7).
- **Ranking por categoria + guardrails** (§6).
- **Tela desktop** com split MeuDia (fila) | WhatsApp e **pedido em modo focado** (§8).
- **Instrumentação de adoção** desde o dia 1 (§9).

**Não entra ainda (pós-piloto, se os dados justificarem):**
- Realtime no motor comercial (G2).
- Antecipação preditiva nova (G3).
- Tabela materializada `suggested_actions` (§5 — derivamos no front no v1).
- Split redimensionável sofisticado; pedido 100% inline; mobile polido.
- Conversão de todos os cockpits (G4 é seletivo e vem depois).

## 4. Fontes do v1 (4)

Sob a ótica do dia da **vendedora** (não do CFO):

| # | Fonte | Hook existente | Categoria | "Por que apareceu" |
|---|-------|----------------|-----------|--------------------|
| 1 | Tarefas do founder | `useTarefas` | prazo/SLA | "Seu chefe pediu isto" |
| 2 | Ligações da rota | `useRouteContactList` | esperado + janela de rota | "Ligue — cidade de hoje, alto valor" |
| 3 | WhatsApp pendente | `useWhatsappConversations` | SLA forte (janela 24h) | "Cliente respondeu, ninguém retornou" |
| 4 | Oportunidade comercial | `useMyMixGap` | esperado | "Compra A e B, oferece C" |

Visita sugerida (`useMyVisitSuggestions`) e win-back já moram dentro de (1)/(2); ficam fora do v1 como fonte separada. **A confirmar:** as 4 fontes refletem o dia real da vendedora-piloto.

## 5. Arquitetura

**Decisão: derivar a fila no front + persistir só o feedback.** (Divergência consciente do Codex, que pediu tabela materializada `suggested_actions` desde já — ver Anexo.)

- Um **agregador client-side** chama os 4 hooks-fonte, normaliza cada item num **formato comum de ação** (`{ source, source_entity_id, customer_user_id, action_type, title, reason, category, score, expected_value?, value_kind }`), deduplica por `dedupe_key` (cliente + tipo de ação) e ranqueia (§6).
- **Estado de feedback persiste numa tabela leve nova** (ex.: `suggested_action_feedback`), espelhando o padrão **já existente** em `useCashflowAlertas` (`dismissed_at` / `dismissed_until` / `dismissed_by`) + estado `concluido`/`adiado`. Chaveada por `dedupe_key` + `seller_id`. Onde uma fonte já tem estado próprio (tarefas: `useTarefas.concluir/adiar/cancelar`; rota: `route_contact_log`/`registrar_contato_rota`), a ação **escreve no motor de origem**; a tabela de feedback cobre só o que não tem dono (mix-gap, e o "dispensar/adiar" genérico).

**Por que não materializar ainda:** os motores já rodam e expõem hooks; materializar a fila inteira (+ jobs que populam, + dedupe server-side, + "por que apareceu" persistido) é infra do estado-da-arte que só compensa com realtime/multi-vendedora/escala — que adiamos. **Quando o piloto provar adoção, materializamos** (`suggested_actions` + adapters por motor, como o Codex desenhou). Forward-compatible: o formato comum de ação do front é o mesmo schema da tabela futura.

**Risco do atalho:** dedupe e consistência ficam client-side; mitigação = `dedupe_key` obrigatório no formato comum + volume baixo do piloto (1 vendedora). Aceitável pra validar adoção.

## 6. Ranking por categoria (não score cru)

Nunca comparar "R$10k certo" com "talvez R$20k" no mesmo número (ranking enganoso). Cada ação tem **categoria**:

- **prazo/SLA** — tarefa vencendo, WhatsApp dentro da janela 24h.
- **valor certo** — compromisso explícito.
- **valor esperado** — `prob × ticket × margem × confiança` (mix-gap, oportunidade).
- **risco** — cliente esfriando (já embutido na rota/win-back).

**Guardrails:** SLA/prazo sobem; incerto **não** atropela tarefa explícita; rota só pesa no dia/cidade certa; baixa confiança fica abaixo; a UI sempre rotula **"estimado"**, nunca "valor", e mostra o **motivo** ("por que apareceu").

## 7. Loop de feedback (o que separa fila de dashboard-vazio)

Todo item tem: **Fazer** (botão primário, abre a execução) · **Concluir** · **Adiar** (snooze, com motivo) · **Dispensar + motivo** (sem sentido / já resolvido / dados errados / depois). Estado persiste (§5). Reusa padrões existentes: `useTarefas` (concluir/adiar/cancelar) e `useCashflowAlertas` (dismiss/snooze com `dismissed_at/until/by`). É o que gera as métricas do piloto **e** o sinal pra refinar.

## 8. Tela / UX (desktop, escritório)

- **MeuDia → `CommercialDashboard` → `FarmerDashboardV2`** (a piloto é farmer). A **fila lidera** o FarmerDashboardV2 (topo, proeminente); os cards atuais descem ou recolhem pra não competir pela atenção. *(Se a piloto for hunter/closer, plugamos no dashboard correspondente.)*
- **Split desktop:** painel esquerdo = fila (MeuDia); painel direito = contexto (WhatsApp / pedido). Estado dos painéis preservado ao alternar.
- **WhatsApp por composição:** reaproveita `useWhatsappConversations`/`useWhatsappThread` (já com realtime + janela 24h); deep-link por `customer_user_id`/`phone_e164`. **Não** duplicar a lógica da API.
- **Pedido em modo focado:** o `UnifiedOrder` é uma página pesada (`/sales/new`). O botão "Montar pedido" abre o fluxo **preservando o lugar na fila** (navegação com retorno, ou drawer full-height) e **volta pro item** ao fechar. **Não** embutir o wizard espremido em meia tela.
- **Responsivo (sem 2 UIs):** mesma arquitetura "ação atual + contexto + execução"; em telas estreitas a fila vira tela principal e a ação abre fullscreen com botão fixo "voltar à fila". No v1 polimos **desktop**; mobile fica funcional, não polido.

## 9. Instrumentação (sem isto o piloto é cego)

Logar desde o dia 1 (via `track()` de `@/lib/analytics`, convenção `<area>.<action>`):
- ações **mostradas / aceitas (Fazer) / concluídas / dispensadas** (+ motivo) / adiadas;
- **tempo até a 1ª ação** após abrir o MeuDia;
- **% de dias** em que ela abre o dia pelo MeuDia;
- **retorno no dia seguinte** sem alguém mandar;
- (posterior) receita/pedido originado de ação aceita.

## 10. O piloto

1 vendedora (farmer), **5-10 dias úteis**, rotina real. **Sucesso:** ela abre o dia pela fila; **60-70%** das ações aceitas/concluídas vêm da fila (não da memória); ela volta no dia seguinte sem empurrão. **Teste brutal (Codex):** depois de ~1 semana, tirar a fila por 1 dia — se ela reclamar, virou ferramenta; se não, ainda não.

## 11. Não-objetivos (v1)

Realtime no comercial; preditivo novo; `suggested_actions` materializada; split redimensionável sofisticado; pedido 100% inline; conversão de todos os cockpits; mobile polido; multi-vendedora/rollout amplo. Tudo isto é pós-piloto.

## 12. Riscos & mitigações (do Codex)

- **P1 — "Estado da arte antes do uso" repete o cemitério.** Mitigação: este design já inverte a ordem (núcleo → piloto → refina) e força o piloto com 1 vendedora antes de polir.
- **P1 — Fila vira só "cards empilhados" sem loop.** Mitigação: loop de feedback é requisito do v1 (§7), não opcional.
- **P1 — Pedido pesado espremido mata o fluxo.** Mitigação: modo focado preservando retorno (§8), não inline.
- **P2 — Ranking enganoso (certo × incerto).** Mitigação: categorias + guardrails + rótulo "estimado" (§6).
- **P2 — Dedupe/consistência client-side.** Mitigação: `dedupe_key` obrigatório + volume baixo do piloto; materializa ao escalar (§5).

## 13. Decisões em aberto (pro plano)

1. **`commercial_role` da vendedora-piloto** (assumido `farmer` → `FarmerDashboardV2`).
2. **Migration da tabela de feedback** (`suggested_action_feedback`) — exige ritual `lovable-db-operator` (SQL no Lovable + validação) antes do código depender dela.
3. **Detecção de "WhatsApp pendente"** — definir a regra exata (última msg inbound, dentro de 24h, não respondida) sobre `useWhatsappConversations`.
4. **Shape exato dos 4 hooks** — confirmar campos no plano de implementação (cliente, motivo, valor/prioridade).

---

## Anexo — síntese do Codex (consult, 2026-06-04)

Veredito: a ordem não é G1→G4→G2→G3; é **G1 mínimo pilotável → instrumentação + feedback → G4 seletivo → G1 refinado com uso → G2 (só eventos que mudam a decisão) → G3 (bem depois)**. Pontos incorporados: forçar piloto com 1 vendedora antes do estado-da-arte; loop de feedback é parte do núcleo; pedido em modo focado (não espremido); ranking por categoria com guardrails; tabela `suggested_actions` materializada + adapters (adotada como destino pós-piloto, não no v1); workspace responsivo único (não 2 UIs); WhatsApp por composição; cortar realtime/preditivo do v1; "pronto" = uso diário comprovado, não completude visual.
