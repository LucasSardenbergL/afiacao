# Radar, pacote G: acompanhamento depois da ligação (2026-11-08)

Migration `supabase/migrations/20261111100000_radar_acompanhamento_pacote_g.sql` (manual, o Lovable não aplica).
Prova PG17 `db/test-radar-acompanhamento-g.sh`: 35 asserts, `--falsificar` com 18 sabotagens vermelhas e controle verde,
locales C e pt_BR. Roda sobre a cadeia do pacote E e sobre as definições VIVAS da PROD
(`db/fixtures/radar-g-predecessora-prod-20261108.sql`, saída de `pg_get_functiondef` sem edição; o G0 confere o md5).
Medição: `db/medir-radar-acompanhamento.sql` (só tabelas, roda no psql-ro).

## O que mudou

| # | Antes | Depois |
|---|---|---|
| G1 | "em conversa" tirava o lead do card e do e-mail para sempre (status ≠ `a_contatar`) | a ficha pede a data de retorno (chips Hoje · Amanhã · 3 dias · **1 semana** (marcada) · 2 semanas, ou um dia qualquer até 60). No dia, o lead volta como **retorno**. App antigo, que não manda data, fica com hoje+7 em dia útil (`retorno_origem = 'padrao'`) |
| G2 | o próprio CNPJ de "não atendeu" nunca voltava. O que "reaparecia no dia seguinte" era a **mesma empresa por outra filial**: o "1 por raiz" escolhia outra filial `a_contatar` | "não atendeu" volta ao mesmo vendedor depois de 3 dias (1ª tentativa), 7 dias (2ª) ou 30 dias (3ª em diante). Prazo em dias corridos; se cair no fim de semana, vai para segunda. A contagem segue a cadeia do status e é decidida no registro. Enquanto há acompanhamento com responsável, nenhuma filial da raiz entra como lead novo |
| G3 | a posse vencia em 7 dias sem atividade e ninguém sabia. Nada gravava o vencimento | ① o compromisso vigente protege a posse até retorno+3 dias (meia-noite BRT). A proteção vem do contato dono do status, então renovar a posse não a apaga e outro desfecho a retira. ② O card mostra os atendimentos que vencem em 48 h e os que venceram em 7 dias, mesmo sem lead novo e sem território. ③ O e-mail semanal ganha o bloco "Seu acompanhamento" (retornos até domingo, posses que vencem em 8 dias, posses vencidas desde o último e-mail) e **sai só com ele** (`n_leads = 0`). ④ Um tick diário (06:00 BRT, `radar-posses-vencer-diario`) fecha a posse vencida como `expirado` no instante do vencimento: é o registro imutável |
| G4 | na dedupe de 2 min a RPC não gravava a nota, e a ficha avançava de lead. Na troca de CNPJ, um efeito zerava o campo e o texto sumia. "Próximo" com nota digitada também apagava | A dedupe só vale para o **mesmo conteúdo**: nota ou data diferente vira registro novo (as duas notas ficam). A resposta diz `nota_gravada`. A ficha guarda um rascunho por usuário + CNPJ (sessionStorage com Map de reserva) e só apaga **o texto enviado**, depois que o servidor confirmou. Com nota não gravada, a ficha não avança |

**Retornos são uma fila à parte** (`private.radar_retornos_do_vendedor`). Não disputam o top 3/top 5 de leads novos e não
passam pelo "1 por raiz": cada compromisso é um CNPJ. O card mostra 3 e "Ver todos (N)" (até 20); o e-mail lista todos
até domingo. Os links do bloco abrem a ficha direto (`/radar?cnpj=`). Não são lead empurrado e não entram no funil H.

**Responsável** pelo retorno: o dono da posse ativa (com acesso). Sem posse, o autor do contato, se ainda tiver acesso.
Sem nenhum dos dois (acompanhamento órfão), o CNPJ volta à distribuição do território quando o retorno vence. O retorno
do ex-vendedor não fica parado para sempre.

**Legado** (contato anterior ao G, sem `retorno_em`): vale a regra padrão a partir do dia do contato (em conversa +7,
não atendeu +3). Os 3 casos que existem em prod (de junho, do master) entram como retornos atrasados dele.

## Prazos: o critério

- **Não atendeu 3/7/30**: ligar de novo no dia seguinte repete o mesmo horário ruim e queima o lead. 3 dias muda o dia
  da semana e o momento. A 2ª falha indica que o número pode não ser o certo, daí 7 dias. Na 3ª o lead para de ocupar a
  agenda (30 dias), mas não morre. Sem uso em prod (0 contato humano em 30 dias), o número é **hipótese**. A calibração
  sai da medição (`no_prazo` × `atrasado` × `reagendado` por tentativa) depois do 1º mês com uso.
- **Em conversa 7 dias / máx. 60**: uma semana é o ciclo de retorno comercial típico. 60 dias evita "reservar" um lead
  com uma data distante. Hoje é aceito: o cliente pode ter pedido "liga hoje à tarde" (a hora fica na nota).
- **Proteção da posse até retorno+3**: a posse não vence antes do compromisso que o vendedor marcou, e os 3 dias de folga
  cobrem o retorno feito com atraso curto. Depois disso vale a regra dos 7 dias sem toque.

## 2ª opinião (Codex, desenho, 2026-11-08, reasoning high, 130 s, 39 mil tokens)

O desenho inicial era outro: retornos dentro de `radar_leads_do_vendedor` (no top N), nota **anexada** na dedupe e
aviso de posse só no e-mail. O Codex apontou 2 MÉDIO e cerca de 12 ALTO. Os que mudaram o desenho:

1. **Top N não é agenda** (ALTO): 4 retornos vencidos tomariam o card todo dia. → Fila à parte, com total e "ver todos".
2. **1 por raiz apaga compromisso** (ALTO): → retornos por CNPJ, sem dedupe de raiz.
3. **Bloqueio de raiz que acaba no dia do retorno** (ALTO): → a raiz fica fora enquanto houver responsável, esteja o
   retorno vencido ou não.
4. **Compromisso órfão** (ALTO): B assumia a posse e o retorno de A sumia para os dois. → responsável = posse > autor com
   acesso; sem ninguém, a distribuição.
5. **Proteção da posse x `renovado_em`** (ALTO): renovar mudava o início da varredura e o contato com retorno saía da
   conta. → a proteção vem do contato dono do status, fora da varredura.
6. **Anexar nota não é idempotente** (ALTO): um retry de B sobre "A\nB" anexava de novo. → dedupe por conteúdo
   (repetir o mesmo conteúdo é a mesma operação; diferente é registro novo).
7. **Dedupe sobrescrevendo data** (ALTO): → data omitida preserva a gravada; data diferente é registro novo, e o
   histórico da data fica na cadeia.
8. **Limpar rascunho na hora errada** (MÉDIO): → apaga só o texto enviado, com chave usuário + CNPJ.
9. **Cruzar segunda-feira não garante aviso útil** (ALTO): → janela de 8 dias no e-mail (com cadência semanal, toda
   posse viva na segunda é avisada com pelo menos 24 h de antecedência) e card diário com 48 h.
10. **Backend devolver ≠ usuário avisado** (ALTO): → o card renderiza o aviso, e também sem lead novo e sem território
    (combinado com a sessão I, dona do card).
11. **Aviso de um prazo antigo cobrindo o novo** (ALTO): → o envio grava `atendimento_id` + `expira_em` (a versão do
    prazo). A medição só casa a mesma versão.
12. **Estado atual não é histórico** (ALTO): → o tick fecha a posse vencida (registro imutável). Não há cron que reabra.
13. **Cumprimento falso** (ALTO): → a medição separa `reagendado` (outro "em conversa" antes da data) de `no_prazo`.

Aceitos como risco, com o motivo:

- **Hoarding por "em conversa" sem posse** (Codex ALTO): o CNPJ em conversa já saía da distribuição antes do pacote G.
  O G só estende isso às filiais da raiz. Com 0 uso e 2 vendedoras ligáveis, um teto é desenho sem sinal. A medição
  expõe por vendedor; o teto entra quando houver sinal.
- **Aviso exibido no card** sem registro server-side: o ledger autenticado tem allowlist fechada no banco, e abri-la é
  mudança de outro domínio. Fica `track('radar.posse_aviso_exibido')`, que é censurável. O sinal forte é o do e-mail.
- **Vendedor sem e-mail ativo e que não abre o /meu-dia** não é avisado. A medição conta `sem_aviso_email_desligado`.

## Medir (é query, não recado)

```bash
~/.config/afiacao/psql-ro -X -At -v ON_ERROR_STOP=1 -v desde="'2026-11-11'" -f db/medir-radar-acompanhamento.sql
```

- `retornos|agendados|em_conversa|nao_atendeu|data_do_vendedor|data_padrao|no_prazo|atrasado|reagendado|pendente|vencido`
- `posses|vencidas|avisadas_24h|avisadas_menos_24h|sem_aviso_email|sem_aviso_email_desligado`

Período sem linha = **sem base** (nem 0% nem 100%). `data_padrao` alto em `em_conversa` = app velho no service worker
(o build só troca quando o vendedor clica) ou chamada sem data. A cobertura começa no 1º registro; não declarar data de
instalação.

## Deploy

Ordem recomendada: migration → Publish. As duas ordens são seguras:

- **App velho com banco novo**: a chamada de 3 args cai no DEFAULT do 4º e os campos novos do card são ignorados. Na
  dedupe de "mesmo conteúdo", a regra de antes vale.
- **App novo com banco velho**: o card não mostra acompanhamento (ausente = `null`, nunca zero). O "em conversa" manda
  `p_retorno` para a função de 3 args e toma PGRST202. O cliente repete **sem a data**, então o contato é gravado sem
  retorno e o toast não promete data (`src/queries/useRegistrarContatoRadar.ts`).

**Estado em 2026-11-08:** o `db:aplicar --ensaio` rodou inteiro na PROD e fez ROLLBACK (sha256 `52cdb8c2…`), com
pré-voo 🟢 (os 5 corpos vivos = predecessores). A aplicação real foi **negada pelo classificador do modo automático**
da sessão e ficou com o founder (comando no PR).
