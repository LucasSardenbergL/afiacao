# Frente B — "Caça": look-alike dos melhores clientes pro Hunter — Design

- **Data:** 2026-06-04
- **Status:** Em revisão (saída do brainstorming, antes do plano). ⚠️ Mecânica a re-validar com o Codex (estourou o limite de uso no challenge; reset ~19:55 BRT — ver Anexo).
- **Programa:** G1 "Waze comercial interno", **Frente B** (extrair valor de quem AINDA NÃO compra). A Frente A (fila única de ação da farmer) está em produção e vai a piloto na segunda.
- **Idioma/contexto:** pt-BR. Ver `CLAUDE.md`.

---

## 1. Contexto & motivação

A Frente A respondeu "extrair mais de quem já compra" (fila da farmer: tarefas + rota + mix-gap). A Frente B responde a outra metade da pergunta do founder: **"qual a melhor forma de capturar mais clientes ainda?"** — via **look-alike dos melhores clientes** (a inspiração no "cockpit de Valor").

O founder refinou a intenção na conversa: a visão ampla é prospecção **externa**, mas o **ganho rápido** está **dentro da base interna** que hoje não compra ("já temos os dados"). Isso é a Frente B v1.

Lar natural no produto: o **`HunterDashboard` é um placeholder vazio** (literalmente "até PR-MULTIVENDOR-V2"). A Frente B é a **fila de caça proativa (outbound)** que o preenche — o análogo da fila da farmer, pro **hunter**: *"vá atrás destes N clientes, parecidos com os seus melhores, que ainda não compram da gente"*.

## 2. Decisões travadas (negócio, com o founder)

1. **Universo = base INTERNA que hoje não compra** (prospecção externa + "radar do ME" = evolução pós-piloto).
2. **Base unificada cross-CNPJ** — as 3 empresas (Oben/Colacor/Colacor SC) são UMA comercialmente (separadas só por tributo). Oposto dos engines **financeiros**, que nunca cruzam CNPJ por regra contábil; aqui é **relacionamento comercial**, não caixa.
3. **Dono = hunter** (`commercial_role` real). **No piloto, o hunter é o próprio founder** (entra como `master`).
4. **Alvo = TODA a base que não compra**, o motor **classifica por sabor** (dormente / cross-empresa / frio) e **prioriza**, com **degradação honesta por sabor** (frio = só cadastro, confiança baixa; histórico = score rico).
5. **"Melhor cliente" = índice ponderado decomponível** (lucro + volume + fidelidade), pesos ajustáveis, componentes visíveis.
6. **Recorte de "não compra" = sem pedido há 6 meses** (consolidado nas 3 empresas), + o sabor cross-empresa à parte.
7. Filosofia: núcleo sólido → piloto (founder como hunter) → refina com uso real. **Degradação honesta** é lei do projeto (ausente≠zero; confiança baixa quando falta dado; NUNCA fabricar número/recomendação).

## 3. Escopo do v1 (a "casca")

**Entra:**
- Motor de **look-alike interpretável** (perfil-dos-melhores por **lift** + score por aderência), helper puro TDD.
- **Índice "melhor cliente"** decomponível (lucro/volume/fidelidade, percentil, pesos ajustáveis).
- **Universo de candidatos** = base sem compra há 6m (dedup por documento) + cross-empresa, classificada em **dormente / cross / frio**.
- **Score × confiança** com degradação honesta por sabor; **top-K** pro hunter.
- **Entregável**: componente **"Caça"** + rota `/caca` (acessível ao master no piloto) que também preenche o `HunterDashboard`; cada candidato com o **porquê** explícito.
- **Loop de feedback** reusando o padrão da fila G1 (aceite/descarte/outcome) + telemetria.

**Não entra (evolução, espera o sinal do piloto):**
- Prospecção **externa** (empresas fora do Omie) + integração com o "radar do ME".
- Similaridade **vetorial/kNN**; **co-compra/association rules** como motor (entra só como componente futuro da dimensão "mix").
- **Automação/pin**, cadência automática de follow-up, encaminhar-pro-closer (isso é o PR-MULTIVENDOR-V2 inbound, ortogonal).
- Calibração fina dos pesos / limiar K por ML.

## 4. Arquitetura & componentes

Pipeline em 5 etapas, todas em **lógica pura testável** (helper TDD) sobre dados pré-agregados (view/snapshot):

```
[Melhores]  → top-N clientes por índice ponderado (cross-CNPJ)
    ↓
[Perfil]    → distribuição por LIFT (vs base): região · ramo(mix) · faixa de ticket · famílias
    ↓
[Candidatos]→ base sem compra 6m (dedup documento) + cross-empresa; sabor: dormente/cross/frio
    ↓
[Score]     → aderência ao perfil (lift, só dimensões com dado) × confiança (nº dimensões)
    ↓
[Fila]      → top-K ordenado, com o "porquê" por candidato (componente Caça / HunterDashboard / /caca)
```

### Onde calcular
Não é money-path (inteligência comercial, staff-readable) → padrão do projeto: **helper puro TDD** (lift/score) + **view/snapshot** que pré-agrega candidatos + features (espelho do que `customer_metrics_mv` já faz). Ranking final client-side ou numa RPC de leitura. **Sem edge function nova** no v1 se a agregação couber em view/snapshot. O perfil-dos-melhores e o lift são baratos (agregam top-N + base); o gargalo é enumerar candidatos + features → snapshot recalculável (como `customer_metrics_mv`).

## 5. "Melhor cliente" — índice ponderado decomponível

- **Índice** = `lucro·0,4 + volume·0,3 + fidelidade·0,3` (pesos iniciais, **ajustáveis**), cada componente **normalizado por percentil** dentro da base de clientes ativos (somar peras com peras).
- **Componentes (fontes candidatas — confirmar populadas/cross-CNPJ no plano):**
  - **Lucro:** `gross_margin_pct` × volume (ou **EVP** do `fin-valor-cockpit` onde existir — **Oben-only**, entra como refino, não como base única).
  - **Volume:** faturamento consolidado por cliente (`customer_metrics_mv` / `avg_monthly_spend_180d`).
  - **Fidelidade:** `health_score` (RFM-ish já calculado) ou recência+frequência (`dias_desde_ultima_compra`, `intervalo_medio_dias`).
- **Decomponível:** a UI mostra o índice **e** os 3 componentes por cliente. Founder vê *por que* aquele é "melhor" e calibra os pesos.
- **Degradação honesta:** componente ausente → índice recalcula com o que há + marca confiança; nunca assume 0.

## 6. Perfil dos melhores — por LIFT (mata a circularidade)

O furo central: perfil por **frequência bruta** degenera o look-alike em "ache quem mora onde os melhores moram" (espelha a concentração natural da base, não o que TORNA bom). Correção: **lift** = `P(traço | melhores) / P(traço | base geral)`.

- Dimensões: **região** (cidade/UF) · **ramo derivado do mix** de famílias compradas · **faixa de ticket/porte** · **famílias dominantes**.
- Só traços com lift **> 1** (desproporcionais entre os melhores) entram com peso; geografia não domina só porque a base toda é local.
- Guard de amostra: traço com poucos melhores → lift instável → piso de suporte mínimo antes de pesar (definir no plano).

## 7. Candidatos, sabores & recorte

- **Universo** = clientes na base (omie_clientes, todos os accounts), **dedup por documento** (mesmo CNPJ em 2 accounts = 1 candidato), **sem pedido consolidado há 6 meses**.
- **Sabores:**
  - **Dormente** — já comprou, mas não nos últimos 6m (em nenhuma empresa). Tem histórico → score rico.
  - **Cross-empresa** — compra (mesmo recente) de uma empresa do grupo e **zero** na outra. Alto valor: já confia no grupo. Entra **mesmo sendo comprador recente** numa empresa (exceção ao corte de 6m).
  - **Frio** — nunca comprou em nenhuma. Só cadastro → score pobre, confiança baixa, fim da fila.
- **Boost por ciclo:** `atraso_relativo` (`customer_metrics_mv`) — quem está atrasado vs o **próprio** intervalo de recompra sobe na fila (mitiga "falso dormente" do corte fixo de 6m). É boost, **não** filtro.

## 8. Score & degradação honesta

- `score = Σ (aderência_dimensão × peso_lift)` apenas sobre dimensões **com dado** no candidato.
- `confiança = nº de dimensões com dado / nº total` (ou faixa baixa/média/alta).
- **Ordenação da fila** = score × confiança (frio com score alto mas confiança baixa **não** lidera).
- Por sabor: dormente/cross → mix + RFM histórico (confiança alta). Frio → só geo + ramo (CNAE se houver) → confiança baixa, **badge honesto**, fim da fila.
- **Porquê explícito** por candidato (interpretável): *"mesma região + compra a família X que seus melhores compram; já compra da Colacor, zero na Oben há 8 meses."*

## 9. Entregável / UX

- Componente **`FilaDeCaca`** (reusa o padrão visual/feedback da `FilaDoDia` da Frente A — item priorizado, porquê, ação, outcome).
- **Acesso:** rota dedicada **`/caca`** (staff: hunter + master) + ponto de entrada no `MasterDashboard` (o founder é o hunter no piloto) + render no `HunterDashboard` (substitui o placeholder) pro hunter dedicado futuro. **Não toca o `FarmerDashboardV2`** (piloto da farmer intacto).
- Ação por candidato: ligar (`tel:`) / abrir ficha (Customer 360) / **iniciar pedido** (`/sales/new?customer=&returnTo=/caca`, reusando o que a Fase 3 construiu) + outcome (caçei/converteu/sem fit/não-agora).
- **Loop de feedback**: reusa o padrão da fila (esconder-na-sessão + outcome + telemetria).

## 10. Telemetria (estende `caca.*` espelhando `fila.*`)

- `caca.exibida` { qtd, sabores } · `caca.item_aberto` { sabor, confianca } · `caca.acao` { cta, sabor } · `caca.outcome` { resultado, sabor } · `caca.descartado` { sabor }.

## 11. Métrica de sucesso do piloto

- **Primária:** conversão do candidato apontado → **1ª compra** (ou 1ª compra na empresa-alvo do cross) no horizonte (ex.: 30 dias), **por sabor** — calibra os pesos e prova o look-alike.
- **Secundária:** **aceite do hunter** (concorda que o alvo faz sentido? agiu?). Reusa o loop de feedback.
- **Critério de morte:** se a conversão dos top-K não bate a de uma lista-controle (ex.: dormentes por recência pura, sem look-alike), o motor não está agregando — volta pra prancheta.

## 12. Riscos & mitigações (passe adversário — ver Anexo)

| Risco | Severidade | Mitigação |
|---|---|---|
| **Circularidade** ("parecido" vira espelho do CEP/porte da base) | P1 | **Lift** vs base (só traço desproporcional pesa); porquê decomposto e visível |
| **"Melhores" mal definido** (EVP Oben-only vira viés p/ Oben) | P1 | Índice cross-CNPJ (lucro/volume/fidelidade); EVP só refina na Oben; degradação honesta |
| **Dupla-contagem por CNPJ** | P1 | Dedup por **documento**; candidato = 1 por documento |
| **Falso dormente** (corte fixo 6m pega ciclo normal) | P2 | Boost por `atraso_relativo` (vs ciclo próprio) |
| **Frio que "parece bom" mas converte mal** | P2 | Confiança baixa + fim da fila + medir conversão por sabor no piloto |
| **Lista gigante** | P2 | top-K (hunter vê 20-50, não 10k) |
| **Cobertura de scores** (frio/não-vinculado não tem linha em `farmer_client_scores`) | P2 | Confirmar no plano; degradar honestamente p/ só-cadastro |
| **LGPD/abordagem** | P3 | São clientes/cadastros DA empresa (já no Omie), abordagem B2B legítima; não é scraping externo |

## 13. Decisões em aberto (pro plano — verificar nos dados)

1. **`customer_metrics_mv` é cross-CNPJ?** (soma todos os accounts por `customer_user_id`?) — base do índice de volume.
2. **Cobertura de `farmer_client_scores`**: cobre só a carteira mapeada (~6908)? Candidatos frios/não-vinculados têm linha? (Provável que não → degradação honesta por só-cadastro.)
3. **`gross_margin_pct` / lucro por cliente é cross-CNPJ ou Oben?** Definir a fonte de "lucro" mais defensável.
4. **Enumerar candidatos**: join `omie_clientes` (todos accounts, dedup documento) × última compra (`sales_orders` por documento) × features. Estrutura da view/snapshot.
5. **Ramo-do-mix**: agregação de famílias compradas por cliente (parsing `sales_orders.items` + `omie_products.familia`). Onde materializar.
6. **Base de comparação do lift**: todos os clientes? só ativos? Definir.
7. **Faixa de ticket/porte do frio**: ausente (nunca comprou) → dimensão não contribui (ok pela degradação).
8. **K (teto da fila)** e **horizonte de conversão** do piloto.
9. **Cross-empresa**: exceção ao corte de 6m bem definida (comprador recente numa empresa, zero na outra) sem reintroduzir dupla-contagem.

## 14. Não-objetivos (v1)

Prospecção externa / radar do ME; vetorial/kNN; co-compra como motor; automação/pin/cadência; encaminhar-pro-closer (inbound do PR-MULTIVENDOR-V2); calibração por ML. Tudo guiado pelo sinal do piloto.

---

## Anexo — passe adversário (2026-06-04)

⚠️ O **Codex estourou o limite de uso** durante o challenge (reset ~19:55 BRT) — **re-validar a mecânica antes do plano**. Passe adversário feito por mim (no lugar do Codex):

- **Maior furo (corrigido no design): circularidade.** Perfil por frequência bruta espelha a concentração da base → look-alike vira "mesmo CEP". **Lift** resolve.
- **EVP é Oben-only** (confirmado, CLAUDE.md §A3) → "melhores do grupo" exige métrica cross-CNPJ; EVP refina, não ancora.
- **Mecânica:** Abordagem 1 (regras interpretáveis + lift + ramo-do-mix) **vence** a vetorial (features esparsas/fracas envenenam a distância) e a co-compra pura (não cobre frio). Interpretável + barata + alinhada à degradação honesta.
- **Degradação honesta por sabor** é o que mantém o frio honesto sem fabricar similaridade.
- **A re-validar com o Codex:** definição do índice de "melhores" cross-CNPJ; recorte de candidato sem inflar/dupla-contar; tratamento do frio; viés residual; dimensionamento do v1; métrica de sucesso.
