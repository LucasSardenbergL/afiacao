# `REVOKE … FROM anon` sozinho é teatro — o espelho da armadilha do PUBLIC

**Data:** achado em 2026-08-22, entregue em 2026-09-07 · **Origem:** apply da
`20260821200000_farmer_assoc_rules_segmento.sql` (PR #1853)

> **Reconferido em 2026-09-07, antes de entregar** (a apuração e a entrega ficaram separadas por ~2
> semanas e ~225 migrations): o sensor **segue aberto** com o ACL idêntico, segue sendo a **única**
> função de `public` cujo EXECUTE para `anon` vem só de PUBLIC (1 em 213 com anon-exec), as **8**
> entradas da baseline seguem fechadas, e as ~225 migrations novas **não** trouxeram violação nova.
**Entrega:** migration `20260907160103_revoke_public_sensor_multi_conta.sql` + Parte F do `authz:check`

## O achado

`REVOKE EXECUTE ON FUNCTION … FROM anon;` é **NO-OP** enquanto `PUBLIC` mantiver o `EXECUTE`, porque
`anon` é **membro de PUBLIC**. É a armadilha já conhecida do CLAUDE.md — "`REVOKE FROM PUBLIC` **não**
tira `anon`/`authenticated`, que têm grant por NOME" — **no espelho**. As duas metades são necessárias;
nenhuma sozinha fecha.

Não é preferência de estilo, é **incoerência**: se PUBLIC retém EXECUTE, `anon` executa de qualquer
jeito. Logo "revogar de `anon` mantendo PUBLIC" nunca é intenção — é no-op ou é bug. Por isso a regra
pode ser universal sem custo de falso positivo, e reemitir o `FROM PUBLIC` é idempotente e grátis.

## O tamanho real do passivo — medido, não presumido

Varredura em prod (psql-ro, 2026-08-22) das **18 funções** que algum dia receberam `REVOKE … FROM anon`
no repo:

| desfecho | nº |
|---|---|
| efetivamente fechadas (`has_function_privilege('anon', …) = false`) | **17** |
| ainda concedendo EXECUTE a `anon` — e **só via PUBLIC** | **1** |

A única foi `public.omie_products_codigos_multi_conta()`, criada pela própria `20260821200000`.
Em todo o schema `public`, ela era a **única** função com essa assinatura de ACL (`SO-via-PUBLIC`).

**Não houve buraco aberto** (medido, não presumido): o sensor é SECURITY INVOKER (`prosecdef=false`,
não bypassa RLS); `has_table_privilege('anon','public.omie_products','SELECT')` = `false`; e a RLS
está ativa com a única policy de SELECT escopada a `authenticated`. Sem privilégio de tabela o corpo
falha para `anon` de qualquer jeito. O fecho é **defense-in-depth** — a defesa não deve depender de
uma segunda camada permanecer como está.

Contraste instrutivo: no **mesmo arquivo**, `farmer_association_rules_substituir(jsonb)` reemite os 3
REVOKE (authenticated, anon, PUBLIC) e ficou correta. A forma certa já estava ali ao lado.

## A lição de método: o gate tem de julgar por FUNÇÃO, nunca por ARQUIVO

A `20260821200000` emite `FROM PUBLIC` para a função vizinha e **não** para o sensor. Qualquer
verificação que pergunte *"este arquivo tem algum `REVOKE … FROM PUBLIC`?"* fica **verde exatamente
sobre o caso que a originou**.

Isto não é hipótese: **o primeiro grep desta própria apuração caiu nessa armadilha** — filtrou por
arquivo, e por isso excluiu do resultado a migration culpada. O grep dizia "19 arquivos suspeitos"; a
análise por função encontrou **8 pares** reais — conjuntos que nem se contêm. Medir a coisa errada
com precisão continua sendo medir a coisa errada.

## Por que a Parte F, e não a D nem dentro da E

- **Parte D** é *reescrita da definição viva* (`regexp_replace`) — outro vetor.
- **Parte E** é *EXECUTE de função fechada*, a família certa, mas o cabeçalho dela **exclui PUBLIC de
  propósito** e com razão: aceitar `FROM PUBLIC` como fecho ficaria verde sobre o grant nominal. A
  Parte F é a **metade que faltava**, não uma correção da E. Ambas convivem.
- A Parte E é ancorada numa **allowlist curada** pelo eixo custo/preço. O sensor que originou o achado
  (SECURITY INVOKER, fora do eixo) **não estaria nela** — amarrar a regra à allowlist a deixaria cega
  justamente onde ela nasceu. Por isso a Parte F é **universal**.

## Duas lições que só apareceram ao CONSTRUIR o gate

**1. O eixo do julgamento é o CORPUS ORDENADO, não o arquivo.** A primeira versão da Parte F julgava
cada migration isoladamente — e acusou a `20260821200000`, apesar de a `20260907160103` (o conserto
desta mesma entrega) fechar o débito no arquivo seguinte. Migration aplicada **não se edita**, então
o único conserto legal de uma migration mergeada é uma POSTERIOR: um gate por arquivo obrigaria a
baselinar todo conserto legítimo, transformando a baseline em depósito. Corrigido para corpus
ordenado, o fix-forward passa a ser reconhecido — e **duas** entradas saíram da baseline sozinhas.

**2. A âncora tem de ser INCLUSIVA (`>=`), e isso foi MEDIDO, não deduzido.** Ao ensinar o gate que
`DROP FUNCTION` + `CREATE` reseta o ACL (anulando um `FROM PUBLIC` anterior), a comparação estrita
`>` reprovou **13 funções** — todas falsas, porque a forma REAL de recriação neste repo é
`DROP`+`CREATE`+`REVOKE` na **mesma** migration. O detector nasceria cego exatamente para a forma
correta. É a mesma lição que a Parte E já havia documentado e pago; foi redescoberta aqui porque
não a li antes de escrever a condição. As 13 viraram 0 com `>=`; as 2 sobreviventes
(`auto_assign_user_role`, `fin_consolidado_intercompany`) foram medidas em prod — fechadas, com o
fecho vindo de FORA do repo, o caso que a Parte E modela como `fechadaPor: null`.

## Baseline honesta

8 pares históricos em `scripts/authz-revoke-public-baseline.ts`, **cada um medido `anon_exec = false`
em prod em 2026-08-22** — são `REVOKE` redundantes sobre função já fechada, inertes. Reescrever
migration aplicada seria pior que inútil (o snapshot é a fonte de DR e o passado já rodou).

Duas travas contra o apodrecimento da baseline:
1. teste `baseline não apodrece` — derruba entrada que deixou de existir ou de violar;
2. o **verde do `authz:check` declara o número de pares baselinados**, para que "gate verde" nunca
   seja lido como "cobertura textual completa" (a mesma disciplina do `ressalva`/`ressalvaE`).

## Achado adjacente (benigno, registrado para não ser re-investigado)

4 das funções baselinadas medem `authenticated = SIM` apesar de a migration revogar. **Não é
contradição:** essas migrations revogam **só `anon`** de propósito — são RPCs de staff chamadas do
browser, com gate no corpo. Verificado linha a linha em `20260605140000` e `20260606170100`.
