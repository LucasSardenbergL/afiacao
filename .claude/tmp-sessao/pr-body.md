Re-derivação do núcleo do #1326 contra a `main` de hoje. O #1326 **não foi rebaseado** — estava 638
commits atrás (merge-base de 2026-07-11), `CONFLICTING`, e 13 dos 16 arquivos foram reescritos por baixo
desde a base (`omie-analytics-sync`: +77/−29 no PR vs **+701/−721** na main; `omie-vendas-sync`: +133/−97
vs **+536/−216**). Fecho o #1326 como superado por este.

## O achado (A2) — vínculo por ausência de contraindicação

Em `omie-vendas-sync`, o `clientCache` (código Omie → `user_id`, que decide o **dono do pedido** e
portanto a comissão) vinha da view `omie_customer_account_map_fresco`. Ela atesta *"existe vínculo com
menos de 7 dias"* — **nunca qual documento o provou**. Sem isso, *"não há contraindicação"* era
indistinguível de *"há prova"*: um vínculo `C→u1` casado com o doc X sobrevive depois de u1 migrar para Y
e u2 receber X.

## Duas metades: provar **e** revogar

A primeira versão deste PR só tinha a prova positiva. O challenge do Codex (xhigh) reprovou, e com razão:

> "A SQL só emite o código quando `d.user_id = m.user_id`. Portanto, em estado estável, a prova sempre
> concorda com a mesma linha que alimenta a view. […] essa propriedade produz **omissão, não revogação**,
> e portanto não corrige o cache."

Omitir não corrige nada — o código continua no cache. Então a RPC devolve **duas** metades:

- **`client_to_user`** — prova positiva: `account = p_account` ∧ `source='document'` ∧ evidência
  **presente**, **única** (∈ `doc_to_user`) e **consistente** (o dono atual do doc é o **mesmo** user do
  vínculo) ∧ TTL 7d.
- **`revoked_client_codes`** — códigos cuja evidência **existe mas não sustenta mais** o vínculo. O leitor
  os **remove** do cache antes de calcular `unknownCodes`, e eles são refeitos pelo `ConsultarCliente`,
  que resolve pelo doc **atual** do Omie.

`evidence IS NULL` fica fora das duas: é o *"sem prova, nunca houve"* das linhas antigas, que degrada para
o status quo em vez de jogar 10.822 códigos no fallback da API.

**A revogação deliberadamente NÃO filtra `source`.** Eu tinha argumentado que o TTL de 7d expiraria o
vínculo podre sozinho. Está errado, e conferi em prod: `register_carteira_member` faz
`ON CONFLICT … source = CASE WHEN source='manual' THEN 'manual' ELSE 'rpc' END, updated_at = now()`
**sem tocar a evidência** — a linha errada renova o frescor para sempre. Filtrar por `source='document'`
deixaria escapar exatamente essa linha. Provado por execução: assert **V7** + falsificação **F9**.

## Uma correção só no `resolveClientUserId` seria inerte

O dono do pedido é lido **direto** de `clientCache.get(codigoCliente)`, e `resolveClientUserId` só roda
para códigos **fora** do cache (`unknownCodes`) — ou seja, nunca para o vínculo obsoleto do achado, que
**mora no cache**. Por isso a sobreposição e a revogação vivem na **construção** do cache
(`aplicarProvaPositivaNoCache`, helper puro espelhado), que é a fronteira que toda via cruza.

## LGPD — a coluna podia vazar o CPF de terceiro

Medido em prod: a proof-table tem `anon=arwdDxtm` / `authenticated=arwdDxtm` e a policy
`Users can view their own account map` (`auth.uid() = user_id`) — um cliente logado lê a própria linha. No
cenário A2 a linha ainda é de u1 enquanto `evidence_document_normalized` já é o documento de **u2**.

Fechado por **grant de coluna**, não revogando a tabela: a view `_fresco` é `security_invoker=on` e é lida
pelo frontend (customer360, `useUnifiedOrder`), então o leitor precisa manter SELECT nas 8 colunas que ela
projeta. Asserts **L1–L4** + falsificação **F11**.

## ⚠️ NASCE INERTE — a propriedade, não um efeito colateral

`omie_customer_account_map` tem **16.118 linhas** (`document`=16.097, `rpc`=21); nas duas contas que o
`omie-vendas-sync` opera são **10.822 vínculos frescos** (`oben` 5.621 + `colacor` 5.201). **Todos nascem
com evidência NULL** — o backfill é justamente *não* backfillar. Logo as duas chaves voltam vazias e o
helper é no-op: comportamento idêntico ao de hoje. A cobertura sobe a cada ciclo do `syncCustomers`.

**Meça, não presuma.** Sensores embutidos:
- log do run: `Prova positiva: N com evidência viva sobre M do cache (X% de cobertura); D divergiram e
  foram corrigidos; R REVOGADOS do cache` — `D` e `R` são o achado se manifestando em produção;
- canário `?canary=1` → `clientes_provados` e `codigos_revogados` (read-only, não escreve, não chama o Omie).

**Baseline pré-apply:** `oben` 5.621 · `colacor` 5.201 vínculos frescos, **0 com evidência**.

### Fora de escopo, declarado (vira PR-3)

Dois achados do Codex que não fecho aqui: (a) o writer não consegue **transferir** um código para o novo
dono — o insert bate na `UNIQUE(omie_codigo_cliente, account)` e dá 23505; a reconciliação precisa de uma
RPC transacional; (b) a RPC e a view são lidas em **instantes diferentes**, então cache/prova/revogação
não vêm de um snapshot conjunto. Nenhum dos dois torna esta entrega pior que o status quo — a revogação já
força o caminho fail-closed —, mas os dois limitam quanto ela se auto-cura.

## Gates

| Gate | Resultado |
|---|---|
| `prove-sql-money-path` (PG17, `db/test-omie-identidade-a2-client-to-user.sh`) | **74 asserts, 0 falhas** |
| ↳ falsificação, cada defesa **sozinha** | **12 mutantes**, todos deixam o assert correspondente vermelho |
| `bun run test` | verde · falsificação dos gates textuais: 6 sabotagens → todas vermelhas |
| `test:edges` (Deno `--no-remote`) · `edges:typecheck` · `typecheck` · `lint` · `bunx knip` | verdes |
| `/codex challenge` xhigh (`gpt-5.6-sol`), 2 rodadas | rodada 1 reprovou; 3 dos 4 P1 corrigidos, 2 declarados como PR-3 |

Cada defesa é sabotada **sozinha**, por `sed` cirúrgico sobre a migration real, com guard `cmp` contra
sabotagem no-op. Dois mutantes valem menção: **F1b** mostra o achado em carne e osso (removida a
consistência, o código `105` volta a apontar para o dono obsoleto); e **F12** flagrou um assert meu que
estava verde pelo motivo errado — o seed stale tinha evidência viva, então o TTL nunca era o que o excluía.

## ⚠️ ATENÇÃO: migration manual necessária — e **migration ANTES da edge**

`supabase/migrations/20260821192817_omie_identidade_a2_client_to_user.sql` — **Lovable não aplica
automaticamente**; mergear **não** toca o banco.

A ordem **não** é livre (correção de uma afirmação errada da 1ª versão deste PR):

| Banco | Edge | Resultado |
|---|---|---|
| novo | antigo | degrada — a evidência fica NULL |
| PR-1 | `omie-vendas-sync` novo | degrada — a RPC do PR-1 já devolve `client_to_user: {}` |
| PR-1 | `omie-analytics-sync` novo | **quebra**: escreve numa coluna inexistente, depois de deletes e writes no ledger já commitados |

1. 🟣 **SQL Editor** — colar a migration (idempotente; já inclui `NOTIFY pgrst`).
2. 💬 **chat do Lovable** — só então o deploy de `omie-analytics-sync` e `omie-vendas-sync`, verbatim da main.
3. Validar: `?canary=1` verde e `clientes_provados` saindo de 0 após um ciclo do sync de clientes.
