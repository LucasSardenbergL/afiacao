# Identidade Omie por documento aceita CNPJ alfanumérico — follow-up 1 do #3180 (2026-10-19)

PR: https://github.com/LucasSardenbergL/afiacao/pull/3195 · Branch `claude/relaxed-leakey-23ddaf`.
Migration **manual** (Lovable não aplica custom): `supabase/migrations/20261019140000_omie_identidade_cnpj_alfanumerico.sql`.
Prova PG17: `db/test-omie-identidade-cnpj-alfanumerico.sh` (40 asserts, `--falsificar` 7/7) no `db/nucleo-ci.txt`.

## O buraco que fechou

O #3175 fez o Radar aceitar CNPJ alfanumérico (RFB jul/2026) e o #3180 fez os **escritores** das fontes de cliente
preservarem as letras (`normalizarDocumento`, `_shared/cnpj-alfanumerico.ts`). Mas a **identidade** continuava
mutilando do lado SQL — dois pontos, ambos nesta migration:

1. `omie_sync_identity_snapshot(p_account)` chaveava o profile por `regexp_replace(document, '\D', '', 'g')`
   (+ `length >= 11`). O profile `AEG12345678909` (CNPJ alfanumérico **válido** — o literal do Codex ALTO é um
   CNPJ legítimo, DV confere) virava a chave `12345678909` e casava com o cliente Omie **numérico** `12345678909`
   de **outra** pessoa. A edge só fechava o caso em que os DOIS docs aparecem no mesmo run do Omie
   (`docsComCodigoAmbiguoNoOmie`); "profile alfanumérico sem gêmeo no Omie" só fecha aqui.
2. O CHECK de `omie_customer_account_map.evidence_document_normalized` era `^[0-9]{11,}$`: a evidência
   alfanumérica que o escritor passou a gravar no #3180 era **recusada** → vínculo automático impossível (caía em
   `nao_vinculados` com letras — honesto, mas sem vínculo).

**Medido em prod antes (psql-ro, 2026-10-19):** 0 documentos com letra em `profiles` (5.668) e 0 em
`evidence_document_normalized` (16.122 linhas, 0 violariam o CHECK novo). Preventivo, sem acervo a migrar.

## O que a migration faz (molde TRAVA → PRE → CREATE → PÓS)

- **`cnpj_alfanumerico_valido(text)`** (plpgsql IMMUTABLE): DV mod-11 sobre ASCII−48, pesos `5,4,3,2,9,8,7,6,5,4,3,2`
  e `6,5,4,3,2,9,8,7,6,5,4,3,2` — espelho SQL de `dvCnpj`/`cnpjValido` do helper TS. **O #3175 não criou função
  de DV em SQL** (o briefing dizia que sim): lá o DV "é validado no ingest" (TS) e o `radar_recruzar_ja_cliente()`
  casa por igualdade com um cnpj já validado. Aqui a chave precisa do DV, então a função nasce nesta migration.
- **`normalizar_documento(text)`** (sql IMMUTABLE): a chave, com a regra do `normalizarDocumento` TS **mais o aperto
  do #3192** (Codex retroativo do #3175, `radar_recruzar_ja_cliente`): o caminho alnum só aceita documento **cru**
  (14 posições) ou com a **máscara nas posições exatas** `00.000.000/0000-00` após `btrim(upper(x))`, e só então remove
  `[-./]` — `aeg-123.456.789-09` (CPF com anotação, DV válido por coincidência) cai no só-dígitos `12345678909`,
  que é o CPF de verdade. Entra como alnum **só se tem letra E é CNPJ alfanumérico válido**; senão só-dígitos,
  byte-idêntico ao `regexp_replace(x, '\D', '', 'g')` de sempre (acervo numérico com máscara/prefixo "CNPJ:"
  produz exatamente a chave de antes). Espaço interno não é separador (`aeg 987.654.321-00` → `98765432100`,
  nunca `AEG98765432100`).
- **CHECK** → `^([0-9]{11,}|[0-9A-Z]{12}[0-9]{2})$` (recriado só se a definição divergir; `COMMENT` atualizado).
- **RPC**: só `doc_valid` muda (`normalizar_documento(document)`, `length >= 11`); `doc_agg`, `client_prova`,
  `client_revogado` são o corpo do PR-2/A2 verbatim. `BEGIN ATOMIC` mantido.
- ACL das 3 funções reemitido **nomeando** as roles (fechadas a anon/authenticated/PUBLIC; `service_role` executa —
  a RPC é SECURITY INVOKER chamada pela edge com service client).

### Régua da PRE/PÓS numa função `prosqlbody`

A RPC é `LANGUAGE sql BEGIN ATOMIC` — **não tem `prosrc`**, só `prosqlbody`; `md5(prosrc)` (o molde da casa) não
serve. A régua aqui é `md5(pg_get_functiondef(oid))` com **`search_path` pinado em `public` dentro do DO**
(`set_config(..., true)`): a deparse qualifica nomes pelo search_path da sessão, e o SQL Editor pode não ter o
mesmo do psql-ro. Medido: o md5 do predecessor em PG 17.10 local (A1+A2 aplicadas) **= o de prod** (17.6,
psql-ro) — a deparse é estável entre os dois minors. Se a PÓS reprovar em prod por deparse diferente, a transação
inteira volta (fail-closed) e a régua vira marcador textual; a prova A0p pega o caso repo≠prod antes.

## Prova (PG17, cascata PR-1 → PR-2/A2 → esta)

| Bloco | Prova |
|---|---|
| A0 | predecessor local = PROD (md5) · aplica · re-aplicar é no-op · CHECK vivo é o alnum |
| A1 | helpers **executados**: exemplo oficial RFB `12ABC34501DE35` válido, DV errado inválido, numérico clássico válido, minúscula inválida; chave nos 3 ramos |
| A2 | CHECK: alnum maiúsculo entra; minúscula, máscara, 10 dígitos → `23514`; numérico 11 segue |
| A3 | **money-path**: `AEG12345678909` é chave com letras → U3; U1 alnum casa com cliente Omie alnum (`client_to_user`); `12345678909` **não é mais ambíguo** → U2 (dono real) e o código numérico vai a U2; o vínculo **antigo** de U3 com evidência mutilada fica fora de `client_to_user` **e é revogado**; numérico byte-idêntico; DV errado não vira chave; 2 users no mesmo alnum → ambíguo; disjunção |
| A4 | ACL das 3 funções |

Falsificação (cada sabotagem sozinha, controle verde na mesma invocação): `chave_so_digitos`→A3c ·
`sem_mascara_exata`→A1k (alnum aceita separador em qualquer posição; régua da PÓS neutralizada) ·
`check_so_digitos`→A2a · `dv_ignorado`→A3g (régua da PÓS neutralizada) · `dv_ignorado_pos`→A0a (a PÓS **executa**
o helper e morde) · `rpc_mutila`→A3a (md5 da RPC neutralizado) · `corpo_sabotado_md5`→A0a.

## 2ª opinião: Caminho B

`scripts/codex-async.sh -r xhigh` recusou **sem gastar** (`exit 79`: cota em 86% > teto 85%, janela reabre
24/10 19:09). Oráculo = a prova PG17 falsificável acima. **REVISÃO INDEPENDENTE PENDENTE** — rodar o Codex
retroativo (prompt em `/tmp` não persiste; reconstruir a partir deste diário + migration) quando a janela voltar.
Perguntas que eu levaria: CHECK deveria exigir DV (função) em vez de regex? Divergência `btrim`/`trim()` e
`upper()` não-ASCII entre SQL e TS? Ordem de deploy edge↔migration.

## Decisão: o laço de mutilação da edge FICA

`docsComCodigoAmbiguoNoOmie` (MIRROR em `omie-analytics-sync/index.ts` + `src/lib/omie/omie-doc-ambiguo.ts`)
marca como ambíguo o numérico que é a mutilação de um alfanumérico do mesmo run. **Depois** desta migration
aplicada o laço vira falso-positivo (alnum e sua mutilação passam a ser chaves distintas, cada uma do seu dono);
**antes** dela, é a única defesa do caso. Como merge ≠ prod e a edge e a migration sobem por caminhos manuais
independentes, remover o laço no mesmo PR abriria a janela "edge nova sem migration". Custo de manter: recall
perdido só quando um alnum e sua mutilação coexistem legitimamente no mesmo run — hoje 0 alnum em prod.
Logo: **sem bump de VERSAO, sem `sonda:bump`/`fingerprint`, sem bump de canária** neste PR. A remoção é
follow-up, gated na **atestação** da migration em prod (query de validação abaixo ✅ via psql-ro).

## Handoff (o que NÃO está no ar)

- 🟣 **Migration no SQL Editor** (envelope `BEGIN/COMMIT`; idempotente; PRE aborta se o corpo vivo não for o de
  prod revisado nem este). Validação pós-apply (psql-ro):
  `SELECT public.normalizar_documento('12.abc.345/01de-35') = '12ABC34501DE35' AND pg_get_constraintdef(c.oid) LIKE '%[0-9A-Z]{12}[0-9]{2}%' FROM pg_constraint c WHERE c.conname = 'ocam_evidence_document_normalizado_chk';`
  → `t`.
- Nenhuma edge muda neste PR. `bun run pendencias:deploy` decide o resto pelo ledger.
- Depois de atestada: (a) remover o laço de mutilação nos 2 espelhos com bump de VERSAO + contrato da
  `doc_ambiguo_probe` + `sonda:bump` + `sonda:fingerprint -- --write`; (b) Codex retroativo.

## Divergência DELIBERADA com o escritor TS (follow-up)

`_shared/cnpj-alfanumerico.ts` (`normalizarDocumento`, os 5 escritores do #3180) ainda remove `[-./]` em **qualquer**
posição — o #3192 apertou só o SQL do radar. A chave SQL daqui é **mais estrita** que a do escritor: para um input
como `aeg-123.456.789-09` o escritor produz `AEG12345678909` e o SQL `12345678909`. Consequência: o escritor nunca
consegue um vínculo que o SQL não daria (ele só CONSULTA `doc_to_user` com a chave dele → miss → sem vínculo,
fail-closed), mas pode gravar `omie_clientes_nao_vinculados.cnpj_cpf` com a chave inflada. Harmonizar o helper TS
(e seu espelho `src/lib/omie/cnpj-alfanumerico.ts`) com a máscara exata é follow-up próprio — mexe em 5 edges.

## Lições

- **"Reutilize a função X do PR anterior" é hipótese, não fato**: `grep` no artefato (`FUNCTION public.*dv*`) e
  `pg_proc` em prod antes de desenhar — aqui a função não existia em SQL e nasceu neste PR.
- **Função `BEGIN ATOMIC` não tem `prosrc`**: a régua de deriva é `md5(pg_get_functiondef)` com search_path pinado;
  medir a igualdade local×prod do predecessor é o que autoriza usá-la.
- **Contar dígitos na mão erra**: `12ABC34501DE36` sem letras tem 9 dígitos, não 10 — o assert A1j me corrigiu.
- **Quando a PÓS executa o helper, a sabotagem semântica precisa de DUAS versões**: uma neutraliza a PÓS para
  alcançar o assert funcional; a outra prova que a PÓS morde. Uma só deixaria o assert funcional sem prova de dente.
