# O deploy de um orquestrador vale o elo mais fraco — e o eco PASSIVO é o sensor barato que faltava

**Classe:** sensor instalado por EDGE numa entrega cujo objeto é um CONJUNTO. Cada edge fica
"decidida" no seu mérito, ninguém decide o conjunto, e a verificação do conjunto vale o pior elo.

Data: 2026-08-27. Substrato: os 5 steps do `omie-cron-diario`.

## O que aconteceu

O #2031 (`118b10655`) pôs coleira de RELÓGIO no `omieCall` dos **cinco** steps que o
`omie-cron-diario` orquestra. Verificar se ele tinha ido ao ar provou **um**: o
`omie-sync-nfes-recebidas`, o único com `versao.ts` e sonda. Os outros quatro —
`omie-sync-pedidos-compra`, `omie-sync-ctes-recebidos`, `omie-sync-sku-items`,
`omie-sync-vendas-items` — ficaram como INFERÊNCIA ("o Lovable deployou tudo junto, deve ter ido").

Isso não é um detalhe de rigor. O sintoma que a coleira corrige — **request pendurado** — é
INDISTINGUÍVEL de "o Omie estava lento" quando se olha só o resultado. Sem saber qual bundle está
no ar, o próximo estouro não diz se a coleira falhou ou se nunca foi deployada, e o desfecho é
investigar o Omie por um bug que é nosso (ou o contrário).

**Por que ficaram inverificáveis:** as quatro não tinham `versao.ts`, não tinham sonda
`{"probe":true}`, e o corpo que devolviam era **byte-idêntico** antes e depois de uma fatia. Nem
N1 (grep na `main`, que prova FONTE), nem N2, nem canária: não havia resposta possível para "qual
bundle está no ar?".

## A lição 1 — verificabilidade é propriedade do CONJUNTO, não da edge

As nove levas anteriores de instrumentação escolheram alvo por **efeito da edge** (escreve no
Omie? escreve money-path no nosso banco? é chamada pelo browser?). Cada escolha estava certa
isoladamente e o conjunto ficou errado: instrumentar 1 de 5 steps de um orquestrador entrega uma
verificação que vale **o elo mais fraco**, porque a pergunta que alguém faz depois do merge não é
"a edge X subiu?", é "**a fatia** subiu?" — e a fatia atravessou os cinco.

⇒ **Régua nova:** quando uma fatia toca N edges que um orquestrador chama juntas, o critério de
instrumentação é o CONJUNTO. Instrumentar o subconjunto "que escreve mais" produz exatamente o
desfecho de 2026-08-27: um step provado e quatro inferidos, num diff único.

## A lição 2 — o eco PASSIVO de `versao` é o N3 mais barato, e não custa chamada nenhuma

O `omie-sync-nfes-recebidas` já resolvia isso de graça, com um pedaço que passou despercebido: o
helper `jsonRes` dele anexa `versao: VERSAO` a **TODA** resposta, não só à da sonda.

```ts
return new Response(JSON.stringify({ ...body, versao: VERSAO }), { … });
```

E o `omie-cron-diario` (`runStep`) faz `JSON.parse` do corpo de cada step e o devolve INTEIRO em
`resultados.<key>.body`. Logo a resposta que o **jobid 52**
(`afiacao_omie_oben_sync_incremental_2h`, `15 */2 * * *`) já grava em `net._http_response` carrega
o marcador do step — **N3 PASSIVO pela forma do JSON**: prova de versão sem invocar nada, sem cron
secret, sem o founder logado e sem pagar efeito caro nenhum.

Foi assim que o #2031 se provou na `omie-sync-nfes-recebidas`:

```
id 61498 (2026-08-27 16:15Z)  resultados.nfes.modo=respondido  versao = v1.1-deadline-relogio
id 61560 (2026-08-27 18:15Z)  resultados.nfes.modo=respondido  versao = v1.1-deadline-relogio
```

**Por que o eco importa MAIS que a sonda nestas quatro:** nenhuma delas roteia por `action`, então
um bundle PRÉ-sensor recebe `{"probe":true}`, não reconhece nada, cai nos defaults e **dispara a
varredura inteira**. A sonda só é segura DEPOIS do deploy confirmado — ou seja, ela não serve para
a pergunta que se faz ANTES. O caminho passivo não tem esse problema: ele já respondeu, no último
tick do cron, sem ninguém pedir.

## A lição 3 — o eco no fluxo real é sensor OU disfarce, e a régua os separa

`docs/agent/deploy.md` já carrega o alerta inverso: a `omie-nfe-reconcile` respondia
`versao:"v3.3-paginacao-janelas"` no fluxo real e **não era sensor de deploy** — o valor é
hardcoded, aceso à mão, e ficou idêntico byte a byte nos dois bundles do #2025.

A régua que separa os dois casos é a do próprio doc, e ela não é sobre ONDE o campo viaja:

- marcador **aceso à mão e sem gate** nomeia a FATIA e nada mais → disfarce;
- marcador que um gate **obriga a mover** (`sonda:bump`) e que o `sonda:fingerprint` **deriva da
  fonte** identifica o BUNDLE → sensor.

`versao: VERSAO` importado do `versao.ts` cai no segundo caso. O `v3.3` hardcoded, no primeiro.
Mesmo campo, mesma posição na resposta, veredito oposto — e é por isso que copiar a FORMA sem o
`versao.ts` reproduziria o disfarce.

⚠️ **Ressalva medida (a mesma do #2054):** o eco passivo carrega `versao`, **não** `fonte`. Fatia
que chegue inteira por `_shared/` não move o `VERSAO` (o `sonda:bump` exclui `_shared/` por
medição: ~12 bumps à mão por PR) e o eco responde idêntico nos dois bundles. Quando a fatia tocar
`_shared/`, o veredito exige a chamada à sonda, que é quem serve o `fonte`.

## A lição 3.5 — MEDIDO: o eco cobre o step que cabe em 25s, e os 2 pesados não cabem

Escrito na entrega (2026-08-27) e **corrigido pela verificação (2026-08-28)**. A régua original deste
doc — "os 5 steps provam deploy pelo eco" — é mais forte que o mecanismo, e prometer demais é a
própria classe que a entrega combate.

Tick pós-deploy, `id 61756` (`02:15:00Z`):

| step | modo | versao |
|---|---|---|
| `ctes` | respondido | ✅ `v1.0-eco-versao-passivo` |
| `sku_items` | respondido | ✅ `v1.0-eco-versao-passivo` |
| `vendas` | respondido | ✅ `v1.0-eco-versao-passivo` |
| `pedidos` | **background** | (vazio) |
| `nfes` | **background** | (vazio) |

Nos 4 ticks da janela de retenção: `nfes` background **4/4**, `pedidos` **3/4**, os outros três
`respondido` 4/4. Amostra pequena — 4 ticks é o que o `pg_net.ttl` de ~6h permite —, e por isso o
enunciado abaixo fala de MECANISMO (o abort em `STEP_TIMEOUT_MS`), não de frequência.

⇒ **Régua honesta:** o eco passivo prova o step cujo corpo o orquestrador consegue COLETAR, isto é,
o que responde dentro do `STEP_TIMEOUT_MS` (25s). O step que estoura segue rodando server-side e
não devolve corpo nenhum — para ele, a prova continua sendo a sonda ativa.

A ironia operacional que fecha o argumento: **a sonda é mais cara exatamente nos dois steps que o
eco não alcança** (são os mais pesados, e um bundle pré-sensor sondado dispara a varredura inteira).
O eco resolveu 3 dos 5 e deixou os 2 caros no mesmo lugar — melhoria real, cobertura parcial.

⚠️ Isto **não** invalida a lição 2: para os três steps que cabem, o caminho passivo funcionou
exatamente como desenhado, e o contraste é prova (os três ticks ANTERIORES ao deploy trazem o mesmo
campo ausente). O que muda é o escopo do que se pode afirmar.

## A lição 4 — no eco passivo, leia o `modo` ANTES do `versao`

`versao` vazio numa linha de `resultados` **não** é "marcador velho". O `omie-cron-diario` aborta o
cliente em 25s (`STEP_TIMEOUT_MS`) e devolve `modo:"background", coletado:false` — a edge segue
server-side, mas **o corpo não foi coletado**, então não há `body.versao` para ler. Julgar por esse
vazio reprova um deploy CORRETO e manda redeployar edge money-path à toa. Isso quase aconteceu na
sessão que originou esta entrega.

É a mesma família da linha de timeout do `net._http_response`, que vem com `content` e
`status_code` NULL e devolve uma linha vazia com exit 0: **ausência de dado sendo lida como
veredito** (`money-path.md`, "ausente ≠ zero").

E aqui a coincidência é cruel, porque o vazio do `background` é **byte a byte** o mesmo vazio do
bundle pré-sensor: nos ticks de 20:15, 22:15 e 00:15 (antes do deploy) o `ctes` vinha `respondido`
com `versao` ausente — bundle velho de verdade —, e no de 02:15 o `pedidos` veio vazio por não ter
sido coletado. Só a coluna `modo` separa os dois casos. Um verificador que projete apenas `versao`
não tem como distinguir "não subiu" de "não deu tempo de coletar".

O SQL de verificação, portanto, projeta `modo` e `versao` lado a lado — nunca só o segundo:

```sql
SELECT r.id, r.created, k, (r.content::jsonb)->'resultados'->k->>'modo' AS modo,
       (r.content::jsonb)->'resultados'->k->'body'->>'versao' AS versao
FROM net._http_response r, jsonb_object_keys((r.content::jsonb)->'resultados') k
WHERE r.created BETWEEN '<inicio>' AND '<fim>' AND r.status_code = 200
  AND r.content IS NOT NULL AND left(ltrim(r.content),1) = '{'
  AND (r.content::jsonb) ? 'resultados'
  AND jsonb_typeof((r.content::jsonb)->'resultados') = 'object'
ORDER BY r.id, k;
```

⚠️ Ache o run por **janela de tempo**, nunca por id chutado (`deploy.md`: id vizinho é tick alheio
por padrão), e dentro da retenção de ~6h do `pg_net.ttl`.

## O que a 2ª opinião (Codex `gpt-5.6-sol`/xhigh, 2026-08-28) acrescentou

Levei a lacuna dos 2 steps ao ritual `/codex` com cinco opções e minha ceticismo declarado. Três
achados sobreviveram à conferência contra o código:

### 1. O eco NÃO carrega `edge` — furo meu, e é a lição das 10 sondas repetida

`criarRespostaSonda` serve `{ok, probe, versao, edge, fonte}`. Meu `jsonRes` replicou **só o
`versao`**. Como as quatro nascem no MESMO marcador (`v1.0-eco-versao-passivo`), o eco sozinho não
diz QUEM respondeu: a identidade vem da CHAVE que o orquestrador escolhe (`resultados.ctes`), ou
seja, é confiada ao pai. O gate `o orquestrador chama exatamente estes 5 steps` protege a `main`;
ele não prova o bundle do PAI em produção.

É exatamente o furo que o campo `edge` existe para fechar — ele nasceu de 10 sondas respondidas com
corpos byte a byte idênticos e nenhum veredito por edge possível (`verificar-sonda-versao.md` §7).
Repliquei metade do desenho e deixei de fora a metade que uma lição anterior já tinha pago.

**Não corrigido nesta fatia de propósito:** acrescentar `edge` muda o corpo servido ⇒ exige bump do
`VERSAO` ⇒ deixa prod (`v1.0`) atrás da `main` (`v1.1`) e **cobra um novo ciclo de deploy manual das
edges**, um dia depois do anterior. O ganho hoje é baixo (as 5 chaves do pai são estáveis e há gate
na `main`) e a opção (F) abaixo traz `edge` de graça. ⇒ **agrupar com (F)**, não gastar um ciclo de
deploy sozinho.

### 2. Opção (F): atestação por `OPTIONS` autenticado — a saída do ciclo impossível

O problema que travava todas as opções de sondagem automática: *sondar para descobrir se o sensor
subiu dispara o efeito caro justamente quando ele NÃO subiu*. O `OPTIONS` quebra isso, e a razão é
mecânica — **as cinco edges tratam `OPTIONS` ANTES do gate de auth e de qualquer IO**, e já tratavam
no bundle pré-sensor:

| edge | linha do `OPTIONS` | linha do `authorizeCronOrStaff` |
|---|---|---|
| `omie-sync-pedidos-compra` | 1004 | 1008 |
| `omie-sync-ctes-recebidos` | 544 | 545 |
| `omie-sync-sku-items` | 656 | 659 |
| `omie-sync-vendas-items` | 308 | 311 |
| `omie-sync-nfes-recebidas` | 852 | 855 |

⇒ um bundle PRÉ-sensor que receba `OPTIONS` devolve só o CORS antigo e **não executa nada**. O
orquestrador poderia colher `{probe, edge, versao, fonte}` das cinco no início do tick, cobrindo
deterministicamente inclusive os que estouram — e trazendo o `fonte`, que o eco não tem e é o único
campo que enxerga mudança vinda de `_shared/`.

⚠️ **É entrega própria, não apêndice:** toca o ramo CORS das 5 edges money-path mais o orquestrador,
e o ramo `OPTIONS` é o mais silencioso que existe — errar ali quebra o CORS do app inteiro. Riscos a
tratar no desenho: `OPTIONS` autenticado tem de exigir o `Bearer SERVICE_ROLE` (o preflight comum do
browser continua devolvendo só CORS, sem expor fingerprint); e chamadas aninhadas compartilham
orçamento de rate limit por trace ⇒ baixa concorrência, timeout curto, zero retry, medir 425/429.

### 3. Opções rejeitadas, com o motivo que as mata

- **(B) o pai sonda por POST antes de cada step:** rejeitada. O custo das 5 chamadas é irrelevante;
  o que mata é o fallback do bundle antigo. "Acontece uma vez" pressupõe deploy perfeito — se o PAI
  subir antes das FILHAS, repete a cada 2h; num rollback pré-sensor, reaparece. Pior: a sonda antiga
  pode ainda estar rodando quando o POST real começa ⇒ **duas varreduras concorrentes**.
- **(D) filha responde 202 + `waitUntil`:** rejeitada com mais força. Os steps **não** são
  independentes — NF-es/CT-es/itens leem o espelho de pedidos, e o comentário do orquestrador
  registra que ele é síncrono de propósito. Hoje o abort já reduz "sequencial" a "25s de vantagem";
  o 202 reduziria a quase zero e ampliaria a corrida. E trocaria "respondeu" de prova de CONCLUSÃO
  para prova de ACEITAÇÃO.
- **(E) marcador no log que a edge já escreve:** só evidência auxiliar, e cobre menos do que parecia.
  Das cinco, apenas `omie-sync-sku-items` e `omie-sync-nfes-recebidas` têm linha append-only por run
  em `fin_sync_log`. `omie-sync-pedidos-compra` só sobrescreve heartbeat em `sync_state` — sujeito a
  um run antigo terminar depois e **sobrescrever a evidência nova** (é a regra "sinal money-path
  nunca em jsonb multi-writer" batendo). `ctes` e `vendas` não escrevem log nenhum. ⇒ acrescentar
  `edge/versao/fonte` aos logs de NF-es/SKU é barato; criar log de negócio novo só para deploy, não.

### Modos em que o eco ainda pode mentir (além do `_shared/`)

1. **Identidade confiada ao pai** — o item 1 acima.
2. **`fonte` não é hash do bundle** — sem `deno.lock` versionado e com range aberto; e um deploy
   MISTO (`versao.ts` + mapa novos, `index.ts` velho) responde os dois campos "certos" com
   comportamento errado. O gerador lê a fonte crua, então também conta import citado em comentário.
3. **Uma resposta prova UMA requisição** — não exclusividade temporal. Um tick pode atravessar um
   deploy manual e conter épocas diferentes por step. Leia step a step; nunca chame o conjunto de
   "snapshot atômico de produção".

⚠️ **O `/codex` desta rodada não teve revisão cruzada** — o wrapper reporta que a 2ª chamada falhou
porque o sandbox read-only não deixou criar o temporário. O parecer é auto-adversário (Caminho B),
e os fatos acima foram conferidos contra o código antes de entrar aqui; o que não foi conferido é
o desenho de (F) por um segundo modelo.

## O que ficou de gate

Em `supabase/functions/_shared/sonda-versao-contrato_test.ts`, além das 4 linhas novas em `EDGES` e
`ESCRITA_NOSSO_BANCO` (que as põem sob os gates de FORMA já existentes):

- **`os 5 steps do cron diário ECOAM versao em toda resposta`** — exige o spread
  (`{ ...body, versao: VERSAO }`), que é o que separa "anexa a todo corpo" de "montei um corpo com
  `versao` dentro" (esta última serviria só a resposta que o autor lembrou de tocar). E exige que o
  handler não monte mais nenhuma resposta JSON por fora do helper — senão a resposta do RUN, que é
  justamente a que o cron coleta, sai sem marcador enquanto o gate fica verde pelo helper.
- **`CALIBRAÇÃO: o gate do eco reprova o marcador que só a sonda carrega`** — falsifica contra a
  forma PRÉ-fatia das quatro e contra o corpo montado à mão.
- **`décima leva: o corpo do Request é lido UMA vez só`** — a sonda obrigou o parse a subir; um
  `req.json()` a mais devolveria `{}` e descartaria `empresa`/`dias`/`trigger` em silêncio.
- **`o orquestrador chama exatamente estes 5 steps, com estas chaves`** — o mapa `key`↔edge é o que
  a receita de verificação usa em `resultados.<key>.body.versao`; chave errada devolve NULL, que é
  byte a byte a assinatura de "bundle pré-sensor". O gate falha nomeando a divergência quando o
  `omie-cron-diario` ganha um 6º step ou renomeia uma `key`.

## Adendo 2026-08-28 — o `background` é do TICK, não do STEP (e a janela larga precisa de guard)

A régua acima mediu **um** tick (id 61756, 02:15Z) e leu `pedidos` como um dos steps que o eco não
alcança, concluindo que ali "a prova continua sendo a sonda ativa". Ao verificar o deploy do #2063
no dia seguinte, quatro ticks contam outra história:

| tick (UTC) | `modo` do `pedidos` | `versao` |
|---|---|---|
| 2026-08-28 02:15 | `background` | *(vazio)* |
| 2026-08-28 06:15 | `background` | *(vazio)* |
| 2026-08-28 08:15 | `background` | *(vazio)* |
| **2026-08-28 10:15** | **`respondido`** | **`v1.0-eco-versao-passivo`** |

Mesma edge, mesmo bundle, mesmo `STEP_TIMEOUT_MS`: o que varia é a carga do Omie naquele tick. Logo
o `background` **não é propriedade do step** — é sorteio por execução, e três seguidos não são
evidência de que o eco nunca alcança aquele step. Quem lê o primeiro `background` como "só a sonda
ativa resolve" paga a sonda cara (que num bundle pré-sensor dispara o efeito real) para responder o
que o tick seguinte responde de graça.

**Regra:** diante de `background`, releia a **janela inteira do TTL** antes de invocar a sonda. A
cobertura do eco não se mede num tick — ela CONVERGE ao longo deles.

### O guard de tipo, que a janela estreita esconde

Alargar a janela é o que ativa uma falha que o `BETWEEN` de 10 minutos vinha escondendo: o
predicado `(content::jsonb) ? 'resultados'` também casa com **outro emissor**, que grava
`{"success":true,"processados":0,"resultados":[]}` — `resultados` como **array** (1 linha, medida às
09:00:03Z, contra 3 do orquestrador na mesma janela). O `jsonb_object_keys` sobre um array **aborta
a query inteira**:

```text
ERROR:  cannot call jsonb_object_keys on an array
```

Não é uma linha ruim que se ignora: é o resultado todo perdido. A falha é **ruidosa** (exit 1), então
não fabrica veredito — mas some com a leitura justamente quando se acumula ticks, que é a receita do
adendo acima. `jsonb_typeof((content::jsonb)->'resultados') = 'object'` separa os dois emissores, e
está embutido na query desta página e na da skill `lovable-deploy-verify`.
