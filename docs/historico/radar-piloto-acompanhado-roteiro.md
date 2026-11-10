# Radar: roteiro do piloto acompanhado (proposta, 2026-11-09)

> **Para o founder decidir.** Nada aqui foi executado com vendedor. Recomendação da 3ª revisão do Radar (Codex):
> antes de qualquer fase nova (recorte de CNAE, e-mail semanal ligado, mais leads), medir **uso real com
> denominador** num grupo pequeno e acompanhado, com o que já existe. Depende do pacote M no ar (migration
> `20261111134500` + Publish): é ele que dá o universo de elegíveis, as exibições do card e a intenção de contato.

## Por que um piloto, e não "esperar o uso aparecer"

Em 4 meses: 5 contatos humanos (todos em 15/06), 37 aberturas de 1 só usuário, 0 atendimento. "No ar e ninguém
reclamou" é ausência de dado (`fase-sem-sinal.md`). Sem um grupo combinado, a próxima leitura do painel volta a
dizer 0 e não separa "não serve" de "ninguém tentou".

## Quem

- **2 a 3 vendedores**, com acesso ao Radar (`farmer`/`hunter`/`closer` ativos) e carteira com território no
  Radar (o card "Prospectar hoje" mostra "Perto dos seus clientes", não "Sem território"). Hoje são elegíveis o
  master e 2 farmers — o piloto pode ser exatamente esses 2 farmers.
- **1 semana útil** (segunda a sexta), com o founder (ou gestor) combinando no início e conversando no fim.
- O que se pede a cada um: abrir o card "Prospectar hoje" todo dia, abrir a ficha dos leads que fizerem sentido,
  tentar contato (ligar, WhatsApp) e **registrar o desfecho na ficha** — inclusive "não atendeu" e "descartado".

## O que medir (tudo já é gravado; nada novo a instalar)

Na tela: `/radar/funil` → aba **Uso** (adoção) e aba **Funil** (por semana, filtrando o vendedor).

Por query (psql-ro, como master; o gate da função é o mesmo da tela):

```sql
-- Adoção da semana corrente: elegível → exposto → 1ª ação → uso em outro dia, por vendedor.
SELECT set_config('request.jwt.claims',
         json_build_object('sub', (SELECT user_id FROM public.user_roles WHERE role = 'master' LIMIT 1))::text, false);
SELECT a ->> 'user_id' AS vendedor, a ->> 'elegivel' AS elegivel, a ->> 'exposto_em' AS exposto_em,
       a ->> 'primeira_acao_em' AS primeira_acao, (a ->> 'dias_com_acao')::int AS dias_com_acao, (a ->> 'acoes')::int AS acoes
  FROM jsonb_array_elements(public.radar_funil(1) -> 'adocao' -> 'vendedores') a
 ORDER BY dias_com_acao DESC;

-- Funil da semana: exibidos no card → clicados → intenção de contato → contato registrado.
SELECT l ->> 'vendedor_user_id' AS vendedor,
       (l ->> 'card_leads_exibidos')::int AS exibidos, (l ->> 'card_leads_clicados_exibidos')::int AS clicados,
       (l ->> 'intencoes')::int AS intencoes, (l ->> 'contatos')::int AS contatos
  FROM jsonb_array_elements(public.radar_funil(1) -> 'linhas') l;
```

`NULL` numa coluna = o sensor não cobria (ex.: Publish ainda não feito), **não** zero.

## Linha de base antes do piloto (psql-ro, 2026-11-09, com M e agenda no ar)

`radar_funil(4)`, de 19/10 a 09/11, com os 3 elegíveis de agora:

| Elegível | Exposto | 1ª ação | Dias com ação | Ações |
|---|---|---|---|---|
| master (founder) | 03/11 | 06/11 | 3 | 30 |
| farmer A | — | — | 0 | 0 |
| farmer B | — | — | 0 | 0 |

- Contatos registrados: 0 nas 4 semanas, para os 3.
- Exibidos, clicados e intenções aparecem como `—`. Os sensores entraram hoje (M e agenda) e ninguém foi exposto
  depois disso.
- Leitura: o único uso medido é o do founder. Os 2 farmers, que são o grupo do piloto, nunca abriram o Radar. Pelo
  critério abaixo, o "antes" é zero em todos os sinais e qualquer valor no piloto vem da semana combinada.

## Critério de sucesso (decidir ANTES de começar, para não ler o resultado com a régua do resultado)

Por vendedor do piloto, na semana:

| Sinal | Sucesso | Leitura se falhar |
|---|---|---|
| Uso em outro dia (`dias_com_acao ≥ 2`) | ≥ 2 dos 3 (ou 2 de 2) | O card não puxa o vendedor de volta: problema de lugar/rotina, não de lead. |
| Leads clicados ÷ exibidos no card | ≥ 30 % | Os leads mostrados não parecem bons à primeira vista (nota/recorte). |
| Contatos registrados (qualquer desfecho) | ≥ 5 por vendedor | Abre e não liga: falta motivo/roteiro de abordagem, ou o telefone é da contabilidade. |
| Intenções sem contato registrado | conversa no fim | Ligou e não registrou = a ficha não está no fluxo; medir isso é o ponto de existir a intenção. |

Resultado abaixo do critério **não** é "o Radar não serve": é o dado que decide entre (a) mexer no card/ficha,
(b) mexer na escolha dos leads, ou (c) parar de investir no Radar. Acima do critério: libera a fase seguinte
(ligar o e-mail semanal para o grupo, depois ampliar).

## O que NÃO entra no piloto

- Não liga o e-mail semanal (decisão separada do founder).
- Não fecha o experimento da coorte topo × amostra: ele segue aberto e só ganha dado se houver toque humano.
- Não muda nota, recorte de CNAE nem distribuição de leads durante a semana (senão o antes/depois mistura duas coisas).
