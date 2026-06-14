# Venda assistida por IA — spec de design (programa, vendedor-only v1)

> Spec de design (arquitetura do programa). Data: 2026-06-14. Autor: Claude (Opus) + **2ª opinião adversarial do Codex (gpt-5.5, 166k tokens)** dobrada no desenho.
> Status: aguardando revisão do founder antes de decompor em specs/planos por fatia.
> Continuação do programa "Base de conhecimento → venda/copilot" (fundação `2026-06-11-kb-conhecimento-venda-fundacao-design.md` + casamento `2026-06-14-kb-casar-boletim-sku-venda-design.md`, já em prod via #819). Esta é a **fatia 2 (venda-IA)** do programa, que se revelou grande o bastante pra virar um **sub-programa próprio** com 4 fatias.

## 1. Contexto e problema

O casamento boletim↔SKU (#819) deu a **ponte determinística** produto técnico ↔ item vendável ↔ ficha ↔ preço-base. Agora o founder quer que, **no momento da venda/ligação**, a IA ajude o vendedor a vender melhor — sugerindo produtos a partir da **necessidade do cliente**, não só do catálogo.

O `compare-customer-process` (edge LLM que confronta o processo CADASTRADO do cliente com padrões e devolve oportunidades com `product_codes_suggested` + lookalikes) **já existe**, mas só renderiza no Customer 360 — **não na venda**, e seus códigos sugeridos são **strings da IA** (risco de alucinação no money-path).

**A tensão central (founder, textual):** *"a cada ligação tem uma situação NOVA; não sabemos o que o cliente vai reclamar na hora — como fazer análise em tempo real sem travar a tela nem poluir?"* → pré-computar uma análise **estática** do processo cadastrado **não captura a necessidade VIVA** que surge na conversa.

## 2. Objetivo e não-objetivos

**Objetivo:** no wizard de pedido, o **vendedor** (na tela dele) recebe sugestões de produto **aterradas e auditáveis** a partir do que o cliente traz na conversa — produto vendável (em estoque / sob encomenda) ou alternativa técnica (sob consulta), **sempre com SKU e preço determinísticos** (nunca fabricados pela IA), e **só quando há oportunidade real** (sem poluir).

**Princípio mestre (do Codex, adotado):** *"A v1 correta NÃO é 'IA escolhendo produtos'. É **IA entendendo a dor; o banco elegendo as opções autorizadas; o vendedor publicando uma recomendação auditável**."*

**Decisões do founder (2026-06-14) que recortam a v1:**
- **VENDEDOR-ONLY:** a sugestão aparece **só na tela do vendedor durante a venda**. **Nada aparece pro cliente** na v1. (O "mostrar pro cliente" vira follow-up: um resumo curado que o vendedor escolhe enviar — não exposição automática.)
- **Não-mapeado → "sob consulta":** opção cujo boletim **não** tem SKU confirmado aparece como **alternativa técnica sem preço** ("sob consulta"). Só opção mapeada a SKU (mesmo sem estoque) mostra preço.
- **Catalisador = % do volume da BASE.**

**Não-objetivos da v1 (YAGNI / cortados pelo Codex):**
- ❌ Card customer-facing / exposição automática ao cliente.
- ❌ Lookalikes (casos similares) visíveis ao cliente — e nem os `similarity_score` atuais servem de gate (são posicionais, falsos; ver §3).
- ❌ Análise automática/passiva do WhatsApp (mensagem antiga / conversa desvinculada → contexto falso).
- ❌ Streaming contínuo de um 2º LLM.
- ❌ **Preço pra boletim não-mapeado** (sem SKU não há preço-base confiável → "sob consulta").
- ❌ Recomendação de múltiplas alternativas abertas (máx. 1 principal; resto recolhido).
- ❌ ROI estimado pela IA.
- ❌ `useCrossSellEngine` no caminho síncrono (carrega histórico amplo, thresholds baixos, **não preserva `account`** ao mapear código Omie — `useCrossSellEngine.ts:206`).
- ❌ Reusar os `crossSellTriggers` do copiloto atual (prompt com códigos e alegações comerciais hard-coded — inadequado p/ money-path).

## 3. Riscos P0 (Codex) — guard-rails não-negociáveis

1. **Boletim sem SKU não tem preço.** Sem vínculo humano-confirmado, não há preço-base confiável → "sob encomenda com preço" = **SKU mapeado mas sem estoque**; boletim realmente não-mapeado = **só alternativa técnica, sob consulta**.
2. **"R$/L preparado" é matematicamente ambíguo.** `B + r·C` é o **custo pra catalisar 1L de base**; o lote final tem **1+r litros**. Com `r = pct/100` (% do volume da base, decisão do founder): **custo por 1L final preparado = `(B + r·C)/(1+r)`**. Pré-requisito: **volume validado da embalagem** — o `valor_unitario` do Omie é o preço da **embalagem**, não por litro (`B = preço_embalagem / litros_embalagem`). Catalisador obrigatório sem SKU/volume/preço → `price_status=incomplete` ("sob consulta"). **Nunca somar componente ausente como zero** (o `get_tint_price` faz isso no agregado — **não copiar**, `20260527180000_get_tint_price_rpc.sql:32`).
3. **Preço "do cliente" não é contratual.** É o último preço praticado (`sales_price_history`), e o mesmo mapa é copiado pra Oben e Colacor (limitação reconhecida, `useCustomerSelection.ts:421`). **Não apresentar como "seu preço fechado".**
4. **Estoque é indicativo** (cache até 10min, atualizado em background, `useProductCatalog.ts:12`). **"Em estoque agora" é promessa forte demais** → enquadrar como indicativo.
5. **Os `similarity_score` dos lookalikes são FALSOS** — recebem `1.0/0.9/0.8` pela **posição na query**, não por similaridade (`compare-customer-process/index.ts:297`). **Não servem de gate.** E o anonimato atual é fraco (cidade+segmento+porte+tempo+texto livre → reidentifica empresa local) → lookalikes **nunca** vão pro card; só ranking interno / prior estatístico agregado com coorte `k ≥ 5`.

## 4. Arquitetura — o pipeline

```text
sinal vivo (fala do cliente, capturada pelo vendedor)
  → [LLM] extrai NeedFrame (a DOR estruturada — não SKU)
  → retrieval nos boletins APROVADOS (pgvector server-side)
  → GATE determinístico (conjunção — §6)
  → RESOLVER server-side: elege SKU/preço/estoque das opções AUTORIZADAS
       (casamento v_omie_product_current_spec + standard_processes curados)
  → [LLM] apenas EXPLICA os candidatos que sobreviveram
  → card auditável SÓ do vendedor (máx. 1 principal; alternativas recolhidas)
```

**Duas camadas (Codex refinou):**
- **Camada Ambiente (background, "o que já sabemos do cliente"):** pré-computa `compare-customer-process` **quando `customer_processes`/padrões/boletins MUDAM** (não roda Sonnet a cada abertura do pedido). Na seleção do cliente, **só lê cache**. Mostra só se houver oportunidade.
- **Camada Viva (reativa, "o que o cliente traz AGORA"):** o vendedor **captura** o sinal vivo → extração → candidatos → cotação. **Nenhuma etapa bloqueia o wizard**; resposta atrasada é descartada por `customer_id + situation_revision` (guarda de corrida). "Tempo real" = **reativo ao sinal real**, não preditivo.

**Estados de resultado por opção (a UI distingue):**
- `SELLABLE_NOW` — SKU mapeado + saldo indicativo + preço. (Base e **componentes obrigatórios** mapeados, precificados e disponíveis.)
- `ORDERABLE` — SKU mapeado, sem saldo, com **preço/litro preparado** (catalisado).
- `TECHNICAL_ONLY` — boletim sem SKU → **sem preço** ("sob consulta").

## 5. Contratos de interface

**`NeedFrame` (saída do LLM extrator — a DOR, nunca SKU):**
```
problema, resultado_desejado, substrato, etapa, acabamento,
restricoes, urgencia, evidencia_literal (citação textual da fala)
```
Todo identificador eventualmente retornado pelo modelo passa por **validação por allowlist** (pós-validação — o prompt atual pede "não invente código" mas **não pós-valida**, `compare-customer-process/index.ts:37`).

**Resolver (server-side, determinístico) — entrada `NeedFrame` (+ candidatos do retrieval), saída lista de:**
```
{ kb_product_spec_id, account, omie_codigo_produto|null,
  estado: SELLABLE_NOW|ORDERABLE|TECHNICAL_ONLY,
  preco: { status: ok|incomplete, valor_litro_preparado?, base?, componentes? },
  estoque_indicativo?, evidencia, spec_version, timestamps }
```
- Retrieval devolve **`kb_product_spec_id`**, nunca código inventado.
- Filtros técnicos eliminam incompatíveis (substrato/etapa/uso).
- `standard_processes` fornece IDs/códigos **humano-curados**.
- A view `v_omie_product_current_spec` resolve `spec_id → account + omie_codigo_produto` (casamento).
- O resolver calcula preço + disponibilidade. O LLM **só explica** o que sobreviveu.

**Auditoria (Codex, pré-requisito da v1):** cada recomendação registra evidência (fala), spec, **versão da spec**, preço, estoque e timestamps — pra rastrear o que foi sugerido e com base em quê.

## 6. Gate de oportunidade real (conjunção determinística)

**Não** usar threshold isolado de embedding nem confiança do LLM. Exigir **todos**:
- Há **fala literal** indicando problema/objetivo/dúvida/restrição.
- Há **boletim aprovado** semanticamente relevante.
- **Substrato, etapa e uso não contradizem** a necessidade.
- **Specs críticas preenchidas** (senão não dá pra recomendar com segurança).
- A recomendação é **mudança real** (não algo já na cesta/processo).
- Existe **ação comercial possível** (`SELLABLE_NOW`/`ORDERABLE`/`TECHNICAL_ONLY`).
- Pra `SELLABLE_NOW`: base + componentes obrigatórios mapeados, precificados **e** disponíveis.

O threshold semântico precisa ser **calibrado com exemplos rotulados**. "Sem oportunidade" → **não renderiza nada**. Erro técnico → telemetria + estado discreto **só pro vendedor**.

## 7. Decomposição em fatias (cada uma = spec→plano→PR próprio)

Ordem por dependência:

- **Fatia 1 — Resolver + pricing determinístico** (fundação money-path). Dado `spec_id`/categoria curada → SKU autorizado (casamento) → estado (`SELLABLE_NOW`/`ORDERABLE`/`TECHNICAL_ONLY`) + preço (catalisado `(B+r·C)/(1+r)`, volume da embalagem, degradação "sob consulta", nunca componente=zero). **Engine puro, testável (helper + PG17), verificável SEM LLM.** Desbloqueia tudo.
- **Fatia 2 — Camada Ambiente (vendedor-only):** no wizard, lê a análise `compare-customer-process` cacheada (pré-computada on-change) → passa pelo resolver → **card do vendedor**. Estabelece a UI + a auditoria.
- **Fatia 0 — Fix do `rag-search` (pgvector server-side):** hoje faz cosine em **JS sobre 200 linhas arbitrárias** (índice ivfflat sem uso, `rag-search/index.ts:81`). **Prereq de qualidade** do gate de produção. Adiável enquanto a base de boletins é pequena; fazer **logo antes** da Fatia 3.
- **Fatia 3 — Camada Viva (o coração):** captura do sinal (texto curto + **prefill da última fala** da transcrição existente; padrão de debounce 3s do `useSpinAnalysis.ts:20`) → edge que extrai o `NeedFrame` → gate (§6) → resolver (Fatia 1) → card.

**Sequência recomendada:** **1 → 2 → (0) → 3.**

## 8. Fluxos

**Ambiente:** seleção do cliente → lê cache de oportunidades conhecidas → resolver → card (se houver). Background recomputa quando o processo/padrão/boletim muda.

**Viva:** vendedor capta o que o cliente disse (campo curto, ou "usar última fala" do transcript) → extrai NeedFrame → gate → resolver → card auditável. Resposta atrasada descartada por `situation_revision`.

## 9. Casos de erro / money-path safety

- Sem SKU confirmado → `TECHNICAL_ONLY`, sem preço.
- Catalisador/componente sem SKU/preço/volume → `price_status=incomplete` ("sob consulta"); nunca zero.
- Sem oportunidade que passe no gate → nada renderiza.
- LLM retorna código/claim → descartado por allowlist (o resolver é a fonte de SKU).
- Resposta atrasada/concorrente → descartada por `customer_id + situation_revision`.
- Estoque/preço-do-cliente → enquadrados como **indicativo/último praticado**, não promessa.

## 10. Decisões e trade-offs

- **Vendedor-only v1** (founder) — elimina o risco de expor produto/preço errado ao cliente; simplifica (sem card customer-facing, sem publish, sem leak de lookalike). "Mostrar pro cliente" vira follow-up curado.
- **IA extrai a DOR, banco elege o SKU** (Codex) — inverte o `product_codes_suggested` (string da IA) por `NeedFrame` + resolver determinístico + allowlist. Núcleo do money-path.
- **Não-mapeado = sob consulta** (founder + Codex) — nunca preço fabricado.
- **Catalisado, % da base, `(B+r·C)/(1+r)`** (founder + Codex) — fórmula explícita, volume da embalagem obrigatório, degradação honesta.
- **Camada Ambiente pré-computa on-change, não por abertura** (Codex) — custo/latência controlados.
- **Gate por conjunção determinística, não threshold de IA** (Codex).

## 11. Sub-problemas abertos (resolver nas fatias)

- **Volume da embalagem por SKU** (pra `B = preço/volume`): de onde sai? (campo do Omie? cadastro? derivar da descrição/unidade?). **Pré-requisito do pricing** — investigar na Fatia 1; sem volume confiável → `price_status=incomplete`.
- **Catalisador → SKU/preço:** o `catalisador_codigo` do boletim é uma string (igual ao código-base) → precisa do **mesmo casamento** (vínculo do catalisador a um SKU). Sem isso → "sob consulta".
- **Calibração do gate** (threshold semântico + exemplos rotulados) — precisa de dados; começa conservador (alto precision).
- **pgvector** (Fatia 0) — corrigir antes do gate de produção.
- **Componentes obrigatórios** (o que conta como "componente obrigatório" de um boletim: catalisador? diluente?) — modelar na Fatia 1 a partir dos campos do boletim.

## 12. Dependências e sequência de build

- **O build da Fatia 1 (resolver) consome o casamento EM PROD** → começar **depois** do founder **Publicar** o front (#819) + **popular alguns vínculos** reais pelo painel (pra verificar de verdade, não no vazio).
- O **design** (esta spec) não depende disso.
- Cada fatia: helper puro TDD onde houver lógica + **PG17** no money-path (Fatia 1) + **Codex adversarial** antes do apply (é money-path + LLM-trust, diferente do casamento que era front puro).

## 13. Testes (por fatia)

- **Fatia 1:** helper puro do pricing (vitest) — fórmula `(B+r·C)/(1+r)`, degradação sob-consulta, componente-ausente-≠-zero, volume-da-embalagem; resolver em **PG17** (estados, allowlist, casamento).
- **Fatia 3:** anti-alucinação enforçada (allowlist pós-LLM), guarda de corrida (`situation_revision`), gate por conjunção.
- Verificação visual = QA do founder pós-Publish.

## 14. Nota Codex

Consult adversarial rodado em 2026-06-14 (gpt-5.5, reasoning `high`, 166k tokens, read-only no repo). Achou **5 riscos P0** (todos com citação de código — §3), reescreveu a arquitetura ("IA entende a dor; banco elege; vendedor publica auditável"), e definiu o corte v1 (§2/§7). **Todos os achados foram dobrados nesta spec.** Nas fatias de implementação (sobretudo Fatia 1 e 3, money-path + LLM), **rodar Codex adversarial no código** antes do apply (padrão do programa financeiro/KB).
