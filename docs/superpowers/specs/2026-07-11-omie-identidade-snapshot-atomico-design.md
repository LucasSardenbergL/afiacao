# Identidade Omie por snapshot atômico server-side — follow-up estrutural do #1288 — design

> **money-path** (identidade cliente→pedido→carteira/atribuição). Follow-up ESTRUTURAL do [#1288](../../../) (fail-closed do resolver de identidade do `syncPedidos`, já mergeado). O `/codex challenge xhigh` do #1288 (2026-07-10) apontou 3 furos que o hardening TS-puro não fecha — exigem migration/RPC + coordenação. Conduzido por Claude + `/codex` (parecer cru na §10). Deploy PENDENTE do founder (Lovable: edge pelo chat + migration no SQL Editor).

## 1. Problema — os 3 achados (Codex xhigh, confirmados no código)

Todos giram em torno de UM predicado: **"documento ambíguo = doc que aparece em 2+ profiles com `user_id` distinto"**. Hoje ele é computado **no edge, por paginação não-atômica**. A correção move o predicado (e a prova de identidade inteira) para um **snapshot único server-side**.

- **A1 — Corrida de paginação não-atômica.** `omie-vendas-sync` monta `docToUserMap` lendo `profiles` em múltiplas páginas KEYSET ([index.ts:907-928](../../../supabase/functions/omie-vendas-sync/index.ts)); `omie-analytics-sync` faz o mesmo por OFFSET ([index.ts:251](../../../supabase/functions/omie-analytics-sync/index.ts) `fetchProfileDocUserMap`, P1b). Leitura multi-página **não é atômica**: um profile que nasce/muda entre páginas escapa da detecção de doc-ambíguo. O próprio código já marca "follow-up v2: RPC `GROUP BY doc HAVING count(distinct user)=1`".
- **A2 — Cache-first bypass + prova por ausência.** `syncPedidos` consulta o `clientCache` (código→user, da view fresca 7d) ANTES do `docToUserMap` ([index.ts:1186](../../../supabase/functions/omie-vendas-sync/index.ts)); um hit retorna direto, sem o fail-closed. **Furo mais profundo (Codex):** a proof-table **não registra o documento que produziu a prova** — filtrar por `NOT EXISTS doc ambíguo` é *ausência de contraindicação*, não *prova positiva*. Um vínculo `C→u1` criado com doc `X` sobrevive mesmo depois de `u1` mudar para `Y` e `u2` receber `X` (a view junta `C→u1` ao doc atual `Y`, único, e mantém — mas `Y` nunca provou `C→u1`). Também deixa passar vínculo cujo profile foi apagado/ficou sem doc.
- **A3 — Head-of-line blocking + métrica agregada.** O loop de resolução usa `Promise.all` + `throw e` no incremental ([index.ts:1149-1163](../../../supabase/functions/omie-vendas-sync/index.ts)); `callOmieVendasApi` dá `throw` para qualquer faultstring que não seja rate-limit/transitório/"Não existem registros" ([:254](../../../supabase/functions/omie-vendas-sync/index.ts)). Um código com fault Omie **determinístico** derruba a run inteira → a próxima reprocessa a mesma janela e falha igual → pedidos represados até o código sair da janela (~5 dias). E `skippedNoClient` ([:1187](../../../supabase/functions/omie-vendas-sync/index.ts)) agrega doc-ambíguo + doc-ausente + cliente-inexistente numa métrica só.

## 2. Evidência (psql-ro, produção, 2026-07-11)

- **proof-table `omie_customer_account_map`:** colunas `(id, user_id, account, omie_codigo_cliente, omie_codigo_vendedor, source, created_at, updated_at)` — **sem documento**. `UNIQUE(omie_codigo_cliente,account)`, `UNIQUE(user_id,account)`, `CHECK source IN (document,code,manual)`, FK `user_id→auth.users`. RLS on, **zero grants** (só service_role/owner). `security_invoker=true` na view fresca.
- **view `omie_customer_account_map_fresco`** = `SELECT <8 cols> WHERE updated_at >= now()-'7 days'` (só filtro de frescor).
- **`profiles`:** 5.276 profiles com doc>=11 (todos). Normalização `regexp_replace(document,'\D','','g')`. RLS on.
- **doc-ambíguo no lado profile HOJE = 0.** Fenômeno raríssimo (1 CNPJ = 1 conta). ⟹ A1(fail-closed) e A2 são **blindagem preventiva**, impacto imediato zero; o dado não denuncia sozinho → canário comportamental é a única prova do deploy.
- **`fin_sync_log`:** 57 runs `sync_pedidos` status=`error` em 30d (vs 784 `complete`), `rate_limits_hit=0`, **concentrados em 4 dias de junho** (11/13/14/18; pico 30 em 14/06) e **zero nos últimos 23 dias**. Assinatura de head-of-line blocking real (A3) mas **não ativo agora**.
- **cron:** incremental a cada 2h (`vendas-sync-pedidos-{oben,colacor}-2h`) + continuação por cursor a cada 6min (`vendas-sync-continuacao-6min`). O `throw e` do A3 está no **path incremental** ([index.ts:2967](../../../supabase/functions/omie-vendas-sync/index.ts)).

## 3. Princípio de correção

1. **Atomicidade server-side.** Resolver identidade num **único snapshot MVCC** (função `LANGUAGE sql STABLE` — todas as sub-consultas usam o snapshot da chamadora). Fecha a corrida de paginação nos dois edges de uma vez.
2. **Prova positiva, nunca ausência** (money-path.md §1, regra P0-A). Um vínculo código→user só vale se: `source='document'` **E** o documento de evidência ainda existe no profile do MESMO user **E** esse doc ainda é único. Sem evidence, o vínculo degrada para o fallback (que também é prova positiva por doc único). **Nunca** "manter porque não achei contraindicação".
3. **Unknown defaults to fatal** (A3). Só uma **allowlist estreita** de faults determinísticos por-cliente é isolável; todo o resto (transitório, 5xx, auth, JSON malformado, **faultstring desconhecida**, erro de banco, falha ao persistir a fila) continua abortando/pausando. Isolar errado troca *bloqueio visível* por *perda silenciosa* — pior no money-path.
4. **Ou isola direito, ou não isola.** Isolar um pedido exige gravá-lo **durável e order-level** (por `codigo_pedido` + janela) ANTES de avançar a página, com escrita **obrigatória** (falha aborta) e alerta de backlog. Sem isso, mantém o `throw`.

## 4. Arquitetura

### 4.1 RPC única `omie_sync_identity_snapshot(p_account text) → jsonb`

Substitui a paginação (A1) e o cache-first bypass (A2) num snapshot atômico. `LANGUAGE sql STABLE`, `SECURITY INVOKER` (o edge já é service_role e já lê `profiles`; DEFINER só aumenta privilégio), `SET search_path=''`, corpo `BEGIN ATOMIC` (analisado no CREATE — pega `42P01`/`42703` já no deploy, não em runtime). Retorna:

```
{
  "doc_to_user":     { "<doc_norm>": "<user_id>", ... },   // count(distinct user)=1
  "ambiguous_docs":  ["<doc_norm>", ...],                    // count(distinct user)>1 — separa métrica
  "client_to_user":  { "<omie_codigo>": "<user_id>", ... }   // prova positiva, conta p_account
}
```

`client_to_user` inclui um vínculo só quando: `account=p_account` **E** `source='document'` **E** `evidence_document_normalized IS NOT NULL` **E** o doc de evidência é único (`∈ doc_to_user`) **E** aponta para o mesmo `user_id` do vínculo **E** o profile desse user ainda carrega esse doc **E** `updated_at >= now()-7d`. Retorna 1 linha / 1 jsonb escalar (o cap de 1.000 do PostgREST não se aplica ao conteúdo do escalar; consumir como objeto, sem `.single()`).

Segurança: `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` (funções nascem executáveis por PUBLIC) + `GRANT EXECUTE ... TO service_role`. Rollout: `NOTIFY pgrst,'reload schema'` + 1 chamada real via service_role ANTES do deploy dos edges (evita `PGRST202` schema-cache stale). Gate de crescimento: `pg_column_size(resultado)` + duração (risco futuro é `57014` statement timeout, não os ~290KB de hoje).

### 4.2 Coluna `omie_customer_account_map.evidence_document_normalized text` (+ writer + backfill)

Provenance da prova. O writer document-first (`omie-analytics-sync/syncCustomers`) grava o doc normalizado que casou. **Backfill fail-closed:** linhas antigas ficam `NULL` = sem prova → **não** entram em `client_to_user` → caem no fallback `doc_to_user` (prova positiva) durante a transição; o próximo ciclo do writer reescreve com evidence (~1 dia). Degrada para status-quo, nunca fabrica. `manual`/`code` tratados por hierarquia (§6), não incluídos em `client_to_user` no v1 (só `document`).

### 4.3 Tabela order-level `omie_pedido_identidade_pendente`

Backlog durável dos pedidos isolados (A3). Grão de **pedido**, não cliente (senão registra o erro mas não o trabalho perdido).

```
id uuid pk default gen_random_uuid()
account text not null                      -- CHECK IN (oben,colacor,colacor_sc)
omie_codigo_cliente bigint not null
omie_codigo_pedido bigint not null
janela_de date, janela_ate date            -- p/ replay pela mesma janela
kind text not null                         -- permanent_fault (v1); extensível a ambiguous
fingerprint text                           -- hash/amostra MASCARADA (nunca CPF/CNPJ nem faultstring crua)
primeira_vez timestamptz not null default now()
ultima_vez  timestamptz not null default now()
tentativas  int not null default 1
resolved_at timestamptz
UNIQUE (account, omie_codigo_pedido)
INDEX parcial WHERE resolved_at IS NULL     -- backlog aberto + alerta
```

RLS on: staff **SELECT** (não ALL); escrita/resolução via service_role (edge) ou RPC staff auditada. Upsert idempotente: recorrência reabre `resolved_at=NULL` e resiste a eventos fora de ordem entre runs concorrentes (o cursor de 6min pode sobrepor a run de 2h). Alerta de backlog aberto integra o `data_health`/watchdog (SLA < 5 dias).

### 4.4 Edges

- **`omie-analytics-sync`:** `fetchProfileDocUserMap` ← `doc_to_user` da RPC (fecha a corrida do P1b); `syncCustomers` grava `evidence_document_normalized` ao casar por doc.
- **`omie-vendas-sync`:** `docToUserMap` ← `doc_to_user`; `clientCache` ← `client_to_user` (aposenta a leitura da view fresca no cache — mesma RPC, mesmo snapshot que o `doc_to_user`, fechando o caveat de "snapshots diferentes"). Loop de resolução: enum `Resolution = resolved | ambiguous | profile_missing | invalid_doc | client_not_found | permanent_fault` (substitui `Map<number,string|null>`); allowlist estreita de `permanent_fault` isolável; ordem-segura-por-página (resolver → materializar não-resolvidos → **upsert durável da fila (falha aborta)** → `criar_pedidos_com_itens` dos bons → avançar página → `resolved_at` só após gravar); métricas separadas `skippedDocAmbiguo`/`skippedDocAusente`/`skippedClienteInexistente`.

## 5. Fatiamento (PRs de risco decrescente)

- **PR-1 — RPC (A1):** cria `omie_sync_identity_snapshot` retornando `doc_to_user` + `ambiguous_docs`; os 2 edges consomem `doc_to_user` (fim da paginação nos dois). `clientCache` intocado. Fecha a corrida A1. Gate: prove-sql (RPC atômica + `42501` anon/auth) + canário comportamental (RPC real via service_role) + codex challenge do diff.
- **PR-2 — prova positiva (A2), CONSECUTIVO a PR-1:** coluna `evidence_document_normalized` + writer (`omie-analytics-sync`) + backfill NULL-fail-closed + estende a RPC com `client_to_user`; `syncPedidos` consome `client_to_user` (aposenta o cache da view fresca). Gate: prove-sql **falsificando** evidence trocado/ausente/ambíguo + codex.
- **PR-3 — isolamento seguro (A3):** tabela `omie_pedido_identidade_pendente` + enum `Resolution` + ordem-segura-por-página + allowlist estreita + métricas separadas + alerta de backlog. Gate: prove-sql (constraints + índice parcial + RLS staff-SELECT) + codex. Maior risco de implementação (isolamento apressado = perda silenciosa) → por último.

## 6. Threat model / fail-closed

- **Prova:** identidade por prova positiva no snapshot atômico — `client_to_user` só com `source='document'` + evidence vivo/único/consistente; senão fallback `doc_to_user` (doc único) ou bloqueio. **Nunca** vínculo por ausência de contraindicação nem código de conta arbitrária.
- **Fail-close drástico (`source='document'`):** doc que vira ambíguo **mata** o vínculo histórico (não é prova independente; preservar seria circular). Profile-fantasma → indisponibilidade localizada + alerta, nunca atribuição possivelmente errada.
- **Hierarquia por source:** `document` exige evidence atual/único; `manual` preservar só se atestação independente auditável; `code` só se prova código→user sem depender do mesmo doc. v1 inclui só `document` em `client_to_user`.
- **A3 unknown=fatal:** só `permanent_fault` (allowlist explícita de faultstrings determinísticas por-cliente) isola; todo o resto aborta/pausa (comportamento do #1288 preservado). **A allowlist começa conservadora** (vazia se nenhum fault determinístico comprovado — então o head-of-line de fault DESCONHECIDO segue como abort→retoma-idempotente, sem perda, precisão>recall). O ganho estrutural do PR-3 é a **infra que torna o isolamento seguro** (tabela order-level + ordem-segura-por-página + métricas), não isolar faults às cegas; a allowlist cresce só com evidência (ex.: caracterizar o fault de junho se recorrer). Não promete eliminar todo represamento — promete nunca trocá-lo por perda silenciosa.
- **Degrada honesto:** evidence NULL / doc não-único / profile ausente → fallback API fail-closed ou skip com métrica; nunca fabrica dono.

## 7. Gate (por PR)

- **prove-sql-money-path** (PG17 + falsificação): PR-1 (RPC), PR-2 (RPC estendida + coluna — falsifica evidence trocado/ausente/ambíguo), PR-3 (tabela/constraints/RLS). Gate SQL executa a RPC como service_role e **prova `42501`** para anon/authenticated.
- **vitest** dos helpers puros + **canário comportamental** `{canary:true}` que chama a **RPC real** via service_role (helper puro não detecta `PGRST202`/`42501`/shape errado/payload excessivo) + **paridade textual** MIRROR no CI.
- **`/codex challenge xhigh` do diff** por PR.
- **typecheck + test + lint.**

## 8. Deploy (ordem — Lovable, 3 camadas manuais)

Por PR: (1) migration no SQL Editor (lovable-db-operator) + `NOTIFY pgrst` + validação psql-ro; (2) deploy da(s) edge(s) pelo chat do Lovable (verbatim); (3) validar (canário verde; outcomes não regridem). PR-2 depende de PR-1 aplicado + 1 run do sync (evidence populado). Cada leitor migrado degrada a fallback se a prova faltar — aditivo, nunca corrompe.

## 9. Fora de escopo (evita expansão)

- **Cron de reconciliação** (rotina que relê a tabela e reprocessa `permanent_fault`) — follow-up. v1 = tabela durável + alerta + replay manual pela janela/IDs. (Codex: sem consumidor, só isole se guardar pedido+janela; senão mantenha o `throw`.)
- **`manual`/`code` em `client_to_user`** — v1 só `document`.
- **DROP do espelho `omie_clientes`** — Fatia 4, fora daqui.
- **Reconciliar doc-ambíguo/ausente/inexistente** como trabalho recuperável — são métricas estáveis (nada muda no reprocesso); só `permanent_fault` (e, se estendido, `ambiguous`) vira linha na tabela.

## 10. Decisões (Codex challenge, gpt-5.6-sol xhigh, 2026-07-11)

Parecer cru arquivado (`scripts/codex-async.sh`, `scratchpad/codex-out.log`). **Veredito: não aprovar como escrito** — A1 fechava, A2 (view paginada) não fechava, A3 (allSettled+tabela por-cliente) reintroduzia fail-open. Ressalva do Codex: o passo dinâmico do challenge foi bloqueado pelo sandbox (`Operation not permitted`); foi consult estático ancorado em file:line + docs oficiais. O challenge dinâmico do **diff** roda no gate de cada PR.

Achados incorporados:
- **A1 — ACEITO com mudanças:** `sql STABLE` + `BEGIN ATOMIC` (não plpgsql late-bound); `SECURITY INVOKER` (não DEFINER); `REVOKE PUBLIC`; `NOTIFY pgrst` no rollout; gate `pg_column_size`/`57014`.
- **A2 — ACEITO, corrige erro meu:** meu design fechava por *ausência de contraindicação* (fail-open sutil). Correção: **prova positiva** via coluna `evidence_document_normalized` + RPC consolidada (`client_to_user` no mesmo snapshot). Expande escopo (writer + backfill) — obrigatório, senão A2 é teatro.
- **A3 — ACEITO, sobe de nível:** tabela order-level (não por-cliente); allowlist estreita + **unknown=fatal**; ordem-segura-por-página com escrita durável obrigatória.
- **D1 (ordem) — A→B→C:** Claude + Codex convergem (C tem maior risco de implementação). A+B consecutivos (a RPC consolidada os acopla no mesmo snapshot).
- **D2 (reconciliação) — sem cron, tabela durável order-level + escrita obrigatória + alerta + SLA<5d + replay manual.** "Só tabela solta" rejeitado: ou isola direito ou mantém o `throw`.
- **Furos extras aceitos:** separar doc-ambíguo de doc-ausente (`ambiguous_docs`); enum `Resolution`; upsert idempotente resistente a concorrência; staff só SELECT; **nunca gravar CPF/CNPJ nem faultstring crua** (kind+hash+amostra mascarada — LGPD); canário chama a RPC real; gate SQL falsifica evidence.

## 11. Correção pós-Codex do PR-2 (challenge do **diff**, xhigh, 2026-07-12) — resgatada e RE-VERIFICADA em 2026-08-23

Esta seção nasceu no branch do [#1326](https://github.com/LucasSardenbergL/afiacao/pull/1326), que foi **fechado sem merge** (superado pelo [#1888](https://github.com/LucasSardenbergL/afiacao/pull/1888) — ver [prs-parados](../../historico/prs-parados-2026-08-06.md), Forma 4). O parecer do Codex é o mesmo, mas **o que shipou tem arquitetura diferente**, então cada item abaixo foi re-verificado contra o código e a PROD de hoje — não copiado.

**A diferença que reordena tudo:** o #1326 fazia `client_to_user` **substituir** a fonte do `clientCache`. O #1888 mantém o cache vindo da view fresca (`omie-vendas-sync/index.ts:1011`, que traz **todos** os `source`) e aplica a prova positiva como **overlay**, mais uma **revogação explícita** (`aplicarProvaPositivaNoCache`, `:1073`). Substituir vs. sobrepor muda qual limitação existe.

### Fechados — mas confira COMO, não SE

- **P1-b (regressão do override manual) — FECHADO, por outro mecanismo.** No #1326 a correção era um 2º ramo `UNION` para `source='manual'` em `client_valid`. No #1888 **não existe ramo `manual`**: o `manual` chega ao cache pela view fresca e é preservado por ser **excluído da revogação** (imunidade explícita, igual ao delete de ambíguos do `syncCustomers`). ⚠️ **Armadilha para quem auditar:** `pg_get_functiondef` da RPC em produção tem **ZERO** ocorrências de `'manual'` — e isso está **certo**. Concluir "regressão" a partir daí é ler a RPC isolada de quem monta o cache.
- **Chave não-canônica no parser (P3) — FECHADO, verificado.** `OMIE_SNAPSHOT_CODIGO_RE = /^[1-9][0-9]*$/` + `Number.isSafeInteger` em `src/lib/omie/omie-identity-snapshot.ts:67,85`. Fecha o alias por `Number()` (`"1e3"`/`"01000"`) nas chaves do snapshot.

### ⚠️ NÃO atravessou — regressão de força de teste (follow-up)

- **Fronteira de frescor (P3) — REABERTO.** O achado original: o assert de stale usava `8 days` exato e **não matava o mutante `7d→7.5d`**; o #1326 fechou com B10 (7.25d → FORA), B11 (6.75d → DENTRO) e F_M4 (afrouxa o TTL e exige vazamento). **O harness do #1888 voltou a usar `interval '8 days'`** (`db/test-omie-identidade-a2-client-to-user.sh:137`) e não tem nenhum caso em 7.25d/6.75d (medido: 0 ocorrências). As falsificações F6/F12 **deletam** a cláusula de TTL — o que um assert de 8d pega —, mas um mutante que **afrouxa** 7d→7.5d sobrevive, porque 8d segue fora dos dois. Fechar = reintroduzir os dois casos de fronteira + a falsificação que afrouxa (não a que deleta).

### Limitações conhecidas — re-verificadas, seguem abertas

- **P1-a (Omie-side, doc do CADASTRO muda) — pré-existente, NÃO é regressão; janela menor que a original.** A prova valida a evidência contra `profiles`, não contra o documento **atual** do Omie. Duas coisas estreitaram a janela desde julho: o writer regrava `evidence_document_normalized` com o doc corrente a cada run **diário** (`omie-analytics-sync/index.ts:674`), e a revogação do #1888 derruba o código cuja evidência deixou de resolver. O furo que sobra: doc muda no Omie **e** o profile mantém o antigo → a evidência ainda casa → nada revoga, até o refresh (~1d) ou o TTL de 7d. Exige troca/perda de CPF/CNPJ no Omie (raríssimo). `manual` é imune.
  - **Ressalva ao "~1d" e ao "TTL de 7d" (medido 2026-08-23): nenhum dos dois é garantia.** O refresh diário só regrava a evidência do cliente que **casa** com algum profile (`userByDoc.get(doc)`); no Omie-side puro — doc novo que não existe em `profiles` — o cliente não casa, a linha antiga **não é tocada** e o refresh não a corrige. Sobra o TTL. E o TTL também não fecha sozinho: a view `omie_customer_account_map_fresco` filtra **exclusivamente** por `updated_at >= now() - interval '7 days'` (`db/omie_customer_account_map_fresco.sql`) — `evidence_document_normalized` nem está no SELECT dela. Como `register_carteira_member` faz `updated_at = now()` gravando `evidence_document_normalized = NULL` (migration `20260821192817`, corpo da função), uma linha por ela renovada fica **fresca na view** (o `clientCache` segue servindo o vínculo antigo) e ao mesmo tempo **fora de `client_prova`** (evidência NULL) e **fora de `client_revogado`** (que exige evidência não-nula): nem a prova nem a revogação têm o que dizer, e o relógio dos 7d reinicia. Enquanto essa RPC for chamada para aquele `(user, conta)` — ela tem chamadores em `omie-sync/index.ts:426` e `omie-cliente/index.ts:895,956,1244` (`sync_all_clients`) —, o vínculo obsoleto **não tem prazo para cair**. Zerar a evidência é a decisão certa do #1888 (impede prova mentirosa); o efeito colateral é que o frescor renovado deixa de ter contrapeso.
- **Upsert `onConflict(user_id,account)` × `UNIQUE(codigo,account)` — ~~VIVO~~ FECHADO (2026-08-24), mas confira COMO.** O achado era: quando um código migra de user1→user2 o upsert insere (não há conflito em `(user_id,account)`) e bate na `UNIQUE(codigo,account)` da linha antiga → `23505`, que o `throw` de `:813` transformava em queda do run inteiro — um único código migrando matava o sync do dia.
  - **A correção NÃO foi aplicar a transferência**, e essa é a parte que importa. O parecer Codex (gpt-5.6-sol xhigh, 2026-08-24) refutou o desenho "o writer tem prova documental, logo pode transferir": o documento prova o **pareamento atual**, não a **autorização** da transferência. Migração legítima e captura de vínculo por edição do CNPJ no Omie produzem input **idêntico** ("código X agora tem o documento D2, que é do user2") — deletar a linha antiga automaticamente promoveria qualquer editor do Omie a autoridade sobre dono de pedido e comissão. Regra que ficou: **documento autoriza CRIAÇÃO e REFRESH; transferência vira CONFLITO.**
  - O writer classifica o lote antes de gravar (`classificarLoteProof`, `src/lib/omie/omie-transferencia-codigo.ts`, espelhado no edge): `aplicar` (código livre ou já deste user) vai ao upsert; `transferencia` **não é aplicada**; `manual_protegido` preserva override humano. O upsert passa a receber lote filtrado ⇒ nunca viola a UNIQUE ⇒ o run não cai e as outras 499 linhas do chunk passam.
  - **A UNIQUE segue no schema, intocada.** Ela é a barreira do writer SEM evidência — a RPC pontual `register_carteira_member`, cujo `23505` é fail-closed correto e tem teste com dente (A8/F3 em `db/test-register-carteira-member.sh`). ⚠️ **Armadilha para quem auditar:** esse harness chama a MESMA exceção de "defesa anti-roubo de vínculo". Concluir daí que o bulk também deveria estourar é ler a defesa fora do writer que a exerce — no bulk ela nem era coerente: só dispara quando o código **já** estava mapeado, e deixa passar livre o mesmo "roubo" sobre código novo.
  - **Trocar o `onConflict` para `(codigo,account)` é PIOR, não neutro** (medido no raciocínio, registrado aqui para não voltar): resolve a troca de dono e **quebra a troca de código** — INSERT de um código novo para um user que já tem linha viola `uq_ocam_user_account` —, que é o caso COMUM do recadastro. E implementa exatamente a transferência que o A8 existe para barrar.
  - **Colisão intra-lote** (achada ao implementar, ninguém a cobria): o P1b detecta um DOC com 2+ códigos; o **inverso** — um CÓDIGO com 2+ documentos na mesma paginação, casando com users diferentes — produz a mesma `23505` sem nenhuma linha pré-existente envolvida. Fail-closed simétrico: 2+ users disputando um código ⇒ **nenhum** o leva.
  - **Quarentena do incumbente:** ele mantém a linha (a transferência não foi aplicada), mas o Omie já diz que o código é de outro documento ⇒ `identity_state='conflict'` no ledger. O valor já existia no CHECK desde a Fatia 0 e **nunca teve emissor** (a spec de 2026-07-16 §68 admite: "nenhum caminho o emite"); o `carteira-rebuild` já o quarantina porque filtra por **negação** (`identity_state !== 'verified'`, `carteira-rebuild/index.ts:177`) ⇒ zero mudança no consumidor. Fail-closed dos dois lados: o candidato não ganha o vínculo e o incumbente para de gerar comissão até revisão humana. A reversão `conflict→verified` existe e é **simétrica** (senão seria a catraca de mão única que esta mesma seção nomeia como defeito), com critério mais estrito que a de `ambiguous`: lê `mapRows` (APLICADOS), não `accountMapByUser` — que inclui quem virou transferência.
  - **Limitação conhecida, verificada (o Codex pediu para checar): a quarentena vale para a COMISSÃO, não para a ATRIBUIÇÃO DO PEDIDO.** `identity_state` só é consumido pelo `carteira-rebuild`; o importador de pedidos (`omie-vendas-sync`) resolve identidade pela view `omie_customer_account_map_fresco` + prova positiva e **não** consulta o ledger (medido: zero ocorrências de `identity_state` naquele arquivo). Como a transferência não é aplicada, a proof segue dizendo `(user1, X)` e o pedido continua indo para o incumbente — **é o status quo**, não uma regressão (antes o run caía e a proof ficava igual). O efeito líquido é o desejado: pedido atribuído ao dono conhecido, comissão zerada enquanto a identidade está em disputa. Mas quem for fechar a fase 2 precisa saber que fazer o reader respeitar a quarentena é trabalho SEPARADO.
  - **Fora de escopo, deliberado (fase 2):** aprovação independente da transferência (tabela de conflito por `(account,código)` com `from_user`/`to_user`/aprovador/fingerprint). Sem ela, o conflito é detectado e neutralizado, mas **destravar** exige `UPDATE` manual no ledger. O Codex é explícito de que o teste que **distingue migração de roubo** só existe com esse segundo fato — com os inputs atuais os dois são indistinguíveis, e nenhum teste (deste PR ou de outro) pode alegar essa distinção.
  - **Furo adjacente que o Codex nomeou e este PR fechou junto:** o upsert mandava `source:'document'` sem predicado, então **rebaixava a linha `manual` do próprio user** — apesar de o delete de ambíguos preservá-la explicitamente. Promessa de imunidade que o dado nunca exerceu: há **zero** linhas `manual` em produção (medido 2026-08-24: 16097 `document` + 21 `rpc`), então o furo era LATENTE. **Consequência deliberada de fechá-lo:** a linha `manual` deixa de ser tocada, então seu `updated_at` não é renovado e ela envelhece para fora da view `omie_customer_account_map_fresco` (TTL 7d) se ninguém mais a escrever. Trocamos "override destruído, porém fresco" por "override preservado, porém envelhece" — renovar o frescor sem evidência nova é o anti-padrão que esta mesma seção nomeia na `register_carteira_member`.

- **P2 (unsafe-integer) — FECHADO nos dois lados; ~~metade fechada~~ (revisado 2026-08-23, sem follow-up).** Lado do **snapshot**: fechado pelo guard do parser acima. Lado do **pedido**: o `codigo_cliente?: number` de fato chega como número do JSON (`omie-vendas-sync/index.ts:45,107,129`) e **não** tem guard próprio — mas isso não abre furo, por um argumento **estrutural** (não pela faixa dos códigos reais, que era o fecho condicional do §11 original). O `Map` consultado no lookup só contém chaves que passaram pelo guard, logo **toda chave é inteiro seguro e canônico**. Daí só há dois casos: código ≤ 2^53−1 tem representação exata em double (não houve arredondamento — lookup fiel); código maior arredonda para um double **também** maior que 2^53−1, e nenhum valor desses existe no `Map`, porque o guard os rejeitou na entrada. O resultado é **miss** → `resolveClientUserId` → API Omie (fail-safe), **nunca** dono errado. Medido: `Number.isSafeInteger` sobrevive à falsificação — removê-lo do guard faz `'9007199254740993'` ser aceito e colidir com `9007199254740992` (mesmo double), que é exatamente a atribuição errada que o guard previne. Um guard end-to-end no lado do pedido seria redundante.

**Observação adjacente (fora do escopo, não medida a fundo):** `omie-vendas-sync/index.ts:579,624` usa `codigo_cliente: c.codigo_cliente_omie ?? 0`. Fabricar `0` para um código de identidade é a forma de "ausente ≠ zero"; aqui degrada para MISS→fallback (não para dono errado), mas é um `?? 0` num campo de identidade e merece olhar quando alguém tocar esse trecho.
