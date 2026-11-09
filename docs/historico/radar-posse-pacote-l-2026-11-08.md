# Radar, pacote L — o vendedor ter motivo para voltar sem o e-mail (2026-11-08/09)

3ª revisão do Radar (Codex + Fable) → 5 pacotes paralelos J/K/L/M/N. Este é o da **adoção pelo vendedor**. Ponto de
partida medido em prod (psql-ro, 2026-11-08): `radar_atendimentos` com **0 linhas**, 3 "em conversa" e 2 "não atendeu"
em 64 mil contatos — ninguém usava o botão "Assumir", e retornos/posses só apareciam no /meu-dia e no e-mail (desligado).

## O que mudou

| Item | Onde | O quê |
|---|---|---|
| 1 contato dá a posse | `registrar_contato_radar` (migration `20261111134000`) | "em conversa"/"não atendeu" chamam `radar_definir_atendimento('assumir')` depois de gravar: livre → assume, do próprio → renova, de outro → recusa sem mexer, já-cliente/teto 100 → recusa. Resposta ganha `posse` (aditiva). Desfazer o contato que criou a posse a fecha (`radar_atendimentos.contato_origem_id`). |
| 2 posse não vence para trás | `private.radar_atendimento_expira_em` | Uma reconstrução cronológica: cada contato do **dono** estende a cadeia (+7 d) e define o compromisso vigente (retorno+3 d do "em conversa"). Contato de outro usuário não mexe. O caso do Codex (assume 1/11, conversa 2/11 retorno 30/11, conversa 20/11) agora vence em 30/11, não "em 9/11". |
| 3 agenda "Hoje" no /radar | `RadarAgendaHoje.tsx` + `lib/radar/agenda-hoje.ts` | Retornos de hoje/atrasados e posses vencendo em 48 h acima da fila, pela MESMA RPC e chave de cache do card (`radar_prospectar_hoje`). Vazia some; leitura que falha diz. |
| 4 telefone do cadastro | `RadarAcoesLead.tsx`, `lib/radar/telefone-cadastro.ts`, `montarPayloadCriarCliente` | A confirmação mostra os números, marca o da contabilidade e deixa trocar (ou não enviar). A sugestão nunca é o da contabilidade. O lote (gestor) segue no 1º número — ver pendências. |
| 5 "mesma empresa" eterna | `RadarClientes.tsx` | O CNPJ aberto por link fora das páginas vira uma "página" própria da consulta de irmãos e vínculos. |
| 6 "hoje" em BRT | `lib/radar/useHojeBRT.ts` | O dia do servidor (America/Sao_Paulo), relido na meia-noite BRT e quando a aba volta. |
| sensor (regra de fase) | `radar_agenda_uso` + `radar_registrar_agenda_uso` | `vista` 1×/vendedor/dia com o denominador (retornos, posses); `aberta` 1×/CNPJ/dia. Medição: `db/medir-radar-agenda.sql` (também separa posse pelo contato × pelo botão). |

## Revisão

- **Codex não consultado:** `codex-async.sh` saiu **79** (guard de cota, 90% da janela, reabre 11/11 07:47). `sem-codex:
  guard de cota 79`. Posse não é money-path; segui o **Caminho B**: régua escrita (cabeçalho da migration) + revisor
  independente (subagente lendo o código, sem a minha conclusão). **Codex retroativo pendente** quando a janela reabrir.
- **Revisor independente:** nenhum P1/P2. P3 corrigidos: (a) advisory do CNPJ antes do relógio no registro (corrida
  com o "Assumir" de um colega entre o INSERT e o COMMIT); (b) desfazer não fecha posse renovada no botão; (f) teto nos
  números do sensor. P3 aceitos e escritos: (c) desfazer pode recuar o vencimento em até 5 min (janela do desfazer);
  (d) o compromisso inicial é o último contato do dono até o início, sem limite de idade — só estende, nunca toma;
  (e) "descartado" do dono ainda conta como toque (+7 d), comportamento anterior ao L.

## Prova

`db/test-radar-posse-l.sh` (PG17, sobre os corpos VIVOS da PROD de 2026-11-08: `db/fixtures/radar-l-predecessora-prod-20261108.sql`
+ a cadeia do pacote G): 32 asserts, `--falsificar` com 15 sabotagens vermelhas no assert certo, verde em `C` e em
`pt_BR.UTF-8`. No núcleo do CI (`db/nucleo-ci.txt`, falsificar fora do CI). A migration entra em `CV_FORA`
(`db/lib/corpo-vivo.sh`) pelo mesmo motivo do G.

## Lições

- **Contato de outro usuário não pode mexer na posse do dono** quando o registro passa a assumir sozinho: no G, a
  conversa de um colega trocava o contato dono do status e derrubava a proteção; com o auto-assumir, o próprio colega
  tomaria o lead no mesmo clique. Toda regra que "lê o status atual" vira ataque quando um escritor novo age sobre ela.
- **Uma camada de defesa nova pode deixar a sabotagem da camada antiga VERDE** (o `renovado_em IS NULL` segurou o caso
  que o `NOT EXISTS` provava). O `--falsificar` acusou; o conserto foi dar a cada camada o seu caso, não remover uma.
- **O hook `migration-collision-guard` dá 🔴 falso** quando o checkout principal está em HEAD destacada antiga (aqui:
  20/10, sem as migrations de novembro): os predecessores mergeados aparecem "EM VOO".

## Camadas de deploy (merge ≠ produção)

1. **Migration `20261111134000_radar_posse_pacote_l.sql`** — manual (founder, SQL Editor entre `BEGIN;`/`COMMIT;`, ou
   `bun run db:aplicar`). Sem ela, o app novo segue funcionando: `posse` ausente = sem frase no toast; o sensor da agenda
   falha calado (track + console) até a RPC existir.
2. **Publish** no Lovable (front). Nenhuma edge.
3. Conferência pós-apply por psql-ro: md5 dos 3 corpos = os `este` da PRE, `contato_origem_id` presente, ACL.

## Quando medir

`~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -v desde="'<dia do Publish>'" -f db/medir-radar-agenda.sql` — uma semana
depois do Publish + migration. Sinal positivo com denominador: dias com agenda vista × dias com abertura, e posses
`pelo_contato` > 0.

## Pendências

- Cadastro em LOTE (gestor) ainda manda `telefone1 || telefone2`: não tem a leitura da contabilidade por linha.
- Codex retroativo sobre o desenho da posse (janela reabre 11/11).
