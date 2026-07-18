# Carteira — o membro omitido: conflito de mapeamento, Hunter ausente e a pós-condição de cobertura — design

> money-path (comissão de vendedor + carteira). Resíduo §8 do spec da Fatia 2
> ([2026-07-16-fatia2-identity-state-quarantine-design.md](2026-07-16-fatia2-identity-state-quarantine-design.md)),
> épico-drop do espelho `omie_clientes` (spec macro: [2026-07-12](2026-07-12-carteira-membership-ledger-drop-espelho-design.md), opção **D**).
> Fatos por psql-ro (prod, 2026-07-16) + `/codex` adversarial (gpt-5.6-sol, xhigh) que **refutou 2 afirmações minhas**.
> **Zero DDL** — 1 edge + 1 helper puro.

## 1. Ponto de partida (medido, não presumido)

| fato | evidência (psql-ro, 2026-07-16) |
|---|---|
| códigos → 2+ vendedores **hoje** | **0** → a fatia é **preventiva** (como a Fatia 2) |
| `omie_vendedor_map` | 18 linhas · 18 códigos · **3** vendedores · 3 contas (colacor 3 / colacor_sc 12 / oben 3) |
| chave REAL (`pg_constraint` **e** `pg_indexes`) | **`UNIQUE (omie_account, omie_codigo_vendedor)`** + PK(id). **Não** existe unique só no código |
| `omie_account` | `NOT NULL`, **sem DEFAULT**, distribuição real 3/12/3 |
| consumidores de `omie_vendedor_map` | **só** o `carteira-rebuild` (o outro hit é `types.ts` gerado) |
| ledger × assignments | 6909 = 6909 · quarantinados 0 · omie elegível **2728** (= `carteira_omie_baseline`) |
| aliases ativos | 1633 · **0** canônicos fora do ledger · **0** clones fora · **0** cadeias |

## 2. O problema — uma classe, três instâncias

O `carteira-rebuild` grava com **upsert-only sem reconciliar ausentes**
([:403](../../../supabase/functions/carteira-rebuild/index.ts), `onConflict: 'customer_user_id'`, sem DELETE).
Logo **quem não é emitido mantém o assignment ANTIGO vivo** → vendedor errado, **válido e elegível**, cobrando
comissão. É o mecanismo pelo qual o Codex refutou a opção A′ (§2 do spec macro): *"ausente da entrada"* nunca
pode significar revogação/no-op.

"Um membro não chegou na saída" é **uma classe de bug**, com três instâncias vivas hoje:

| # | instância | efeito |
|---|---|---|
| I1 | `emitLegado` não emite `kind==='conflict'` ([rebuild-helpers:115](../../../src/lib/carteira/rebuild-helpers.ts)) | o resíduo reportado |
| I2 | `hunterUserId === null` → **nenhum** órfão é emitido, sem abort ([:279](../../../supabase/functions/carteira-rebuild/index.ts)) | **4162** membros stale (2069+2093 hunter_orphan). Instância ~2000× maior que I1 |
| I3 | qualquer omissão futura no helper | invisível: os guards contam LINHAS, e o membro omitido some **sem mudar contagem** |

### 2.1 A causa-raiz de I1 é um join entre namespaces incompatíveis

O vendedor vem da proof **`.eq('account','oben')`** ([:338](../../../supabase/functions/carteira-rebuild/index.ts)) —
então o código é da conta **oben**. Mas a outra metade do join lê o map de **TODAS as contas**
([:262](../../../supabase/functions/carteira-rebuild/index.ts)). O código de vendedor é **account-scoped**
(o mesmo humano tem código diferente em cada conta Omie — visível no dump: os 3 vendedores aparecem nas 3 contas
com códigos distintos). A `UNIQUE(omie_account, omie_codigo_vendedor)` **permite por design** o mesmo número em
duas contas apontando p/ vendedores diferentes.

**O bug sem filtro é PIOR que o stale:** um código oben que casasse com **uma única** linha `colacor_sc` de outro
vendedor resolveria `users.size === 1` → sai `source='omie'`, **`eligible=true`, vendedor errado, sem nenhum sinal
de conflito** ([rebuild-helpers:83](../../../src/lib/carteira/rebuild-helpers.ts)). Misatribuição **silenciosa** —
o conflito ao menos deixa rastro em `conflicts`.

⚠️ **Por que gatear por `omie_account` é legítimo aqui** (o P0-A foi revogado por gatear num rótulo mentiroso —
`money-path.md`): `empresa_omie` era `DEFAULT 'colacor' NOT NULL` com ~100% no default → não era fato.
`omie_account` é `NOT NULL` **sem default**, com distribuição real 3/12/3, e **compõe a UNIQUE**. É fato.

## 3. Decisões

| # | decisão | porquê |
|---|---|---|
| D1 | **Filtrar `omie_vendedor_map` por `.eq('omie_account','oben')`** | corrige o domínio do join. `UNIQUE(omie_account, código)` ⇒ dentro da conta, código→vendedor é **função** ⇒ `users.size>1` **estruturalmente impossível** ⇒ I1 inalcançável **por construção do banco**, não por convenção. Mata também a misatribuição silenciosa (§2.1), que é o caso mais perigoso e que D2 **não** pega. |
| D2 | **Conflito → `hunter_orphan` + `eligible=false`** (em vez de omitir) | padrão da Fatia 2 (D3): membro preservado, zero comissão, reversível, **zero DDL** (`owner_user_id` é NOT NULL e o CHECK de `source` só aceita `omie|hunter_orphan`). O helper é **puro** e não pode CONFIAR no filtro do caller. Hunter é **placeholder inerte**, não palpite de dono. |
| D3 | **Abortar se `hunterUserId` for null** | fecha I2. Mesmo padrão do guard vizinho *"vendedor_map vazio é anômalo → aborta"* ([:276](../../../supabase/functions/carteira-rebuild/index.ts)). No-op hoje (Hunter configurado). |
| D4 | **Pós-condição de cobertura: saída == conjunto de membros** (sem faltante/extra/duplicado) → aborta | fecha a **classe** (I3), não as instâncias. É o único guard que prova o **CONJUNTO**; os de cardinalidade contam LINHAS e são cegos ao membro omitido. Tripwire: com D1+D2+D3 deve ser inalcançável. |
| D5 | **`computeCarteira` entra no bloco `MIRROR`** | hoje ela é duplicada no edge ([:38](../../../supabase/functions/carteira-rebuild/index.ts)) **fora** de qualquer guarda de paridade — dá p/ corrigir o helper testado e **esquecer o edge real** (achado Codex, que eu havia encontrado em paralelo). |
| D6 | **Teste estrutural prendendo `.eq('omie_account','oben')` no edge** | D2 **não** defende a remoção de D1 (o singleton de conta errada resolve como `omie`, sem conflito — refutação do Codex). Sem isto, D1 é reversível pelo deploy do Lovable sem ninguém notar. |

### 3.1 Por que D1 **e** D2 (e não só um)

São **ortogonais**: D1 corrige o **domínio** (impede contaminação cross-account); D2 impede **omissão/stale** quando o
helper recebe um mapa inconsistente. O Codex, forçado a escolher um, escolheu **D1** — e concordo com o
raciocínio: D2 só trata um subconjunto *menos perigoso* das entradas inválidas. Mas D2 é o que a spec macro §6 exige
do helper ("ausente ≠ revogação") e custa 4 linhas.

### 3.2 O que ficou de FORA (fatia própria)

- **P0 — `eligible` NÃO é gate universal.** Medido: **8 de 14** consumidores SQL de `carteira_assignments` ignoram a
  coluna. `carteira_visivel_para` (SECURITY DEFINER) faz `EXISTS(... owner_user_id=_uid)` **sem** `AND a.eligible` e
  gateia **8 policies RLS** (`farmer_calls`, `route_visits`, `farmer_recommendations`, `visitas_agendadas` INSERT…);
  `minha_carteira` idem. **A invariante #3 da Fatia 2** (*"eligible=false → zero comissão e invisível — todos os
  leitores usam WHERE eligible"*) **é falsa na camada RLS**. Comissão está protegida
  (`_carteira_positivacao_for_owner` filtra ✅) e a tela principal também (`escopo-clientes.ts`). Já vale hoje:
  **2112** rows `eligible=false` em prod cujos donos ainda enxergam via RLS. Exige DDL + auditoria dos 8 → chip próprio.
- **P1 — mosaico/atomicidade:** cada chunk é transação independente ([:427](../../../supabase/functions/carteira-rebuild/index.ts));
  "foi emitido" ≠ "foi reconciliado". Staging + swap transacional é a solução estrutural.
- **P2 — paginação:** a leitura do `omie_vendedor_map` não é paginada (18 linhas: segura por **volume**, não por construção).
- **Paradoxo do guard** (Codex): revogação em massa legítima derruba `omieElegivelNovo` → `<80%` → **aborta** →
  preserva justamente os assignments que deviam ser revogados. O guard não distingue "entrada degradou" de
  "revogação explícita". Inerte aqui (D1 torna o conflito em massa impossível), mas é dívida real da Fatia 2.

## 4. Prova de que D1 é no-op (pré-deploy)

⚠️ **Contagem não prova no-op** (refutação do Codex, aceita): o guard de 80% aceita até **545** perdas elegíveis
(baseline 2728 → mínimo que passa: 2183) e **não detecta troca de 2728 owners por outros 2728**.

Prova correta, por **equivalência de entrada** (`computeCarteira` é PURA ⇒ mesma entrada, mesma saída — owner,
source e eligible dos 6909, não só contagem): para **todo** código que a proof oben pode entregar, o conjunto de
vendedores resolvido é idêntico com o map global e com o map filtrado por `oben`:

```
    cod     | n_global | n_oben | veredito          → codigos_que_divergem = 0 / dominio = 4
 8689670832 |        1 |      1 | IDENTICO
 8689670840 |        1 |      1 | IDENTICO
 8689670842 |        1 |      1 | IDENTICO
 8689670844 |        0 |      0 | IDENTICO   (casa nada nos dois → Hunter; já é o caso dos 2 órfãos)
```

Portanto D1 não muda `resolveVendedor`, canonicalização, máscara nem owner de **nenhum** dos 6909 membros.
(Validade: a medição vale p/ o estado do map no momento — reconferir no pós-deploy.)

## 5. Invariantes

1. Membro **nunca** sai da lista nem da saída. Conflito muda `eligible`, **nunca** a presença.
2. Todo membro do ledger → **exatamente uma** row (provado por D4, não presumido).
3. Conflito → `eligible=false` → zero comissão. ⚠️ **Não** garante invisibilidade RLS (§3.2 P0).
4. Aditivo: com 0 conflitos (hoje), a saída é **idêntica** à atual — provado em §4.
5. Fail-closed: anomalia estrutural (Hunter ausente, cobertura furada, cadeia de alias) → **aborta sem escrever**.

## 6. Testing

`prove-sql-money-path` **não se aplica** (zero DDL/SQL nova — a própria skill exclui *"edge function sem SQL novo"*).
O risco é **lógica TypeScript** → o teste que pega a saída errada é **vitest**.

| teste | pega |
|---|---|
| `emitLegado` conflito +/− | membro conflitado **tem row** com `eligible=false` (**não some**); código preservado |
| conflito + `hunter=null` | não emite (limitação real) → é D3/D4 que fecham, no edge |
| `verificarCobertura` +/− | faltante / extra / duplicado → `ok=false`; caso feliz → `ok=true` |
| composição `computeCarteira`+cobertura | o **erro catastrófico**: membro sumir da saída |
| **falsificação** | sabotar cada guard → exigir vermelho **com contagem E nomes conferidos** (#1362) |
| canária textual | edge filtra `omie_account='oben'` (D6) · edge aborta sem Hunter · paridade do MIRROR agora cobre `computeCarteira` |

### 6.1 Falsificação executada (baseline verde + contagem E nomes conferidos)

| sabotagem | vermelhos esperados | resultado (motivo = assert `×`, não parse) |
|---|---|---|
| baseline (helper original) | verde | **62 passed / 0 failed** ✅ (prova: comando roda, 62 asserts) |
| SAB.1 conflito volta a OMITIR | 2 | `× QUARANTINA` + `× composição-cobertura` ✅ |
| SAB.2 conflito emite `eligible=true` | 2 | `× QUARANTINA` + `× composição` ✅ |
| SAB.3 `verificarCobertura` sempre ok | 3 | `× sem row` + `× não-membro` + `× duplicado` ✅ |
| SAB.4 cobertura ignora faltante | 1 | `× membro sem row` ✅ |
| pós-restauro | verde | **62 passed** ✅ |

⚠️ SAB.3 v1 FALHOU o ritual (#1362 vivo): a perl casou o `{` dentro de `Array<{...}>` → **erro de PARSE**, não os 3 asserts (o vermelho era `FAIL …test.ts [ … ]`, não `×`). Só a checagem de NOME pegou — a contagem (`1 failed`) parecia plausível. Refeito injetando após a assinatura completa `): { ok: boolean; motivo: string | null } {`. **Lição confirmada:** exit≠0 e "1 failed" não distinguem "pegou o bug" de "corrompi o arquivo" — só o NOME do vermelho (`×` do meu assert vs `FAIL` de suite) prova.

## 7. Deploy

**💬 1 edge pelo chat do Lovable, verbatim** (`carteira-rebuild`). **Sem 🟣 SQL Editor** (zero DDL) e **sem Publish**
(`rebuild-helpers.ts` é lib consumida pelo espelhamento no edge, não por página).

**Pós-deploy (psql-ro):** ledger==assignments==6909 · omie elegível ≈2728 (D1 é no-op — §4) · 0 rows novas com
`source='hunter_orphan' AND eligible=false` além das 2093 conhecidas.

## 8. Lição de método (nova)

**O semáforo `heavy` é uma FILA → "rodo o baseline e depois edito" NÃO garante essa ordem.** Mordido nesta sessão:
o baseline ficou ~10min esperando slot (4 worktrees na frente), eu editei o helper enquanto ele esperava, e ele
executou **já com o código novo** — voltou `1 failed | 53 passed` parecendo baseline e sendo pós-mudança. O tell:
a falha era exatamente o assert que a minha mudança quebra de propósito. **Regra:** baseline se prende ao **estado
do código** (`git stash` / worktree limpa / commit), nunca à ordem dos comandos. Irmão do #1362 (o exit code mente)
e do `| tail` (engole o exit code): aqui **o relógio mente**.
