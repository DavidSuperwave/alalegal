"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    const token = localStorage.getItem("superwave_token");
    
    if (!token) {
      router.push("/");
      return;
    }

    fetch("/api/auth/verify", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
      .then((res) => {
        if (res.ok) {
          setIsAuthenticated(true);
        } else {
          localStorage.removeItem("superwave_token");
          localStorage.removeItem("superwave_user");
          router.push("/");
        }
      })
      .catch(() => {
        setIsAuthenticated(true);
      });
  }, [router]);

  if (isAuthenticated === null) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-stone-50" style={{ fontFamily: "monospace" }}>
        <div className="text-center">
          <div className="text-2xl mb-2">⚙️</div>
          <div className="text-stone-400">Loading...</div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}
