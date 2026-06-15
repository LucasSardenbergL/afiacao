# Cockpit de preço cost-anchored (Onda 1 / Fase 2) — markup sobre CMC + defasagem

> **Status:** design aprovado em forma (2 decisões do founder travadas, abaixo). Sub-projeto da Onda 1, construído SOBRE o esqueleto de cockpit já desenhado na spec-mãe (`docs/superpowers/specs/2026-06-06-jornada-comercial-onda1-ligacao-design.md` §9 / §7.4).
> **Metodologia validada com Codex (gpt-5.5, xhigh, 2026-06-14)** — output completo em `/tmp/codex-fase2-out.md` (efêmero; achados-chave folded abaixo).
> **Reframe central:** a régua é 100% ancorada em **CUSTO (CMC)**, NÃO em "preço de tabela". A spec-mãe comparava preço × tabela de venda — o founder **rejeitou** isso.

---

## 1. Objetivo

Dar ao vendedor (e ao gestor) um **cockpit de preço por linha de item** no wizard de venda que responda, de forma **honesta e informativa** (mostra, não bloqueia):

1. **O preço que vou praticar é saudável em relação ao CUSTO?** (markup sobre CMC vs piso/meta).
2. **O custo subiu e eu não repassei?** (defasagem por alta de CMC — a dor #1 do founder).

Custo = **CMC** (Custo Médio Contábil do Omie, o "Custo de Estoque" da ficha). É a média contábil do estoque — não o preço da próxima compra —, mas é a melhor âncora de custo que temos. Empresa-foco: **Oben (distribuidora, markup sobre custo)**.

---

## 2. Decomposição em sub-projetos + decisões do founder

A funcionalidade tem **duas partes com dependências de dados radicalmente diferentes** → fatiada em **2a** (entrega já) e **2b** (depois). Cada uma é um ciclo spec→plano→build próprio; **esta spec detalha a 2a** e **esboça a 2b** (§9).

| Parte | Precisa de | Entrega valor |
|---|---|---|
| **2a — Saúde estática (markup sobre CMC)** | só o **CMC atual** + config de meta-markup | **Imediato** |
| **2b — Defasagem ("o CMC subiu e o preço não acompanhou")** | **CMC histórico** — disponível no **Omie por data** (`ListarPosEstoque` + `dDataPosicao`, point-in-time) + design da âncora/quarentena | **Sem espera de acúmulo** — pode até backfill (CMC de qualquer data passada) |

**Decisão D1 (founder):** **2a agora + 2b depois** — a 2b é fatiada por **complexidade de design** (âncora de repasse, quarentena de saltos, UI), NÃO por falta de dado. **CORREÇÃO (2026-06-15, founder):** o histórico de CMC **existe na fonte** — o `ListarPosEstoque` do Omie é parametrizado por `dDataPosicao` e devolve o `nCMC` **como estava naquela data**; o sync só sempre pediu "hoje". Então a 2b puxa `CMC_referência` do Omie sob demanda (e pode backfill), **não nasce cega**. O **`cmc_ledger`** ligado na 2a deixa de ser o "gate" e vira **cache barato** de mudanças observadas (evita N chamadas ao Omie + marca QUANDO o CMC mudou). ⚠️ Antes de fechar o design da 2b: **smoke do `dDataPosicao`** (confirmar que data passada devolve `nCMC` histórico, não o atual com rótulo de data — money-path).

**Decisão D2 (founder):** **faixa de cor pra vendedora, número pro gestor.** A vendedora vê 🔴🟡🟢⚪ + rótulo ("abaixo do custo / abaixo do piso / saudável / sem dado"); markup% e folga R$ só pro **gestor/master**. Protege o CMC (custo é segredo — coerente com o hardening da receita tintométrica, CLAUDE.md §10). Implementação: a **RPC role-gateia o payload numérico** — o client da vendedora **nunca recebe o número** (não basta esconder na UI).

---

## 3. Princípios (não-negociáveis, money-path)

1. **Honestidade > cobertura.** Ausente ≠ 0. Sem CMC/config confiável → estado **neutro (⚪ "—")**, nunca verde nem vermelho fabricado.
2. **Precisão > recall.** Um falso "preço ruim"/"defasado" **erode a confiança** da vendedora (ela passa a ignorar o cockpit). Preferir **não-alertar** a alertar errado. → o estado neutro é **generoso**.
3. **Markup ≠ margem (rótulo honesto, Codex).** `(P−CMC)/CMC` é **markup bruto sobre CMC**, não "margem". Exibir `Markup: X% · Folga: R$ Y` + aviso "não inclui imposto, comissão, frete, prazo ou opex". Chamar de "margem" envenena metas/orçamento futuros.
4. **CMC nunca cru no client.** Cálculo via **RPC staff-gated**; o número (que permite inferir o custo) só pro gestor/master.
5. **O risco #1 (Codex):** "comparar preço/custo/data/unidade que *parecem* corresponder mas economicamente não correspondem" → alertas convincentes e **errados**. Mitigação transversal: comparar só o que é economicamente comparável (preço **líquido**, mesma **conta**, mesma **unidade**, **data econômica** real), estados neutros generosos, e **quarentena** pra saltos absurdos.

---

## 4. Metodologia

### 4.1 Custo = CMC account-aware (RPC role-gated)

- Fonte: `inventory_position.cmc`, join por **`account` + `omie_codigo_produto`** (NÃO por `product_id`; NÃO usar `product_costs` — é proxy ~2× com confiança baixa).
- **RPC nova `get_preco_cockpit`** (nome a confirmar), `SECURITY DEFINER`, staff-gated, **batch** (recebe N SKUs do carrinho, devolve N linhas — sem N+1).
- **Payload role-gated** (D2):
  - **Sempre** (qualquer staff): `faixa` (🔴/🟡/🟢/⚪), `motivo` (rótulo), `tem_custo` (bool), `tem_politica` (bool).
  - **Só gestor/master** (`pode_ver_carteira_completa(auth.uid())`): `cmc`, `markup_perc`, `folga_reais`, `piso_markup`, `meta_markup`, `proveniencia`, `frescor`.
- **Frescor:** `inventory_position.updated_at` (hora do último sync). CMC stale (> limiar; o app já considera >3h problemático em outro contexto — calibrar) → degrada pra neutro com aviso.
- **Fracionamento (Codex P1):** unidade de venda × unidade de estoque. **Exige cadastro explícito** (unidade do CMC no Omie, conteúdo líquido da embalagem, unidade de venda, fator). **Não inferir** de descrição ("GL/QT/900 ml"). Onde o fator não estiver cadastrado → neutro (não chutar).

### 4.2 Custo tintométrico — all-or-nothing por CMC

- Custo direto = `CMC_base (por unidade vendida) + Σ(qtd_ml × CMC_corante / conteúdo útil da unidade de estoque do corante)`.
- Resolução **server-side**: fórmula → `tint_skus.omie_product_id` → `omie_products`; corante → `tint_corantes.omie_product_id` → `omie_products`; join `inventory_position` por **account + código**; validar que tudo é da **mesma conta**.
- ⚠️ **ALL-OR-NOTHING (Codex):** base sem CMC, **qualquer** corante usado sem CMC/conversão, ou fórmula incompleta/stale → **custo total nulo (neutro)**. **Nunca** somar os componentes conhecidos e assumir zero nos demais.
- ⚠️ O helper atual (`src/lib/tint/compute-price.ts`) e a RPC `get_tint_price` (`20260527180000`) fazem o **OPOSTO**: usam `valor_unitario` (preço), ausência→0, soma parcial. → a Fase 2a cria a **variante por CMC** (NÃO altera `computeTintPrice`/`get_tint_price`, que servem o preço de venda — caminhos separados).
- **Rótulo honesto:** "custo direto de materiais pelo CMC", não "custo completo do tingimento" (não inclui perda de dosagem/purga/sobra). Furos a confirmar na impl: o CMC da base já capitaliza algum componente tintométrico? (anti-double-count); o corante desloca volume de base ou é aditivo?

### 4.3 Markup + faixas + meta-markup config

- **Markup bruto sobre CMC** = `(preço_praticado − custo) / custo`. **Folga** = `preço − custo` (R$).
- **Política de markup** (piso + meta) configurável, resolução **conta → família → SKU (exceção)**:
  - `piso_markup` = o markup mínimo aceitável (proxy de break-even na v1; v2 deriva de orçamento — §4.6).
  - `meta_markup` = o markup-alvo.
  - Master/financeiro edita (versionado/auditável); vendedora só consulta.
- **Faixas:**

| Faixa | Condição | Vendedora vê | Gestor vê (+número) |
|---|---|---|---|
| 🔴 | `preço < custo` (markup negativo) | "Abaixo do custo" | + markup% (negativo) · folga R$ |
| 🟡 | `custo ≤ preço < piso` | "Abaixo do piso" | + markup% · folga · piso |
| 🟢 | `preço ≥ piso` | "Saudável" | + markup% · folga · meta (e "abaixo da meta" se `< meta`) |
| ⚪ | sem CMC confiável **ou** sem política | "—" | "—" + motivo |

- **Sem política configurada:** `preço < custo` ainda pinta 🔴 (spread bruto negativo é fato conhecido); CMC válido mas piso ausente → mostra o número (pro gestor) mas faixa **⚪** (neutro). **Nunca 🟢 só porque `preço > custo`** (Codex).
- **Não derivar a meta de preços históricos** (institucionalizaria a precificação atual — Codex).

### 4.4 Defasagem (2b) — âncora de repasse, à prova de catraca

> Detalhado aqui porque a metodologia foi validada agora; a **construção** é a Fase 2b.

- **Baseline NÃO é a última venda** (Codex): erro de catraca — um repasse parcial apagaria o alerta cedo demais (ex.: CMC 100→120, preço 150→160 quando devia ir a 180; se 160 vira o novo baseline, o alerta some sem o repasse ter sido concluído).
- **Âncora de repasse** = o último par (preço líquido `Pₐ`, custo `Cₐ`) que **encerrou corretamente** um ciclo de repasse, por **cliente × account × SKU × unidade comercial** (tinta: + embalagem, acabamento, versão da fórmula).
- **Defasagem quando:** (1) `C > Cₐ` por alta **material**; **e** (2) `P < P_req` onde `P_req = Pₐ × C / Cₐ`. Forma auditável equivalente: **`P/C < Pₐ/Cₐ`** (o markup relativo da âncora não foi preservado).
- **Atualização da âncora:** venda abaixo de `P_req` → **não** atualiza (episódio segue aberto); venda em/acima de `P_req` → fecha o episódio, vira nova âncora; `C ≤ Cₐ` (CMC caiu) → não alerta; primeira venda → estabelece âncora, **neutro**.
- **Tolerância** (calibrar em **shadow-mode**): alta material de CMC `≥ 0,5%`; déficit mínimo `max(R$ 0,05; 0,1% de P_req)`; `P_req` em alta precisão, arredondado pra cima no centavo. **Não** usar tolerância de vários p.p. (contradiz o founder).
- **Estados neutros:** `Cₐ/C/Pₐ/P` nulos ou ≤0; CMC stale; unidade não comparável; venda cancelada/devolvida/bonificada/sem data econômica; estoque zerado/negativo sem validação.

### 4.5 Histórico de CMC — ledger por trigger (2a, write-only)

- **`cmc_ledger`** (append-only): `account, omie_codigo_produto, cmc_anterior, cmc_novo, saldo, observed_at, synced_at, origem`. Alimentado por **TRIGGER** no `inventory_position` quando o CMC **realmente muda** (não cron — o sync já atualiza, o banco observa a mudança exata). Seed inicial = CMC atual no lançamento.
- Rótulo: **"alta observada pelo sistema"**, NÃO data contábil real da compra.
- **CORREÇÃO (2026-06-15):** o ledger é **complemento**, não a única fonte. O **CMC histórico (cost side)** vem do **Omie por `dDataPosicao`** (`ListarPosEstoque` point-in-time) → **backfill possível**, sem nascer cego. O ledger evita N chamadas ao Omie e marca QUANDO o CMC mudou; o Omie é a fonte autoritativa do CMC numa data arbitrária. Rótulo do ledger continua "alta observada pelo sistema", não data contábil real.
- **Fonte da âncora — decisão de 2b:** o **cost side** (CMC na data de referência) = Omie `dDataPosicao` (autoritativo) e/ou `cmc_ledger` (cache). O **price side** é o problema delicado: ⚠️ `sales_price_history` é baseline **ruim** (preço **bruto** sem desconto; `created_at` às vezes = previsão de entrega; sem account/unidade/`sold_at` explícitos — Codex, refs em §10). 2b decide entre: (A) **snapshot econômico imutável por linha no `submitOrder`** (preço líquido real + cmc no momento — toca money-path, review focado na 2b), ou (B) **reconstruir** de `sales_orders` (líquido) × CMC-na-data (Omie/ledger). A 2a **só liga o ledger** (DB-only); a escrita no submit fica pra 2b.

### 4.6 Break-even (v2, não bloqueia a v1)

`Preço mínimo = (CMC + custos variáveis por unidade) / (1 − v − t)`, com `v` = impostos não-recuperáveis/comissão/frete subsidiado/financeiro/inadimplência/devoluções/prazo (% da receita) e `t = (Opex fixo orçado + lucro-alvo) / receita líquida orçada`. É **política de portfólio** (não alocar todo custo fixo por SKU — condena itens estratégicos). v1 usa `piso_markup`/`meta_markup` **manuais**; v2 deriva do orçamento e passa a mostrar **margem de contribuição** + ponto de equilíbrio.

---

## 5. Arquitetura (Fase 2a)

### 5.1 Componentes

| Componente | Arquivo (a confirmar na impl) | Responsabilidade |
|---|---|---|
| RPC `get_preco_cockpit` | migration nova | CMC account-aware (incl. tint all-or-nothing), markup, faixa; **payload role-gated**; batch |
| Tabela `markup_policy` | migration nova | piso/meta por conta→família→SKU; RLS master-only; versionado |
| Tabela `cmc_ledger` + trigger | migration nova | histórico append-only de mudança de CMC (write-only na 2a) |
| Helper puro `cockpit-preco` | `src/lib/preco/` | classificação faixa/markup (oráculo TDD que a RPC espelha) |
| Hook `usePrecoCockpit` | `src/hooks/` | consome a RPC (batch, por carrinho), staff-gated, degradação honesta |
| UI por linha | wizard de venda (`ProductItemForm`/cockpit do item) | faixa (vendedora) / faixa+número (gestor); rótulo honesto |

### 5.2 Fluxo de dados

1. Vendedor adiciona/edita item no wizard → `usePrecoCockpit` chama `get_preco_cockpit({ itens: [{account, codigo, preco_praticado, qtd, unidade, [tint: formula]}] })`.
2. RPC: resolve CMC (account+código; tint → composição all-or-nothing) → aplica `markup_policy` (conta→família→SKU) → classifica faixa → **role-gateia** o payload.
3. UI pinta a faixa por linha; gestor vê o número; degradação honesta onde faltar dado.
4. Em paralelo (DB, sem app): cada sync de produto que muda o CMC dispara o trigger → grava em `cmc_ledger` (acumula pra 2b).

### 5.3 Segurança / degradação

- RPC `SECURITY DEFINER` + REVOKE de anon; gate staff; **número** só `pode_ver_carteira_completa`. CMC nunca no payload da vendedora.
- Toda ausência → neutro (⚪), com `motivo` legível. Nunca exceção que derrube o wizard (o cockpit é informativo; falha do cockpit ≠ falha da venda).

---

## 6. Riscos P1 (Codex) e mitigação

| # | Risco | Mitigação (2a salvo nota) |
|---|---|---|
| 1 | Preço não comparável (bruto vs líquido, desconto linha/pedido, bonificação, frete, imposto) | 2a compara o **preço que a vendedora vai praticar** (líquido, no wizard) com o CMC — comparável por construção. 2b: usa preço líquido do snapshot/pedido, nunca `sales_price_history` bruto. |
| 2 | Data errada (`created_at` = previsão de entrega) | 2b: usar `sold_at` econômico, não `created_at`. |
| 3 | Duplicidade em `sales_price_history` (multi-sync, sem unicidade econômica) | 2b: não usar essa tabela como baseline; snapshot próprio OU `sales_orders` + ledger. |
| 4 | Conta errada no join (lookup sem `account` — `omie-analytics-sync:722`) | RPC **sempre** account-aware; validar mesma conta no tint. |
| 5 | CMC observado ≠ efetivo (correção contábil retroativa parece alta comercial) | rótulo "alta observada", não data de compra; 2b quarentena. |
| 6 | Saltos extremos (+900% por erro de cadastro/unidade) | **quarentena** (2b): salto absurdo não alerta, sinaliza revisão. |
| 7 | Baixo giro / saldo zero (CMC contabilmente antigo apesar de sync recente) | frescor + neutro; 2b pondera. |
| 8 | SKU reutilizado/remapeado ao longo dos anos | âncora por unidade comercial + 2b valida identidade econômica. |
| 9 | Fórmula tint alterada (mesma cor, receita diferente) | congelar versão/hash da fórmula (2b âncora inclui versão). |
| 10 | Política sem versão (mudar piso reescreve a explicação do passado) | `markup_policy` **versionada/auditável**. |
| 11 | Concorrência (CMC muda entre abrir o wizard e enviar) | RPC retorna `calculated_at`; 2b congela a observação usada no pedido. |
| 12 | Vazamento indireto (preço + markup exato → calcula o CMC) | **D2**: número só pro gestor; payload da vendedora sem número. |
| 13 | Identidade do cliente mismapeada → baseline de outro cliente | 2b: âncora por `customer_user_id` validado. |
| 14 | Kits/quantidade (unidade econômica e faixa de volume) | RPC normaliza por unidade comercial; fracionamento cadastrado. |

---

## 7. Testes

- **Helper puro `cockpit-preco` (TDD, vitest):** classificação de faixa (🔴/🟡/🟢/⚪), markup/folga, role-gating do payload (estrutura), degradação (custo ausente → ⚪; política ausente → ⚪ exceto preço<custo → 🔴), tint all-or-nothing (qualquer componente ausente → custo nulo). É o **oráculo** que a RPC espelha verbatim.
- **PG17 (`db/test-cockpit-preco.sh`):** RPC account-aware (join certo; conta errada não casa); payload role-gated (vendedora sem número, gestor com número); tint all-or-nothing no SQL; trigger do `cmc_ledger` grava só em mudança real; RLS de `markup_policy` master-only; REVOKE anon. **Falsificação:** sabotar o role-gate e exigir vermelho.
- **Paridade** helper TS × RPC SQL (mesmos inputs → mesma faixa).

---

## 8. Não-objetivos (Fase 2a)

- Defasagem por alta de CMC (é a **2b**; a 2a só liga o `cmc_ledger`).
- Escrita de snapshot econômico no `submitOrder` (decisão da **2b**; money-path).
- Break-even/orçamento/margem de contribuição (**v2**).
- Bloquear a venda (cockpit é **informativo**; "exigir justificativa em 🔴" é follow-up).
- Alterar `computeTintPrice`/`get_tint_price` (servem o preço de venda; caminhos separados).
- Derivar meta de preços históricos.

---

## 9. Fase 2b (próximo sub-projeto — esboço, spec própria depois)

**Não depende de acúmulo** — o CMC histórico vem do Omie por `dDataPosicao` (point-in-time), backfill possível. Pré-requisito: **smoke do `dDataPosicao`** (confirmar `nCMC` histórico de verdade — money-path).
- **Cost side (CMC na data):** Omie `ListarPosEstoque` + `dDataPosicao` (autoritativo) e/ou `cmc_ledger` (cache). Definir a data de referência (N dias / última compra / último pedido do cliente).
- **Fonte da âncora (price side):** decidir A (snapshot no submit) vs B (reconstruir de `sales_orders` × CMC-na-data) — A é mais limpo mas toca money-path (review focado); B evita tocar o submit.
- **Cálculo da âncora de repasse** + a regra `P/C < Pₐ/Cₐ` (§4.4) num helper puro TDD + RPC.
- **Shadow-mode** pra calibrar tolerância (alta material, déficit mínimo) antes de exibir.
- **Quarentena** de saltos absurdos (P1 #6).
- **UI de defasagem** no cockpit (vendedora: "preço defasado — custo subiu"; gestor: Pₐ/Cₐ/P_req).
- Degradação honesta enquanto cego ("⚪ histórico insuficiente desde DD/MM").

---

## 10. Referências

- **Spec-mãe Onda 1:** `docs/superpowers/specs/2026-06-06-jornada-comercial-onda1-ligacao-design.md` (§9 cockpit, §10 fases, §18 revisão Codex).
- **Consult Codex (2026-06-14, gpt-5.5 xhigh):** `/tmp/codex-fase2-out.md` (efêmero). Achados folded: hybrid de snapshot (ledger por trigger + snapshot econômico + âncora de repasse); âncora à prova de catraca; markup≠margem; tint all-or-nothing; break-even como política de portfólio (v2); 14 P1.
- **Código-âncora:**
  - `inventory_position` (CMC atual; `{account, omie_codigo_produto, cmc, saldo, updated_at}`, unique account+código).
  - `get_tint_price` RPC `supabase/migrations/20260527180000_get_tint_price_rpc.sql` (usa `valor_unitario`, soma parcial — **não** reusar pro custo).
  - `src/lib/tint/compute-price.ts` (`custoBase=0`, corante por `valor_unitario` — variante por CMC é nova).
  - `submitOrder` + Fase 0 (`checkout_id`/`origem`/`atendimento_id` em `sales_orders`) — ponto de integração da 2b-A.
  - `pode_ver_carteira_completa(uid)` (gate gestor/master) — role-gating do número.
  - `omie-vendas-sync/index.ts:1147,1174` (preço bruto / `created_at` = previsão — por que `sales_price_history` é baseline ruim).
  - `omie-analytics-sync/index.ts:722` (lookup sem `account` — P1 #4).

---

## 11. Constraints de entrega (CLAUDE.md)

- **Migrations** (RPC, `markup_policy`, `cmc_ledger`+trigger): aplicação **manual** pelo founder no SQL Editor do Lovable (blocos inline + query de validação). **Sem edge function nova** prevista (RPC SQL pura + trigger).
- **Frontend** (cockpit no wizard): **Publish manual** no Lovable após merge.
- **CMC ledger** começa a acumular só **após** a migration aplicada (sem backfill).
