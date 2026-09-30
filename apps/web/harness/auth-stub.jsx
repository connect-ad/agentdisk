// Harness-only stub of src/lib/auth.jsx: a signed-in person with no Firebase.
import React, { createContext, useContext, useMemo } from 'react';
const AuthContext = createContext(null);
const USER = {
  uid: 'usr_01HARNESS0000000000000000',
  email: 'rina.kessler@example.com',
  displayName: 'Rina Kessler',
  emailVerified: true,
  providerData: [{ providerId: 'password' }, { providerId: 'google.com' }],
  metadata: { creationTime: new Date(Date.now() - 86400000 * 40).toUTCString() },
};
export function describeAuthError(error) { return error?.message ?? 'Something went wrong.'; }
export function AuthProvider({ children }) {
  const value = useMemo(() => ({
    user: USER, loading: false, configured: true, providerIds: ['password', 'google.com'],
    async getToken() { return 'harness-token'; },
    async signInWithPassword() {}, async signUpWithPassword() {}, async signInWithGoogle() {},
    async signInWithGithub() {}, async sendPasswordReset() {}, async confirmPasswordReset() {},
    async sendVerification() {}, async reload() {}, async updateName() {},
    async changePassword() {}, async requestEmailChange() {}, async signOut() {},
    async signInWithEmailLink() {}, async sendEmailLink() {}, isEmailLink() { return false; },
  }), []);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth() { return useContext(AuthContext); }
