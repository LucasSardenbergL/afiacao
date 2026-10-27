# Tintométrico — histórico de receitas (H1) e as 7 cores-fantasma do card (A) — 2026-10-26

Migrations `20261026214720_tint_receita_versoes.sql` e `20261026214721_tint_arquivar_staging_fantasma.sql`.
Prova executada: `db/test-tint-receita-versoes.sh` (PG17; 21 asserções + 19 sabotagens, verde em C e pt_BR.UTF-8).

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
