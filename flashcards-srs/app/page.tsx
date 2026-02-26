"use client";
import { FormEvent, useEffect, useState } from "react";

const AUTH_STORAGE_KEY = "flashcards_pin_ok";
const ACCESS_CODE = process.env.NEXT_PUBLIC_ACCESS_CODE ?? "260809";

export default function Login() {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (localStorage.getItem(AUTH_STORAGE_KEY) === "1") {
      location.href = "/dashboard";
    }
  }, []);

  function handle(e: FormEvent) {
    e.preventDefault();

    if (code !== ACCESS_CODE) {
      setError("Code incorrect");
      return;
    }

    localStorage.setItem(AUTH_STORAGE_KEY, "1");
    location.href = "/dashboard";
  }

  return (
    <main className="min-h-screen grid place-items-center px-4">
      <form
        onSubmit={handle}
        className="w-full max-w-sm space-y-4 p-6 rounded-2xl bg-white/5 backdrop-blur border border-white/10 shadow-xl"
      >
        <h1 className="text-xl font-bold text-center">Flashcards SRS</h1>
        <p className="text-sm text-slate-300 text-center">Entre ton code a 6 chiffres</p>
        <input
          type="password"
          required
          inputMode="numeric"
          maxLength={6}
          placeholder="260809"
          value={code}
          onChange={(e) => {
            setError("");
            setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
          }}
          className="w-full rounded-lg bg-white/10 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-sky-400"
        />
        {error && <p className="text-sm text-rose-300 text-center">{error}</p>}
        <button className="w-full py-3 rounded-lg bg-sky-500 hover:bg-sky-600 font-semibold">Entrer</button>
      </form>
    </main>
  );
}
