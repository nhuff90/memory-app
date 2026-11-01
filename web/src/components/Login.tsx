import { useState } from "react";
import { errorMessage, login } from "../api";

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(password);
      onLoggedIn();
    } catch (caught) {
      setError(errorMessage(caught));
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="w-full max-w-sm"
      >
        <img src="/icon-192.png" alt="" className="mx-auto h-16 w-16 rounded-2xl shadow-sm" />
        <h1 className="mt-4 text-center text-2xl font-semibold tracking-tight">Recall</h1>
        <p className="mt-1 text-center text-sm text-stone-500 dark:text-stone-400">Save anything. Find it later.</p>
        {/* Lets password managers and iOS Keychain remember the login. */}
        <input type="text" name="username" autoComplete="username" value="recall" readOnly hidden />
        <label htmlFor="password" className="sr-only">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
          className="mt-8 w-full rounded-2xl bg-white px-4 py-3 text-base shadow-sm ring-1 ring-stone-200 outline-none focus:ring-2 focus:ring-indigo-500 dark:bg-stone-900 dark:ring-stone-800"
        />
        {error && (
          <p className="mt-3 text-sm text-red-700 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={!password || submitting}
          className="mt-4 w-full rounded-full bg-indigo-700 py-3 text-base font-semibold text-white shadow-sm hover:bg-indigo-800 disabled:opacity-50"
        >
          {submitting ? "Unlocking…" : "Unlock"}
        </button>
      </form>
    </main>
  );
}
