// Emite a saída ESPERADA de `venda_recompra_em` / `venda_situacao_em` para a fixture compartilhada,
// calculada pelo oráculo TS (src/lib/venda-cliente/recompra.ts). Usado por db/test-venda-recompra.sh
// (paridade SQL × TS). Uso: bun scripts/venda-recompra-esperado.ts <fixture.json> <saida.json>
//
// O mapeamento fixture → LinhaPedido abaixo é a "fonte" (alias, universo de venda, data em SP, preço
// líquido); o SQL faz o mesmo em `private.venda_linhas_pedido`. Os casos (b)–(e) do teste SQL provam a
// fonte por fora desta paridade, para ela não ser só "os dois erram igual".
import { readFileSync, writeFileSync } from 'node:fs';
import {
  calcularRecompra,
  diasEntre,
  situacaoComprador,
  valorAtrasado,
  type Empresa,
  type LinhaPedido,
} from '../src/lib/venda-cliente/recompra';

type Item = [number, number, number | null, number | null];
interface Pedido {
  c: string;
  conta: string;
  status: string | null;
  kpi: string | null;
  created_at?: string;
  deleted?: boolean;
  itens: Item[];
}
interface Fixture {
  hojes: string[];
  aliases: { alias: string; canonico: string; status: string }[];
  pedidos: Pedido[];
}

const STATUS_NAO_VENDA = ['cancelado', 'rascunho', 'pendente', 'orcamento'];
const EMPRESAS = ['oben', 'colacor', 'colacor_sc'];

const diaSP = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const [fixturePath, saidaPath] = process.argv.slice(2);
if (!fixturePath || !saidaPath) {
  console.error('uso: bun scripts/venda-recompra-esperado.ts <fixture.json> <saida.json>');
  process.exit(2);
}
const fx = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;

const canonico = new Map(fx.aliases.filter((a) => a.status === 'active').map((a) => [a.alias, a.canonico]));

const linhas: LinhaPedido[] = [];
for (const p of fx.pedidos) {
  if (p.deleted) continue;
  if (p.status == null || STATUS_NAO_VENDA.includes(p.status)) continue;
  if (!EMPRESAS.includes(p.conta)) continue;
  const data = p.kpi ?? diaSP.format(new Date(p.created_at as string));
  for (const [cod, qtd, preco, desconto] of p.itens) {
    if (!(qtd > 0)) continue; // a fonte SQL descarta quantity ≤ 0 (o oráculo também descartaria)
    linhas.push({
      comprador_id: canonico.get(p.c) ?? p.c,
      empresa: p.conta as Empresa,
      omie_codigo_produto: cod,
      quantidade: qtd,
      preco_unit_liquido: preco == null || desconto == null ? null : preco - desconto / qtd,
      data_pedido: data,
    });
  }
}

const saida: Record<string, unknown> = {};
for (const hoje of fx.hojes) {
  const recompra = calcularRecompra(linhas, hoje);
  const historico = new Map<string, Set<string>>();
  for (const l of linhas) {
    if (l.data_pedido >= hoje) continue;
    const s = historico.get(l.comprador_id) ?? new Set<string>();
    s.add(l.data_pedido);
    historico.set(l.comprador_id, s);
  }
  const situacao = [...historico.entries()].map(([comprador, dias]) => {
    const skus = recompra.filter((r) => r.comprador_id === comprador);
    const ultima = [...dias].sort().at(-1) as string;
    return {
      comprador_id: comprador,
      situacao: situacaoComprador(skus, ultima, hoje, dias.size),
      dias_sem_compra: diasEntre(ultima, hoje),
      valor_atrasado: valorAtrasado(skus),
    };
  });
  saida[hoje] = { recompra, situacao };
}

writeFileSync(saidaPath, JSON.stringify(saida));
console.log(
  `esperado: ${fx.hojes
    .map((h) => {
      const s = saida[h] as { recompra: unknown[]; situacao: unknown[] };
      return `${h} recompra=${s.recompra.length} situacao=${s.situacao.length}`;
    })
    .join(' · ')}`,
);
