import { NextRequest, NextResponse } from "next/server";
import { authConfigError, verifySessionToken } from "@/lib/dashboard-auth";

export async function GET(req: NextRequest) {
  const configError = authConfigError();
  if (configError) {
    return NextResponse.json({ valid: false }, { status: 503 });
  }

  const authHeader = req.headers.get("authorization");
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const user = verifySessionToken(token);
  if (!user) {
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  return NextResponse.json({
    valid: true,
    user,
  });
}
