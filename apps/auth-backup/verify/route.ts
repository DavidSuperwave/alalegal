import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

const TEST_USERS = [
  { id: "usr_001", email: "admin@superwave.ai", name: "Admin User", role: "admin" },
  { id: "usr_002", email: "test@alalegal.mx", name: "ALA Legal Test", role: "user" },
  { id: "usr_003", email: "demo@superwave.ai", name: "Demo User", role: "viewer" },
];

function verifyToken(token: string): { valid: boolean; userId?: string } {
  try {
    const [dataB64, hash] = token.split(".");
    if (!dataB64 || !hash) return { valid: false };

    const data = Buffer.from(dataB64, "base64").toString();
    const payload = JSON.parse(data);

    // Check expiration
    if (payload.exp < Date.now()) {
      return { valid: false };
    }

    // Verify hash
    const expectedHash = crypto
      .createHash("sha256")
      .update(data + process.env.ADMIN_SECRET || "superwave-secret")
      .digest("hex")
      .slice(0, 16);

    if (hash !== expectedHash) {
      return { valid: false };
    }

    return { valid: true, userId: payload.userId };
  } catch {
    return { valid: false };
  }
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  const token = authHeader.slice(7);
  const result = verifyToken(token);

  if (!result.valid) {
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  const user = TEST_USERS.find((u) => u.id === result.userId);
  
  if (!user) {
    return NextResponse.json({ valid: false }, { status: 401 });
  }

  return NextResponse.json({
    valid: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  });
}
