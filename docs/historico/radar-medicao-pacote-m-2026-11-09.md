# Radar, pacote M: medir a adoção com denominador (2026-11-09)

> Sessão `radar-m-medicao` (worktree `affectionate-faraday-422348`), um dos 5 pacotes da 3ª revisão do Radar
> (J privacidade · K carga · L vendedor · **M medição** · N acabamento). Migration
> `20261111134500_radar_medicao_pacote_m` (**manual**, `bun run db:aplicar`, aplica o founder: tem `DROP FUNCTION`
> e expurgo por cron). Front: **Publish**. Prova PG17: `db/test-radar-medicao.sh` (`--falsificar`, 10 sabotagens).

## Por que (medido em PROD por psql-ro em 2026-11-08)

- `radar_eventos`: **64.299** eventos `automatica` (o descarte da Receita, 1 por contato automático), 37 `abriu`
  humanos (1 usuário) e 5 contatos humanos (todos de 15/06). 24 MB.
- 0 linha em `radar_lead_aberturas`, `radar_prospectar_hoje_servido` e `radar_atendimentos`.
- Elegíveis ao Radar agora (`private.cap_radar_prospectar`): **3** (o master e 2 farmers).

O painel do pacote H (`/radar/funil`) tinha três buracos de **denominador**:

1. **O universo sumia.** A população nascia de eventos, envios e config ativa: o vendedor elegível que nunca
   abriu nada não aparecia, e "ninguém usa" ficava igual a "ninguém tem acesso".
2. **A reposição do card estourava 100 %.** O sensor gravava só a 1ª quantidade do dia; o Assumir repõe leads e os
   cliques acumulam: 3 servidos, 6 cliques = 200 %, e o painel dizia que o sensor tinha perdido registro.
3. **Ligar, WhatsApp e copiar não deixavam rastro no banco.** Só `track()` (PostHog, censurado no navegador do
   founder); o link do WhatsApp nem isso.

## O que entrou

- **M1 universo e adoção.** `radar_funil` lista todo elegível agora, com zero explícito nas linhas. Chave nova
  `adocao`: por vendedor, se é elegível, quando foi exposto (card, e-mail entregue, tela ou ficha aberta), a 1ª
  ação humana (clique em lead, ficha, intenção, contato, cadastro, assumir — atribuição do gestor não conta como
  ação do dono), dias com ação e ações. A aba **Uso** do `/radar/funil` mostra as 4 etapas com o MESMO
  denominador: elegível → exposto → 1ª ação humana → uso em outro dia (ação em ≥ 2 dias).
  - Limite declarado: "elegível" é o de AGORA; a autorização de semanas passadas não é reconstruída. Quem agiu e
    perdeu o acesso aparece à parte ("fora do denominador").
- **M2 reposição.** Tabela `radar_card_exibicoes` (1 por vendedor, dia e CNPJ; RLS sem policy, só RPC) e
  `radar_registrar_card_exibido(cnpjs[])`. O card manda a lista exibida a cada leitura que traz CNPJ novo; o banco
  grava só o novo. O painel ganha `card_leads_exibidos` e `card_leads_clicados_exibidos` (clique em CNPJ exibido no
  mesmo dia: ⊂ por construção). Semanas antes do 1º registro seguem `—`, e o aviso antigo agora explica a
  reposição em vez de culpar o sensor. Banco sem o pacote M: o front cai no sensor antigo, sem registrar falha.
- **M3 intenção de contato.** `radar_eventos` aceita `evento = 'intencao'` (`acao` ligar | whatsapp | copiar;
  constraint de forma), escrito por `radar_registrar_intencao(cnpj, canal)` (1 por vendedor, CNPJ, canal e dia).
  Ficha: Ligar (celular), Copiar telefone (desktop) e WhatsApp gravam; sob a lente "Ver como", nada. O funil mostra
  "Intenções de contato" por semana e vendedor.
- **M5 retenção.** `private.radar_expurgar_medicao()`, cron `radar-expurgo-medicao-diario` (07:20 UTC):
  automáticos de `radar_eventos` em lotes de 20 mil (o backlog sai em ~4 dias); `abriu`/`intencao` humanos,
  `radar_lead_aberturas`, `radar_card_exibicoes` e `radar_prospectar_hoje_servido` com mais de 400 dias;
  `radar_sensor_falhas` com mais de 180 dias. Contato, desfazer e cadastro **humanos nunca saem** (ledger de
  decisão; a coorte os lê desde o sorteio). O painel lê no máximo 26 semanas.
- **Ficha:** o descarte automático mostra "Receita Federal (automático)" no histórico (era "autor não identificado").
- **Card:** "Assumir" e "Abrir ficha" levam `aria-label` com o nome do lead (leitor de tela).

## M4 — a decisão sobre o placar sem tela

`radar_placar_uso()`, `radar_coorte_resultado()` e `radar_conversao_por_faixa()` (20261029150100) tinham 0
chamadas no app, e o trigger do ledger gravava ~64 mil eventos `automatica` por lote só para o placar contar.

| Objeto | Decisão | Por quê |
|---|---|---|
| `radar_placar_uso()` | **DROP** | A adoção com universo (M1) responde a mesma pergunta, na tela e com denominador. O resto dele era a contagem de eventos automáticos e uma reconciliação que passaria a acusar cada descarte automático como "contato sem evento". |
| INSERT automático em `private.radar_evento_contato` | **para** (contato e desfazer automáticos) | Nenhum leitor sobra. O contato humano segue igual (com a nota no registro). |
| `radar_coorte_resultado()` e `radar_conversao_por_faixa()` | **ficam, com tela** | São a leitura do experimento topo × amostra, que segue **aberto**: com 0 toque humano nas coortes não há o que concluir. Lidas pela aba Uso via `radar_funil_experimento()` (gate master/gestor, STABLE), à parte do funil porque custam ~0,8 s em prod. |

## Fases e o que mede o quê (regra "fase N+1 exige sinal da fase N")

- Sinal desta fase = a aba Uso com denominador. **Quando medir:** a query do piloto
  ([radar-piloto-acompanhado-roteiro.md](radar-piloto-acompanhado-roteiro.md)) — é query, não recado.
- O e-mail semanal continua desligado (decisão do founder, fora deste pacote).

## Camadas de deploy — no ar em 2026-11-09

| Camada | Quem | Estado e evidência |
|---|---|---|
| Merge | auto-merge | ✅ #3759, squash `e28b6f275` (10:46Z). |
| Publish | founder | ✅ `monitor-deploy --pr 3759`: o ar serve `e28b6f27`. `verify-frontend` com sentinela exclusiva ("Usaram em outro dia": 0 em `e4dcdd5a4`, 1 em `e28b6f275`) em `RadarFunil-C7kclVaM.js`, controle negativo ok. |
| Migration `20261111134500` | founder (`db:aplicar`, tentativa #1043) | ✅ psql-ro: os 6 `md5(prosrc)` = os do arquivo (funil `fb09ceea…`); `radar_placar_uso` ausente; anon e PUBLIC fora das 5 funções, `authenticated` fora do expurgo; `radar_card_exibicoes` com RLS e fechada ao JWT; `radar_eventos_evento_check` e `radar_eventos_intencao_forma` validados; sensores `card_exibido` (10) e `intencao` (11); cron `radar-expurgo-medicao-diario` ativo como `postgres`. Re-rodar o `db:aplicar` dá `exit 3` "já aplicado" (benigno). |
| Edge | — | não há. |

A sessão não aplicou a migration: ela tem `DROP FUNCTION` e expurgo por cron, escrita destrutiva que
`docs/agent/database.md` §1 deixa com o founder. Isso vale mesmo quando outra sessão pede para a sessão aplicar.

Estado no apply (psql-ro): 0 exibição, 0 intenção, 64.299 automáticos ainda no ledger (o cron os tira em ~4 dias).
**Zero aqui é falta de uso, não de sensor:** o 1º sinal é o 1º toque de vendedor, na aba Uso. Quando medir: as
queries de [radar-piloto-acompanhado-roteiro.md](radar-piloto-acompanhado-roteiro.md).

## Pendências que ficam fora deste pacote

- **Uso da agenda do pacote L na adoção.** O pacote L (#3762, aberto em 2026-11-09) cria `radar_agenda_uso`. Quando
  ela estiver no ar, o CTE `acao` do `radar_funil` pode contá-la como ação humana: recriar com a PRE no md5
  `fb09ceea1ad40a78dc471b3a5e4ec95d`.
- **Piloto acompanhado:** decisão do founder.

## Provas

- `db/test-radar-medicao.sh`: 48 asserts verdes em `LC_ALL=C`/UTC e `pt_BR.UTF-8`/America/Sao_Paulo;
  `--falsificar` 10/10 vermelhas no assert certo nos dois locales. A 1ª falsificação pegou um assert fraco:
  tirar o retorno antecipado do contato automático o fazia cair no ramo **humano**, e o A5a só olhava
  `origem = 'automatica'` — agora olha qualquer evento do UUID de sistema.
- O fixture extrai os corpos do ledger das migrations (a ÚLTIMA definição vence: o placar vivo é o da
  20261106132259, não o da 20261029150100) e confere o md5 contra a PROD (A9).
- `db/test-radar-funil.sh` (pacote H) segue verde: a M recria o `radar_funil` por cima, sem tocar a prova dele.
