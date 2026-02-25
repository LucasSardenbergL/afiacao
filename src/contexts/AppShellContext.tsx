import { createContext, useContext } from 'react';

const AppShellContext = createContext(false);

export const AppShellProvider = ({ children }: { children: React.ReactNode }) => (
  <AppShellContext.Provider value={true}>{children}</AppShellContext.Provider>
);

export const useInsideAppShell = () => useContext(AppShellContext);
