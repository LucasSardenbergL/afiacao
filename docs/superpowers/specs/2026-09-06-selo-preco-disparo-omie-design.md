# Selo de preço no disparo — "disparado = aprovado" no OMIE (2026-09-06, v10)

> Money-path de compras. Origem: decisão **§8.4 do PR #2187** (spec
> `2026-09-05-selo-aprovacao-pedido-sayerlack-design.md`, branch `claude/frosty-goodall-f12941`), que
> deixou `preco_unitario`/`valor_linha` **fora** das colunas seladas de propósito — o selo de lá
> protege o que o PORTAL recebe. Esta é a outra metade: o que o **Omie** recebe. O Codex registrou o
> desacordo como P2-13 no challenge do desenho v1 do #2187.
> Contexto vivo: `docs/agent/reposicao.md` §Portal Sayerlack, `docs/agent/money-path.md`,
> `docs/historico/portal-sayerlack-fator-aprovado-vs-vivo.md`.
> **Status: desenho aprovado pelo founder em conversa (2026-09-06); implementação EM FILA atrás do
> #2187, que ainda é DRAFT e do qual esta fatia consome infraestrutura (§2).**
>
> 🔴 **DUAS RODADAS DE CHALLENGE CODEX, as duas "não aprovar".** Toda alegação factual foi conferida
> por mim contra o código antes de entrar no spec.
> - **Rodada 1** sobre a v2 (`max · tentativa 2 · 908s · 165.313 tokens`; a 1ª tentativa caiu por cota
>   e a janela resetou): 5 achados, um deles **P0** — o selo era forjável pela própria porta (§9.1).
> - **Rodada 2** sobre a v4 (`max · tentativa 1 · 401s · 156.347 tokens`): os ataques antigos estavam
>   fechados, mas **a minha correção do P0 introduziu duas regressões** — escalada de privilégio na
>   porta humana e quebra da aprovação (§9.7).
>
> - **Rodada 3** sobre a v5 (`max · tentativa 1 · 422s · 164.718 tokens`): a correção de capability
>   fechou; **mas o "primeiro selo apenas" quebrou a aprovação legítima e o split lava preço** (§9.8).
>
> ✅ **A v7 TROCA A FORMA** (decisão do founder, 2026-09-06, §11.2). Sai o hash por pedido com função
> de selar; entra **procedência POR LINHA, carimbada pelo próprio trigger** no mesmo statement que
> escreve o preço. Os cinco achados fecham **por construção**, não por remendo — não há selo para
> forjar, nem selador para chamar, nem "primeiro selo" para disputar, nem GUC, e o carimbo **viaja com
> a linha** no split. A aprovação, a captura do portal e o split **deixam de ser tocados** por este spec.
>
> - **Rodada 4** sobre a v7 (`max · tentativa 1 · 425s · 161.439 tokens`): *"as regressões anteriores
>   de aprovação, capability e GUC **não se reabrem** pela forma descrita"* — a troca de forma
>   funcionou. Mas **não aprovar**: o próprio ROLLOUT fabricava procedência válida para preço
>   adulterado, e a fronteira pré-aprovação continuava aberta (§9.9).
>
> ✅ **Decisão do founder (§9.9.2): `preco_unitario` entra no token `p_itens_vistos` do #2187.**
> É o que fecha a fronteira pré-aprovação sem constranger o motor. ⚠️ **Cria dependência cruzada com o
> #2187** — ver §2.1.
>
> - **Rodada 5** sobre a v9 (`max · tentativa 1 · 507s · 123.447 tokens`): **corte atômico do §6
>   confirmado como suficiente**. Mas o token do §2.1 tinha um P1 (a releitura no clique incorpora o
>   preço adulterado ao próprio token) e o reparo do §5.4 um P2 (produz capturas fictícias no sensor).
>   Acatados — §9.10.
>
> 🔴 **A v10 ainda NÃO foi desafiada.** Rodada 6 é pré-condição da implementação, e não roda nesta
> sessão (contexto). É a primeira tarefa de quem retomar.

## 1. A invariante — e por que NÃO é igualdade

O enunciado ingênuo — "o preço no PO é o preço da aprovação" — é **literalmente falso no único fluxo
que existe em produção**, e implementá-lo recusaria todo pedido Sayerlack cuja captura de custo
funcionasse.

`sayerlack_aplicar_custo_portal` (migration `20260905090000`) só grava sob CAS
`omie_pedido_compra_numero IS NULL AND status_envio_portal = 'sucesso_portal'`: **por desenho ela roda
depois da aprovação e antes do PO**, trocando a estimativa do motor pelo custo PROVADO do portal. A
ordem real é `aprovar → portal (async) → sucesso_portal → captura de custo → conciliação →
IncluirPedCompra lendo preço fresco`.

A invariante executável é **procedência**, não igualdade:

> Todo `nValUnit` e todo `nQtde` que chegam ao `IncluirPedCompra` foram escritos por uma porta
> **autorizada naquele momento** — motor (pré-aprovação), humano preenchendo custo de 1ª compra
> (preço ausente), ou captura do portal (pós-`sucesso_portal`, pré-PO). Nunca por um UPDATE sem
> procedência. Divergência é recusa do pedido **antes de qualquer efeito no Omie**.

## 2. Dependência do #2187 (esta fatia NÃO é standalone)

⚠️ **O #2187 está EM RECONSTRUÇÃO** (conferido em 2026-09-06, imediatamente antes de abrir este PR):
o Codex reprovou a M1 dele, e a sessão irmã a refez "sobre a main (guard atômico)", ainda marcada
`NÃO PRONTA`. Os cinco símbolos de que esta fatia depende sobrevivem à reconstrução
(`aprovacao_selo`, `reposicao.selo_bypass`, `reposicao_selar_pedido`, `reposicao_selo_itens`,
`p_itens_vistos`), mas **a FORMA do guard mudou** — e é dentro dele que o ramo `SP006` do
§4.3 se enxerta. **Re-conferir §4.5 contra a versão final do guard antes de implementar**; se o
guard atômico não tiver mais o ponto de enxerto que este spec assume, §4.5 é reescrita, não adaptada.

⚠️ **A classe de SQLSTATE `SA` é do #2187 e está se movendo.** Conferido contra a M1 real em
2026-09-06: `SA001` e `SA003`–`SA008` já estão ocupados, e o `SA008` de lá é *'Pedido % mudou de
estado durante a aprovação'* — a v3 deste spec colidia com ele. Por isso os ramos daqui usam a classe
**`SP`**, mesmo vivendo dentro das funções do #2187. **Ao implementar, re-conferir os códigos livres:
esta lista envelhece a cada commit de lá.**

Consome, sem reimplementar: a RPC `aprovar_pedido_sugerido` de 3 args, o trigger de
`pedido_compra_item`, o GUC de bypass (`reposicao.selo_bypass`, honrado só com
`current_user IN ('postgres','service_role')`), `reposicao_selo_itens`, `aprovacao_selo` e
`reposicao_pedido_e_portal`. Acrescenta um ramo ao trigger existente — **não cria um segundo trigger
na mesma tabela**. Se o #2187 for reprovado ou remodelado, este spec é reescrito, não adaptado.

### 2.1 🔴 Requisito que este spec IMPÕE ao #2187 (leitura obrigatória para quem mexe lá)

**`preco_unitario` tem de entrar no token `p_itens_vistos`** da RPC `aprovar_pedido_sugerido` de 3 args
(§3.4.3 do spec do #2187), ao lado de `id`, `sku_codigo_omie`, `qtde_final` e `fator_embalagem_portal`.
Comparação com `trim_scale` + `IS DISTINCT FROM`, como os demais campos numéricos.

**Por quê:** medido em prod (2026-09-06), `gerar_pedidos_sugeridos_ciclo`,
`gerar_pedidos_oportunidade_ciclo`, `aplicar_promocoes_no_ciclo` e `remover_itens_pedido_sugerido` são
**todas `SECURITY INVOKER` e executáveis por `authenticated`** — logo, com um humano rodando o ciclo
pela tela, `current_user` é `authenticated`, o mesmo de um UPDATE cru. O trigger deste spec **não
consegue** separar os dois na fase pré-aprovação (§9.9.2). Quem separa é o token: ele já compara "o que
você viu" contra "o que está lá" no instante da aprovação, e um campo a mais faz a aprovação recusar o
caso realista — **a aba velha que grava preço por cima entre a leitura e a aprovação**.

🔴 **E o token tem de vir do snapshot APRESENTADO, não de uma releitura no clique** (§9.10). O spec do
#2187 manda `PedidoRow`/lote buscarem os itens *imediatamente antes de aprovar* — o que permite
`tela mostra 10 → outra aba grava 100 → o clique busca 100 → o token contém 100 → aprovação aceita`.
Os locks protegem **comparação→aprovação**, mas a alteração aconteceu **antes da busca**. O token
comprova **correspondência com o snapshot**, não procedência nem visualização humana — e isso precisa
constar expressamente lá.
Requisito: o token vem do snapshot que foi exibido e confirmado (inline **e** em lote —
`useCicloHoje.ts:92` aprova os IDs selecionados sem revisão intermediária); releitura divergente
**interrompe** a aprovação e exige nova revisão. Testar a sequência completa: só testar
`token=10 × banco=100` **não cobre o furo**.

**Não contradiz a §8.4 do #2187:** lá a decisão foi manter preço fora do **selo**. O token é outra
coisa — anti-TOCTOU de leitura, não procedência. O selo continua sem preço.

**Se o #2187 recusar este requisito**, o risco pré-aprovação volta a ficar aberto e este spec tem de
registrá-lo como risco aceito, com o caso da aba velha nomeado.

## 3. O que existe hoje (medido em prod via psql-ro, 2026-09-06)

- **Nada do #2187 está aplicado.** `aprovacao_selo` / `portal_recusa_motivo`: 0 colunas.
  `pedido_compra_item`: **0 triggers**. Os 3 triggers de `pedido_compra_sugerido` são outros
  (`trg_analytics_outbox_pedido_compra`, `trg_po_inexistente_antes_de_guard`,
  `trg_set_status_envio_portal`).
- **A janela é 100% Sayerlack.** Dos pedidos com PO no Omie em 120 dias, **123 de 123** são
  OBEN/Sayerlack. Aprovação → PO: p50 **1 min**, p90 **28 min**, máx **20.032 min (~14 dias)**. Não
  existe disparo não-portal nesse recorte — mas o guard é desenhado no `IncluirPedCompra`, que é
  universal, e não no predicado de portal: escopá-lo a Sayerlack deixaria o buraco aberto no dia em
  que um fornecedor não-portal entrar.
- **Escritores de `preco_unitario` / `valor_linha`, auditados:**

  | Writer | Quando | Papel | Freio hoje |
  |---|---|---|---|
  | motor (`gerar_pedidos_sugeridos_ciclo`, `gerar_pedidos_oportunidade_ciclo`, `aplicar_promocoes_no_ciclo`) | INSERT; pedido nasce `pendente_aprovacao` | invoker | pré-aprovação |
  | UI de 1ª compra (`preco-edit.ts` → PostgREST cru) | `pendente_aprovacao` / `bloqueado_guardrail` / `falha_envio`, só se preço ≤ 0 | `authenticated` + `cap_compras_ler` | **só o cliente** |
  | `sayerlack_aplicar_custo_portal` | pós-`sucesso_portal`, pré-PO | `service_role`, CAS no banco | ok, sem rastro selável |
  | `reposicao_persistir_qtde_inteira` | **no disparo, em produção** | SECDEF | reescreve **só `valor_linha`** (`ceil(qtde_final) * preco_unitario`) |

- **Policies de `pedido_compra_item`:** `staff_pedido_compra_item_{select,insert,update,delete}` são
  `cap_compras_ler` por linha, em qualquer status do pai. Qualquer staff de compras altera item por
  `id`. Aba velha fura.
- **`falha_envio` é caminho vivo, não hipótese.** A edge grava em qualquer throw de `processarPedido`
  (`index.ts:1163`), inclusive no guard "SKU(s) sem custo"; o reprocesso aceita
  `["aprovado_aguardando_disparo","falha_envio"]` (`index.ts:1578`). Zero linhas nesse status **hoje**
  é medida de status atual, não de histórico — é estado transitório. **152 itens sem custo em 72
  pedidos** nos últimos 120d: a 1ª compra é comum.
- **A captura de custo está sem sinal.** Deployada em 05/09. Denominador ~10 `sucesso_portal`/semana;
  **1 pedido** com `captura_custo`, e nele `atualizados = 0`. **Não existe tabela de auditoria de
  `pedido_compra_item` nem coluna `atualizado_em`** — não dá para medir retroativamente se algum preço
  já mudou pós-aprovação. Ausência de dado, não aprovação.
- **Um único call site chega ao Omie:** `IncluirPedCompra` em `index.ts:1057`. O segundo `select` de
  itens (`index.ts:1761`) é só o e-mail de notificação, pós-PO.

## 4. Forma — procedência POR LINHA, carimbada na escrita

> **v7.** As v1–v6 usavam um hash por pedido (`preco_selo`) gravado por uma função de selar. Três
> rodadas de challenge derrubaram essa forma pelo mesmo motivo estrutural (§11): selar era um ato
> **separável** da escrita, e a autoridade para selar vinha sempre de um proxy fraco. Aqui não há selo,
> não há função de selar, e não há nada para autorizar a selar.

### 4.1 `valor_linha` fica fora — e por quê

`reposicao_persistir_qtde_inteira` reescreve `valor_linha` no disparo, em produção, pós-aprovação; e
`valor_linha` **nunca chega ao Omie** (o payload é `nValUnit: Number(preco_unitario)` e
`nQtde: Math.ceil(Number(qtde_final))`, `index.ts:984-985`). Protegê-lo custaria uma porta a mais por
nada na fronteira do dinheiro.

⚠️ Mas o desvio **não é "só relatório"** (era erro meu, §9.3): o gate de valor mínimo lê
`pedido.valor_total` (`index.ts:358`) antes da recomputação. Total deslocado flipa um gate de dinheiro.
Isso vira chip próprio (§10) — e **não** exige `valor_linha` no mecanismo daqui.

### 4.2 Estado novo — duas colunas na PRÓPRIA linha

Em `pedido_compra_item`: **`preco_origem text`** e **`preco_gravado_em timestamptz`**.

`preco_origem ∈ ('motor','primeira_compra','portal_captura','manual_sql','backfill')`.

Nada em `pedido_compra_sugerido` além de `preco_recusa_motivo text` (§5.3). **Não há `preco_selo`.**

O sensor (§4.6) deixa de precisar de tabela própria: a procedência e o instante moram na linha, e o
delta sai de `pedido_compra_item` cruzado com o histórico do próprio carimbo. Uma tabela append-only
`reposicao_preco_origem_log(item_id, pedido_id, de_preco, para_preco, origem, em)` continua útil como
série temporal para o teto (§4.6) — **escrita pelo MESMO trigger**, nunca por chamador.

### 4.3 O trigger CARIMBA — e é por isso que não há o que forjar

Ramo novo no trigger `BEFORE INSERT OR UPDATE ON pedido_compra_item` do #2187. Para cada linha:

1. **O carimbo nunca é input.** Se o statement escreve `preco_unitario` (INSERT, ou UPDATE com
   `NEW.preco_unitario IS DISTINCT FROM OLD.preco_unitario`), o trigger **sobrescreve**
   `NEW.preco_origem` e `NEW.preco_gravado_em` com valores que ele mesmo calcula. O que o chamador
   tenha posto nessas colunas é descartado, sempre.
2. **Se o statement NÃO escreve preço**, o trigger força
   `NEW.preco_origem := OLD.preco_origem` e `NEW.preco_gravado_em := OLD.preco_gravado_em` — senão
   alguém reescreveria o carimbo sozinho, que é o mesmo furo por outra porta.
3. **A autorização e o rótulo saem do MESMO par** `(estado do pai × current_user)`, avaliado do mais
   específico para o menos. Par não previsto → **`SP006`**, nunca um rótulo adivinhado:

   | estado do pai | `current_user` | carimbo |
   |---|---|---|
   | `pendente_aprovacao` / `bloqueado_guardrail` | qualquer um que a RLS deixe passar | `motor` no INSERT, `primeira_compra` no UPDATE |
   | `status_envio_portal='sucesso_portal'` **e** `omie_pedido_compra_numero IS NULL` | owner (SECDEF da captura) | `portal_captura` |
   | `falha_envio` | owner (SECDEF da 1ª compra) | `primeira_compra` |
   | qualquer | `postgres` (SQL Editor) | `manual_sql` |
   | resto | — | **`SP006`** |

   Precedência: a linha do portal vem **antes** da de `falha_envio`, porque um pedido pode estar em
   `status='falha_envio'` com `status_envio_portal='sucesso_portal'`. Ambiguidade resolve para a regra
   mais específica, e o risco residual é **de RÓTULO** (atribuição no sensor), nunca de autorização —
   os dois pares são autorizados de qualquer forma.

🔴 **O trigger NÃO pode ser `SECURITY DEFINER`** — ele decide sobre a identidade do executor, e
SECDEF trocaria justamente essa identidade, tornando a decisão circular. Verificar no catálogo
(`prosecdef = false`) na postcondição da migration e nos testes (§9.9).

**`authenticated` não escreve `preco_unitario` em nenhum estado pós-aprovação.** Quem escreve em
`falha_envio` é a RPC de 1ª compra, que é SECDEF (§4.4). Autorização por **estado + `current_user`**,
sem GUC — alinhado com a M1 do #2187 (*"a M2 autoriza por ESTADO, que é mais forte que um GUC"*), e
fechando o P2 da rodada 3: um GUC não autentica quem o definiu.

### 4.4 As portas — agora elas só ESCREVEM; o carimbo é consequência

| Porta | Quando | Muda o quê |
|---|---|---|
| motor (`gerar_pedidos_*`, `aplicar_promocoes_no_ciclo`) | INSERT, pedido nasce `pendente_aprovacao` | **nada** — já passa, e ganha carimbo `motor` de graça |
| `reposicao_definir_custo_primeira_compra` **nova** | `pendente_aprovacao` / `bloqueado_guardrail` / `falha_envio` | escreve preço; o trigger carimba |
| `sayerlack_aplicar_custo_portal` | pós-`sucesso_portal`, pré-PO | **nada** — a RPC não muda; o trigger carimba |
| `aprovar_pedido_sugerido` (#2187) | aprovação | **nada. A aprovação NÃO é tocada por este spec** |
| `pedido_compra_split` | disparo | **nada** — ver §4.4.2 |

🔴 **Isto é o ganho central da v7, e cada linha "nada" fecha um achado:**
a aprovação não chama selador nenhum (fecha o P1 da rodada 2 — ela é `SECURITY INVOKER` e não teria
privilégio); não existe "primeiro selo" para a 1ª compra disputar com a aprovação (fecha o P1 da
rodada 3); e o `sayerlack_aplicar_custo_portal` volta a ser exatamente o que já está em produção.

#### 4.4.1 `reposicao_definir_custo_primeira_compra(p_pedido_id, p_itens)`

`SECURITY DEFINER`, `search_path` fixo. `p_itens = [{item_id, preco_unitario}]`.

🔴 **O gate é a capability EXATA que a RLS exigia** — `private.cap_compras_ler(auth.uid())`, senão
`42501` —, e **`auth.uid() IS NULL` NÃO passa**. Conferido em prod: `cap_compras_ler` é
`has_role(_uid,'master')`, **só master**. A v4 copiou o gate do `sayerlack_aplicar_custo_portal`
(`employee OR master`), o que dava a `employee` uma escrita reservada a `master` (§9.7). E a expressão
de lá deixa `auth.uid() IS NULL` passar **de propósito**, porque quem chama é a edge com
`service_role` — copiá-la para porta humana inverte o sentido. Não trocar por `cap_compras_escrever`:
ela nasceu para a telemetria do motor, outra superfície (rodada 3). `REVOKE EXECUTE` de `PUBLIC` e
`anon` por nome.

1. Pedido `FOR UPDATE`; status ∈ `('pendente_aprovacao','bloqueado_guardrail','falha_envio')`, senão `SP003`.
2. Payload: array não vazio, `item_id` inteiro, `preco_unitario` **NOT NULL**, `<> 'NaN'::numeric`,
   `> 0`, `< 'Infinity'::numeric` — os três lados (`'NaN'` e `'Infinity'` **passam** em `> 0`). Senão `SP004`.
3. Cada item pertence ao pedido **e tem `coalesce(preco_unitario,0) <= 0` agora** — só PREENCHE, nunca
   troca preço bom. `ROW_COUNT <> n` → `SP005`, ROLLBACK de tudo.
4. `valor_linha = ceil(qtde_final) * preco_unitario` nas linhas tocadas; `valor_total` recomputado.

Não há passo 5: o carimbo é do trigger.

**UI:** `useDetalhesModal` troca o `update` PostgREST de preço (`useDetalhesModal.ts:170`) pela RPC.

#### 4.4.2 Split — o carimbo VIAJA COM A LINHA

`pedido_compra_split` move `pedido_id` das linhas. `preco_origem` e `preco_gravado_em` **vão junto,
porque são colunas da linha** — o filho herda a procedência do item, e não ganha procedência nova por
ser um pedido novo.

🔴 É isto que fecha o P1 da rodada 3, e por construção: lá, o split criava o **primeiro selo** dos
filhos e assim lavava um preço divergente do pai *sem nunca chamar a entrada pública*. Aqui não há
selo de pedido para nascer — não há o que lavar. O split não precisa conferir o pai, e **não é
alterado por este spec**.

Cuidado que fica: o trigger vê o UPDATE de `pedido_id`. Como ele **não** toca `preco_unitario`, cai no
passo 2 do §4.3 (preserva o carimbo) e não em `SP006`.

### 4.5 O que continua guardado no pedido

Nada de selo. O #2187 segue dono das transições de status e da imutabilidade do `aprovacao_selo`; este
spec não acrescenta ramo em `pedido_compra_sugerido`. **`SP007` deixou de existir** — era o ramo do
GUC, e o GUC saiu (rodada 3, P2).

### 4.6 O sensor — é ele que decide o teto depois

Procedência agora, teto depois com número medido (decisão §8.2). Com o carimbo na linha o sensor fica
mais fino do que era com o hash por pedido — o delta é **por item**:

```sql
SELECT origem,
       count(*) AS escritas,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (para_preco-de_preco)/de_preco*100)::numeric, 2) AS p50_delta_perc,
       round(max((para_preco-de_preco)/de_preco*100)::numeric, 2) AS max_delta_perc
  FROM reposicao_preco_origem_log
 WHERE em > now() - interval '30 days' AND de_preco > 0
 GROUP BY 1;
```

Denominador ao lado: `sucesso_portal` por semana (hoje ~10). A fatia do teto **só nasce** com ≥ 4
semanas de `origem='portal_captura'` e escritas > 0 — "está no ar e ninguém reclamou" é ausência de
dado.

## 5. A fronteira: asserção antes do `IncluirPedCompra`

### 5.1 `reposicao_conferir_disparo_omie(p_pedido_id bigint, p_itens jsonb)`

`RETURNS TABLE(ok boolean, motivo text, divergencias jsonb)`. `STABLE`, `SECURITY INVOKER`,
`search_path` fixo, EXECUTE só para `service_role`.

Recebe **exatamente o que a edge está prestes a mandar** — `[{item_id, n_val_unit, n_qtde}]`, derivado
do próprio `produtos_incluir`, **não de uma releitura**. Motivos, na ordem de avaliação:

| motivo | condição |
|---|---|
| `preco_origem_ausente` | alguma linha com `preco_origem IS NULL` ou `preco_gravado_em IS NULL` |
| `preco_origem_invalida` | alguma linha com `preco_origem` fora do conjunto permitido |
| `payload_divergente` | correspondência um-para-um quebrada, ou `n_val_unit IS DISTINCT FROM preco_unitario`, ou `n_qtde IS DISTINCT FROM qtde_final` |

**Correspondência um-para-um, não igualdade de conjuntos** (§9.5): `p_itens` tem de ser array válido,
com `item_id` **únicos**, e cardinalidade igual à contagem de itens do pedido —
`count(*) = count(DISTINCT item_id) = (SELECT count(*) FROM pedido_compra_item WHERE pedido_id = …)`.
Sem isso, um payload que repete `{id:7, preço:10, qtde:2}` mantém o mesmo CONJUNTO de ids, satisfaz
toda comparação individual, e passaria com **quantidade total dobrada**. Não há produtor disso hoje
(o `.map` parte das linhas do banco) — é defeito de CONTRATO, e contrato se fecha no contrato.

Comparação de `numeric` em SQL com `IS DISTINCT FROM`: o `Number()` do TS colapsa decimais distintos
(P2-12 do Codex no #2187). Comparar o valor **enviado** contra o banco é mais estrito que
banco-contra-banco — se o `Number()` deturpar o preço, o PO sairia deturpado e nós saberíamos.

⚠️ **Honestidade sobre o que esta conferência prova.** A **prevenção** mora no trigger (§4.3), que é
`BEFORE … FOR EACH ROW` e sobrescreve o carimbo: enquanto ele existir, não há como escrever preço sem
ser carimbado. A conferência é **defesa em profundidade** contra linha **não carimbada** — legado,
backfill incompleto, ou uma janela em que o trigger não estivesse ativo. Ela **não** detecta uma
escrita crua feita com o trigger desabilitado, e nenhum esquema puramente-em-banco detectaria: quem
escreve controla todas as colunas. O hash das v1–v6 tinha a mesma limitação — só que com uma função de
selar a mais para abusar.

⚠️ **A conferência de SELO de quantidade não está aqui** (decisão §9.2): ela criava recusa **sem
recuperação**. O que fica de quantidade é **transporte** — `n_qtde` contra a linha do banco —, e isso
não tem o beco: transporte divergente é bug de código da edge, corrigível e reprocessável. A prevenção
de quantidade segue sendo do #2187.

### 5.2 Onde entra na edge

Colada no único call site (`index.ts:1057` — verificado: é o único `IncluirPedCompra` executável),
depois de montar `produtos_incluir`, ao lado do `lerMarcoPreOmie`, que já tem essa disciplina — **com o
sinal invertido, e o comentário tem de dizer por quê**: `lerMarcoPreOmie` é fail-**open** de propósito
(perder o marco é melhor que perder o PO); esta é fail-**closed** — erro da RPC, `ok=false`, resposta
vazia ou fora de forma = recusa. Degradar é certo no sensor, errado no que move dinheiro.

O `select` de itens (`index.ts:842`) passa a trazer `id`.

**Roda nos DOIS modos.** `dry_run` chama `IncluirPedCompra` incondicionalmente e **cria PO real no
Omie** (`index.ts:454-457`); pular a conferência lá seria o mesmo furo com outro nome.

### 5.3 Na recusa

`throw` com o motivo → o `catch` que já existe grava `falha_envio` (`index.ts:1163`). **Nenhum estado
terminal novo, nenhuma máquina de estados nova.** `preco_recusa_motivo` guarda o motivo, e é limpo na
próxima escrita autorizada de preço (o mesmo trigger que carimba).

| motivo | recuperação |
|---|---|
| `preco_origem_ausente` / `preco_origem_invalida` | **procedimento de reparo do §5.4** — reescrever o mesmo preço NÃO recarimba |
| `payload_divergente` (transporte) | bug de código da edge — corrigir, deployar, reprocessar. Nada a recarimbar |

Para Sayerlack a recusa acontece **depois** de o portal já ter recebido o pedido: fornecedor tem a
ordem, Omie não tem o PO. É estado operacional real, e é o **correto** — PO faltando é recuperável por
conciliação; PO com preço errado é dinheiro saindo errado.

### 5.4 Reparo de carimbo ausente — e por que o óbvio não funciona

🔴 `UPDATE ... SET preco_unitario = 10` numa linha que **já** vale 10 **não entra no ramo de
carimbar**: o gatilho é `NEW.preco_unitario IS DISTINCT FROM OLD.preco_unitario`, e não há distinção.
Pior: o passo 2 do §4.3 então **restaura os NULLs antigos**. Passar `preco_origem` no UPDATE não ajuda
— o trigger descarta input. A captura do portal escrevendo os mesmos 10 dá no mesmo (§9.9.3).

Procedimento (SQL Editor, `postgres`, **uma transação**), a ser testado como parte da prova:

```sql
BEGIN;
UPDATE pedido_compra_item SET preco_unitario = preco_unitario + 1 WHERE id = :id;  -- entra no ramo
UPDATE pedido_compra_item SET preco_unitario = :preco_correto  WHERE id = :id;     -- carimba manual_sql
COMMIT;
```

🔴 **O reparo tem de ser IDENTIFICÁVEL, senão polui o sensor** (§9.10). Com `owner=postgres`,
`sucesso_portal` e PO ausente, os dois UPDATEs caem em **`portal_captura`** — que precede `manual_sql`
na tabela do §4.3 —, e `10→11→10` deixa no log **+10% e −9,09%** como se o portal tivesse mexido no
custo. Meu comentário "carimba `manual_sql`" **contradizia a minha própria tabela de precedência**.

Correção: `SET LOCAL reposicao.reparo_carimbo = 'on'`, honrado **só** com `current_user = postgres`,
força a origem `manual_sql`; e o sensor do §4.6 **exclui `manual_sql` da amostra de captura**.
⚠️ Este GUC é de **ROTULAGEM, nunca de autorização** — é a distinção que o torna aceitável depois de a
rodada 3 ter derrubado o GUC como mecanismo de autoridade: o pior caso aqui é alguém rotular errado a
própria escrita no sensor, não obter permissão que não tinha.

O teste é **recusa → reparo → disparo válido**, com o preço final idêntico ao inicial **e** verificando
origem gravada e efeito no sensor. Sem isso, a "recuperação" do §5.3 é promessa não executável.

⚠️ Recuperação de preço é **do founder, não do operador**: como `authenticated` não escreve preço
pós-aprovação, a RPC de 1ª compra só resolve "preço ausente". Preço válido a corrigir é SQL Editor.

## 6. Rollout expandir → ativar (3 camadas manuais; a ordem é a diferença entre nada quebrar e fila presa)

1. **M1 — expandir (nada recusa escrita).** Colunas `preco_origem`/`preco_gravado_em` em
   `pedido_compra_item`, `preco_recusa_motivo` no pedido, `reposicao_preco_origem_log` + RLS,
   `reposicao_conferir_disparo_omie`, `reposicao_definir_custo_primeira_compra`. `NOTIFY pgrst,
   'reload schema'`; regenerar `src/integrations/supabase/types.ts`. `DO $post$` relê o catálogo
   (existência, SECDEF onde previsto, `search_path` preso, `anon`/`authenticated` sem EXECUTE onde
   previsto, **e que `cap_compras_ler` é a capability usada na porta humana**).
   🔴 **CORTE ATÔMICO: o backfill e a ativação do ramo são a MESMA transação** (§9.9.1). A v7 punha o
   backfill na M1 e o ramo na leva seguinte, e **o próprio rollout fabricava procedência válida para
   preço adulterado**: entre um e outro, um `master` fazia `UPDATE preco_unitario=100` sem tocar o
   carimbo, e o carimbo de 10 ficava **colado ao preço 100** — a conferência depois passava (origem
   presente, permitida, transporte batendo) e o Omie recebia 100. *"Mesma leva" não define ordem entre
   operações manuais.*
   Portanto, numa transação só: `LOCK TABLE pedido_compra_item IN SHARE ROW EXCLUSIVE MODE` →
   backfill (`preco_origem='backfill'`, `preco_gravado_em=now()`) para itens de pedidos em estado
   não-terminal → **criar o ramo do trigger** → commit. Sem janela para escrita concorrente.
   O backfill carimba o que estiver lá — não há como saber se foi adulterado, e recusar toda a fila em
   voo seria pior; `backfill` fica visível como origem própria. **Depois do commit, `NULL` significa
   "linha que ninguém carimbou" — e recusar é correto.**
   Nem `aprovar_pedido_sugerido`, nem `sayerlack_aplicar_custo_portal`, nem `pedido_compra_split` são
   recriadas — a v7 não as toca (§4.4). Isso encolhe a M1 e elimina o pré-voo `pg_get_functiondef`
   sobre três funções que outra sessão está reconstruindo.
2. **Deploy da edge + Publish — DEPOIS do commit da M1** (o ramo já está ativo; a edge nova depende
   dele). Publish não fecha aba antiga (o SW só
   troca de build quando o cliente clica) — uma aba velha em `falha_envio` gravaria preço por PostgREST
   cru **sem carimbo**, e a edge nova recusaria; pior, atualizar a UI depois não salvaria, porque o
   preço já seria positivo e a RPC nova responderia `SP005` (§9.4). Com o ramo `SP006` ativo **junto**,
   a escrita da aba velha é **recusada no banco**: o preço fica ≤ 0 e a RPC nova ainda resolve.
   ⚠️ Uma query de "zero pedidos em `enviando_portal`" **não fecha a janela de UPDATE dos itens** — foi
   por isso que o corte virou transacional no passo 1, e não uma pré-condição medida (§9.9.1).
3. **Sensor da fase seguinte:** §4.6.

Deploy da edge decidido por `bun run pendencias:deploy` (ledger `deploy_atestacoes`), não pelo diff do
PR.

## 7. Prova

- **PG17 `db/test-reposicao-preco-origem.sh`** (`-v ON_ERROR_STOP=1` + marcador positivo de fim;
  asserts negativos casam a **SQLSTATE exata** e re-lançam o resto; cenários humanos sob
  `SET ROLE authenticated` + GUC do JWT).

  🔴 **O teste decisivo — `adulterar → tentar carimbar → conferir disparo`.** Cada cenário tem **DUAS**
  asserções, e a v4 errava a segunda (§9.7): o ataque é **recusado** *e* **o estado fica intacto**,
  portanto **o disparo legítimo seguinte PASSA**. "Em todos o disparo recusa" estava errado — se o
  `UPDATE 10→100` foi barrado, banco e carimbo seguem em 10, e recusar o disparo de 10 quebraria o
  fluxo real em vez de protegê-lo.

  Como `authenticated`: (a) UPDATE de preço em `falha_envio` → `SP006`, preço segue 10, **disparo
  passa**; (b) UPDATE de preço → NULL pós-aprovação → `SP006`, **disparo passa** (fecha a ausência
  fabricada); (c) UPDATE que muda **só** `preco_origem`/`preco_gravado_em`, sem tocar preço → o
  carimbo antigo é preservado (passo 2 do §4.3), nada muda; (d) INSERT/UPDATE passando `preco_origem`
  escolhido pelo chamador → o trigger **sobrescreve**, e o valor gravado é o que ele calculou;
  (e) variante A/B: a adulteração de A é barrada em (a); a RPC de 1ª compra recebe **só B** (que está
  ≤ 0) e **deve SUCEDER** — recusar B por causa de A, que nem está no payload, mudaria o ataque
  testado.

  🔴 **Os fluxos legítimos que as v5/v6 quebravam, agora como teste** (§9.8): (f) `1ª compra →
  aprovação` como master autenticado, **sucesso**; (g) `backfill de pendente → aprovação`,
  **sucesso**; (h) **split de pai com preço divergente**: os filhos herdam `preco_origem` e
  `preco_gravado_em` **da linha**, e o disparo do filho não vê procedência nova — é o teste que prova a
  §4.4.2 e que a forma antiga reprovava.

  🔴 **Capability** (§9.7): (i) `employee` na RPC de 1ª compra → `42501`; (j) **`master` → autorizado**;
  (k) `auth.uid() IS NULL` → `42501`.

  Mais: payload NaN/Infinity/≤0 → `SP004` · status fora da lista → `SP003` · a 1ª compra **recusa** item
  com preço > 0 → `SP005` · `reposicao_persistir_qtde_inteira` no disparo **não** altera carimbo (é o
  teste que prova a decisão §4.1) · conferência: `n_val_unit` deturpado e `n_qtde` ≠ `qtde_final` →
  `payload_divergente` · **payload com `item_id` repetido → `payload_divergente`** (o furo de
  multiplicidade do §9.5, que a igualdade de conjuntos deixava passar com quantidade dobrada) ·
  `preco_origem` NULL → `preco_origem_ausente` · `preco_recusa_motivo` limpo na próxima escrita
  autorizada.

- **Falsificação uma camada por vez**, com **controle verde na MESMA invocação do laço** (senão a
  suíte sempre-vermelha aprova tudo) e **commit antes** (o `restaurar()` é `git checkout --`):
  fazer o trigger **aceitar** `NEW.preco_origem` do chamador em vez de sobrescrever → (d) fica
  vermelho; remover o passo 2 (preservar carimbo quando o preço não muda) → (c) fica vermelho; repor
  `falha_envio` como estado de escrita livre → (a) fica vermelho; **trocar `cap_compras_ler` por
  `employee OR master` na RPC de 1ª compra → (i) fica vermelho** — é a falsificação da escalada que eu
  mesmo introduzi na v4; afrouxar o `<= 0` da 1ª compra → o teste de "não troca preço bom" fica
  vermelho.

- **Gate da edge — a v2 afirmava um FATO FALSO aqui, corrigido (§9.5).** Eu escrevi que
  `_shared/marco-pre-omie_test.ts` já asserta "exatamente 1 call site de `IncluirPedCompra`". **Não
  assere**: o `G3` conta `atribuicoesDaColuna` — atribuições de `omie_po_inexistente_antes_de` —, e o
  Codex executou os 7 testes com um segundo call site inserido, **7/7 verde nos dois casos**. Eu
  afirmei sobre um arquivo que só tinha visto por `grep`. Ele é bom **modelo de estilo** (o `G2` traz
  falsificação embutida), não garantia pronta.

  Então o gate **é novo**, e forma sozinha não basta: presença + ordem + ausência de
  `if (modo === 'producao')` são satisfeitas por **uma chamada cuja resposta é ignorada**. O que prova
  a asserção é COMPORTAMENTO:
  - **zero chamadas ao Omie** quando a RPC (a) erra, (b) devolve `ok=false`, (c) devolve vazio,
    (d) devolve formato inválido — **nos DOIS modos** (`producao` e `dry_run`), 8 casos;
  - 🔴 **e os CONTROLES POSITIVOS desses oito** (§9.9): RPC válida → **exatamente UMA** chamada ao
    Omie, nos dois modos. Sem eles, *"uma edge que recusa tudo satisfaz os oito casos negativos"* — é a
    mesma armadilha de sabotar sem linha de base verde, agora dentro do meu próprio gate;
  - assert de **contagem** de call sites de `IncluirPedCompra` (que não existia) — é ele, e só ele, que
    sustenta "inescapável";
  - **falsificação removendo a DECISÃO de recusar** (manter a chamada, ignorar o resultado): tem de
    ficar vermelho. Sem ela o gate é decorativo — o defeito que o Codex demonstrou executando.

  Onde lê a edge como TEXTO, limpa comentário com o stripper COMPARTILHADO (`removerComentarios` de
  `@/lib/gates/limpeza-fonte`), nunca regex local — a edge tem `IncluirPedCompra` em 6 comentários e 1
  chamada.

- **Deno `test:edges`** (`--no-remote`, sem afrouxar o flag), **`edges:typecheck`**, **`sonda:bump`** +
  **`sonda:fingerprint -- --write`** em `disparar-pedidos-aprovados`. Os 5 gates de edge não se cobrem.
- **Manifesto de módulos** para arquivo novo em `src/`; **`bun run psql:errorstop`**; **`shellcheck`**.
- **Codex challenge** sobre esta v7 **antes** de implementar — as v2/v4/v5 foram reprovadas (§9).

## 8. Decisões do founder (2026-09-06, nesta ordem)

1. **Selo próprio + re-selo por porta**, não o selo do #2187 estendido. O selo de lá é imutável por
   construção; este precisa ser reescrito legitimamente até 2x. Fundi-los tornaria mutável o selo cuja
   propriedade central é a imutabilidade. **A §8.4 do #2187 fica intacta — não foi reaberta.**
2. **Procedência agora, teto depois**, com o sensor do §4.6 produzindo o número. Evita a armadilha
   "fase N+1 sem sinal da fase N".
3. **RPC dedicada para a 1ª compra + UI migra** — o gate sai do cliente, e a regra "só preenche
   ausente" passa a ser servidor.
4. **Em fila atrás do #2187.** Não standalone (§2).
5. ~~**Quantidade entra no escopo**~~ → **REVERTIDA na v4 (§9.2).** Entrou porque parecia "quase de
   graça"; o Codex mostrou que a recusa de quantidade **não tem recuperação** (cancelar é negado em
   `sucesso_portal`). Sai a conferência de **selo** de quantidade — vira chip bloqueado no desenho de
   recuperação de ordem externa (§10); fica a de **transporte**, que não tem o beco.
   ⚠️ Aplicado por recomendação minha, na ausência de decisão contrária: a decisão original foi do
   founder, e a reversão é trivial (repor os dois motivos de `aprovacao_selo` na tabela do §5.1) —
   mas então o §9.2 exige desenhar a recuperação de ordem externa junto.

6. **Trocar a forma: procedência por LINHA** (2026-09-06, §11) — depois de três rodadas de challenge
   reprovando o hash-por-pedido pelo mesmo motivo estrutural.

## 9. Revisão independente — challenge Codex (2026-09-06): **não aprovar**

`gpt-6-astra · reasoning max · tentativa 2 · 908s · 165.313 tokens`. A 1ª tentativa saiu com exit 75
(cota); a janela resetou e a 2ª rodou. **Toda alegação factual do parecer foi conferida contra o
código antes de entrar aqui** — parecer de agente não vira spec sem verificação. As cinco estão
acatadas no corpo.

### 9.1 [P0 — eu subo de P1] O re-selo legitimava uma alteração proibida

Como staff `authenticated`:
`falha_envio → UPDATE preço 10→100 → reposicao_selar_preco(id,'portal_captura') → reprocessar`.
O UPDATE passava pela lista permissiva; o selador aceitava chamador e origem sem exigir o CAS da
captura; gravava o hash de 100, limpava a recusa e registrava origem falsa. A quantidade ficava
intacta ⇒ **os dois selos e a comparação do payload passavam**.

Classifico como **P0, não P1**: o mecanismo não era contornado por fora, era **derrotado pela própria
porta que deveria protegê-lo**. Um guard que o atacante pode re-selar não é guard.

E o Codex antecipou a correção incompleta: revogar só a chamada direta não bastaria — sobraria
`UPDATE preço → NULL` + RPC de 1ª compra com o valor novo, porque o `<= 0` validaria a **ausência
fabricada**; e adulterar o item A enquanto se preenche legitimamente o item B faria o re-selo do
pedido inteiro incorporar A.

**Acatado** em §4.3 (selador vai para `private`, sem EXECUTE para ninguém além do owner; `p_origem`
deixa de ser do chamador), §4.4.1 (RPC de 1ª compra vira SECDEF e põe o bypass ela mesma) e §4.5
(`falha_envio` **sai** da lista permissiva — pós-aprovação `authenticated` não escreve preço em estado
nenhum). As três são acopladas; nenhuma resolve sozinha.

**Teste decisivo** (§7): *adulterar → tentar legitimar → conferir disparo*. Negar INSERT direto no log
não prova nada.

### 9.2 [P1] O beco da quantidade — e a decisão que volta para o founder

**Verificado no código:** `cancelar_pedido_sugerido`, na própria M1 do #2187, recusa quando
`status_envio_portal IN ('enviando_portal','enviado_portal','sucesso_portal','aceito_portal_sem_protocolo','indeterminado_requer_conciliacao')`.
A recuperação que a v2 prescrevia ("cancelar + o ciclo regrava") está **bloqueada exatamente no
estado onde seria necessária**.

Meu B1 (§9.3) tinha achado o problema e prescrito a cura errada: **band-aid**. Mudar a mensagem não é
recuperação.

✅ **DECIDIDO na v4: a conferência de selo de quantidade SAI desta fatia.** A quantidade entrou porque
parecia "quase de graça" — cinco linhas de SQL numa RPC que já ia existir. **Não é de graça**: uma
recusa sem recuperação transforma "fornecedor recebeu e Omie não" num estado sem saída.

O que sai: a recomputação de `reposicao_selo_itens` contra `aprovacao_selo` (motivos
`aprovacao_selo_ausente` / `aprovacao_selo_divergente`). **O que FICA: a conferência de transporte**
`n_qtde` contra a linha do banco — ela não tem o beco, porque divergência ali é bug da edge
(corrigir → deployar → reprocessar), não estado externo irreversível.

Descartadas: (b) manter e desenhar a recuperação de ordem externa junto — é outra fatia inteira dentro
desta; (c) manter como alerta não-bloqueante — guard que não recusa, em money-path, é teatro.

### 9.3 O Caminho B (auto-challenge) — e o que ele subdimensionou

Enquanto a cota estava esgotada, auto-desafiei o desenho. Achei **B1** (quantidade sem recuperação) e
**B2** (`valor_total` provado sobrescrito). **Subdimensionei os dois**, e o registro importa mais que
o acerto:

- **B1** eu prescrevi "distinguir na mensagem" — band-aid, porque não conferi se o cancelamento era
  possível (§9.2).
- **B2** eu chamei de "desvio de relatório, não dinheiro". **Errado, e verificado:** o gate de valor
  mínimo lê `pedido.valor_total` (`disparar-pedidos-aprovados/index.ts:358`) **antes** de
  `processarPedido` recomputar. Total adulterado **flipa um gate de dinheiro**. Continua fora de
  escopo — mas pelo motivo CERTO (separação de efeitos: não afeta `nValUnit`/`nQtde`, e não exige
  `valor_linha` no hash), não pelo motivo errado que eu tinha dado. Vira chip com essa nota.
- **B3** (meus descartes) o Codex confirmou: um call site atual, promoção pré-aprovação, sem reenvio
  com protocolo. Mas registrou o que eu não tinha visto: **descarte correto não é recuperação** — nada
  disso destrava o §9.2.

Isto é a evidência de que **auto-revisão não substitui revisão independente**: ela encontrou os dois
sintomas certos e errou o tamanho dos dois.

### 9.4 [P2] O rollout deixava a aba velha de fora, e agendava só metade dos ramos

Publish não fecha aba antiga (o SW só troca de build quando o cliente clica). Sequência furada:
pedido selado com custo ausente → `falha_envio` → **aba velha preenche o custo corretamente** por
PostgREST cru (`useDetalhesModal.ts:170`, verificado) → nenhum re-selo → edge nova recusa. E atualizar
a UI depois **não salvava**: preço já positivo ⇒ a RPC nova responde `SP005`, e a recuperação normal
vira intervenção SQL.

E a §6 agendava só o `SP006`; o `SP007` não estava em etapa nenhuma. *(Na v7 o `SP007` deixou de
existir — era o ramo do GUC, e a forma nova não tem GUC nem selo de pedido.)*

**Acatado** em §6: o `SP006` passa a entrar **junto com o deploy da edge**, não depois — assim a
escrita da aba velha é recusada no banco, o preço fica ≤ 0 e a RPC nova ainda resolve. `SP007`
agendado explicitamente.

### 9.5 [P2] Contrato do payload e uma alegação FALSA minha sobre a prova

**Multiplicidade.** A §5.1 comparava conjuntos de `item_id`. Um payload que repete
`{id:7, preço:10, qtde:2}` mantém o mesmo conjunto e satisfaz toda comparação individual — passaria com
**quantidade total dobrada**. Não há produtor hoje (o `.map` parte das linhas do banco), mas é defeito
do **contrato**, e contrato se fecha no contrato. Acatado em §5.1: array válido, ids únicos,
cardinalidade igual, correspondência um-para-um.

**A alegação falsa.** A v2 dizia que `_shared/marco-pre-omie_test.ts` já asserta "exatamente 1 call
site de `IncluirPedCompra`", e eu usei isso para sustentar que a asserção seria "inescapável".
**Verificado: é falso.** O `G3` conta `atribuicoesDaColuna` — atribuições de
`omie_po_inexistente_antes_de`. O Codex executou os 7 testes com um segundo call site inserido:
**7/7 verde nos dois casos**. Eu afirmei sobre um arquivo que só tinha lido por `grep` — a armadilha
de sempre: recorte não é leitura.

E mesmo com a contagem acrescentada, presença + ordem + ausência de `if (modo === 'producao')` são
satisfeitas por **uma chamada cuja resposta é ignorada**. Acatado em §7: testes comportamentais
exigindo **zero chamadas ao Omie** em erro/`ok=false`/vazio/formato inválido, **nos dois modos**, mais
falsificação que remove a DECISÃO de recusar.

### 9.8 Terceira rodada (v5) — **não aprovar**: o conserto do P0 quebrou a aprovação, e o split lava

`gpt-6-astra · max · tentativa 1 · 422s · 164.718 tokens`. O que **fechou**: a capability nas duas
portas humanas (`cap_compras_ler(auth.uid())` + rejeição de UID nulo reproduz a RLS dos itens). O Codex
acrescentou que **não** se deve trocar por `cap_compras_escrever` — ela nasceu para outra superfície
(telemetria do motor) — e que portal e split precisam preservar o caminho de máquina com
`service_role`.

O que **não** fechou — três achados, nenhum remendado nesta v6 (ver §11):

- **[P1] O "primeiro selo apenas" impede aprovação legítima. Regressão da v5.**
  `pendente_aprovacao + custo ausente → RPC de 1ª compra (que sela) → aprovar → a entrada nova recusa`,
  porque ela exige `preco_selo IS NULL` e a 1ª compra já selou. O **backfill** de estados não-terminais
  produz o mesmo bloqueio para pendentes. E a 1ª compra é comum: **152 itens em 72 pedidos/120d**
  (§3). *"Apenas remover o `IS NULL` reabre a porta anterior"* — é o pêndulo entre o P0 e esta
  regressão que motiva o §11.
- **[P1, 9/10] O split lava preço criando o PRIMEIRO selo dos filhos.** Pai aprovado com preço 100 e
  selo de 10 (origem concreta: escrita crua entre M1 e M2, depois do backfill). O §4.4 manda selar os
  filhos mas **não** exige conferir o selo do pai antes de mover os itens; o split roda na edge antes
  de processar (`index.ts:1688`). Os filhos nascem com preço 100 e um **primeiro selo válido de 100**,
  origem `aprovacao`. A entrada pública nova nem é chamada.
  ⚠️ **Isto refuta a tese central da v5** — *"lavar exige re-selar um pedido já selado"*. Não exige:
  **troca-se o pedido que recebe o selo.**
- **[P2] O GUC do `SP007` não autentica quem o definiu.** O ramo exige só igualdade com `NEW.id`; no
  modelo SQL, `set_config('reposicao.selando_preco', id)` + `UPDATE preco_selo = NULL` o satisfaz.
  Não é explorável por HTTP hoje (o wrapper público de `set_config` restringe a `fin.%`), por isso P2 —
  mas a garantia de "um escritor só" precisa de contexto de execução no `SP007`, e a falsificação tem
  de **tentar zerar o selo**. (Eu havia movido o ramo de ITEM para estado+`current_user` na v4 e deixei
  o de PEDIDO no GUC — incoerência minha.)
- Sobre a prova: o cenário (g) segue incompatível com a integração prescrita e precisa cobrir também os
  selos pré-aprovação; e o (f) de capability está só na 1ª compra — tem de ser replicado na entrada
  pública de aprovação.

Ressalva do parecer: revisão de desenho contra o código disponível; as migrations novas não foram
executadas e o `psql-ro` dele falhou por DNS (as medições são minhas, §3).

### 9.9 Quarta rodada (v7) — a troca de forma FUNCIONOU, mas ainda **não aprovar**

`gpt-6-astra · max · tentativa 1 · 425s · 161.439 tokens`. Palavras do parecer: *"as regressões
anteriores de aprovação, capability e GUC **não se reabrem** pela forma descrita"*, e nenhum escape
adicional por `ON CONFLICT`, UPDATE em massa, `COPY` ou `DELETE+INSERT` com o ramo ativo. A forma nova
resistiu. O que não resistiu:

#### 9.9.1 [P1] O próprio ROLLOUT fabricava procedência válida para preço adulterado

```
M1: item aprovado com preço=10, origem=backfill, instante=t0
authenticated/master: UPDATE preco_unitario=100   ← ramo do trigger AINDA não existe
ativação do ramo + edge nova
conferência: origem presente, permitida, transporte bate → PASSA → nValUnit=100
```

A escrita **não precisa tocar o carimbo**: o carimbo de 10 fica colado ao preço 100. E *"mesma leva"
não define ordem entre operações manuais*. Isso **reabre o efeito financeiro do achado da rodada 3
sem precisar de split nem de selo novo**. Acatado no §6: backfill e criação do ramo na **mesma
transação**, sob `LOCK TABLE`, e a edge só depois do commit.

⚠️ E o Codex corrigiu a minha "honestidade" do §5.1: eu equiparei "não detecta escrita crua com trigger
desabilitado" a "não resiste a administrador malicioso". **Não são equivalentes** — um hash protegido
detectaria uma escrita que altera *somente o preço*. Não impedir um admin de adulterar tudo não torna
as duas propriedades iguais. A forma por linha realmente perde essa detecção; o que a compensa é o
corte atômico + o trigger sempre ativo, não uma nota de rodapé.

#### 9.9.2 [P1] A fronteira PRÉ-aprovação — ✅ decidido: preço entra no token do #2187

Com o mecanismo inteiro ativo: `pendente_aprovacao, preço=10 → master faz UPDATE cru para 100 → o
trigger permite e carimba `primeira_compra` → aprovação ocorre → a conferência aceita 100`. A RPC
responderia `SP005` para essa troca; o UPDATE direto obtém a **mesma procedência sem satisfazer o
predicado**. Variante acidental, mais provável: duas abas com custo ausente, uma preenche 10, a **aba
velha grava 100** com o pedido ainda pendente.

🔴 **E o conserto óbvio não existe.** Medido em prod (2026-09-06): `gerar_pedidos_sugeridos_ciclo`,
`gerar_pedidos_oportunidade_ciclo`, `aplicar_promocoes_no_ciclo` e `remover_itens_pedido_sugerido` são
**todas INVOKER e todas executáveis por `authenticated`**. Quando um humano roda o ciclo pela tela,
`current_user` **é** `authenticated` — indistinguível de um UPDATE cru dele. Então "recusar escrita de
`authenticated`" quebraria o motor, e "exigir preço anterior ausente em todo UPDATE" barraria promoção
legítima, que muda preço positivo. **O par `(estado × current_user)` não separa isto.** É limitação da
forma, não descuido.

**✅ Decidido pelo founder (2026-09-06):** não constranger o motor. Fechar pelo lado da APROVAÇÃO —
**incluir `preco_unitario` no token `p_itens_vistos` do #2187** (§3.4.3 de lá).
O token já existe e já compara "o que você viu" contra "o que está lá"; acrescentar um campo faz a
aprovação recusar exatamente o caso da aba velha, que é o realista. Isso **não contradiz a §8.4 do
#2187**: lá a decisão foi manter preço fora do **selo**; o token é outra coisa — é anti-TOCTOU de
leitura, não procedência.

⚠️ **Toca o #2187**, que está em reconstrução ⇒ o requisito está isolado na **§2.1** para que a sessão
irmã o encontre sem ler este spec inteiro. Descartada a alternativa de aceitar como risco.

#### 9.9.3 [P2] A recuperação prometida não era executável

`UPDATE SET preco_unitario = 10` numa linha que já vale 10 não entra no ramo (`IS DISTINCT FROM`), e o
passo 2 do §4.3 restaura os NULLs. A "recuperação" do §5.3 era promessa sem procedimento. Acatado:
§5.4 traz o reparo atômico e o teste **recusa → reparo → disparo válido** com preço final idêntico.

#### 9.9.4 Duas notas de prova e de catálogo

- **O trigger não pode ser `SECURITY DEFINER`**: ele decide sobre a identidade do executor, e SECDEF
  trocaria essa identidade. Verificar `prosecdef = false` na postcondição. Acatado no §4.3.
- 🔴 **Os oito casos negativos do gate da edge precisam de CONTROLES POSITIVOS** — *"uma edge que
  recusa tudo também satisfaz aqueles oito casos"*. É a armadilha de sabotar sem linha de base verde,
  dentro do meu próprio gate. Acatado no §7: RPC válida → **exatamente uma** chamada ao Omie, nos dois
  modos.
- Falta ainda testar UPDATE direto de preço positivo nos dois estados pré-aprovação, inclusive a aba
  antiga após outro preenchimento — depende da decisão §9.9.2.

### 9.10 Quinta rodada (v9) — o corte atômico passou; o token e o reparo, não

`gpt-6-astra · max · tentativa 1 · 507s · 123.447 tokens`. **Confirmado suficiente:** o corte atômico
do §6 — *"`SHARE ROW EXCLUSIVE` conflita com o `ROW EXCLUSIVE` dos escritores e permanece até o término
da transação; escritores anteriores terminam antes do corte, os seguintes encontram o ramo ativo"*.

- **[P1] A releitura no clique incorpora o preço adulterado ao PRÓPRIO token.** O #2187 manda buscar os
  itens imediatamente antes de aprovar ⇒ `tela mostra 10 → outra aba grava 100 → o clique busca 100 →
  token = 100 → aprovação aceita`. Os locks protegem comparação→aprovação; a alteração é **anterior à
  busca**. Acatado no §2.1: o token vem do snapshot **apresentado e confirmado**, releitura divergente
  interrompe. *"Apenas testar `token=10 × banco=100` não cobre o furo."*
- **[P2] O reparo produz capturas fictícias no sensor.** Acatado no §5.4 (GUC de rotulagem +
  `manual_sql` fora da amostra).
- **Risco aceito, a constar expressamente:** *"master deliberado continua passando: pode gravar 100
  antes da aprovação e apresentar token de 100. Aceitar isso é defensável se quem pode aprovar integra
  a fronteira de confiança."* — e quem aprova é `master`, a mesma capability de `cap_compras_ler`. **O
  token comprova correspondência com o snapshot, não procedência nem visualização humana.** Isso não
  justifica a releitura silenciosa do P1 acima.

### 9.6 O que o Codex NÃO transformou em achado

- **Hash:** sem colisão estrutural. JSON preserva fronteiras, `ORDER BY id` estabiliza, `trim_scale`
  normaliza escala, NULL ≠ zero, inserção/remoção mudam o vetor. *"O furo principal está em quem pode
  autenticar esse vetor"* — que é o §9.1.
- Ressalva do próprio parecer: a análise das RPCs novas é **de desenho** (elas não existem), e a
  consulta SQL read-only dele falhou por DNS — ele manteve as medições do prompt como fatos. As
  medições são minhas, via `psql-ro`, e estão na §3.

### 9.7 Segunda rodada do challenge (v4) — **não aprovar**, e os dois P1 são MEUS

`gpt-6-astra · max · tentativa 1 · 401s · 156.347 tokens`. O Codex confirmou que os ataques de escrita
crua foram fechados **na regra pretendida** — e achou que **a própria correção do P0 introduziu duas
regressões**. As duas verificadas por mim antes de entrar aqui.

- **[P1] Escalada de privilégio na porta humana.** Verificado em prod: `private.cap_compras_ler` é
  `has_role(_uid,'master')` — **só master**. Meu gate da v4 copiou o do
  `sayerlack_aplicar_custo_portal` (`employee OR master`), e com SECDEF isso daria a `employee` uma
  escrita que a RLS reservava a `master`: `falha_envio` com custo ausente → preço arbitrário positivo →
  o owner grava e sela → reprocessamento manda ao Omie. **Sem forjar nada.** Trocar RLS por SECDEF sem
  reproduzir a capability **exata** é escalada silenciosa — a lição está agora como regra no §4.4.1, e
  vale para toda porta humana deste spec.
- **[P1] A premissa "as portas são SECDEF" é falsa para a aprovação.** Verificado na M1 do #2187
  (l.376): `aprovar_pedido_sugerido` é `SECURITY INVOKER` **por desenho**. Privilégio de SECDEF não
  permanece no chamador, então a aprovação chamaria o selador privado ainda como `authenticated` e
  tomaria *permission denied*: **a v4 quebrava a aprovação inteira**. Corrigido no §4.3 com uma entrada
  SECDEF estreita de **primeiro selo apenas** — que não pode lavar nada, porque lavar exige re-selar um
  pedido já selado, e é isso que ela recusa.
- **[P2] O meu teste decisivo exigia resultado impossível.** Eu escrevia "em todos, o disparo seguinte
  recusa". Errado: se o ataque foi barrado, o estado ficou intacto e **o disparo legítimo tem de
  passar**. Também: na variante A/B a RPC recebe só B e **deve suceder**; e a falsificação ainda citava
  um GUC que a v4 tinha removido. Um spec com teste contraditório produz implementação que passa no
  teste errado. Corrigido no §7.

**Padrão que se repete e vale registrar:** as duas rodadas acharam furos na *fronteira de
autorização*, não na criptografia do selo. Hash, ordenação, escala e NULL passaram limpos nas duas. O
risco deste desenho nunca esteve em "o hash colide" — está em **quem pode autenticar o vetor**, e cada
correção minha mexeu exatamente aí e criou a regressão seguinte.

## 10. Fora de escopo (dito, não esquecido)

- 🚧 **Conferência de selo de QUANTIDADE no disparo** — tirada na v4 (§9.2). Bloqueada no desenho de
  **recuperação de ordem externa** (cancelamento confirmado no fornecedor antes de gerar substituto);
  sem ela, a recusa não tem saída. A prevenção do #2187 segue cobrindo quantidade, e a conferência de
  transporte (`n_qtde` × banco) fica nesta fatia.
- **Teto de valor aprovado** ("o portal cobrou mais do que aprovamos"). É a fatia seguinte, e §4.6 diz
  exatamente qual número a destrava.
- **`valor_linha` e `valor_total`** — §4.1 explica por que ficam fora do hash (separação de efeitos:
  não alcançam `nValUnit`/`nQtde`). ⚠️ **Mas o desvio NÃO é "só relatório"**, como a v2 dizia: o gate
  de valor mínimo lê `pedido.valor_total` (`index.ts:358`) antes da recomputação, então total
  adulterado flipa um gate de dinheiro (§9.3). Vira chip próprio, com essa nota — e o chip **não**
  precisa de `valor_linha` no hash.
- **Auditoria de `pedido_compra_item`** (não há `atualizado_em` nem tabela de histórico). O log do selo
  cobre o que importa para esta invariante; auditoria geral da tabela é outra decisão.
- **`conciliar-pedido-portal`** — o #2187 já mexe nela; esta fatia não acrescenta nada lá.

## 11. A conclusão estrutural — e a decisão que ela força

Três rodadas de challenge. Em cada uma, a correção que eu fiz na fronteira de autorização abriu um
buraco novo **na mesma fronteira**:

| Rodada | O que eu consertei | O que a correção abriu |
|---|---|---|
| 1 → v3 | selador chamável por `authenticated` com origem livre | porta humana SECDEF com gate mais frouxo que a RLS **e** aprovação INVOKER sem acesso ao selador |
| 2 → v5 | capability exata + entrada de "primeiro selo apenas" | "primeiro selo" **bloqueia aprovação legítima**; e o split lava trocando o pedido que recebe o selo |
| 3 → ? | (não remendado) | — |

Isso deixou de ser série de descuidos. O que se repete é a **forma**: o selo é um ato **separável** da
escrita, e a autoridade para selar vem sempre de um proxy fraco — o papel do chamador, um GUC, a
ausência de selo anterior, ou qual pedido está sendo selado. Todo proxy fraco tem um caminho que o
satisfaz sem a intenção que ele representa. Remendar o proxy da vez apenas move o furo.

### 11.1 A alternativa: procedência POR LINHA, carimbada na escrita

Em vez de um hash por pedido que alguém precisa **autorizar a gravar**, gravar a procedência **na
própria linha do item, no mesmo statement que escreve o preço**:
`pedido_compra_item.preco_origem` + `preco_gravado_em`, e o trigger **carimba ele mesmo** a partir do
contexto de execução (`current_user` + estado do pai), recusando escrita de contexto não autorizado.

O disparo deixa de recomputar hash: confere que **toda linha** tem `preco_origem` no conjunto
permitido para o estado do pedido.

Por que isto fecha os cinco achados **por construção**, não por remendo:

- **R1/P0 (forjar re-selando):** não há selo para regravar — o carimbo é escrito pelo trigger, nunca
  pelo chamador.
- **R2/P1 (aprovação INVOKER):** não há selador para chamar. A aprovação não muda.
- **R3/P1 (primeiro selo):** o conceito não existe; 1ª compra e aprovação não disputam nada.
- **R3/P1 (split lava):** o carimbo **viaja com a linha**. O filho herda a procedência do item, não
  ganha uma nova por ser um pedido novo.
- **R3/P2 (GUC):** não há GUC.

Custo honesto: uma coluna a mais por item; o sensor do §4.6 passa a ler por linha (fica **melhor** —
hoje o delta é por pedido); e a §5.1 deixa de comparar hash, o que **enfraquece** a detecção de
"conjunto de itens mudou" — que, no entanto, já é coberta pelo trigger do #2187 e pela cardinalidade
um-para-um do payload.

### 11.2 ✅ Decisão do founder: TROCAR (2026-09-06)

A forma "selo próprio + re-selo por porta" foi **escolha sua** na abertura desta fatia, com a
alternativa de então sendo "trigger sem hash". A informação nova é que essa forma custou três rodadas
sem convergir. **Decidido: trocar para 11.1**, e é o que a §4 desta v7 implementa. Aproveitados sem
mudança: a medição (§3), o escopo (§9.2) e a prova comportamental da edge (§7) — nenhum deles dependia
da forma.

**O que a troca também comprou, e não estava no argumento original:** a M1 encolheu. A v6 recriava
`aprovar_pedido_sugerido`, `sayerlack_aplicar_custo_portal` e `pedido_compra_split` — três funções que
outra sessão está reconstruindo agora no #2187, cada uma exigindo pré-voo `pg_get_functiondef` contra
a PROD e sujeitas à regra "a última a recriar vence". A v7 **não toca nenhuma das três**.
