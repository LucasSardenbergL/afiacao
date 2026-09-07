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
2. ✅ **ENTREGUE (fatia #2, 2026-09-06).** **`AdminReposicaoPedidos.tsx:652 + 662`.** `(pedidos ?? []).filter(status==='bloqueado_guardrail')`
   ⇒ falha de leitura apaga `<Alert> N pedidos bloqueados por guardrail. Revise antes do disparo.` e
   `<Alert> N SKUs abaixo do ponto sem fornecedor — não entram em compra`. 80 expirados sem
   aprovação em 30d provam a tela em uso; a ausência afirma "nada bloqueado" **antes do disparo**.
   Corrigido com `estadoDeLeitura`/`naoConsegui` + `<AvisoLeituraFalhou>`, **âncora de teste
   própria por leitura** (o guard de uma não pode passar verde pelo aviso da outra) e o ramo
   COMPOSTO para cache-com-refetch-falho — apagar pedidos vivos por causa de um refetch seria
   trocar um defeito por outro. O rodapé de truncamento da :681 ficou de fora, como classificado.
   Guard: `src/pages/__tests__/AdminReposicaoPedidos.alertas-erro-honesto.test.tsx` (9 casos, a
   PÁGINA rodando, só o supabase mockado), falsificado com 5 dentes — um por camada, com
   controle verde na MESMA invocação do laço.
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

## O delta da baseline não diz QUAL dos dois aconteceu (achado da fatia #2)

Corrigir o sítio #2 derrubou `contarAutoOcultacao` deste arquivo de **2 para 1** — e o gate
exige registrar o encolhimento. O que a fatia mediu é que **o mesmo delta tem dois motivos
opostos, e o gate não os distingue**:

| recorte | o que o detector vê | é conserto? |
|---|---|---|
| `const q = useQuery(…)` + `q.data` adiante | o sítio SOME: o alias de `data` é casado na desestruturação **da chamada**, e sem ele não há sítio | **não** — a linha de silêncio continua lá |
| `const { data, status, fetchStatus } = useQuery(…)` | `temErro = true` (`status` ∈ `CHAVES_DE_ERRO`) | **sim** — o componente PROVA acesso ao estado de falha |

Os dois imprimem `(2→1)`. O primeiro passou typecheck, lint e os 9 testes do guard novo — o
refactor era plausível e a queda parecia recompensa. **Encolher baseline é uma afirmação
sobre a REALIDADE, e precisa da mesma evidência positiva que qualquer outra**: aqui, o
`temErro` do sítio. Esta é a versão de sensor da regra que já vale para dado
(`docs/historico/evidencia-positiva-shell.md`): ausência de sítio não é sítio corrigido.

Corolário para quem varrer o resto do inventário: a correção desta classe **muda a
desestruturação do hook**, então quase todo sítio corrigido vai encolher a baseline. Cada
encolhimento precisa dizer POR QUE — e "o número caiu" não é o porquê.

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

## Fatia #1 FECHADA — `usePrecoCockpit` (2026-09-06)

Os dois consumidores (`CartItemList`, `ProductItemForm` — e são **exatamente** dois) passaram a
ler o estado da query, não só o `data`: `estadoDeLeitura` + `naoConsegui`/`desatualizado` +
`<AvisoLeituraFalhou>`. O preço continua na tela **com** o aviso — apagar a linha do carrinho
porque o cockpit falhou trocaria um defeito por outro (`estado-de-leitura.ts`, `desatualizado`).

### 1. A guarda que já existia mockava o hook — e o mock era PARCIAL

O briefing mandou conferir `CartItemList.priceGuard.test.tsx` antes de mexer, contra o risco de
"tratamento parcial já existente" tornar o fix inerte. O que ele cobre é **nada** desta classe:
mocka `usePrecoCockpit: () => ({ data: undefined })` — isto é, roda o componente **exatamente no
estado de falha** — e afirma só o `aria-invalid` do preço. O erro nunca foi olhado.

O achado que vale como regra é o **formato do mock**: `{ data: undefined }` não tem `status` nem
`fetchStatus`. Depois do fix, `estadoDeLeitura({status: undefined, fetchStatus: undefined})` não
casa nenhum `if` e cai no `return 'carregando'` — o teste antigo segue verde **por acidente de
ramo**, não por desenho. Um mock de hook precisa ter a forma que o componente LÊ; mock parcial
transforma "o componente escolheu este ramo" em "o objeto não tinha o campo". Completado para
`{ data: undefined, status: 'pending', fetchStatus: 'idle' }` — 'desabilitada', que é o estado
que aquele teste de fato quer (cockpit indiferente ao guard de preço).

### 2. A RPC lança por DESENHO, não só por acidente de transporte

`get_preco_cockpit` é SECURITY DEFINER e tem dois `RAISE EXCEPTION` no corpo (psql-ro, 2026-09-06):

```
RAISE EXCEPTION 'forbidden' USING errcode = '42501'
  IF NOT (auth.uid() IS NOT NULL AND (has_role(auth.uid(),'employee') OR has_role(auth.uid(),'master')))
RAISE EXCEPTION 'too many items (max 200)' USING errcode = '22023'
```

ACL: `authenticated=X`, **`anon` sem EXECUTE**. O caminho alcançável não é exótico — é a **aba de
balcão aberta o dia inteiro**: token expira, `auth.uid()` vira null, a RPC responde 42501, e a
régua de margem some de um carrinho que continua editável e submetível. A tela do erro era
byte-a-byte a tela da margem saudável em faixa `neutro`.

### 3. O caminho dos 200 itens NÃO é alcançável — e o zero fica registrado

Antes de usar "carrinho grande derruba a régua" como argumento, medi. `sales_orders` grava os
itens em coluna `items` jsonb (confirmado pelo ESCRITOR, `submitOrder.ts:216`, não pelo nome):

| pedidos | máx itens | p99 | acima de 200 |
|---|---|---|---|
| 31.248 | **28** | 9,0 | **0** |

O limite de 200 nunca foi tocado em 31 mil pedidos. Registrar o zero é o que impede o próximo a
inflar o argumento — mesma disciplina que separou `orders` (0 linhas) de `sales_orders` (508/30d)
na medição original, só que agora contra um erro **meu**, plausível e verificável em duas queries.
