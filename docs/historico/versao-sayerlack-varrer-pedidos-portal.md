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
```
