# Outbox: pedido INSERIDO já aprovado perdia a transição 'aprovada' (2026-10-18)

**Sinal:** sensor `analytics_outbox_trigger` em `broken` desde 2026-10-16 22:12 UTC — "Orfas: 2 de 3
aprovacoes em 48h", com o *como resolver* mandando procurar o `WARNING [analytics_outbox]` nos logs
do Postgres (INSERT perdido pelo fail-open).

## O que era de verdade

Não foi INSERT perdido. Por `psql-ro`, as órfãs (pcs **3644, 3669, 3670** — e são 3 de 3 com
`condicao_origem = 'importado_portal'`) tinham `criado_em = aprovado_em` e **só** a linha
`reposicao.sugestao_criada` na outbox — ou seja, o trigger RODOU e inseriu. A causa é a segunda que
o comentário do próprio sensor já previa: a RPC `sayerlack_importar_pedido_portal` (migration de
2026-10-14, 1º uso real em 2026-10-16, [importar-pedido-portal-sayerlack.md](importar-pedido-portal-sayerlack.md))
**insere o pedido já com `aprovado_em`**, e o ramo `TG_OP = 'INSERT'` de
`analytics_outbox_pedido_compra` emitia um único evento, 'criada'. O funil perdia 'aprovada' de
**todo** pedido importado — não era 1 incidente, era uma classe nova de escrita que o trigger não
conhecia. (Os logs do Postgres nem eram legíveis daqui: `~/.config/afiacao/supabase-pat` tem 0
bytes por desenho — `analytics.md` §"PAT". A evidência pela chave de dedup bastou e é mais forte.)

## O conserto — `db/aplicar-analytics-outbox-insert-ja-aprovado.sql` (envelope `db:aplicar`)

- **Ramo:** no INSERT, `aprovado_em IS NOT NULL` ⇒ **duas** linhas (criada e aprovada), uma por
  transição — a chave de dedup já carrega o evento, então nada muda nos ramos de UPDATE.
- **Backfill** das 'aprovada' só dos importados do portal (RPC nasceu depois do trigger: nenhum é
  pré-trigger), `ocorrido_em = aprovado_em`, `props.backfill` marcado. Órfã de **outra** origem não
  entra: seria outra causa (precisão > recall). O drain manda `event_id` como uuid — não duplica no
  PostHog.
- **TRAVA → PRE (md5 do corpo vivo ∈ {prod, este}) → CREATE → backfill → PÓS** (ramo novo vivo por
  regex, ramo de cancelamento de 2026-10-11 preservado, trigger ativo, zero importados órfãos).

## O que a prova PG17 pegou antes da prod (`db/test-analytics-outbox-insert-ja-aprovado.sh`)

1. **`text[] || 'literal'` quebra em runtime** ("malformed array literal": o Postgres resolve como
   array||array) — e a atribuição fica **fora** do bloco fail-open, então o INSERT do pedido (money-
   path) teria caído junto. `CREATE` passa; só EXECUTANDO aparece (PL/pgSQL late-bound). Virou
   `array_append`.
2. O **fixture é a prod**: o corpo predecessor entra pela migration de 2026-10-11 e o md5 do `prosrc`
   é conferido contra o medido por `psql-ro` — se divergir, a prova não prova nada.
3. Falsificação com dente: predicado do backfill sabotado ⇒ PÓS `[BACKFILL]` vermelha; ramo
   removido ⇒ PÓS `[RAMO]` vermelha **e** o corpo volta a emitir 1 linha (C2 ficaria vermelho).

## Lições

- **Trigger de transição e escritor que "pula" transições:** todo escritor que INSERE um registro já
  num estado avançado (importação, split, migração de dados) tem de ser confrontado com o trigger que
  emite por transição — o ramo de INSERT precisa emitir a **cadeia** de transições implícitas, não só
  a primeira. Ao criar um escritor assim, procure os triggers AFTER INSERT OR UPDATE da tabela.
- O *como resolver* do sensor aponta só para a 1ª causa (WARNING nos logs); a 2ª está no
  `probable_cause`. Antes de caçar log, **leia a chave de dedup**: `criada` presente + `aprovada`
  ausente + `criado_em = aprovado_em` é a assinatura do INSERT já aprovado, e a correção é o ramo do
  trigger, não o limiar do sensor.
