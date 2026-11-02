'use client';

import { createContext, useContext, useMemo } from 'react';

type AppUser = {
  id: string;
  email?: string | null;
  credits?: {
    remainingCredits: number | null;
  } | null;
} | null;

type AppContextValue = {
  user: AppUser;
  fetchUserCredits: () => Promise<void>;
  fetchUserInfo: () => Promise<void>;
};

const AppContext = createContext<AppContextValue>({
  user: {
    id: 'local-user',
    email: null,
    credits: {
      remainingCredits: null,
    },
  },
  fetchUserCredits: async () => {},
  fetchUserInfo: async () => {},
});

export function AppProvider({
  children,
  userId,
}: {
  children: React.ReactNode;
  userId: string;
}) {
  const value = useMemo<AppContextValue>(() => ({
    user: {
      id: userId,
      email: null,
      credits: {
        remainingCredits: null,
      },
    },
    fetchUserCredits: async () => {},
    fetchUserInfo: async () => {},
  }), [userId]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppContext() {
  return useContext(AppContext);
}
