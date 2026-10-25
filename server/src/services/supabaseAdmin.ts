import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig } from '../config.js';

export function createSupabaseAdmin(config: AppConfig): SupabaseClient | null {
  const { url, serviceRoleKey } = config.supabase;
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export interface AccountService {
  deleteAccount(userId: string): Promise<void>;
}

export function createAccountService(admin: SupabaseClient | null): AccountService | null {
  if (!admin) return null;
  return {
    async deleteAccount(userId: string) {
      // Remove avatar files first (storage objects are not removed by the FK cascade).
      const { data: files } = await admin.storage.from('avatars').list(userId, { limit: 100 });
      if (files?.length) {
        await admin.storage.from('avatars').remove(files.map((f) => `${userId}/${f.name}`));
      }
      // Deleting the auth user cascades to profiles, settings, conversations and messages (see migrations).
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw error;
    },
  };
}
