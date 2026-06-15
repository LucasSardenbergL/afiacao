# Money-path — princípios inegociáveis

> Tudo que mexe com dinheiro (financeiro, reposição/compras, pedido a fornecedor, preço, estoque, positivação/comissão), autorização (RLS/gate) ou automação (sync) segue isto. Detalhe por domínio em `docs/agent/{financeiro,reposicao}.md`.

## Os princípios

1. **Precisão > recall.** Na ambiguidade, NÃO agir / NÃO mostrar — melhor uma ficha a menos que uma errada. Ex.: matching boletim↔SKU só com confirmação humana; a venda mostra ficha só pela view confirmada+aprovada, zero fuzzy em runtime.
2. **Degradação honesta — ausente ≠ zero.** `Number(null)` é `0`; `cmc` ausente vira `null`, não R$0; NCG/hurdle/capital ausente → `null` + confiança baixa, **nunca** um número fabricado. O usuário vê "—" ou "falta dado", jamais uma recomendação inventada. (Frente inteira de consolidação financeira foi sobre isto: NCG/A2, hurdle/A3, caixa do snapshot.)
3. **Nunca fabricar número no money-path.** LLM não inventa SKU/preço (pricing determinístico do Omie). A IA conversa/sugere; o número firme passa por gate determinístico/humano. Prosa do LLM é descartável; a evidência é o produto.
4. **Gate humano na escrita.** O founder no loop pra escrita money-path (migration via SQL Editor; aprovação de compra). Exceção atual: a auto-aprovação Sayerlack (N3, piloto medido por taxa de veto — ver `docs/agent/reposicao.md`).

## Provar antes de aplicar

- **Função/RPC/trigger/policy money-path → `prove-sql-money-path`** (PG17 local com falsificação) ANTES de entregar a migration. plpgsql é late-bound: `CREATE` passa com SQL inválido, só falha ao EXECUTAR. O teste aplica a migração REAL, semeia, faz asserts positivos E negativos (SQLSTATE + re-raise), prova RLS (`SET ROLE` + GUC), e **se sabota de propósito pra provar que os asserts têm dente**.
- **Assert negativo** captura a `SQLSTATE`/condição ESPERADA e re-lança o resto. `WHEN OTHERS THEN 'OK'` é teatro (engole o erro real). Sentinela do teste nunca contém o texto que o código emite (anti-teatro de ILIKE).

## Segunda opinião adversária (Codex)

- Rodar Codex em cada etapa de trabalho money-path: **metodologia → spec → plano → adversarial no código**. `/codex` (consult/challenge). Modelo `gpt-5.5`, reasoning `high` (consult rotineiro) ou `xhigh` explícito (adversarial money-path).
- ⚠️ A cota do Codex (ChatGPT Plus) é **janela rolante de 7 dias e ESGOTA**. Fallback = **"Caminho B"**: validação adversária própria (PG17 falsificável + auto-challenge), gravando **`REVISÃO INDEPENDENTE PENDENTE`** — auto-revisão NÃO substitui revisão independente, só cobre o intervalo. Rodar o Codex retroativo quando a cota voltar.

## Helper espelhado

Helper TS puro (testado com vitest) **espelhado verbatim** no edge (Deno não importa de `src/`) e/ou em SQL. Para lógica replicada, **provar paridade** (harness diferencial TS×SQL, ex.: `db/test-city-norm-paridade.sh`) — não institucionalizar "copiar verbatim" como fim.

## Diagnóstico

"Diagnosticado ≠ corrigido" — ver `diagnose-supabase-sync` (estados rígidos de saída; só declara RECUPERADO com novo ciclo + efeito no dado; a ação corretiva é entregue ao humano, nunca aplicada às cegas).
