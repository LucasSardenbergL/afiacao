# Selo de aprovação do pedido Sayerlack — desenho para decisão (2026-09-05)

> Money-path de compras. Origem: achados P0/P1 do challenge Codex no PR #2166 (itens graváveis
> pós-aprovação · `sku_portal` do de-para mutável sem snapshot · "Forçar reenvio" sem reaprovar).
> Contexto vivo em `docs/agent/reposicao.md` §Portal Sayerlack e
> `docs/historico/portal-sayerlack-fator-aprovado-vs-vivo.md`. **Status: aguardando decisão do
> founder (§7) — nada implementado.**

## 1. Invariante alvo

**Enviado = aprovado.** O que o portal Sayerlack recebe tem de ser, item a item, o que o comprador
viu e aprovou: mesmo SKU Omie, mesma quantidade, mesmo código do portal, mesmo fator de embalagem.
Qualquer divergência entre a aprovação e o instante do envio é recusa do pedido INTEIRO antes de
qualquer efeito externo (`requestSent: false`), nunca "envia o que tem".

## 2. O que existe hoje (medido em prod via psql-ro, 2026-09-05)

- **A aprovação é um flip de status.** `aprovar_pedido_sugerido(p_pedido_id, p_usuario)` só checa
  `status IN (pendente_aprovacao, bloqueado_guardrail)` e grava `aprovado_por/em`. Não olha os itens.
- **Os itens ficam vivos depois.** `pedido_compra_item` não tem trigger (0 em prod); a policy de UPDATE
  e DELETE é `cap_compras_ler` por linha — qualquer staff de compras altera/apaga item por `id` em
  qualquer status. O gate `podeEditar` existe SÓ no cliente (`useDetalhesModal`), então uma aba velha
  fura. Escritores pós-aprovação reais: UI (update/delete), `reposicao_persistir_qtde_inteira`
  (disparo, `ceil` ANTES do portal), a normalização da edge (`qtde_final` → múltiplo, escreve), e
  `sayerlack_aplicar_custo_portal` (preço, pós-sucesso).
- **Há flip de status para "aprovado" fora da RPC:** `runAutoApprove` (`useCicloHoje.ts` ~l.189) faz
  `UPDATE … SET status='aprovado_aguardando_disparo'` direto.
- **O de-para é vivo.** A edge relê `sku_fornecedor_externo` no envio; 312 linhas ativas, 5 editadas
  depois de criadas (a última hoje). O `#2157` gravou o FATOR usado no item
  (`fator_embalagem_portal`), mas não o `sku_portal`.
- **"Forçar reenvio" é UPDATE direto do front** (`PortalDrawer.tsx`) para `pendente_envio_portal`,
  e `iniciar_envio_portal_pre_claim` aceita qualquer status que não seja `enviando_portal`.
- **Janela real.** 109 pedidos aprovados→portal em 90d; p50 de 0,1 min entre aprovação e 1ª
  tentativa (aprovar = disparar na hora). A janela nominal é de segundos; as janelas que importam são
  o retry `erro_retentavel` (15 min × 3), o cron de corte e o "Forçar reenvio" (horas/dias). O #2388
  está parado desde 03/09 em `aprovado_aguardando_disparo` + `erro_nao_retentavel`, com o erro
  recomendando "confira o de-para" — consertar o de-para e forçar reenvio é exatamente B+C.

## 3. Decisão de forma: o selo é consequência do STATUS, não do chamador

Cinco unidades, cada uma com um dono e uma fronteira testável. Nenhum status novo em
`status_envio_portal` (status novo entra por default como "estoque a caminho" na CTE `em_transito` —
armadilha documentada); a família de recusa vive numa **coluna dedicada, 1 escritor**.

### 3.1 Selo — trigger em `pedido_compra_sugerido` (BEFORE UPDATE OF status)

Dispara na transição `→ aprovado_aguardando_disparo`, venha ela da RPC ou de UPDATE direto. Em ordem:

1. ≥1 item, senão `RAISE SQLSTATE 'SA005'` ("pedido sem itens").
2. Toda `qtde_final` inteira, senão `SA005` (a integerização é dever do chamador — §3.4 — e o trigger
   só CONFERE; trigger que muta item de outra tabela esconde escritor).
3. Snapshot do de-para, por item, pela MESMA chave do motor e da edge:
   `sku_fornecedor_externo` ativo com `(empresa, fornecedor_nome exato, sku_omie)`.
   0 linhas → `sku_portal_aprovado = NULL` (a edge já recusa "sem mapeamento ativo" — mantém);
   >1 ativa → `SA003` ("de-para ambíguo"); 1 → grava `pedido_compra_item.sku_portal_aprovado` e
   `fator_portal_aprovado`.
4. Se `fator_embalagem_portal IS NOT NULL` e ≠ fator vivo → `SA004` ("o motor arredondou com outro
   fator; cancele e aguarde o ciclo"). Fecha o TOCTOU geração→aprovação NA aprovação, antes de
   qualquer efeito, em vez de deixar para a edge.
5. `aprovacao_selo := reposicao_selo_itens(pedido_id)`, `aprovacao_selo_em := now()`,
   `portal_recusa_motivo := NULL`.

`reposicao_selo_itens(bigint) RETURNS text` (STABLE): `sha256` de
`string_agg(id|sku_codigo_omie|qtde_final|fator_embalagem_portal|sku_portal_aprovado|fator_portal_aprovado, '\n' ORDER BY id)`
com `numeric` serializado por `trim_scale()` (0,20 e 0,2 são o mesmo selo) e NULL como token fixo.
**Uma implementação, em SQL** — a edge chama a função, não espelha o hash em TS.

### 3.2 Trava de itens — trigger em `pedido_compra_item` (BEFORE INSERT/UPDATE/DELETE)

Se o pai está fora de `(pendente_aprovacao, bloqueado_guardrail)`: INSERT e DELETE → `SA001`;
UPDATE → `SA001` só se mudar coluna SELADA (`qtde_final`, `qtde_sugerida`, `sku_codigo_omie`,
`fator_embalagem_portal`, `sku_portal_aprovado`, `fator_portal_aprovado`). Preço
(`preco_unitario`, `valor_linha`) passa — custo de 1ª compra em `falha_envio` e
`sayerlack_aplicar_custo_portal` são escritas legítimas pós-aprovação, e preço não vai ao portal.
**Independente de papel** (vale para service_role): a invariante é "item de pedido selado não muda",
não "humano não muda". Escape explícito para operação do founder no SQL Editor:
`SET LOCAL reposicao.selo_bypass = 'on'` (documentado; nunca usado por código).

Escritores auditados que continuam válidos: split (INSERT em pedido filho ainda `pendente`), motor
(INSERT em pedido novo), snapshot do §3.1 (roda com o pai ainda `pendente`, BEFORE), custo do portal
(só preço). `reposicao_persistir_qtde_inteira` no disparo vira no-op porque §3.4 integeriza antes do
selo. A normalização da edge deixa de existir (§3.5).

### 3.3 Guard de reenvio — trigger em `pedido_compra_sugerido` (BEFORE UPDATE OF status_envio_portal)

`OLD = erro_nao_retentavel` ∧ `NEW = pendente_envio_portal` ∧ `portal_recusa_motivo` ∈ família-selo →
`SA002` ("requer reaprovação; cancele e aguarde o ciclo"). Família-selo = `selo_ausente`,
`selo_aprovacao_divergente`, `depara_aprovado_divergente`, `fator_aprovado_divergente`,
`qtde_nao_multiplo_embalagem`. Independente de papel; a reaprovação (§3.1 passo 5) limpa o motivo, então
um pedido reaprovado volta a poder ser reencaminhado. O `PortalDrawer` não precisa mudar para ficar
seguro (o `SA002` vira toast); por UX, `decidirAcaoPortal` passa a receber o motivo e troca "Forçar
reenvio" pela orientação "cancele; o ciclo regrava" quando o motivo é da família.

`portal_recusa_motivo text` é coluna nova em `pedido_compra_sugerido`, **1 escritor**: a closure
`recusarPreBrowserless` da edge (que já recebe `motivo`). `portal_erro` continua texto livre.

### 3.4 RPC `aprovar_pedido_sugerido(p_pedido_id, p_usuario, p_itens_vistos jsonb DEFAULT NULL)`

Substitui a de 2 argumentos. **`DROP` + `CREATE`** (não `REPLACE`): assinatura diferente por `CREATE OR
REPLACE` cria OVERLOAD, e o PostgREST responde `PGRST203` (ambígua) para a chamada de 2 args. `DROP`
zera o ACL → reemitir nomeando as roles (pré-voo em prod: `anon, authenticated, service_role,
sandbox_exec_…` com EXECUTE; `anon` fica FORA na nova). Corpo, numa transação:

1. `SELECT … FOR UPDATE` do pedido; checa status (contrato atual: `{error: …}` em jsonb).
2. Se `p_itens_vistos` veio (`[{id, qtde_final}]`): compara com as linhas (mesmo conjunto de ids e
   mesma `qtde_final` — comparação por `trim_scale`); divergência → `{error: 'itens mudaram desde a
   leitura — recarregue'}`. Fecha a corrida "a 2ª aba salvou ANTES da 1ª aprovar" (a trava §3.2 fecha
   a corrida "DEPOIS").
3. `PERFORM reposicao_persistir_qtde_inteira(p_pedido_id)` — a UI já mostra o `ceil`
   (`quantidadeCompraInteira`), então o selo cobre o que o comprador viu.
4. `UPDATE status` → o trigger §3.1 sela. `SA003/SA004/SA005` são capturados e devolvidos como
   `{error}` para manter o contrato de `aprovar-disparar.ts`.

Front: `aprovarEDisparar` ganha `itensVistos?` e `useDetalhesModal` passa `linhas` (`id`, `_qtd`);
`PedidoRow`/lote não têm itens na tela e passam `null` (selo do servidor continua valendo).
`runAutoApprove` troca o UPDATE direto pela RPC por id (sem disparar — preserva a semântica de hoje).
`ItensTable`: ao editar quantidade de item com `fator_embalagem_portal`, arredonda ao múltiplo da
embalagem (mostra "N emb."), senão a aprovação/edge recusa por `qtde_nao_multiplo_embalagem`.

### 3.5 Edge `enviar-pedido-portal-sayerlack` v1.4

- Seleciona `sku_portal_aprovado, fator_portal_aprovado` no item e `aprovacao_selo` no pedido (a
  migration TEM de estar aplicada antes do deploy — senão "Erro ao buscar itens", retentável, zero POST,
  como no #2157).
- Pré-Browserless, depois de montar `itemsPortal` e ANTES de qualquer escrita:
  1. `aprovacao_selo IS NULL` → recusa `selo_ausente`.
  2. `rpc('reposicao_selo_itens')` ≠ `aprovacao_selo` → `selo_aprovacao_divergente`.
  3. `verificarDeParaAprovado(item)`: `(sku_portal, fator_conversao)` vivos ≠
     `(sku_portal_aprovado, fator_portal_aprovado)` → `depara_aprovado_divergente` (igualdade exata,
     como no fator). `verificarFatorAprovado` (fator do MOTOR) permanece.
  4. `qtdeFisicaOmie(qtdePortal(q)) ≠ q` → `qtde_nao_multiplo_embalagem`. **A escrita de normalização
     sai** — a edge deixa de ser escritora de item; o que o comprador aprovou é o que vai.
- `recusarPreBrowserless` grava `portal_recusa_motivo = motivo` no mesmo UPDATE de
  `erro_nao_retentavel`.
- Helpers puros no espelho `src/lib/reposicao/qtde-portal.ts` (`MIRROR-START`), com o gate de forma
  existente estendido (a edge USA `verificarDeParaAprovado` no map que decide a compra; nenhum
  `.update(` em `pedido_compra_item` antes do Browserless).

## 4. Como isto absorve os chips irmãos

- **Chip 1 ("TOCTOU residual: NULL fail-closed e qtde editada pós-motor")** fica **absorvido**: (1) o
  `fator_embalagem_portal NULL` deixa de reabrir o TOCTOU porque a edge compara o de-para VIVO com o
  snapshot da APROVAÇÃO (`fator_portal_aprovado`, nunca NULL quando há mapeamento), e o §3.1 passo 4
  ainda recusa aprovar quando o motor arredondou com fator diferente; (2) "qtde editada pós-motor
  normalizada sem reaprovação" é exatamente o §3.5 item 4 + o arredondamento na `ItensTable`.
- **Chip 3 (ceil genérico com fator fracionário)** segue independente, com um aviso: a integerização
  passa a rodar TAMBÉM na aprovação (§3.4 passo 3). Quem trocar a regra de
  `reposicao_persistir_qtde_inteira` muda os dois pontos de uma vez (é a mesma função) — desenho
  deliberado, não duplicação. E a conferência "toda `qtde_final` inteira" do §3.1 passo 2 relaxa
  JUNTO (para "inteira na unidade do PORTAL" quando há fator) — hoje prod só tem fatores 1 e 0,2, os
  dois com compra física inteira, então o passo 2 é correto até o chip 3 entrar.

## 5. Rollout (ordem importa)

1. Migration custom (`/lovable-db-operator`): colunas (`pedido_compra_sugerido.aprovacao_selo`,
   `aprovacao_selo_em`, `portal_recusa_motivo`; `pedido_compra_item.sku_portal_aprovado`,
   `fator_portal_aprovado`), função `reposicao_selo_itens`, 3 triggers, RPC nova com ACL nomeado,
   `DO $post$` que relê o catálogo. Pré-voo `pg_get_functiondef` da RPC viva (feito hoje: é a de 2
   args, sem `SECURITY DEFINER`).
2. Só DEPOIS: Publish (a UI chama a assinatura nova) e deploy da edge (seleciona colunas novas).
3. Pedidos aprovados antes do apply não têm selo → `selo_ausente` na edge → cancelar e deixar o ciclo
   regravar. Medido hoje: 1 pedido nesse estado (#2388), já terminal. Aprovar = disparar na hora ⇒
   conjunto em voo ≈ 0.
4. Sensor da fase seguinte: `SELECT portal_recusa_motivo, count(*) … GROUP BY 1` — quantas recusas por
   selo em 30 dias, com denominador (envios). Sem esse número, "reabrir para aprovação" (§7.3) não
   nasce.

## 6. Prova

- **PG17 `db/test-reposicao-selo-aprovacao.sh`** (padrão dos harnesses existentes), cenários:
  flip pela RPC sela · flip por UPDATE direto também sela · `p_itens_vistos` divergente → `{error}` e
  NADA muda · de-para ambíguo → `SA003` · fator do motor ≠ vivo → `SA004` · fração → `SA005` ·
  `UPDATE qtde_final` em selado → `SA001` sob `SET ROLE authenticated` + GUC do JWT · `UPDATE preco`
  em selado passa · `DELETE`/`INSERT` em selado → `SA001` · bypass GUC passa · reenvio com motivo da
  família → `SA002` · reaprovação limpa motivo e o reenvio passa · mudar o de-para muda o selo
  recomputado. Asserts negativos casam a SQLSTATE exata e re-lançam o resto. Falsificação uma camada
  por vez (trigger de item removido → o teste da corrida "depois" fica vermelho; comparação de
  `p_itens_vistos` neutralizada → a corrida "antes" fica vermelha; família-selo esvaziada → reenvio
  passa indevidamente).
- **vitest**: `verificarDeParaAprovado` (tabela de casos, igualdade exata, NULL fail-closed) e o gate de
  forma da edge (`qtde-portal-edge-invariants.test.ts`) — inclusive o assert NEGATIVO "nenhum
  `pedido_compra_item.update` antes de `enviando_portal`".
- **Deno `test:edges`** (`--no-remote`), `edges:typecheck`, `sonda:bump` (v1.4) + `sonda:fingerprint -- --write`.
- **Codex challenge** (gpt-5.6-sol, xhigh, `scripts/codex-async.sh`) sobre este desenho antes de
  implementar e sobre o PR depois.

## 7. Decisões para o founder

1. **Selo por trigger (qualquer flip sela) — recomendo — ou só na RPC (e proibir o flip direto)?** O
   `runAutoApprove` flipa direto hoje; com trigger ele fica coberto mesmo que alguém esqueça a RPC.
2. **A edge deixa de NORMALIZAR e passa a RECUSAR (`qtde_nao_multiplo_embalagem`)** — recomendo. É o
   que faz "enviado = aprovado" ser literal e o que absorve o chip 1. Custo: item editado à mão fora
   do múltiplo é recusado na aprovação (mensagem clara) em vez de silenciosamente inflado.
3. **Reabrir para aprovação?** Pedido recusado por selo hoje só sai por "cancelar + ciclo regrava".
   Recomendo NÃO criar a RPC de reabertura agora — medir primeiro (§5.4).
4. **Escopo do selo = o que o PORTAL recebe** (SKU, quantidade, código do portal, fator). Preço fica
   fora de propósito. O selo do lado Omie é outra fatia.
5. **Fechar o chip 1 como absorvido** (§4) e manter o chip 3 com o aviso da integerização dupla.
