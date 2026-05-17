# `CustomerDashboard` Redesign — Brainstorm (não-spec)

> **Status**: brainstorm pré-spec. Documenta hipóteses + perguntas em aberto.
> A spec real exige sessão própria com a skill `brainstorming` e research
> com clientes reais (1-3 entrevistas no mínimo).
>
> Data: 2026-05-17

---

## 1. Estado atual ([src/components/CustomerDashboard.tsx](../../../src/components/CustomerDashboard.tsx))

- **Aesthetic**: mobile-first consumer (hero escuro com blobs, gradient, `font-display`)
- **Persona**: cliente final do serviço de afiação (indústria, doméstico)
- **Estrutura**:
  - Hero header com saudação + 3 stats (Pedidos / Ferramentas / Score gamificação)
  - PriorityCard (Ação Recomendada — pattern bom, reusado no Staff)
  - Gamification mini (nível + progress bar)
  - Pedidos em andamento (lista)
  - Ferramentas com atenção (vencidas/próximas afiação)
  - Quick actions (Novo Pedido, Ferramentas, Gamificação, Suporte)
  - Empty state pra novos usuários

## 2. O que funciona

- PriorityCard com 5 variants — heurística sólida (quote pending > tools overdue > no tools > no address > all_good)
- Gamification mini integrado — sticky pra retenção
- Quick actions 2×2 grid mobile — touch-friendly
- Industrial benefit card (frete grátis) — segmentação visível

## 3. Onde dói (suspeitas, sem validação)

| Dor hipotética | Evidência | Como validar |
|---|---|---|
| **Empty state genérico** | Sparkles + "Bem-vindo à Colacor" — pouco actionable | Sessão com cliente novo, gravar tela |
| **Gamification descontextualizada** | "Nível 3 Mestre Afiador" sem clareza do que dá nível | Perguntar "o que esse score significa pra você" |
| **Não há histórico de gastos** | Cliente industrial tem ROI a justificar | "Quanto economizei este mês?" merece KPI próprio |
| **Ferramentas é binário (urgente/não)** | Sem trend visual: meu uso aumentou? | Comparar "10 afiações em outubro vs 6 em setembro" |
| **Mobile dependente do PWA** | Workbox cache só em catálogo, pedido offline-first quebra | Tipo "vendedor que opera no carro" - validado fora deste escopo |

## 4. Inspirações pra explorar

- **Stripe Customer Portal**: super clean, KPI big number + 1 ação por seção
- **Notion home**: empty state que ensina + invite to action
- **Linear**: "My Issues" — inbox-first, zero decoração
- **Mercury for business**: KPIs comparativos com período anterior
- **Duolingo**: gamification que mostra impacto real (não só pontos)

## 5. Perguntas que precisam de validação (brainstorming session)

1. **Persona prioritária**: industrial (que justifica ROI) ou doméstico (que precisa de orientação)? 1 dashboard ou 2 views?
2. **Frequência de uso**: cliente abre 1x/mês (pra pedir afiação) ou 1x/semana (acompanhar status)?
3. **Métrica de sucesso**: qual ação queremos que ele faça? (criar pedido, agendar recorrência, indicar amigo, comprar mais ferramentas)
4. **Mobile vs desktop**: cliente industrial fala "abro pelo laptop do escritório" ou "no celular do chão de fábrica"?
5. **Gamification vale a pena?**: % real de clientes que olham score / sobem nível. PostHog deve ter dado.

## 6. Hipóteses iniciais de redesign

### Hipótese A: "Inbox-first" (aplicar do Staff)
- Remover decoração, foco em 1 ação prioritária + lista limpa de pedidos
- Pros: consistência com Staff Dashboard, menos manutenção
- Cons: perde calor do consumer; cliente final espera mais "personalidade"

### Hipótese B: "Industrial dashboard"
- Foco em ROI: economia mensal, frequência de afiação, vida útil de ferramentas
- Charts pequenos (recharts já no projeto)
- Pros: alto valor pra cliente industrial; justifica relação B2B
- Cons: muda completamente persona; doméstico vê dashboard frio demais

### Hipótese C: "Iterar atual sem refazer"
- Manter estrutura, melhorar:
  - Empty state mais educativo
  - Gamification com explicação inline ("Você ganha 10pts por afiação concluída")
  - Adicionar 1 KPI ROI pra industriais ("R$ X economizados em troca de ferramentas")
- Pros: baixo risco, melhoria incremental
- Cons: não responde "deveria ser dashboard B2B ou B2C?"

## 7. Recomendação de próximo passo

**Não fazer agora**. Spec completa exige:
1. **PostHog audit do CustomerDashboard atual** — métricas de adoção, retention, qual quick action mais clicada (1-2h)
2. **3 entrevistas com clientes reais** — 1 industrial, 1 doméstico, 1 misto (1 semana de calendário)
3. **Decisão de produto**: B2B vs B2C vs híbrido
4. **Spec própria com brainstorming skill** — vira projeto separado de 2 semanas

Quando essa fila estiver pronta, abrir nova sessão com `brainstorming` skill e este doc como ponto de partida.

## 8. Out-of-scope desta nota

- Decisões finais (não tem dado)
- Mockups (sem direção decidida)
- Tech choices (depende do escopo)
- Cronograma firme (depende de qual hipótese)
