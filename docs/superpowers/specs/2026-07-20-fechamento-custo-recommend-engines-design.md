# FU4-F fase 3 — as vias de recomendação param de entregar custo ao browser

> Spec de desenho. Irmão de [`2026-07-20-fechamento-custo-farmer-scoring-design.md`](2026-07-20-fechamento-custo-farmer-scoring-design.md),
> que fecha `useFarmerScoring`. Aqui: as **três** vias restantes da §9 daquele spec.
>
> Decisão de produto (dono, 2026-07-20): **ordem + faixa ficam, o R$ derivado de custo fecha.**
> Escopo (dono, 2026-07-20): **PR-A antes de PR-B** — a edge `recommend` vaza AGORA; os hooks estão dormentes.

## 1. A população inteira do problema são 2 pessoas

Medido em prod (`psql-ro`, 2026-07-20). Isto dimensiona tudo o que vem abaixo:

| | |
|---|---|
| staff total | **3** — 1 `master`, 2 `employee` |
| os 2 `employee` | ambos `commercial_role='farmer'` |
| quem tem `private.cap_custo_ler` | **só o master** (exige `master` ou `employee`+`estrategico`/`super_admin`) |
| quem lê `product_costs` hoje | policy `master OR employee` ⇒ **os 3** |
| usuários `gerencial`/`estrategico` | **0** |

⇒ **Os 2 farmers são a superfície inteira do FU4-F fase 3.** E a assimetria `cap_carteira_ler` ⊃ `cap_custo_ler`
(que permitiria a um `gerencial` ler carteira sem poder ler custo) tem **zero usuários hoje** — é dívida
latente, não caminho vivo. Dizer o contrário seria inflar a ameaça.

## 2. As quatro vias, medidas — e três não são o que o enunciado supunha

| via | vaza o quê | estado medido | veredito |
|---|---|---|---|
| edge `recommend` | `cost_final` + `margin` + `eip` exatos | **VIVO e corrente** | **PR-A** |
| `useCrossSellEngine` | `product_costs` inteira (3.637) + `m_ij` persistido | dormente desde **2026-05-12** | PR-B |
| `useBundleEngine` | `product_costs` inteira + `"cost"` literal no jsonb | dormente desde **2026-03-02** | PR-B |
| `useBaixoGiro` | — | **já gatado** | **não é lacuna** (§6) |

### 2.1 `useBaixoGiro` — o brief mandou verificar antes de concluir, e a verificação nega a lacuna

`inventory_position` **já tem `private.cap_custo_ler` nas duas policies** (`Staff can manage inventory`
e `staff_inventory_position_select`). Não há o que fechar: está fechado pela régua mais estrita do repo.

O efeito colateral é o **inverso** de um vazamento: um comprador não-master abre
`/admin/reposicao/baixo-giro` e recebe `saldo`/`cmc`/`capital_parado` = `null` **em silêncio**
([`useBaixoGiro.ts:33`](../../../src/components/reposicao/baixoGiro/useBaixoGiro.ts)) — a tela mostra
"—" sem dizer que é falta de permissão. É degradação silenciosa (questão de produto: `cap_compras_ler`
também é master-only, então nenhum comprador não-master enxerga capital parado), **não** autorização.
Registrado na §7; fora do escopo de segurança.

## 3. PR-A — a edge `recommend`

### 3.1 O vazamento: o strip é no browser, depois de receber

A edge tem gate `employee OR master` ([`index.ts:401`](../../../supabase/functions/recommend/index.ts))
e monta `_admin.cost_final` **incondicionalmente** ([`:319-321`](../../../supabase/functions/recommend/index.ts)).
Quem apaga é o cliente:

```ts
// useRecommendationEngine.ts:69-75
if (!isAdmin) {
  res.recommendations = res.recommendations.map(r => { const { _admin, ...rest } = r; return rest; });
}
```

**A resposta de rede já entregou o custo.** É a fachada exata que o spec irmão nomeia (§8, "mascarar a
saída mantendo o `fetch`"). Os 2 farmers veem o `cost_final` de cada candidato no DevTools.

E há um caminho mais curto que nem precisa do `_admin`: `margin` é **top-level**, renderizado em
[`RecommendationCard.tsx:81`](../../../src/components/RecommendationCard.tsx) **fora** do
`showAdminBreakdown`, ao lado de `price` na linha 62 ⇒ `custo = preço − margem`, aritmética de duas
células da mesma tela. O `Custo:` da linha 120 que o enunciado apontou é o sintoma menor.

### 3.2 A superfície de inversão é maior que `cost_final` — inventário completo

Nulificar o campo óbvio não fecha. Enumerado a partir do código, não por analogia:

| campo | por que inverte |
|---|---|
| `margin` | `custo = price − margin`, direto |
| `eip` | `eip = probability × margemRank`, e `probability` **é devolvido** ⇒ `margemRank = eip/probability` |
| `_admin.eiltv` | idem, via `kappa` e `recurrence` |
| `_admin.cost_final` · `_admin.estimated_cost_for_ranking` | literais |
| `score_final` **+** `meta.weights` **+** sub-scores do `_admin` | `score_final = wA·assocN + wP·eipN + wS·simN + wC·ctxN − pen` ([`:271`](../../../supabase/functions/recommend/index.ts)). Com pesos e sub-scores conhecidos, isola-se `eipN`; `minMaxNorm` é invertível a menos de afim sobre o conjunto ⇒ margens recuperáveis a menos de afim, e **duas âncoras conhecidas fixam a afim** |
| `explanation_text` | ⚠️ [`:241`](../../../supabase/functions/recommend/index.ts) embute o número na **prosa**: `` `… alto potencial de margem (R$ ${margemExibida.toFixed(2)})` `` — nenhum nulificar-campo pega isto |

O `explanation_text` é o achado que justifica enumerar em vez de tapar o buraco visível.

### 3.3 O desenho

**(a) Migration — `public.pode_ler_custo() → boolean`, SEM PARÂMETRO**

`private.cap_custo_ler` não é alcançável por PostgREST (só `public` é exposto). Replicar a regra em TS
**derivaria em fail-OPEN** (a edge acharia que pode quando o banco diz que não) — é a armadilha do
helper espelhado sem prova de paridade.

⇒ wrapper fino, `SECURITY DEFINER`, `STABLE`, `SET search_path TO 'public', pg_temp` (`pg_temp` por
último), corpo = `SELECT COALESCE(private.cap_custo_ler((SELECT auth.uid())), false)`.

⚠️ **O desenho sem parâmetro não é detalhe.** Uma `pode_ler_custo(_uid uuid)` seria um **oráculo de
capability**: qualquer caller sondaria a permissão de qualquer usuário. Sem argumento, a função
responde só sobre o **caller** — informação que ele já obtém olhando a própria tela. Zero informação
nova ⇒ pode ser `GRANT`ada a `authenticated`, que é como a edge (chamando com o JWT do usuário) obtém
a resposta. `REVOKE` de `PUBLIC` e `anon` **por nome** (revogar de `PUBLIC` não remove grant nomeado).

⚠️ **Propriedade defensiva de brinde:** chamada com `service_role`, `auth.uid()` é `NULL` e o retorno
é `false`. Ligar a edge no client errado falha **FECHADO** (nega custo), nunca aberto. Por isso a edge
chama com `supabaseAuth`, não com `supabaseAdmin` — e o harness prova esse caso (A6).

**(b) Edge — gate de projeção, espelhando `get_preco_cockpit`**

```
v_pode := pode_ler_custo(user.id)     -- erro na RPC ⇒ false (fail-closed)
```

| campo | sem `cap_custo_ler` |
|---|---|
| `margin`, `eip` | `null` (chave presente) |
| `_admin` | **ausente por inteiro** — não nulificado campo a campo |
| `meta.weights` | ausente |
| `score_final` | **migra para dentro do `_admin`** (já é conteúdo admin-only: [`RecommendationCard:124`](../../../src/components/RecommendationCard.tsx)) |
| `explanation_text`, ramo `margin` | mesma frase **sem o R$** |
| nº de itens | `top_n_vendedor` (5) em vez de `top_n_admin` (20) — reduz 4× a superfície de ordenação |

O que **fica**: `price`, `probability`, `estoque`, `explanation_text`, `recommendation_type` e a
**ordem** do array. É o ranqueamento — o produto da feature.

**(c) `recommendation_log`** — `unit_cost` é gravado pela edge ([`:295`](../../../supabase/functions/recommend/index.ts))
e a RLS é `master OR employee` ⇒ os farmers leem. Medido: 683 linhas, 3 com `unit_cost`, 154 SKUs,
último 2026-06-14. **Nenhum leitor no frontend** (`grep` em `src/`: só `types.ts` e um doc).
⇒ apertar o SELECT para `cap_custo_ler`, mantendo a escrita por `service_role` (que bypassa RLS).
Impacto de UX: zero.

⚠️ Ao apertar este gate, **reler os asserts que dependiam do gate antigo** — o aperto transforma
fiscal em tautologia e nada no exit code avisa (corolário medido 3× no #1488).

**(d) Frontend** — `fmt()` já devolve `—` para `null` ([`RecommendationCard:10`](../../../src/components/RecommendationCard.tsx)),
então a degradação já é honesta. `score_final` sai do tipo top-level e passa a ser lido de `_admin`.

**O strip client-side de `useRecommendationEngine:69-75` SAI** — decisão revista durante a
implementação. Manter "como defense-in-depth" seria errado: `isAdmin` é `role === 'master'`,
**estritamente mais restrito** que `cap_custo_ler` (que também concede a `employee` `estrategico`/
`super_admin`). Duas autoridades discordando não é profundidade, é uma tela que **esconde de quem o
servidor autorizou**. A presença de `_admin` na resposta **é** a resposta do servidor. O toggle
`showAdminBreakdown` segue como controle de **exibição** e já exige `item._admin` — fail-closed por
construção se o servidor não mandar o bloco.

### 3.4 O que PR-A NÃO fecha — declarar no corpo do PR

Precisão>recall exige nomear o resíduo em vez de anunciar "custo fechado":

1. **Ordem + pertencimento ao top-N + distribuição sob chamadas repetidas** — declaração ampliada
   após o Codex. Eu tinha escrito só "a ordem"; é mais que isso:
   - `score_final` embute `eipN`, que embute margem ⇒ a ordenação devolve desigualdades.
   - **Entrar ou não no top-N é sinal por si só.** Custo desconhecido não é excluído (recebe
     `margemRank = 0`, [`:201`](../../../supabase/functions/recommend/index.ts)), mas cai no ranking
     — a **identidade do SKU omitido** é o canal. A *quantidade* devolvida, isolada, não é.
   - **Repetição amplifica.** Com `epsilon_exploration = 0,10` somando até `0,3` ao `score_final`
     ([`:276`](../../../supabase/functions/recommend/index.ts)), a *frequência* com que um par troca
     de posição em chamadas repetidas estima a diferença de `score_final` entre eles. O ruído que eu
     citei como defesa é, sob repetição, um **canal de medição**.
2. **1 bit por SKU — pela FRASE, não pela chave.** Correção do Codex, verificada por mim no código:
   `explanationKey` é **inicializado** como `"margin"` ([`:252`](../../../supabase/functions/recommend/index.ts))
   e o `else` final não o troca ⇒ `explanation_key === 'margin'` também vale para o fallback e
   **não prova nada**. Quem prova `margem > 50` é a frase *"tem alto potencial de margem"*, emitida
   só no ramo real. O resíduo existe, é 1 desigualdade por SKU (limiar **fixo**, não busca binária),
   e é **menor** do que eu havia declarado. Mantido de propósito: suprimir a frase degradaria a
   explicação para "boa adição ao mix", destruindo conteúdo legítimo para fechar 1 bit.
3. ⚠️ **Esconder `meta.weights` é defense-in-depth, não barreira** — achado da própria revisão
   adversarial desta sessão, contra a versão anterior deste spec. `recommendation_config` tem policy
   `master OR employee`: o mesmo usuário de quem escondemos os pesos na resposta lê
   `w_assoc/w_eip/w_sim/w_ctx` com um `select`. `farmer_association_rules` (idem) reconstrói
   `assoc_score`. **O que encarece de verdade a inversão é `score_final` ter saído da resposta** —
   sobram desigualdades (a ordem), não valores. Fechar a config é follow-up (§6.4), não gratuito:
   `useAnalyticsSync` lê **e escreve** a tabela numa tela de tuning.
4. `product_costs` **continua** com policy `master OR employee`. PR-A não toca a tabela.

### 3.5 Como se prova

- **PG17 (`prove-sql-money-path`)** para a migration: `pode_ler_custo` com `SET ROLE authenticated`
  + GUC (nunca `SET LOCAL` — em autocommit vira `WARNING` e o assert fica falso-verde), guard que
  **aborta** se `current_user ≠ authenticated`, e negativo por `SQLSTATE` + re-raise.
- **Assert de existência via `to_regprocedure('public.pode_ler_custo(uuid)')`**, nunca comparando
  `pg_get_function_identity_arguments` com string literal — ela inclui os NOMES dos parâmetros e
  **nunca casa** (o detector que não dispara, #1488).
- **Asserts sobre corpo de função rodam com comentários removidos**
  (`regexp_replace(pg_get_functiondef(oid), '--[^\n]*', '', 'g')`) — a própria migration é fonte do
  texto que o assert lê de volta (#1472/#1488).
- **Suíte Deno** (`test:edges`, `--no-remote` ⇒ **sem import remoto**): a projeção sai como **função
  pura** (`projetarRecomendacoes(candidatos, podeCusto)`) justamente para ser testável sem dep.
- **Falsificações EXECUTADAS**, cada uma com baseline VERDE antes e conferência de **contagem e
  nomes** dos vermelhos (contagem sozinha não prova que o vermelho é o certo):

  | # | sabotagem | vermelho observado |
  |---|---|---|
  | S1 | `pode_ler_custo()` → `SELECT true` | A4 (farmer não tem capability) virou `t` |
  | S2 | `GRANT EXECUTE TO anon` | A7 (anon não executa) virou `t` |
  | S3 | policy antiga (`master OR employee`) de volta | A10 (farmer lê 0) virou `3` |
  | S4 | **sem policy nenhuma** | A11 (master lê 3) virou `0` |
  | D1 | gate de projeção desligado (`if (false)`) | 3 testes Deno, nomeados e conferidos |
  | D2 | R$ de volta na prosa | 1 teste Deno, nomeado |

  **S4 é o controle positivo e o mais importante:** sem ele, "ninguém lê nada" passaria como
  sucesso — o assert de negação (A10) ficaria verde com a tabela quebrada. É o assert POSITIVO que
  tem de gritar quando a policy some.

  Resultado: **20 asserts de baseline + 4 falsificações no PG17 (exit 0)**, **10 testes Deno + 2
  falsificações**. O baseline B1–B4 roda **antes** da migration e prova o detector vendo o mundo
  vivo (farmer lendo as 3 linhas, e escrevendo) — sem isso, "lê 0 depois" não se distingue de
  "a query quebrou".

- **Codex adversarial** (`gpt-5.6-sol`, `xhigh`) antes de tirar do draft.

### 3.6 Entrega (3 camadas manuais do Lovable)

1. Migration custom no SQL Editor — **não auto-aplica**, falha silenciosa
2. **Deploy da edge `recommend` pelo chat do Lovable**, verbatim da `main`. ⚠️ Após o merge, conferir
   `git log -S pode_ler_custo` do arquivo **antes** de pedir o deploy — o sync bidirecional já
   reverteu wiring de edge 4h depois do merge (#1445→#1478)
3. Publish do frontend
4. `types.ts`: a RPC nova não regenera tipos sozinha — parte da entrega, senão a `main` fica vermelha
   e trava o auto-merge de todos os PRs abertos

**Ordem: edge → migration → verificar as duas → Publish.** Revista após o Codex — eu tinha
`migration → edge`, e ele mostrou que é a ordem *menos* fail-closed das duas:

| janela | com `migration → edge` (antes) | com `edge → migration` (adotada) |
|---|---|---|
| intermediária | a edge VELHA segue devolvendo custo ⇒ **o vazamento continua aberto** | a RPC ainda não existe ⇒ `podeLerCusto` recebe erro e devolve `false` ⇒ resposta **já redigida** |
| custo | nenhum | o master perde o breakdown até a migration entrar (degradação, não vazamento) |

Para um PR cujo objetivo é confidencialidade, fechar antes vale mais que evitar uma degradação
temporária e honesta. O `Publish` continua por último, **depois de confirmar que a edge nova está
servindo** — publicar o front antes de confirmar a edge é o único risco real que sobra aqui.

## 4. PR-B — os dois hooks (desenho, execução em sessão própria)

### 4.1 O achado que muda o desenho: a persistência re-arma o oráculo

Não estava no enunciado. Os dois engines **gravam** o resultado, e o que gravam inverte:

- `farmer_recommendations` guarda `m_ij` **e** `cluster_volume_estimate` na **mesma linha**. Como
  `m_ij = margem × volume` ([`useCrossSellEngine.ts:373`](../../../src/hooks/useCrossSellEngine.ts)),
  uma divisão dá a margem unitária exata. Verificado em prod: `134,26 / 2 = 67,13`.
- `farmer_bundle_recommendations.bundle_products` tem `"cost"` **literal** por SKU
  ([`useBundleEngine.ts:496`](../../../src/hooks/useBundleEngine.ts)). 12 linhas, 12 com custo. Sem
  inversão nenhuma.

RLS de ambas: `farmer_id = uid` ⇒ os 2 farmers leem as próprias linhas.

⚠️ **Calibragem honesta:** as linhas estão velhas (2026-05-12 e 2026-03-02) e **0 de 2.617** batem com
o custo atual — hoje é oráculo de margem **histórica** sobre 19 SKUs, não de custo corrente.
**O ponto é que o conserto re-arma:** mover o ranqueamento para o servidor faz a tabela voltar a ser
fresca, e aí o oráculo passa a ser corrente sobre o conjunto recomendado inteiro. Um PR que mova o
cálculo sem mexer na persistência **piora** a exposição.

### 4.2 RPC, não edge — e o corte que torna isto tratável

**A mineração de regras não toca custo.** `support`/`confidence`/`lift` saem de co-ocorrência de cesta
([`useBundleEngine.ts:289-365`](../../../src/hooks/useBundleEngine.ts)); `pij` sai de health score,
engajamento, aderência de cluster e taxa histórica. **Custo entra só no scoring** (`margin`, `mij`,
`lieBundle`).

⇒ Não é preciso reescrever os engines em SQL. A RPC recebe os candidatos **já pontuados na parte que
não toca custo** e devolve a ordem. Isso é `JOIN` + `ROW_NUMBER() OVER (PARTITION BY cliente ORDER BY
lie DESC)` — nativo em SQL, cabe no padrão `get_preco_cockpit`, ganha o harness `prove-sql-money-path`,
e a superfície de paridade TS×SQL encolhe para a fórmula da margem.

**Edge foi descartada** porque: (a) some o harness PG17 falsificável; (b) acrescenta um 2º deploy
manual e a exposição ao sync bidirecional; (c) a parte que sobra é set-based, exatamente o que o
Postgres faz melhor que um laço JS de ~3,8M iterações.

⚠️ **O peso é conhecido pelo cliente** — se a RPC devolvesse `lie`, então `margem = lie / peso` seria
inversão imediata. Só a **ordem** e a **faixa** saem sem `cap_custo_ler`.

### 4.3 Contrato da RPC (esboço)

`get_ranking_margem(p_itens jsonb)` — uma linha por candidato:

| campo | regra |
|---|---|
| `product_id` | — |
| `ordem` | posição no ranking — **sempre presente** |
| `faixa` | `verde\|amarelo\|vermelho\|neutro` — `neutro` obrigatório: SKU sem custo **não** é empurrado para cor |
| `mij`, `lie` | **só** com `cap_custo_ler`; senão `null` com a chave presente |

Persistência: `m_ij`/`cluster_volume_estimate` e `bundle_products.cost` **param de ser gravados juntos**
(ou a gravação passa a ser server-side com a leitura gatada) — senão o §4.1 volta.

### 4.4 Paridade — o risco principal

Mesma lista do spec irmão §4, valendo aqui: universo de pedidos (`confirmado|faturado|entregue`),
custo canônico (`cost_final` → `cost_price`, finito **e** > 0), ⚠️ `'NaN'::numeric` é valor legítimo em
Postgres e `Number.isFinite` o rejeita em TS — o SQL precisa excluir explicitamente, senão a paridade
quebra onde ninguém olha.

## 5. Alternativas descartadas

| alternativa | por que não |
|---|---|
| Fechar `product_costs` direto (`cap_custo_ler`) e deixar degradar | Os engines já excluem SKU sem custo (pós-#1471) ⇒ a lista dos 2 farmers fica **vazia**. Apaga a feature em vez de protegê-la — exatamente o que o spec irmão barrou. |
| Nulificar só `_admin.cost_final` na edge | Deixa `margin` top-level, `eip`, `score_final`+pesos e o R$ na prosa (§3.2). |
| Manter o strip client-side como proteção | O `fetch` já entregou. Fachada. |
| Agregado por cliente em R$ (mantendo o total da carteira) | `Σ kᵢ·margemᵢ` com `kᵢ` conhecido ⇒ sistema linear resolvível para SKUs recorrentes. Estreita, não fecha. Descartado pelo dono em favor de ordem+faixa. |
| Replicar `cap_custo_ler` em TS na edge | Deriva em **fail-open**: a edge acha que pode quando o banco diz que não. |
| Reescrever os engines inteiros em SQL | A mineração não toca custo — reescrevê-la é trabalho sem ganho de segurança e paridade cara (§4.2). |

## 6. Fora de escopo — follow-ups com evidência

1. **`/admin/reposicao/baixo-giro` degrada em silêncio** (§2.1): não-master vê `cmc`/`capital_parado`
   como "—" sem saber que é permissão. `cap_compras_ler` é master-only ⇒ nenhum comprador enxerga
   capital parado. Decisão de produto, não de segurança.
2. **A dívida latente `cap_carteira_ler` ⊃ `cap_custo_ler`**: hoje 0 usuários. No dia em que existir um
   `gerencial`, ele lerá `farmer_recommendations` da base inteira — e o §4.1 vale para ele sem o
   filtro `farmer_id = uid`.
3. **`derivarMargensCandidato` é helper espelhado** (`src/lib/custos/cost-source.ts:67` ×
   `supabase/functions/recommend/index.ts:59`) sem guard textual `MIRROR-START/END` nem canária. O
   `money-path.md` exige um dos dois para lógica replicada.
4. **`recommendation_config` legível por `employee`** (medido: policy `master OR employee`; contém
   `w_assoc=0.25`, `w_eip=0.35`, `w_sim=0.20`, `w_ctx=0.20`, `epsilon_exploration`, e ainda
   `margem_default_global/minima/maxima`). Enfraquece o gate de `meta.weights` do PR-A (§3.4.3) e
   entrega os parâmetros de política de margem. **Não é trivial de fechar:**
   `src/components/analyticsSync/useAnalyticsSync.ts:55,127` **lê e escreve** a tabela numa tela de
   tuning sob `GestaoAdmin` — fechar exige decidir se tunar peso de recomendação é ato de `master`,
   de `cap_custo_ler`, ou se a escrita vira RPC. Decisão de produto antes do diff.
