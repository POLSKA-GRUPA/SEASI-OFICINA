/** HARD suite: brain parser — adversarial corpus, aliases, cycles, perf. */
import { describe, expect, it } from "vitest";
import {
  buildGraph,
  extractWikilinks,
  moveCard,
  noteTitle,
  parseRoadmapBoard,
} from "../src/domains/brain/parser";

describe("extractWikilinks", () => {
  it("basic + alias + dedup raw", () => {
    const md = "ve [[Mission]] y [[Goals|objetivos]] y [[Mission]]";
    const links = extractWikilinks(md);
    expect(links.map((l) => l.target)).toEqual(["Mission", "Goals", "Mission"]);
    expect(links[1]?.alias).toBe("objetivos");
  });

  it("adversarial corpus", () => {
    const cases: [string, string[]][] = [
      ["sin links", []],
      ["[[]]", []],
      ["[[ ]]", []],
      ["[[A|]]", []], // alias vacío se acepta pero target válido A… ver abajo
      ["[not a wiki [[Real]]]", ["Real"]],
      ["[[A\nB]]", []], // sin salto de línea dentro
      ["[[Café-Ñ]]", ["Café-Ñ"]],
      ["[[A]][[B]][[C]]", ["A", "B", "C"]],
      ["```code [[Fake]]```", ["Fake"]], // parser de links NO conoce fences: se espera Fake (documentado)
      ["[[A|B|C]]", ["A"]], // alias greedy absorbe "B|C" (documentado)
    ];
    for (const [input, expected] of cases) {
      expect(extractWikilinks(input).map((l) => l.target), input).toEqual(expected);
    }
  });

  it("5000 links en <500ms", () => {
    const md = Array.from({ length: 5000 }, (_, i) => `[[N${i}]]`).join(" ");
    const t0 = performance.now();
    const links = extractWikilinks(md);
    const dt = performance.now() - t0;
    expect(links.length).toBe(5000);
    expect(dt).toBeLessThan(500);
  });
});

describe("buildGraph", () => {
  const notes = {
    "brain.md": "# Brain\nentry → [[Mission]] y [[Roadmap]]",
    "mission.md": "# Mission\npor qué → [[Goals]]",
    "goals.md": "# Goals\nmeta → [[Roadmap]]",
    "roadmap.md": "# Roadmap\n",
    "lonely.md": "# Lonely\n",
  };

  it("resuelve títulos case-insensitive y construye edges", () => {
    const g = buildGraph(notes);
    expect(g.nodes.length).toBe(5);
    expect(g.edges).toContainEqual(["brain.md", "mission.md"]);
    expect(g.edges).toContainEqual(["mission.md", "goals.md"]);
    expect(g.edges).toContainEqual(["goals.md", "roadmap.md"]);
    expect(g.orphans).toEqual(["lonely.md"]);
  });

  it("ciclos no rompen el grafo", () => {
    const g = buildGraph({
      "a.md": "# A\n→ [[B]]",
      "b.md": "# B\n→ [[C]]",
      "c.md": "# C\n→ [[A]]",
    });
    expect(g.edges.length).toBe(3);
    expect(g.orphans).toEqual([]);
  });

  it("self-links y dangling se ignoran", () => {
    const g = buildGraph({
      "a.md": "# A\n→ [[A]] y [[No Existe]]",
    });
    expect(g.edges).toEqual([]);
    expect(g.nodes[0]?.links).toEqual([]);
  });

  it("títulos duplicados: primero gana, sin crash", () => {
    const g = buildGraph({
      "x.md": "# Dup\n→ [[Dup]]",
      "y.md": "# Dup\n→ [[Otro]]",
      "z.md": "# Otro\n",
    });
    expect(g.nodes.length).toBe(3);
  });
});

describe("parseRoadmapBoard", () => {
  const board = [
    "## Roadmap",
    "",
    "### Todo",
    "- [ ] Clasificar facturas B82211806",
    "- [ ] Modelo 130 borrador",
    "",
    "### Doing",
    "- [~] Conciliación cobros",
    "",
    "### Done",
    "- [x] Ficha censal 036",
    "",
    "```",
    "- [ ] tarjetas dentro de código: NO son tarjetas",
    "```",
    "",
    "## Ignorado (h2 también mapea)",
    "- [x] otra columna custom",
  ].join("\n");

  it("parsea columnas, estados y respeta fences", () => {
    const cards = parseRoadmapBoard(board);
    expect(cards.length).toBe(5); // 2 todo + 1 doing + 1 done + 1 custom
    expect(cards.filter((c) => c.column === "todo")).toHaveLength(2);
    expect(cards.find((c) => c.title.includes("Conciliación"))?.status).toBe("blocked");
    expect(cards.find((c) => c.title.includes("Ficha"))?.status).toBe("done");
    expect(cards.some((c) => c.title.includes("dentro de código"))).toBe(false);
    expect(cards.find((c) => c.title === "otra columna custom")?.column).toBe("Ignorado (h2 también mapea)");
  });

  it("CRLF y tabs sobreviven", () => {
    const crlf = "## Todo\r\n- [ ]\tcon tab\r\n";
    const cards = parseRoadmapBoard(crlf);
    expect(cards.length).toBe(1);
    expect(cards[0]?.title).toBe("con tab");
  });

  it("markdown vacío → sin tarjetas", () => {
    expect(parseRoadmapBoard("")).toEqual([]);
    expect(parseRoadmapBoard("# nada\nsin listas")).toEqual([]);
  });
});

describe("moveCard", () => {
  const board = ["## Roadmap", "", "## Todo", "- [ ] tarea alpha", "- [ ] tarea beta", "## Done", "- [x] vieja"].join("\n");

  it("mueve tarjeta a otra columna cambiando estado", () => {
    const moved = moveCard(board, "todo::tarea alpha", { column: "done", status: "done" });
    const cards = parseRoadmapBoard(moved);
    expect(cards.find((c) => c.title === "tarea alpha")?.status).toBe("done");
    expect(cards.find((c) => c.title === "tarea beta")?.column).toBe("todo");
    expect(cards.find((c) => c.title === "tarea alpha")?.column).toBe("done");
  });

  it("tarjeta inexistente lanza", () => {
    expect(() => moveCard(board, "todo::no-existe", { column: "done", status: "done" })).toThrow();
  });

  it("crear columna si no existe", () => {
    const moved = moveCard(board, "todo::tarea beta", { column: "blocked", status: "blocked" });
    expect(parseRoadmapBoard(moved).find((c) => c.title === "tarea beta")?.column).toBe("blocked");
  });
});

describe("noteTitle", () => {
  it("primer h1, fallback", () => {
    expect(noteTitle("# Hola\nmundo")).toBe("Hola");
    expect(noteTitle("sin heading")).toBe("sin-titulo");
    expect(noteTitle("### h3 no vale", "fb")).toBe("fb");
  });
});
