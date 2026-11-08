# Radar, pacote E: a distribuição do e-mail semanal e do card "Prospectar hoje" (2026-11-07)

Migration `supabase/migrations/20261107230000_radar_distribuicao_pacote_e.sql` (manual, Lovable não aplica).
Prova PG17 `db/test-radar-distribuicao-e.sh` (35 asserts, `--falsificar` com 33 sabotagens, nos locales C e pt_BR;
no núcleo do CI sem a falsificação).
Origem: revisão Codex + Fable de 07/11 sobre o pacote D (#3678, #3700).

## O que estava errado e o que mudou

O e-mail semanal e o card chamam a MESMA função de escolha, `private.radar_leads_do_vendedor`. A assinatura dela mudou
para `(p_vendedor, p_n, p_agora)`: a janela de 90 dias passou a viver dentro da função, e os dois canais não podem
mais divergir. Antes, o card passava `NULL` e mostrava o mesmo top-3 para sempre.

| # | Antes | Depois |
|---|---|---|
| E1 | lead fora da foto da Receita ou sem contato podia ir no e-mail que promete "ficha com telefone" | só `ultimo_lote` = maior lote `complete` (sem lote completo não recorta, igual à fila); exige telefone1, telefone2 ou email |
| E2 | "não repetir 90 dias" contava o REGISTRO do envio: e-mail que falhou queimava os 5 leads e consumia a semana | conta só e-mail ENTREGUE (`fornecedor_alerta.status = 'notificado'`) numa semana anterior; o que falhou libera a tentativa 2 (`tentativa`, UNIQUE (vendedor, semana, eh_teste, tentativa)) |
| E3 | o lead que o próprio vendedor assumiu continuava sugerido | sai (está em "Meus atendimentos") |
| E4 | o lead atribuído pelo gestor (#3684) só aparecia se caísse no território | entra primeiro, mesmo fora do território, com `atribuido = true` (e-mail, card e `radar_email_vendedor_leads.atribuido`) |
| E5 | um erro abortava todos os vendedores e o ledger nem era escrito | subtransação por vendedor; o erro vai para `erros` no ledger, que sai com status `erro`. Duas execuções simultâneas se serializam por `pg_advisory_xact_lock` |
| E6 | quem era 2º em todas as suas cidades recebia `sem_territorio`, e a tela dizia "Sem carteira com endereço" | fallback: até 3 municípios onde a pessoa tem clientes, marcados `compartilhado`. O DONO tem prioridade: no município compartilhado, o lead já mandado a OUTRO vendedor (na fila ou entregue) fica fora para o fallback, mas o dono nunca perde lead para o fallback. Os donos são processados antes. O território vazio ganha motivo: `nao_e_vendedor`, `sem_carteira` ou `carteira_sem_municipio` |
| E7 | `c_app := 'https://steu.lovable.app'` fixo | `company_config.app_url_publica` (semeada com o valor de hoje); valor fora de `https://host` não manda e-mail e grava ledger `erro` |

Por que ENTREGUE e não ABERTO: o único "aberto" que existe é o clique por lead (`radar_lead_aberturas`). Contar
aberto faria o lead ignorado voltar toda semana, o contrário de rodar a lista.

## 2ª opinião (Codex, 07/11, reasoning high)

O Codex apontou 2 achados ALTO, 2 MÉDIO e 1 BAIXO. Os cinco procediam e foram corrigidos antes do PR:
1. Duas execuções simultâneas (cron + manual) podiam mandar o mesmo lead ao dono e ao fallback: o SKIP LOCKED repartia
   os vendedores sem que uma execução enxergasse os envios da outra. Correção: advisory lock transacional, provado no
   E5c com duas sessões.
2. A exclusão entre vendedores tirava lead do DONO quando o fallback o recebia antes (por exemplo, depois de uma falha
   do dono). Correção: a exclusão só vale para lead de município compartilhado.
3. A PRE e a POST conferiam a UNIQUE pelo nome. Correção: passam a conferir pelas colunas de todo índice único.
4. A re-aplicação que falhava não reprovava a suíte. Correção: virou o assert E9a0, com sabotagem própria.
5. `radar_territorio_motivo` estava fora da TRAVA e da PRE. Correção: entrou nas duas.

## Medido em PROD antes (psql-ro, 07/11)

As 2 vendedoras ligáveis eram donas de município (39 e 44). No universo do top-3 delas, 9 de 977 e 4 de 698 leads
estavam sem nenhum contato. O universo inteiro já estava no lote vigente (2026-10). Havia 0 atendimentos no Radar e
1 envio (teste, notificado). A escolha nova sobre o território da Regina custa ≈300 ms com cache quente (a velha,
≈280 ms), devolve o mesmo top-5, e os elegíveis caem de 972 para 965 (os sem contato). Ou seja, o estrago de hoje é pequeno. E3, E4 e E6 eram latentes: mordiam no 1º vendedor
novo ou na 1ª atribuição.

## Contratos com as sessões irmãs

- **F (card):** `radar_prospectar_hoje` só ganhou campos: `leads[].atribuido`, `territorio[].compartilhado` e
  `territorio_motivo` no topo. A posse própria SAI do card; F cruza com `radar_atendimentos_ativos` para mostrar
  "com você". A copy do motivo é de F.
- **H (sensores):** o denominador continua sendo "envio não-teste com alerta `notificado`". Com a tentativa 2, uma
  semana pode ter 2 linhas, mas só a entregue conta. O ledger `radar.avisar_vendedores` ganhou `erros[]` e
  `pulados[].causa`.

## Não mudou

A edge `dispatch-notifications` não mudou: ela já grava `notificado`/`falha_notificacao`, que é o que E2 lê. Não
há deploy de edge.
