# Grupos de clientes / Caça aceitam CNPJ alfanumérico — follow-up 3 do #3180 (2026-10-20)

Branch `claude/grupos-caca-cnpj-alfanumerico-35c4f1`. Migration **manual** (Lovable não aplica custom):
`supabase/migrations/20261020130000_grupos_caca_cnpj_alfanumerico.sql`.
Prova PG17: `db/test-grupos-caca-cnpj-alfanumerico.sh` (81 asserts; `--falsificar` 7/7 em `LC_ALL=C` **e**
`pt_BR.UTF-8`) no `db/nucleo-ci.txt`. Fixture das predecessoras verbatim da prod:
`db/fixtures/grupos-caca-predecessoras-prod-20261020.sql`.

## O buraco (e o que ele já fazia de errado HOJE)

Depois de #3175 (Radar), #3180 (escritores), #3190/#3197 (front) e #3195 (identidade Omie), sobrou o domínio
**grupos de clientes / Caça**: `cliente_grupo_membros.documento` tinha CHECK só-dígitos (`^[0-9]+$`, 11|14) e as
6 views (`v_grupo_comercial`, `v_grupo_contatos`, `v_grupo_contas_receber`, `v_grupo_contas_receber_por_doc`,
`v_caca_compradores`, `v_caca_candidatos`) casavam o documento por `regexp_replace(x, '\D', '', 'g')`.
Consequências, **medidas no harness** (zona O, antes da migration):

- o exemplo oficial da RFB (`12.ABC.345/01DE-35`) não entra em grupo (23514) e, na Caça, vira `NULL` → o cliente
  some das duas views;
- pior: um alfanumérico **válido** cujos dígitos formam um CPF — `AEG12345678909` → `12345678909` — **contamina**
  o grupo e a Caça de **outra pessoa**: o grupo do CPF ganhava 2 contatos, R$ 60 de título em vez de R$ 20, e na
  Caça o CPF somava os pedidos dos dois (600 em vez de 200). Acervo de prod em 2026-10-20: 0 membros, 0 documentos
  com letra em `profiles` (5.668) e `fin_contas_receber` (45.326) — preventivo, mas o mecanismo estava armado.

## O que a migration faz (molde TRAVA → PRE → CREATE → PÓS, idempotente, `BEGIN…COMMIT`)

1. **ACL dos helpers do #3195** — `cnpj_alfanumerico_valido(text)` e `normalizar_documento(text)` ganham `EXECUTE`
   para `anon` e `authenticated`. Não é opcional: o CHECK roda como quem **insere** e as views são
   `security_invoker` legíveis por `anon`/`authenticated` → sem o grant, staff recebe **42501** (medido: até o
   `claude_ro` recebia `permission denied for function normalizar_documento`). Codex: funções puras, sem dado,
   algoritmo público — o grant é adequado; `security_invoker=off` **não** dispensaria o `EXECUTE` do invocador.
2. **CHECK** `cliente_grupo_membros_documento_digits` → `cliente_grupo_membros_documento_formato`:
   `^[0-9]{11}$ | ^[0-9]{14}$ | cnpj_alfanumerico_valido(documento)`. Minúscula, máscara, DV errado, 10/12/13
   dígitos → 23514 (fail-closed); CPF/CNPJ numéricos **continuam sem DV**, deliberadamente (byte-idêntico).
3. **6 views** — SÓ a expressão do documento (as de telefone ficam) vira
   `CASE WHEN x ~ '[A-Za-z]' THEN normalizar_documento(x) ELSE regexp_replace(x,'\D','','g') END`.
   Semântica ≡ `normalizar_documento(x)` (sem letra a função cai no MESMO regexp_replace; NULL → NULL), mas o
   numérico — 100% do acervo — **não paga a chamada**. Corpo = `pg_get_viewdef` da prod com a troca; colunas,
   tipos, ordem, `reloptions` (literal `on` nas `v_caca_*`, `true` nas `v_grupo_*`) e ACL inalterados (a PÓS
   compara com a foto tirada na TRAVA).

PRE: md5(prosrc) dos 2 helpers **só** aceita o de prod (não são recriados aqui); md5(viewdef, pretty) das 6 views
∈ {prod, este}; CHECK vivo ∈ {antigo, este}. PÓS executa: DV do exemplo oficial, chave da máscara minúscula,
`has_function_privilege` dos 3 papéis, CHECK validado + antigo ausente, **INSERT real** do alfanumérico numa
subtransação desfeita (23505 também vale: re-aplicar com o membro já presente não pode falhar) e DV errado → 23514.

## Lições (o que custou e o que ficou)

- **`normalizar_documento` não inlina** (tem `SET search_path`): 50k linhas numéricas em PG17 — `regexp_replace`
  36 ms · `normalizar_documento` 285 ms · guard 66 ms. Sobre 45k títulos a view de contas a receber pagaria ~1 s
  por leitura. O guard `x ~ '[A-Za-z]'` é exato (A5.2 prova a equivalência nas 50k + contraexemplos) e barato.
  Codex (D) antecipou: medir **consumindo** o resultado — `count(*)` sobre subquery elimina a expressão.
- **`echo` do zsh engole `\D`**: o gerador das views com `echo "... '\\D' ..."` produziu `regexp_replace(x,'D',…)`
  — em prod removeria só a letra D, não a máscara. Pego ANTES do harness ao ler a deparse; regenerado em perl.
  Geração de SQL por shell: `printf '%s'`/perl, nunca `echo` com barra.
- **`md5(pg_get_viewdef(oid))` ≠ `md5(pg_get_viewdef(oid, true))`** — a casa usa `true`; medir a prod com o
  mesmo pretty da PRE, senão a PRE nasce mentindo.
- **`public.set_config` é um shim** (`fin.*` só) — dentro de `DO` sob `search_path=public,pg_catalog` ele vence o
  builtin: `pg_catalog.set_config(...)` sempre.
- **Smoke da PÓS não pode usar documento que possa existir**: a 1ª versão inseria CNPJ/CPF numéricos de smoke e
  bateu no UNIQUE do harness (e bateria em prod); ficou só o alfanumérico, tolerando 23505.
- **Falsificação in-process não passa no fiscal** (`scripts/falsificar-exige-assert-gate.ts`, R1/R2/R3): a 1ª versão
  sabotava e restaurava no MESMO cluster — a PRE (certa) recusava restaurar um CHECK sabotado e as rodadas
  seguintes herdavam o estado quebrado ("verdes" por cascata). Migrou para o idioma da casa: lista
  `SABOTAGENS="nome:ASSERT"` (ids alfanuméricos, sem ponto), uma rodada = um cluster novo com `SABOTAGEM=<nome>`, e o
  vermelho que conta é `^FAIL <ASSERT> ` no log daquela rodada — precisão, não "ficou vermelho".
- **macOS = bash 3.2**: sem `declare -A`; expansão indireta `${!n}`.
- `$(estado …)` roda em subshell — o "último erro" vai para arquivo, não para variável.

## Front (módulo governança)

`useClienteGrupos.normalizarDocumento` delega ao espelho `src/lib/omie/cnpj-alfanumerico.ts`; `avaliarDocumento`
devolve `{chave, motivo}` e o diálogo mostra o motivo. **Achado P1 do Codex incorporado:** o que tem a **forma** de
CNPJ alfanumérico (14 posições com letra, cru ou máscara exata) mas DV errado é recusado como `dv_alfanumerico`
— não cai nos dígitos, porque `AEG12345678908` → `12345678908` seria aceito como CPF de outrem. Letra fora
dessa forma (`CNPJ: …`, `aeg-123.456.789-09`) continua caindo nos dígitos (decisão do #3192). `src/lib/caca/documento.ts`
passa a re-exportar o helper (mesma chave das `v_caca_*`). Testes: `src/queries/__tests__/useClienteGrupos.documento.test.ts`
e `src/lib/caca/__tests__/documento.test.ts`.

## O que fica de FORA (explícito)

- **Espaços externos TS × SQL** (Codex E, P1): o helper TS faz `trim()` (tab/newline/NBSP), o SQL `btrim()` (só
  espaço). Uma fonte `"\t12.ABC.345/01DE-35\t"` vira chave no front e `123450135` na view. Não é deste domínio (é
  o contrato de #3180/#3195) e os escritores já gravam normalizado; registrado, não corrigido.
- A prova sabota contatos e Caça-compradores; as outras 4 views são a MESMA troca (gerada pelo mesmo script) e
  são cobertas pelas asserções funcionais A1/A3, não por sabotagem própria.
- Planos completos das views com RLS/filtros do app não foram medidos em prod (o `claude_ro` não executa a
  função); a medição é o microbenchmark PG17 acima.

## Aplicação em prod (2026-10-20)

O founder mandou "roda você": aplicada pela sessão via `mcp__lovable__query_database` (entra como `postgres`, transação
completa — piloto-deploy-mcp-lovable.md), com guarda de identidade antes (`current_user`, 5.668 profiles, 0 membros,
CHECK antigo, md5 da view = medido) e **atestada por fora via psql-ro** (query de validação `✅`, 6 md5 = "este",
literais `on`/`true` e ACL das views intactos, smoke desfeito). Achado na atestação: `claude_ro` recebia
`permission denied for function normalizar_documento` ao ler as views — o #3195 revogou os helpers de PUBLIC e as
views agora os chamam. Entrou na migration um `GRANT … TO claude_ro` condicional à existência do papel (no harness
não existe) e a PÓS o confere; re-aplicada (idempotente, PRE aceita "este").

## Pendências do founder

- 🖱️ Publish do Lovable após o merge; verificar com `.claude/skills/lovable-deploy-verify/scripts/monitor-deploy.sh`.
