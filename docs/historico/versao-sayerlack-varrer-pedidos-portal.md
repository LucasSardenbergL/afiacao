# Changelog do `VERSAO` — edge `sayerlack-varrer-pedidos-portal`

Movido de `supabase/functions/sayerlack-varrer-pedidos-portal/versao.ts` em 2026-11-07 (o arquivo afundava em
comentário; o gate `limpeza-fonte` acusa). Cada bump novo acrescenta aqui.

```text
v1.0 (2026-10-16) — varredura nova: cron 12:30 · 17:30 · 22:30 SP, emissão dos últimos 7 dias, sem cancelados;
situação importável em LISTA FECHADA (vazia na partida = só relata); bloqueia a rodada com pedido do app em
voo/conciliação; falha → e-mail 1 vez por protocolo. Revisão Codex: lista fechada revalidada na releitura da
importadora, página ilegível/HTTP ≥ 400 = falha (nunca lista parcial completa), rodada com falha = erro no registro,
timeout da importadora = indeterminado (sem e-mail).
v1.2 (2026-10-17) — lista ligada (palavra do founder + 2 rodadas de Codex): importa sozinho 1 Aberto e 5 Suspenso;
2/3 Atendido sem PO viram e-mail para conferir (o espelho não prova que a NF não está no Omie). Carência de 1 rodada
contra PO lançado à mão no Omie (visto antes em rodada de importar E sync `complete` do espelho depois da vista);
a importadora recebe a situação EXATA classificada; contrato relido antes de cada importação; contrato composto
"a/b" conta os dois pedidos.
v1.3 (2026-10-28) — reconciliação do "PO a reconciliar": pedido `disparado` do portal cujo PO sumiu do Omie (último
run válido do detector, guard causal) e cujo protocolo está "6 - Cancelado" no portal é ENCERRADO pela porta auditada
`corrigir_cancelamento_pos_disparo` (motivo cancelado_junto_ao_fornecedor, autor sistema:varredura_portal). A leitura
se estende até 30 dias só quando há pedido a alcançar; importar segue em 7. Vivo/atendido/não achado só relata.
Codex (3 P1 + 2 P2): id do PO canônico (bigint); visto = `visto_seq >= seq` do marcador (corrida com run novo);
marcador > 26 h não encerra; leitura estendida é OUTRA chamada, depois das importações, e falha dela só relata.
v1.4 (2026-11) — no app SEM PO não é resolvido: re-dispara pela importadora; adiado por pedido em voo não é falha.
v1.5 (2026-11-07, pontos cegos Onda 3) — rodada nunca verde sem prova: total anunciado pelo portal (JSON da consulta
ou texto) = linhas lidas, 0 só com "0 de 0"; colunas obrigatórias; ilegível/repetido = rodada vermelha; re-disparo
que falha = vermelha; resumo parcial guardado no erro (registro local); `listar` sem efeito; candidatos novos antes
dos re-disparos; reconsulta por número além da janela (teto 4, 1×/20 h por protocolo); carência presa > 6 h avisa.
v1.6 (2026-11-07, pontos cegos Onda 4) — o registro diz POR QUE a rodada parou antes do protocolo
(`causa_pre_protocolo`: config_ausente · leitura:<erroTipo> · prova:<motivo> · excecao), que o vigia
`sayerlack_varredura_portal` do data_health transforma em 1 e-mail por causa; e conta as sessões do Browserless da
rodada (`sessoes_browserless`: leitura_portal + importacao = total) no resumo, sucesso ou erro.
v1.7 (2026-11-08, pontos cegos Onda 5A fatia 1) — a situação de cada pedido do app lida na lista (e na leitura
estendida da reconciliação) vai para o pedido pelo escritor único `sayerlack_registrar_situacao_portal`, com o
intervalo [início, fim] da leitura; só com leitura PROVADA e código 1..7. É o que faz o claim de disparo recusar o
pedido cancelado no portal. Falha da gravação deixa a rodada vermelha. Migration 20261108120000 ANTES.
v1.8 (2026-11-08, revisão 2) — situação sem código 1..7 ou emissão ilegível contam como linha ilegível (B1); 6 não
gravado é regravado 1× e vira pendência com e-mail (B3); pedido do app em voo/conciliação bloqueia só a importação: a
rodada lê e grava as situações e termina `pulado: bloqueado` com `prova_leitura: ok_bloqueado` (B4); re-disparo de
pedido sem PO espera o sync do espelho terminar depois da última mudança (+5 min; > 6 h vira pendência) (B5);
importação sem resposta com contrato vira pendência durável sem e-mail e deixa a rodada vermelha (B6/B7); `modo=listar`
registra em `reposicao.listar_portal_sayerlack`, fora do vigia do data_health (B9).
```

```text
v1.9 (2026-11-08) — Onda 5A fatia 2, 5.4 + cobertura: passo 8 relê, 1×/dia, a situação dos pedidos com PO ainda não
faturado nem encerrado no espelho (sayerlack_cobertura_situacao_portal — a mesma fonte que o vigia
sayerlack_cancelado_com_po cobra), com leitura estendida desde a emissão mais antiga − 3 dias (teto 90). O 6 gravado
num pedido com PO abre o incidente da 5.4 (trigger). Toda falha da cobertura (sem tempo, leitura sem prova, protocolo
que não apareceu, fora do alcance) deixa a rodada vermelha.
```

```text
v1.10 (2026-11-08) — revisão 2, 8.2: funções de PÁGINA (filtros, situações, tabela da consulta, próxima página) e o
laço de paginação saem do template para _shared/sayerlack-portal-dom.ts, testados contra HTML real
(scripts/sayerlack-portal-dom.test.ts). Comportamento igual.
```

v1.11 (2026-11-08) — revisão 2, 4.3: `sessoes_browserless.importacao` conta só a importação em que a importadora
(v1.9+) respondeu `sessao_browserless: true`. `false` vai para `importacao_sem_sessao` (já com PO, recusa antes do
portal). Sem o campo vai para `importacao_indeterminada`, e então `total` é null, com a faixa
`total_minimo`/`total_maximo`. Ausente nunca vira zero. Deploy da importadora antes.
