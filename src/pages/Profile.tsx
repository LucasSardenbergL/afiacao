import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, Phone, Mail, ChevronRight, LogOut, HelpCircle, Loader2, Wrench, Camera, Pencil, Fingerprint, Scan, Check, X, Plus, Clock } from 'lucide-react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SharpeningSuggestions } from '@/components/SharpeningSuggestions';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { useBiometricAuth } from '@/hooks/useBiometricAuth';


interface ProfileData {
  name: string;
  email: string | null;
  phone: string | null;
  customer_type: string | null;
  avatar_url: string | null;
  business_hours_open: string | null;
  business_hours_close: string | null;
}

const Profile = () => {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [addressCount, setAddressCount] = useState(0);
  const [orderCount, setOrderCount] = useState(0);
  const [toolCount, setToolCount] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editBusinessOpen, setEditBusinessOpen] = useState('');
  const [editBusinessClose, setEditBusinessClose] = useState('');
  const [saving, setSaving] = useState(false);
  
  const { isSupported: biometricSupported, isRegistered: biometricRegistered, isLoading: biometricLoading, register: registerBiometric, removeCredential: removeBiometric, checkRegistration } = useBiometricAuth();
  

  useEffect(() => {
    if (user) {
      loadProfileData();
      checkRegistration(user.id);
    }
  }, [user, checkRegistration]);

  const loadProfileData = async () => {
    if (!user) return;
    
    try {
      const { data: profileData } = await supabase
        .from('profiles')
        .select('name, email, phone, customer_type, avatar_url, business_hours_open, business_hours_close')
        .eq('user_id', user.id)
        .maybeSingle();

      if (profileData) {
        setProfile(profileData);
      } else {
        setProfile({
          name: user.email?.split('@')[0] || 'Usuário',
          email: user.email || null,
          phone: null,
          customer_type: null,
          avatar_url: null,
          business_hours_open: null,
          business_hours_close: null,
        });
      }

      const { count: addrCount } = await supabase
        .from('addresses')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id);
      
      setAddressCount(addrCount || 0);

      const { count: ordCount } = await supabase
        .from('orders')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('status', 'entregue');
      
      setOrderCount(ordCount || 0);

      const { count: tlCount } = await supabase
        .from('user_tools')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id);
      
      setToolCount(tlCount || 0);
    } catch (error) {
      console.error('Error loading profile:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAvatarClick = () => {
    fileInputRef.current?.click();
  };

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    if (!file.type.startsWith('image/')) {
      toast({
        title: 'Arquivo inválido',
        description: 'Por favor, selecione uma imagem',
        variant: 'destructive',
      });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: 'Arquivo muito grande',
        description: 'A imagem deve ter no máximo 5MB',
        variant: 'destructive',
      });
      return;
    }

    setUploading(true);

    try {
      const fileExt = file.name.split('.').pop();
      const fileName = `${user.id}/avatar.${fileExt}`;

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(fileName, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data: { publicUrl } } = supabase.storage
        .from('avatars')
        .getPublicUrl(fileName);

      const { error: updateError } = await supabase
        .from('profiles')
        .update({ avatar_url: publicUrl })
        .eq('user_id', user.id);

      if (updateError) throw updateError;

      setProfile(prev => prev ? { ...prev, avatar_url: publicUrl } : null);

      toast({
        title: 'Foto atualizada!',
        description: 'Sua foto de perfil foi alterada com sucesso',
      });
    } catch (error) {
      console.error('Error uploading avatar:', error);
      toast({
        title: 'Erro ao enviar foto',
        description: 'Tente novamente mais tarde',
        variant: 'destructive',
      });
    } finally {
      setUploading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut();
      toast({
        title: 'Até logo!',
        description: 'Você saiu da sua conta',
      });
    } catch (error) {
      toast({
        title: 'Erro ao sair',
        description: 'Tente novamente',
        variant: 'destructive',
      });
    }
  };

  const handleEditClick = () => {
    setEditName(profile?.name || '');
    setEditPhone(profile?.phone || '');
    setEditBusinessOpen(profile?.business_hours_open || '');
    setEditBusinessClose(profile?.business_hours_close || '');
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
  };

  const handleSaveProfile = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from('profiles')
        .update({
          name: editName,
          phone: editPhone || null,
          business_hours_open: editBusinessOpen || null,
          business_hours_close: editBusinessClose || null,
        })
        .eq('user_id', user.id);

      if (error) throw error;

      setProfile(prev => prev ? {
        ...prev,
        name: editName,
        phone: editPhone || null,
        business_hours_open: editBusinessOpen || null,
        business_hours_close: editBusinessClose || null,
      } : null);

      setIsEditing(false);
      toast({
        title: 'Perfil atualizado!',
        description: 'Suas informações foram salvas com sucesso',
      });
    } catch (error) {
      console.error('Error saving profile:', error);
      toast({
        title: 'Erro ao salvar',
        description: 'Tente novamente mais tarde',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const menuItems = [
    { icon: Wrench, label: 'Minhas Ferramentas', count: toolCount, path: '/tools' },
    { icon: MapPin, label: 'Meus Endereços', count: addressCount, path: '/addresses' },
    { icon: HelpCircle, label: 'Ajuda e FAQ', path: '/support' },
  ];

  if (loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Meu Perfil" showBack showNotifications />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Meu Perfil" showBack showNotifications />

      <main className="pt-16 px-4 max-w-lg mx-auto">
        {/* Profile card */}
        <div className="bg-card rounded-xl p-6 shadow-soft border border-border mb-6">
          <div className="flex items-center gap-4 mb-4">
            {/* Avatar with upload */}
            <div className="relative">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={handleAvatarUpload}
                className="hidden"
              />
              <button
                onClick={handleAvatarClick}
                disabled={uploading}
                className={cn(
                  'w-16 h-16 rounded-full overflow-hidden flex items-center justify-center transition-all',
                  uploading ? 'opacity-50' : 'hover:opacity-90',
                  profile?.avatar_url ? '' : 'bg-gradient-primary'
                )}
              >
                {uploading ? (
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                ) : profile?.avatar_url ? (
                  <img 
                    src={profile.avatar_url} 
                    alt="Avatar" 
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-2xl font-bold text-primary-foreground">
                    {profile?.name?.charAt(0).toUpperCase() || 'U'}
                  </span>
                )}
              </button>
              <div className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-primary flex items-center justify-center shadow-md">
                <Camera className="w-3 h-3 text-primary-foreground" />
              </div>
            </div>

            <div className="flex-1">
              <h2 className="font-display font-bold text-lg">{profile?.name || 'Usuário'}</h2>
              <div className="flex items-center gap-2">
                <p className="text-sm text-muted-foreground">
                  Cliente desde {new Date(user?.created_at || Date.now()).toLocaleDateString('pt-BR', { month: 'short', year: 'numeric' })}
                </p>
              </div>
              {profile?.customer_type && (
                <span className="inline-flex items-center text-xs px-2 py-0.5 rounded-full mt-1 bg-amber-100 text-amber-800">
                  Industrial
                </span>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={handleEditClick}>
              <Pencil className="w-3 h-3 mr-1" />
              Editar
            </Button>
          </div>

          {isEditing ? (
            <div className="space-y-3 border-t border-border pt-4">
              <div>
                <Label htmlFor="editName">Nome</Label>
                <Input id="editName" value={editName} onChange={e => setEditName(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="editPhone">Telefone</Label>
                <Input id="editPhone" value={editPhone} onChange={e => setEditPhone(e.target.value)} placeholder="(11) 99999-9999" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="editOpen">Horário Abertura</Label>
                  <Input id="editOpen" type="time" value={editBusinessOpen} onChange={e => setEditBusinessOpen(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="editClose">Horário Fechamento</Label>
                  <Input id="editClose" type="time" value={editBusinessClose} onChange={e => setEditBusinessClose(e.target.value)} />
                </div>
              </div>
              <div className="flex gap-2 pt-2">
                <Button onClick={handleSaveProfile} disabled={saving} className="flex-1">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Check className="w-4 h-4 mr-1" />}
                  Salvar
                </Button>
                <Button variant="outline" onClick={handleCancelEdit} disabled={saving}>
                  <X className="w-4 h-4 mr-1" />
                  Cancelar
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-2 text-sm">
                {profile?.phone && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Phone className="w-4 h-4" />
                    <span>{profile.phone}</span>
                  </div>
                )}
                {profile?.email && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Mail className="w-4 h-4" />
                    <span>{profile.email}</span>
                  </div>
                )}
                {(profile?.business_hours_open || profile?.business_hours_close) && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Clock className="w-4 h-4" />
                    <span>{profile.business_hours_open || '--:--'} às {profile.business_hours_close || '--:--'}</span>
                  </div>
                )}
              </div>

              {/* Stats */}
              <div className="flex gap-4 mt-4 pt-4 border-t border-border">
                <div className="flex-1 text-center">
                  <p className="text-2xl font-bold text-primary">{orderCount}</p>
                  <p className="text-xs text-muted-foreground">Pedidos</p>
                </div>
                <div className="flex-1 text-center border-l border-border">
                  <p className="text-2xl font-bold text-foreground">{toolCount}</p>
                  <p className="text-xs text-muted-foreground">Ferramentas</p>
                </div>
                <div className="flex-1 text-center border-l border-border">
                  <p className="text-2xl font-bold text-foreground">{addressCount}</p>
                  <p className="text-xs text-muted-foreground">Endereços</p>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="mb-6">
          <h3 className="font-display font-bold text-lg mb-3">Agenda de Afiação</h3>
          <SharpeningSuggestions />
          <Button 
            variant="outline" 
            className="w-full mt-3"
            onClick={() => navigate('/tools')}
          >
            <Plus className="w-4 h-4 mr-2" />
            Adicionar Ferramenta
          </Button>
        </div>
        {/* Biometric Settings - hidden for now */}

        {/* Menu items */}
        <div className="bg-card rounded-xl shadow-soft border border-border overflow-hidden mb-6">
          {menuItems.map((item) => (
            <button
              key={item.label}
              onClick={() => item.path && navigate(item.path)}
              className="w-full flex items-center gap-3 p-4 hover:bg-muted/50 transition-colors border-b border-border last:border-b-0"
            >
              <item.icon className="w-5 h-5 text-muted-foreground" />
              <span className="flex-1 text-left font-medium">{item.label}</span>
              {item.count !== undefined && item.count > 0 && (
                <span className="text-sm text-muted-foreground">{item.count}</span>
              )}
              <ChevronRight className="w-5 h-5 text-muted-foreground" />
            </button>
          ))}
        </div>

        {/* Logout */}
        <Button 
          variant="outline" 
          className="w-full text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={handleLogout}
        >
          <LogOut className="w-4 h-4 mr-2" />
          Sair da conta
        </Button>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Versão 1.0.0
        </p>
      </main>

      <BottomNav />
    </div>
  );
};

export default Profile;
