# Raio-X do estoque parado — pacote 2: preço piso/canal · custo de esperar · responsável/prazo

> Aprovado pelo founder (Lucas) em 2026-10-31, em chat. Origem: revisão Codex + Fable de 2026-10-30, "pacote 2"
> (o pacote 1 entrou no #3442). Spec da fase B: `2026-10-15-raio-x-estoque-parado-fase-b-design.md`.

## Por quê

A meta de 25/11 é **100% do Top 61 decidido e ≥ R$ 60k liberados**. Hoje a decisão para no "o quê" (destino): não diz
**por quanto** (liquidar sem piso vira desconto sem limite), **quem executa e até quando** (decisão sem dono não sai do
estoque) e **quanto custa esperar** (sem urgência em R$, o item parado não compete com o dia a dia).

## Escopo (uma entrega)

1. **Preço piso e canal** no destino `liquidar`.
2. **Custo de esperar** por item e no placar.
3. **Responsável, prazo e "executado"** por decisão, com vencidas visíveis na lista e no placar.

### Não-objetivos

Provisão contábil/obsolescência automática · aprovação multinível · push/lembrete · Croston/TSB · marketplace ·
mudar o critério da meta de R$ 60k (estoque reduzido a custo + crédito de troca informado) · tocar `raio_x_decidir`
ou `raio_x_medicao`.

### Anti-objetivos (falha mesmo "funcionando")

- Custo de esperar exibindo **R$ 0** para item sem CMC ou empresa sem taxa (ausente ≠ zero).
- "Executado" somando na meta: a meta continua vindo **só da medição** (saldo da foto × venda por NF).
- Piso comparado contra preço em unidade diferente (R$/caixa × R$/unidade).

## Desenho

### Banco (migration nova, `[migration manual]`)

`ALTER TABLE public.raio_x_decisao ADD COLUMN IF NOT EXISTS`:

| coluna | tipo | regra |
|---|---|---|
| `preco_piso` | numeric | ≥ 0, ≠ NaN (CHECK). R$ por **unidade de venda**. |
| `canal_liquidacao` | text | CHECK ∈ `cliente_especifico`, `promocao_carteira`, `outlet_queima`, `outro` |
| `responsavel` | uuid | quem executa (equipe: `employee`/`master`) |
| `prazo` | date | até quando |
| `concluido_em` | timestamptz | "executado" (marca de tarefa, não de dinheiro) |
| `concluido_por` | uuid | quem marcou |

`raio_x_decidir`, `raio_x_contar` devolvem `public.raio_x_decisao` via `%ROWTYPE` + `SELECT *`/`RETURNING r.*`
(conferido na prod): ganham as colunas sem recriar. **Provar executando** (PL/pgSQL é late-bound). Nenhuma view
depende da tabela (conferido em `pg_depend`). O upsert de `raio_x_decidir` só escreve as colunas que nomeia → não
apaga o plano.

**RPC nova `raio_x_planejar(p_empresa text, p_sku bigint, p_preco_piso numeric, p_canal text, p_responsavel uuid,
p_prazo date, p_concluido boolean) RETURNS public.raio_x_decisao`** — SECURITY DEFINER, `search_path = public`,
escritor único do plano. Estado completo (como `raio_x_decidir`, Ruling S2: campo omitido = limpo).

- gate `private.cap_custo_ler(auth.uid())` → 42501;
- empresa ∉ {oben, colacor} → 22023; `p_sku`/`p_concluido` nulos → 22023;
- linha travada `FOR UPDATE`; **sem linha ou `destino IS NULL` → `RX002`** (não há o que planejar);
- `p_preco_piso`/`p_canal` não nulos com destino ≠ `liquidar` → 22023;
- piso < 0 ou NaN → 22023; canal fora da lista → 22023;
- responsável não nulo e sem papel `employee`/`master` → 22023;
- `p_concluido = true`: grava `concluido_em = now()`, `concluido_por = auth.uid()` **só se ainda nulo** (re-salvar
  não move a data); `false` limpa os dois;
- `atualizado_em = now()` (o Sheet aberto por outro operador fica "velho" — Ruling S9).
- REVOKE de `PUBLIC, anon` nomeados; GRANT a `authenticated`; postcondição embutida (SECURITY DEFINER, anon sem
  EXECUTE, colunas presentes) que aborta o apply.
- Função NOVA → sem TRAVA/PRE de corpo vivo; registra nos dois manifestos de authz.

**Re-decidir mudando o destino não zera o plano no banco** (não tocamos `raio_x_decidir`). Regra de leitura (TS):
`concluido_em < decidido_em` ⇒ não concluído (o destino mudou depois); piso/canal só valem com destino `liquidar`.

### Lógica pura (TS) — `src/lib/reposicao/raio-x/execucao.ts`

- `DESTINOS_EXECUTAVEIS = trocar, venda_dirigida, liquidar, erro_cadastro` (manter/estratégico não têm execução).
- `custoEsperarMensal(valor, taxaAnual)`: `valor × taxa / 12`; `null` se qualquer um for nulo/não-finito/≤ 0.
- `situacaoPlano(decisao, hoje)`: `null` (sem decisão ou destino não executável) · `concluido` · `sem_responsavel` ·
  `vencido` (+ dias) · `no_prazo` · `sem_prazo`. Concluído só se `concluido_em ≥ decidido_em`.
- `alertaPiso(linhaMedicao, decisao, unidadesVenda)`: só com destino `liquidar`, piso não nulo, `qtd_vendida > 0`,
  `receita` não nula **e exatamente uma unidade de venda**; senão `null` ("sem comparação"). Devolve preço do período,
  piso e `abaixo`.
- `resumoExecucao(itens, decisoes, hoje)`: vencidas N · sem responsável N · concluídas N (no universo executável).

### Tela

- **Sheet de decisão:** seção **"Execução"** só para decisão **gravada** com destino executável: responsável (lista da
  equipe — `user_roles` employee/master + `profiles`), prazo (padrão hoje + 14 dias), botão-estado "executado"; para
  `liquidar`, piso (R$ por unidade de venda, mostrando unidade, CMC e preço médio 12m como referência) e canal.
  Botão próprio **"Salvar execução"** → `raio_x_planejar`. Mesma guarda de rascunho velho (S9). Decisão nova
  primeiro grava o destino; o plano vem depois (sem gravação dupla não-atômica).
- **Linha da mercadoria:** "custa ~R$ X/mês parado" (sem custo/taxa: "—"); badge de situação (vencido há N dias /
  sem responsável / executado); selo "sem piso" em liquidar sem piso.
- **Placar:** "pendente custa ~R$ Y/mês" (mercadoria parada sem decisão × taxa / 12; sem taxa: não exibe número) e
  "N vencidas · M sem responsável".
- **Filtro** (URL, `useUrlState`): `rxExec` ∈ vencidas / sem responsável / minhas.
- **Medição (Caixa liberado):** lista "vendeu abaixo do piso" (SKU, preço do período, piso), ao lado das contradições.

Taxa: `fin_regua_custo_capital(p_empresa)` (já existe; Selic + spread de `empresa_configuracao_custos`; OBEN 17,75%
a.a.; COLACOR sem configuração → `null`). Falha de leitura → `null` (sem número), nunca 0.

### Sensor (fase N+1 exige sinal)

A própria tabela: `count(*) FILTER (WHERE responsavel IS NOT NULL)`, `... concluido_em IS NOT NULL`,
`... concluido_em::date <= prazo` — query registrada no diário. Sem evento novo.

## Prova

- PG17 `db/test-raio-x-planejar.sh`: aplica 16/10 + 31/10 + a nova; controle verde nos dois locales; `raio_x_decidir`
  e `raio_x_contar` executando após o ALTER (late-bound); cada regra acima com SQLSTATE exata; sabotagem uma camada
  por vez (gate, RX002, piso fora de liquidar, NaN, canal, responsável, concluído preserva data, REVOKE anon →
  postcondição).
- Vitest: `execucao.ts` (custo, situação, piso, resumo) + Sheet/placar.
- Ritual Codex (money-path) antes do PR.

## Deploy

Migration pelo envelope (`db:aplicar --ensaio` → real, 2ª testemunha psql-ro) após o merge, com autorização do
founder · Publish (founder) com conferência por bytes · recarregar o app do comprador.
