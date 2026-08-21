/**
 * Docs RAG Extension
 *
 * A personal documentation corpus with BM25 retrieval, topic auto-detection,
 * and ingestion — a local RAG for programming languages, hardware, OS, and
 * software the user works with.
 *
 * Corpus:  ~/.pi/agent/docs/ (recursive, markdown files)
 *          frontmatter: title, category (os|hardware|language|software|other),
 *          aliases, tags, source, learned_at
 * Index:   ~/.pi/agent/docs-index.json (BM25; rebuilt on session start / /learn)
 *
 * Features:
 * - /learn <path...>  Ingest .md files (or directories of them) into the corpus
 * - /docs <query>     Search the corpus (results shown as a widget)
 * - /docs rm [name]   Remove a document via an interactive picker
 * - /docs-list        List all learned documents
 * - /docs-rm [name]   Remove a document (picker; optional name filters candidates)
 * - search-docs tool  BM25 search callable by the LLM
 * - Auto-injection: prompts that mention a doc's aliases get a hidden context
 *   message with the most relevant chunks. Deduped per session and reset on
 *   compaction so the context survives it.
 *
 * Env config:
 * - DOCS_RAG_MAX_INJECT_CHARS    total injected chars per prompt (default 3000)
 * - DOCS_RAG_MAX_DOCS            max docs injected per prompt (default 2)
 * - DOCS_RAG_MAX_CHUNKS_PER_DOC  max chunks per doc (default 2)
 */

import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Paths & config
// ---------------------------------------------------------------------------

const EXTENSION_AGENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_DIR = resolve(process.env.PI_CODING_AGENT_DIR ?? EXTENSION_AGENT_DIR);
const DOCS_DIR = resolve(AGENT_DIR, "docs");
const INDEX_PATH = resolve(AGENT_DIR, "docs-index.json");

const CATEGORIES = ["os", "hardware", "language", "software", "other"] as const;
type Category = (typeof CATEGORIES)[number];

const MAX_INJECT_CHARS = Number(process.env.DOCS_RAG_MAX_INJECT_CHARS ?? 3000);
const MAX_INJECT_DOCS = Number(process.env.DOCS_RAG_MAX_DOCS ?? 2);
const MAX_CHUNKS_PER_DOC = Number(process.env.DOCS_RAG_MAX_CHUNKS_PER_DOC ?? 2);
const MAX_CHUNK_CHARS = 4000;
const MIN_CHUNK_CHARS = 40;
const EXCERPT_CHARS = 1200;

// ---------------------------------------------------------------------------
// Frontmatter (minimal YAML subset: "key: value" and "key: [a, b, c]")
// ---------------------------------------------------------------------------

interface DocMeta {
  title: string;
  category: Category;
  aliases: string[];
  tags: string[];
  source?: string;
  learnedAt?: string;
}

function parseFrontmatter(text: string): { meta: Partial<DocMeta>; body: string } {
  if (!text.startsWith("---\n")) return { meta: {}, body: text };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { meta: {}, body: text };
  const rawBlock = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\r?\n+/, "");
  const meta: Partial<DocMeta> = {};
  for (const line of rawBlock.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let value = m[2].trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      const items = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      if (key === "aliases") meta.aliases = items;
      else if (key === "tags") meta.tags = items;
      continue;
    }
    value = value.replace(/^["']|["']$/g, "");
    if (key === "title") meta.title = value;
    else if (key === "category") meta.category = value as Category;
    else if (key === "source") meta.source = value;
    else if (key === "learned_at") meta.learnedAt = value;
  }
  return { meta, body };
}

function serializeFrontmatter(meta: DocMeta): string {
  const lines = [
    "---",
    `title: ${meta.title}`,
    `category: ${meta.category}`,
    `aliases: [${meta.aliases.join(", ")}]`,
  ];
  if (meta.tags.length > 0) lines.push(`tags: [${meta.tags.join(", ")}]`);
  if (meta.source) lines.push(`source: ${meta.source}`);
  if (meta.learnedAt) lines.push(`learned_at: ${meta.learnedAt}`);
  lines.push("---", "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveTitle(body: string, filePath: string): string {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  if (m) return m[1].trim();
  const base = relative(DOCS_DIR, filePath).split("/").pop() ?? filePath;
  return base.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "Untitled";
}

function deriveAliases(title: string): string[] {
  const clean = title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const set = new Set<string>();
  if (clean.length >= 4) set.add(clean);
  for (const w of clean.split(" ")) if (w.length >= 4) set.add(w);
  return [...set].slice(0, 8);
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "doc";
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((l) => (l ? pad + l : l))
    .join("\n");
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listMarkdownFiles(p)));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chunking (by markdown headings, with heading path as context)
// ---------------------------------------------------------------------------

interface RawChunk {
  doc: string;
  heading: string;
  text: string;
}

function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const paras = text.split(/\n{2,}/);
  const pieces: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > max) {
      pieces.push(cur);
      cur = p;
    } else {
      cur = cur ? cur + "\n\n" + p : p;
    }
  }
  if (cur) pieces.push(cur);
  const out: string[] = [];
  for (const p of pieces) {
    if (p.length <= max) {
      out.push(p);
      continue;
    }
    for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max));
  }
  return out;
}

function chunkDoc(relPath: string, body: string): RawChunk[] {
  const out: RawChunk[] = [];
  const stack: string[] = [];
  let buf: string[] = [];
  let inCode = false;

  const flush = () => {
    const text = buf.join("\n").trim();
    buf = [];
    if (text.length < MIN_CHUNK_CHARS) return;
    const heading = stack.join(" > ");
    for (const piece of splitLong(text, MAX_CHUNK_CHARS)) {
      out.push({ doc: relPath, heading, text: piece });
    }
  };

  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) inCode = !inCode;
    const h = inCode ? null : line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      flush();
      const level = h[1].length;
      while (stack.length >= level) stack.pop();
      stack.push(h[2].trim());
      buf.push(`## ${stack.join(" > ")}`);
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Tokenization & BM25
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "to", "of", "in", "on", "at",
  "for", "and", "or", "but", "with", "without", "from", "by", "as", "it", "its", "this", "that",
  "these", "those", "i", "you", "he", "she", "we", "they", "me", "my", "your", "our", "their",
  "what", "which", "who", "how", "why", "when", "where", "can", "could", "should", "would", "will",
  "shall", "may", "might", "do", "does", "did", "done", "have", "has", "had", "having", "not", "no",
  "yes", "if", "then", "than", "so", "such", "into", "about", "over", "under", "again", "further",
  "once", "here", "there", "all", "any", "both", "each", "few", "more", "most", "other", "some",
  "only", "own", "same", "just", "also", "very", "too", "up", "down", "out", "off", "per", "via",
  "one", "two", "new", "get", "set", "make", "using", "used", "use",
]);

/** Words too generic to trigger auto-injection on their own (doc-structure terms). */
const GENERIC_ALIASES = new Set([
  "guide", "tutorial", "reference", "overview", "introduction", "basics", "getting", "started",
  "setup", "configuration", "manual", "documentation", "notes", "readme", "user", "howto",
  "handbook", "cookbook", "examples", "example", "api", "cli", "sdk", "docs", "doc", "help",
  "faq", "wiki", "book", "lesson", "chapter", "section", "page", "version", "versions", "release",
  "releases", "changelog", "migration", "migrating", "upgrade", "upgrading", "update", "updated",
  "tips", "tricks", "troubleshooting", "debugging", "debug", "performance", "optimization",
  "optimizing", "security", "network", "networking", "storage", "memory", "best", "practices",
  "practice", "patterns", "pattern", "questions", "answers", "summary", "details", "deep", "dive",
]);

function tokenize(text: string): string[] {
  const normalized = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
  return normalized.split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

interface IndexChunk {
  doc: string;
  heading: string;
  text: string;
  tf: Record<string, number>;
  len: number;
}

interface IndexDoc {
  rel: string;
  title: string;
  category: Category;
  aliases: string[];
  tags: string[];
  source?: string;
}

interface IndexData {
  version: 1;
  builtAt: string;
  docs: IndexDoc[];
  chunks: IndexChunk[];
  df: Record<string, number>;
  totalLen: number;
}

async function buildIndex(): Promise<IndexData> {
  await mkdir(DOCS_DIR, { recursive: true });
  const files = (await listMarkdownFiles(DOCS_DIR)).sort();
  const docs: IndexDoc[] = [];
  const chunks: IndexChunk[] = [];
  const df: Record<string, number> = {};
  let totalLen = 0;

  for (const abs of files) {
    const text = await readFile(abs, "utf8");
    const { meta, body } = parseFrontmatter(text);
    const rel = relative(DOCS_DIR, abs);
    const title = meta.title?.trim() || deriveTitle(body, abs);
    const category: Category = CATEGORIES.includes(meta.category as Category)
      ? (meta.category as Category)
      : "other";
    const aliases = meta.aliases?.length ? meta.aliases : deriveAliases(title);
    const doc: IndexDoc = { rel, title, category, aliases, tags: meta.tags ?? [] };
    if (meta.source) doc.source = meta.source;
    docs.push(doc);

    const docTokens = new Set<string>();
    for (const rc of chunkDoc(rel, body)) {
      const tokens = tokenize(rc.text);
      if (tokens.length === 0) continue;
      const tf: Record<string, number> = {};
      for (const t of tokens) tf[t] = (tf[t] ?? 0) + 1;
      for (const t of Object.keys(tf)) docTokens.add(t);
      chunks.push({ doc: rel, heading: rc.heading, text: rc.text, tf, len: tokens.length });
      totalLen += tokens.length;
    }
    for (const t of docTokens) df[t] = (df[t] ?? 0) + 1;
  }

  return { version: 1, builtAt: new Date().toISOString(), docs, chunks, df, totalLen };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

interface SearchHit {
  chunk: IndexChunk;
  doc: IndexDoc;
  score: number;
}

function searchIndex(index: IndexData, query: string, category: Category | undefined, limit: number): SearchHit[] {
  const qTokens = [...new Set(tokenize(query))];
  if (qTokens.length === 0 || index.chunks.length === 0) return [];
  const N = index.docs.length;
  const avgdl = index.totalLen / index.chunks.length || 1;
  const k1 = 1.5;
  const b = 0.75;
  const docMap = new Map(index.docs.map((d) => [d.rel, d]));
  const allowed = category
    ? new Set(index.docs.filter((d) => d.category === category).map((d) => d.rel))
    : null;

  const hits: SearchHit[] = [];
  for (const chunk of index.chunks) {
    if (allowed && !allowed.has(chunk.doc)) continue;
    let score = 0;
    for (const qt of qTokens) {
      const tf = chunk.tf[qt];
      if (!tf) continue;
      const df = index.df[qt] ?? 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * chunk.len) / avgdl)));
    }
    if (score > 0) hits.push({ chunk, doc: docMap.get(chunk.doc)!, score });
  }
  hits.sort((a, z) => z.score - a.score);

  // Max 2 chunks per doc in results
  const perDoc = new Map<string, number>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    const n = perDoc.get(h.chunk.doc) ?? 0;
    if (n >= 2) continue;
    perDoc.set(h.chunk.doc, n + 1);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Topic detection (alias matching against the user prompt)
// ---------------------------------------------------------------------------

function aliasPattern(alias: string): RegExp {
  const esc = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Word-boundary match for plain word-ish aliases; plain match for special ones (c++, node.js)
  return /^[a-z0-9](?:[a-z0-9.+-]*[a-z0-9])?$/i.test(alias)
    ? new RegExp(`\\b${esc}\\b`, "i")
    : new RegExp(esc, "i");
}

interface DetectedTopic {
  doc: IndexDoc;
  score: number;
  matched: string[];
}

function detectTopics(prompt: string, index: IndexData): DetectedTopic[] {
  const out: DetectedTopic[] = [];
  for (const doc of index.docs) {
    const matched: string[] = [];
    let score = 0;
    for (const alias of doc.aliases) {
      if (alias.length < 3) continue;
      if (aliasPattern(alias).test(prompt)) {
        matched.push(alias);
        score += alias.length;
      }
    }
    if (matched.length === 0) continue;
    const strong = matched.filter((a) => !GENERIC_ALIASES.has(a));
    const passes =
      strong.some((a) => a.length >= 5) ||
      strong.length >= 2 ||
      (strong.length >= 1 && strong[0].length >= 4 && matched.length >= 2);
    if (!passes) continue;
    out.push({ doc, score, matched });
  }
  return out.sort((a, z) => z.score - a.score);
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

function buildInjection(topics: DetectedTopic[], index: IndexData, prompt: string): string {
  const hits = searchIndex(index, prompt, undefined, 12);
  const byDoc = new Map<string, SearchHit[]>();
  for (const h of hits) {
    const arr = byDoc.get(h.chunk.doc) ?? [];
    if (arr.length < MAX_CHUNKS_PER_DOC) arr.push(h);
    byDoc.set(h.chunk.doc, arr);
  }

  const parts: string[] = [];
  let used = 0;
  outer: for (const t of topics.slice(0, MAX_INJECT_DOCS)) {
    for (const h of byDoc.get(t.doc.rel) ?? []) {
      const header =
        `### ${h.doc.title} [${h.doc.category}]\n` +
        `File: ${join(DOCS_DIR, h.chunk.doc)}` +
        (h.chunk.heading ? `\nSection: ${h.chunk.heading}` : "");
      let excerpt = h.chunk.text;
      if (used + header.length + excerpt.length + 2 > MAX_INJECT_CHARS) {
        const room = MAX_INJECT_CHARS - used - header.length - 1;
        if (room < 200) break outer;
        excerpt = excerpt.slice(0, room) + "…";
      }
      parts.push(header + "\n" + excerpt);
      used += header.length + excerpt.length + 2;
    }
  }
  if (parts.length === 0) return "";

  const matched = topics
    .slice(0, MAX_INJECT_DOCS)
    .map((t) => `${t.doc.title} (${t.matched.join(", ")})`)
    .join("; ");
  return (
    `[docs-rag] Local documentation relevant to this prompt (matched: ${matched}).\n` +
    "Excerpts from the user's local documentation corpus:\n\n" +
    parts.join("\n\n") +
    "\n\nUse the read tool on the file paths above for full documents."
  );
}

// ---------------------------------------------------------------------------
// Ingestion (/learn)
// ---------------------------------------------------------------------------

async function ingestFile(abs: string): Promise<string> {
  const text = await readFile(abs, "utf8");
  const { meta, body } = parseFrontmatter(text);
  const title = meta.title?.trim() || deriveTitle(body, abs);
  const category: Category = CATEGORIES.includes(meta.category as Category)
    ? (meta.category as Category)
    : "other";
  const aliases = meta.aliases?.length ? meta.aliases : deriveAliases(title);
  const doc: DocMeta = {
    title,
    category,
    aliases,
    tags: meta.tags ?? [],
    source: abs,
    learnedAt: new Date().toISOString(),
  };

  const base = slugify(title);
  let rel = join(category, `${base}.md`);
  let target = join(DOCS_DIR, rel);
  if (await pathExists(target)) {
    const existing = await readFile(target, "utf8").catch(() => "");
    const existingMeta = parseFrontmatter(existing).meta;
    // Same source file → overwrite; different source → numeric suffix
    if (existingMeta.source !== abs) {
      for (let i = 2; i < 100; i++) {
        rel = join(category, `${base}-${i}.md`);
        target = join(DOCS_DIR, rel);
        if (!(await pathExists(target))) break;
      }
    }
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, serializeFrontmatter(doc) + body);
  return rel;
}

async function learnPaths(inputs: string[]): Promise<{ learned: string[]; skipped: string[] }> {
  const learned: string[] = [];
  const skipped: string[] = [];
  for (const input of inputs) {
    const abs = resolve(process.cwd(), input.replace(/^@/, ""));
    let st;
    try {
      st = await stat(abs);
    } catch {
      skipped.push(`${input} (not found)`);
      continue;
    }
    const files: string[] = [];
    if (st.isDirectory()) files.push(...(await listMarkdownFiles(abs)));
    else if (abs.endsWith(".md")) files.push(abs);
    else {
      skipped.push(`${input} (not a .md file or directory)`);
      continue;
    }
    if (files.length === 0) {
      skipped.push(`${input} (no .md files)`);
      continue;
    }
    for (const f of files) {
      try {
        learned.push(await ingestFile(f));
      } catch (err) {
        skipped.push(`${f} (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }
  return { learned, skipped };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

// Named exports for testing (the extension loader only uses the default export)
export {
  buildIndex,
  chunkDoc,
  detectTopics,
  learnPaths,
  parseFrontmatter,
  searchIndex,
  serializeFrontmatter,
  tokenize,
};

export default function docsRag(pi: ExtensionAPI) {
  let index: IndexData | null = null;
  const injectedThisSession = new Set<string>();

  async function loadOrBuildIndex(force = false): Promise<IndexData> {
    if (index && !force) return index;
    if (!force) {
      try {
        // Use cached index only if it is at least as fresh as the corpus dir
        const idxStat = await stat(INDEX_PATH);
        const dirStat = await stat(DOCS_DIR).catch(() => null);
        if (dirStat && idxStat.mtimeMs >= dirStat.mtimeMs) {
          const cached = JSON.parse(await readFile(INDEX_PATH, "utf8")) as IndexData;
          if (cached.version === 1 && Array.isArray(cached.chunks) && Array.isArray(cached.docs)) {
            index = cached;
            return cached;
          }
        }
      } catch {
        // no cache — rebuild below
      }
    }
    const built = await buildIndex();
    index = built;
    const tmp = INDEX_PATH + ".tmp";
    await writeFile(tmp, JSON.stringify(built));
    await rename(tmp, INDEX_PATH);
    return built;
  }

  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const n = index?.docs.length ?? 0;
    ctx.ui.setStatus("docs-rag", n > 0 ? `📚 ${n} docs` : undefined);
  }

  // --- interactive removal (picker + confirm) --------------------------------

  async function removeDocInteractive(ctx: ExtensionContext, filter?: string): Promise<void> {
    const idx = await loadOrBuildIndex();
    if (idx.docs.length === 0) {
      ctx.ui.notify("Corpus is empty. Add documents with /learn <path>.", "warning");
      return;
    }
    let candidates = idx.docs;
    if (filter) {
      const q = filter.toLowerCase();
      candidates = idx.docs.filter(
        (d) =>
          d.rel.toLowerCase().includes(q) ||
          d.title.toLowerCase().includes(q) ||
          d.aliases.some((a) => a.toLowerCase() === q),
      );
      if (candidates.length === 0) {
        ctx.ui.notify(`No document matching "${filter}". See /docs-list.`, "warning");
        return;
      }
    }
    const label = (d: IndexDoc) => `${d.title} [${d.category}] — ${d.rel}`;
    const choice = await ctx.ui.select(
      filter ? `Remove a document matching "${filter}":` : "Remove which document?",
      candidates.map(label),
    );
    if (!choice) {
      ctx.ui.notify("Cancelled.", "info");
      return;
    }
    const doc = candidates.find((d) => label(d) === choice);
    if (!doc) return;
    const ok = await ctx.ui.confirm(
      "Remove document?",
      `${doc.title} [${doc.category}]\nFile: ${join(DOCS_DIR, doc.rel)}\n\nThis deletes the file from the corpus.`,
    );
    if (!ok) {
      ctx.ui.notify("Cancelled.", "info");
      return;
    }
    await rm(join(DOCS_DIR, doc.rel));
    await loadOrBuildIndex(true);
    updateStatus(ctx);
    ctx.ui.notify(`Removed: ${doc.rel}`, "info");
  }

  // --- search-docs tool ----------------------------------------------------

  const searchParams = Type.Object({
    query: Type.String({
      description:
        "What to look up in the local documentation corpus. Be specific — one concept per call.",
    }),
    category: Type.Optional(
      Type.Union(
        CATEGORIES.map((c) => Type.Literal(c)),
        { description: "Restrict search to one category: os, hardware, language, software, other." },
      ),
    ),
    limit: Type.Optional(
      Type.Number({ minimum: 1, maximum: 10, description: "Maximum number of results (default 5)." }),
    ),
  });

  pi.registerTool({
    name: "search-docs",
    label: "Search Local Docs",
    description: `Searches the user's LOCAL documentation corpus at ${DOCS_DIR} — documents the user has ingested with /learn, covering programming languages, operating systems, hardware, and software they work with.

Use this tool when the question involves a technology, OS, hardware component, or software the user may have documented locally, especially for:
- the user's specific setup, environment, hardware, or configurations
- topics where personal notes or ingested docs are likely to contain specifics (versions, quirks, conventions)
- anything the user has previously asked to be learned

Results include file paths and section headings. When an excerpt is not enough, use the read tool on the file path to get the full document.

Do not call this tool more than 3 times per question.`,
    promptSnippet: "Search the user's local documentation corpus (ingested via /learn)",
    promptGuidelines: [
      "Use search-docs before answering questions about programming languages, operating systems, hardware, or software the user has documented locally.",
    ],
    parameters: searchParams,
    async execute(_toolCallId, params) {
      try {
        const idx = await loadOrBuildIndex();
        if (idx.docs.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "The local documentation corpus is empty. The user can add documents with /learn <path-to-markdown-file-or-directory>.",
              },
            ],
            details: undefined,
          };
        }
        const hits = searchIndex(idx, params.query, params.category, params.limit ?? 5);
        if (hits.length === 0) {
          const topics = idx.docs
            .map((d) => `- ${d.title} [${d.category}] (aliases: ${d.aliases.join(", ")})`)
            .join("\n");
          return {
            content: [
              {
                type: "text",
                text: `No matches in the local documentation corpus for "${params.query}".\n\nKnown documents:\n${topics}`,
              },
            ],
            details: undefined,
          };
        }
        const parts = hits.map((h, i) => {
          const excerpt =
            h.chunk.text.length > EXCERPT_CHARS ? h.chunk.text.slice(0, EXCERPT_CHARS) + "…" : h.chunk.text;
          const lines = [
            `${i + 1}. ${h.doc.title} [${h.doc.category}] — score ${h.score.toFixed(1)}`,
            `   File: ${join(DOCS_DIR, h.chunk.doc)}`,
          ];
          if (h.chunk.heading) lines.push(`   Section: ${h.chunk.heading}`);
          lines.push(`   Excerpt:\n${indent(excerpt, "   ")}`);
          return lines.join("\n");
        });
        return {
          content: [
            {
              type: "text",
              text: `Local documentation matches for "${params.query}":\n\n${parts.join("\n\n")}\n\nUse the read tool on a file path for the full document.`,
            },
          ],
          details: undefined,
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `search-docs failed: ${err instanceof Error ? err.message : String(err)}` },
          ],
          details: undefined,
        };
      }
    },
  });

  // --- commands --------------------------------------------------------------

  pi.registerCommand("learn", {
    description: "Ingest documentation into the local corpus (usage: /learn <path-to-md-or-dir> [more paths...])",
    handler: async (args, ctx) => {
      const inputs = args.trim().split(/\s+/).filter(Boolean);
      if (inputs.length === 0) {
        ctx.ui.notify("Usage: /learn <path-to-markdown-file-or-directory> [more paths...]", "warning");
        return;
      }
      ctx.ui.setStatus("docs-rag", "learning…");
      const { learned, skipped } = await learnPaths(inputs);
      await loadOrBuildIndex(true);
      updateStatus(ctx);
      if (learned.length > 0) {
        ctx.ui.notify(
          `Learned ${learned.length} doc(s): ${learned.map((r) => r.split("/").pop()).join(", ")}`,
          "info",
        );
      }
      if (skipped.length > 0) ctx.ui.notify(`Skipped: ${skipped.join("; ")}`, "warning");
      if (learned.length === 0 && skipped.length === 0) ctx.ui.notify("Nothing to learn.", "warning");
    },
  });

  pi.registerCommand("docs", {
    description: "Search the local documentation corpus (usage: /docs <query> | /docs rm [name])",
    handler: async (args, ctx) => {
      const q = args.trim();
      if (!q) {
        ctx.ui.notify("Usage: /docs <query> | /docs rm [name]", "warning");
        return;
      }
      const firstToken = q.split(/\s+/)[0].toLowerCase();
      if (firstToken === "rm" || firstToken === "remove") {
        await removeDocInteractive(ctx, q.slice(firstToken.length).trim() || undefined);
        return;
      }
      const idx = await loadOrBuildIndex();
      if (idx.docs.length === 0) {
        ctx.ui.notify("Corpus is empty. Add documents with /learn <path>.", "warning");
        return;
      }
      const hits = searchIndex(idx, q, undefined, 5);
      if (hits.length === 0) {
        ctx.ui.setWidget("docs-rag", [
          `No matches for "${q}". Known documents:`,
          ...idx.docs.map((d) => `- ${d.title} [${d.category}] — ${d.aliases.join(", ")}`),
        ]);
        return;
      }
      const lines = hits.map((h, i) => {
        const l = [
          `${i + 1}. ${h.doc.title} [${h.doc.category}] (score ${h.score.toFixed(1)}) — ${join(DOCS_DIR, h.chunk.doc)}`,
        ];
        if (h.chunk.heading) l.push(`   ${h.chunk.heading}`);
        const first = h.chunk.text.split("\n").find((x) => x.trim());
        if (first) l.push(`   ${first.trim().slice(0, 120)}`);
        return l.join("\n");
      });
      ctx.ui.setWidget("docs-rag", [`docs-rag: ${q}`, ...lines]);
    },
  });

  pi.registerCommand("docs-list", {
    description: "List all learned documents",
    handler: async (_args, ctx) => {
      const idx = await loadOrBuildIndex();
      if (idx.docs.length === 0) {
        ctx.ui.notify("Corpus is empty. Add documents with /learn <path>.", "warning");
        return;
      }
      const chunkCounts = new Map<string, number>();
      for (const c of idx.chunks) chunkCounts.set(c.doc, (chunkCounts.get(c.doc) ?? 0) + 1);
      ctx.ui.setWidget("docs-rag", [
        `docs-rag corpus: ${idx.docs.length} docs, ${idx.chunks.length} chunks`,
        ...idx.docs.map(
          (d) =>
            `- ${d.title} [${d.category}] — ${chunkCounts.get(d.rel) ?? 0} chunks — ${join(DOCS_DIR, d.rel)}`,
        ),
      ]);
    },
  });

  pi.registerCommand("docs-rm", {
    description:
      "Remove a document from the corpus (usage: /docs-rm [slug-or-title]) — opens a picker to navigate when no name is given",
    handler: async (args, ctx) => {
      const q = args.trim();
      if (!ctx.hasUI) {
        // Non-interactive fallback (print/json mode): require an unambiguous name
        if (!q) {
          ctx.ui.notify("Usage: /docs-rm <slug-or-title>", "warning");
          return;
        }
        const idx = await loadOrBuildIndex();
        const ql = q.toLowerCase();
        const matches = idx.docs.filter(
          (d) =>
            d.rel.toLowerCase().includes(ql) ||
            d.title.toLowerCase().includes(ql) ||
            d.aliases.some((a) => a.toLowerCase() === ql),
        );
        if (matches.length === 0) {
          ctx.ui.notify(`No document matching "${q}". See /docs-list.`, "warning");
          return;
        }
        if (matches.length > 1) {
          ctx.ui.notify(
            `Ambiguous — matches: ${matches.map((d) => d.rel).join(", ")}. Be more specific.`,
            "warning",
          );
          return;
        }
        await rm(join(DOCS_DIR, matches[0].rel));
        await loadOrBuildIndex(true);
        updateStatus(ctx);
        ctx.ui.notify(`Removed: ${matches[0].rel}`, "info");
        return;
      }
      await removeDocInteractive(ctx, q || undefined);
    },
  });

  // --- events ----------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    injectedThisSession.clear();
    try {
      await loadOrBuildIndex();
      updateStatus(ctx);
    } catch {
      // never break startup
    }
  });

  pi.on("session_compact", async () => {
    // Injected context may have been compacted away — allow re-injection
    injectedThisSession.clear();
  });

  pi.on("before_agent_start", async (event) => {
    try {
      if (!index) await loadOrBuildIndex();
      if (!index || index.docs.length === 0) return;
      const topics = detectTopics(event.prompt, index);
      if (topics.length === 0) return;
      const fresh = topics.filter((t) => !injectedThisSession.has(t.doc.rel));
      if (fresh.length === 0) return;
      const text = buildInjection(fresh, index, event.prompt);
      if (!text) return;
      for (const t of fresh) injectedThisSession.add(t.doc.rel);
      return {
        message: {
          customType: "docs-rag",
          content: text,
          display: false,
        },
      };
    } catch {
      return; // never break the agent loop
    }
  });
}
