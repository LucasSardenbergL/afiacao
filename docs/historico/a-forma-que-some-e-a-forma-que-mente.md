# `{data && <X/>}` — o segundo front, medido antes de varrido (2026-09-06)

A varredura de 2026-08-22 (`fase-sem-sinal.md` §"A CLASSE, varrida e gateada") erradicou a
**auto-ocultação total** (`return null` guardado pela leitura) e deixou de fora, de propósito, a
forma `{data && <X/>}` — 93 sítios, idioma legítimo na maioria. Esta entrada é a medição desse
resto. **Não é uma varredura**: é o inventário classificado que decide o que merece correção, e
com que ordem.

Reprodução (o detector já enxerga a forma; nenhum código de produção foi alterado para medir):

```ts
// acharColapsos(conteudo, nomeArquivo).silencios.filter(s => s.forma === 'jsx-&&')
// sobre src/**, mesmo filtro de fontes do gate (src/__tests__/erro-colapsado-em-vazio-gate.test.ts)
```

**93 sítios · 199 ocorrências · 70 arquivos** (1.472 fontes) — bate exatamente com a contagem
registrada em 2026-08-22, o que prova que o eixo não se moveu em 2 semanas.

## O que a medição acrescentou à classe

### 1. A forma tem dois sub-tipos, e o dano é OPOSTO

| sub-tipo | o que a falha de leitura produz | sítios |
|---|---|---|
| `{dado && <X/>}` | o trecho **some** (o dano do #1859) | 77 |
| `{derivada.length === 0 && <p>Nenhum…</p>}` | o trecho **aparece e afirma "não há"** | 16 |

Os 16 são exatamente os que têm **default no binding** (`data: x = []`). Não é coincidência: o
default é o que converte "não consegui" em "está vazio", e daí a tela **afirma o vazio com
palavras**. Sumir é ambíguo; `"Sem registros de auditoria"` sobre uma fonte de 11.869 linhas é uma
frase falsa. **O sub-tipo que mente é mais grave que o sub-tipo que some** — e é o irmão da classe
(`ausente → vazio`) morando dentro da forma que o gate deixou de fora.

### 2. O pré-requisito de dano é o hook LANÇAR — e 21 dos 93 não lançam

`const { data } = await supabase…; return data ?? []` **engole o erro dentro do `queryFn`**: a
query fica `success` com `[]`, o `error` do react-query nunca popula, e `<AvisoLeituraFalhou>` é
**inalcançável por construção**. Nesses 21 sítios, trocar o `&&` por `estadoDeLeitura` seria *fix*
inerte — um diff plausível com zero mudança de comportamento (a mesma armadilha do `?? 0` de
`UnifiedOrder` em 2026-08-22). O defeito está uma camada abaixo, no hook.

Medir isto exigiu AST: a primeira passada procurou `throw` por texto exigindo `export`, e **errou em
4 hooks não-exportados** (`useResumoCiclo`, `useSkuDescricoes`, `useLastErrors`, `useSkus`) — dois
deles na direção que mais importa (lançam, e o texto disse que não).

### 3. Existe uma TERCEIRA forma, que nem o gate nem esta varredura enxergam

```tsx
// src/pages/ToolHistory.tsx:173
if (!tool || !healthMetrics) return ( … <p>Ferramenta não encontrada</p> … );
```

Não é `null` (o gate exige `ehSilencio`: null/undefined/fragmento vazio), não é `&&`. É
`return <mensagem afirmativa>` — e é a mais afirmativa das três: em vez de sumir, **mente com
especificidade**. "Ferramenta não encontrada" quando a leitura falhou é uma afirmação sobre o banco
que o componente não tem como fazer. Fica registrada como o terceiro front; não foi varrida aqui.

### 4. A armadilha de medição que quase inverteu a conclusão — de novo

O sítio de maior dano (cockpit de preço no carrinho) mediu **`orders` = 0 linhas** ⇒ "dano hoje
zero, chip com gatilho". A tabela certa era **`sales_orders` = 508 pedidos em 30 dias**. O nome
plausível produziu um zero plausível, e o zero quase virou veredito. O que separou os dois foi ir ao
código de **escrita** da tela (`UnifiedOrder.tsx:156`) em vez de ao nome que parece certo.
**Denominador só vale com a fonte confirmada pelo escritor.**

## Denominadores (psql-ro, 2026-09-06)

| fonte | linhas | serve a |
|---|---|---|
| `sales_orders` | **31.248 · 508/30d · 134/7d** (último 2026-09-04) | cockpit de preço |
| `fin_movimentacoes` | 56.536 · 399 no mês · 62 categorias/90d | alerta de mapeamento |
| `tint_importacoes` (erro>0) | **1.656** | card "Últimos erros" |
| `margin_audit_log` | **11.869** | auditoria de margem |
| `pedido_compra_sugerido` | 440 · 4 hoje · 30d: 4 pend. aprovação, **80 expirados sem aprovação**, 42 disparados | alertas de compra |
| `nfe_recebimentos` | 5 pendente · 1 falha_efetivacao · 40 efetivado | badge de pendência |
| `promocao_campanha` | 2 rascunho | alerta de rascunho |
| `v_reposicao_sku_sem_fornecedor` | 2 (OBEN) | alerta "não entra em compra" |
| `user_tools` | 4 | telas de ferramenta |
| `fin_ic_matches` · `v_sugestao_negociacao_ativa` · `picking_tasks` · `whatsapp_conversations` | **0** | ver "gatilho" |

**Denominador de gente:** `user_roles` = 5.664 customer · **2 employee · 1 master**;
`commercial_roles` = 3. Toda tela admin (reposição, financeiro, governança, tint) é vista por
**3 pessoas** — o que, como em 2026-08-22, torna o argumento mais forte e não mais fraco: um alerta
perdido é um terço da operação. As telas de cliente têm 5.664 *contas*, e conta não é uso
(`fase-sem-sinal.md` §"O zero da employee B").

## Ordem de correção, por dano medido

1. **`usePrecoCockpit` — `CartItemList.tsx:149,151,158` + `ProductItemForm.tsx:156,163`.** O hook
   lança; some a régua de margem (`markup %`, faixa, "repassar p/", "revisar") e **o preço fica**.
   Denominador **508 pedidos/30d** — a superfície mais viva do sistema. Ausência afirma "margem OK"
   sobre a tela em que o preço é decidido. Money-path literal.
2. **`AdminReposicaoPedidos.tsx:652 + 662`.** `(pedidos ?? []).filter(status==='bloqueado_guardrail')`
   ⇒ falha de leitura apaga `<Alert> N pedidos bloqueados por guardrail. Revise antes do disparo.` e
   `<Alert> N SKUs abaixo do ponto sem fornecedor — não entram em compra`. 80 expirados sem
   aprovação em 30d provam a tela em uso; a ausência afirma "nada bloqueado" **antes do disparo**.
3. **`GovernanceAudit.tsx:447` + `TintDashboard.tsx:128`.** Sub-tipo que MENTE, fontes de 11.869 e
   1.656 linhas. Os dois hooks **engolem o erro** ⇒ a correção começa no `queryFn`, não na UI.
4. **`ConfirmacaoPanel.tsx:185–197`** (badges pendente/aguardando/bloqueado no aceite do ciclo) e
   **`Recebimento.tsx:312`** (badge de pendência por armazém; 5 pendentes + 1 falha).
5. **`AdminReposicaoPromocoes.tsx:165`** (2 rascunhos vivos) e **`FinanceiroMapping.tsx:170`**
   (`= []` no binding; denominador parcial — a fração sem mapeamento vive na edge
   `fin-suggest-mapping` e **não foi medida**).

**Dano hoje ZERO ⇒ chip com gatilho, não correção agora** (mesmo perfil do `carteira_coverage`):
`FinanceiroFechamento:117` + `FinanceiroIntercompany:106` + `FinanceiroIntercompanyFila:129`
(`fin_ic_matches` = 0), `AdminReposicaoOportunidades:330` (0), `AdminEstoquePicking:371,580,659`
(0), `WhatsappInbox:110` (0). Corrigir **antes da primeira linha**, porque depois some calado.

## O que considero LEGÍTIMO, e por quê

Sete padrões cobrem a maioria dos 93. Em nenhum deles a ausência afirma segurança:

1. **Campo opcional de um registro já carregado.** `Profile` (telefone/e-mail/horários), `OrderDetail`
   (previsão, desconto, pagamento), `AdminKnowledgeBaseDetail` (11 `KpiCell` de spec),
   `RendimentoCalculator` (catalisador/diluente/pot life), `AdminStandardProcessDetail`,
   `GrupoCliente360`. O `&&` testa **um campo do objeto**, não a leitura: `data` está presente e o
   campo é nulo. A ausência afirma "não preenchido" — que é verdade.
2. **Sítio protegido por guard superior.** `PedidoProgramadoDetalhe:274` — o `if (isPending || !data)`
   da linha 52 torna o `&&` inalcançável com `data` undefined. Falso positivo do detector, que não
   modela fluxo.
3. **UI de interação local.** `MapearItemDialog` ("Nada encontrado" de uma busca digitada),
   `ConsolidarDemandaDialog`, `SubstituicaoModal`, `ImpersonationBanner`, `GovernancePermissions:197‑199`.
4. **Rodapé de truncamento.** `FollowupsSugeridosCard:95`, `GestorExcecoes:115`,
   `AdminReposicaoPedidos:681`, `ClientesNaoVinculados:121` — some junto com a lista que qualifica.
5. **Gráfico/decoração.** `Intelligence*Tab`, `Gamification`, `Training`, `TarefasTemplates`,
   `MinhasVisitasResultadoCard`, `CustomerProfile360Summary`.
6. **O `&&` que MOSTRA o aviso de falha.** `ClientesNaoVinculados:80` —
   `{erro && <Card>A última atualização falhou…}`. É o padrão certo aparecendo na varredura.
7. **Máquina de estados explícita já no lugar.** `TintPricing:315‑338` —
   `view.status ∈ {carregando, com-preco, sem-preco}`, e "Sem preço" é **fail-closed por desenho**.

## Sobre gatear a forma

**A decisão de 2026-08-22 continua certa**: `jsx-&&` inteiro no gate faria a baseline crescer por
motivo benigno em idioma legítimo, e baseline que cresce por motivo benigno ensina a atualizá-la no
automático. **Nada aqui justifica reverter o filtro de `contarAutoOcultacao`.**

O que a medição sugere é um recorte **menor e diferente**: o sub-tipo que MENTE — default no
binding (`= []`) + condição `length === 0` + texto afirmativo — tem o mesmo dano da forma já
gateada e são 16 sítios, não 93. Isso é um PR próprio, com baseline própria e falsificação; e o
pré-requisito dele é o item 2 acima, porque num hook que engole o erro o gate estaria fiscalizando
a camada errada.
