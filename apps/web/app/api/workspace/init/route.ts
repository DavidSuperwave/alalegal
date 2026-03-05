import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { resolveOpenClawStateDir, setUIActiveProfile, getEffectiveProfile, resolveWorkspaceRoot, registerWorkspacePath } from "@/lib/workspace";
import { duckdbExecOnFile, resolveDuckdbBin } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Bootstrap file names (must match src/agents/workspace.ts)
// ---------------------------------------------------------------------------

const BOOTSTRAP_FILENAMES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
] as const;

// Minimal fallback content used when templates can't be loaded from disk
const FALLBACK_CONTENT: Record<string, string> = {
  "AGENTS.md": "# AGENTS.md - Your Workspace\n\nThis folder is home. Treat it that way.\n",
  "SOUL.md": "# SOUL.md - Who You Are\n\nDescribe the personality and behavior of your agent here.\n",
  "TOOLS.md": "# TOOLS.md - Local Notes\n\nSkills define how tools work. This file is for your specifics.\n",
  "IDENTITY.md": "# IDENTITY.md - Who Am I?\n\nFill this in during your first conversation.\n",
  "USER.md": "# USER.md - About Your Human\n\nDescribe yourself and how you'd like the agent to interact with you.\n",
  "HEARTBEAT.md": "# HEARTBEAT.md\n\n# Keep this file empty (or with only comments) to skip heartbeat API calls.\n",
  "BOOTSTRAP.md": "# BOOTSTRAP.md - Hello, World\n\nYou just woke up. Time to figure out who you are.\n",
};

// ---------------------------------------------------------------------------
// CRM seed objects (mirrors src/agents/workspace-seed.ts)
// ---------------------------------------------------------------------------

type SeedField = {
  name: string;
  type: string;
  required?: boolean;
  enumValues?: string[];
};

type SeedObject = {
  id: string;
  name: string;
  description: string;
  icon: string;
  defaultView: string;
  entryCount: number;
  fields: SeedField[];
};

const SEED_OBJECTS: SeedObject[] = [
  {
    id: "seed_obj_lead_00000000000000",
    name: "lead",
    description: "ALA Legal intake pipeline",
    icon: "briefcase",
    defaultView: "kanban",
    entryCount: 0,
    fields: [
      { name: "Full Name", type: "text", required: true },
      { name: "Phone Number", type: "phone" },
      { name: "Email Address", type: "email" },
      { name: "Status", type: "enum", enumValues: ["New Lead", "Contacted", "Qualified", "Proposal Sent", "Won", "Lost"] },
      { name: "Source", type: "enum", enumValues: ["manychat", "instagram", "whatsapp", "messenger", "manual"] },
      { name: "Assigned To", type: "text" },
      { name: "Pillar", type: "enum", enumValues: ["fallecimientos", "lesiones", "aseguradoras", "litigios"] },
      { name: "Notes", type: "richtext" },
    ],
  },
  {
    id: "seed_obj_people_00000000000000",
    name: "people",
    description: "Contact management",
    icon: "users",
    defaultView: "table",
    entryCount: 5,
    fields: [
      { name: "Full Name", type: "text", required: true },
      { name: "Email Address", type: "email", required: true },
      { name: "Phone Number", type: "phone" },
      { name: "Company", type: "text" },
      { name: "Status", type: "enum", enumValues: ["Active", "Inactive", "Lead"] },
      { name: "Notes", type: "richtext" },
    ],
  },
  {
    id: "seed_obj_company_0000000000000",
    name: "company",
    description: "Company tracking",
    icon: "building-2",
    defaultView: "table",
    entryCount: 3,
    fields: [
      { name: "Company Name", type: "text", required: true },
      {
        name: "Industry",
        type: "enum",
        enumValues: ["Technology", "Finance", "Healthcare", "Education", "Retail", "Other"],
      },
      { name: "Website", type: "text" },
      { name: "Type", type: "enum", enumValues: ["Client", "Partner", "Vendor", "Prospect"] },
      { name: "Notes", type: "richtext" },
    ],
  },
  {
    id: "seed_obj_task_000000000000000",
    name: "task",
    description: "Task tracking board",
    icon: "check-square",
    defaultView: "kanban",
    entryCount: 5,
    fields: [
      { name: "Title", type: "text", required: true },
      { name: "Description", type: "text" },
      { name: "Status", type: "enum", enumValues: ["In Queue", "In Progress", "Done"] },
      { name: "Priority", type: "enum", enumValues: ["Low", "Medium", "High"] },
      { name: "Due Date", type: "date" },
      { name: "Notes", type: "richtext" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripFrontMatter(content: string): string {
  if (!content.startsWith("---")) {return content;}
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {return content;}
  return content.slice(endIndex + "\n---".length).replace(/^\s+/, "");
}

/** Try multiple candidate paths to find the monorepo root. */
function resolveProjectRoot(): string | null {
  const marker = join("docs", "reference", "templates", "AGENTS.md");
  const cwd = process.cwd();

  // CWD is the repo root (standalone builds)
  if (existsSync(join(cwd, marker))) {return cwd;}

  // CWD is apps/web/ (dev mode)
  const fromApps = resolve(cwd, "..", "..");
  if (existsSync(join(fromApps, marker))) {return fromApps;}

  return null;
}

function loadTemplateContent(filename: string, projectRoot: string | null): string {
  if (projectRoot) {
    const templatePath = join(projectRoot, "docs", "reference", "templates", filename);
    try {
      const raw = readFileSync(templatePath, "utf-8");
      return stripFrontMatter(raw);
    } catch {
      // fall through to fallback
    }
  }
  return FALLBACK_CONTENT[filename] ?? "";
}

function generateObjectYaml(obj: SeedObject): string {
  const lines: string[] = [
    `id: "${obj.id}"`,
    `name: "${obj.name}"`,
    `description: "${obj.description}"`,
    `icon: "${obj.icon}"`,
    `default_view: "${obj.defaultView}"`,
    `entry_count: ${obj.entryCount}`,
    "fields:",
  ];

  for (const field of obj.fields) {
    lines.push(`  - name: "${field.name}"`);
    lines.push(`    type: ${field.type}`);
    if (field.required) {lines.push("    required: true");}
    if (field.enumValues) {lines.push(`    values: ${JSON.stringify(field.enumValues)}`);}
  }

  return lines.join("\n") + "\n";
}

function generateWorkspaceMd(objects: SeedObject[]): string {
  const lines: string[] = ["# Workspace Schema", "", "Auto-generated summary of the workspace database.", ""];
  for (const obj of objects) {
    lines.push(`## ${obj.name}`, "");
    lines.push(`- **Description**: ${obj.description}`);
    lines.push(`- **View**: \`${obj.defaultView}\``);
    lines.push(`- **Entries**: ${obj.entryCount}`);
    lines.push("- **Fields**:");
    for (const field of obj.fields) {
      const req = field.required ? " (required)" : "";
      const vals = field.enumValues ? ` — ${field.enumValues.join(", ")}` : "";
      lines.push(`  - ${field.name} (\`${field.type}\`)${req}${vals}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function writeIfMissing(filePath: string, content: string): boolean {
  if (existsSync(filePath)) {return false;}
  try {
    writeFileSync(filePath, content, { encoding: "utf-8", flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function seedFieldId(objectName: string, fieldName: string): string {
  const compact = `${objectName}_${fieldName}`.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 26);
  return `seed_fld_${compact}`;
}

function buildSeedSchemaSql(): string {
  const statements: string[] = [
    "CREATE TABLE IF NOT EXISTS objects (id VARCHAR PRIMARY KEY, name VARCHAR NOT NULL UNIQUE, description VARCHAR, icon VARCHAR, default_view VARCHAR DEFAULT 'table', display_field VARCHAR, immutable BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT now(), updated_at TIMESTAMP DEFAULT now())",
    "CREATE TABLE IF NOT EXISTS fields (id VARCHAR PRIMARY KEY, object_id VARCHAR NOT NULL, name VARCHAR NOT NULL, description VARCHAR, type VARCHAR NOT NULL, required BOOLEAN DEFAULT false, default_value VARCHAR, related_object_id VARCHAR, relationship_type VARCHAR, enum_values JSON, enum_colors JSON, enum_multiple BOOLEAN DEFAULT false, sort_order INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT now(), updated_at TIMESTAMP DEFAULT now(), UNIQUE(object_id, name))",
    "CREATE TABLE IF NOT EXISTS entries (id VARCHAR PRIMARY KEY, object_id VARCHAR NOT NULL, sort_order INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT now(), updated_at TIMESTAMP DEFAULT now())",
    "CREATE TABLE IF NOT EXISTS entry_fields (id VARCHAR PRIMARY KEY, entry_id VARCHAR NOT NULL, field_id VARCHAR NOT NULL, value VARCHAR, created_at TIMESTAMP DEFAULT now(), updated_at TIMESTAMP DEFAULT now(), UNIQUE(entry_id, field_id))",
    "CREATE TABLE IF NOT EXISTS statuses (id VARCHAR PRIMARY KEY, object_id VARCHAR NOT NULL, name VARCHAR NOT NULL, color VARCHAR DEFAULT '#94a3b8', sort_order INTEGER DEFAULT 0, is_default BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT now(), updated_at TIMESTAMP DEFAULT now(), UNIQUE(object_id, name))",
  ];

  for (const obj of SEED_OBJECTS) {
    const displayField = obj.fields.find((f) => /\bname\b/i.test(f.name) || /\btitle\b/i.test(f.name))?.name || obj.fields[0]?.name || "id";
    statements.push(
      `INSERT INTO objects (id, name, description, icon, default_view, display_field, immutable) VALUES ('${sqlEscape(obj.id)}', '${sqlEscape(obj.name)}', '${sqlEscape(obj.description)}', '${sqlEscape(obj.icon)}', '${sqlEscape(obj.defaultView)}', '${sqlEscape(displayField)}', false) ON CONFLICT(name) DO NOTHING`
    );

    obj.fields.forEach((field, index) => {
      const fieldId = seedFieldId(obj.name, field.name);
      const enumValues = field.enumValues ? `'${sqlEscape(JSON.stringify(field.enumValues))}'::JSON` : "NULL";
      statements.push(
        `INSERT INTO fields (id, object_id, name, type, required, enum_values, sort_order) VALUES ('${sqlEscape(fieldId)}', '${sqlEscape(obj.id)}', '${sqlEscape(field.name)}', '${sqlEscape(field.type)}', ${field.required ? "true" : "false"}, ${enumValues}, ${index}) ON CONFLICT(object_id, name) DO NOTHING`
      );
    });

    const statusField = obj.fields.find((f) => f.name === "Status" && Array.isArray(f.enumValues));
    if (statusField?.enumValues) {
      statusField.enumValues.forEach((status, index) => {
        statements.push(
          `INSERT INTO statuses (id, object_id, name, sort_order, is_default) VALUES ('${sqlEscape(`seed_status_${obj.name}_${index}`)}', '${sqlEscape(obj.id)}', '${sqlEscape(status)}', ${index}, ${index === 0 ? "true" : "false"}) ON CONFLICT(object_id, name) DO NOTHING`
        );
      });
    }
  }

  return statements.join(";\n") + ";\n";
}

function seedDuckDB(workspaceDir: string, projectRoot: string | null): boolean {
  const destPath = join(workspaceDir, "workspace.duckdb");
  const dbAlreadyExists = existsSync(destPath);

  let seeded = false;
  if (!dbAlreadyExists && projectRoot) {
    const seedDb = join(projectRoot, "assets", "seed", "workspace.duckdb");
    if (existsSync(seedDb)) {
      try {
        copyFileSync(seedDb, destPath);
        seeded = true;
      } catch {
        seeded = false;
      }
    }
  }

  if (!dbAlreadyExists && !seeded) {
    // Fallback for production images where the prebuilt seed DB is unavailable.
    if (!resolveDuckdbBin()) {return false;}
    seeded = duckdbExecOnFile(destPath, buildSeedSchemaSql());
  }

  if (!existsSync(destPath)) {
    return false;
  }

  // Always upsert seed objects/fields/statuses so existing workspaces pick up
  // newer native objects (e.g. "lead") without manual SQL.
  if (resolveDuckdbBin() && !duckdbExecOnFile(destPath, buildSeedSchemaSql())) {
    return false;
  }

  // Create filesystem projections for CRM objects
  for (const obj of SEED_OBJECTS) {
    const objDir = join(workspaceDir, obj.name);
    mkdirSync(objDir, { recursive: true });
    writeIfMissing(join(objDir, ".object.yaml"), generateObjectYaml(obj));
  }

  writeIfMissing(join(workspaceDir, "WORKSPACE.md"), generateWorkspaceMd(SEED_OBJECTS));

  return true;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  const body = (await req.json()) as {
    profile?: string;
    path?: string;
    seedBootstrap?: boolean;
  };

  const profileName = body.profile?.trim() || null;

  if (profileName && profileName !== "default" && !/^[a-zA-Z0-9_-]+$/.test(profileName)) {
    return Response.json(
      { error: "Invalid profile name. Use letters, numbers, hyphens, or underscores." },
      { status: 400 },
    );
  }

  // Determine workspace directory
  let workspaceDir: string;
  if (body.path?.trim()) {
    workspaceDir = body.path.trim();
    if (workspaceDir.startsWith("~")) {
      workspaceDir = join(homedir(), workspaceDir.slice(1));
    }
    workspaceDir = resolve(workspaceDir);
  } else {
    const stateDir = resolveOpenClawStateDir();
    if (profileName && profileName !== "default") {
      workspaceDir = join(stateDir, `workspace-${profileName}`);
    } else {
      workspaceDir = join(stateDir, "workspace");
    }
  }

  try {
    mkdirSync(workspaceDir, { recursive: true });
  } catch (err) {
    return Response.json(
      { error: `Failed to create workspace directory: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  const seedBootstrap = body.seedBootstrap !== false;
  const seeded: string[] = [];

  if (seedBootstrap) {
    const projectRoot = resolveProjectRoot();

    // Seed all bootstrap files from templates
    for (const filename of BOOTSTRAP_FILENAMES) {
      const filePath = join(workspaceDir, filename);
      if (!existsSync(filePath)) {
        const content = loadTemplateContent(filename, projectRoot);
        if (writeIfMissing(filePath, content)) {
          seeded.push(filename);
        }
      }
    }

    // Seed DuckDB + CRM object projections
    if (seedDuckDB(workspaceDir, projectRoot)) {
      seeded.push("workspace.duckdb");
      for (const obj of SEED_OBJECTS) {
        seeded.push(`${obj.name}/.object.yaml`);
      }
    }

    // Write workspace state so the gateway knows seeding was done
    const stateDir = join(workspaceDir, ".openclaw");
    const statePath = join(stateDir, "workspace-state.json");
    if (!existsSync(statePath)) {
      try {
        mkdirSync(stateDir, { recursive: true });
        const state = {
          version: 1,
          bootstrapSeededAt: new Date().toISOString(),
          duckdbSeededAt: existsSync(join(workspaceDir, "workspace.duckdb"))
            ? new Date().toISOString()
            : undefined,
        };
        writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
      } catch {
        // Best-effort state tracking
      }
    }
  }

  // Remember custom-path workspaces in the registry
  if (body.path?.trim() && profileName) {
    registerWorkspacePath(profileName, workspaceDir);
  }

  // Switch to the new profile
  if (profileName) {
    setUIActiveProfile(profileName === "default" ? null : profileName);
  }

  return Response.json({
    workspaceDir,
    profile: profileName || "default",
    activeProfile: getEffectiveProfile() || "default",
    seededFiles: seeded,
    workspaceRoot: resolveWorkspaceRoot(),
  });
}
