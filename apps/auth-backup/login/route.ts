import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

// Test users - in production, use a proper database
const TEST_USERS = [
  {
    id: "usr_001",
    email: "admin@superwave.ai",
    password: "superwave123",
    name: "Admin User",
    role: "admin",
  },
  {
    id: "usr_002",
    email: "test@alalegal.mx",
    password: "alalegal123",
    name: "ALA Legal Test",
    role: "user",
  },
  {
    id: "usr_003",
    email: "demo@superwave.ai",
    password: "demo123",
    name: "Demo User",
    role: "viewer",
  },
];

function generateToken(userId: string): string {
  const payload = {
    userId,
    exp: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
    iat: Date.now(),
  };
  const data = JSON.stringify(payload);
  const hash = crypto.createHash("sha256").update(data + process.env.ADMIN_SECRET || "superwave-secret").digest("hex");
  return Buffer.from(data).toString("base64") + "." + hash.slice(0, 16);
}

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400 }
      );
    }

    // Find user
    const user = TEST_USERS.find(
      (u) => u.email.toLowerCase() === email.toLowerCase() && u.password === password
    );

    if (!user) {
      return NextResponse.json(
        { error: "Invalid email or password" },
        { status: 401 }
      );
    }

    // Generate token
    const token = generateToken(user.id);

    // Return user info (without password)
    return NextResponse.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
