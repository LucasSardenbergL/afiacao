# Radar, pacote J: privacidade/LGPD (2026-11-09)

Pacote J da 3ª revisão do Radar (Codex + Fable), o 1º do Top 3 do Codex. Três defeitos:

1. **O CPF completo do titular de MEI saía para o app.** A razão social de MEI termina no CPF (`FULANO DE TAL
   12345678901`). Em prod, **122.077** linhas de `radar_empresas` (medido 2026-11-08). A razão crua saía na ficha, na
   lista (`radar_lista` devolve `SETOF radar_empresas`), no "prospectar hoje", na rota, nos e-mails gerados em SQL, na
   descrição da tarefa, no CSV e no PostgREST direto (`select('*')` de 3 hooks).
2. **A exclusão de sócio não resistia à recarga.** O procedimento de `radar-socios-cpf-mascarado-2026-11-07.md`
   mandava "tirar a raiz do universo", mas a carga mensal reconstrói o universo do zero.
3. **Notas livres sobre pessoas sem prazo.** `radar_contatos.nota` é legível por todo vendedor com
   `cap_radar_prospectar` e nunca expirava.

## O que entrega

Migration `20261111150000_radar_privacidade_titular_mei.sql` (manual), prova `db/test-radar-privacidade-j.sh`,
edge `omie-vendas-sync` v1.33 (guarda no `criar_cliente`) e uma mudança pequena no cadastro Omie do front.

- **A razão de MEI é gravada mascarada**, no formato do QSA da RFB: `FULANO DE TAL ***456789**` (dígitos 4 a 9). Dois
  triggers BEFORE reescrevem na entrada, para qualquer escritor (carga, publicação, escritor futuro): um no staging
  da carga (`radar_empresas_carga`) e outro na foto (`radar_empresas`). Por isso nenhuma RPC de leitura foi recriada:
  toda saída, de hoje e de amanhã, já nasce sem o CPF. A contagem da publicação não muda, porque o trigger altera o
  valor e nunca descarta linha. Mascarar já no staging mantém o "só o que difere" da publicação em passos: sem isso,
  staging cru × foto mascarada reescreveria as ~122 mil linhas de MEI todo mês. A prova P1 reproduz o UPDATE do passo.
- **O valor da Receita fica em `private.radar_razao_receita`.** Só a RPC `radar_razao_social_para_cadastro` o lê,
  com o gate do próprio cadastro (gestor/master, `pode_ver_carteira_completa`, não o vendedor) e o registro de cada
  leitura em `private.radar_razao_receita_acessos` (retenção de 12 meses). A razão fiscal do MEI tem o CPF e vai
  para o Omie. O front a busca logo antes de chamar a edge, e o caminho é fail-closed: se vier mascarada, o cadastro
  não é enviado (`escolherRazaoFiscal`). A edge também recusa o sufixo mascarado (v1.33), o que protege a aba que
  ainda está num build velho.
- **O vínculo e o aviso de crédito aceitam as duas formas.** As únicas 2 funções que usam o CPF da razão
  (`private.radar_vinculos_base` e `private.radar_mascaras_conflitam`) e os 2 índices de expressão foram recriados
  por **substituição textual mínima** do corpo de prod (md5 conferido, PRE/PÓS). O regex passou a ser
  `' ([0-9]{11}|\*\*\*[0-9]{6}\*\*)$'` e a máscara vem de `private.radar_titular_mascara`. Elas só usavam a máscara,
  nunca o CPF completo (MEI × MEI compara máscara), então as decisões são **idênticas** antes, durante e depois do
  backfill. A prova E1/E2 compara a foto inteira do vínculo, do aviso de crédito e da guarda de homônimo.
- **Exclusão persistente** em `public.radar_exclusoes_titular` (raiz, escopo, finalidade, protocolo). É registrada
  pela RPC `radar_exclusao_registrar` (master, ou o SQL Editor), e cada pedido entra no histórico `pedidos`. Vale
  **na ingestão**: os triggers do staging e da foto zeram a cada carga. E o job **reaplica** de hora em hora.

  O escopo `qsa` tira os nomes dos sócios da ficha e da prospecção. O `contato` faz isso e também registra a oposição
  à prospecção: zera e-mail e telefone, descarta o lead com `descarte_motivo = 'lgpd_oposicao'`, apaga as notas livres
  e não deixa o lead ser "reaberto". Um 2º pedido só amplia o escopo, nunca devolve dado.
- **🧭 Decisão do founder: a exclusão NÃO toca o vínculo societário nem o aviso de crédito.** O QSA mascarado em
  `radar_socios` e a máscara do titular na razão continuam, só no servidor. A revisão provou que filtrar a raiz no
  vínculo apagava o aviso de um devedor (R$ 70 vencidos), e a proteção do crédito é base legal própria (LGPD art.
  7º X), que a oposição ao legítimo interesse não alcança. Foi o padrão conservador do money-path. Para estender a
  exclusão ao vínculo (o "tirar a raiz do universo" original), basta um filtro `NOT EXISTS` em `ocorr` de
  `private.radar_vinculos_base`. A prova da 1ª versão, no histórico do PR, tinha essa forma e a sabotagem dela.
- **Retenção.** O cron `radar-privacidade-expurgo` (de hora em hora, `:41`) anula a nota livre de lead descartado há
  mais de 12 meses (data do descarte, ou a do evento quando o lead não tem). O evento fica, só o texto sai. A nota
  automática também fica: o critério é o AUTOR (o usuário de sistema `…ad0f`, que escreveu as 64.299 notas `RFB:` de
  prod), não o texto, porque um texto livre pode imitar o prefixo. O mesmo job:
  - termina o backfill da máscara em fatias de 10 mil (`FOR UPDATE SKIP LOCKED`, ~13 rodadas para 122 mil);
  - apaga o cru órfão e o registro de acesso com mais de 12 meses;
  - reaplica as exclusões.

  Cada rodada fica registrada em `acoes_execucoes` (`radar.privacidade_expurgo`), inclusive o erro: o job não aborta
  mudo.
- **Efeito na busca:** a busca por nome continua igual. Buscar pelos 11 dígitos do CPF deixa de achar o MEI, de
  propósito (era um oráculo CPF→empresa).

## Por que gravar mascarado e não mascarar cada saída

A alternativa era manter a tabela crua e mascarar nas ~12 RPCs, nos 3 hooks e nos e-mails. Foi descartada por três
motivos. Cinco sessões paralelas recriam essas RPCs, e no apply manual a última a recriar vence e perde a máscara. A
tabela continuaria legível crua pelo PostgREST. E toda RPC futura nasceria vazando. A medição decidiu: em prod, só
2 funções e 2 índices dependem do CPF da razão (`pg_proc` + grep), e ambos usam só a máscara.

## Ritual e evidência

- **Codex não consultado (`sem-codex: cota`).** `scripts/codex-async.sh` saiu 79: guard local, cota em 90% contra
  teto de 85%, janela reabrindo em 11/11. Fui pelo Caminho B: régua escrita (acima), falsificação e revisão
  adversarial independente (subagente, sem as minhas conclusões). Gastar a reserva é decisão do founder.
- **A revisão adversarial achou e o PR corrigiu:**
  - P1: aba em build velho cadastraria MEI no Omie com a razão mascarada → guarda na edge v1.33.
  - P2: a publicação em passos reescreveria as 122 mil linhas de MEI todo mês, porque comparava staging cru com foto
    mascarada → trigger também no staging, provado no formato real do passo.
  - P2: o vendedor lia o CPF completo de qualquer MEI pela RPC do cadastro → gate gestor/master e registro de acesso.
  - P2: a exclusão derrubava o aviso de crédito → decisão conservadora acima.
  - P3: o lead em oposição podia ser reaberto, o critério da nota automática era pelo texto, o job abortava sem
    registro e a pedida nova sobrescrevia a trilha → todos corrigidos e cobertos.
- **Prova PG17** com as migrations reais da cadeia do vínculo (`20261104201756` → `20261106083754` →
  `20261106205557` → `20261107040000`), o lote de sócios carregado pelas RPCs da carga e esta migration aplicada 2×.
  Fechou com 30 asserts. Rodei `--falsificar` em `LC_ALL=C` e em `pt_BR.UTF-8`: controle verde e 14/14 sabotagens
  vermelhas no assert certo. Na 1ª versão, a sabotagem mostrou que um filtro de exclusão no `lead_cpf` era camada
  redundante; depois a decisão do crédito tirou do vínculo todo filtro de exclusão.
- **Custo do trigger** (PG17 local, upsert de 500 mil linhas com 20% de MEI): 2,4 s sem trigger, 5,5 a 6,1 s com,
  cerca de 6 µs por linha. No caminho real, o staging recebe em chunks de 1.000 (cerca de +6 ms por chunk) e o passo
  da publicação só reescreve o que difere.
- **Varredura de vazamento histórico em prod:** 0 tarefas, 0 alertas (`mensagem` e `metadata`) com CPF, staging
  vazio. Só `radar_empresas` tinha o CPF, e o backfill cobre.

## Ordem de deploy

1. **Edge `omie-vendas-sync` v1.33.** Recusa a razão mascarada no `criar_cliente` e protege a aba que ainda está num
   build velho. Não tem pré-condição de banco.
2. **Publish** do front: o cadastro Omie passa a buscar a razão fiscal pela RPC. Sem a migration (PGRST202), usa a
   exibida, que ainda é a crua.
3. **Migration**, fora do horário comercial: os `CREATE INDEX` seguram as escritas em `radar_empresas` por alguns
   segundos. Use `bun run db:aplicar …` ou o SQL Editor. O backfill corre sozinho pelo cron. Para acelerar, rode
   `SELECT public.radar_privacidade_expurgo();` algumas vezes, até `razoes_cruas_restantes = 0`.

A carga (`scripts/radar/carga.ts`) não muda.

## LGPD: registro e prazos (formato `lgpd-data-mapping`)

| Dado | Finalidade | Base legal | Quem vê | Prazo |
|---|---|---|---|---|
| Razão de MEI (nome + CPF **mascarado**) em `radar_empresas` | Identificar a empresa e o vínculo societário | Legítimo interesse (art. 7º IX). Dado público por lei (dados abertos de CNPJ, art. 7º §§3º-4º) | Vendedor com `cap_radar_prospectar` | Lote vigente; a carga mensal substitui |
| Razão **fiscal** (com o CPF completo) em `private.radar_razao_receita` | Só o cadastro do cliente no Omie (a razão fiscal do MEI tem o CPF) | Execução de contrato / procedimentos preliminares (art. 7º V) e obrigação fiscal (art. 7º II) | Ninguém pelo JWT; só a RPC do cadastro (gestor/master), 1 CNPJ por vez, com registro de cada leitura (12 meses) | Enquanto a empresa estiver no Radar (cascata) |
| `socios_nomes` (QSA) na ficha | Saber quem decide pela empresa | Legítimo interesse; dado público RFB | Vendedor com a cap | Lote vigente |
| E-mail e telefone do estabelecimento (de PF, no MEI) | Contato comercial B2B | Legítimo interesse; dado público RFB | Vendedor com a cap | Lote vigente; oposição → escopo `contato` |
| `radar_contatos.nota` (texto livre do vendedor) | Continuidade do atendimento entre vendedores (o lead é da fila, não de um vendedor) | Legítimo interesse | Vendedor com a cap (por desenho: a fila é compartilhada) | Lead ativo: enquanto em prospecção. **Lead descartado: 12 meses após o descarte**, depois o texto vira NULL |
| `radar_exclusoes_titular` | Provar e manter o atendimento ao direito do titular (art. 18, §2º e VI; art. 6º X) | Obrigação legal / exercício regular de direito (art. 7º II e VI) | Só servidor/master | Enquanto o Radar tratar dados de CNPJ |

- **Orientação ao vendedor** (minimização na fonte): escreva na nota sobre o negócio (interesse, horário, objeção),
  não sobre a vida da pessoa.
- **Por que 12 meses:** cobre um ciclo comercial anual (não re-abordar quem já recusou, com o porquê). Depois disso, o
  texto sobre a pessoa não serve mais à finalidade. Prazo do founder, revisável no parâmetro `p_meses` do job
  (mínimo 6).

### Pedido de oposição ou eliminação (o procedimento novo)

Substitui o "tirar a raiz do universo" de `radar-socios-cpf-mascarado-2026-11-07.md`:

```sql
SELECT public.radar_exclusao_registrar('<raiz 8 dígitos>', 'qsa' /* ou 'contato' */,
                                       '<finalidade: pedido do titular, data, canal>', '<protocolo>');
```

O efeito é imediato e se mantém nas cargas seguintes. Para conferir:
`SELECT raiz, escopo, pedidos FROM public.radar_exclusoes_titular;` e
`SELECT socios_nomes, email, prospeccao_status FROM public.radar_empresas WHERE left(cnpj, 8) = '<raiz>';`. Esperado:
`socios_nomes` NULL e, no escopo `contato`, e-mail e telefone NULL e o lead descartado. O vínculo e o aviso de
crédito seguem (decisão acima).

## Fora deste pacote (follow-up)

- **Clientes MEI fora do Radar:** `profiles.razao_social` e a base Omie também guardam a razão de MEI com o CPF.
  O vínculo já tira o CPF do nome de saída, mas outras telas de cliente podem exibir. Isso é de outro domínio e fica
  para uma varredura própria.
- **REVOKE de coluna no PostgREST:** não é necessário, porque a tabela não guarda mais o CPF.
- **Cópias fora do banco vivo:** os CSVs já exportados pelos vendedores e os backups/PITR do Supabase (rotação pela
  retenção do plano) ainda têm a razão crua de antes da migration. Esses dados não são apagáveis daqui. Registre no
  inventário do Encarregado.
