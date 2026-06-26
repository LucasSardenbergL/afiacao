# Money-path — princípios inegociáveis

> Tudo que mexe com dinheiro (financeiro, reposição/compras, pedido a fornecedor, preço, estoque, positivação/comissão), autorização (RLS/gate) ou automação (sync) segue isto. Detalhe por domínio em `docs/agent/{financeiro,reposicao}.md`.

## Os princípios

1. **Precisão > recall.** Na ambiguidade, NÃO agir / NÃO mostrar — melhor uma ficha a menos que uma errada. Ex.: matching boletim↔SKU só com confirmação humana; a venda mostra ficha só pela view confirmada+aprovada, zero fuzzy em runtime. Vale no **review** também: finding sem prova (trigger+linha+efeito) rebaixa, não bloqueia — barra em `docs/agent/review.md`.
2. **Degradação honesta — ausente ≠ zero.** `Number(null)` é `0`; `cmc` ausente vira `null`, não R$0; NCG/hurdle/capital ausente → `null` + confiança baixa, **nunca** um número fabricado. O usuário vê "—" ou "falta dado", jamais uma recomendação inventada. (Frente inteira de consolidação financeira foi sobre isto: NCG/A2, hurdle/A3, caixa do snapshot.)
3. **Nunca fabricar número no money-path.** LLM não inventa SKU/preço (pricing determinístico do Omie). A IA conversa/sugere; o número firme passa por gate determinístico/humano. Prosa do LLM é descartável; a evidência é o produto.
4. **Gate humano na escrita.** O founder no loop pra escrita money-path (migration via SQL Editor; aprovação de compra). Exceção atual: a auto-aprovação Sayerlack (N3, piloto medido por taxa de veto — ver `docs/agent/reposicao.md`).
5. **Guard na fronteira que TODA via cruza, não só na UI.** A invariante (ex.: preço de produto > 0 e finito — `!(Number.isFinite(p) && p>0)` pega 0/negativo/NaN/Infinity; `ProductCartItem.unit_price` vira 0 silencioso com `parseFloat('')||0`) mora no service/edge; botão desabilitado + destaque na UI é defense-in-depth, não a proteção. **Enumere TODAS as vias até o efeito antes de gatear:** o pedido tem ≥4 caminhos até o Omie — submit do unified-order (`submitOrder`/`submitQuote`, guardados via `orderSubmission/priceGuard.ts`), **conversão de orçamento** (`SalesQuotes.convertToOrder` chama o edge direto), **edição** (`useSalesOrderEdit`) e retry idempotente. O edge `omie-vendas-sync` (`criar_pedido`/`alterar_pedido`) é a fronteira final comum e hoje NÃO valida `valor_unitario` — guardar só uma via deixa as outras abertas (achado Codex 2026-06-16).

## Provar antes de aplicar

- **Função/RPC/trigger/policy money-path → `prove-sql-money-path`** (PG17 local com falsificação) ANTES de entregar a migration. plpgsql é late-bound: `CREATE` passa com SQL inválido, só falha ao EXECUTAR. O teste aplica a migração REAL, semeia, faz asserts positivos E negativos (SQLSTATE + re-raise), prova RLS (`SET ROLE` + GUC), e **se sabota de propósito pra provar que os asserts têm dente**.
- **Assert negativo** captura a `SQLSTATE`/condição ESPERADA e re-lança o resto. `WHEN OTHERS THEN 'OK'` é teatro (engole o erro real). Sentinela do teste nunca contém o texto que o código emite (anti-teatro de ILIKE).
- **Harness PG17:** `pg_temp.*` (tabela/função temporária) é **por-sessão psql** → helper e cenários têm de rodar no **mesmo bloco psql** do harness; em blocos separados o cenário não enxerga o helper temp criado antes.
- **Engine nova que emite número de decisão → escreva o threat-model** (`docs/agent/threat-model-template.md`): o que prova / não prova / default fail-closed, com **um assert pra cada default declarado** (doc×código não podem divergir — achado aura: THREAT_MODEL diz reject, código faz DEFAULT_ALLOW).

## Segunda opinião adversária (Codex)

- Rodar Codex em cada etapa de trabalho money-path: **metodologia → spec → plano → adversarial no código**. `/codex` (consult/challenge). Modelo `gpt-5.5`, reasoning `high` (consult rotineiro) ou `xhigh` explícito (adversarial money-path).
- ⚠️ A cota do Codex (ChatGPT Plus) é **janela rolante de 7 dias e ESGOTA**. Fallback = **"Caminho B"**: validação adversária própria (PG17 falsificável + auto-challenge), gravando **`REVISÃO INDEPENDENTE PENDENTE`** — auto-revisão NÃO substitui revisão independente, só cobre o intervalo. Rodar o Codex retroativo quando a cota voltar.
- ⚠️ **NÃO deixe o Codex varrer `supabase/schema-snapshot.sql` (~36k linhas) — estoura o contexto e TRAVA** (hang silencioso: processo vivo, stderr congelado no dump, `output` vazio, sem `turn.completed`; gasta a janela inteira sem responder). No prompt do `/codex`: coloque os fatos de schema (índices/constraints conferidos via `psql-ro`) no PRÓPRIO texto e instrua a NÃO abrir o snapshot — aponte só os arquivos pequenos relevantes. (Mordido 2026-06-25: `challenge` travou lendo o dump → fechado pelo Caminho B + convergência de outra sessão.)

## Helper espelhado

Helper TS puro (testado com vitest) **espelhado verbatim** no edge (Deno não importa de `src/`) e/ou em SQL. Para lógica replicada, **provar paridade** (harness diferencial TS×SQL, ex.: `db/test-city-norm-paridade.sh`) — não institucionalizar "copiar verbatim" como fim.

## Diagnóstico

"Diagnosticado ≠ corrigido" — ver `diagnose-supabase-sync` (estados rígidos de saída; só declara RECUPERADO com novo ciclo + efeito no dado; a ação corretiva é entregue ao humano, nunca aplicada às cegas).
