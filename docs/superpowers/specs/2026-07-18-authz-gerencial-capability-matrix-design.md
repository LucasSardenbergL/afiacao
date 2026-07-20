# Autorização gerencial: `pode_ver_carteira_completa` é capability universal, não gate de carteira — design

> money-path + autorização. Nasceu como **FU4** do [design de 2026-07-17](2026-07-17-carteira-rls-eligible-visibilidade-design.md)
> ("gestor deve respeitar a máscara `eligible`?") e cresceu ao medir o alcance real do gate.
> Estado **medido em PROD via psql-ro em 2026-07-18**. Revisão adversária **Codex `gpt-5.6-sol` xhigh**,
> 2 rodadas — o parecer derrubou a proposta inicial e corrigiu 6 afirmações.
> **E1 entregue ([#1424](https://github.com/LucasSardenbergL/afiacao/pull/1424), só código).
> E2 entregue ([#1434](https://github.com/LucasSardenbergL/afiacao/pull/1434)) — ver §8 para o que
> mudou entre o especificado aqui e o construído.**

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

- ~~**FU4-A:** matriz de capability por recurso × ação~~ — **ENTREGUE** no #1434 (§8).
- **FU4-B:** agregação server-side dos KPIs estratégicos (§4.3), independente da máscara.
- **FU4-C:** o TS `CommercialRole` tem 4 valores; o enum do Postgres tem **8** (`operacional, gerencial,
  estrategico, super_admin, farmer, hunter, closer, master` — medido 2026-07-18; o "7" acima estava errado).
  `useCommercialRole` classifica `master` como nenhum dos 4 — hoje inerte porque o master passa por
  `isAdmin`, mas é divergência de contrato.
- **FU4-D:** `ineligibility_reason` (enum+coluna+backfill com `legacy_unknown`) + RPC de quarentena read-only.
  Cortados da E2 por decisão do dono: a matriz não depende deles (a coorte filtra por `eligible`, que já
  existe), e mantê-los engordaria o bloco aplicado à mão misturando autorização com qualidade de dado.
- **FU4-E:** 3 RPCs de ESCRITA em compras (`despinar_parametro`, `reverter_parametro_auto`,
  `reverter_run_auto`) seguem no gate antigo. Como a E2 tirou do gerencial a LEITURA da telemetria de
  compras, sobrou a incoerência "não lê, mas escreve". Não é vazamento de custo/preço/crédito. Ao tratar:
  criar `private.cap_compras_escrever` — não reusar a de leitura (§4.2).
- **FU4-F — custo é legível por `employee`, não só pelo papel (o furo maior, e é outro).** A E2 fechou o
  que o **papel comercial** concede. Mas todo gestor é `app_role='employee'`, e o role concede custo por
  superfícies fora de `commercial_role` (medido em prod 2026-07-18, achado da rodada 2 do Codex):

  | superfície | gate medido | o que expõe |
  |---|---|---|
  | `inventory_position` | policy `employee OR master` | `cmc`, `preco_medio` |
  | `cmc_snapshot` | policy `employee OR master` | `cmc` |
  | `product_costs` | policy `employee` | `cost_price`, `cmc`, `cost_final`, `custo_producao` |
  | `regua_preco_log` | `FOR ALL` `employee OR master` | `piso_mc`, `cmc_usado` |
  | `get_regua_preco` · `_customer360` | `has_role(employee\|master)` | `cmc`, `piso_mc` |
  | `get_tint_price` · `_prices` | `v_is_staff := employee OR master` | `custoBase`, `custoCorantes` |

  Os 2 vendedores de hoje já leem custo por aí — antes e depois da E2. **Isto não é regressão desta
  entrega nem foi prometido por ela**, mas invalida a leitura ingênua de "gerencial não vê custo".

  Canais DERIVADOS na mesma família (mascarar o campo bruto não fecha): `get_preco_cockpit` é um
  **oráculo por bisseção** — o caller escolhe o preço e lê a faixa (`abaixo_do_custo`/`abaixo_do_piso`/
  `abaixo_da_meta`), reconstruindo cmc/piso/meta; `get_defasagem_cliente` devolve `alta_custo_perc`
  (variação percentual do custo) fora do gate. Ambos acessíveis a qualquer `employee`.

  ### FU4-F — decisão do dono (2026-07-19): **vendedor NÃO deve ver custo**

  A decisão confirma o desenho da E2 (`cap_custo_ler` já exclui `farmer`) e define a entrega:
  **fechar no BANCO, em 2 fases.** Impacto medido: 2 pessoas (2 `employee`/`farmer`; o resto é
  2 `master` + 5.664 `customer`).

  ⚠️ **Restrição ingênua QUEBRA o vendedor — medido, não suposto.** Três motores calculam com custo
  no CLIENTE, lendo `product_costs` direto: `useCrossSellEngine` (`if (margin <= 0) continue` ⇒ sem
  custo, **todas** as recomendações somem), `useFarmerScoring` (margem é eixo do score ⇒ a ordenação
  da agenda muda) e `useBundleEngine`. Trocar o gate sem mover o cálculo apaga funcionalidade que o
  vendedor usa.

  **O padrão certo já existe no código, em 3 lugares** — separar o SINAL do NÚMERO:
  `ReguaPrecoSinal` modo `readonly` (`pisoOculto` mostra "abaixo do piso" sem valor);
  `get_defasagem_cliente` (absolutos NULL, mantém `alta_custo_perc` e "repassar p/ R$X");
  `RecommendationCard` (bloco de custo gated por `isAdmin`). O vendedor precisa do semáforo e do
  "repasse para R$X" — não do CMC.

  **Fase 1 — exposições CRUAS saem do gate `employee`** (não mexe nos motores):
  · `cmc_snapshot` → `cap_custo_ler` (só custo; fechar inteiro é seguro)
  · `regua_preco_log` → `cap_custo_ler` na leitura (a UI só escreve, nunca lê)
  · `get_regua_preco` / `_customer360` → mascarar `cmc`/`piso_mc` pelo padrão do `get_defasagem_cliente`
  · `get_tint_price` / `_prices` → trocar `v_is_staff` por `cap_custo_ler` no gate de `custoBase`/`custoCorantes`
  · frontend: **remover as colunas CMC e Preço Médio** da aba Estoque do `/admin/estoque/picking`
    (decisão do dono: quem separa pedido precisa de saldo/lote/FEFO, não de custo) e aplicar
    `pisoOculto` no carrinho, preservando a faixa verde/amarelo/vermelho
  · `/admin/reposicao/baixo-giro`: `capital_parado` (= saldo × cmc) vira gated

  🧭 **PONTO EM ABERTO da Fase 1 — `inventory_position`.** A tabela tem `saldo` **e** `cmc` juntos, e
  o separador precisa do `saldo`. RLS filtra LINHA, não coluna, então não dá para esconder só o custo
  por policy. `GRANT` por coluna também não serve: é por role do Postgres, e `authenticated` é todo
  mundo — não distingue capability. As saídas plausíveis, a decidir na implementação: (a) view
  operacional sem as colunas de custo + fechar a tabela, (b) RPC de saldo que não projeta custo, ou
  (c) aceitar que o frontend só não seleciona as colunas — que é "não mostrar", não "não poder", e
  contradiz a decisão de fechar no banco. **Não escolher isto por conveniência no meio da implementação.**

  **Fase 2 — motores Farmer saem do cliente.** `useCrossSellEngine`, `useFarmerScoring` e
  `useBundleEngine` migram para RPC `SECURITY DEFINER` que lê custo com privilégio e devolve só o
  RESULTADO (margem, score, bundle). Só depois disso `product_costs` pode ir para `cap_custo_ler`
  sem apagar feature. Enquanto a Fase 2 não existir, `product_costs` **fica como está** — e isso é
  uma decisão consciente, não esquecimento.

## 8. E2 — o que foi construído (2026-07-18, #1434)

Divergências conscientes entre o especificado acima e o entregue:

| §4.1 | especificado | entregue | porquê |
|---|---|---|---|
| passos 3-4 | `ineligibility_reason` + backfill | **cortado** → FU4-D | a matriz não depende; reduz o bloco aplicado à mão |
| passo 7 | RPC de quarentena | **cortado** → FU4-D | observabilidade, não autorização |
| passo 8 | RPC de KPIs estratégicos | **cortado** → FU4-B | §4.3 já dizia que é bug independente |
| passo 1 | "gate de versão fail-closed (já entregue como E1)" | **construído de verdade** | a E1 era uma constante literal; virou consulta a `authz_contract_version()`. Sem isso, um Publish sem a migration reabriria o furo em silêncio |

**A matriz.** 6 capabilities em `private`: `cap_preco_escrever` e `cap_credito_escrever` (master),
`cap_custo_ler` (master+estrategico+super_admin), `cap_compras_ler` (master), `cap_carteira_ler` e
`cap_carteira_escrever` (mantêm a concessão do gate antigo). As duas de carteira coincidem hoje **de
propósito**: é a junta onde a matriz dobra — apertar a escrita depois custa 1 função, não 28 policies.

**Alcance real medido — maior que as 64 policies.** Além delas, 4 RPCs `SECURITY DEFINER` liberavam custo:
`fin_estimar_estoque_omie`, `medir_abaixo_piso_tier`, `get_preco_cockpit`, `get_defasagem_cliente`. As duas
últimas quase escaparam: o comentário no `authz-manifest.ts` as descreve como "afina o detalhe", mas o
código mostra que a variável gateada é o que decide se `cmc`/`markup`/`piso`/`folga` saem preenchidos.
**Lição: classifique gate lendo o corpo da função, não o comentário do manifesto.**

**O que a revisão adversária derrubou (Codex `gpt-5.6-sol` xhigh, 2 rodadas).**

Rodada 1 — 4 achados, veredito "não aplique ainda": as 2 RPCs de custo acima (bloqueador);
`FOR ALL USING(ler) WITH CHECK(escrever)` em `selfservice_cliente_allowlist` (DELETE só consulta `USING` →
latentemente inseguro); um assert do harness que era falso-verde por `SET LOCAL` fora de transação; e
`useAuthzContract` não sendo fail-closed após sucesso→erro (react-query preserva o último `data` bom).

Rodada 2 — confirmou 3 correções e reprovou a 4ª por 3 defeitos, todos corrigidos: o bloco que reescreve
as RPCs **não era idempotente** (2ª aplicação abortava — inaceitável para migration colada à mão),
resolvia por `proname` **sem assinatura** (overload futuro seria escolhido arbitrariamente), e o guard
casava **string literal** em vez de regex tolerante (`public.gate ( … )` passaria batido). E trouxe o
achado maior: **a leitura de custo não é fechada por esta entrega** — ver FU4-F no §7. A afirmação
"gerencial perde leitura de custo", que estava no cabeçalho da migration e no PR, foi **corrigida** para
"o PAPEL deixa de conceder" — a redação anterior era falsa, porque gestor é `employee`.

**Prova:** `db/test-authz-capability-matrix.sh` — 52 asserts, PG17, `SET ROLE authenticated`, com guard que
aborta se o SET ROLE não pegar, teste de idempotência (re-aplica a migration) e falsificação em 6 pontos.

## 9. FU4-F — o role `employee` também concede custo (em curso)

A matriz da E2 fecha o que o **papel comercial** concede. O `COMMENT` de `private.cap_custo_ler` declara o resto:
o **role `employee`** concede custo por 6 superfícies que não passam por `commercial_role`.

**Decisão de produto (dono, 2026-07-20): o NÚMERO fecha, o SINAL fica.** A vendedora deixa de ver "CMC R$ 12,40"
e continua vendo "abaixo do custo / abaixo do piso / saudável". Diferente da E2, isto **muda o acesso de gente
viva** — os 2 employees em prod, ambos `farmer`, um deles com 28.065 pedidos criados.

### 9.1 O achado que reenquadra o problema

O enunciado era "6 superfícies com o gate errado". Medindo, o problema é outro: **três subsistemas baixam custo
para o browser e calculam lá** — e é por isso que fechar o gate quebra a tela, não por causa do gate.

| subsistema | onde calcula | efeito de fechar o gate |
|---|---|---|
| `get_preco_cockpit` | **servidor** (`v_pode_num`) | nenhum — já mascara os 7 campos numéricos |
| régua de preço | cliente — `calcPisoMC(cmc, aliquota)` em `regua-preco-helpers.ts:26` | régua morre: o piso é derivado do cmc |
| engines de recomendação | cliente — `margin = price - cost` em 3 hooks | 3 engines morrem |

O cockpit é o **modelo**: calcula a faixa no servidor, devolve só o sinal. As fases 2 e 3 não são "mais
superfícies" — são a **mesma refatoração** (mover cálculo de custo para o servidor) em dois subsistemas.

Corolário para o inventário: `inventory_position` **mistura operacional (`saldo`) com custo (`cmc`,
`preco_medio`)** na mesma tabela, e RLS filtra LINHA, não COLUNA — fechar tira o saldo junto. Column-level
`GRANT` não salva: distingue roles do **Postgres**, e no Supabase todo logado é o mesmo `authenticated`.

### 9.2 Limite honesto declarado

Manter o sinal e tirar o número **não é barreira de segurança**: `get_preco_cockpit` segue sendo **oráculo por
bisseção** (o caller escolhe o preço e lê a faixa; aceita 200 itens/chamada, então ~20 chamadas resolvem 200
SKUs). É barreira de **conveniência**, escolhida conscientemente em troca da ferramenta de venda — mesmo tipo de
limite que o §3 declarou para o E1. Contra adversário competente, a barreira real é contrato e offboarding.

### 9.3 Fases

- **Fase 1** (PR #1465): `cmc_snapshot` + `get_tint_price(s)`. As superfícies **sem** o problema arquitetural.
- **Fase 2** (PR #1488, ENTREGUE): cluster **régua de preço** — ver §9.5.
- **Fase 2b/H** (#1485, #1487): tabelas de compras que ficaram fora da matriz do #1434.
- **Fase 3**: `inventory_position` **ENTREGUE** no #1473 (view operacional `inventory_position_operacional`);
  falta `product_costs` (margem server-side nos 3 engines).

### 9.5 Fase 2 — o que a implementação descobriu (#1488)

Três coisas que o enunciado da fase não previa, todas medidas antes de escrever código:

**1. `piso_mc` também é custo — a alíquota é uma CONSTANTE GLOBAL.** O enunciado supunha que remover
`aliquota_venda` do payload impediria derivar o cmc a partir do piso. Não impede:
`company_config['regua_preco_aliquota_venda_oben']` é **uma linha só** (0.078), não um valor por SKU — logo
`cmc = piso_mc × 0,922`, e quem aprende 7,8% uma vez inverte todo piso para sempre. `piso_mc` e
`piso_gap_pct` saíram gateados por `cap_custo_ler` junto com o `cmc`. Não foi mudança de escopo: é o que o
§7 já mandava (`pisoOculto` "sem valor") e o que `ReguaPrecoSinal.tsx:31` já comentava.

**2. Mascarar não bastava: a COMPARAÇÃO tinha de mudar de lado.** Se o cliente consegue avaliar
`preço < piso` offline para um preço arbitrário, ele acha o piso por **busca binária** — não existe
predicado avaliável no browser que esconda o próprio limiar. Por isso `p_preco_atual` virou argumento da
RPC e a assinatura de 3 args foi **dropada** (viva, ela seguiria devolvendo `cmc`). Corolário de custo: o
preço entrou na `queryKey` do carrinho, o que exigiu debounce — antes a decisão era local e grátis a cada
tecla. No 360 saiu de graça: ele já resolvia `preco_atual` no servidor.

**3. O custo do prazo (F2) tinha de vir junto, e o motivo é o pior tipo de bug.** `pisoComPrazo` também
precisa do cmc. Deixá-lo no cliente faria o piso **degradar para à vista em silêncio** — piso menor, sinal
disparando menos, vendedora fechando abaixo do piso real. Nenhum erro, nenhum log: só uma margem que some.

**Anti-regressão, com o limite declarado.** O `authz:check` do CI **não enxerga mascaramento de campo** —
`checkGate` só valida gate em forma de bloqueio (`IF NOT … RAISE`), e pôr `cap_custo_ler` no `requiredGate`
da régua bloquearia a vendedora inteira. A proteção é o assert estrutural da própria migration + o harness
(`db/test-authz-custo-fu4f-fase2-regua.sh`, 46 asserts / 8 falsificações). Mesma situação do
`get_preco_cockpit`. Está escrito no `authz-manifest.ts` para quem vier depois.

**A lição do #1472 se repetiu — e o harness a pegou.** A 1ª versão do assert procurava a substring
`cap_custo_ler` no corpo do writer para provar que ele NÃO usa a capability de leitura. O **comentário** do
writer ("NUNCA `cap_custo_ler`") satisfazia o assert: a migration fiscalizando a si mesma pelo texto que ela
mesma escreve. Corrigido medindo código **sem comentários** (o mesmo `stripComments` do
`scripts/lib/authz-contract.ts`). Generalização: *todo* assert sobre corpo de função deve rodar sobre a
definição com comentários removidos, não sobre `pg_get_functiondef` cru.

### 9.4 O que o Codex derrubou na fase 1 (registro honesto)

Veredito literal da rodada 1: *"eu não aplicaria esta migration como está"*. Quatro bloqueadores P1:

1. **Idempotência afirmada, não testada** — o cabeçalho dizia "pode reaplicar" e a migration falhava na 2ª
   aplicação. Uma linha de teste teria pego. O harness agora **aplica 2× e asserta**.
2. **Capability de LEITURA usada como autorização de ESCRITA** — `WITH CHECK (cap_custo_ler OR salesperson_id=uid)`
   deixava `estrategico` **forjar `salesperson_id` de outro**, violando o §4.2 deste mesmo spec. Resolvido
   **removendo** o log da fase, não remendando o predicado.
3. **Regexp não ancorado** — casava o predicado solto; em `NOT auth.uid() IS NOT NULL AND (...)` a troca
   consumiria o `AND` e deixaria `NOT cap_custo_ler(...)`, semântica invertida. Agora são dois padrões ancorados
   no contexto de atribuição, com pós-check no mesmo contexto.
4. **Harness sem baseline** — comparava farmer×master **depois** da migration; ficaria verde se o preço mudasse
   igualmente para ambos. O baseline pré-migration virou assert, e uma falsificação sabota exatamente isso.

Lição transversal das 4: **as três primeiras eram verificáveis com o que já estava escrito nos docs do repo** — o
§4.2 deste spec, e a seção "baselinar antes do apply" do `money-path.md`. Ler o doc não substitui aplicar a regra
ao próprio diff. A 4ª é a família do "verde pelo motivo errado": no mesmo harness, um assert passou lendo
`INSERT 0 1` (o status do psql) em vez do uuid, porque a asserção era "não-vazio".
