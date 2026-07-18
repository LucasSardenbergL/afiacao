# Fatia 2 (P0-B-bis) — popular E consumir `identity_state`: o quarantine de identidade ambígua — design

> money-path (comissão de vendedor + visibilidade de carteira). Fatia 2 do épico-drop do espelho `omie_clientes`
> (spec macro: [2026-07-12-carteira-membership-ledger-drop-espelho-design.md](2026-07-12-carteira-membership-ledger-drop-espelho-design.md), opção **D**).
> Estado verificado por psql-ro (prod) + leitura direta do código em 2026-07-16. **Zero DDL** — a fatia é 2 edges.

## 1. Ponto de partida (verificado, não presumido)

| fato | evidência (2026-07-16) |
|---|---|
| Fatias 0/1/3 mergeadas | `865fa7f3` (#1321), `e065cf86` (#1329), `60ba92ba` (#1331), `3f5b4729` (#1333) |
| ledger populado, quarantine INERTE | psql-ro: **6909 membros / 6909 `verified` / 0 outros** |
| schema pronto p/ a fatia | `identity_state` NOT NULL DEFAULT `'verified'`, CHECK `('verified','ambiguous','inactive','conflict')`, índice `idx_cml_identity_state`, RLS staff+own |
| docs ambíguos HOJE | **0** (psql-ro, lado `profiles`) → a fatia é **preventiva** |
| órfãos Hunter visíveis | **2069** (`carteira_assignments` source=`hunter_orphan` AND eligible) |

### 1.1 O rebuild NÃO consome `identity_state` (o briefing de sessão errou)

Grep de `quarantin` em todo o repo retorna **um único hit**: o comentário
[carteira-rebuild:281](../../../supabase/functions/carteira-rebuild/index.ts) — *"Sem filtro de identity_state
(quarantine é da Fatia 2)"*. Não há implementação.

Não é deslize: a **Fatia 1 adiou deliberadamente**, e registrou em
[§2 do seu design](2026-07-13-fatia1-carteira-rebuild-le-ledger-design.md) — *"Decisão de escopo — quarantine fica
para a Fatia 2 (diverge da spec macro §5-Fatia1)"*, com a justificativa de que consumir `identity_state` com 100%
dos membros em `verified` seria dead code não-testável, e de que **"a Fatia 2 popula E consome juntas"**.

**Consequência:** a Fatia 2 tem **duas pontas**. Só marcar (escritor) entregaria uma fatia decorativa — o
`ambiguous` gravado, ninguém lendo, o quarantine seguindo inerte, com aparência de entrega feita.

## 2. O furo money-path que esta fatia fecha

Hoje, quando um doc vira ambíguo (2+ códigos Omie distintos p/ o mesmo doc na mesma conta):

1. o sync **deleta** o vínculo da proof ([analytics-sync:464](../../../supabase/functions/omie-analytics-sync/index.ts), `source='document'`);
2. o rebuild lê o membro do ledger (nunca some ✅) mas **não** acha vendedor na proof → `montarClientes` → `omie_codigo_vendedor: null`;
3. `computeCarteira` cai no ramo órfão ([rebuild-helpers:150-155](../../../src/lib/carteira/rebuild-helpers.ts)) → emite `source='hunter_orphan'`, **`eligible: true`**.

**Resultado:** um cliente cuja identidade nós admitimos não saber entra visível na carteira do Hunter e **gera
comissão**. E "sem vendedor" (legítimo) é hoje indistinguível de "identidade ambígua" — os 2069 órfãos são um
balde só.

Alvo (spec macro §3.3/§6): **quarantined** — vendedor sem efeito, `eligible=false`, **membro preservado**, zero comissão.

## 3. Decisões desta fatia

| # | decisão | porquê |
|---|---|---|
| D1 | **Popular só `ambiguous`** | único estado com gatilho REAL. `inactive`/`conflict` do `mapaConsolidacao` ficam fora — ver §3.1. Aditivo: o CHECK já aceita os 4. |
| D2 | **Consumir `identity_state !== 'verified'`** (não `=== 'ambiguous'`) | **fail-closed**: estado desconhecido/futuro/NULL → quarantine. Se alguém popular `inactive` amanhã, a rede já está armada em vez de falhar aberto. |
| D3 | **Quarantined = `hunter_orphan` + `eligible=false`** | `carteira_assignments.owner_user_id` é **NOT NULL** e o CHECK de `source` só aceita `('omie','hunter_orphan')` → `source='quarantined'` exigiria DDL em tabela quente + auditar todos os leitores. `eligible=false` já entrega o efeito money-path (índice `idx_carteira_owner_eligible`). **Zero DDL.** |
| D4 | **Reversão `ambiguous→verified` escopada ao que o run PROVOU limpo** | sem ela é catraca de mão única: doc corrigido no Omie deixaria o cliente invisível e sem comissão **para sempre**, e ninguém saberia que precisa de um UPDATE manual. |
| D5 | **Só o run da conta `vendas`/oben escreve no ledger** | `identity_state` é coluna **global** (1 row/user) mas a ambiguidade é detectada **por conta** → 3 runs escrevendo = um marca, outro desmarca (**flapping**). A carteira é oben-only (rebuild lê proof `account='oben'`), e o código já segue essa regra: só `'vendas'` escreve o espelho ([:488](../../../supabase/functions/omie-analytics-sync/index.ts)) e as tags. |

### 3.1 Por que `inactive`/`conflict` do `mapaConsolidacao` ficam fora

A spec macro §3 diz *"`mapaConsolidacao` alias `inactive`/`conflict` → reflete no ledger do clone"*. Isso **não
sobrevive ao código real**:

- `mapaConsolidacao` grava **todos** os aliases com `status:"inactive"` hard-coded
  ([:1887](../../../supabase/functions/omie-analytics-sync/index.ts)); o handler ([:2140](../../../supabase/functions/omie-analytics-sync/index.ts))
  descreve o estado como *"INERTE até o canário"*. Ou seja **`inactive` = proposta não-ativada, não revogação**.
  Prod: 1633 aliases, **todos `active`** (ativados depois, manualmente).
- Um clone canonicalizado tem identidade **perfeitamente conhecida** — ele *é* o gêmeo. Marcá-lo não-`verified`
  conflaria "mapeamento proposto" com "identidade problemática".
- Seria um **2º writer** para um efeito que o `aliasMap` já produz (clone → `eligible=false`, [rebuild-helpers:157](../../../src/lib/carteira/rebuild-helpers.ts)).
  O CLAUDE.md proíbe sinal money-path multi-writer.
- `'conflict'`: **nenhum caminho** do `mapaConsolidacao` o emite (o tipo em [:1781](../../../supabase/functions/omie-analytics-sync/index.ts)
  permite; o código sempre grava `inactive`). O `conflict` do `computeCarteira` é outro conceito (código→2 vendedores),
  calculado no rebuild. Popular seria dead code.

D2 (fail-closed) preserva a opção: se um gatilho real de `inactive` aparecer, basta popular — o consumo já quarantina.

## 4. Arquitetura

### 4.1 Escritor — `omie-analytics-sync` (2 escritas, espelhando as da proof)

Cada escrita no ledger acompanha a escrita correspondente na proof, no mesmo bloco:

| onde | hoje | + Fatia 2 |
|---|---|---|
| [:464](../../../supabase/functions/omie-analytics-sync/index.ts) | DELETE dos ambíguos da proof | `UPDATE ledger SET identity_state='ambiguous'` p/ `usersAmbiguosOmie` |
| [:501](../../../supabase/functions/omie-analytics-sync/index.ts) | UPSERT dos vínculos limpos na proof | `UPDATE ledger SET identity_state='verified'` p/ `accountMapByUser.keys()`, filtrado por `.eq('identity_state','ambiguous')` |

- **Conjuntos disjuntos de graça:** [:447](../../../supabase/functions/omie-analytics-sync/index.ts) já faz
  `accountMapByUser.delete(uid)` para todo ambíguo → quem entra na reversão nunca é quem entra na marcação.
- **Ordem fail-closed:** marca ambíguo **antes** de reverter. Se a marcação falhar → `throw` → run falha, nada muda.
  Se a reversão falhar → sobra gente quarantinada a mais (conservador: esconde em vez de pagar comissão errada),
  corrigida no próximo run.
- **`UPDATE` nunca insere:** `.in('user_id', …)` sobre linhas existentes. Membro fora do ledger não é criado aqui
  (isso é do trigger da Fatia 0) — o ledger continua acumulador.
- **`.eq('identity_state','ambiguous')` na reversão:** evita reescrever ~5238 linhas por run (write amplification)
  e impede que a reversão toque estados que esta fatia não populou.
- **Run parcial é fail-safe:** vê menos registros → detecta menos ambíguos → marca menos; e reverte só o que provou
  limpo. Mesma propriedade do DELETE cirúrgico já existente.

### 4.2 Leitor — `carteira-rebuild`

- [:291](../../../supabase/functions/carteira-rebuild/index.ts): `.select('user_id')` → `.select('user_id, identity_state')`;
  monta `quarantinados: Set<string>` via `extrairQuarantinados` (helper puro, D2).
- [:380](../../../supabase/functions/carteira-rebuild/index.ts): a máscara de elegibilidade passa a incluir o
  quarantine, reusando o padrão que os `flaggeds` já usam.

**O que NÃO fazer (o erro catastrófico):** filtrar o quarantinado da LISTA. O membro sumiria da entrada → o
upsert-only ([:403](../../../supabase/functions/carteira-rebuild/index.ts), `onConflict: 'customer_user_id'`, sem
DELETE) não geraria row → **o assignment antigo persistiria STALE** (vendedor errado, válido, cobrando comissão).
Esse é exatamente o mecanismo pelo qual o Codex refutou a opção A′. O membro permanece na lista; **só o `eligible` cai**.

Na prática o ambíguo já perde o vendedor sozinho (deletado da proof → `montarClientes` → `null` → órfão), então a
fatia só precisa **derrubar o `eligible`**: a diferença entre "vai pro Hunter e gera comissão" e "preservado,
invisível, zero comissão".

### 4.3 Helpers puros (`src/lib/carteira/rebuild-helpers.ts`, dentro do bloco MIRROR)

```ts
extrairQuarantinados(rows: Array<{ user_id: string; identity_state: string | null }>): Set<string>
// D2 fail-closed: TUDO que não for exatamente 'verified' entra (inclui null/undefined/estado futuro).

aplicarMascaras(assignments, flaggeds, quarantinados): ComputedAssignment[]
// eligible := a.eligible && !flaggeds.has(id) && !quarantinados.has(id). Extrai a regra do edge p/ ser testável.
```

Ambos espelhados **verbatim** no edge (Deno não importa de `src/`) — paridade guardada pela canária textual.

## 5. Invariantes

1. Membro **nunca** sai do ledger nem da lista do rebuild. Quarantine muda `eligible`, **nunca** a presença.
2. Todo membro do ledger → **uma** row em `carteira_assignments` (reconciliação; nada fica stale).
3. Quarantinado → `eligible=false` → zero comissão (protegido: `_carteira_positivacao_for_owner`) e
   invisível na carteira operacional (`escopo-clientes.ts`). ⚠️ **CORRIGIDO 2026-07-17:** a afirmação
   original *"todos os leitores usam `WHERE eligible`"* era **FALSA** — `carteira_visivel_para` e
   `minha_carteira` ignoravam `eligible` e vazavam artefatos do cliente via RLS (medido em prod:
   8/14 consumidores). Fechado o gate + RPC em
   [2026-07-17-carteira-rls-eligible-visibilidade-design.md](2026-07-17-carteira-rls-eligible-visibilidade-design.md);
   os braços de **autoria** (`farmer_id`), **`pode_ver_carteira_completa`** (gestor) e **edge service_role**
   seguem eligible-blind por design — para identidade ambígua isso é um gap de reidentificação aberto (FU1 do design acima).
4. Consumo é fail-closed (`!== 'verified'`); população é conservadora (só `ambiguous`, só conta oben).
5. Aditivo: com 0 ambíguos (o caso de hoje), o rebuild produz **exatamente** o resultado atual.
6. O `owner_user_id` do quarantinado permanece na row (NOT NULL), inerte — o quarantine é **máscara reversível**,
   não destruição de dado. Volta a `verified` → volta a valer.

## 6. Testing

**`prove-sql-money-path` (PG17) NÃO se aplica** — e isso é um desvio consciente do briefing de sessão, que o exigia
presumindo DDL. D3 eliminou toda a SQL nova: sem migration, o PG17 provaria só que um `UPDATE` não apaga a linha e
que o CHECK aceita `ambiguous` (já provado na Fatia 0). A própria skill exclui *"edge function sem SQL novo"*.
O risco desta fatia é **lógica TypeScript** — o teste que pega a saída errada é vitest.

| teste | pega |
|---|---|
| `extrairQuarantinados` +/− | `verified`→fora; `ambiguous`→dentro; `null`/estado futuro→dentro (D2) |
| `aplicarMascaras` +/− | quarantinado tem row com `eligible=false` (**não some**); `verified` intocado; flagged+quarantine compõem |
| composição `computeCarteira`+máscara | o **erro catastrófico**: membro quarantinado sumir da saída |
| **falsificação** | sabotar a máscara (`&& !quarantinados.has(...)` removido) → a suíte **tem** que ficar vermelha |
| canária textual | `select` inclui `identity_state`; edge aplica a máscara; paridade do MIRROR |
| `heavy bun run test` | suíte completa (não só os alvos) |

A canária atual ([edge-money-path-invariants:805](../../../src/__tests__/edge-money-path-invariants.test.ts)) casa
`select('user_id')` **exato** → vai quebrar de propósito e precisa ser atualizada. É o teste fazendo seu trabalho.

**Pós-deploy (psql-ro):** distribuição de `identity_state` (esperado: 6909 `verified`, 0 `ambiguous` — hoje não há
doc ambíguo) e `carteira_assignments` sem perda de membro (`count == 6909`).

## 7. Deploy

**💬 2 edges pelo chat do Lovable, verbatim** (`omie-analytics-sync`, `carteira-rebuild`). **Sem 🟣 SQL Editor**
(zero DDL) e **sem Publish** (nenhuma mudança de frontend — `rebuild-helpers.ts` é lib compartilhada consumida pelo
espelhamento no edge, não por página).

## 8. Resíduos conhecidos

- **Override manual + doc ambíguo:** o DELETE da proof preserva `source='manual'` ([:471](../../../supabase/functions/omie-analytics-sync/index.ts)),
  então um user com override humano pode ficar `ambiguous` **com** vendedor na proof → o quarantine derruba o
  `eligible` mesmo assim (fail-closed vence). Reversível: doc corrigido → `verified` → override volta a valer.
- **`orphanCount`** conta o quarantinado como órfão visível (a máscara é aplicada depois do `computeCarteira`).
  É métrica de observabilidade, não money-path; mesmo comportamento dos `flaggeds` hoje.
- **`avaliarGuardResultado`** vira rede de segurança de graça: quarantine em massa (bug) derruba `omieElegivelNovo`
  → `< 80%` do baseline → rebuild **aborta** sem gravar. Com 0 ambíguos hoje, inerte.
- **`computeCarteira` não emite membro com conflito de mapeamento** ([rebuild-helpers:115](../../../src/lib/carteira/rebuild-helpers.ts))
  → mesmo padrão stale do A′, pré-existente e fora do escopo desta fatia. Candidato a fatia própria.
