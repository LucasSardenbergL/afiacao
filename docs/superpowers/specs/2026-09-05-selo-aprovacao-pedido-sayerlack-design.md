# Selo de aprovação do pedido Sayerlack — desenho para decisão (2026-09-05, v2)

> Money-path de compras. Origem: achados P0/P1 do challenge Codex no PR #2166 (itens graváveis
> pós-aprovação · `sku_portal` do de-para mutável sem snapshot · "Forçar reenvio" sem reaprovar).
> Contexto vivo em `docs/agent/reposicao.md` §Portal Sayerlack e
> `docs/historico/portal-sayerlack-fator-aprovado-vs-vivo.md`. **Status: aguardando decisão do
> founder (§8) — nada implementado.** A v1 recebeu challenge Codex (gpt-5.6-sol, xhigh) com veredito
> "não aprovar" — 3 P0, 7 P1, 4 P2; os fatos foram conferidos em prod e esta v2 acata todos (§9 diz o
> que mudou e o que ficou em desacordo).

## 1. Invariante alvo

**Enviado = aprovado.** O que o portal Sayerlack recebe tem de ser, item a item, o que o comprador
viu e aprovou: mesmo SKU Omie, mesma quantidade, mesmo código do portal, mesmo fator de embalagem.
Divergência entre a aprovação e o instante do envio é recusa do pedido INTEIRO antes de qualquer
efeito externo (`requestSent: false`), nunca "envia o que tem". E a aprovação **valida, não transforma**:
o que não é canônico é recusado na aprovação com mensagem, não arredondado em silêncio.

## 2. O que existe hoje (medido em prod via psql-ro, 2026-09-05)

- **A aprovação é um flip de status.** `aprovar_pedido_sugerido(p_pedido_id, p_usuario)` só checa
  `status IN (pendente_aprovacao, bloqueado_guardrail)` e grava `aprovado_por/em`. Não olha os itens.
  É `SECURITY INVOKER`.
- **Os itens ficam vivos depois.** `pedido_compra_item` não tem trigger (0 em prod); a policy de UPDATE
  e DELETE é `cap_compras_ler` por linha — qualquer staff de compras altera/apaga item por `id` em
  qualquer status. O gate `podeEditar` existe SÓ no cliente (`useDetalhesModal`); aba velha fura.
- **Escritores de item pós-aprovação hoje:** UI (update/delete), `reposicao_persistir_qtde_inteira`
  (disparo, `ceil` ANTES do portal; EXECUTE só `service_role` — `authenticated` NÃO executa), a
  normalização da edge (`qtde_final` → múltiplo, escreve), `pedido_compra_split` (disparo: cria filhos
  JÁ em `aprovado_aguardando_disparo` e move itens por `pedido_id`, Sayerlack > 20 itens) e
  `sayerlack_aplicar_custo_portal` (preço, pós-sucesso).
- **Há flip de status para "aprovado" fora da RPC:** `runAutoApprove` (`useCicloHoje.ts` ~l.189) faz
  `UPDATE … SET status='aprovado_aguardando_disparo'` direto.
- **O de-para é vivo.** A edge relê `sku_fornecedor_externo` no envio; 312 linhas ativas, 5 editadas
  depois de criadas (a última hoje). O índice `(empresa, fornecedor_nome, sku_omie) WHERE ativo` NÃO é
  UNIQUE. O `#2157` gravou o FATOR usado no item (`fator_embalagem_portal`), mas não o `sku_portal`.
- **"Forçar reenvio" é UPDATE direto do front** (`PortalDrawer.tsx`); `iniciar_envio_portal_pre_claim`
  aceita qualquer status que não seja `enviando_portal`; `envio_portal_claim_ids` filtra só por
  `status_envio_portal`, não pelo status principal.
- **Cancelar não olha o envio em voo:** `cancelar_pedido_sugerido` recusa só `disparado`/`concluido`,
  e o front habilita cancelar em `aprovado_aguardando_disparo` mesmo com `enviando_portal` — a edge já
  tem o payload em memória, faz o POST e depois grava por `id`.
- **A conciliação aceita `erro_nao_retentavel`** (`conciliar-pedido-portal`, `STATUS_CONCILIAVEIS`) —
  um pedido recusado sem POST pode receber protocolo digitado e virar PO no Omie.
- **Janela real.** 109 pedidos aprovados→portal em 90d; p50 de 0,1 min entre aprovação e 1ª
  tentativa. As janelas que importam são o retry `erro_retentavel` (15 min × 3), o cron de corte e o
  "Forçar reenvio" (horas/dias). O #2388 está parado desde 03/09 em `aprovado_aguardando_disparo` +
  `erro_nao_retentavel`, com o erro recomendando "confira o de-para".

## 3. Forma: o selo é gravado por UMA função, e triggers garantem que nenhum caminho a contorna

Nenhum status novo em `status_envio_portal` (status novo entra por default como "estoque a caminho"
na CTE `em_transito`). A família de recusa vive em coluna dedicada. "Pedido de portal" é definido por
UM predicado SQL (`reposicao_pedido_e_portal(empresa, fornecedor_nome)` = `empresa='OBEN' AND
fornecedor_nome ILIKE '%SAYERLACK%'`, o mesmo que o claim usa hoje) — reusado pelo selo, pelo claim e
pela conciliação.

### 3.1 `reposicao_selar_pedido(p_pedido_id)` — o ÚNICO escritor do selo

Função SQL (`SECURITY INVOKER`, `search_path` fixo), chamada pela RPC de aprovação e pelo split. Em
ordem, tudo numa transação que já segura o pedido `FOR UPDATE` e os itens `FOR UPDATE`:

1. ≥1 item, senão `RAISE SQLSTATE 'SA005'`.
2. Toda `qtde_final` **canônica**: não NULL, finita, > 0, inteira; e, se `fator_embalagem_portal`
   não é NULL, round-trip idêntico (`trim_scale(round(ceil(round(q×f,6))/f,6)) = q`) — o mesmo
   espelho do motor. Senão `SA005` com o SKU na mensagem. **A função valida; não arredonda.**
3. Pedido de portal → snapshot do de-para por item, pela MESMA chave do motor e da edge
   (`sku_fornecedor_externo` ativo com `(empresa, fornecedor_nome exato, sku_omie)`): exatamente 1
   linha utilizável (`sku_portal` não vazio; `fator_conversao` não NULL, > 0, < 1e9) → grava
   `pedido_compra_item.sku_portal_aprovado`, `fator_portal_aprovado`; 0 → `SA006` ("sem de-para
   utilizável"; pedido sem mapeamento falha NA aprovação, não nasce aprovado e condenado); >1 →
   `SA003` ("de-para ambíguo").
4. Se `fator_embalagem_portal IS NOT NULL` e `IS DISTINCT FROM` fator vivo → `SA004` ("o motor
   arredondou com outro fator; cancele e aguarde o ciclo").
5. `aprovacao_selo := reposicao_selo_itens(p_pedido_id)`, `aprovacao_selo_em := now()`, sob
   `SET LOCAL reposicao.selando = <pedido_id>` (o GUC que o guard §3.3 exige).

`reposicao_selo_itens(bigint) RETURNS text` (STABLE, `search_path` fixo):
`encode(sha256(convert_to(jsonb_agg(jsonb_build_array(id, pedido_id, sku_codigo_omie,
trim_scale(qtde_final)::text, trim_scale(fator_embalagem_portal)::text, sku_portal_aprovado,
trim_scale(fator_portal_aprovado)::text) ORDER BY id)::text, 'UTF8')), 'hex')` — JSON não tem
ambiguidade de separador, NULL é `null`, `numeric` vai por `trim_scale` (0,20 ≡ 0,2). **Uma
implementação, em SQL** — nenhum espelho TS do hash.

### 3.2 Trava de itens — trigger em `pedido_compra_item` (BEFORE INSERT/UPDATE/DELETE)

Lê o pai com **`FOR SHARE`** (conflita com o `FOR UPDATE` da aprovação: um INSERT/UPDATE concorrente
BLOQUEIA até a aprovação commitar e então relê o status novo — fecha a corrida "escreveu durante a
aprovação" sem `LOCK TABLE`). Se o pai está fora de `(pendente_aprovacao, bloqueado_guardrail)`:
INSERT e DELETE → `SA001`; UPDATE → `SA001` se mudar coluna SELADA (`pedido_id`, `sku_codigo_omie`,
`qtde_final`, `qtde_sugerida`, `fator_embalagem_portal`, `sku_portal_aprovado`,
`fator_portal_aprovado`). Preço (`preco_unitario`, `valor_linha`) passa — ver §8.4.
**Independente de papel** (vale para `service_role`): a invariante é "item de pedido selado não muda".
Escape: `SET LOCAL reposicao.selo_bypass = 'on'` **só é honrado se `current_user IN ('postgres',
'service_role')`** (SQL Editor do founder e o split via edge) — nunca para `authenticated`.

Escritores auditados: motor (INSERT em pedido novo `pendente`) passa; snapshot do §3.1 roda com o pai
ainda `pendente` → passa; custo do portal (só preço) passa; `reposicao_persistir_qtde_inteira` no
disparo vira no-op (canônico já na aprovação — e se não for no-op, `SA001` é a resposta certa: algo
aprovou fração); normalização da edge sai (§3.6); split passa sob bypass (§3.5).

### 3.3 Guards em `pedido_compra_sugerido` — trigger BEFORE UPDATE

1. **Transição para `aprovado_aguardando_disparo`** exige `reposicao.selando = NEW.id` (GUC posto só por
   `reposicao_selar_pedido`) e `NEW.aprovacao_selo IS NOT NULL`, senão `SA007` ("aprovação só pela
   RPC"). Fecha `runAutoApprove` e qualquer flip direto futuro.
2. **`aprovacao_selo`/`aprovacao_selo_em` imutáveis** fora dessa transição e do re-selo do split (GUC
   `reposicao.selando` idem).
3. **Sem reabertura:** `aprovado_aguardando_disparo` só sai para `cancelado_humano`, `disparado`,
   `split_em_filhos`, `falha_envio`, `concluido_recebido` (lista positiva). Nunca volta a
   `pendente_aprovacao`.
4. **`portal_recusa_motivo`** só é gravado na transição `enviando_portal → erro_nao_retentavel`
   e, uma vez gravado, é imutável (o pedido é terminal: sem reabertura, não há "limpar motivo").
5. **Guard de reenvio:** entrar em `pendente_envio_portal` ou `enviando_portal` com
   `portal_recusa_motivo IS NOT NULL` → `SA002` ("recusado por selo; cancele e aguarde o ciclo") —
   qualquer origem, qualquer status intermediário. O `PortalDrawer` fica seguro sem mudar (o `SA002`
   vira toast); por UX, `decidirAcaoPortal` recebe o motivo e troca "Forçar reenvio" pela orientação.

### 3.4 RPC de aprovação

`aprovar_pedido_sugerido(p_pedido_id bigint, p_usuario text, p_itens_vistos jsonb)` — **3 args SEM
DEFAULT**, nova função; a de 2 args vira **wrapper** que chama a de 3 com `NULL` (conjuntos de
argumentos distintos ⇒ PostgREST resolve sem `PGRST203`; sem `DROP`, ACL preservado; `REVOKE`/`GRANT`
reafirmados nas duas por nome — `anon` fora; `NOTIFY pgrst, 'reload schema'` no fim; regenerar
`src/integrations/supabase/types.ts`). `SECURITY INVOKER` — a escrita nos itens é sob RLS do aprovador
(`cap_compras_ler`), e **não chama `reposicao_persistir_qtde_inteira`** (EXECUTE só `service_role`).

1. `SELECT … FOR UPDATE` do pedido; `SELECT … FOR UPDATE` dos itens (serializa UPDATE/DELETE
   concorrentes; INSERT concorrente bloqueia no `FOR SHARE` do trigger §3.2).
2. Status atual ∉ `(pendente_aprovacao, bloqueado_guardrail)` → `{error}` (contrato atual).
3. **Token de revisão.** `p_itens_vistos = [{id, sku_codigo_omie, qtde_final, fator_embalagem_portal}]`:
   comparado com as linhas na MESMA statement do selo (mesmo snapshot): mesmo conjunto de `id`s e
   campos iguais (`trim_scale`, `IS DISTINCT FROM`). Divergência → `{error: 'itens mudaram desde a
   leitura — recarregue'}`. **`NULL` só é aceito com `p_usuario` de origem automática** (`'cockpit:auto'`,
   o `runAutoApprove`); aprovação humana sem token → `{error}`. `PedidoRow`/lote passam a buscar os
   itens (um `select` por pedido) imediatamente antes de aprovar — é isso que fecha a corrida "a 2ª aba
   salvou ANTES da 1ª aprovar"; a trava §3.2 fecha a corrida "DEPOIS".
4. `PERFORM reposicao_selar_pedido(p_pedido_id)`; `SA00x` capturados e devolvidos como `{error}`
   com a mensagem (mantém `aprovar-disparar.ts`). Não-canônico → `{error}` e NADA muda.
5. `UPDATE status` (o guard §3.3.1 vê o GUC e o selo).

Front: `aprovarEDisparar` ganha `itensVistos`; `useDetalhesModal` passa `linhas` (`id`,
`sku_codigo_omie`, `_qtd`, `fator_embalagem_portal`) — mas `_qtd` é o `ceil` de exibição: a UI passa a
mostrar e SALVAR a quantidade canônica (ItensTable arredonda ao múltiplo/inteiro ao editar e o modal
persiste antes de aprovar quando `qtde_final` cru ≠ exibido — sem isso `10,6` visto como `11` recusa
sempre). `runAutoApprove` troca o UPDATE direto pela RPC por id com `p_usuario='cockpit:auto'` (sem
disparar — preserva a semântica de hoje). Não-canônico em auto-aprovação → recusado com o motivo no log
de operações do cockpit.

### 3.5 Split (`pedido_compra_split`) — seal-aware

Fica no disparo (não muda o fluxo "aprovar = disparar"). Passa a rodar sob
`SET LOCAL reposicao.selo_bypass='on'` (é chamado pela edge como `service_role`): cria o filho em
`pendente_aprovacao`, move os itens (`pedido_id` é coluna selada — só o split move), e chama
`reposicao_selar_pedido(filho)` **derivando dos snapshots já gravados nos itens, sem reler o de-para
vivo** (o §3.1 passo 3 tem um parâmetro `p_reusar_snapshot` que, verdadeiro, exige `sku_portal_aprovado`
não NULL em vez de consultar `sku_fornecedor_externo`), e só então flipa o filho para
`aprovado_aguardando_disparo` (o guard §3.3.1 vê o GUC). O pai vai a `split_em_filhos` e seu selo fica
histórico. Migration recria a função (pré-voo `pg_get_functiondef` da PROD — a viva é a da
`20260515170100` + PR7).

### 3.6 Edge `enviar-pedido-portal-sayerlack` v1.4

- Claim positivo: `envio_portal_claim_ids`/`envio_portal_lock_candidatos`/`iniciar_envio_portal_pre_claim`
  exigem `status = 'aprovado_aguardando_disparo'` E `portal_recusa_motivo IS NULL` e devolvem
  `aprovacao_selo`.
- Pré-Browserless, depois de montar `itemsPortal` e ANTES de qualquer escrita, **uma RPC**
  `reposicao_conferir_envio(p_pedido_id) RETURNS (selo_ok, depara_ok, divergencias jsonb)` — comparação
  de `numeric` em SQL com `IS DISTINCT FROM` (o `Number` do TS colapsa decimais distintos): selo NULL →
  `selo_ausente`; hash recomputado ≠ selo → `selo_aprovacao_divergente`; `(sku_portal, fator_conversao)`
  vivos ≠ `(sku_portal_aprovado, fator_portal_aprovado)` → `depara_aprovado_divergente`. Em TS
  permanecem `verificarFatorAprovado` (fator do MOTOR) e, como backstop, o round-trip
  `qtdeFisicaOmie(qtdePortal(q)) ≠ q` → `qtde_nao_multiplo_embalagem`. **A escrita de normalização
  sai**; a edge deixa de ser escritora de item.
- `recusarPreBrowserless` grava `portal_recusa_motivo = motivo` no mesmo UPDATE (transição
  `enviando_portal → erro_nao_retentavel`, a única que o guard aceita).
- **Toda transição terminal da edge é CAS** `WHERE id = ? AND status_envio_portal = 'enviando_portal'
  AND aprovacao_selo = <selo do claim>` com `.select('id')` e 0 linhas tratado por `escritaCritica`
  como divergência crítica (log + sensor), nunca silêncio.
- `cancelar_pedido_sugerido`: `FOR UPDATE` e recusa (`{error}`) quando `status_envio_portal IN
  (enviando_portal, enviado_portal, sucesso_portal, aceito_portal_sem_protocolo,
  indeterminado_requer_conciliacao)`. Front: `podeCancelar` espelha (UX; o banco é a verdade).
- `conciliar-pedido-portal`: recusa quando `portal_recusa_motivo IS NOT NULL` (por construção
  `requestSent:false`). Os demais estados conciliáveis ficam como estão (fora de escopo).

## 4. Como isto se relaciona com os chips irmãos

- **Chip 1 ("TOCTOU residual: NULL fail-closed e qtde editada pós-motor")**: coberto por desenho —
  (1) `fator_embalagem_portal NULL` deixa de reabrir o TOCTOU porque a conferência compara o de-para
  VIVO com o snapshot da APROVAÇÃO (`fator_portal_aprovado`, nunca NULL para pedido de portal — §3.1
  passo 3 exige mapeamento utilizável); (2) qtde editada pós-motor é recusada na aprovação (§3.1 passo
  2) e na edge (backstop). **Fecha só quando este desenho estiver implementado e PROVADO** (Codex: não
  fechar antes).
- **Chip 3 (ceil genérico com fator fracionário)**: independente; aviso: a regra de canonicidade do
  §3.1 passo 2 relaxa JUNTO (de "inteira" para "inteira na unidade do PORTAL"). Hoje prod só tem
  fatores 1 e 0,2, os dois com compra física inteira.

## 5. Rollout expandir → ativar (3 camadas manuais; ordem é a diferença entre nada quebrar e fila presa)

1. **M1 — expandir (sem enforcement):** colunas (`pedido_compra_sugerido.aprovacao_selo`,
   `aprovacao_selo_em`, `portal_recusa_motivo`; `pedido_compra_item.sku_portal_aprovado`,
   `fator_portal_aprovado`), `reposicao_pedido_e_portal`, `reposicao_selo_itens`,
   `reposicao_selar_pedido`, `reposicao_conferir_envio`, RPC 3-args + wrapper 2-args (as DUAS já
   selam), `pedido_compra_split` seal-aware, `cancelar_pedido_sugerido` com o guard de voo, claims
   positivos, `NOTIFY pgrst`. `DO $post$` relê o catálogo. Nada aqui recusa escrita.
   Com M1 e edge/UI velhas: a edge velha ainda normaliza (sem trava, passa) e ignora o selo; a UI velha
   chama a de 2 args (que sela). Nada quebra.
2. **Publish (UI) + deploy da edge v1.4 + `conciliar-pedido-portal`.** Com M1 aplicada a edge nova
   encontra as colunas e a RPC de conferência; pedidos aprovados antes da M1 não têm selo →
   `selo_ausente` (medido hoje: 1 pedido, #2388, já terminal).
3. **M2 — ativar:** os 2 triggers (§3.2, §3.3). Pré-condição medida por query: zero pedidos em
   `enviando_portal` e o `sonda` da edge respondendo `1.4`. Se M2 fosse aplicada com a edge velha no
   ar, a normalização dela tomaria `SA001` com o pedido em `enviando_portal` e o watchdog o levaria a
   "indeterminado" sem POST — por isso M2 é a última.
4. **Sensor da fase seguinte:** `SELECT portal_recusa_motivo, count(*) FROM pedido_compra_sugerido
   WHERE criado_em > now()-interval '30 days' GROUP BY 1` contra o denominador de envios. Sem esse
   número, "reabrir para aprovação" não nasce.

## 6. Prova

- **PG17 `db/test-reposicao-selo-aprovacao.sh`** (padrão dos harnesses; asserts negativos casam a
  SQLSTATE exata e re-lançam o resto; `SET ROLE authenticated` + GUC do JWT nos cenários humanos):
  RPC 3-args sela · wrapper 2-args sela · flip direto sem GUC → `SA007` · token divergente (id, sku,
  qtde, fator) → `{error}` e NADA muda · humano sem token → `{error}` · `cockpit:auto` sem token sela ·
  fração/NULL/≤0/não-múltiplo → `SA005` · sem de-para utilizável → `SA006` · ambíguo → `SA003` · fator
  motor ≠ vivo → `SA004` · **duas sessões** (psql em background): UPDATE de item iniciado durante a
  aprovação bloqueia e termina em `SA001` · INSERT idem · UPDATE preço em selado passa · DELETE →
  `SA001` · bypass com `authenticated` NÃO passa; com `service_role` passa · selo imutável fora da
  transição · sem volta a `pendente_aprovacao` · motivo só em `enviando → erro_nao_retentavel` e
  imutável · reenvio com motivo → `SA002` por qualquer caminho (inclusive limpar motivo antes, que é
  ele mesmo recusado) · cancelar em `enviando_portal` → `{error}` · claim recusa pedido com motivo ·
  split de 45 itens sob bypass: 3 filhos selados a partir dos snapshots, sem reler o de-para, e
  **mudar o de-para depois NÃO muda o selo** (é snapshot) mas faz `reposicao_conferir_envio` devolver
  `depara_ok=false` · hash: ordem por id, `0,20 ≡ 0,2`, NULL ≠ vazio. Falsificação uma camada por vez
  (trigger de item removido → o teste de duas sessões fica vermelho; comparação do token neutralizada
  → a corrida "antes" fica vermelha; guard de reenvio sem o ramo `enviando_portal` → o salto
  intermediário passa indevidamente; `FOR SHARE` removido → o INSERT concorrente entra no selo).
- **vitest**: backstop TS (`qtde_nao_multiplo_embalagem`, tabela de casos) e o gate de forma da edge
  (`qtde-portal-edge-invariants.test.ts`) com o assert NEGATIVO "nenhum `pedido_compra_item.update`
  antes de `enviando_portal`" e o POSITIVO "toda transição terminal filtra `enviando_portal` e
  `aprovacao_selo`".
- **Deno `test:edges`** (`--no-remote`), `edges:typecheck`, `sonda:bump` (v1.4) + `sonda:fingerprint
  -- --write`, nas 2 edges tocadas.
- **Codex challenge** sobre esta v2 antes de implementar e sobre o PR depois.

## 7. Fora de escopo (dito, não esquecido)

- Selo do lado **Omie** (preço/valor_total): a exceção de preço no §3.2 deixa uma aba velha alterar
  `preco_unitario`/`valor_linha` depois da aprovação — não muda o portal, mas pode mudar o PO no Omie
  quando a captura de custo do portal for cega. É outra invariante (`disparado = aprovado` no Omie),
  outra fatia.
- "Reabrir para aprovação" (ver §8.3).

## 8. Decisões para o founder

1. **Selo por função única + triggers-guarda (v2) — recomendo.** Substitui "trigger que sela" da v1:
   o trigger agora só garante que ninguém aprova sem passar pelo selo (`SA007`), o que fecha o
   `runAutoApprove` e qualquer flip direto futuro.
2. **A aprovação VALIDA e a edge RECUSA (`qtde_nao_multiplo_embalagem`); ninguém normaliza** —
   recomendo. Custo: a UI passa a salvar a quantidade canônica antes de aprovar (ItensTable arredonda
   ao múltiplo; o modal persiste o `ceil` que já exibe). Auto-aprovação de pedido não-canônico é
   recusada com log, não arredondada.
3. **Sem reabertura, e agora PROIBIDA no banco** (§3.3.3): pedido recusado por selo só sai por
   "cancelar + ciclo regrava". Recomendo, com o sensor do §5.4 decidindo se a RPC de reabertura nasce.
4. **Escopo do selo = o que o PORTAL recebe; preço fica fora** — mantenho a recomendação, registrando
   que o Codex prefere restringir preço aos estados de 1ª compra e à RPC de captura (§7 explica o
   risco). Alternativa: incluir `preco_unitario` nas colunas seladas exceto quando `status =
   'falha_envio'` ou via `sayerlack_aplicar_custo_portal` (bypass `service_role`).
5. **Token de revisão obrigatório em aprovação humana** (§3.4.3): `PedidoRow` e lote passam a buscar
   os itens antes de aprovar (um select por pedido). Alternativa mais barata e mais fraca: aceitar
   `NULL` fora do modal e confiar só na trava "depois".
6. **Split fica no disparo, seal-aware sob bypass `service_role`** (§3.5) — recomendo. Alternativa:
   splitar NA aprovação (filhos nascem selados na mesma transação) — mais limpo, porém muda
   `disparar-pedidos-aprovados` para expandir `split_em_filhos` e é uma fatia maior.
7. **Chip 1** não fecha agora; fecha quando a prova do §6 estiver verde em prod.

## 9. O que a v2 mudou em relação à v1 (rastro do challenge Codex)

Acatados: P0-1 (RPC invoker não executa `persistir` → a aprovação valida em vez de integerizar);
P0-2 (token cobre sku/fator; `FOR UPDATE` nos itens + `FOR SHARE` no pai pelo trigger; token
obrigatório para humano); P0-3 (cancelar recusa envio em voo; claim positivo; CAS com selo nas
transições terminais); P1-4 (split seal-aware); P1-5 (canonicidade validada, não transformada; UI
salva canônico); P1-6 (selo/motivo imutáveis; sem reabertura; guard cobre `enviando_portal` e limpeza
de motivo; bypass gateado por `current_user`); P1-7 (conciliação recusa motivo de selo); P1-8
(de-para utilizável obrigatório na aprovação; bound 1e9 no SQL); P1-9 (rollout expandir→ativar em 2
migrations); P1-10 (overload sem DEFAULT + wrapper, sem DROP; `NOTIFY pgrst`; tipos regenerados);
P2-11 (hash em `jsonb_agg` + `convert_to` + hex); P2-12 (comparação de `numeric` em SQL);
P2-14 (asserção do de-para corrigida; cenários de 2 sessões, split, cancelamento, conciliação, saltos
do guard, promo, ordens parciais de deploy).
Em desacordo, registrado: P2-13 (preço fora do selo) — decisão §8.4.
