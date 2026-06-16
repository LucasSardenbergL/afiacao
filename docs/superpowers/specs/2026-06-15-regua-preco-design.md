# Régua de Preço — design v1 (carrinho Oben)

> **Data:** 2026-06-15 · **Status:** spec aprovado em brainstorm, aguardando review do founder antes do plano de implementação.
> **Origem:** pergunta do founder — "na análise em tempo real (tirar pedido / 360), dá pra dizer, por elasticidade, que vamos subir o preço X% e qual a probabilidade do cliente aceitar? Como criar esse motor pra subir margem e EBITDA?"
> **Segunda opinião:** consult adversário do Codex (gpt-5.5, reasoning xhigh) — resumo no Anexo A. Foi o que endureceu o reframe central.

## 1. Problema e reframe (o coração da decisão)

O pedido original era um motor de **"probabilidade do cliente aceitar +X%"**. Isso **não é honesto** com os dados de hoje, e fabricar esse número viola a regra-mãe da casa (nunca inventar número no money-path):

- Temos **preço pago** (`sales_price_history`, `order_items`), mas **nunca rodamos experimento de preço** — nunca subimos de propósito e medimos aceite/recusa. Falta o contrafactual.
- Cotações recusadas e pedidos perdidos **não são registrados**. Só observamos transações **aceitas** (viés de seleção).
- Logo: willingness-to-pay, elasticidade, probabilidade de aceite e "preço ótimo" são **não-identificáveis** com o dado atual.

**Reframe acordado:** o motor entrega **faixa-com-evidência** — um *benchmark determinístico de preço realizado*. Ele diz *"este preço está X% abaixo de vendas recentes comparáveis / abaixo do custo+imposto"*, **nunca** *"o cliente aceita"* nem *"dá pra subir"*. É munição factual; a vendedora decide. Nome técnico honesto: `price_benchmark_gap`, **não** `acceptance_headroom`.

> Isto é o **A3 Cockpit de Valor levado ao ponto de decisão**: o A3 (`fin-valor-cockpit`) já recomenda "Subir preço" quando a margem fura a mínima, mas no **agregado**. A Régua faz o mesmo por **linha de carrinho, ao vivo**.

## 2. Decisões travadas (founder)

| Decisão | Escolha |
|---|---|
| Entrega | Faixa-com-evidência (benchmark observado), **nunca** probabilidade de aceite |
| Superfície | **Carrinho da Oben** (`unified-order`); o **Customer 360** herda o mesmo card como vista de prep |
| Empresa (v1) | **Oben** (distribuidora — revenda, onde o headroom de preço faz mais sentido e o dado tem densidade) |
| Nome | **Régua de Preço** |
| Tom do card | **Acionável** — lidera com a folga em R$ + botão "Aplicar referência"; disclaimers no "ⓘ por quê" |
| Prazo de pagamento | **Varia por vendedora/cliente** → confounder **não-controlável** → aviso *"não controlado por prazo/frete"* **permanente** + cap conservador + sinal do próprio cliente **elevado** na hierarquia |
| Piso 🔴 | **MC negativa** = `preço_líquido < CMC + impostos sobre a venda` (alíquota efetiva da Oben via DRE, rotulada **estimativa**) |

## 3. Os três sinais (hierarquia por confiabilidade)

O card mostra **o sinal mais confiável disponível** e degrada pra baixo. Nunca soma score mágico; sinais que discordam → degrada.

1. **🔴 Abaixo do piso de margem (MC negativa)** — o mais seguro, independe de amostra (só precisa de CMC + alíquota). Vender com prejuízo variável. *Provável dinheiro vazando hoje.*
2. **💰 Abaixo do que o próprio cliente já pagou** — o mais confiável dos comparativos: controla cliente + relacionamento + prazo típico dele. *"Você cobrou R$ 112 deste mesmo cliente neste item em 03/2026; hoje está em R$ 106."*
3. **💰 Abaixo de comparáveis da carteira** — contexto, quando não há histórico do cliente. Quantil de vendas recentes do mesmo SKU, mesma faixa de quantidade, excluindo o próprio cliente.

## 4. Metodologia de cálculo (determinística)

Todas as fórmulas vivem num **helper puro TS testável** (oráculo) espelhado por uma **RPC SQL**. Zero LLM no número.

### 4.1 Piso de MC (sinal 🔴)
Impostos sobre venda incidem sobre o **preço** (não sobre o custo):
```
MC = preço_líquido·(1 − alíquota_efetiva) − CMC
MC < 0  ⟺  preço_líquido < CMC / (1 − alíquota_efetiva)
piso_MC = CMC / (1 − alíquota_efetiva)        ← preço mínimo pra MC zero
```
- `CMC` ← `inventory_position.cmc` (account-aware, convenção `vendas` da Oben). Sem CMC confiável → cair pro proxy `product_costs.cost_price` **rotulado "custo estimado"**, ou ocultar o 🔴.
- `alíquota_efetiva` ← deduções de receita (ICMS+PIS+COFINS) / receita bruta da Oben, do módulo DRE. Rotulada **estimativa** (não é por-NCM).

### 4.2 Auto-referência do cliente (sinal 💰 alto)
```
ref_cliente = quantil recente (p50–p75) dos preços que ESTE cliente pagou neste SKU
              em ~180d, com decaimento de recência (preços antigos saem/perdem peso)
gap_cliente = max(0, ref_cliente / preço_atual − 1)         se ≥1 obs do cliente no SKU
```

### 4.3 Benchmark de comparáveis (sinal 💰 contexto)
```
C = order_items ⋈ sales_orders dos últimos 90d
    , mesmo product_id
    , mesma account (Oben)
    , mesma BANDA DE QUANTIDADE (bins por quartil de log(quantity) do SKU)
    , EXCLUINDO o customer_user_id atual         (leave-one-customer-out)
p_target = percentil_65(preço_líquido em C)       (p65, não p75 — p75 é agressivo)
n        = |C|
n_eff    = 1 / Σ(share_cliente²)                  (clientes efetivos; mata SKU concentrado)
gap_bench = max(0, p_target / preço_atual − 1)    sujeito aos gates de §5
```
- `preço_líquido = unit_price − discount` (a **auditar** — ver §10; se `discount` não for confiável, usar `unit_price` cru + disclaimer).

### 4.4 Alvo sugerido e cap conservador
```
teto   = min( p_target_benchmark , ref_cliente(se houver) )
alvo   = min( teto , preço_atual · (1 + cap_confiança) )
gap_sugerido = max(0, alvo / preço_atual − 1)
```
`cap_confiança`: alta → cap maior; média → cap pequeno; baixa → **não sugere %** (só recibo). Valores calibráveis (config), começam conservadores porque o preço varia por negociação.

## 5. Confiança = qualidade da evidência (NUNCA "chance de aceite")

| Nível | Regra (benchmark) | UI |
|---|---|---|
| **Alta** | `n≥30` · `n_eff≥8` · qty comparável · CMC confiável · sinais consistentes | folga + botão aplicar |
| **Média** | `n≥15` · `n_eff≥5` | folga + cap pequeno |
| **Baixa** | abaixo disso, ou preço antigo/contexto incompleto | **recibos sem %** |
| **Oculto** | amostra mínima falha ou preço não comparável | nada |

O 🔴 (piso) tem trilha própria: confiança = qualidade do CMC (real vs proxy). A palavra **probabilidade/chance/aceita/seguro** **não existe** na UI.

## 6. Copy e UI (tom acionável, honestidade a um clique)

> **Princípio-guia (Codex, PR3):** a maior ameaça é a UI transformar evidência histórica fraca em **autoridade prescritiva** ("o sistema mandou subir"), e aí perder pedido sem provar causalidade. Trava central: **evidência visível ANTES da ação**, botão ausente em baixa confiança/proxy/discordância, e **um único vermelho** inequívoco para MC<0. Nunca usar "bom/ideal/recomendado".

### 6.1 Coexistência com o cockpit de markup (achado PR3)

O carrinho **já** tem o `usePrecoCockpit` (badge 🔴🟡🟢 = markup **bruto** sobre CMC, **sem imposto**; `CartItemList.tsx:86-101`). A Régua **não** cria um segundo vermelho:

- **A Régua é a autoridade do vermelho de margem.** Quando `abaixoPiso=true`, ela mostra o único alerta vermelho (`MC<0 · piso R$ X`) e o badge do cockpit naquela linha **recua a neutro** (markup% sem cor de alerta). Como `preço<CMC ⟹ preço<piso_MC`, **todo** vermelho do cockpit já é coberto pelo da Régua — sem perda de proteção, e a Régua ainda pega a **zona cega** do cockpit (`CMC ≤ preço < piso_MC`: markup bruto positivo mas MC negativa após imposto).
- **Fallback (fail-safe):** se a Régua não tem dado (sem cliente / RPC falhou / flag off), o cockpit mantém o comportamento atual (vermelho "Abaixo do custo") — a proteção nunca some.
- Sinais 💰 (auto-ref/benchmark) são da Régua, cor própria **não-vermelha**; o cockpit segue mostrando amarelo/verde (markup vs meta) como dado secundário.

### 6.2 Anatomia (linha densa → evidência a um clique)

Na linha (compacto, ao lado do preço — a linha é `text-[9px]`, sem espaço pra card inline):

- 🔴 `MC<0 · piso R$ 113,95` — vermelho, **sempre** que `abaixoPiso` (proxy → sem número de ação)
- 💰 `R$ 112 (+6%)` — folga, só evidência ≥ média
- ⓘ discreto — confiança baixa: recibo, **sem** número nem botão
- (nada) — `nenhum`/`oculto`/`discordancia`

Clique no sinal → **popover** com recibos + disclaimers + ação (evidência antes da ação):

```
┌─ Verniz PU 3,5L · MARCENARIA SILVA · 2un ──────┐
│ Você: R$ 106/un   ·   Referência: R$ 112/un     │
│ 💰 folga +R$ 6/un (R$ 12 no item)               │
│ Comparáveis recentes (mesmo porte), p65         │
│ Base: 23 vendas · 9 clientes · 180d · exclui    │
│       este cliente                              │
│ ⓘ Não estimamos aceite · Não controla prazo/frete│
│ [ Aplicar referência · R$ 112,00 ]              │
└─────────────────────────────────────────────────┘
```

Modo piso (🔴): "Abaixo do piso MC (custo+imposto). CMC R$ 98 + imposto ≈ R$ 113,95; seu preço R$ 106 = MC negativa." Botão `Aplicar piso · R$ 113,95` só se CMC confiável; proxy → "Confira o custo real" **sem** botão. O ⓘ explica: *"Piso MC = CMC + imposto. O markup do cockpit é bruto."*

### 6.3 Travas anti-money-path

1. **Evidência antes da ação** — o número fica visível na linha, mas `Aplicar` só **dentro** do popover (2 cliques); nunca aplica cego em 1 clique.
2. **Não-destrutivo** — `Aplicar referência` só preenche o campo editável (`onUpdateProductPrice`); o vendedor confirma. Nunca altera o preço sozinho.
3. **Botão ausente** em confiança baixa/proxy/discordância — recibo sem número (o helper já degrada).
4. **Copy neutra** — "referência", nunca "ideal/recomendado/bom"; o número é o **alvo capado**, não o teto observado.
5. **Flag + sombra** — `regua_preco_carrinho` liga primeiro só pra founder/gestor conferir com clientes reais antes do balcão.

## 7. Arquitetura (unidades isoladas)

| Unidade | Responsabilidade | Depende de |
|---|---|---|
| `src/lib/regua-preco/regua-preco-helpers.ts` (puro, **TDD**) | cap/gate/confiança/hierarquia/fórmulas — **oráculo** | nada (entradas numéricas) |
| RPC SQL `get_regua_preco(p_customer, p_product, p_qty)` **[no banco ✅]** | FETCHER: cmc, aliquota, piso_MC, precos_cliente[], comparaveis[] (leave-one-out, banda qty, 180d, anonimizado). Account fixo `'oben'` interno. | `order_items`, `sales_orders`, `inventory_position`, `company_config` |
| Tabela `regua_preco_log` **[no banco ✅]** | closed-loop. v1 grava via PostgREST direto (RLS staff; `salesperson_id`=`useAuth().user.id`). RPC `SECURITY DEFINER` que fixa `auth.uid()` server-side = **hardening pós-sombra** (não bloqueia v1). | auth.uid (vendedor) |
| `src/hooks/useReguaPreco.ts` | consome a RPC, react-query | RPC |
| `src/components/regua-preco/ReguaPrecoCard.tsx` | card (carrinho + 360) | hook |
| Feature flag `regua_preco_carrinho` | rollout sombra→balcão | config |

**Fontes:** `order_items` (quantity/discount/unit_price) + `sales_orders` (data/account) como verdade da venda; **não** `sales_price_history` (não tem quantidade). Custo via `inventory_position.cmc`.

**Dados no carrinho (v1, decisão eu+Codex):** `useReguaPreco` faz **1 `useQuery`** cuja `queryFn` dispara a RPC single `get_regua_preco` **N× em paralelo via `Promise.allSettled`** (não `useQueries` — sem precedente no projeto; este padrão é `useQuery` idiomático e dá o `Map` ao componente-pai, que precisa dele pra suprimir o vermelho do cockpit). Carrinho Oben é pequeno (1–8 itens) e a single já está no banco/serve o PR4 (360). Gates: só dispara com `customerUserId` + `productId` + `qty>0` + `unit_price>0`; **dedupe** do fetch por `(product, qty)` (carrinho repete SKU); `queryKey` inclui o `user.id` **real** (anti-leak, igual ao cockpit); a `queryFn` **não** depende do preço (fetcher) — a decisão (`avaliarReguaPreco`) roda client-side via `useMemo` a cada keystroke do preço, barata. `allSettled` isola item lento/falho. Se a latência p95 estourar, um PR futuro troca por `get_regua_preco_carrinho(p_customer, p_itens)` batch — sem métrica, o N+1 vira dívida invisível.

## 8. Closed-loop log (desde o v1)

Não muda nada na decisão do v1, mas é o trilho que um dia destrava win-rate real. Tabela `regua_preco_log` (essencial):

```
id, created_at, account, customer_user_id, product_id, salesperson_id,
cart_ref / sales_order_id, quantity,
preco_atual, ref_cliente, p_target_benchmark, piso_mc,
sinal_exibido (piso|cliente|benchmark|nenhum), gap_sugerido_pct, confianca,
preco_final, aplicou_bool, outcome_status, outcome_at,
cmc_usado, cmc_confianca, aliquota_usada, evidence_version, reason_codes
```
Granularidade = **linha de carrinho/cotação**, não pedido agregado. RLS: staff/Oben.

**Quando gravar (decisão eu+Codex, PR3):** registrar **exibição qualificada**, não render bruto — senão o log mede clique, não conversão.
- **Exibição:** 1 linha por `cartSessionId + product_id + sinal_exibido + preco_referencia` quando o sinal fica visível ~**800ms** (debounce, dedupe no cliente), `outcome_status='pendente'`. `cartSessionId` = uuid gerado no cliente ao montar o carrinho (`useRef`).
- **Aplicar:** `UPDATE` da linha → `aplicou=true`, `outcome_status='aplicado'`, `preco_final`, `outcome_at` no clique de "Aplicar referência".
- `reason_codes` **sempre** gravados (auditar quando o motor empurrou aumento — rastrear a "autoridade prescritiva" do Codex).
- Denominador de adoção (viu × aplicou) sai daí; sem a exibição não dá pra saber se baixa adoção é "ninguém viu" ou "ninguém aplicou". `track('regua.exibida'/'regua.aplicada')` no PostHog é complemento analítico opcional (não-bloqueante).

**Viés conhecido do log** (registrar, não esconder): a vendedora só aplica onde acha fácil; clientes difíceis ficam sub-representados; preço escolhido é endógeno. **Mitigação é v2** (randomização pequena e segura: sortear mostrar/não-mostrar, ou +2% vs +4% dentro de caps) — sem isso, win-rate futuro continua observacional.

## 9. Escopo

**No v1 (in):** 3 sinais; piso MC (CMC+imposto); benchmark p65 leave-one-out + banda qty; auto-ref do cliente; confiança=qualidade; copy honesta + disclaimers permanentes; card no carrinho Oben; 360 herda; flag+sombra; log de exposição+outcome.

**Fora (v2+):** probabilidade de aceite; randomização pra desenviesar; pooling hierárquico por categoria; correção de frete/prazo (no v1 são só disclaimer); auto-aplicar em massa; Colacor/Colacor SC.

## 10. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| **Significado de `unit_price`/`discount`** (líquido? bruto? frete?) — se inconsistente, todo benchmark é lixo | **PR0 de auditoria read-only** antes de tudo (psql-ro): amostrar, conferir `unit_price` vs `discount` vs total do pedido; o frete já é campo separado no Omie (confirmado no `omie-vendas-sync`), o que reduz o confounder |
| Cobertura/qualidade do **CMC** na Oben | usar `inventory_position.cmc`; sem ele → proxy rotulado "custo estimado" ou ocultar 🔴 |
| **Alíquota efetiva** é média, não por-NCM | rotular **estimativa** na UI; é piso conservador, não preço-alvo |
| **Confounders não-observáveis** (prazo, contrato, urgência) | a UI **declara** "não controlado por prazo/frete"; cap conservador; sinal do cliente elevado |
| SKU **concentrado** num cliente | `n_eff` gate oculta o benchmark |
| Uso indevido ("o cliente aceita") | copy sem "aceite/chance"; não autopreenche; sem % em confiança baixa |

## 10.1 Resultados da auditoria PR0 (read-only, executada 2026-06-16)

Rodada via `psql-ro` **antes** do plano, pra blindar premissas. Confirmou e ajustou o design:

| Pergunta | Resposta | Impacto |
|---|---|---|
| `unit_price` é líquido? | **Sim.** Desconto por item E por cabeçalho são **0% na Oben** (0 de 3.143 itens / 1.508 pedidos, 90d) | Confounder de desconto **eliminado**; `preço_líquido = unit_price` direto |
| Cobertura do benchmark (`n≥15`, `≥5` clientes) | 90d: **55/337 SKUs (16%)** · 180d: **81/424 (19%)** | Janela do benchmark → **180d com decaimento de recência**; é o sinal de **menor** cobertura |
| Cobertura auto-referência | **50%** dos pares (cliente, SKU) recompram em 365d (1.743/3.479) | Sinal 2 é o **cavalo de batalha** |
| Cobertura piso de MC | **~78%** dos SKUs vendidos têm CMC (263/337) | Sinal 1 é o de **maior** cobertura — confirma a hierarquia |
| Account de CMC | `inventory_position.account` ∈ {`oben`, `vendas`} cobrem quase os mesmos SKUs | **Questão aberta PR1:** definir o account canônico de CMC da Oben |
| Alíquota efetiva | **`fin_kpi_tributario`** tem `aliquota_efetiva` + `icms/pis/cofins` por `company`/mês | Usar **(icms+pis+cofins)/receita** (impostos sobre venda, sem IRPJ/CSLL) do mês recente |

**Ordem de cobertura confirmada:** piso de MC (~78%) > auto-referência (~50%) > benchmark (~19%). O plano prioriza nessa ordem.

## 10.2 Alíquota de venda da Oben (derivada 2026-06-16, com o founder)

O DRE não traz o ICMS (`deducoes`=0), então a alíquota efetiva foi montada por **componentes + mix de operações**:
- **Mix** (`venda_items_history`, por CFOP, 12m, por receita): **59,8% interno** (MG, 5xxx) / **40,2% interestadual** (6xxx).
- **PIS/COFINS** (Lucro Presumido, cumulativo): **3,65%**.
- **ICMS efetivo** (crédito presumido de e-commerce de MG, fornecido pelo founder): interno **6%**, interestadual nacional **~1,4%** (importado 1,3% + DIFAL, tratado como repassado → fora do custo).
- **Ponderado:** `ICMS = 0,598×6% + 0,402×1,4% = 4,15%` → `+ 3,65% = 7,8%`.

Gravado em `company_config['regua_preco_aliquota_venda_oben'] = 0.078`. **Calibrável** (recalcular se o mix ou o regime mudar). Refinamento v2: alíquota **por linha** (destino interno/interestadual via CFOP + origem nacional/importado via NCM) em vez de média ponderada.

## 10.3 Revisão de implementação do PR3 (Codex, 2026-06-15)

Revisão independente do diff da UI (rigor money-path — "Caminho B"). 5 findings; disposição:

| # | Finding | Disposição |
|---|---|---|
| P1 | **Tinta**: a Régua busca só `product.id` da base; custo real inclui corantes → piso de MC subestimado | **Corrigido**: v1 exclui itens com `tint_formula_id` (gate); o cockpit formula-aware segue cobrindo tinta |
| P1/P2 | **Supressão ampla**: `cockpitSuprimido` escondia o vermelho forte do cockpit mesmo com piso por CMC proxy | **Corrigido**: só suprime quando `regua.precoReferencia != null` (piso confiável, com botão) |
| P1 | **Log do cliente errado**: dedupe/logId sem o cliente → troca de cliente sem desmontar atribui ao anterior | **Corrigido**: chave de dedupe e `logId` por `(cliente, item)` |
| **P0** | **Preço 0 → pedido**: campo esvaziado vira 0; cockpit e Régua filtram `>0` e o submit não valida → pedido com valor zerado | **Separado** (não é da Régua — bug pré-existente do `submitOrder`): flagado como tarefa dedicada. A Régua não introduz nem piora |
| P2 | **Debounce stale**: timer de exibição pode logar contexto velho se sinal/ref iguais dentro de 800ms | **Aceito como limitação** de telemetria (raro; sombra). O fix do P1 cobre o pior caso (cliente). Robustez fina = v2 |

**Confirmações do Codex:** separação fetch (sem preço) × decisão (`useMemo` no preço) correta; `Promise.allSettled` preserva ordem (mapeamento índice→item certo); `onAplicar` usa o **alvo capado**, não o teto.

## 11. Validação

- **Helper puro:** vitest (TDD) — fórmulas, gates, hierarquia, degradação. Casos: amostra mínima, SKU concentrado (n_eff), custo ausente, MC negativa exata na fronteira, discount inválido.
- **RPC SQL:** `prove-sql-money-path` (PG17 local) — aplica a migration real, semeia comparáveis, asserta o p65/leave-one-out, **falsifica** (sabota → exige vermelho), prova RLS do log sob `SET ROLE`.
- **Modo sombra:** founder/gestor confere os números contra clientes reais antes de liberar pro balcão.
- **Deploy:** ritual Lovable (migration via SQL Editor + edge se houver + Publish) — `lovable-db-operator` / `lovable-deploy-verify`.

## 12. Faseamento (esboço pro plano)

- **PR0** — auditoria read-only de `unit_price`/`discount`/`cmc`/alíquota (viabilidade do dado). *Gate: se o preço não for comparável, repensar.*
- **PR1** — helper puro (TDD) + RPC `get_regua_preco` + prove-sql.
- **PR2** — tabela `regua_preco_log` + RPC de gravação (migration + prove-sql).
- **PR3** — `useReguaPreco` + `ReguaPrecoCard` + integração no carrinho `unified-order` + flag (sombra).
- **PR4** — card no Customer 360 (reuso).

---

## Anexo A — Resumo do consult adversário do Codex

- **Veredito:** v1 só é honesto como **higiene de preço com recibos** (benchmark de preço realizado), não como motor de previsão. Se a UI disser "dá pra subir +8%", vira teatro estatístico.
- Renomear `acceptance_headroom` → `observed_price_benchmark_gap`.
- Âncora = comparáveis **controlados** (SKU+account+banda de qty+90d) com **leave-one-customer-out** e **p65** (p75 é agressivo). `n_eff = 1/Σshare²`.
- **RFM ≠ tolerância a preço.** No máximo risco comercial → cliente estratégico/concentrado pede cap **menor**, não maior.
- Confounders não-observáveis → **declarar** "não controlado por X" ou ocultar; **não** corrigir com proxy bonito.
- **Logar exposição + outcome desde o dia 1**; sem **randomização** futura, win-rate continua enviesado.
- Maior risco de produto: tratarem o número como "o cliente aceita" → mitigar com copy, sem autopreencher, sem % em evidência baixa.
