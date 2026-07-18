# Autorização gerencial: `pode_ver_carteira_completa` é capability universal, não gate de carteira — design

> money-path + autorização. Nasceu como **FU4** do [design de 2026-07-17](2026-07-17-carteira-rls-eligible-visibilidade-design.md)
> ("gestor deve respeitar a máscara `eligible`?") e cresceu ao medir o alcance real do gate.
> Estado **medido em PROD via psql-ro em 2026-07-18**. Revisão adversária **Codex `gpt-5.6-sol` xhigh**,
> 2 rodadas — o parecer derrubou a proposta inicial e corrigiu 6 afirmações.
> **E1 entregue (só código, zero migration). E2 especificada, não construída.**

## 1. A descoberta que redefine o problema

O FU4 perguntava se o gestor deve ver clientes mascarados (`eligible=false`). Ao medir o alcance de
`pode_ver_carteira_completa` — a função que os papéis gerenciais acionam — o problema mudou de tamanho.

**Ela gateia 64 policies em 34 tabelas.** Não é o gate da carteira; é a capability universal de gestão.

> **Frescor (re-medido 2026-07-18, após 3 PRs do domínio mergearem durante esta sessão):** eram 68 policies
> na primeira medição; o [#1416](https://github.com/LucasSardenbergL/afiacao/pull/1416) tornou
> `score_recalc_queue`/`visit_score_recalc_queue` master-only e tirou 4 do gate. O
> [#1421](https://github.com/LucasSardenbergL/afiacao/pull/1421) moveu `carteira_visivel_para` para o schema
> `private` (as policies agora chamam `private.carteira_visivel_para`); `pode_ver_carteira_completa` segue em
> `public`. **A tese não muda:** preço, crédito, custo e markup continuam no gate — reconfirmado.

| recurso | ação concedida | policy |
|---|---|---|
| **`cliente_tier_preco`** | **INSERT + UPDATE** | `cliente_tier_preco_insert_gestor` / `_update_gestor` |
| **`venda_excecao_credito`** | **INSERT** | `venda_excecao_insert_gestor` |
| **`cmc_ledger`** | SELECT | `cmc_ledger_select_gestor` |
| `markup_policy` | SELECT | `markup_policy_select_carteira` |
| `tarefas` + 3 tabelas de tarefa | INSERT/SELECT/UPDATE | |
| 10 tabelas `reposicao_*` | SELECT | motor de compras |
| 4 tabelas `radar_*` | SELECT | prospecção |
| 7 tabelas de carteira | ALL | inclui os mascarados |

Consequência: **atribuir `commercial_role='gerencial'` hoje concede escrita em preço e crédito, e leitura
de custo.** O FU4 original (máscara de carteira) é uma fração pequena disso.

Gatilho medido: o papel é atribuído por um `upsert` num dropdown
([GovernanceUsers.tsx](../../../src/pages/GovernanceUsers.tsx)) — não por migration. Nenhum CI roda quando
alguém usa essa tela. O dono do produto declarou (2026-07-18) que terá **pessoal gerencial em futuro próximo**,
o que tira isto de "risco latente".

## 2. Estado medido (prod, 2026-07-18)

| fato | valor |
|---|---|
| `commercial_roles` existentes | 2 `farmer` (employees) + 1 `master` — **zero** `gerencial`/`estrategico`/`super_admin` |
| enum `commercial_role` | gerencial, estrategico, super_admin, farmer, hunter, closer, master |
| RLS de `commercial_roles` | escrita **só master ou super_admin**; leitura só do próprio (`auth.uid()=user_id`) |
| writers de `commercial_roles` | o dropdown + o trigger `trg_auto_commercial_super_admin` (nenhum outro) |
| `carteira_assignments` | 4.797 `eligible=true` · 2.112 `eligible=false` |
| artefatos de clientes mascarados | 1.459 `farmer_client_scores` · 1.459 `customer_visit_scores` · 730 `farmer_recommendations` |
| distribuição da contaminação | **100% sob o master** (1.459 de 3.534 = 41,3%); os 2 vendedores reais têm **zero** |
| natureza dos 2.112 mascarados | todos clones/aliases fiscais; **zero** conflitos de mapeamento represados |
| `carteira_coverage` | 0 linhas (braço de cobertura inerte) |

O último fato importa: **nenhum número de vendedor está errado hoje.** A exposição é futura e dispara com o
primeiro gestor.

## 3. E1 — trava do contrato gerencial (ENTREGUE, só código)

Escolhida sobre a alternativa "trigger no banco" porque a pré-condição se verifica (zero papéis gerenciais
hoje) e cada migration é aplicada **manualmente** pelo dono no SQL Editor, com falha silenciosa se esquecida.
Gastar uma aplicação manual num interlock que a E2 removeria é desperdício com risco.

1. [`useCommercialRole.ts`](../../../src/hooks/useCommercialRole.ts): `CONTRATO_GERENCIAL_ATIVO = false` gateia
   `canViewManagerial`/`canViewStrategic`. O papel no banco é preservado; a capability não é concedida.
2. [`GovernanceUsers.tsx`](../../../src/pages/GovernanceUsers.tsx): opções desabilitadas no dropdown (não
   omitidas — sumir leria como bug) + guarda na `mutationFn` que barra qualquer outro caller.

**Limite honesto:** é trava de INTENÇÃO, não de segurança. A RLS já garante que só master escreve, então o
único caminho real é este dropdown — mas quem tem token de master pode chamar a API direto. O gate de banco
vem na E2. O risco tratado aqui não é ataque: é promover alguém sem lembrar que vai preço e crédito junto.

Prova: [`useCommercialRole.test.tsx`](../../../src/hooks/__tests__/useCommercialRole.test.tsx) — assere que
`gerencial`/`estrategico`/`super_admin` **no banco** não concedem capability. Red verificado antes do green
(3 falhas por `expected true to be false`).

Verificado que não quebra ninguém: as telas usam `(canViewStrategic || isAdmin)`, e o master entra por `isAdmin`.

## 4. E2 — matriz de capability (ESPECIFICADA, não construída)

### 4.1 Ordem obrigatória (uma transação)

O dono aplica migrations à mão, uma de cada vez, e uma esquecida falha em silêncio. Por isso a E2 **não pode**
ser uma sequência de migrations: precisa ser código dual-compatible + **uma única transação**.

1. Código dual-compatible, com gate de versão fail-closed (já entregue como E1).
2. `BEGIN` + precondições com `RAISE EXCEPTION` se o banco vivo divergir do esperado.
3. Enum/coluna `ineligibility_reason` + backfill + invariantes.
4. Compatibilidade: `eligible=false` sem razão vira `legacy_unknown` — **nunca** falha silenciosa.
5. Separação permanente das policies de **escrita** (ver §4.2).
6. Policies/views/RPCs de leitura: master total; gestor apenas coorte `eligible=true`.
7. RPC de quarentena read-only, inicialmente master-only.
8. RPC de KPIs estratégicos sobre a coorte completa (ver §4.3).
9. Criar `authz_contract_version=2`, rodar assertions, ativar por último.
10. `COMMIT`.

Se qualquer passo falhar, tudo volta. Se a migration não for aplicada, a versão não existe e o frontend mantém
o gestor bloqueado. Elimina o estado "aplicou a segunda, esqueceu a terceira".

### 4.2 Escrita é mais grave que leitura

`pode_ver_carteira_completa` é reusado em policies **mutantes** — o gestor não é auditor read-only, ele pode
alterar e apagar scores e recomendações de qualquer vendedor. Corrigir `INSERT`, `UPDATE` **e** `DELETE`.
Não reutilizar a mesma função em policies de leitura e de escrita.

A matriz precisa ser por **recurso × ação** para os 34 recursos. Trocar só os de carteira deixa preço, crédito,
custo e reposição acoplados ao papel.

### 4.3 Bug independente: KPIs estratégicos são inválidos hoje

[`IntelligenceStrategicTab.tsx`](../../../src/components/intelligence/IntelligenceStrategicTab.tsx) cruza 500
scores + 500 pedidos + 1.000 itens **arbitrários** (`.limit()` sem `.order` — a armadilha de paginação do
PostgREST), sem coorte comum, e calcula LTV/CAC/concentração. **Filtrar `eligible` não conserta isto**: os
números já são matematicamente inválidos, com ou sem máscara. Precisa de agregação server-side.

Fica no escopo da E2 porque é a tela que o papel `estrategico` desbloqueia.

### 4.4 Backfill não pode fabricar certeza

`source + omie_codigo_vendedor` distingue os casos atuais (2.093 sem código = aliases; 19 com código = clones
com vendedor conhecido), mas não é contrato de domínio. O enum precisa de `legacy_unknown`/`ambiguous_backfill`
— inventar motivo onde não há é a mesma falha de "ausente ≠ zero" do money-path.

### 4.5 Prova

RLS prova-se sob `SET ROLE authenticated` + JWT falsificado. **Testar pelo SQL Editor passa falsamente**: o
owner ignora RLS. O trigger `SECURITY DEFINER` roda com privilégios do owner, que pode ter `BYPASSRLS` — provar
consultando `proowner`, `relowner`, `rolbypassrls`.

Se algum interlock de banco for adicionado depois: substituir as policies existentes, **não** acrescentar outra
permissiva (policies permissivas combinam com `OR`, e uma nova não restringe nada).

## 5. Riscos conhecidos

| risco | mitigação |
|---|---|
| Dono promove alguém antes da E2 | E1 bloqueia o dropdown; a guarda barra outros callers |
| E1 vira falso senso de segurança | §3 declara o limite: trava de intenção, não de segurança |
| E2 aplicada pela metade | transação única + `authz_contract_version` ativada por último |
| `trg_auto_commercial_super_admin` quebrado por interlock futuro | reconhecer o alvo por profile + `master_cpf`, **nunca** pela ordem de `user_roles` |
| Trocar só as policies de carteira | matriz por recurso × ação cobre os 34 |

## 6. O que o Codex corrigiu (registro honesto)

A proposta inicial era "documentar a regra + teste de CI, sem tocar no banco". Foi derrubada:

1. **"Gestor é auditor" era falso** — o gate concede INSERT/UPDATE/DELETE global.
2. **"0,7% de divergência" usava o denominador errado** — existem 1.459 scores sob clientes mascarados.
3. **O teste de CI proposto era teatro** — o papel nasce de um `upsert` numa tela; CI não roda em mudança de dado.
4. **Filtrar `eligible` não conserta os KPIs estratégicos** (§4.3).
5. **Backfill inferido fabricaria certeza** (§4.4).
6. **O gate é capability universal**, usado em dezenas de policies incluindo preço e estoque (§1).

Em contrapartida, duas afirmações do parecer foram refutadas por medição: o dano **não** é imediato (a
contaminação está 100% sob o master; vendedores reais têm zero), e o interlock proposto **quebraria produção**
como especificado (o `trg_auto_commercial_super_admin` insere `super_admin` pelo CPF do master).

## 7. Follow-ups

- **FU4-A:** matriz de capability por recurso × ação para os 34 recursos — é a E2 inteira, merece sessão própria.
- **FU4-B:** agregação server-side dos KPIs estratégicos (§4.3), independente da máscara.
- **FU4-C:** o TS `CommercialRole` tem 4 valores; o enum do Postgres tem 7 (falta `farmer`, `hunter`, `closer`,
  `master`). `useCommercialRole` classifica `master` como nenhum dos 4 — hoje inerte porque o master passa por
  `isAdmin`, mas é divergência de contrato.
