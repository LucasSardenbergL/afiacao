# Âncora nova somando previsto velho — recarregar UMA ponta de um número de DUAS pontas

2026-10-08, PR #PR-ESTE. Classe do #2459 (dupla contagem no caixa projetado), criada agora pelo
próprio botão "Sincronizar". Achado durante o #2865 e registrado lá como fora do escopo.

## O número

A aba "Fluxo Caixa" de `/financeiro` projeta `saldoCC + Σ previsto futuro`
(`src/components/financeiro/dashboard/fluxo-caixa-semanas.ts`). As duas pontas têm ÉPOCAS
distintas por desenho: a **âncora** é o saldo bancário de HOJE (`fin_contas_correntes`, via
`resumo.saldo_total_cc`) e o **delta** é só o que ainda NÃO entrou — o dinheiro já recebido
está dentro da âncora, então contá-lo de novo no previsto é somar duas vezes.

As duas pontas são estados DIFERENTES do `useFinanceiro`: `resumo` e `fluxoCaixa`. O `syncAll`
sincronizava contas correntes, CP, CR e movimentações — e depois recarregava **só o resumo**. O
`fluxoCaixa` só era relido pelo efeito de abas da página, cujas dependências (`tab`, `view`,
filtros) não mudam quando se clica em Sincronizar.

Resultado: com a aba aberta, o clique deixava a âncora NOVA e o previsto VELHO. Um título que
virasse RECEBIDO durante a sincronização já entrava no saldo bancário e continuava contando
como entrada futura, até alguém trocar de aba. Em prod havia 20 títulos RECEBIDO com vencimento
futuro (psql-ro, 2026-10-08), então o gatilho existia.

## A lição

**Num número de duas pontas, recarregar apenas uma não é meia-correção: é uma dupla contagem
nova.** O eixo não é "o dado está velho" — dado velho coerente consigo mesmo erra para um lado
só. O defeito aparece quando duas leituras de épocas diferentes entram na MESMA conta: o erro
não é a defasagem, é a soma.

Dois corolários que custaram a escolha do desenho:

1. **Recarregar as duas pontas em sequência não fecha a janela.** `await loadResumo()` seguido
   de `await loadFluxoCaixa()` são dois `setState` em `await`s distintos: o render do meio exibe
   a mistura. E se a segunda leitura cair no `catch`, o estado FINAL é exatamente o defeito.
   Invalidar a ponta velha **antes** de escrever troca o pior caso de "número inflado" por
   "aba em skeleton" — precisão > recall (`docs/agent/money-path.md`).
2. **Invalidar sem um gatilho de releitura troca um defeito por outro.** Zerar o previsto sem
   sinalizar nada deixa a aba vazia até o usuário interagir, porque o efeito não re-dispara: as
   deps dele não mudaram. O par é **invalidar + sinalizar versão**; a versão entra nas deps do
   efeito e a aba ATIVA relê. Quem invalida não é quem recarrega.

## Como se prova sem espionar implementação

O invariante de PRODUTO é mais forte e mais barato do que contar chamadas:
**receber um título a vencer não muda o caixa projetado** — o dinheiro só muda de bolso.

    antes do sync : banco 1.000 + previsto 4.000 → projetado 5.000  (`R$ 5.0k`)
    o sync recebe 2.000 do título a vencer
    depois do sync: banco 3.000 + previsto 2.000 → projetado 5.000  (invariante)
    defeito       : banco 3.000 + previsto 4.000 → projetado 7.000  (`R$ 7.0k`)

`R$ 7.0k` é a marca EXCLUSIVA do defeito. ⚠️ Mas como `R$ 5.0k` é o total antes **e** depois, a
ausência do 7.0k **sozinha** não prova reconciliação — inércia daria o mesmo resultado. O teste
precisa do sinal POSITIVO ao lado: o previsto foi relido e a âncora mudou de valor
(`R$ 1.0k` → `R$ 3.0k`). Guard em
`src/pages/__tests__/FinanceiroDashboard.coerencia-pos-sync.test.tsx`.

Detalhes que o teste cobrou: o Radix Tabs troca de painel no **mouseDown**, não no `click`
(com `fireEvent.click` a aba nunca ativava e `getFluxoCaixa` ficava em 0 chamadas — falha de
setup que se disfarça de falha de asserção); e a janela EM VOO só é inspecionável com o sync
pendente de propósito (mock que resolve sob comando).

**Falsificação: 4/4**, controle verde na MESMA invocação do laço antes da 1ª sabotagem e depois
da última. Cada camada tem uma sabotagem que a mata com marca ASCII prevista antes de rodar:
sem a invalidação (`to have a length of +0`), sem a versão nas deps da tela e sem o incremento
no `finally` (`to be called 2 times, but got 1`), e sem o `|| syncing` no `loading` da aba
(`to be null` — sem ele a tela mostra "Sincronize os dados primeiro" **durante** o sync).

## A segunda porta da mesma mistura

`loadFluxoCaixa` mantinha o previsto anterior quando a leitura falhava (o `catch` só setava o
erro): trocar de empresa e falhar exibia o fluxo da empresa ANTERIOR sob a âncora da atual.
Era o mesmo defeito por outra porta — e estava na lista de "fora do escopo" do #2865, a três
linhas do item do `syncAll`. O `catch` agora descarta o previsto. Leitura que falha não é
leitura vazia (`docs/agent/financeiro.md`), mas também **não é a leitura de antes**: a faixa de
erro da página continua dizendo que falhou, e o número não é mais o da época anterior.

## De passagem, pela mesma via

- `syncSpecific` não recarregava **nada**, e `sync_contas_correntes` move a âncora.
- `calcularDRE(ano, [mes])` substituía o estado `dre` por um mês só: a aba de DRE anual ficava
  exibindo um mês até alguma outra dependência do efeito mudar.

## Fora do escopo

- O `saldo_previsto` de `FluxoCaixaDiario` continua sem leitor e sem âncora (herdado do #2865).
- Aging e inadimplentes também ficam velhos após um sync. São dados de uma ponta só — erram
  para um lado, não somam épocas —, então ficaram fora por decisão, não por esquecimento.
