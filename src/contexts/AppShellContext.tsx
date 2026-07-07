import { createContext } from 'react';

const AppShellContext = createContext(false);

export const AppShellProvider = ({ children }: { children: React.ReactNode }) => (
  <AppShellContext.Provider value={true}>{children}</AppShellContext.Provider>
);
