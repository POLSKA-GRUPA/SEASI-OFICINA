/**
 * Brain domain — pure markdown intelligence.
 *
 * `[[wikilinks]]` (with optional `[[Target|alias]]`), graph extraction
 * (dedup, cycles tolerated, orphans included) and roadmap board parsing
 * (`## Column` headings with `- [status] card` items).
 * No Electron, no fs: fully unit-testable.
 */

export type Wikilink = { target: string; alias: string | null; raw: string };
export type BrainNode = { id: string; links: string[]; linkedFrom: string[] };
export type BrainGraph = { nodes: BrainNode[]; edges: [string, string][]; orphans: string[] };

export type BoardCard = {
  id: string;
  title: string;
  column: string;
  status: CardStatus;
};
export type CardStatus = "todo" | "doing" | "blocked" | "done";
export const CARD_STATUSES: readonly CardStatus[] = ["todo", "doing", "blocked", "done"];

const WIKILINK = /\[\[([^\[\]|\n]+)(?:\|([^\[\]\n]+))?\]\]/g;

export function extractWikilinks(markdown: string): Wikilink[] {
  const out: Wikilink[] = [];
  for (const match of markdown.matchAll(WIKILINK)) {
    const target = (match[1] ?? "").trim();
    if (!target) continue;
    const alias = match[2]?.trim() || null;
    out.push({ target, alias, raw: match[0] });
  }
  return out;
}

/** Parse `# Title` front-matter-less note name from first heading. */
export function noteTitle(markdown: string, fallback = "sin-titulo"): string {
  const heading = markdown.match(/^#\s+(.+)$/m);
  return (heading?.[1] ?? fallback).trim();
}

export function buildGraph(
  notes: Record<string, string>,
  resolveTitle = noteTitle,
): BrainGraph {
  const ids = Object.keys(notes);
  const idOfTitle = new Map<string, string>();
  for (const id of ids) {
    idOfTitle.set(resolveTitle(notes[id] ?? "", id).toLowerCase(), id);
  }

  const linksOf = new Map<string, Set<string>>();
  const linkedFrom = new Map<string, Set<string>>();
  for (const id of ids) {
    linksOf.set(id, new Set());
    linkedFrom.set(id, new Set());
  }

  for (const id of ids) {
    for (const link of extractWikilinks(notes[id] ?? "")) {
      const targetId = idOfTitle.get(link.target.toLowerCase());
      if (targetId === undefined) continue; // dangling link: no node
      if (targetId === id) continue; // self-link: ignore
      linksOf.get(id)?.add(targetId);
      linkedFrom.get(targetId)?.add(id);
    }
  }

  const nodes: BrainNode[] = ids.map((id) => ({
    id,
    links: [...(linksOf.get(id) ?? [])].sort(),
    linkedFrom: [...(linkedFrom.get(id) ?? [])].sort(),
  }));

  const edges: [string, string][] = [];
  for (const node of nodes) {
    for (const target of node.links) edges.push([node.id, target]);
  }

  const orphans = nodes
    .filter((n) => n.links.length === 0 && n.linkedFrom.length === 0)
    .map((n) => n.id);

  return { nodes, edges, orphans };
}

const CARD_LINE = /^[-*]\s+\[([ xX/~])\]\s+(.*)$/;

function statusOf(mark: string): CardStatus | null {
  switch (mark) {
    case " ": return "todo";
    case "x":
    case "X": return "done";
    case "~": return "blocked";
    default: return null;
  }
}

export function parseRoadmapBoard(markdown: string): BoardCard[] {
  const cards: BoardCard[] = [];
  let column = "sin columna";
  let inCodeFence = false;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const clean = (rawLine as string).replace(/\r/g, "");
    if (clean.trimStart().startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    const heading = clean.match(/^(#{1,6})\s+(.+)$/);
    if (heading?.[2]) {
      const text = heading[2].trim().toLowerCase();
      if (text === "doing" || text === "wip") column = "doing";
      else if (text === "todo" || text === "backlog") column = "todo";
      else if (text === "blocked") column = "blocked";
      else if (text === "done") column = "done";
      else column = heading[2].trim();
      continue;
    }
    const card = clean.match(CARD_LINE);
    if (card) {
      const status = statusOf(card[1] ?? "");
      if (status === null) continue;
      const title = (card[2] ?? "").trim();
      if (!title) continue;
      cards.push({ id: `${column}::${title}`, title, column, status });
    }
  }
  return cards;
}

/** Move a card to a column/status and re-serialize the board. */
export function moveCard(
  markdown: string,
  cardId: string,
  to: { column: string; status: CardStatus },
): string {
  const cards = parseRoadmapBoard(markdown);
  const target = cards.find((c) => c.id === cardId);
  if (!target) throw new Error(`card not found: ${cardId}`);

  const markFor = (s: CardStatus): string =>
    s === "done" ? "x" : s === "blocked" ? "~" : " ";

  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let currentColumn = "sin columna";
  let inserted = false;
  let skipping = false;
  let fence = false;

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      fence = !fence;
      out.push(line);
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading?.[2]) {
      const text = heading[2].trim().toLowerCase();
      if (text === "doing" || text === "wip") currentColumn = "doing";
      else if (text === "todo" || text === "backlog") currentColumn = "todo";
      else if (text === "blocked") currentColumn = "blocked";
      else if (text === "done") currentColumn = "done";
      else currentColumn = heading[2].trim();
      out.push(line);
      continue;
    }
    const card = line.match(CARD_LINE);
    if (card) {
      const status = statusOf(card[1] ?? "");
      const title = (card[2] ?? "").trim();
      const id = `${currentColumn}::${title}`;
      if (id === cardId) {
        skipping = true; // drop from old column
        continue;
      }
    }
    out.push(line);
  }

  // Re-insert under destination column heading (creating it if missing)
  const result: string[] = [];
  let placed = false;
  let underColumn: string | null = null;
  fence = false;
  for (const line of out) {
    if (line.trimStart().startsWith("```")) {
      fence = !fence;
      result.push(line);
      continue;
    }
    if (fence) {
      result.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading?.[2]) {
      if (underColumn !== null && !placed) {
        result.push(`- [${markFor(to.status)}] ${target.title}`);
        placed = true;
      }
      const text = heading[2].trim().toLowerCase();
      if (text === to.column.toLowerCase() || heading[2].trim() === to.column) {
        underColumn = to.column;
      } else {
        underColumn = null;
      }
      result.push(line);
      continue;
    }
    result.push(line);
  }
  if (!placed) {
    if (underColumn !== null) {
      result.push(`- [${markFor(to.status)}] ${target.title}`);
      placed = true;
    } else {
      result.push("", `## ${to.column}`, `- [${markFor(to.status)}] ${target.title}`);
    }
  }
  void skipping;
  return result.join("\n");
}
