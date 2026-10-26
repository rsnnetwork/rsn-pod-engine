// Stand-in for client/src/stores/authStore.ts in the render-loop harness: only the signed-in member, set by the harness.
import { create } from 'zustand';

interface Member { id: string; role: string; firstName: string }

export const useAuthStore = create<{ user: Member | null }>(() => ({ user: null }));
