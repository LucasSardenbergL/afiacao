# Reposição "a caminho" — PO já recebida que segue contando — MEDIÇÃO (passo 0)

**Data:** 2026-08-13 · **Escopo:** OBEN (money-path) · **Origem:** handoff `onorder-po-recebida`, §5 (medição obrigatória ANTES de código).
**Método:** `psql-ro` sobre PROD (read-only). Toda afirmação abaixo é medida, não inferida — a query está no corpo.

> **VEREDITO:** o defeito é **real, grande e mecanicamente explicado** (244 de 584 POs abertas já foram
> recebidas e seguem contando); a dupla contagem **sobreviveu** ao teste com grupo de controle, mas apenas
> como evidência POPULACIONAL — ela não autoriza a regra `t4 ⇒ descontar`. **Os quatro desenhos possíveis
> com os dados de hoje foram REFUTADOS** (§3.1 a §3.4): todos podem subestimar o "a caminho", que é o lado
> proibido da invariante-mestra. O sinal correto não é `t4`, é o **movimento de estoque** originado pelo
> recebimento. **Decisão: receipt-first ledger** (§6) — founder e Codex convergiram independentemente.
>
> **Duas asserções desta medição foram corrigidas pelo Codex e NÃO devem ser recicladas:** que o subconjunto
> `nid_receb` exclusivo era "prova inequívoca" (§3.4), e que `t4` implica mercadoria no físico (§3.5).

## 1. O defeito, mecanicamente

O motor compra por `estoque_efetivo = estoque_fisico + estoque_pendente_entrada`. O "a caminho" é
Σ `saldo = max(0, nQtde − nQtdeRec)` por SKU sobre POs etapa-15 do `PesquisarPedCompra`.

**M1 — `nQtdeRec` nunca é preenchido neste tenant.** 2.726 itens de PO no `raw_data` de
`purchase_orders_tracking`: o valor é a string literal `"0"` em **100%** deles (zero com valor > 0,
zero nulos, campo sempre presente). Logo `saldo = nQtde` sempre, e o "a caminho" **nunca decrementa
por recebimento**.

**M2 — a etapa no Omie não muda ao receber.** As duas edges varrem o MESMO `PesquisarPedCompra` com
filtros DIFERENTES: `omie-sync-pedidos-compra` (espelho) pede `lExibirPedidosRecebidos:"T"`;
`omie-sync-estoque` (que calcula o "a caminho") pede `"F"`. Medido:

| etapa | tem t4 | POs | refresh hoje |
|---|---|---|---|
| 15 (Aprovado) | não | 340 | 279 |
| **15 (Aprovado)** | **sim** | **244** | **244** |

**244 POs de 584 etapa-15 (42%) já foram recebidas e seguem contando como "a caminho".** Não é lag de
sincronização: a etapa só sai de 15 quando **um humano fecha o pedido** no Omie (70=RECEBIDO/80=ENCERRADO).
Consequência: o conserto por `t4` tem valor **estrutural**, não apenas de latência — corrige um estado que
de outra forma pode nunca mudar.

**Caso âncora** (`WJOI.7666GL` = `PRD00032` = SKU `8689791246`): 5 unidades contaram como a caminho por
13 dias após o recebimento (PO 1133, t4 = 31/07); no ciclo de 13/08 18:15 o efetivo deu exatamente o
ponto de pedido (10) e o motor comprou o mínimo (3) em vez de repor até 13. **Compra suprimida.**

## 2. A tese da dupla contagem — PROVADA (com grupo de controle)

Tese do handoff: quando o recebimento é lançado, a quantidade **entra no `estoque_fisico`**; contá-la também
no "a caminho" é dupla contagem do MESMO estoque — descontar não é subestimar, é desduplicar.

**Instrumento.** Não existe histórico de `estoque_fisico` (`sku_estoque_atual` é snapshot; `inventory_position`
idem e bloqueada por RLS). A única série temporal é o snapshot **congelado por ciclo** em
`pedido_compra_item.estoque_fisico` (618 linhas, 121 SKUs, 172 ciclos, desde 26/06). Sobre pares de snapshots
consecutivos do mesmo SKU:

```
entrada_implícita = (estoque_fisico_b − estoque_fisico_a) + vendas(a, b]
```
(vendas de `venda_items_history`.)

| grupo | pares | entrada implícita média |
|---|---|---|
| **controle** — nenhum recebimento na janela | 470 | **0,05** |
| **tratamento** — recebimento na janela | 27 | **7,30** |

O controle em ≈0 é a **calibração do instrumento**: quando nada foi recebido, a equação de conservação fecha
em zero — `estoque_fisico` e `venda_items_history` são consistentes e estão na mesma unidade. O tratamento
em 7,30 ≫ 0 mostra que **a mercadoria recebida entra no físico**. Nos casos limpos (exatamente 1 PO recebida
na janela) bate quase exato: 2↔2, 4↔4, 11↔11, 10↔10, 6↔5.

⚠️ **Um viés estrutural do instrumento, registrado para quem repetir:** pares de janela curta que atravessam
um `t4` **não existem** (zero com gap ≤ 5 dias). Depois de receber, o SKU sai dos ciclos por semanas — o gap
médio do grupo tratamento é 20,4 dias contra 1,6 do controle. Por isso a comparação de médias brutas
subestima o efeito, e a leitura correta é a dos casos limpos, não a média.

## 3. Os desenhos REFUTADOS (o que a medição matou)

### 3.1 "PO com `t4` preenchido não conta mais" — o default do handoff. **MORTO.**

Das **951 linhas (PO, SKU)** das 244 POs etapa-15 com `t4`:

| situação | linhas | % |
|---|---|---|
| NF-e casada == quantidade pedida (entrega cheia) | 567 | 60% |
| NF-e trouxe **menos** que o pedido (parcial) | 39 | 4% |
| NF-e trouxe mais que o pedido | 146 | 15% |
| **não existe linha de NF-e para aquele (PO, SKU)** | **199** | **21%** |

As 199 são SKUs que **não vieram naquela nota** — seguem genuinamente a caminho. Somadas às 39 parciais,
descontar a PO inteira apagaria on-order legítimo → **subestima → compra dupla → viola a invariante-mestra.**

### 3.2 Descontar por QUANTIDADE via `sku_leadtime_history`. **BLOQUEADO.**

A coluna `quantidade_recebida` não é prova de recebimento por PO:

- **Nota consolidada:** 73 das 244 POs dividem o mesmo `nid_receb` com outras (distribuição: 171 notas 1:1,
  15 com 2 POs, 16 com 3, 9 com 4, 5 com 5, 5 com 6, 4 com 7, 1 com 8, 1 com 9, 2 com 10, **1 com 13**).
  Uma nota cobre vários pedidos → a atribuição por PO é ambígua por construção.
- **O próprio código admite** (`omie-sync-sku-items/index.ts`, passada 1): item de NF-e sem pedido casado
  "cai na linha eleita (fallback). **NÃO é o dono correto** — é um pouso determinístico", e
  "o modelo atual não sabe dizer 'não sei'" porque `tracking_id` é NOT NULL. O comentário nomeia a saída:
  "**o receipt-first ledger é a fase seguinte, não este patch**".
- Nota lateral: `quantidade_pedida` = `nQtdeNFe` e `quantidade_recebida` = `nQtdeRecebida` são unidades
  DIFERENTES (razão constante 3,24 no SKU âncora — kg vs UN). O nome da coluna engana; ela está preenchida
  inclusive em PO **sem** `t4` (ex.: PO 1145).

### 3.3 Reconciliar AGREGADO POR SKU (que dissolveria a ambiguidade de atribuição). **REFUTADO.**

Ideia: `on_order(SKU) = max(0, Σ pedido_aberto − Σ recebido)`, aggregando sobre o mesmo conjunto de POs
abertas — se a nota é consolidada, tanto faz de qual PO ela é. Medido nos 18 SKUs com pendente > 0:

| SKU | pendente hoje | pedido aberto | "já recebido" | resultado |
|---|---|---|---|---|
| 12101724100 | 14 | 62 | **539** | 0 |
| 8689733257 | 5 | 120 | 224 | 0 |
| 8689792256 | 3 | 110 | 114 | 0 |

O "recebido" excede o pedido em quase todo SKU (539 contra 62!) porque acumula NF-e de POs há muito
fechadas **e** a inflação do fallback de 3.2. Zeraria 13 dos 18 SKUs → subestimaria em massa.

### 3.4 O "subconjunto de prova inequívoca" — também REFUTADO (pelo Codex, 2026-08-13)

Critério que eu propus: `nid_receb` **não compartilhado** (nota exclusiva daquela PO) **E** existe linha de
NF-e para aquele exato (PO, SKU) com quantidade ≥ a pedida. Tamanho: **22 linhas de 951 (2,3%), 104 unidades
de 3.502 (3%)**. Eu o classifiquei como "respeita a invariante por construção". **Estava errado.**

O Codex (gpt-5.6-sol, xhigh) derrubou o predicado. Os furos residuais:

- **Exclusividade é RELATIVA, não absoluta:** `nid_receb` exclusivo prova só que nenhuma outra PO *visível
  hoje no espelho* divide o cabeçalho. Outra PO pode estar fora da janela, ausente por falha parcial de
  sync, ou ser associada depois.
- **Exclusividade de CABEÇALHO não prova propriedade do ITEM.** O fallback de §3.2 ainda pode pousar um
  item não-casado na linha da única PO. E a NF-e pode conter compras avulsas além daquela PO.
- **Sem restrição de conservação**, a mesma linha de NF-e pode satisfazer duas linhas de PO
  (falta `Σ alocações ≤ quantidade recebida`).
- **`qtde_nfe >= qtde_po` torna a regra MAIS perigosa, não mais segura** — sobre-entrega, bonificação ou
  quantidade destinada a outra obrigação passam no teste.
- **SKU textual não prova identidade** (produto alternativo, embalagem, fator de conversão, unidade
  comercial vs. tributável, cadastro duplicado).
- **Quantidade fiscal ≠ quantidade que movimentou estoque**, e o movimento pode cair em local fora do saldo.

Veredito do Codex, acatado: **não colocar o desconto §3.4 no money-path.** No máximo rodá-lo em SOMBRA,
para formar fila de investigação. Uma única das 22 linhas sem movimento de estoque individualizado derruba
o predicado em produção.

### 3.5 A correção mais importante: `t4` não prova movimento de estoque

A §2 prova dupla contagem **populacionalmente**; ela **não** autoriza a regra `t4 ⇒ pode descontar`.
`Δ físico + vendas` não separa recebimento de transferência, ajuste/inventário, devolução de cliente,
produção ou compra avulsa — "exatamente uma PO na janela" não é "exatamente um movimento positivo".
Falta a ligação causal por item.

Caminhos reais (documentados) em que `t4` existe e a quantidade **não** está no saldo lido:

- o Omie permite marcar um item como **"não movimenta estoque"** — NF-e concluída não implica movimento;
- o que determina o movimento é a **"Data de Registro"**, não necessariamente `dRec` → corrida entre `t4`,
  movimento e snapshot;
- **quarentena / armazém de terceiro** podem movimentar um local que `estoque_fisico` não soma;
- **simples faturamento, remessa e consignação** podem não movimentar estoque;
- **reversão de recebimento** exclui os movimentos, e cancelamento da NF-e não reverte automaticamente →
  `t4` permanece historicamente verdadeiro enquanto o efeito no estoque foi removido;
- **devolução**: descontar segue correto se não há reposição esperada; **subestima** se a obrigação da PO
  foi reaberta e o fornecedor mandará substituição.

**O sinal certo não é `cRecebido`/`t4` — é o MOVIMENTO DE ESTOQUE originado pelo recebimento**, ligado ao
produto e ao local corretos. O Omie expõe APIs separadas para Pedido de Compra, Nota de Entrada,
Recebimento de NF-e, **Movimento de Estoque** e Consulta de Estoque.

## 4. Achado lateral investigado e DESCARTADO

`sku_estoque_atual` tem **99 linhas com `ultima_sincronizacao` congelada** (semanas), 3 delas carregando
15 das 74 unidades de "a caminho" vivas — e o RPC `gerar_pedidos_sugeridos_ciclo` (446 linhas) lê
`estoque_pendente_entrada` **sem nenhuma checagem de frescor** (zero menções a `ultima_sincronizacao`).

Parecia um bug maior e mais barato. **Não é, para o ciclo automático:** os 3 SKUs têm
`habilitado_reposicao_automatica = false` — pararam de sincronizar porque saíram do ciclo automático, e o
motor não age sobre eles. É **higiene** (valor obsoleto exposto em telas/relatórios), não money-path vivo.

⚠️ **Duas ressalvas do Codex, que impedem fechar o assunto:**

1. `ultima_sincronizacao` velha **não prova sozinha** que a sincronização parou — ela pode significar
   "última alteração gravada", não "último polling bem-sucedido". Provar exige comparar com o log de
   execução da edge, não só com a coluna.
2. **Valor velho NÃO é conservador** — erra nos dois sentidos: pendente antigo > atual após
   recebimento/cancelamento **superestima** (suprime compra → ruptura); PO nova não capturada
   **subestima** (→ compra dupla); físico novo + pendente velho é dupla contagem. Um total que *parece*
   certo (físico 0 + pendente 9 antes, físico 9 + pendente 0 depois) pode estar certo por coincidência.

A correção segura é a mesma do ledger: staging por ciclo, publicação atômica, o motor só usando físico e
pendente da **mesma versão**, e estado `STALE/HOLD` (não gerar PO automática) quando qualquer fonte estiver
velha ou incompleta — **nunca substituir desconhecido por zero**.

## 5. Consequência para a decisão

O handoff previa: *"Se essa tese cair na medição do §5, a entrega muda de forma (ou morre) — não force o
conserto."* A tese **não** caiu — a dupla contagem é real e vale 42% das POs abertas. O que caiu foi a
**implementabilidade segura com os dados de hoje**: a réplica de recebimento não sabe dizer, por (PO, SKU),
quanto chegou — e sem isso todo desconto agressivo subestima.

**DECISÃO (founder, 2026-08-13): receipt-first ledger.** Codex convergiu de forma independente para a mesma
recomendação ("o correto é o receipt-first ledger"; o subconjunto §3.4 no máximo em sombra).

**Fora de escopo (reconfirmado):** trocar a FONTE do on-order para a réplica-por-PO (redesign B) segue
congelado por `2026-06-26-reposicao-onorder-medir-confirmar-design.md`.

## 6. Desenho do receipt-first ledger (esboço aprovado, a detalhar na implementação)

O defeito de modelagem que origina tudo: `sku_leadtime_history.tracking_id` é **NOT NULL**, então o modelo
**não sabe dizer "não sei"** e pousa o item no dono errado. O ledger existe para tornar "não sei" um estado
representável.

| tabela | papel | campos-chave |
|---|---|---|
| `receipt` | 1 por recebimento Omie | `receipt_id` nativo, chave NF-e, status, data efetiva, data de sync |
| `receipt_item` | 1 por item recebido | id nativo, produto Omie, **quantidade em unidade-base**, local, flag "movimenta estoque" — **sem `tracking_id`** |
| `po_item` | obrigação de compra | id nativo, produto, qtde-base, qtde cancelada, obrigação ainda aberta |
| `receipt_allocation` | N:N, **nullable** | quantidade alocada + **origem da associação**; "não sei" é estado VÁLIDO |
| `stock_posting` | movimento de estoque | produto, local, quantidade, data efetiva, eventual reversão |

**Invariantes (fail-closed):**

```text
Σ(alocações de um receipt_item)  ≤  quantidade efetivamente POSTADA (stock_posting, não revertida)
recebido_verificado(po_item)     ≤  quantidade_pedida(po_item)
pendente                          =  pedido − cancelado − recebido_verificado
```

Só entra em `recebido_verificado` a alocação ligada a movimento **postado, não revertido e já coberto pelo
snapshot de estoque** (watermark posterior ao movimento). Tudo calculado em staging e publicado
**atomicamente por ciclo**; o motor só consome físico e pendente da mesma versão.

Com `recebido_verificado` confiável, a §3.3 (agregado por SKU) volta a ser válida e **dispensa** a alocação
por PO — a ambiguidade da nota consolidada deixa de importar:
`pendente_sku = max(0, total_aberto_sku − recebido_verificado_sku)`.
⚠️ Mas só com movimentos **explicitamente ligados** às NF-e/POs candidatas. Agregado inferido de saldo
físico (`Δ físico + vendas`) serve como **detector de anomalia**, nunca como sinal para descontar — uma
entrada alheia (devolução, transferência, produção) zeraria falsamente todo o pendente.

### Medição que abre a implementação (fatia 1)

Codex levantou uma inconsistência que muda o desenho e **ainda não está medida**: no fluxo NATIVO do Omie,
associar itens da NF-e à PO move o pedido para "Recebido Parcialmente"/"Recebido". As 244 POs seguem em
etapa 15 — então **ou** etapa-15 é um workflow paralelo ao estado nativo de recebimento, **ou** a associação
item-a-item do Omie nunca é feita neste tenant. Até resolver isso, `t4` não pode ser tratado como recebimento.

Medir, nas mesmas 244 POs: payload de `ConsultarPedCompra` por id nativo vs. `PesquisarPedCompra`;
identificadores/quantidades da aba nativa "Recebimentos deste item"; movimento de estoque correspondente à
chave da NF-e; e status parcial/saldo/unidade/produto do detalhe. (`ListarSaldoPendente` **não** deve ser
assumido: falta validar que existe neste contrato, que é de compra, que opera por item e que reflete
parciais neste tenant — nome de endpoint não é contrato.)

## 7. Queries de reprodução

Todas com `~/.config/afiacao/psql-ro -X -c "…"`. Chaves: itens de PO via
`jsonb_array_elements(raw_data->'produtos_consulta')` (`nCodProd`, `nQtde`, `nQtdeRec`); etapa via
`raw_data->'cabecalho_consulta'->>'cEtapa'`; série de físico via `pedido_compra_item` ⋈
`pedido_compra_sugerido` (`criado_em`); vendas via `venda_items_history` (`data_emissao`).
⚠️ `sku_leadtime_history.sku_codigo_omie` é **bigint** e `pedido_compra_item.sku_codigo_omie` é **text** —
o join exige `::text`.

## 8. Errata da §3.2/§3.4 — a consolidação de nota é MUITO pior no conjunto que importa

**Medido 2026-08-13 (fatia 1, `psql-ro`), corrigindo o universo da distribuição da §3.2.**

A distribuição da §3.2 ("171 notas 1:1, 15 com 2 POs, …") está aritmeticamente correta, mas descreve
**todas as 418 POs OBEN com `nid_receb`** — não as **244** que são alvo do desconto. Reproduzido:
`171` notas 1:1 e `418` POs sobre a tabela inteira; a §3.2 é verdadeira ali. No subconjunto etapa-15
com `t4` a foto é outra:

| recorte | notas distintas | POs com nota exclusiva |
|---|---|---|
| todas as POs OBEN com nota | 230 | 171 (41% das 418) |
| **as 244 POs alvo** | **68** | **14 (5,7%)** |

**230 das 244 POs (94%) dividem a nota com outra PO** — a nota consolidada é a REGRA no conjunto que
importa, não a exceção. Distribuição nas 244: 14 notas com 1 PO, 13 com 2, 16 com 3, 6 com 4, 5 com 5,
5 com 6, 4 com 7, 2 com 8, 2 com 10, 1 com 13.

**E a exclusividade é mesmo relativa — agora medido, não só argumentado.** O Codex derrubou a §3.4 em
tese ("`nid_receb` exclusivo prova só que nenhuma outra PO *visível hoje* divide o cabeçalho"). Das
**14** notas exclusivas dentro das 244, só **12 continuam exclusivas** quando a contagem olha a tabela
OBEN inteira: 2 delas (14%) dividem a nota com POs fora do recorte etapa-15+`t4`. A exclusividade
mudou **sem nenhum dado novo chegar** — apenas por ampliar a janela de observação sobre o MESMO
espelho. Um predicado que vira falso ao mudar o `WHERE` da própria query não pode gatilhar desconto
no money-path.

**Consequência para o ledger (§6):** `receipt_allocation` N:N com quantidade **nullable** não é
generalidade defensiva — é a forma dominante do dado. Qualquer desenho que pressuponha nota→PO 1:1
cobre 5,7% do problema e erra os outros 94%.

### 8.1 Correção de tipo no M1 — `nQtdeRec` é NUMBER, não string

O M1 (§1) afirma que `nQtdeRec` "é a string literal `"0"`". A **conclusão** está certa e continua
de pé — sobre os 2.740 itens de PO OBEN do espelho, `nQtdeRec` é `0` em **100%**, zero acima de zero,
zero ausentes; o "a caminho" nunca decrementa. O que estava errado é o tipo: `jsonb_typeof` devolve
`number` para `nQtdeRec` **e** para `nQtde` em 2.740 de 2.740.

Registro porque muda código: quem implementar o parse do ledger a partir do M1 escreveria uma
política para string onde o dado é número. O `parseQtd`/`parseRecebido` de `omie-sync-estoque` já
trata os dois (string estrita **e** number), e o núcleo da sonda faz o mesmo — mas o comentário
"Omie omite" ali descreve um caso que, no espelho de hoje, **não ocorre nenhuma vez**.

## 9. A terceira hipótese para a etapa-15 — e o que a sonda da fatia 1 NÃO mede

### 9.1 O `t4` do espelho pode ser inferência NOSSA

A §6 põe duas explicações para as 244 POs recebidas em etapa 15 (workflow paralelo × associação
nunca feita). Há uma **terceira**, levantada pelo Codex e sustentada pelo próprio código:
`omie-sync-nfes-recebidas` monta o vínculo PO↔NF-e a partir de `itensRecebimento[].itensInfoAdic.
nNumPedCompra` — uma referência **textual** que o fornecedor escreve no XML — e **não** dos ids
nativos `nIdPedido`/`nIdItPedido` (ver `extractPedidosFromDetalhe`). O `t4` é gravado quando
`cRecebido=S` e **nunca é limpo** se o recebimento for revertido.

Se esse for o caso dominante, "PO recebida" é **inferência do espelho**, não estado do Omie — e a
etapa-15 deixa de ser contradição alguma. Medido junto: **nenhuma tabela do espelho guarda
`nIdPedido`/`nIdItPedido`** (`nfe_recebimentos`, `nfe_recebimento_itens`, `sku_leadtime_history`),
então a ausência do vínculo nativo aqui **nunca provou** ausência dele no Omie — provou que
ninguém foi buscar. Por isso a sonda classifica cada item numa taxonomia (`native_exact`,
`native_other_po`, `native_sem_item`, `xml_hint_only`, `xml_hint_outra_po`, `product_only`,
`unassociated`) em vez de perguntar "o campo existe?".

### 9.2 Limites conhecidos da sonda — leia antes de interpretar o resultado

- **`dangling` não é verificado.** Um `nIdPedido` que aponta para PO inexistente/inconsultável cai
  em `native_other_po`. Separar os dois exigiria uma consulta extra por id.
- **Sem varredura de paginação.** Os candidatos de movimento leem a primeira página. O relatório
  traz o total de páginas/registros **declarado**, justamente para que "página 1 vazia" não seja
  lido como "não há dado".
- **O período parte do `t4`, não do `dRegistro`.** É o `dRegistro` que governa o lançamento de
  estoque, mas ele só é conhecido **depois** da S2 — a janela é ±7 dias em torno do `t4` como
  aproximação. Uma segunda rodada pode reapontar usando o `dRegistro` que a S2 devolver.
- **A amostra é de contrato, não censo.** 3 notas distintas (dos dois extremos da consolidação),
  não as 68. Serve para fixar a FORMA do dado; frequência exige varredura.
- **Fault de parâmetro ≠ método inexistente.** A camada A (`param: {}`) só separa isso quando a
  faultstring é específica. Faultstring genérica não discrimina, e o relatório mostra o texto cru
  para que a leitura não seja automática.
