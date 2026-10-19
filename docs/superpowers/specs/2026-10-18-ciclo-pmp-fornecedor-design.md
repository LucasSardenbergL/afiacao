# Ciclo financeiro — frente 4: PMP por fornecedor e o custo do prazo

> 2026-10-18 · Spec da frente 4 adiada em `2026-10-14-ciclo-financeiro-cockpit-cliente-design.md` §10.
> Aba "Ciclo" (só master) em `/financeiro/capital-giro?aba=ciclo`. Molde: lado CR (frentes 1+2).
> Diário: `docs/historico/ciclo-financeiro-cliente.md` (seção nova "Frente 4").

## 1. Intenção (palavras do founder)

O handoff pedia uma "fila de fornecedores onde cabe negociar prazo maior". **O founder recusou essa premissa:**

> "Se eu pedir prazo maior, meu preço de compra aumenta. Quero o menor preço, com o estoque girando o mais rápido possível e recebendo dos meus clientes o mais cedo possível."

No lado de quem paga, o jogo **não** é esticar o PMP. É **pagar no ponto da condição que dá o menor preço**. O ciclo se ganha no PME e no PMR. O caso concreto é a **Sayerlack** (oben, ~67% das compras):
- pagamento antecipado dá 2% de desconto na NF;
- boleto pago até o vencimento dá 2% de desconto no boleto, e o desconto vem escrito no próprio boleto;
- acima disso, o preço sobe.

Desde jul/2026 o boleto vence em 9 a 11 dias por **escolha da fábrica** (não houve negociação).

Logo, a pergunta que a tela responde é **"quanto o prazo está me custando, por fornecedor?"**. Ela mostra:
- o desconto de pontualidade que capturei;
- o desconto que perdi, como cenário;
- os juros e multa que paguei;
- o diagnóstico de PMP por fornecedor, com o R$/dia sobre compras.

## 2. Objetivos, não-objetivos, anti-objetivos

**Objetivos**
1. PMP por fornecedor e por empresa, **só compras**: prazo concedido × prazo real, R$ em aberto a vencer e vencido.
2. **R$/dia do PMP sobre COMPRAS** (não CMV): compras emitidas em 12m ÷ 365, por empresa.
3. **Custo do prazo** por fornecedor, medido no resumo do Omie:
   - desconto obtido (R$, apurado);
   - juros + multa pagos (R$, apurado);
   - desconto perdido por atraso (R$, **cenário rotulado**).
4. Fila **"onde o prazo está custando"**, ordenada por R$ (desconto perdido + encargo pago), com o vencido em aberto ao lado.
5. Tendência de **pontualidade** (% do valor pago até o vencimento) por **mês de vencimento**.

**Não-objetivos:** giro por SKU (frente 3); mexer no engine, no `v_capital_giro_prazos` ou no simulador DES; resolver nome de fornecedor da colacor por API Omie (vira pendência medida, §7); corrigir as versões de movimento no ingest.

**Anti-objetivos (falha mesmo "funcionando"):**
- qualquer texto ou ranking que sugira **pedir mais prazo**;
- R$ de desconto perdido onde o fornecedor **nunca demonstrou** dar desconto no boleto;
- somar caixa entre CNPJs;
- tratar `NULL` de resumo como zero de desconto ou de juros;
- marcar como atrasado o que foi pago em dia só porque a conta corrente liquida no dia útil seguinte.

## 3. Fatos medidos (pré-voo psql-ro, 2026-10-18)

| Fato | Medida | Consequência no desenho |
|---|---|---|
| O PMP do engine (`v_capital_giro_prazos`) usa **todo o CP**, sem janela, ponderado por `valor_baixado` | 32 / 5 / 12 d. A colacor_sc é quase só folha; a oben carrega empréstimo e imposto | O agregado de compras **não** vai bater. A RPC devolve também o **controle engine-equivalente** (mesma base do engine) e a UI explica a diferença |
| Compras em 12m (categorias da §4.1) | oben R$ 2,50 mi / 63 fornecedores; colacor R$ 275 mil / 41; colacor_sc R$ 735 / 1 | colacor_sc ≈ sem compras: os números aparecem, com selo de amostra pequena |
| `fin_contas_pagar.nome_fornecedor` e `cnpj_cpf` | **vazios em 100%** | Nome em cascata (§4.2). Pelo `purchase_orders_tracking` sai 87% do valor da oben e 0% da colacor |
| `saldo` | = `valor_documento` **até em PAGO** | Saldo não serve para medir pagamento. Em aberto = `valor_documento` dos não pagos, com o rótulo "valor do título" |
| `valor_desconto/juros/multa` do CP | 0 em todos | Fonte de encargo e desconto = `fin_movimentacoes.resumo_*` (ótica `CONTA_A_PAGAR`), lido em ≥98% das linhas desde 2026-10-13 |
| `resumo_desconto` em compras/CP 12m | oben 59 títulos, R$ 37 mil; colacor R$ 28,6 mil; juros+multa colacor R$ 6,4 mil | Desconto e encargo são **apurados**, não estimados |
| Sayerlack depois de jul/2026 | 26 de 40 títulos pagos em dia saíram a **98%** (ex.: 5.838,88 / 5.958,04) | O desconto de pontualidade é observável e a taxa sai do dado |
| Sayerlack até jun/2026 | vencimento 1–2 d após a emissão; caixa = 100% do título | Regime antigo (2% embutido na NF, segundo o founder): **não** é desconto perdido. Ver §4.4 (regime) |
| Versões de movimento | 16 títulos de CP com 2+ `CONTA_CORRENTE_PAG` em caixa (ex.: 12182935508: 17.261,40 sem `nCodBaixa` + 16.916,17 com `nCodBaixa`) | Dedup idêntico ao do `v_titulo_encargos_cr`. Sobra → confiança `divergente`, fora do número de decisão |
| Códigos de categoria | variam por empresa (2.01.99 = imobilizado na colacor, uso e consumo nas outras) | Lista **explícita (empresa, código)**, nunca prefixo |
| Emissão vs faturamento da NF (Sayerlack × `purchase_orders_tracking`) | 0,6–2,2 d | `data_emissao` do CP é confiável como início do prazo |
| Pré-voo de atraso feito com `v_titulo_baixas.data_baixa_final` (data da CC) | "~4 d de atraso" | **Inflado pela liquidação D+1.** A pontualidade usa a data da BAIXA do título (§4.2) e tem de ser medida de novo |

## 4. Desenho

### 4.1 Universo: "compras"

Decisão do founder: entram **mercadoria para revenda, matéria-prima, frete e serviço de compra**. Ficam fora imposto, empréstimo, folha, imobilizado e uso e consumo.

| empresa | códigos |
|---|---|
| colacor | 2.01.01, 2.01.02, 2.01.03, 2.01.04 (Fretes e Carretos, inativa mas com histórico), 2.01.97 (MP importada p/ revenda) |
| colacor_sc | 2.01.01, 2.01.02, 2.01.03, 2.01.04 |
| oben | 2.01.01, 2.01.02, 2.01.03, 2.01.04 |

- A lista é um CTE `VALUES` literal numa única view (`v_ciclo_cp_compras_categorias`), com comentário citando esta spec.
- **Sensor de deriva:** a RPC de resumo devolve, por empresa, quantos títulos e quanto R$ de CP 2.01.* ficaram **fora** da lista e quantos vieram **sem categoria**. A UI mostra isso no rodapé. Categoria nova não some em silêncio.

### 4.2 Camada de fatos (SQL, views `security_invoker=on`)

1. **`v_titulo_encargos_cp`**: espelho fiel do `v_titulo_encargos_cr` (20261013094000).
   - Título: versão atual da linha `CONTA_A_PAGAR`, a última observada.
   - Baixas em caixa: `CONTA_CORRENTE_PAG`, `natureza = 'BAXP'` (mais `APBP` se existir), `tipo = 'S'`, com o dedup em 2 camadas (`nCodBaixa` manda; linha sem ID nunca elimina linha com ID).
   - Status de quitado: `PAGO`/`LIQUIDADO`.
   - Saída: mesmas colunas do CR, trocando `encargo_recebido` → `encargo_pago` e `desconto_concedido` → `desconto_obtido`.
   - `data_baixa` = `data_pagamento_omie` > `data_movimento` do título > liquidação CC (com fonte).
   - Confiança no mesmo vocabulário.
   - Fica **genérica** (todo o CP), porque serve a outras leituras depois. O recorte de compras vem na camada seguinte.
2. **`v_ciclo_cp_titulos`**: por parcela de compra (espelho do `v_ciclo_cr_titulos`).
   - **Vocabulário Omie do CP:** `PAGO`, `A VENCER`, `VENCE HOJE`, `ATRASADO`, `CANCELADO`. Fora disso → `status_ambiguo`.
   - **Situações:**
     - `paga`: tem baixa e vencimento em [hoje_sp−365, hoje_sp);
     - `paga_sem_baixa`;
     - `vencida_aberta`: `ATRASADO`, ou `A VENCER`/`VENCE HOJE` com vencimento < hoje_sp;
     - `a_vencer`: aberto com vencimento ≥ hoje_sp. É **nova**: no CP, o R$ a vencer é parte do pedido.
   - **Chave de documento:** `coalesce(nullif(btrim(numero_documento_fiscal),''), nullif(btrim(numero_documento),''))`.
   - `prazo_concedido_dias = vencimento − emissão`. **Pode ser negativo** (lançamento depois do pagamento, adiantamento). Entra na média e é **contado** (`n_prazo_negativo`), nunca descartado em silêncio.
   - `prazo_real_dias` = `v_titulo_baixas.prazo_ponderado_dias` (como no engine).
   - `dias_atraso_baixa = data_baixa(encargos) − vencimento`. Pontualidade pela data do **título**, não da CC.
   - `desconto_obtido`, `encargo_pago`, `confianca_encargo` (de `v_titulo_encargos_cp`; NULL ≠ 0).
3. **`v_ciclo_fornecedor_resumo`**: por (empresa, fornecedor).
   - **Volume:** `compras_12m` (por emissão, base válida), `n_titulos`, `n_documentos`.
   - **Prazos ponderados por valor:** concedido e real; `atraso_pond` via `max(0, atraso)` **e** a média com sinal, os dois.
   - **Pontualidade:** `pct_valor_pago_em_dia` e `pct_valor_pago_atrasado` (atraso > 0 pela data do título).
   - **Desconto e encargo:** `desconto_obtido_12m`, `encargo_pago_12m`, `n_titulos_com_desconto`, cobertura do resumo (% do valor pago com confiança de decisão).
   - **Aberto:** `valor_vencido_aberto`, `dias_vencido_max`, `valor_a_vencer`.
   - **Nome em cascata, sem fabricar:** `purchase_orders_tracking.fornecedor_nome` (empresa casada por `lower(empresa::text)`, tipo enum) → `omie_clientes_nao_vinculados` (nome_fantasia, senão razao_social) → `fornecedor_omie_cache.razao_social_omie` → NULL, e a UI mostra `#código`.
4. **`v_ciclo_fornecedor_coorte`**: por (empresa, mês de VENCIMENTO), compras. Valor vencido no mês, % pago em dia, % pago atrasado, em aberto, desconto obtido, `mes_parcial` (mesma regra do CR).

### 4.3 RPCs (gate na fronteira)

- `fin_ciclo_fornecedor_resumo()`, `fin_ciclo_fornecedor_coorte()`, `fin_ciclo_titulos_fornecedor(p_company text, p_fornecedor bigint)`. Mesmo padrão da 20261015003200: `PERFORM _fin_ciclo_gate_master()`, depois `fin_user_can_access(company)` sobre as linhas já agregadas; `REVOKE` em `PUBLIC` **e** `anon`; postcondição embutida.
- `fin_ciclo_cp_empresa()`: uma linha por empresa com
  - PMP compras (real ponderado);
  - compras_12m e `rs_por_dia = compras_12m/365`;
  - **controle engine-equivalente** (fórmula do `v_capital_giro_prazos.pmp`, reproduzida);
  - sensor de categoria (§4.1).
- Meta de tempo: < ~2 s cada, sob `SET ROLE authenticated` com as claims do master.

### 4.4 Regra pura (TS, `src/lib/financeiro/ciclo-fornecedor-helpers.ts`)

- **R$/dia do PMP** = `compras_12m / 365`. Compras ausentes ou ≤ 0 → `null` ("—" + motivo). Rótulo: "1 dia a menos de PMP (compras) ≈ R$ X de caixa · cenário".
- **Taxa de desconto de pontualidade observada** (por fornecedor):
  - é a mediana de `desconto_obtido / valor_pago_principal` nos títulos com confiança de decisão e desconto > 0;
  - exige **≥ 5 títulos com desconto** e dispersão estreita (P20–P80 dentro de ±0,5 p.p.);
  - sem isso a taxa é `null` e não há R$ perdido.
- **Regime de desconto no boleto:** começa no vencimento do **primeiro título com desconto observado** do fornecedor. Títulos vencidos antes ficam fora do cenário. Motivo: a Sayerlack antiga embutia o desconto na NF, e cobrar 2% "perdidos" ali seria fabricar.
- **Desconto perdido (cenário):** soma de `taxa × valor` nos títulos do regime **pagos com atraso > 0** pela data do título, ou **pagos em dia sem desconto**. O segundo grupo vai em linha separada, "pago em dia sem desconto — conferir boleto", porque pode ser fornecedor que não deu o desconto.
- **Custo explícito apurado** = `encargo_pago_12m` (juros + multa, confiança de decisão).
- ~~**Taxa implícita da condição:**~~ (removida — §9 #7) `(1/(1−d))^(30/N) − 1` a.m., com N = prazo concedido de **cada parcela** (calendário real, nunca a média). Mostrada como "pagar no vencimento rende ~X% a.m." (Sayerlack: 2% em 10 d ≈ 6,2% a.m.). É informativa, sem decisão automática.
- **Fila "onde o prazo está custando":**
  - ordem: `desconto_perdido_cenario + encargo_pago` em R$ (12m), decrescente;
  - empate: `valor_vencido_aberto`;
  - fornecedor sem custo (sem taxa e sem encargo) não entra na fila, só na tabela de diagnóstico;
  - texto **nunca** sugere pedir prazo.
- **Confiança/selo** por fornecedor: baixa se `n_documentos < 6` ou cobertura do resumo < 80% do valor pago.

### 4.5 UI (aba Ciclo, só master)

- **Cards de empresa (existentes):** o PMP do engine continua. Ganham a linha "PMP de compras: X d · 1 dia ≈ R$ Y" e um tooltip: "o PMP acima inclui imposto, empréstimo e folha; o de compras não".
- **Seção nova "Fornecedores (compras)"**, por empresa (nunca consolidando caixa):
  1. faixa de KPIs: % pago em dia, desconto obtido, desconto perdido (cenário), juros+multa pagos, vencido em aberto;
  2. fila "onde o prazo está custando";
  3. tabela de diagnóstico de todos os fornecedores (`useUrlState` para ordenação e filtro);
  4. drill do fornecedor com os títulos (RPC de títulos);
  5. tendência de pontualidade por mês de vencimento, com o mês parcial marcado;
  6. rodapé com o sensor de categoria e a cobertura de nome.
- Padrões do DS: `<PageSkeleton>`, `<EmptyState tone="operational">`, `text-status-*`, `track('financeiro.ciclo_fornecedor_<acao>')` ao abrir a seção e ao abrir o drill (sensor de uso, §7).

## 5. Validação (prova da entrega)

- `heavy bun run test`, `heavy bun run typecheck`, `bun run gates:rapidos`.
- Prova PG17 nova (`db/test-fin-ciclo-fornecedor.sh`): controle verde e sabotagens na **mesma invocação**, nos dois locales (`LC_ALL=C` e `pt_BR.UTF-8`), SQLSTATE e marca de ramo casadas, commit antes de falsificar. Casos mínimos:
  - versão velha de baixa sem `nCodBaixa` + versão nova com desconto (o 12182935508 sintético) → sem dupla contagem, confiança `divergente`;
  - CC liquidando D+1 → **não** é atraso;
  - `saldo = valor_documento` em PAGO → não vira aberto;
  - categoria fora da lista → fora do resumo e dentro do sensor;
  - código igual com significado diferente entre empresas;
  - resumo NULL → desconto NULL (não 0);
  - prazo negativo contado;
  - gate: não-master → 42501; anon sem EXECUTE.
- Pré-voo psql-ro:
  - o **controle engine-equivalente** reproduz 32/5/12 d;
  - o PMP de compras diverge pelo motivo da §3, com a divergência explicada no PR;
  - pontualidade da Sayerlack re-medida pela data do título.
- Tempo de cada RPC < ~2 s sob `SET ROLE authenticated` + claims do master.
- `/codex` (money-path) sobre spec e migration via `scripts/codex-async.sh`.
- Pós-Publish: `lovable-deploy-verify` (`monitor-deploy.sh --pr <n>`).

## 6. Deploy

Sem edge. Migration nova (views + RPCs), aplicada **pela sessão** no envelope do `lovable-db-operator` (pré-voo 🟢, idempotente, transacional, postcondição, validada por fora). Front: **Publish pelo founder** após o merge.

## 7. Limites conhecidos e pendências medidas

- **Nome da colacor 0%**: mostra `#código`. Resolver por API Omie é entrega própria (precisa de writer no `fornecedor_omie_cache`).
- **Desconto embutido na NF** (antecipado) não é observável no CP: entra como "sem desconto no boleto", nunca como perdido.
- **Valor do título vs. líquido do boleto:** o cenário assume a taxa sobre o principal (`resumo_val_pago`).
- **Fase N+1** (ex.: alerta de vencimento com desconto) só depois de sinal de uso desta seção (`track` com denominador = aberturas da aba Ciclo).

## 8. Respostas do builder check (medido 2026-10-18, compras 12m)

| Pergunta | Medida | Decisão |
|---|---|---|
| O desconto está em `resumo_desconto` ou só no caixa a 98%? | oben PAGO: **50 títulos com `resumo_desconto > 0`**; em 31 a soma BAXP bate com `resumo_val_liquido`; caixa < título **sem** `resumo_desconto` em só 1 título | Fonte = `resumo_desconto` (nDesconto). A **taxa observada** usa títulos com `identidade_ok` (resumo internamente coerente), **sem** exigir caixa batendo: versão velha de baixa não deve apagar a evidência da taxa. O **R$ apurado** de desconto obtido segue a confiança de decisão (`alta`/`erp_*`). *(decisão da sessão)* |
| Data de baixa só pela CC? | `data_pagamento_omie` em **100%** dos PAGO lidos (oben 489/489, colacor 221/221); só 3 títulos oben têm só CC | Pontualidade só com `fonte_data_baixa ∈ {omie_data_pagamento, titulo_data_movimento}` **e** status PAGO/LIQUIDADO. Fonte `conta_corrente_liquidacao` → "data incerta": fora do % em dia e do cenário, e contada. *(decisão da sessão)* |
| `LIQUIDADO` no CP? | Não aparece em 12m (só PAGO, A VENCER, VENCE HOJE, ATRASADO, CANCELADO) | `LIQUIDADO` = pago (como o `v_titulo_baixas`). Qualquer outro → `status_ambiguo` |
| Pagamento parcial? | Nenhum PAGO com `resumo_val_aberto > 0`; aberto lido em ~90% dos ATRASADO/A VENCER | Valor em aberto = `resumo_val_aberto` quando lido e com identidade ok; senão `valor_documento`, com o selo "valor do título". `tem_baixa` com `resumo_val_aberto > 0` = `paga_parcial` (aberto conta como vencido) |
| Regime de desconto: basta 1 título? | — | Regime começa no **1º mês de vencimento com ≥ 3 títulos com desconto** do fornecedor. Um desconto isolado não abre regime *(decisão da sessão)* |
| Peso do PMP de compras | engine pondera por `valor_baixado` | Compras ponderadas por `valor_documento` (molde CR). O **controle engine-equivalente** usa exatamente a fórmula do engine (`valor_baixado`, todo o CP, sem janela) e precisa dar 32/5/12. A ponte "engine → compras" mostra os dois passos, universo e janela |

## 9. Challenge Codex sobre a spec (2026-10-18) — calibração

Parecer cru: `2026-10-18-ciclo-pmp-fornecedor-codex-spec.txt` (gpt-6-astra, high). 0 P0, 9 P1, 1 P2. **Esta seção prevalece sobre §4.4/§8 onde conflitar.**

| # | Achado Codex | Decisão da sessão |
|---|---|---|
| 1 | Perdido pode cobrar desconto já obtido | ✅ `perdido = max(taxa·base − desconto_informado, 0)`, só com `desconto_informado` **conhecido** (não NULL). "Em dia sem desconto" fica fora do total e da fila |
| 2 | Regime/taxa generalizam evidência fraca | ✅ Conta **documentos (NF)** distintos, não parcelas. O regime começa no **vencimento** (não no mês) do 1º de ≥ 3 documentos com desconto dentro de 90 d. Taxa = mediana dos últimos 180 d do regime. Evidência de pontualidade: ≥ 80% dos documentos com desconto pagos com atraso ≤ 0; senão a taxa é `null` (motivo `nao_pontualidade`) |
| 3 | Evidência bruta × decisória misturadas | ✅ A view expõe `identidade_ok`, `desconto_informado_omie` (evidência) e `desconto_obtido` (decisão) separados |
| 4 | `titulo_data_movimento` fabrica pontualidade | ✅ Só `omie_data_pagamento` decide (medido: falta em 3 de 5.125 PAGO com baixa). O resto é "data incerta", com denominador explícito: % em dia = sobre datáveis + cobertura sobre total |
| 5 | Parcial invisível | ✅ (medido: 0 parciais hoje) Os fatos incluem abertos com BAXP; `paga_parcial`; o remanescente é classificado pelo vencimento (vencido × a vencer) |
| 6 | Dedup não protege o PMP | ✅ PMP de compras = `data_baixa(omie_data_pagamento) − emissão`, ponderado por valor, só com data confiável. Não usa `v_titulo_baixas`. Controle do engine fica fiel. A ponte mostra os 3 passos (universo, janela, peso) |
| 7 | Taxa implícita a.m. inventa alternativa | ✅ **Removida.** Mostra só o desconto % observado |
| 8 | Join de nome multiplica | ✅ Nome resolvido 1×(company, fornecedor) num CTE agregado antes do join; teste de invariância das somas |
| 9 | Views legíveis por `authenticated` contornam o gate | ✅ Views novas **sem** SELECT para `authenticated` (só `service_role`); as RPCs leem como owner. Postcondição afirma. `fin_ciclo_cp_empresa` com o mesmo gate |
| 10 | Ausente parece zero; sinal do R$/dia | ✅ Fila separa "custo apurado", "sem evidência" (contado) e "conferir boleto". Rótulo: "pagar 1 dia antes consome ≈ R$ X de caixa · 1 dia depois retém ≈ R$ X · cenário" |

Concordâncias do Codex: categorias explícitas por empresa, CNPJs separados, NULL≠0, baixa × liquidação, controle do engine separado, nome ausente visível, divergente fora do dinheiro decisório.

## 10. Decisões que ficam com o builder

Nomes finais de colunas; layout fino dos componentes; se `v_ciclo_fornecedor_coorte` também quebra por fornecedor no drill (a RPC de títulos já basta para a v1); limiares exatos de dispersão da taxa (o proposto aqui é o ponto de partida).
