import crypto from "crypto";

type DashboardRole = "admin" | "user" | "viewer";

type DashboardUserConfig = {
  id?: string;
  email: string;
  name?: string;
  role?: DashboardRole;
  password?: string;
  passwordHash?: string;
};

type StoredDashboardUser = {
  id: string;
  email: string;
  name: string;
  role: DashboardRole;
  passwordHash: string;
};

export type DashboardUserPublic = {
  id: string;
  email: string;
  name: string;
  role: DashboardRole;
};

type SessionPayload = {
  sub: string;
  email: string;
  name: string;
  role: DashboardRole;
  iat: number;
  exp: number;
};

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function parseUsersJson(raw: string): DashboardUserConfig[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("DASHBOARD_USERS_JSON must be a JSON array");
  }
  return parsed as DashboardUserConfig[];
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeEqualHex(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left, "hex");
  const rightBuf = Buffer.from(right, "hex");
  if (leftBuf.length !== rightBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuf, rightBuf);
}

function normalizeUsers(users: DashboardUserConfig[]): StoredDashboardUser[] {
  return users
    .filter((user) => typeof user.email === "string" && user.email.trim() !== "")
    .map((user, index) => {
      const normalizedEmail = user.email.trim().toLowerCase();
      const hashed =
        typeof user.passwordHash === "string" && user.passwordHash.trim() !== ""
          ? user.passwordHash.trim().toLowerCase()
          : typeof user.password === "string"
            ? sha256Hex(user.password)
            : "";

      return {
        id: user.id?.trim() || `usr_${String(index + 1).padStart(3, "0")}`,
        email: normalizedEmail,
        name: user.name?.trim() || normalizedEmail,
        role: user.role || "admin",
        passwordHash: hashed,
      };
    })
    .filter((user) => user.passwordHash !== "");
}

function configuredUsers(): StoredDashboardUser[] {
  const usersJson = process.env.DASHBOARD_USERS_JSON;
  if (usersJson && usersJson.trim() !== "") {
    try {
      return normalizeUsers(parseUsersJson(usersJson));
    } catch {
      return [];
    }
  }

  const email = process.env.DASHBOARD_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.DASHBOARD_ADMIN_PASSWORD;
  const passwordHash = process.env.DASHBOARD_ADMIN_PASSWORD_HASH?.trim().toLowerCase();

  if (!email) {
    return [];
  }

  const hashed = passwordHash && passwordHash !== "" ? passwordHash : password ? sha256Hex(password) : "";
  if (!hashed) {
    return [];
  }

  return [
    {
      id: "usr_admin",
      email,
      name: process.env.DASHBOARD_ADMIN_NAME?.trim() || "Admin",
      role: "admin",
      passwordHash: hashed,
    },
  ];
}

function authSecret(): string | null {
  const secret = process.env.DASHBOARD_AUTH_SECRET || process.env.ADMIN_SECRET;
  if (!secret || secret.trim() === "") {
    return null;
  }
  return secret;
}

function publicUser(user: StoredDashboardUser): DashboardUserPublic {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}

export function authConfigError(): string | null {
  if (!authSecret()) {
    return "Missing DASHBOARD_AUTH_SECRET";
  }
  if (configuredUsers().length === 0) {
    return "No dashboard users configured (set DASHBOARD_USERS_JSON or DASHBOARD_ADMIN_EMAIL + password)";
  }
  return null;
}

export function authenticateDashboardUser(email: string, password: string): DashboardUserPublic | null {
  const users = configuredUsers();
  const normalizedEmail = email.trim().toLowerCase();
  const user = users.find((candidate) => candidate.email === normalizedEmail);
  if (!user) {
    return null;
  }

  const providedHash = sha256Hex(password);
  if (!safeEqualHex(providedHash, user.passwordHash)) {
    return null;
  }

  return publicUser(user);
}

export function issueSessionToken(user: DashboardUserPublic): string | null {
  const secret = authSecret();
  if (!secret) {
    return null;
  }

  const now = Date.now();
  const payload: SessionPayload = {
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    iat: now,
    exp: now + TOKEN_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifySessionToken(token: string): DashboardUserPublic | null {
  const secret = authSecret();
  if (!secret) {
    return null;
  }

  const [encoded, providedSignature] = token.split(".");
  if (!encoded || !providedSignature) {
    return null;
  }

  const expectedSignature = crypto.createHmac("sha256", secret).update(encoded).digest("base64url");
  const sigOk =
    providedSignature.length === expectedSignature.length &&
    crypto.timingSafeEqual(Buffer.from(providedSignature), Buffer.from(expectedSignature));
  if (!sigOk) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString()) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp <= Date.now()) {
      return null;
    }

    const users = configuredUsers();
    const user = users.find((candidate) => candidate.id === payload.sub && candidate.email === payload.email);
    if (!user) {
      return null;
    }

    return publicUser(user);
  } catch {
    return null;
  }
}
