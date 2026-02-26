"use client";
import { FormEvent, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function Login() {
  const [email, setEmail] = useState("");

  async function handle(e: FormEvent) {
    e.preventDefault();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}/dashboard` }
    });
    alert(error ? error.message : "Check ta boîte mail !");
  }

  return (
    <main className="min-h-screen grid place-items-center px-4">
      <form onSubmit={handle} className="w-full max-w-sm space-y-4 p-6 rounded-2xl bg-white/5 backdrop-blur border border-white/10 shadow-xl">
        <h1 className="text-xl font-bold text-center">Flashcards SRS</h1>
        <input
          type="email"
          required
          placeholder="ton@email.com"
          value={email}
          onChange={e=>setEmail(e.target.value)}
          className="w-full rounded-lg bg-white/10 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-sky-400"
        />
        <button className="w-full py-3 rounded-lg bg-sky-500 hover:bg-sky-600 font-semibold">Recevoir le lien</button>
      </form>
    </main>
  );
}