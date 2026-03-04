"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const SUPERWAVE_ASCII = [
  " ███████╗██╗   ██╗██████╗ ███████╗██████╗ ██╗    ██╗ █████╗ ██╗   ██╗███████╗",
  " ██╔════╝██║   ██║██╔══██╗██╔════╝██╔══██╗██║    ██║██╔══██╗██║   ██║██╔════╝",
  " ███████╗██║   ██║██████╔╝█████╗  ██████╔╝██║ █╗ ██║███████║██║   ██║█████╗  ",
  " ╚════██║██║   ██║██╔═══╝ ██╔══╝  ██╔══██╗██║███╗██║██╔══██║╚██╗ ██╔╝██╔══╝  ",
  " ███████║╚██████╔╝██║     ███████╗██║  ██║╚███╔███╔╝██║  ██║ ╚████╔╝ ███████╗",
  " ╚══════╝ ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚═╝  ╚═╝  ╚═══╝  ╚══════╝",
];

const WAVE_ASCII = [
  "                                                                                          ░░░░",
  "                                                                                        ░░░░░░",
  "                                         ░░░░                                          ░░░░░░░",
  "                                       ░░░░░░                            ░░░░         ░░░▓▓░░░",
  "                          ░░░░        ░░░░░░░                          ░░░░░░        ░░▓▓▓▓░░░",
  "                        ░░░░░░       ░░░▓▓░░░              ░░░░       ░░░░░░░       ░░▓▓▓▓▓░░ ",
  "                       ░░░░░░░      ░░▓▓▓▓░░░            ░░░░░░      ░░░▓▓░░░     ░░▓▓▓▓▓░░  ",
  "                      ░░░▓▓░░░     ░░▓▓▓▓▓░░            ░░░░░░░     ░░▓▓▓▓░░░    ░▓▓▓▓▓▓░░   ",
  "                     ░░▓▓▓▓░░░    ░░▓▓▓▓▓░░            ░░░▓▓░░░    ░░▓▓▓▓▓░░    ░▓▓▓▓▓▓░░    ",
  "                    ░░▓▓▓▓▓░░    ░▓▓▓▓▓▓░░            ░░▓▓▓▓░░░   ░░▓▓▓▓▓░░    ▓▓▓▓▓▓░░     ",
];

export default function Home() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Login failed");
        setIsLoading(false);
        return;
      }

      localStorage.setItem("superwave_token", data.token);
      localStorage.setItem("superwave_user", JSON.stringify(data.user));
      router.push("/workspace");
    } catch {
      setError("Connection error. Please try again.");
      setIsLoading(false);
    }
  };

  return (
    <>
      <style>{`
        @keyframes wave-shimmer {
          0% { background-position: -200% center; }
          100% { background-position: 200% center; }
        }
        .ascii-banner {
          font-family: "SF Mono", "Fira Code", monospace;
          white-space: pre;
          line-height: 1.15;
          font-size: clamp(0.35rem, 1vw, 0.8rem);
          background: linear-gradient(90deg, #1e3a5f 0%, #2563eb 25%, #60a5fa 50%, #2563eb 75%, #1e3a5f 100%);
          background-size: 200% 100%;
          background-clip: text;
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          animation: wave-shimmer 2.5s ease-in-out infinite;
        }
        .login-card {
          backdrop-filter: blur(12px);
          background: rgba(255, 255, 255, 0.9);
          border: 1px solid rgba(59, 130, 246, 0.2);
          box-shadow: 0 8px 32px rgba(59, 130, 246, 0.15);
        }
        .input-field {
          background: rgba(255, 255, 255, 0.95);
          border: 1px solid rgba(59, 130, 246, 0.3);
          transition: all 0.2s ease;
        }
        .input-field:focus {
          border-color: #3b82f6;
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
          outline: none;
        }
        .login-btn {
          background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%);
          transition: all 0.2s ease;
        }
        .login-btn:hover:not(:disabled) {
          background: linear-gradient(135deg, #1d4ed8 0%, #2563eb 100%);
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
        }
        .login-btn:disabled { opacity: 0.7; cursor: not-allowed; }
      `}</style>

      <div className="relative flex flex-col items-center justify-center min-h-screen bg-stone-50 overflow-hidden px-4">
        <div
          className="absolute inset-0 hidden md:flex items-center justify-center select-none pointer-events-none text-blue-200/20"
          style={{ fontFamily: "monospace", whiteSpace: "pre", lineHeight: 1.0, fontSize: "clamp(0.6rem, 1.2vw, 1rem)" }}
        >
          {WAVE_ASCII.join("\n")}
        </div>

        <div className="relative z-10 flex flex-col items-center w-full max-w-md">
          <div className="ascii-banner select-none hidden sm:block mb-6" aria-label="SUPERWAVE">
            {SUPERWAVE_ASCII.join("\n")}
          </div>
          <h1 className="sm:hidden text-2xl font-bold text-blue-600 mb-6" style={{ fontFamily: "monospace" }}>
            SUPERWAVE
          </h1>

          <div className="login-card rounded-2xl p-8 w-full">
            <h2 className="text-lg font-semibold text-gray-800 mb-6 text-center" style={{ fontFamily: "monospace" }}>
              Sign In to Dashboard
            </h2>

            {error && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
                {error}
              </div>
            )}

            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input-field w-full px-4 py-3 rounded-lg text-gray-800"
                  placeholder="admin@superwave.ai"
                  required
                />
              </div>

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input-field w-full px-4 py-3 rounded-lg text-gray-800"
                  placeholder="••••••••"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="login-btn w-full py-3 rounded-lg text-white font-medium mt-2"
              >
                {isLoading ? "Signing in..." : "Sign In"}
              </button>
            </form>

            <p className="mt-6 text-center text-xs text-gray-500">
              Test: admin@superwave.ai / superwave123
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
