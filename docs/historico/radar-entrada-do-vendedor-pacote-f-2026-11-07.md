# Radar pacote F: a entrada do vendedor (login, fila própria, card), 2026-11-07

> Pacote F da revisão Codex + Fable de 07/11 (furos na ENTRADA do vendedor). Fato de produto que motivou a revisão:
> **0 contatos humanos de vendedores em 60 dias**, e a farmer mais ativa não abre o app. Roda em paralelo com o
> pacote E (SQL de distribuição, dono de `private.radar_leads_do_vendedor`/`radar_territorio_do_vendedor` e da edge do
> e-mail) e o H (sensores e painel do funil, dono de `useRadarRegistroEmpurrado`/`RadarAbrirEmail`).
> Camadas: migration `20261107220500_radar_meu_territorio.sql` (**manual**) · front (**Publish**). Sem edge.

## O que estava errado e o que mudou

| # | Furo (confirmado no código) | Correção |
| --- | --- | --- |
| 1 | **Login perdia o destino no app inteiro.** `ProtectedRoute` gravava só `state.from`; `/auth` só lia `?next=`. Quem abria o link do e-mail sem sessão logava e caía na home. | `ProtectedRoute` manda `/auth?next=<destino>` **e** `state.from`; `/auth` honra os dois (`?next=` vence). Regra única em `src/lib/destino-pos-login.ts`: só caminho interno (recusa `//host`, `/\host`, URL absoluta, controle, laço em `/auth`). O consent OAuth do MCP (que já usava `?next=`) segue igual. |
| 2 | **"Sua fila de hoje" não era do vendedor**: score + "MG e vizinhos" para todos. | RPC fina `public.radar_meu_territorio` (embrulha a privada do pacote D sem tocar nela; gate `cap_radar_prospectar`, outro vendedor só para gestor). No `/radar`, chips **"Perto dos seus clientes"**: com território, a fila abre na cidade nº 1 (código exato + UF); "Toda a região" volta ao default e fica (`perto=nao`). Staff sem território e leitura que falhou mantêm o default; a falha é DITA no resumo. A fila **espera** o território (não busca a fila errada para jogar fora). |
| 3 | Card "Prospectar hoje" depois de Assumir: só a posse era relida; o card seguia com "Assumir" e o 2º clique virava "Atendimento renovado". | Assumir/liberar/atribuir invalidam também `['radar','prospectar-hoje']`. A linha vira **"com você"** (link para `/radar?visao=meus`) pelo estado local, pela posse viva (`radar_atendimentos_ativos.eh_meu`) ou por `com_voce` da RPC. Contrato do E: a posse própria SAI do card no refetch (os dois casos tratados). |
| 4 | Cabeçalho "Sua fila de hoje" e "Começar pelo 1º lead" fixos na visão "Meus atendimentos". | "Seus atendimentos" · "Abrir o 1º atendimento". |
| 5 | Deep link lia a ficha só depois da 1ª página da fila. | Leitura do lead pelo CNPJ em PARALELO; se a fila chegar antes e o tiver, ela vence. |
| 6 | "Próximo" na ficha aberta fora da fila caía em `fila.length` → "fim da fila" com a fila inteira por fazer; e a posição de OUTRO lead valia para ela. | `proximoDaFila`: aberto que nunca esteve na fila → o 1º da fila. A posição guardada é presa ao CNPJ. |
| 7 | `RadarAtendimentoLead`: com a leitura da posse em erro, Assumir aparecia LIGADO sobre estado desconhecido. | Desligado com o motivo no `title` + "Tentar de novo". |
| 8 | O card só estava no `/farmer` — e a home das vendedoras é o `/meu-dia` (`CommercialDashboard`): nem a farmer o via na home; hunter/closer recebem o e-mail e não tinham card. | Card montado no `FarmerDashboardV2`, `HunterDashboard` e `CloserDashboard` (o gate do Radar continua dentro do card). |
| 9 | O sensor do card marcava "servido" antes da confirmação. | O card aceita o contrato novo do H (`Promise<boolean>` ou `{ ok }`) e o void de hoje: só marca com confirmação; falha libera nova tentativa na próxima leitura. Não há ordem de merge entre F e H. |

Copy do pacote E também é do F: motivo do território vazio (`territorio_motivo`: `nao_e_vendedor` · `sem_carteira` ·
`carteira_sem_municipio`), selo **"passado pelo gestor"** (`atribuido`) e a nota de território `compartilhado`. O leitor
aceita os campos ausentes (RPC anterior ao E).

## Decisão: uma cidade por vez, não as três juntas

A fila, o ranking e o mapa filtram pelo MESMO `p_municipio_codigo` exato. Juntar as 3 cidades do território exigiria
mudar `radar_lista` e as RPCs de contagem/mapa juntas — senão a contagem e a fila discordariam (a lição do "corte por
ranking: corrija por união com a fonte que conhece a decisão" vale para o RECORTE, e aqui a união seria em 3 RPCs). Os
chips dão as 3 a 1 clique. Se o sinal de uso pedir a união, ela é o próximo passo (com as 3 RPCs no mesmo PR).

## Provas

- **PG17** `db/test-radar-meu-territorio.sh` (no núcleo do CI): 15 asserts — RPC fina devolve exatamente a privada,
  gates com SQLSTATE e a marca do ramo (`42501` + `forbidden: radar_prospectar` / `exige gestor`), anon fora pelo ACL,
  p_top na privada, idempotente. `--falsificar`: controle verde + 5 sabotagens vermelhas no assert certo (inclui a PÓS
  abortando o apply com ACL aberto, e a mesma sabotagem com a PÓS cega pega pelo A6).
- **vitest**: login integrado começando SEM sessão (`login-honra-destino.test.tsx`, cada camada — `?next=` do
  ProtectedRoute e `state.from` do /auth — sabotada sozinha fica vermelha no seu caso; as duas juntas derrubam o caso
  do link do e-mail); território/fila puros; página (`RadarClientes.test.tsx`: cidade nº 1, chips, "Toda a região",
  espera do território, falha dita, deep link paralelo, Próximo fora da fila, copy da visão); card (com você, posse
  viva, selo, sensor com e sem confirmação, motivos); Assumir em erro. Cada correção do front falsificada uma a uma.

## Deploy

1. Migration `20261107220500_radar_meu_territorio.sql` — aplicada pela sessão no envelope (`db:aplicar`, PÓS com
   marcador positivo) e conferida por `psql-ro` (ver o PR).
2. **Publish** no Lovable (front). Sem ele, o login segue perdendo o destino e o card segue fora do `/meu-dia`.

## Sinal da fase (quando medir)

Denominador: vendedores com território que abriram o `/radar` (`radar.territorio_escolhido` + page view) e logins vindos
do link do e-mail (`radar_lead_aberturas` com origem e-mail seguidas de sessão). A métrica que importa continua sendo
contato humano registrado (`radar_contatos.criado_por` vendedor) — hoje 0 em 60 dias.
