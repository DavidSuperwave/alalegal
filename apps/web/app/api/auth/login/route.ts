import { NextRequest, NextResponse } from "next/server";
import { authConfigError, authenticateDashboardUser, issueSessionToken } from "@/lib/dashboard-auth";

export async function POST(req: NextRequest) {
  try {
    const configError = authConfigError();
    if (configError) {
      return NextResponse.json(
        {
          error:
            "Dashboard authentication is not configured. Set DASHBOARD_AUTH_SECRET and dashboard user credentials in environment variables.",
        },
        { status: 503 }
      );
    }

    const { email, password } = await req.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400 }
      );
    }

    const user = authenticateDashboardUser(email, password);

    if (!user) {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

    const token = issueSessionToken(user);
    if (!token) {
      return NextResponse.json(
        { error: "Authentication is not configured correctly" },
        { status: 503 }
      );
    }

    return NextResponse.json({
      token,
      user,
    });
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
