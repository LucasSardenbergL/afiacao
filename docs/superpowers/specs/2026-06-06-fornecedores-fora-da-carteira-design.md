# Fornecedores fora da carteira — Fase 1 (limpar a fila de visita/ligação)

> Spec de design **v2** (tag-based, pós-Codex). Data: 2026-06-06. Origem: brainstorming a partir do card "Visitas sugeridas" (`/meu-dia`), que sugeria **visitar fornecedores** e mostrava "Cliente sem nome".
>
> **v1 → v2:** a v1 assumia um sync de `ListarFornecedores` + flag por empresa. O passe adversário do Codex (gpt-5.5) derrubou as duas premissas. v2 usa **tag do cadastro** (o sinal real do Omie) + identidade por **CNPJ/usuário** + os 9 P1 resolvidos. O histórico está em §11.

---

## 1. Problema

No Omie **um cadastro pode ser cliente E fornecedor (mesmo registro)**. Quando há **NF de devolução** para um fornecedor, o Omie **marca o cadastro também como cliente**. Consequência:

- Fornecedores e transportadoras (ex.: **JAMEF**) entram como clientes, caem na **carteira**, ganham `visit_score` (missão **Prospecção 70**, porque `sales_orders_count = 0` — [missions.ts:65](../../../src/lib/visit-scoring/missions.ts)) e aparecem como **"Cliente sem nome"** (profile sem `razao_social` — [useMyVisitSuggestions.ts:129](../../../src/hooks/useMyVisitSuggestions.ts)).
- Poluem **Sugestões de visita**, **Lista de ligação**, **positivação MTD** e KPIs.
- **Hipótese forte:** **Caxias do Sul (RS)** aparece por concentrar **fornecedores** (polo do RS), não clientes da Oben (MG). "Tirar fornecedor" ≈ "tirar Caxias".

## 2. Decisões do founder (fixas)

1. **Sinal** = **tag do cadastro do Omie** ∈ `{Fornecedor, Transportadora}` *(confirmado pelo founder; lista extensível — ver §9)*. O Omie é cadastro unificado (`geral/clientes`), e o app **já lê** `c.tags` na busca; só não persiste.
2. **Critério** = **curadoria humana**. O assistente gera a lista de quem tem a tag **E** está na carteira; o founder marca as **exceções** (fornecedor que é cliente real). O resto sai. *(Critério automático de recorrência rejeitado — mas a curadoria é informada: §4.8.)*
3. **Profundidade** = não entra na carteira de **nenhum** vendedor (raiz). Cascateia para visita → ligação → positivação → KPIs.
4. **Aplicação** = **reversível**, respeitada por todos. Não deletar o cadastro; remover a exceção reverte.

## 3. Estado atual (como a carteira nasce)

```
omie_clientes ─(carteira-rebuild, cron)─▶ carteira_assignments(eligible) ─seed─▶ farmer_client_scores ─▶ customer_visit_scores
                                                  │                                                              │            │
                                       (get_minha_positivacao)                              (useMyVisitSuggestions)   (useRouteContactList)
```

- **`carteira-rebuild`**: enumera `omie_clientes`, resolve dono por `omie_codigo_vendedor × omie_vendedor_map` senão `hunter_orphan`; **UPSERT** por `customer_user_id`. **Nunca DELETA**; tem coluna **`eligible`** (default true).
- **`get_minha_positivacao`** (RPC, [migration 20260525120000](../../../supabase/migrations/20260525120000_positivacao_kpis.sql)): elegíveis vêm **100% de `carteira_assignments.eligible = true`** — *não* de scores/omie_clientes. ✅ Por isso o corte usa **`eligible = false`** (já respeitado, reversível), não DELETE.
- **Escritores de score** (precisam respeitar o corte): `calculate-scores` (seed de `farmer_client_scores`, só se a tabela estiver vazia), `scoring-recalc-client` + `scoring-recalc-batch` (upsert em `farmer_client_scores`, **fallback no ator** quando não há assignment), `visit-score-recalc-batch` (resolve dono via carteira) + `visit-score-recalc-client` (drain da fila `visit_score_recalc_pending`).
- **`useFarmerScoring`** ([hook](../../../src/hooks/useFarmerScoring.ts)): calcula de **todos os `sales_orders`** (sem carteira) e **persiste** `farmer_client_scores` (upsert, quando `!isImpersonating`). Ressuscita fornecedor se não filtrar o **universo**.
- **`omie_clientes` é mal-modelado** (Codex P1): o sync faz `upsert` por `user_id`, **não grava `empresa_omie`** (default `colacor`), PK só em `id`. → **a identidade do nosso corte é por `user_id`/CNPJ**, não por `(empresa, código)`.

## 4. Desenho v2

### 4.1 Onde guardar (schema novo — migration manual)

- **`cliente_classificacao`** — fonte da verdade reversível, **por `user_id`**.
  - `user_id uuid PK`, `tags_omie text[]`, `is_fornecedor boolean`, `excluir_da_carteira boolean DEFAULT false`, `tem_venda_real boolean`, `fonte text`, `updated_at timestamptz`.
  - RLS: SELECT staff; **escrita só `service_role`/RPC curada** (resolve o P1 de segurança — employee não mexe na flag).
- **`fornecedor_excecao`** — exceções curadas: `user_id PK`, `motivo`, `criado_por`, `criado_em`. RLS: escrita master, leitura staff.
- **`cliente_tags_staging`** — staging do sync: `(run_id, user_id, cnpj, tags_omie)`. Promoção atômica só quando o run completa (P1 idempotência).

*Por que tabela nova e não coluna em `omie_clientes`:* `omie_clientes` é mal-modelado (§3) e tem RLS aberta a employee. Uma tabela por `user_id` dá identidade limpa + RLS própria.

### 4.2 Sync das tags (edge)

- Reusar a enumeração que **já existe** no `syncNaoVinculados` (`omie-analytics-sync`) — ela já varre `ListarClientes` de **todas as contas**; adicionar a captura de `c.tags`. (Alternativa: edge dedicada `omie-tags-sync`. Decidir no plano; preferência por reusar a varredura.)
- Background + retry/backoff (o `callOmie*` já trata "SOAP broken response") + paginação **data-driven** (até página vazia; não confiar em `total_de_paginas`; `registros_por_pagina` capa em 100).
- Grava em `cliente_tags_staging(run_id, ...)`; **promoção atômica** para `cliente_classificacao` (`tags_omie`/`is_fornecedor`) só quando o run completa. Identidade `user_id` resolvida por CNPJ (`profiles.document`).
- Cron leve diário.

### 4.3 Classificação (RPC idempotente + recorrente)

`classificar_clientes_fornecedores()` (SECURITY DEFINER; service_role/master):

```
is_fornecedor        = tags_omie && ARRAY['Fornecedor','Transportadora']   -- overlap
tem_venda_real       = EXISTS sales_orders válido (não-cancelado, não-devolução)
excluir_da_carteira  = is_fornecedor AND NOT EXISTS (fornecedor_excecao por user_id)
```

- **Recorrência (P1):** roda **após cada promoção de sync** e por **trigger** no insert/update de vínculo (NF de devolução futura cria cadastro novo → re-classifica). Não é one-time.
- `tem_venda_real` é **informativo** (alimenta o diagnóstico/curadoria, §4.8) — **não** altera a exclusão automaticamente (respeita a decisão do founder; é a rede de segurança contra excluir cliente real).

### 4.4 Filtro nos escritores (lista COMPLETA — Codex)

| Escritor | Parte da carteira? | Ação |
|---|---|---|
| `carteira-rebuild` | — | `eligible = NOT excluir_da_carteira` (não some da tabela; só vira inelegível). |
| `calculate-scores` (seed) | sim | Enumera só `eligible`. |
| `visit-score-recalc-batch` | sim | Pula quem não tem assignment elegível (evita fallback no ator). |
| `scoring-recalc-batch`/`-client` | **não** (fallback ator) | **Filtro explícito** por `excluir_da_carteira` antes do upsert. |
| `visit-score-recalc-client` (drain) | **não** | **Filtro explícito** — um único contato não ressuscita. |
| `useFarmerScoring` (front) | **não** | Filtrar o **universo** (`sales_orders`) **antes** do cálculo, não só o upsert. |

- **`customer_metrics_mv`**: sem ação (enriquecimento, não universo da fila).

### 4.5 Cleanup (reversível, por `user_id`)

- **`carteira_assignments.eligible = false`** para os flaggeds → a **positivação some** (ela filtra `eligible`) e é **reversível** (a coluna já existe). Não DELETE em `carteira_assignments`.
- **DELETE** em `customer_visit_scores` e `farmer_client_scores` dos flaggeds (derivadas reconstruíveis) → some da visita/ligação.
- Identidade **por `user_id`** (não empresa). O `carteira-rebuild` aplica o `eligible` a cada execução (não só na 1ª vez).

### 4.6 Reversão com backfill (P1)

Remover a exceção **não basta** — `calculate-scores` só faz seed com a tabela vazia, e sem atividade `customer_visit_scores` não nasce. A transição `excluir → manter` precisa, explicitamente: re-classificar → `carteira-rebuild` (volta `eligible=true`) → **enfileirar** `visit_score_recalc_pending` + **forçar seed** de `farmer_client_scores` para aquele `user_id`. Encapsular numa RPC `reverter_exclusao_fornecedor(user_id)`.

### 4.7 Diagnóstico + curadoria informada

Query (SQL Editor): candidatos = `user` com tag ∈ {Fornecedor, Transportadora} **E** na carteira, com **nome, cidade/UF, vendedor dono, nº de vendas reais, última compra, receita 12m**. Ordena prováveis-fornecedor-puro (zero venda) primeiro; **quem tem venda recente vem pré-marcado "revise antes de excluir"**. Confirma com número a hipótese "Caxias = fornecedores".

## 5. Fluxo

```
ListarClientes (tags, 3 contas) ─▶ cliente_tags_staging ─(promote)─▶ cliente_classificacao
                                          fornecedor_excecao (curadoria) ─┘
                                                       │ classificar_clientes_fornecedores()
                                                       ▼
              carteira_assignments.eligible=false + DELETE scores  ─▶  visita/ligação/positivação limpas
              (escritores que não partem da carteira filtram a flag)
```

## 6. Ordem de rollout (corrigida — filtros ANTES da flag)

1. **Migrations** (SQL Editor): `cliente_classificacao` + `fornecedor_excecao` + `cliente_tags_staging` + `classificar_clientes_fornecedores()` + `reverter_exclusao_fornecedor()`. Flags nascem todas `false` (no-op).
2. **Deploy dos consumidores COM o filtro** (carteira-rebuild, calculate-scores, scoring-recalc-*, visit-score-recalc-*) — **primeiro**, enquanto tudo é `false` (zero efeito).
3. **Deploy + rodar** o sync de tags → popula `cliente_classificacao` (`is_fornecedor`).
4. **Diagnóstico** (query) → founder revisa → insere exceções.
5. **Classificar + cleanup** juntos, sob lock (seta `excluir_da_carteira`, `eligible=false`, DELETE scores).
6. **Verificação** (antes/depois; Caxias; reversão de um caso).
7. **(Front)** `useFarmerScoring` + Publish.

## 7. Não-objetivos (v1)

- Critério automático de exclusão por recorrência (rejeitado).
- Tela de gestão de exceções (curadoria via lista/SQL por ora).
- "Cliente sem nome" que **não** é fornecedor (cadastro incompleto) — qualidade de dado, follow-up.
- Curadoria de cidade (consequência; retoque à parte se sobrar).
- `omie_clientes_nao_vinculados` (Codex P2 — fornecedor sem profile ainda polui essa tela de gestão; follow-up).
- Reescrever a modelagem de `omie_clientes` (mal-modelado, mas fora do escopo — contornado pela identidade por `user_id`).

## 8. Segurança / RLS

- `cliente_classificacao` e `fornecedor_excecao`: escrita **master/`service_role`** apenas; leitura staff. A flag **não** é editável por vendedor (corrige o P1 de RLS aberta de `omie_clientes`).
- Lente "ver como pessoa": read-only, sem novo vazamento (já filtra na fonte limpa).

## 9. A confirmar / parametrizável

- **Lista de tags de "não-cliente"**: hoje `{Fornecedor, Transportadora}`. Há outras a incluir (ex.: Funcionário, Contador)? — parametrizado na classificação, fácil de estender.
- **Disciplina da marcação**: o diagnóstico revela quantos fornecedores conhecidos têm a tag (cobertura). Quem não tiver tag escapa até ser marcado no Omie — aceitável (curadoria pega o resto).

## 10. Testes / verificação

- **Helpers puros TS** (overlap de tags; regra de `excluir_da_carteira`) com vitest.
- **Validação SQL local (PG17)**: `classificar_clientes_fornecedores()`, cleanup (multi-linha por user, `eligible=false`), `reverter_exclusao_fornecedor()` (scores renascem) — padrão `db/test-*.sh`.
- **Aceitação = diagnóstico com número real**: antes/depois (quantos saíram; Caxias esvaziou?), reversão (exceção → cadastro + scores voltam).

## 11. Histórico da revisão

### 11a. Crítica solo (v1, antes do Codex)
Apontou: ressurreição por escritores de score; cleanup por flag (não "deixar o recalc limpar"); flag em `omie_clientes`; cruzamento por `(empresa,código)`; reversão; 3 contas; curadoria informada; rollout filtro-antes-do-cleanup.

### 11b. Codex adversarial (gpt-5.5, high) — 9 P1 que geraram a v2
1. **Fonte não existe** (`ListarFornecedores`) → tag no cadastro unificado → **§2/§4.1-4.2**.
2. **`omie_clientes` não é multiempresa** → identidade por `user_id`/CNPJ → **§3/§4.1**.
3. **Escritor omitido** `scoring-recalc-client` → **§4.4**.
4. **`useFarmerScoring`** filtra universo, não só upsert → **§4.4**.
5. **Reversibilidade quebrada** (scores não renascem) → **§4.6**.
6. **Recorrência** (fornecedor novo entra) → classificação pós-sync + trigger → **§4.3**.
7. **Idempotência/staging** → **§4.1/§4.2**.
8. **Rollout invertido** → filtros antes da flag → **§6**.
9. **RLS aberta** da flag → tabela própria service_role → **§4.1/§8**.
P2: rebuild last-write-wins em múltiplas linhas/user; vazamentos laterais (`nao_vinculados`, snapshots de positivação) → **§7**.
