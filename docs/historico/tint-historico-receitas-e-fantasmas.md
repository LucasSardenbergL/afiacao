# Tintométrico — histórico de receitas (H1) e as 7 cores-fantasma do card (A) — 2026-10-26

Migrations `20261026214720_tint_receita_versoes.sql` e `20261026214721_tint_arquivar_staging_fantasma.sql`.
Prova executada: `db/test-tint-receita-versoes.sh` (PG17; 21 asserções + 19 sabotagens no lote 1; 28 + 26 com o lote 2 — verde em C e pt_BR.UTF-8).

## O problema

Depois do full re-scan de 24/10 (conector 0.2.4), o card `/tintometrico` → "Fórmulas rejeitadas pela
fonte" caiu de 51 para 9 cores. Sobraram `303U - BS` (aguarda a Sayerlack), `ESTOJO DE COURO ` (viva,
cadastro incompleto na máquina — corante 13 com 0 ml no slot 4; correção no balcão) e **7 cores** com
o slot livre gravado como corante `'0'`: `4602081`, `4602092`, `4602093`, `4602100`,
`CAFELATTE ARAUCO ZAMBALD`, `CHOCOLATE AMARGO ` (espaço no fim), `Y149 VERDE`.

## Diagnóstico (psql-ro)

- **Saíram da fonte — provado pelo snapshot de chaves, não pelo balcão.** `tint_keys_snapshots` é a
  lista completa das chaves vivas na máquina, enviada todo dia pelo conector. A chave é
  `cor|cod_produto|id_base|personalizada` (`connector/sayersync/sync.go:1469`) — **o 3º campo é a
  BASE, não a embalagem**: o 1º join que fiz com `id_embalagem` deu ausência até para a cor viva, e
  foi o **controle positivo** (`ESTOJO DE COURO`, viva, presente em 25/25) que pegou o erro.
  Resultado: 6 cores em **0 de 25** snapshots (28/09→26/10); `CHOCOLATE AMARGO ` presente até 21/10
  10:01 e ausente depois — provável **renomeação**: `CHOCOLATE MEIO AMARGO ` (mesmo produto e base)
  chegou pela 1ª vez em 21/10 13:05.
- **Catálogo já limpo.** As 4 `4602*` nunca entraram em `tint_formulas`; as **12** fórmulas das outras 3
  (4 por cor, 20/16/16 itens) estavam todas desativadas (pelo apply do snapshot). 0 vendáveis.
  ⚠️ O diagnóstico e o comentário da migration A dizem "52" — era a contagem de um JOIN com
  `tint_formula_itens` (linhas de ITEM, não fórmulas). A migration é imutável; vale este número.
- **Por que re-logavam (~1×/dia/cor, ~2.400 linhas desde julho).** `tint_promote_sync_run` reexpande
  o latest de TODAS as cores de cada `(cod_produto, id_base)` tocado no run; o Guard 4 grava a
  rejeição em `tint_sync_errors` **antes** do filtro "a fonte retirou a cor" (`_snap_fonte`), que já
  as barrava. O purge preserva a latest por chave → nunca sairiam sozinhas, nem com re-scan.
- **Carimbar `desativada_motivo` seria risco, não proteção.** 44.185 inativas têm motivo NULL (o apply
  do snapshot não carimba), e o CHECK `tint_formulas_motivo_exige_desativacao` aborta o run inteiro
  se o promote reativar uma linha carimbada sem limpar o motivo. E não tiraria do card (o card lê
  `tint_sync_errors`).

## Decisões do founder (2026-10-26)

- **A — arquivar e remover do staging as 7 linhas.** Antes do DELETE, cópia integral em
  `tint_receita_versoes` (evento `staging_arquivado`: `staging_linha = to_jsonb` da linha, com
  `raw_data`; `itens` = linhas completas). A guarda re-prova o diagnóstico na hora do apply (latest
  da chave, chave ausente do último snapshot completo, linha anterior a ele), serializa com o promote
  pela trava do tick e aborta tudo se algo mudou. `tint_sync_errors` e `tint_formulas` intocados.
  Descartada: corrigir a ordem Guard 4 × filtro de fantasma no promote (1.006 linhas de money-path
  para uma classe que o conector 0.2.1+ já fechou na origem).
- **H1 — histórico append-only de receitas.** Medido: em 30 dias, 7.047 chegadas de staging para 1.647
  chaves, só **27 mudanças reais** (76% reenvio idêntico). Descartadas: parar o purge (~365 MB/ano,
  76% repetição, histórico ilegível) e o status quo.

## O desenho do H1

- `tint_receita_versoes`, uma linha por EVENTO de uma chave-fonte (a mesma chave do `_formulas_latest`):
  `receita` (1ª vez, ou hash diferente do anterior, ou a chave voltou depois de sair), `saiu_da_fonte`
  (ausente do último snapshot de chaves **completo e aplicado**, para versão recebida antes dele) e
  `staging_arquivado`. Append-only por trigger (UPDATE/DELETE/TRUNCATE abortam); RLS staff-SELECT;
  `REVOKE ALL` de anon/authenticated (TRUNCATE não passa por RLS).
- **Hash = embalagem + volume + (corante, dose)**, ordenado por corante (trocar de slot não é receita
  nova), com `trim_scale` (2.4645 = 2.46450). Preço é gravado, mas fica fora do hash.
- `tint_receita_versoes_capturar()` (cron `tint-receita-versoes-diario`, 05:03 UTC, 20 min antes do
  purge): janela = última versão − 2 dias (sem estado extra; um dia perdido não perde nada — o purge
  só tira linha superada com >30 dias); ignora staging com <15 min ou com itens incompletos (o
  conector manda itens em lotes, e a ingestão é 24h). A semente é a 1ª chamada, dentro da migration:
  130.185 versões, ~38 MB de itens, 7 s.
- **Limites honestos:** nada antes de 17/06 (staging mais antigo) nem as mudanças que o purge já
  levou; `saiu_da_fonte` da semente carrega a data da DETECÇÃO, não a da saída real.

## Lições

- **Ausência num snapshot só prova algo com controle positivo na mesma consulta.** Formato de chave
  errado dá "ausente" para tudo — inclusive para o que está vivo.
- **Rejeição que re-loga para sempre pode ser chave que a fonte já retirou.** Antes de culpar dado ou
  conector, cruze a chave com o último snapshot aplicado.
- **Na prova, a camada redundante apareceu na falsificação:** `evento_ant = 'saiu_da_fonte'` ficava
  verde quando sabotada, porque o evento de saída tem hash NULL e o `IS DISTINCT FROM` já cobre a
  volta. Saiu do código; a sabotagem agora troca `IS DISTINCT FROM` por `<>`, e essa troca fica vermelha.

## Apply (2026-10-27, `db:aplicar`) — e o que a conexão perdida custou

- H1: recibo **#716** (22 s); semente = 130.185 versões (130.158 chaves → as 27 mudanças), 6.886 saídas,
  89 MB. A: recibo **#718** (8 s). 2ª testemunha psql-ro: tudo ✅; `ESTOJO DE COURO` (viva) sem saída.
- A 1ª tentativa da H1 (#706) perdeu o cliente aos 70 s (`SSL EOF` no Supavisor) com os ensaios
  levando 21–32 s. **Não aplicou** — mas o backend ficou ~30–50 min *idle in transaction* segurando a
  VEZ do `aplicar_sql` (a 2ª tentativa, #711, falhou limpa com `VEZ_OCUPADA`) até o pooler encerrar a
  sessão e fazer ROLLBACK. Identifiquei o backend pela chave advisory (`hashtext` da captura) — o
  `claude_ro` não enxerga a query de outro papel. A #706 ficou em `tentativa` (a marcação à mão foi
  recusada pelo classificador do harness — corrigir no SQL Editor).
- Lição: depois de exit 5, **"tabela ausente" num instante não fecha a questão** enquanto houver
  backend com a trava do apply; espere a trava soltar antes de concluir "não aplicou".

## Lote 2 (2026-10-29) — o lote 1 cortou pelo CARD, não pela CLASSE

Migration `20261029095257_tint_arquivar_staging_fantasma_lote2.sql` (mesmo molde do lote 1, que é
imutável; troca só ids, cores e motivo). `db:aplicar`: ensaio ✅, apply com recibo **#758**.

- **O defeito do recorte.** As 7 do lote 1 eram as que o card mostrava nas últimas 24h. O card só
  mostra a cor cujo `(cod_produto, id_base)` foi tocado por um promote naquele dia, e uma chave
  fantasma pode ficar dias sem logar (`4602104`, `885J COLA` e `CINZA LENADRO MICRO METALIZADA`
  estavam sem log desde 24/10). Medida a **CLASSE** no staging (latest da chave com item de corante
  `'0'` e dose 0 × último snapshot de chaves completo e aplicado, `667a154c…` de 28/10 10:00, com
  controle positivo `ESTOJO DE COURO ` vivo), sobravam exatamente mais 7: `4602104`, `885J COLA`,
  `CINZA LENADRO MICRO METALIZADA`, `KL ` (espaço no fim), `KL PALHA`, `MARILIES PALHA` e
  `OVELHA MATHEUS`. Todas do 0.2.0, conta `oben`, personalizadas, 1 linha de staging e 6 itens cada,
  ausentes da fonte e anteriores ao snapshot.
- **Prova** (`db/test-tint-receita-versoes.sh`, a mesma do lote 1, estendida): fixture com os 7 ids de
  prod; `ARQ2`, `ARQ2_REAPLICA`, guardas `VOLTOU`/`LATEST`/`TRAVA` do lote 2 (a chave que volta é
  `KL |FO20.6501|19|true`, de cor com espaço no fim) e `CLASSE_ZERADA` (a classe vai de 14 para 7 e
  depois para 0: a medida não é vazia, e cada lote só tira as suas 7). São 28 asserts e 26
  sabotagens, verdes em C e em pt_BR.UTF-8. Entre as sabotagens novas: `A2_COR_SEM_ESPACO` (`'KL '`
  vira `'KL'` e a guarda aborta tudo) e `A2_POST_P1`/`A2_POST_P2` (a pós-condição aborta com o
  staging intacto). A P3 (itens órfãos) não tem sabotagem: o CASCADE a torna inalcançável sem mexer na FK.
- **2ª testemunha (psql-ro, depois do commit):** 7 `staging_arquivado` íntegros (`raw_data`, 6 itens),
  0 dos 7 ids no staging, 0 itens órfãos, 14 arquivadas no total e a **classe com 0 chaves**.
  Controle do efeito: as 3 do lote 1 que ainda logavam pararam depois do apply de 27/10. No momento
  do apply, o card mostrava 4 do lote 2 (último log em 28/10 17:56) e esvazia em até 24h.
- **Fora desta entrega (só reporte):** `ZAMBALD` (viva, 0.2.4, "staging vazio sem declaração de base
  pura"), `ESTOJO DE COURO ` (corante 13 com 0 ml, correção no balcão) e `303U - BS` (aguarda a Sayerlack).
- **Lição:** para limpar uma classe, meça a CLASSE na tabela onde o defeito mora, nunca a vitrine. Um card
  com janela de tempo é amostra, não censo.
