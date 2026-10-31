# Radar: integridade das RPCs de contato (2026-10-31)

> Pendências da frente 2 ([radar-acesso-vendedor.md](radar-acesso-vendedor.md), "Pendências fora desta frente"): duas
> falhas ANTIGAS que só o gestor alcançava e que a abertura ao vendedor (`private.cap_radar_prospectar`, #3417) deixou ao
> alcance de qualquer farmer/hunter/closer. Migration `20261031111000_radar_contato_integridade.sql`. Prova:
> `db/test-radar-contato-integridade.sh` (núcleo do CI, 43 asserts, 19 sabotagens).

## Problema

1. `registrar_contato_radar` aceitava `virou_cliente` sem a confirmação do Omie que o cadastro
   (`radar_registrar_cadastro_omie`) exige no ledger `omie_cliente_confirmacoes`. Um vendedor marcava qualquer lead como
   cliente e falseava o funil, o KPI do mês (`radar_kpis.virou_cliente_mes`) e o placar da frente 3
   (`radar_coorte_resultado` / `radar_conversao_por_faixa` contam o contato humano `virou_cliente`).
2. `desfazer_contato_radar` restaurava o status só porque ele "continuava igual à ação desfeita": A e B registram a mesma
   ação, A desfaz e o efeito de B some.

Medido em prod (psql-ro, 2026-10-31): **0** contatos `virou_cliente` na história, 0 empresas nesse status, 0 linhas no
ledger, 5 contatos humanos (1 usuário) em 64.304. Nenhum número histórico muda.

## Decisão do founder

Entre (a) recusar `virou_cliente` sem confirmação do servidor e (b) aceitar como "declarado", separado de "confirmado"
no placar: **(a)**. A (b) mexeria em 3 RPCs de placar e nas telas, e o status continuaria sem prova.

## Desenho (Codex max, 659 s: nenhum P0, 5 P1)

O 1º desenho usava o carimbo `prospeccao_atualizado_em = created_at do contato` como versão do status. O Codex
**reprovou** com um traço concreto: A descarta (X), B conversa (R), o cron da RFB descarta com o carimbo do INÍCIO da
transação dele, B desfaz R, A conversa (Y) e desfaz Y e X. Reconstruir a autoria pela ordem do relógio devolvia o lead a
`a_contatar` e apagava o descarte da RFB. O que entrou:

| Peça | O que faz |
|---|---|
| **Autoria explícita** | `radar_empresas.prospeccao_contato_id` = o contato que escreveu o estado atual. Cada contato guarda o **retrato** do estado que substituiu (`status_anterior`, `descarte_motivo_anterior`, `atualizado_anterior`, `contato_anterior_id`). |
| **Desfazer só pelo dono** | Sob a trava da linha, restaura o retrato só se o dono é o contato desfeito. Outro escreveu depois → apaga o registro e o status fica (`status_restaurado: false`). |
| **Tirar da cadeia** | Ao apagar o contato, quem o tinha como dono anterior herda o retrato dele. Sem isso, A desfaz sem ser dono e o desfazer de B ressuscitava o efeito de A (achado ao escrever a prova). |
| **Trigger `private.radar_empresas_status_guard`** | Fecha a CLASSE, não a porta. Escrita de status que não declara o dono (cadastro v1, cron `radar_aplicar_situacao`) zera a autoria, sem reescrever esses corpos. E entrar em `virou_cliente` exige vínculo + ledger por qualquer caminho (RD005), inclusive uma chamada do corpo ANTIGO que esteja em voo quando a migration commita (Codex P1). |
| **RD005 na porta** | `registrar_contato_radar` recusa `virou_cliente` sem cliente confirmado, antes do dedupe, com a mensagem que aponta o cadastro. |
| **RD006** | `virou_cliente` não se desfaz pela RPC genérica. O cliente continua no Omie, e repetir a v1 é no-op (`deduped`), então apagar o contato só esconderia a conversão. |
| **RD007 + re-marcar no-op** | O KPI do mês conta o status pelo carimbo. Por isso o vendedor tirar um cliente confirmado de `virou_cliente` (falseia para baixo) e re-marcar no mês seguinte (falseia para cima) entram aqui: tirar exige `private.cap_carteira_ler` (gestor/master); re-marcar devolve o contato de conversão como `deduped`. |
| **Dedupe só do dono** | O clique repetido em 2 min só é "o mesmo" se o contato ainda é o dono. Gestor mudou no meio → registro novo (achado da prova, A8). |
| **Janelas pós-trava** | `clock_timestamp()` lido depois das travas (dedupe, janela de 5 min do desfazer, carimbo); `p_acao IS NULL` recusado (Codex P2). |

**Front** (`RadarOutcomeMenu`): "Virou cliente" aparece **desabilitado** sem vínculo Omie ("pelo cadastro no Omie"),
também no card da rota (sem `empresa` não há como saber do vínculo). A oferta de cadastro **não** é reaproveitada (Codex
P1: ela relê `em_conversa` e avança a ficha anunciando um registro que não houve). RD005/RD007 viram aviso pela SQLSTATE,
nunca pela mensagem. O toast da conversão não tem "Desfazer". O desfazer lê 3 estados (`lerDesfazer`): `true` →
"Desfeito"; `false` → "Registro removido; status preservado" (nunca "segue o registro de X": colisão não prova autoria);
ausente (banco anterior) → `null` → "Desfeito", como antes.

## Revisão do código (Codex max, 356 s): 1 ALTA e 2 MÉDIAS, as 3 corrigidas

| Achado | Tratamento |
|---|---|
| ALTA: o trigger protegia só a ENTRADA em `virou_cliente`. Um corpo ANTIGO em voo no commit ainda tirava cliente confirmado, recarimbava a conversão e, pelo desfazer antigo, apagava o efeito de B | O trigger passa a impor RD007 a qualquer JWT (sem JWT = cron/servidor) e a manter a data da conversão quando o status regravado é o mesmo. Provado chamando o predecessor guardado (A15/A16), cada camada sabotada em separado. O desfazer antigo não é detectável por trigger: fechado por **evidência medida** na janela do apply (seção Deploy) |
| MÉDIA: `SET LOCAL statement_timeout` dentro do `aplicar_sql` não rearma o temporizador do executor (300 s), e o PÓS varria 573 mil linhas segurando ACCESS EXCLUSIVE | O `statement_timeout` sai; a varredura da invariante vai para ANTES do `ALTER`; depois dele só há DDL de catálogo |
| MÉDIA: nenhum teste atravessava as janelas de 5 min e 2 min durante a espera pela trava | D1–D4: contato com 4m59s (e dono com 1m59s), a linha presa 2,5 s com o bloqueio observado, e a janela vence na espera. Sabotagens `clock_timestamp()` → `now()` vermelhas |

## Prova

- `db/test-radar-contato-integridade.sh`: snapshot + ACL de prod + retrato de 29/10 + a 20261029201200 + o corpo vivo do
  desfazer (`db/fixtures/radar-contato-integridade-prod-20261031.sql`). Os 4 predecessores com o md5 de prod conferido
  ANTES da migration. Tem o traço do Codex, o desfazer encadeado, o motivo do descarte devolvido e duas corridas com o
  bloqueio **observado** em `pg_stat_activity` (registrar × desfazer; dois desfazer do mesmo contato → só um apaga).
  `--falsificar`: controle verde (43) e **19/19** sabotagens vermelhas no assert declarado, cada uma com a pré-condição
  verde. A porta e a classe do RD005 são sabotadas **separadamente** (cada camada tem o seu vermelho: A1/A11 e A9/A10).
- Vitest: `RadarOutcomeMenu.integridade.test.tsx` (10) e `borda-rpc.test.ts` (3 estados). Falsificado: 5 sabotagens no
  menu, controle verde na mesma invocação, 5 vermelhas.
- **Lição de harness:** simular o cron com dois comandos autocommit dá dois `now()` diferentes. O cron real usa o mesmo
  `p_agora` numa transação; o assert do carimbo (B5) pegou o defeito do harness, não do código.

## Limites declarados

- O cron `radar_aplicar_situacao` e os triggers de `radar_eventos` (frente 3) não estão no harness. O cron é simulado
  pelos dois comandos dele numa transação; os triggers de evento são fail-open e não mudam status nem contato.
- `radar_kpis` segue contando `virou_cliente` pelo carimbo do mês. O gestor tirar e devolver um cliente num mês novo
  ainda conta de novo: follow-up (medir pela data imutável `omie_cadastrado_em`).
- Contatos anteriores à migration não têm retrato nem são donos: desfazer um deles (5 min) remove o registro sem
  restaurar o status. Havia 5 contatos humanos em prod.
- `radar_aplicar_situacao` insere o contato ANTES de travar a linha e confere só os totais (Codex P1, herdado). Com a
  autoria explícita essa premissa sai do desfazer; a correspondência por CNPJ no cron fica como follow-up.

## Deploy (2026-10-31)

| Camada | Estado | Quem |
|---|---|---|
| Migration `20261031111000` | ✅ aplicada 12:39:55–12:40:04 UTC pelo envelope (`bun run db:aplicar`, tentativa **#777**, sha256 `d74ddfd6…`, o mesmo do `--ensaio` de 12:39) | esta sessão |
| Edge | nenhuma | — |
| Publish do Lovable (front: `RadarOutcomeMenu`, `borda-rpc`) | ⏳ depois do merge | **founder** (Publish) |

**Pré-voo PROD (psql-ro, 12:12 UTC):** md5 vivos = predecessores (`658d383c…`, `f695b1e6…`); guarda, colunas e triggers
ausentes; 0 `virou_cliente` sem confirmação; 0 locks não-AccessShare e 0 sessões ativas em `radar_empresas`/`radar_contatos`;
fora da janela dos crons do Radar (06:05–06:45 UTC). Repetido imediatamente antes do apply: 0 sessões ativas.

**2ª testemunha (psql-ro, outra conexão, 12:40:42 UTC):** os 3 corpos com o md5 esperado (`26c486a1…`, `b2f4de64…`,
`8e3db856…`), SECURITY DEFINER + VOLATILE + `search_path`; anon sem EXECUTE nas três; authenticated executa as 2 RPCs e
não a guarda; o gate `cap_radar_prospectar` presente em registrar; 4 colunas; os 2 triggers ativos (`O`); 0
`virou_cliente` sem confirmação; recibo #777 `aplicada` com o mesmo sha256; marcador `FIM_VALIDACAO_OK`.

**Corpo antigo em voo (Codex ALTA, a parte que trigger não alcança):** todo registro pelo corpo antigo insere um contato
humano, e todo desfazer gera `contato_desfeito` humano em `radar_eventos`. Medido de 12:34:55 até 12:40:42: **0** contatos
humanos e **0** eventos humanos. Nenhuma chamada antiga atravessou o commit.

**Bytes do front ≠ adoção:** até o Publish, o bundle antigo mostra "Virou cliente" ativo e recebe RD005 como "Não foi
possível registrar". O banco recusa do mesmo jeito; só o texto do aviso é pior.

## Follow-ups

- `radar_kpis.virou_cliente_mes` pela data imutável `omie_cadastrado_em` (o gestor tirar e devolver ainda reconta).
- `radar_aplicar_situacao`: correspondência contato↔estado por CNPJ, não só pelos totais (Codex P1, herdado).
- Regravar `bun run authz:carimbo:gravar` depois do merge: o carimbo deste PR traz 1 `PATCH_NAO_CONCILIADO` transitório
  (o auditor lê as migrations da `origin/main`, que ainda não tinham a 20261031111000).
