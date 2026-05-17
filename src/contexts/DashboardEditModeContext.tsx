import { createContext, useContext, useState, type ReactNode } from 'react';

interface EditModeCtx {
  isEditMode: boolean;
  toggle: () => void;
  exit: () => void;
}

const Ctx = createContext<EditModeCtx | null>(null);

export function useDashboardEditMode(): EditModeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDashboardEditMode must be used within DashboardEditModeProvider');
  return v;
}

export function DashboardEditModeProvider({ children }: { children: ReactNode }) {
  const [isEditMode, setIsEditMode] = useState(false);
  const toggle = () => setIsEditMode((v) => !v);
  const exit = () => setIsEditMode(false);
  return <Ctx.Provider value={{ isEditMode, toggle, exit }}>{children}</Ctx.Provider>;
}
