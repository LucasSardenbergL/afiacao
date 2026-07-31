import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EMPRESA } from "@/components/reposicao/pedidos/shared";
import { track } from "@/lib/analytics";
import { useAuth } from "@/contexts/AuthContext";

/**
 * Registro de VENDA PERDIDA — a série de demanda censurada que não existia (lacuna P0 apontada
 * pelo challenge do Codex na análise de nível de serviço, 2026-07-30). "Cliente pediu e não
 * tinha" (ou desistiu por preço/prazo): registrar leva segundos e, com meses de dado, responde
 * "quanto a ruptura realmente custa" com número em vez de fé. NENHUM consumo automático no motor.
 */

const MOTIVOS = [
  { value: "sem_estoque", label: "Sem estoque" },
  { value: "preco", label: "Preço" },
  { value: "prazo", label: "Prazo de entrega" },
  { value: "outro", label: "Outro" },
] as const;

interface ProdutoOpcao { omie_codigo_produto: number; descricao: string | null }
interface RegistroPerdido {
  id: string; criado_em: string; sku_codigo_omie: string; sku_descricao: string | null;
  quantidade: number; cliente_nome: string | null; motivo: string; observacao: string | null;
}

export default function AdminReposicaoVendaPerdida() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [busca, setBusca] = useState("");
  const [produto, setProduto] = useState<ProdutoOpcao | null>(null);
  const [quantidade, setQuantidade] = useState("");
  const [cliente, setCliente] = useState("");
  const [motivo, setMotivo] = useState<string>("sem_estoque");
  const [observacao, setObservacao] = useState("");

  const buscaAtiva = busca.trim().length >= 2 && !produto;
  const opcoes = useQuery({
    queryKey: ["venda-perdida-busca-sku", busca],
    enabled: buscaAtiva,
    staleTime: 60_000,
    queryFn: async (): Promise<ProdutoOpcao[]> => {
      const termo = busca.trim();
      const porCodigo = /^\d+$/.test(termo);
      let q = supabase
        .from("omie_products")
        .select("omie_codigo_produto, descricao")
        .eq("account", EMPRESA.toLowerCase())
        .eq("ativo", true)
        .limit(10);
      q = porCodigo ? q.eq("omie_codigo_produto", Number(termo)) : q.ilike("descricao", `%${termo}%`);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map((r) => ({ omie_codigo_produto: Number(r.omie_codigo_produto), descricao: r.descricao }));
    },
  });

  const registrar = useMutation({
    mutationFn: async () => {
      const qtde = Number(quantidade.replace(",", "."));
      if (!produto) throw new Error("Escolha o produto");
      if (!Number.isFinite(qtde) || qtde <= 0) throw new Error("Quantidade inválida");
      const { error } = await supabase.from("venda_perdida_log" as never).insert({
        empresa: EMPRESA,
        sku_codigo_omie: String(produto.omie_codigo_produto),
        sku_descricao: produto.descricao,
        quantidade: qtde,
        cliente_nome: cliente.trim() || null,
        motivo,
        observacao: observacao.trim() || null,
        criado_por: user?.id ?? null,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Venda perdida registrada");
      track("reposicao.venda_perdida_registrada", { motivo });
      setProduto(null); setBusca(""); setQuantidade(""); setCliente(""); setObservacao("");
      qc.invalidateQueries({ queryKey: ["venda-perdida-recentes"] });
    },
    onError: (e: Error) => toast.error("Falha ao registrar: " + e.message),
  });

  const recentes = useQuery({
    queryKey: ["venda-perdida-recentes", EMPRESA],
    staleTime: 30_000,
    queryFn: async (): Promise<RegistroPerdido[]> => {
      const { data, error } = await supabase
        .from("venda_perdida_log" as never)
        .select("id, criado_em, sku_codigo_omie, sku_descricao, quantidade, cliente_nome, motivo, observacao")
        .eq("empresa", EMPRESA)
        .order("criado_em", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as unknown as RegistroPerdido[];
    },
  });

  const rotuloMotivo = useMemo(() => new Map<string, string>(MOTIVOS.map((m) => [m.value, m.label])), []);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <header>
        <h1 className="font-display text-3xl">Venda perdida</h1>
        <p className="text-sm text-muted-foreground">
          Cliente pediu e não fechou (faltou, preço, prazo)? Registrar leva segundos e cria a série
          que hoje não existe — com meses de dado, ela diz quanto a ruptura realmente custa.
        </p>
      </header>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Registrar</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {produto ? (
            <div className="flex items-center justify-between rounded-md border p-2 text-sm">
              <span className="truncate">{produto.descricao ?? produto.omie_codigo_produto}</span>
              <Button variant="ghost" size="sm" onClick={() => { setProduto(null); setBusca(""); }}>trocar</Button>
            </div>
          ) : (
            <div className="space-y-1">
              <Input
                placeholder="Buscar produto por descrição ou código"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
              />
              {buscaAtiva && (
                <div className="max-h-48 overflow-y-auto rounded-md border text-sm">
                  {opcoes.isLoading ? (
                    <div className="p-2 text-muted-foreground">Buscando…</div>
                  ) : (opcoes.data ?? []).length === 0 ? (
                    <div className="p-2 text-muted-foreground">Nenhum produto encontrado.</div>
                  ) : (
                    (opcoes.data ?? []).map((o) => (
                      <button
                        key={o.omie_codigo_produto}
                        type="button"
                        className="block w-full truncate px-2 py-1.5 text-left hover:bg-muted"
                        onClick={() => setProduto(o)}
                      >
                        {o.descricao ?? o.omie_codigo_produto}
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Input placeholder="Quantidade" inputMode="decimal" value={quantidade} onChange={(e) => setQuantidade(e.target.value)} />
            <Select value={motivo} onValueChange={setMotivo}>
              <SelectTrigger><SelectValue placeholder="Motivo" /></SelectTrigger>
              <SelectContent>
                {MOTIVOS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input placeholder="Cliente (opcional)" value={cliente} onChange={(e) => setCliente(e.target.value)} />
          </div>
          <Input placeholder="Observação (opcional)" value={observacao} onChange={(e) => setObservacao(e.target.value)} />
          <Button onClick={() => registrar.mutate()} disabled={registrar.isPending || !produto || !quantidade.trim()}>
            {registrar.isPending ? "Registrando…" : "Registrar venda perdida"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Últimos registros</CardTitle></CardHeader>
        <CardContent>
          {recentes.isError ? (
            <p className="text-sm text-muted-foreground">
              Não consegui ler os registros — a tabela pode ainda não existir em produção (migration pendente).
            </p>
          ) : (recentes.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhum registro ainda.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Quando</TableHead>
                    <TableHead>Produto</TableHead>
                    <TableHead className="text-right">Qtde</TableHead>
                    <TableHead>Motivo</TableHead>
                    <TableHead>Cliente</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(recentes.data ?? []).map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap text-xs tnum">{new Date(r.criado_em).toLocaleDateString("pt-BR")}</TableCell>
                      <TableCell>
                        <div className="text-sm">{r.sku_descricao ?? r.sku_codigo_omie}</div>
                      </TableCell>
                      <TableCell className="text-right tnum">{r.quantidade}</TableCell>
                      <TableCell className="text-xs">{rotuloMotivo.get(r.motivo) ?? r.motivo}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.cliente_nome ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
