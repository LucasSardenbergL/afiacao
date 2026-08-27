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

## A lição 4 — no eco passivo, leia o `modo` ANTES do `versao`

`versao` vazio numa linha de `resultados` **não** é "marcador velho". O `omie-cron-diario` aborta o
cliente em 25s (`STEP_TIMEOUT_MS`) e devolve `modo:"background", coletado:false` — a edge segue
server-side, mas **o corpo não foi coletado**, então não há `body.versao` para ler. Julgar por esse
vazio reprova um deploy CORRETO e manda redeployar edge money-path à toa. Isso quase aconteceu na
sessão que originou esta entrega.

É a mesma família da linha de timeout do `net._http_response`, que vem com `content` e
`status_code` NULL e devolve uma linha vazia com exit 0: **ausência de dado sendo lida como
veredito** (`money-path.md`, "ausente ≠ zero").

O SQL de verificação, portanto, projeta `modo` e `versao` lado a lado — nunca só o segundo:

```sql
SELECT r.id, r.created, k, (r.content::jsonb)->'resultados'->k->>'modo' AS modo,
       (r.content::jsonb)->'resultados'->k->'body'->>'versao' AS versao
FROM net._http_response r, jsonb_object_keys((r.content::jsonb)->'resultados') k
WHERE r.created BETWEEN '<inicio>' AND '<fim>' AND r.status_code = 200
  AND r.content IS NOT NULL AND left(ltrim(r.content),1) = '{'
  AND (r.content::jsonb) ? 'resultados'
ORDER BY r.id, k;
```

⚠️ Ache o run por **janela de tempo**, nunca por id chutado (`deploy.md`: id vizinho é tick alheio
por padrão), e dentro da retenção de ~6h do `pg_net.ttl`.

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
