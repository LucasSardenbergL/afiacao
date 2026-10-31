# Radar: a amostra de controle entra na fila do vendedor (2026-10-30)

> Continuação da frente 3 ([radar-score-backtest-e-placar.md](radar-score-backtest-e-placar.md)). Ela registrou
> a `coorte-2026-10` (topo 536, amostra 50) com denominador fixo, mas a tabela não tinha leitor para o front:
> sem a tela mostrar a amostra, ninguém a contata e a comparação topo × amostra nunca mede nada.

## O que entrou

| Peça | O quê |
| --- | --- |
| Migration `20261030233200_radar_amostra_vigente_leitura.sql` | RPC nova `public.radar_amostra_vigente()`: SECURITY DEFINER, gate `private.cap_radar_prospectar(auth.uid())` (42501 `forbidden: radar_prospectar`), devolve `sorteio, grupo, cnpj, posicao` **só da amostra** do sorteio mais recente (`sorteada_em DESC`). REVOKE de PUBLIC **e** anon nomeados; EXECUTE para authenticated/service_role/claude_ro. Postcondição P1–P5 (existe, SECDEF, search_path fixo, ACL, tabela ainda sem policy). |
| `src/lib/radar/amostra.ts` | Regra pura: `intercalarAmostra` (1 a cada 10, estável por prefixo, sobra no fim quando a fila acaba), `casaFiltrosExplicitos`, `pendenteNaAmostra`, `resumirAmostra`, leitor validado `lerAmostraVigente` (teto 1.000 = erro). |
| `src/queries/useRadarAmostra.ts` | RPC + linha atual de cada sorteado em `radar_empresas` (`.in()` em lotes de 100). Chave `['radar','amostra']`: o registro de contato já invalida `['radar']`, então o contatado sai da fila na hora. |
| `RadarClientes.tsx` / `RadarLinha.tsx` / `RadarAmostraRegra.tsx` | Fila intercalada, selo **amostra** (com o sorteio no título) e a linha da regra acima da lista. Lente "Ver como": RPC na allowlist de leitura do write-guard. |

### Decisões

- **RPC, não policy.** A tabela segue fechada (sem policy, sem privilégio de tabela para o front); a RPC expõe só
  o necessário e nunca o topo nem a nota do sorteio. Só a amostra: o topo já aparece pelo score, e 536+ linhas
  encostariam no corte silencioso de 1.000 do PostgREST num sorteio maior.
- **O que NÃO esconde a amostra:** região padrão, "só sugeridos", "só inéditos", modo de ataque, "com telefone",
  "incluir sem contato" — recortes de ranking, que a amostra existe para furar. **Os 4 de PA (3) e RS (1) aparecem**
  com a região padrão; a linha da regra diz "inclui 4 fora da região de atuação (PA, RS)".
- **O que esconde:** o que o vendedor digitou ou escolheu (busca, UF, município, CNAE, status ≠ a contatar). A
  linha da regra conta quantos ficaram escondidos pelo filtro.
- **Sem substituição silenciosa.** Só ocupa lugar quem está a contatar e não é cliente. Quem foi contatado,
  descartado, virou cliente ou não voltou na leitura sai da fila e **não** é reposto; o resumo da regra conta o
  sorteio inteiro (pendentes · contatados · fora da fila com motivo), batendo com o denominador da coorte.
- **Contato:** o mesmo fluxo do topo (`registrar_contato_radar`, a ficha de sempre). O sensor é o ledger
  `radar_eventos` + `radar_coorte_resultado()` da frente 3; nenhuma máquina nova.

## Provas

- `db/test-radar-amostra-vigente.sh` (núcleo do CI, 7 asserts, `falsificar=7`): autorizado lê só a amostra do
  vigente em ordem (A1); sem cap (A2) e sem JWT (A3) barrados pelo gate; anon barrado pelo privilégio (A4);
  tabela ilegível direto (A5); sorteio novo vira o vigente (A6); 2 applies sem policy (A7). `--falsificar`
  **7/7 vermelhas** com controle verde em `LC_ALL=C` **e** `pt_BR.UTF-8`: sem gate→A2, topo junto→A1, sorteio
  antigo→A1, anon sem a PÓS→A4, anon→P4, SECURITY INVOKER→P2, tabela aberta→P5. Limite: a cap é STUB (a real
  tem prova em `db/test-radar-acesso-vendedor.sh`).
- `src/lib/radar/__tests__/amostra.test.ts` + selo em `RadarLinha.selos.test.tsx`. Falsificado à mão (commitado
  antes): passo 10→9, pendente sem `ja_cliente`, sobra sem ir ao fim, UF ignorada e duplicata na fila — 5/5
  vermelhas, controle verde.

## Camadas de deploy

| Camada | Quem | Estado |
| --- | --- | --- |
| Migration `20261030233200` | sessão, `bun run db:aplicar` | ✅ 2026-10-30 ~23:50 BRT: ensaio (`ENSAIO ok`, rollback conferido: função ausente depois) → apply (tentativa #772 virou recibo) → psql-ro: md5 do corpo `68e63b59…` = repo, SECDEF, `search_path=public, pg_temp`, anon/PUBLIC sem EXECUTE, authenticated/claude_ro com; tabela RLS on, 0 policies, sem SELECT para anon/authenticated; claude_ro sem cap → `forbidden: radar_prospectar`; com o JWT de um master (transação read-only, ROLLBACK) → 50 linhas, 1 sorteio (`coorte-2026-10`), posições 1–50, ES 5 · MG 21 · PA 3 · RS 1 · SP 20 |
| Publish do Lovable (front) | **founder** | ⏳ depois do merge. Sem ele a RPC existe e ninguém a chama. E o SW só troca de build quando o cliente clica. |

## Como medir (query, não recado)

```sql
-- psql-ro: conversão e toques por grupo da coorte vigente (denominador = registro)
SELECT * FROM public.radar_coorte_resultado();
-- uso: aberturas e toques por janela
SELECT * FROM public.radar_placar_uso();
```

Sinal positivo de uso = algum sorteado da amostra com contato humano em `radar_eventos` depois do Publish.
"Ninguém reclamou" não conta.
