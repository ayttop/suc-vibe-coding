import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Skills are markdown files grouped per topic under `agent/skills/<id>/`.
 * Each folder must contain a `SKILL.md` (the hub) and optionally other
 * `.md` support files (referenced by relative links from SKILL.md).
 *
 * Loaded at runtime: tweak the .md files and restart the server, no rebuild.
 */

const SKILLS_DIR = path.resolve(__dirname, "./skills");

export interface SkillDoc {
  filename: string;
  title: string;
  content: string;
}

export interface Skill {
  id: string;
  hub: SkillDoc;
  docs: SkillDoc[];
}

function extractTitle(markdown: string, fallback: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

export function loadSkill(id: string): Skill | null {
  const dir = path.join(SKILLS_DIR, id);
  if (!existsSync(dir)) return null;

  // Recursive so canonical docs synced into a `daemon/` subfolder
  // (scripts/sync-daemon-docs.mjs) are discovered too. Relative paths are
  // kept as the doc `filename` (e.g. "daemon/javascript-sdk.md"), which is
  // also how SKILL.md links to them and how `read_skill_doc` addresses them.
  const files = readdirSync(dir, { recursive: true })
    .map((f) => String(f).split(path.sep).join("/"))
    .filter((f) => f.endsWith(".md"));
  if (files.length === 0) return null;

  const hubFile = files.find((f) => f.toLowerCase() === "skill.md");
  if (!hubFile) return null;

  const toDoc = (filename: string): SkillDoc => {
    const content = readFileSync(path.join(dir, filename), "utf-8");
    return {
      filename,
      title: extractTitle(content, filename.replace(/\.md$/, "")),
      content,
    };
  };

  return {
    id,
    hub: toDoc(hubFile),
    docs: files.filter((f) => f !== hubFile).map(toDoc),
  };
}

export const PRIMARY_SKILL_ID = "reachy-mini-app";

let cached: Skill | null | undefined;
export function getPrimarySkill(): Skill | null {
  if (cached === undefined) {
    cached = loadSkill(PRIMARY_SKILL_ID);
    if (cached) {
      const docNames = cached.docs.map((d) => d.filename).join(", ");
      console.log(
        `[skill-loader] Loaded skill "${cached.id}" (hub: ${cached.hub.filename}, docs: ${docNames || "none"})`,
      );
    } else {
      console.warn(
        `[skill-loader] Skill "${PRIMARY_SKILL_ID}" not found under ${SKILLS_DIR}`,
      );
    }
  }
  return cached;
}

export function listSkillDocs(skill: Skill): string[] {
  return skill.docs.map((d) => d.filename.replace(/\.md$/, ""));
}

export function getSkillDoc(skill: Skill, topic: string): SkillDoc | null {
  const normalized = topic.toLowerCase().replace(/\.md$/, "");
  return (
    skill.docs.find(
      (d) => d.filename.toLowerCase().replace(/\.md$/, "") === normalized,
    ) ?? null
  );
}
