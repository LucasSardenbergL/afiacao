# Radar sucessor, passo 3: "mesmo sócio" pelo CPF mascarado (construção, 2026-11-07)

A medição está em [radar-socios-cpf-mascarado-medicao-2026-11-06.md](radar-socios-cpf-mascarado-medicao-2026-11-06.md).
Os passos 1 e 2 estão em `radar-abriu-ficha-com-cnpj-2026-11-06.md` e `credito-aviso-vinculo-vencido-2026-11-06.md`.
Decisão do founder: **"Construir agora"**, com a regra medida.

## O que entrega

A ficha, a lista e o aviso de crédito passam a dizer **"mesmo sócio (CPF parcial igual)"**. O sinal é `socio_cpf` e
conta como pista forte. Ele aparece quando o nome normalizado **e** o CPF mascarado da Receita (`***dddddd**`) batem
entre o sujeito e um cliente, sem exigir município e **também com clientes fora do recorte do Radar**, que são 80% das
raízes de cliente. A regra só vale nas condições medidas:

- a chave aparece em ≤2 raízes do universo (Radar ∪ clientes);
- a chave aparece em **≤3 empresas no QSA do país inteiro**;
- **todas** as qualificações da pessoa nas 2 raízes são de dono (`05/22/49/65`). O titular de MEI conta como dono.

A máscara do titular de MEI sai do CPF na razão social (dígitos 4 a 9). Pela medição, isso dá +50 leads com pista
forte e +2 pares de crédito.

- **Guarda na regra antiga por nome:** quando os 2 lados têm máscara para o nome e nenhuma bate, é homônimo, e o
  nome não casa mais. MEI × MEI com CPFs diferentes também não casa.
- **Correção de vazamento (Codex P1):** o nome do cliente vindo do **perfil** de um MEI saía com o CPF completo. Agora
  sai sem ele, como já saía o nome vindo do Radar.

## Peças

- **Migration `20261107040000_radar_socios_cpf_mascarado.sql`**, no molde TRAVA → PRE → CREATE → PÓS:
  - `radar_socios_lote` guarda o manifesto imutável: digest, versão da carga e contagens declaradas.
  - `radar_socios` guarda só PF com máscara válida.
  - As RPCs `radar_socios_iniciar/receber/publicar/limpar` são só de `service_role` e serializadas por advisory lock.
  - A publicação reconcilia as contagens e troca o ponteiro `vigente` em 2 UPDATEs ordenados. A limpeza apaga em
    fatias.
  - `private.radar_vinculos_base` continua sendo a cópia única das regras. Partiu do corpo de prod `91dc715b…`.
  - `credito_vinculo_avaliar` passa a `regra_versao` 2.
  - Não foram recriados (a PÓS confere o md5): núcleo, `radar_possiveis_vinculos`, `radar_vinculos_por_cnpjs`,
    `credito_vinculo_aviso` e o sensor.
- **Carga (`scripts/radar/carga.ts` + `scripts/radar/socios.ts`):** do QSA que já é baixado, a carga tira o universo
  (raízes do recorte ∪ dos CNPJs conhecidos) e o `n_raizes_pais` contado no país. A publicação roda **depois** do
  `finalize` e, como a de concorrentes, uma falha só deixa a carga com `exitCode 6`. A normalização do nome usa o
  MESMO mapa de `private.radar_nome_norm`, e o `socios.test.ts` lê a migration para conferir.
- **Edge `radar-ingest` v1.6-socios-rpc-literal** (a v1.5 do #3689 nunca subiu, ver abaixo)**:** ações `socios_iniciar`, `chunk_socios` (até 5 mil linhas),
  `publicar_socios` e `limpar_socios`. A fronteira de erro é própria: só sai código `RSOC_*`, nunca a linha nem o
  `details` do PostgREST, e a fila não é marcada `error`.
- **Front:** `socio_cpf` entrou nos parsers estritos `src/lib/radar/vinculos.ts` e `src/lib/credito-vinculo/aviso.ts`.

## Ordem de deploy (o parser estrito rejeita sinal desconhecido)

1. **Publish** do front e conferência no bundle. Abas abertas no build velho, ao receber `socio_cpf`, mostram "não
   consegui verificar", e o erro é fechado (fail-closed, nunca "sem vínculo"). Hoje há 1 titular ativo.
2. **Migration** (`db:aplicar`). Sem lote vigente a regra nova não contribui, e a saída é a de antes (prova E1/E3).
3. **Deploy da edge** `radar-ingest` (v1.6). Os sócios só entram na **próxima carga mensal**. Até lá, o selo segue
   como antes.

## LGPD: registro da atividade (formato `lgpd-data-mapping`)

| Campo | Valor |
|---|---|
| Slug | `radar-socios-cpf-mascarado` |
| Finalidade | Identificar **vínculo societário** (mesma pessoa provável) entre um CNPJ (lead ou cliente do pedido) e um cliente nosso, para (a) não prospectar como "novo" quem já é cliente e (b) **avisar** o crédito quando o vinculado tem título vencido. **Nunca** inferir parentesco nem afirmar sucessão ou dívida transferida: é PISTA, que o vendedor confere. |
| Base legal | Legítimo interesse (Art. 7º, IX) para a prospecção B2B, e proteção do crédito (Art. 7º, X) para o aviso. Os dados são **públicos por força de lei** (QSA da RFB, dados abertos de CNPJ; Art. 7º §§3º-4º): a finalidade é compatível com a publicação, que é dar transparência a quem responde pela empresa. O balanceamento cabe ao Encarregado (guia ANPD de legítimo interesse). |
| Titulares | Sócios e administradores PF de empresas do recorte e de clientes. Adultos, sem menores esperados (sócio menor é exceção legal e não é tratado à parte). |
| Sensíveis? | Não. |
| Dados | Nome normalizado, CPF **mascarado** (6 dos 11 dígitos, como a RFB publica), qualificação, data de entrada e nº de empresas no país com a mesma chave. **Minimização:** só PF com máscara válida; fora ficam representante legal, faixa etária, país, PJ e estrangeiro. O CPF completo **não** é guardado: o do titular de MEI é lido da razão social na hora e vira máscara. |
| Fonte | Terceiro público: dump mensal de CNPJ da RFB (`Socios*.zip`). |
| Sistemas | `public.radar_socios` e `public.radar_socios_lote` (Supabase/Postgres). O arquivo de trabalho da carga mensal (runner do GitHub, `/mnt`) é apagado ao fim do job. |
| Acesso | Só o servidor: RLS ligada sem policy, nada para `anon`/`authenticated`, RPCs da carga só para `service_role`. As RPCs de leitura (ficha, lista, crédito) devolvem só o **sinal** `socio_cpf`, **nunca** nome de sócio nem máscara. Nenhum CPF em UI, log, analytics ou resposta de erro da edge. |
| Compartilhamento | Nenhum novo. Processamento no Supabase (já operador) e no runner do GitHub (já operador da carga). |
| Retenção | O lote vigente + 1 anterior, para rollback curto. O que sai disso é apagado pela limpeza da própria carga, e lote abandonado em `carregando` expira em 3 dias. |
| Direitos do titular | A correção vem da fonte: a RFB atualiza o QSA e a próxima carga substitui o lote. Pedido de oposição ou eliminação: o Encarregado tira a raiz do universo (o dado é público, mas o tratamento aqui é nosso). |
| Alto risco? | Não pela Res. CD/ANPD 2/2022, art. 4º: não é dado sensível, não decide sozinho (é aviso, não bloqueio) e não monitora o titular. |
| Owner | Founder (Lucas) / Encarregado. |

## Ritual

- **Codex de desenho** (gpt-6-astra, high, 119 s): nenhum P0. Os 5 P1 foram adotados: serialização por lock e troca
  ordenada; manifesto imutável por digest; o vazamento do nome do perfil e do erro da edge; ACL só `service_role`;
  ordem de deploy e adoção. Dos P2 entraram: a exclusividade contada no universo inteiro, independente de
  `p_cnpjs`; a qualificação examinada em todas as linhas; a guarda por nome e par de raízes; a expiração de
  `carregando`.
- **Codex de código** (gpt-6-astra, high, 207 s): nenhum P0. Os 4 achados foram adotados:
  - P1: o MEI com acento ficava fora da contagem de exclusividade. Agora o nome é normalizado nesse ramo, com um
    índice parcial que usa só funções nativas.
  - P2: a carga dava "sucesso" para lote descartado. Agora o estado é validado e a publicação exige `vigente`.
  - P2: faltava concorrência na prova. Entrou o P10, com sabotagem que tira o lock.
  - P2: faltava o registro no núcleo do CI.
- **Prova PG17 `db/test-radar-socios-cpf.sh`:** 32 asserts. O `--falsificar` derruba 19/19 sabotagens, cada uma
  vermelha no assert dela, com controle verde, em `LC_ALL=C` e em `pt_BR.UTF-8`.
  - A 1ª rodada pegou um defeito do PRÓPRIO harness: o 2º apply (idempotência) abortava na PRE antes do assert, e
    foi preciso cegar a PRE.
  - Tirar o lock do **receber** ficou VERDE, e é redundante: a FK de `radar_socios` para o lote já trava a linha
    (`FOR KEY SHARE`) contra o `FOR UPDATE` da publicação. A sabotagem passou para a camada que serializa de fato, o
    lock da **publicação**, e aí o P10 fica vermelho, porque a publicação lê o lote incompleto e reprova.
  - O fixture reaproveita o schema da prova do passo 2, lido de lá para não divergir.
  - Está registrada no `db/nucleo-ci.txt`.

## Achado no deploy: RPC por indireção trava o pacote (2026-11-07)

A v1.5 chamava `admin.rpc(pedido.rpc, …)`. O `preflight:rpcs` não enxerga nome por indireção e sai com exit 3, e aí o
`pendencias:pacote` recusa liberar a edge: a lista de RPCs de pré-condição fica INCOMPLETA. Correção na v1.6: cada uma
das 4 RPCs é chamada pelo nome literal, e `RpcSocios` virou união de literais. O extrator passou a listar as 7 RPCs da
edge, com exit 0. A lição: na edge, o nome da RPC é sempre literal no call-site, mesmo quando o pedido é montado em
outro arquivo.
