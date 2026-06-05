# Decisão de Embalagem Econômica (QT/GL) — Spec de Design

> **Data:** 2026-06-04 · **Status:** aprovado p/ implementação (v1) · **Money-path** (reposição/compras)
> **Origem:** brainstorming com o founder + consult Codex (gpt-5.5). Surgiu durante a investigação do "item 2" (transposição de giro entre SKUs); o founder levantou um caso adjacente — comprar a embalagem mais barata — que tem **maior retorno recorrente** e foi priorizado.
> **Fundação comum:** este projeto constrói a primitiva "vincular SKUs equivalentes com um fator de conversão". A **sucessão de giro** (o item 2 original) reusa essa base num projeto seguinte (§13).

---

## 1. Problema

Alguns insumos da Sayerlack (concentrados linha **WP**, ~12 itens) existem em **duas embalagens** do mesmo conteúdo: **QT** e **GL**, com **1 GL = 4 QT** (fator fixo). O preço relativo das duas **vira sem aviso** — às vezes compensa comprar GL, às vezes QT, por unidade-equivalente. Hoje o founder **confere isso na mão**, toda compra, consultando o portal da Sayerlack.

O sistema não tem nenhuma noção de equivalência entre SKUs: todo o motor de reposição é chaveado por `sku_codigo_omie` (demanda lida de `venda_items_history`, 90d → `v_sku_parametros_sugeridos` → `sku_parametros`, recálculo diário via `omie-cron-diario`). QT e GL aparecem como dois itens independentes, com giro partido entre eles.

**Dor:** dinheiro perdido (ou atenção gasta) em toda compra de concentrado por não saber, no momento, qual embalagem está mais barata por unidade-equivalente.

---

## 2. Objetivo e não-objetivos (v1)

**Objetivo:** para os pares QT/GL cadastrados, recomendar **qual embalagem comprar pelo menor custo por unidade-base** (QT-equivalente), no fluxo onde o founder revisa a sugestão de compra. O founder tolera "arredondar pra cima" (comprar 1 GL para uma necessidade de 1 QT) quando o custo por unidade-base compensa.

**Não-objetivos da v1 (cortados por YAGNI / decisão do founder + Codex):**
- **Não** reprojeta a demanda desses itens (ela é ruidosa — §3.1). A decisão é por **preço**, não por demanda nova.
- **Não** consolida estoque QT+GL no motor de reposição nem regrava `estoque_minimo`/`ponto_pedido` por grupo (double-count, distorce ponto de pedido). Consolidação aparece só como **explicação** da opção, nunca gravada.
- **Não** automatiza a captura de preço na v1 (scraping é Fase 2 — §4, §10).
- **Não** cria tela nova: a recomendação aparece dentro do fluxo de compra existente.
- **Sem** alerta proativo, histórico longo de preço, confiança numérica, limpeza de demanda de liquidação (Fases 2/3).

---

## 3. Restrições de realidade (confirmadas com o founder)

**3.1 Demanda ruidosa.** Parte dos concentrados é **consumo interno** (tintometria — não aparece em `venda_items_history`); parte é **venda**, às vezes **venda-liquidação** (vende perto do custo + desconto em outro item, só pra desovar estoque). Logo, a demanda via venda é um sinal fraco para esses itens → v1 não a reprojeta.

**3.2 Preço só via simulação de pedido.** O preço de compra **não existe** em catálogo/API/tabela exportável. Ele só aparece **simulando um pedido** no portal: inicia um rascunho, coloca o código + embalagem (QT e GL), o portal mostra o preço de cada (respeitando o fator), e o founder **não efetiva** — fecha/abandona. O portal auto-exclui rascunhos não-efetivados depois de um tempo.

**3.3 Concentrados praticamente não vencem.** Validade longa — na prática escoam antes de vencer. → A v1 **não modela trava de validade**; o único freio do overbuy (comprar 4× ao escolher GL) é o **capital parado**.

**3.4 Founder sem terminal.** Migrations custom são coladas manualmente no SQL Editor do Lovable; edge functions deployadas via chat do Lovable. Cada ida ao banco/edge é cara → minimizar idas (uma migration única).

---

## 4. Decisão central: faseamento

O founder escolheu **captura automática (scraping via Browserless)** como alvo. O Codex e a análise convergiram em **desacoplar o valor do risco**, e o founder aprovou:

- **v1 entrega a decisão de embalagem com preço MANUAL.** Sem tocar no portal. O founder digita os dois preços que já está vendo no portal; o sistema faz a conta certa e recomenda. Ganho rápido, risco ~zero.
- **Scraping vira Fase 2, atrás de um spike obrigatório** (§10). Se o spike não provar que dá pra ler o preço **e** abandonar o rascunho sem nunca chegar perto do "finalizar" e sem nascer PO, o scraping não entra — e o manual já resolve.

O scraping é money-path frágil: o portal Sayerlack roda via Browserless, é flaky (timeouts/408) e já causou um incidente de ~R$82k em pedidos órfãos/duplicados.

---

## 5. Arquitetura v1

### 5.1 Modelo de dados — **uma** migration única (§3.4)

**Tabela `sku_embalagem_equivalencia`** (os pares; cadastro manual):

| coluna | tipo | nota |
|---|---|---|
| `id` | bigint PK | |
| `empresa` | text | |
| `grupo_id` | uuid | default `gen_random_uuid()`; agrupa as embalagens do mesmo conteúdo |
| `sku_codigo_omie` | text | |
| `unidade_base` | text | ex.: `QT` (uma só por grupo) |
| `fator_para_base` | numeric | QT=1, GL=4 |
| `fornecedor_nome` | text | `Sayerlack` |
| `ativo` | boolean | default true |
| `vigente_desde` / `vigente_ate` | date | `vigente_ate` nullable |
| `criado_por` / `criado_em` | | |

Constraints: um `grupo_id` tem **uma única** `unidade_base`; cada `(empresa, sku_codigo_omie)` ativo pertence a **no máximo um** grupo. RLS staff (padrão do módulo reposição).

**Tabela `sku_preco_fornecedor_capturado`** (os preços; v1 alimentada manualmente, campos de captura já prontos pra Fase 2):

| coluna | tipo | nota |
|---|---|---|
| `id` | bigint PK | |
| `empresa` | text | |
| `sku_codigo_omie` | text | |
| `fornecedor_nome` | text | |
| `preco` | numeric | |
| `moeda` | text | `BRL` |
| `preco_tipo` | text | `liquido` \| `bruto` (o que o número representa) |
| `capturado_em` | timestamptz | |
| `fonte` | text (enum) | `manual_usuario` \| `portal_capturado_ok` \| `portal_capturado_parcial` |
| `status` | text (enum) | `ok` \| `stale` \| `falhou` (frescor) |
| `run_id` | text nullable | **Fase 2** (rastreio da captura) |
| `validade_operacional_ate` | timestamptz nullable | até quando o preço é considerado válido |
| `observacao` | text nullable | |
| `criado_por` / `criado_em` | | |

Na v1: só `fonte='manual_usuario'`. O preço vigente é o registro mais recente por `(sku_codigo_omie, fonte)`. **A "confiança" do preço (recomendação do Codex) é expressa por `fonte` + `status` — ambos enums, sem número** (evita falsa precisão).

**Kill-switch em `company_config`** (tabela já existente):
- `embalagem_captura_automatica_habilitada` (default `false`)
- `embalagem_preco_stale_horas` (default `24`)

Na v1 a captura nem existe, mas o gate nasce pronto — o founder liga/desliga **sem deploy**.

### 5.2 Helper puro novo — `src/lib/reposicao/embalagem-helpers.ts` (TDD, testes primeiro)

Helper **novo** (não enfiar no `compras-otimizador-helpers.ts`, que decide "vale comprar mais?"). Espelha o estilo dos helpers money-path do projeto (puro, testado com vitest). Função núcleo `escolherEmbalagemEconomica`:

**Input:** `necessidadeBase` (quantidade necessária em unidade-base, vinda da sugestão de compra do item, consolidada pelo fator); `opcoes[]` (`{ sku_codigo_omie, fator_para_base, preco, preco_status, preco_capturado_em, lote_minimo? }`); `params` (`{ custoCapitalAnual, limiarMinimoEconomiaRS, demandaBaseDiaria? }`).

**Lógica:**
1. Considerar opções com preço **informado**. **< 2 opções com preço → `indisponivel`** (pede preço; não recomenda). Preço `stale` (idade > `stale_horas`) **entra com flag `preco_desatualizado`** (aviso "confira/atualize"), não bloqueia — preço manual nunca "some" sozinho; só preço **ausente**/`falhou` bloqueia.
2. Custo por unidade-base de cada opção = `preco / fator_para_base`.
3. Pra atender `necessidadeBase`: `qtd_embalagens = ceil(necessidadeBase / fator)`, `unidades_compradas = qtd_embalagens * fator`, `excedente_base = unidades_compradas − necessidadeBase`.
4. Custo direto = `qtd_embalagens * preco`.
5. **Capital de carrego do excedente:** se `demandaBaseDiaria` disponível → `dias_escoa = excedente_base / demandaBaseDiaria`; `capital = (excedente_base * custo_unit_base) * custoCapitalAnual * (dias_escoa / 365)`. Se demanda ausente → `capital = null` (não estima; mostra excedente cru + flag `escoamento_nao_estimado`). **Sem trava de validade** (§3.3).
6. Custo total ajustado = `custo_direto + (capital ?? 0)`.
7. Recomenda a opção de **menor custo total ajustado** para a mesma `necessidadeBase`.
8. **Guard de overbuy marginal:** se a vencedora gera excedente e a economia ajustada vs. a melhor opção **sem** overbuy é `< limiarMinimoEconomiaRS` → recomenda a sem-overbuy (ou marca `ganho_marginal`). Evita empurrar GL por centavos.
9. **Degradação honesta:** preço **ausente**/`falhou` ou `fator` ausente → não recomenda. Preço `stale` → recomenda com aviso (ponto 1).

**Output:** `{ recomendada | null, status: 'ok'|'indisponivel'|'marginal', custo_por_base_por_opcao[], excedente_base, capital_estimado | null, economia_vs_alternativa, precos_data[], flags[] }`.

### 5.3 Integração na UI

Na **revisão da sugestão de compra** (cockpit de pedidos — `AdminReposicaoSessaoPedidos` / card do item sugerido), para SKUs que pertencem a um grupo de equivalência: um bloco **"Embalagem"** com:
- os dois preços atuais (valor + data + status/fonte);
- a **recomendação** (qual comprar) + economia por unidade-base + excedente/capital estimado;
- botão **"Atualizar preços"** → dialog pra digitar QT e GL (`fonte=manual_usuario`). *(Na Fase 2, esse mesmo botão também dispara a captura automática.)*
- preço velho/ausente → "informe os preços pra ver a recomendação" (**não recomenda no escuro**).

### 5.4 Kill-switch e degradação honesta

- Captura automática (quando existir) só roda se `embalagem_captura_automatica_habilitada=true` — desligável sem deploy.
- Preço além de `embalagem_preco_stale_horas` → `status='stale'`. Na v1 (manual) isso vira **aviso** na recomendação (não some — o founder reinforma quando for comprar). Na Fase 2 (capturado), `stale` **sai** da recomendação automática e cai no manual.
- Nenhuma recomendação é emitida sem **dois preços informados** (preço ausente/`falhou` bloqueia).

---

## 6. Lógica de decisão — exemplos

- **GL/4 < QT, necessidade grande (sem excedente):** recomenda GL. Economia direta.
- **GL/4 < QT, necessidade pequena (1 QT):** GL gera 3 QT-equiv de excedente; o capital de carrego é descontado; só recomenda GL se a economia ajustada > limiar. Senão recomenda QT (ou `ganho_marginal`).
- **QT mais barato por unidade-base:** recomenda QT, sem excedente.
- **Sem demanda confiável:** recomenda pela comparação de preço/unidade-base, `capital=null`, flag `escoamento_nao_estimado` (decisão de overbuy fica com o founder, que tolera estocar).

---

## 7. Auditoria

A recomendação carrega a **explicação estruturada**: "recomendei GL porque QT=R$x, GL=R$y → GL/4=R$z < R$x; excedente N QT-equiv; capital ~R$w; preços de DD/MM (fonte: manual)". Decisão errada nunca vira caixa-preta.

---

## 8. Testes (helper puro, espelhados, escritos primeiro)

1. QT vence por preço.
2. GL vence por preço, necessidade grande → recomenda GL.
3. GL mais barato/unidade mas necessidade pequena → capital come a economia → recomenda QT.
4. Economia abaixo do limiar → não empurra overbuy (`ganho_marginal`).
5. Preço de uma embalagem **ausente** → `indisponivel`, não recomenda.
6. Preço `stale` → recomenda com flag `preco_desatualizado` (não bloqueia).
7. `fator` ausente → não recomenda.
8. Demanda ausente → recomenda por preço/unidade-base, `capital=null`, flag `escoamento_nao_estimado`.

---

## 9. Achados do Codex incorporados

Consult Codex (gpt-5.5) gerou os P1 que moldaram este desenho:
- Faseamento (v1 manual / scraping Fase 2 atrás de spike) — §4, §10.
- Captura nunca no clique crítico de compra; cron/botão explícito — §10.
- Helper novo (não estender o marginal); modelo de preço rico (fornecedor/moeda/líquido-bruto/`fonte`+`status` enums, sem confiança numérica) — §5.1, §5.2.
- Custo total ajustado (não preço/4); não consolidar estoque no motor — §5.2, §2.
- Kill-switch visível + auditoria + política de estado-desconhecido — §5.4, §7, §10.

---

## 10. Roadmap das fases seguintes (fora do escopo deste spec da v1)

- **Fase 1.5 — Spike (gate de viabilidade):** 1 item, execução manual, sem retry/cron/integração. **Sucesso =** lê preço QT/GL de forma inequívoca (qual campo é o preço — por lata, não por litro/subtotal), **não** alcança estado finalizável, **abandona e verifica** que nenhum PO nasceu. Se precisar chegar perto do "finalizar" ou não conseguir limpar/verificar o rascunho → **scraping sai do roadmap**, fica no manual.
- **Fase 2 — Captura automática:** edge function **separada** do motor de envio (`enviar-pedido-portal-sayerlack`) — compartilha só o login, **nunca** o fluxo de pedido; credencial/perfil de cotação **sem permissão de finalizar** se o portal permitir. Cron diário pros 12 (não sob-demanda). **Lock** por fornecedor+grupo (1 job ativo), **circuit-breaker** (1 falha pós-login ou 408 no carrinho → desliga por X horas, força manual), **retry só antes de inserir item** (depois disso, falha = estado desconhecido → bloqueia novas cotações até cleanup/verificação), **run-log + evidência** (run_id, screenshot/HTML, estado, preço), **cleanup explícito** de rascunhos (não confiar no auto-expire), atrás do kill-switch, **desligada por default**.
- **Fase 3 — refino:** lote mínimo por embalagem na decisão; badge "GL ficou mais barato desde DD/MM"; histórico de preço; eventual consolidação/limpeza da demanda dos concentrados.

---

## 11. Limitações conhecidas da v1

- Preço é manual → tão fresco quanto a última digitação (mitigado: status/stale + pedir atualização).
- Capital de carrego usa a demanda existente (ruidosa) como proxy de escoamento — degradação honesta quando ausente.
- Lote mínimo por embalagem não entra na decisão v1 (Fase 3).
- Impostos/descontos/frete condicionais do pedido real podem divergir do preço informado (`preco_tipo` documenta o que o número representa; refino na Fase 2/3).
- Sem consolidação de estoque/demanda no motor (intencional — §2).

---

## 12. Pendências do founder / operação Lovable

- **Migration manual** (uma só): colar no SQL Editor do Lovable (empacotar via skill `lovable-db-operator`) + query de validação.
- **Cadastro dos ~12 pares** QT/GL (`sku_embalagem_equivalencia`) — manual.
- **Parâmetros de decisão:** `custoCapitalAnual` (reusar `empresa_configuracao_custos`/cm_anual do otimizador) e `limiarMinimoEconomiaRS` (definir um piso).
- Sem deploy de edge na v1 (helper + UI são front; só a migration toca o banco).

---

## 13. Relação com o item 2 original (sucessão de giro)

A primitiva `sku_embalagem_equivalencia` (vínculo de SKUs + fator) é a mesma fundação que a **sucessão de giro** precisa (transpor o histórico de um SKU descontinuado para o sucessor — investigação do "item 1" provou que o "Transferir" atual só copia parâmetros, e o recálculo diário os sobrescreve). A sucessão é um projeto seguinte que reusa esta base, com a diferença de que lá o vínculo é **temporal** (antigo→sucessor, fator ~1) e a demanda **é** transposta. Não faz parte deste spec.
