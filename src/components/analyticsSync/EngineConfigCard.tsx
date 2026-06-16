// Card de parâmetros editáveis do motor de recomendação.
// Extraído verbatim de src/pages/AdminAnalyticsSync.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Save, Settings } from "lucide-react";
import { type RecConfigs } from "./useAnalyticsSync";

interface EngineConfigCardProps {
  isLoading: boolean;
  recConfigs: RecConfigs;
  editingConfig: Record<string, string>;
  setEditingConfig: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onSave: (id: string) => void;
}

export function EngineConfigCard({
  isLoading,
  recConfigs,
  editingConfig,
  setEditingConfig,
  onSave,
}: EngineConfigCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Settings className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-base">Parâmetros do Motor</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {(recConfigs || []).map((config) => {
              const isEditing = editingConfig[config.id] !== undefined;
              return (
                <div key={config.id} className="p-3 rounded border text-sm space-y-2">
                  <div className="font-mono font-medium text-xs">{config.key}</div>
                  <div className="text-xs text-muted-foreground">{config.description}</div>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      step="0.01"
                      className="h-8 text-sm font-semibold"
                      value={isEditing ? editingConfig[config.id] : config.value}
                      onChange={(e) => setEditingConfig(prev => ({ ...prev, [config.id]: e.target.value }))}
                    />
                    {isEditing && (
                      <Button size="sm" className="h-8 w-8 p-0" onClick={() => onSave(config.id)}>
                        <Save className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
