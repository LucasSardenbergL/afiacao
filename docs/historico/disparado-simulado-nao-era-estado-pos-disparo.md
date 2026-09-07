# `disparado_simulado` não era estado pós-disparo — mas a compra no Omie é real

**PR:** #2306 · **Data:** 2026-09-07 · **Domínio:** reposição / money-path
**Migration:** `20260907095841_disparado_simulado_e_estado_pos_disparo.sql`
**Prova:** `db/test-disparado-simulado-pos-disparo.sh` (59 asserts, verde em `LC_ALL=C` e `pt_BR.UTF-8`)

## O defeito

O modo `dry_run` de `disparar-pedidos-aprovados` **não é um dry-run**. Ele chama `IncluirPedCompra`
**incondicionalmente** e cria pedido de compra REAL no Omie — a chamada acontece antes de
`novoStatus` ser decidido; o que o dry_run muda é `cObs`/`cObsInt` e o status gravado
(`disparado_simulado` em vez de `disparado`). O `versao.ts` da edge já dizia isso.

E `disparado_simulado` não estava protegido em lugar nenhum:

| Camada | Predicado | `disparado_simulado` |
|---|---|---|
| trigger `trg_valida_cancelamento_pos_disparo` | `OLD.status IN ('disparado','concluido_recebido')` | escapa no curto-circuito |
| `cancelar_pedido_sugerido` (UPDATE) | `status NOT IN ('disparado','concluido_recebido')` | passa, carimba `cancelado_humano` |
| `corrigir_cancelamento_pos_disparo` (saída) | `v_ant NOT IN ('disparado','concluido_recebido')` | **também** recusa |

As três linhas juntas produziam o pior arranjo possível: o cancelamento errado passava sem trilha,
e o cancelamento certo (pós-conciliação, auditado) era recusado.

## Por que agora — o risco é ARMADO, não hipotético

Medido em prod via `psql-ro` em 2026-09-07:

- `empresa_configuracao_custos` tem **uma** linha: OBEN, `producao`.
- O default do código é `dry_run` quando não há config: `cfg?.modo_disparo_pedidos === "producao" ? "producao" : "dry_run"`.
- `pedido_compra_sugerido` hoje só tem pedidos **OBEN** (520) e **zero** linhas em `disparado_simulado`.

Ou seja: **este fix não muda nenhum caso existente**. Ele arma a defesa antes da 2ª/3ª empresa
começar a gerar pedidos — que é exatamente quando o buraco abriria, e em silêncio, porque uma
empresa sem linha de config cai no `dry_run` sem ninguém escolher isso.

Contexto do dano que o guard existe para impedir: **5 pedidos** com `omie_pedido_compra_id`
preenchido constam `cancelad%` (ids 33, 281, 286, 409, 1046 — abr a jul/2026), todos **anteriores**
ao guard de 06/09, e a trilha `reposicao_cancelamento_pos_disparo_audit` tem **0 linhas**.

## O que mudou

`CREATE OR REPLACE` em três objetos (nunca `DROP`+`CREATE`, que resetaria o ACL):

1. **o trigger** passa a vigiar `disparado_simulado` — cobre TODA via de escrita, não só a RPC;
2. **`cancelar_pedido_sugerido`** recusa com mensagem própria. Ela existe porque a intuição do
   operador é o inimigo: "simulado" soa como "não aconteceu". A mensagem nomeia o PO do Omie.
3. **`corrigir_cancelamento_pos_disparo`** ACEITA o estado — a saída auditada. Sem ela o veto
   viraria armadilha: o pedido ficaria sem NENHUMA via de cancelamento.

(2) e (3) são inseparáveis de (1). Fechar a porta sem abrir a saída troca um bug por outro.

## Lições

### 1. O pré-voo `pg_get_functiondef` pagou — mas o risco estava na função ERRADA

O briefing desta fatia previa risco em `corrigir_cancelamento_pos_disparo` (a migration
`20260906172718` podia não estar aplicada, e recriar do corpo vivo reverteria o gate canônico).
**Medido: a prod estava sincronizada** — corpo vivo idêntico ao do repo. Risco inexistente.

O risco real estava em `cancelar_pedido_sugerido`, onde ninguém procurou: a **prod está à frente**
da migration `20260905224959` (o nome que a busca por "guard de cancelamento" encontra). O corpo
canônico vive na `20260906170000_reposicao_selo_aprovacao_m1_expandir.sql` — uma migration de
**outro domínio**, que recriou a função de passagem. Partir da `224959` teria apagado o guard de
`status_envio_portal` em silêncio.

> **Regra:** a fonte canônica de uma função não é a migration cujo NOME fala dela — é a **última
> a recriá-la** em ordem lexical. Ache-a com `grep -rl "FUNCTION public.<nome>" supabase/migrations/`
> e confirme com `pg_get_functiondef` da prod, sempre. O nome do arquivo é uma pista, não a fonte.

O assert `[REGRESSAO-PORTAL]` da postcondição existe só para isto: se alguém recriar a função a
partir do arquivo errado, a migration aborta no apply em vez de degradar em silêncio.

### 2. `prosrc` inclui COMENTÁRIO — postcondição que procura a PALAVRA não prova a LÓGICA

A primeira versão da postcondição testava `prosrc !~ 'disparado_simulado'`. Sabotando **só a linha
da condição** no arquivo real (comentários intactos), o harness ficou vermelho em 7 asserts — e o
`DO $post$` **passou**. Os comentários que eu mesmo escrevi acima da condição citam o estado várias
vezes, e `prosrc` os inclui: o predicado casava o comentário e aprovava a lógica cega. Falha aberta.

> **Regra:** predicado de postcondição sobre `prosrc` casa a **estrutura da condição**
> (`'OLD[.]status NOT IN [(][^)]*disparado_simulado'`), nunca a menção ao nome. Contar ocorrências
> é a mesma armadilha com outra roupa: três comentários satisfazem "aparece 3×".

O assert `F7` do harness é esse caso exato — sabota a lógica preservando os comentários e exige que
a postcondição grite. Foi ele que pegou o defeito, e por isso ficou.

### 3. O 2º locale não é ritual — ele reprovou este harness

Grupo A (ACL) casava `permission denied|permissao negada` no texto do servidor. Verde em `LC_ALL=C`,
**vermelho em `pt_BR.UTF-8`**: a mensagem vem acentuada (`permissão negada`) e o regex ASCII não
casa. Trocado por **SQLSTATE** (`42501`, ASCII e estável) — mas SQLSTATE sozinha não bastava: o gate
de papel também levanta `42501`, então "negado no ACL" e "negado no gate" seriam indistinguíveis, e
o `A3` (a falsificação do eixo) perderia todo o valor. O assert compara o **par**
`SQLSTATE|[SENTINELA]`, onde a sentinela é o marcador ASCII que o próprio `RAISE` do código emite.

## Pendência para quem tocar o PR #2285 (Cenário B)

Aquele PR segue **aberto com `validate` vermelho**; o trigger `trg_veta_cancelamento_com_disparo_pendente`
não existe nem na main nem na prod. Por isso esta fatia **não** se pendurou nele — usa o guard que já
está no ar. Mas o harness dele tem o assert:

```
C3 PENDENCIA DECLARADA: disparado_simulado AINDA e cancelavel (dry_run cria PO REAL no Omie)
```

Esse canário está **cumprido**: o buraco que ele documenta foi fechado aqui. Quando o #2285 for
retomado, `C3` precisa ser reescrito (o desfecho esperado passa a ser a recusa) ou removido. Ele
não quebra o CI enquanto o harness daquele PR não aplicar esta migration — mas passa a afirmar,
por escrito, um buraco que não existe mais.
