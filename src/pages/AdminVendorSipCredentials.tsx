import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { Trash2, Plus, Loader2 } from 'lucide-react';

interface VendorSipCred {
  id: string;
  user_id: string;
  sip_user: string;
  sip_pass: string;
  sip_caller_id: string | null;
  notes: string | null;
}

interface ProfileLite {
  user_id: string;
  name: string | null;
  email: string | null;
}

export default function AdminVendorSipCredentials() {
  const { isMaster } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creds, setCreds] = useState<VendorSipCred[]>([]);
  const [profiles, setProfiles] = useState<ProfileLite[]>([]);

  // Form state pra adicionar nova
  const [newUserId, setNewUserId] = useState('');
  const [newSipUser, setNewSipUser] = useState('');
  const [newSipPass, setNewSipPass] = useState('');
  const [newCallerId, setNewCallerId] = useState('');
  const [newNotes, setNewNotes] = useState('');

  useEffect(() => {
    if (!isMaster) return;
    (async () => {
      try {
        const [credsRes, profilesRes] = await Promise.all([
          supabase.from('vendor_sip_credentials').select('*'),
          supabase.from('profiles').select('user_id, name, email'),
        ]);
        if (credsRes.error) throw credsRes.error;
        if (profilesRes.error) throw profilesRes.error;
        setCreds((credsRes.data ?? []) as VendorSipCred[]);
        setProfiles((profilesRes.data ?? []) as ProfileLite[]);
      } catch (err) {
        toast.error('Erro ao carregar', {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setLoading(false);
      }
    })();
  }, [isMaster]);

  if (!isMaster) {
    return (
      <div className="p-8">
        <p className="text-status-error">
          Acesso restrito. Apenas usuários com role <code>master</code> podem gerenciar credenciais SIP.
        </p>
      </div>
    );
  }

  async function handleAdd() {
    if (!newUserId || !newSipUser || !newSipPass) {
      toast.error('Campos obrigatórios', {
        description: 'Usuário, SIP user e SIP pass são obrigatórios.',
      });
      return;
    }
    setSaving(true);
    try {
      const { data, error } = await supabase
        .from('vendor_sip_credentials')
        .insert({
          user_id: newUserId,
          sip_user: newSipUser,
          sip_pass: newSipPass,
          sip_caller_id: newCallerId || null,
          notes: newNotes || null,
        })
        .select()
        .single();
      if (error) throw error;
      setCreds((prev) => [...prev, data as VendorSipCred]);
      setNewUserId('');
      setNewSipUser('');
      setNewSipPass('');
      setNewCallerId('');
      setNewNotes('');
      toast.success('Credencial adicionada');
    } catch (err) {
      toast.error('Erro ao adicionar', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Remover essa credencial SIP? O vendedor cairá no fallback (env vars).')) return;
    try {
      const { error } = await supabase.from('vendor_sip_credentials').delete().eq('id', id);
      if (error) throw error;
      setCreds((prev) => prev.filter((c) => c.id !== id));
      toast.success('Removido');
    } catch (err) {
      toast.error('Erro ao remover', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const profileMap = new Map(profiles.map((p) => [p.user_id, p]));
  const availableProfiles = profiles.filter((p) => !creds.find((c) => c.user_id === p.user_id));

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <header>
        <h1 className="text-2xl font-display font-medium">Credenciais SIP por vendedor</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Atribua um ramal SIP individual pra cada vendedor. Sem atribuição, o vendedor usa o
          ramal compartilhado (env vars NVOIP_SIP_USER / NVOIP_SIP_PASS).
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Adicionar atribuição</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Usuário</label>
              <select
                value={newUserId}
                onChange={(e) => setNewUserId(e.target.value)}
                className="w-full mt-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="">Selecione…</option>
                {availableProfiles.map((p) => (
                  <option key={p.user_id} value={p.user_id}>
                    {p.name || p.email || p.user_id}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">SIP User (ramal)</label>
              <Input
                value={newSipUser}
                onChange={(e) => setNewSipUser(e.target.value)}
                placeholder="ex: 137973001"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">SIP Password</label>
              <Input
                type="password"
                value={newSipPass}
                onChange={(e) => setNewSipPass(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Caller ID (opcional)</label>
              <Input
                value={newCallerId}
                onChange={(e) => setNewCallerId(e.target.value)}
                placeholder="ex: 553735143571"
              />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground">Notas (opcional)</label>
              <Input value={newNotes} onChange={(e) => setNewNotes(e.target.value)} />
            </div>
          </div>
          <Button onClick={handleAdd} disabled={saving} className="gap-1">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Adicionar
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Atribuições atuais ({creds.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : creds.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nenhuma atribuição. Todos usam o fallback de env vars.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b">
                <tr>
                  <th className="text-left pb-2">Usuário</th>
                  <th className="text-left pb-2">SIP User</th>
                  <th className="text-left pb-2">Caller ID</th>
                  <th className="text-left pb-2">Notas</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {creds.map((c) => {
                  const profile = profileMap.get(c.user_id);
                  return (
                    <tr key={c.id} className="border-b last:border-0">
                      <td className="py-2">
                        <div className="font-medium">{profile?.name ?? '(sem nome)'}</div>
                        <div className="text-xs text-muted-foreground">
                          {profile?.email ?? c.user_id}
                        </div>
                      </td>
                      <td className="py-2 font-mono text-xs">{c.sip_user}</td>
                      <td className="py-2 font-mono text-xs">{c.sip_caller_id ?? '—'}</td>
                      <td className="py-2 text-xs text-muted-foreground">{c.notes ?? '—'}</td>
                      <td className="py-2 text-right">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleDelete(c.id)}
                          title="Remover"
                        >
                          <Trash2 className="w-4 h-4 text-status-error" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
