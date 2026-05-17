import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ScrollText } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { TabFallback } from "./TabFallback";

type LogRow = {
  id: string;
  created_at: string;
  user_id: string | null;
  action: string;
  result: string;
  metadata: Record<string, unknown> | null;
};

export function AuditLogSection() {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(20);

  const { data: rows = [], isLoading, refetch } = useQuery({
    queryKey: ["cockpit-audit-log", limit],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cockpit_audit_log")
        .select("id,created_at,user_id,action,result,metadata")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return ((data ?? []) as unknown) as LogRow[];
    },
    enabled: open,
  });

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="w-full flex items-center justify-between p-4 hover:bg-muted/40 transition-colors"
          >
            <div className="flex items-center gap-2">
              <ScrollText className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Log de Auditoria</span>
            </div>
            {open ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0">
            {isLoading ? (
              <TabFallback />
            ) : rows.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Nenhum registro de auditoria.
              </div>
            ) : (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Quando</TableHead>
                      <TableHead>Usuário</TableHead>
                      <TableHead>Ação</TableHead>
                      <TableHead>Resultado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => {
                      const isErr = r.result.toLowerCase().startsWith("erro");
                      return (
                        <TableRow key={r.id}>
                          <TableCell className="text-xs whitespace-nowrap">
                            {new Date(r.created_at).toLocaleString("pt-BR")}
                          </TableCell>
                          <TableCell className="text-xs font-mono">
                            {r.user_id ? r.user_id.slice(0, 8) : "—"}
                          </TableCell>
                          <TableCell className="text-sm">{r.action}</TableCell>
                          <TableCell>
                            <Badge variant={isErr ? "destructive" : "secondary"}>
                              {r.result}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                <div className="flex justify-center pt-4">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setLimit((l) => l + 20);
                      refetch();
                    }}
                  >
                    Ver mais
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

