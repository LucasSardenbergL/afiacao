# Crédito: aviso de possível vínculo com cliente que tem título vencido (passo 2 do "Radar sucessor", 2026-11-06)

Plano dos 3 passos aprovado pelo founder: sensor (feito, `radar-abriu-ficha-com-cnpj-2026-11-06.md`), **aviso de crédito**
(este) e CPF mascarado dos sócios (passo 3, fora daqui). Viabilidade: `radar-sucessor-viabilidade-2026-11-04.md`.

## O que entrega

Quando o CNPJ do cliente do pedido, ou do lead aberto na ficha do Radar, tem selo de possível vínculo/sucessor de um
cliente nosso com título vencido em aberto, a tela mostra **"Possível vínculo com cliente que possui títulos vencidos;
requer conferência."**, com quem é, a evidência que casou e o vencido por conta. **É só aviso:** não bloqueia o pedido,
não cria exceção, não encurta prazo e não entra em `vencido_no_momento`. `gateCredito()`/`venda_gate_credito` não mudaram.

- **Pedido:** bloco do cliente, junto do `AlertaCreditoCliente` (só staff). **Ficha do Radar:** antes do cadastro no
  Omie. A edge cria no Omie ANTES de `radar_registrar_cadastro_omie_v2`, então o aviso tem de ser leitura anterior.
- **Migration `20261106205557_credito_aviso_vinculo_vencido.sql`:**
  - `private.radar_vinculos_base(p_cnpjs, p_carteira, p_incluir_clientes)` continua sendo a ÚNICA cópia das regras do
    vínculo. Agora inclui sujeitos que já são clientes e não tem o corte de 10. `radar_vinculos_nucleo` vira invólucro
    (`false` + `ordem ≤ 10`): a ficha e a lista não mudam, como prova a foto antes×depois em todos os leads.
  - `public.credito_vinculo_aviso(p_cnpj)` (staff) segue o caminho documento → titular único → código Omie **com prova
    documental** (o contrato de identidade da 20261019140000) → `venda_prazo_aviso`. É a mesma regra do aviso de prazo,
    sem uma 3ª cópia.
  - `public.credito_vinculo_aviso_registrar` é o sensor e o único escritor dos 2 eventos no outbox. Valida no servidor;
    a allowlist quente de `analytics_ledger_registrar` não foi tocada.
- **Front:** `src/lib/credito-vinculo/`, `src/components/credito-vinculo/` (plataforma, como o selo da Receita).

## Decisões do founder (2026-11-06)

| Trade-off | Escolha |
|---|---|
| O que o vendedor sem `cap_carteira_ler` vê | **Igual à ficha:** valores para todo staff; nome/CNPJ de cliente só-cadastro ocultos ("um cliente da carteira — confira com a gestão") |
| Sem cobertura (fora da base RFB, CPF, vínculo indeterminado) | **Nota neutra discreta** "Vínculo com devedor não verificado (…)": nunca silêncio que pareça "em dia" |
| Lugar no pedido | **Bloco do cliente** (consulta cedo, antes dos itens) |

## Números medidos em prod (psql-ro, 2026-11-06)

- **241 pares** (conta, código) com vencido, 0 sem mapa. Todos os 241 têm evidência documental igual ao documento do
  perfil, `source='document'` e mapa com menos de 7 dias. Nenhum documento tem 2 titulares. Por isso exigir a prova
  custou **0 de recall**.
- A regra do vínculo (cópia literal, sem o filtro de já-cliente e sem o corte de 10) rodou sobre os 457 CNPJs que
  compartilham chave com algum devedor: **10 sujeitos** (4 fortes, 6 médios) estão vinculados a 10 devedores. **8 desses
  10 já são clientes**, e o núcleo da prospecção só mostraria 2. É o "obstáculo 1" do plano, medido. 2 pares têm só a
  `colacor_sc` como credora.
- **Ensaio ponta a ponta em prod** (`db:aplicar --ensaio`, ROLLBACK, só contagens): a migration aplicou e a RPC foi
  chamada como staff sobre os 10 sujeitos. Resultado: **8 com aviso** (8 vínculos, 8 credoras, 1 oculto para o
  vendedor) e 2 indeterminados. `fora_da_base` funcionou. A RPC levou no máximo **2,0 s** a frio por CNPJ, o que é
  aceitável para um aviso assíncrono que não segura o pedido. A regra em lote levou 9,6 s para os 457 candidatos.
- **Cobertura:** só 3.021 dos 15.226 perfis com CNPJ (~20%) estão em `radar_empresas`. Os demais saem como "não
  verificado (CNPJ fora da base da Receita)".

## Ritual

- **Codex desenho:** gpt-6-astra · max · 350 s · 151.206 tokens. Nenhum P0; 3 P1 adotados: prova documental, card
  antes do cadastro independente da consulta antiga, e avaliação incompleta ≠ silêncio. Os P2 também entraram:
  projeção, sensor com par e versão + voto corrigível + "não consegui confirmar", validação no servidor, lente.
- **Codex código:** ver o PR.
- **Prova PG17** `db/test-credito-vinculo-aviso.sh`: 30 asserts e `--falsificar` com 19/19 sabotagens vermelhas no
  assert certo, com controle verde, em `LC_ALL=C` e em `pt_BR.UTF-8`. A 1ª falsificação pegou 2 defeitos do PRÓPRIO
  harness. Primeiro, com `pipefail`, o `diff | head` do E1 abortava a suíte antes do assert, e o vermelho caía no lugar
  errado. Segundo, uma sabotagem casava 2 trechos e gerava erro de sintaxe. Agora `sabotar` exige ocorrência ÚNICA.
  Registrada no `db/nucleo-ci.txt`.

## Quando medir ("quando" é query)

```sql
-- O aviso aparece e é conferido? Denominador = avisos servidos (1 por titular, superfície, CNPJ e dia).
select props->>'superficie' superficie, count(*) servidos, count(distinct props->>'cnpj') sujeitos,
       count(distinct user_id) titulares
  from analytics_outbox where evento = 'credito.vinculo_aviso_servido' and ocorrido_em > now() - interval '30 days'
 group by 1;
-- Veredito vigente = o ÚLTIMO voto de cada (titular, superfície, sujeito, ref). Taxa de conferência ≠ concordância.
select veredito, count(*) from (
  select distinct on (user_id, props->>'superficie', props->>'cnpj', props->>'ref') props->>'veredito' veredito
    from analytics_outbox where evento = 'credito.vinculo_aviso_conferido'
   order by user_id, props->>'superficie', props->>'cnpj', props->>'ref', ocorrido_em desc) x
 group by 1;
```

⚠️ O outbox purga cada linha em 30 dias (`purgar_em`). A janela acima é o máximo que ele guarda; a série longa vive no
PostHog, que recebe do servidor e por isso não depende do navegador.

Revisão obrigatória ou qualquer efeito no crédito (o "passo 2b") só com avisos servidos **e** conferidos com
denominador, e com decisão nova do founder. "No ar e ninguém reclamou" é ausência de dado.
