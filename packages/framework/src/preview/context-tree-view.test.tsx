import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SkillNode, TreeTool } from "./context-tree.js";
import { ContextTreeView, skillContents } from "./context-tree-view.js";

function tool(name: string): TreeTool {
  return { name, description: `Does ${name}.`, isNew: false };
}

function skill(path: string, label: string, more: Partial<SkillNode> = {}): SkillNode {
  return { path, label, interactive: true, state: null, isNew: false, tools: [], children: [], ...more };
}

function tree(skills: SkillNode[], open: string[] = []): string {
  return renderToStaticMarkup(
    <ContextTreeView
      instructions={{ firstSentence: "You are Nora.", size: "4 sections", isNew: false, empty: false }}
      tools={[]}
      mcp={[]}
      skills={skills}
      initiallyOpen={new Set(open)}
      liveSkillPath=""
      builtIn={[]}
      onOpenInstructions={() => {}}
      onOpenSkill={() => {}}
      onTry={() => {}}
      onMcpConnect={() => {}}
      onMcpDisconnect={() => {}}
      onMcpRemove={() => {}}
    />,
  );
}

type Rendered = { attributes: string; inner: string };

/** Every button in document order; a button inside another one fails the test. */
function buttonsIn(html: string): Rendered[] {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(([, attributes, inner]) => {
    expect(inner).not.toContain("<button");
    return { attributes, inner };
  });
}

function attributeOf(button: Rendered, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(button.attributes)?.[1];
}

/** The text of the element with this id, its tags stripped; fails when no element has it. */
function textById(html: string, id: string): string {
  const at = html.indexOf(` id="${id}"`);
  expect(at, `an element with id="${id}"`).toBeGreaterThan(-1);
  const rest = html.slice(html.lastIndexOf("<", at));
  const tag = /^<(\w+)/.exec(rest)![1];
  let depth = 0;
  for (const match of rest.matchAll(new RegExp(`<(/?)${tag}\\b[^>]*>`, "g"))) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return rest.slice(0, match.index).replace(/<[^>]+>/g, "");
  }
  throw new Error(`<${tag} id="${id}"> is never closed`);
}

/** A button's accessible name and description, the way a browser reads them off the markup. */
function accessible(html: string, button: Rendered): { name: string; description?: string } {
  const labelledBy = attributeOf(button, "aria-labelledby");
  const describedBy = attributeOf(button, "aria-describedby");
  return {
    name: labelledBy ? textById(html, labelledBy) : (attributeOf(button, "aria-label") ?? button.inner.replace(/<[^>]+>/g, "")),
    description: describedBy?.split(" ").map((id) => textById(html, id)).join(" | "),
  };
}

function openButton(html: string, label: string): Rendered {
  const button = buttonsIn(html).find((candidate) => accessible(html, candidate).name === label);
  expect(button, `a button named "${label}"`).toBeDefined();
  return button!;
}

/** The svg a button ends with. */
function trailingIcon(button: Rendered): string | undefined {
  return /<svg\b(?:(?!<svg\b)[\s\S])*<\/svg>$/.exec(button.inner)?.[0];
}

const claims = skill("/schaden", "Schaden melden", {
  description: "Einstieg in die Schadenmeldung, verzweigt in die passende Sparte.",
  children: [
    skill("/schaden/kfz", "Kfz", { description: "Unfall und Glasbruch am Fahrzeug.", tools: [tool("kfz_schaden_aufnehmen")] }),
    skill("/schaden/sach", "Hausrat", { tools: [tool("sachschaden_aufnehmen")] }),
  ],
});

describe("what a skill holds", () => {
  it("counts its direct sub-skills, then its tools, and is nothing when it holds nothing", () => {
    const nested = skill("/a/b", "B", { children: [skill("/a/b/c", "C")] });

    expect(skillContents(skill("/a", "A", { children: [nested, skill("/a/d", "D")] }))).toBe("2 skills");
    expect(skillContents(skill("/a", "A", { children: [nested], tools: [tool("x"), tool("y"), tool("z")] }))).toBe(
      "1 skill · 3 tools",
    );
    expect(skillContents(skill("/a", "A", { tools: [tool("x")] }))).toBe("1 tool");
    expect(skillContents(skill("/a", "A"))).toBeNull();
  });
});

describe("a skill row in the context tree", () => {
  it("has an expand toggle and an open button named by the skill and described by its description and meta", () => {
    const html = tree([claims]);
    const toggle = buttonsIn(html).find((button) => attributeOf(button, "aria-label") === "Expand Schaden melden");
    const row = openButton(html, "Schaden melden");

    expect(toggle && attributeOf(toggle, "aria-expanded")).toBe("false");
    expect(attributeOf(row, "aria-haspopup")).toBe("dialog");
    expect(accessible(html, row)).toEqual({
      name: "Schaden melden",
      description: "Einstieg in die Schadenmeldung, verzweigt in die passende Sparte. | 2 skills",
    });
    for (const button of [toggle!, row]) expect(attributeOf(button, "class")).toContain("focus-visible:ring-3");
  });

  it("shows its description under its name and ends in the Instructions row's chevron", () => {
    const html = tree([claims]);
    const row = openButton(html, "Schaden melden");

    expect(row.inner).toContain(
      'class="truncate text-[0.8125rem] text-muted-foreground">Einstieg in die Schadenmeldung, verzweigt in die passende Sparte.</span>',
    );
    expect(trailingIcon(row)).toContain("lucide-chevron-right");
    expect(trailingIcon(row)).toBe(trailingIcon(buttonsIn(html)[0]));
  });

  it("says what the skill holds unless it is in use, read or locked", () => {
    const html = tree([
      skill("/v", "Contract", { children: [skill("/v/e", "Excess")], tools: [tool("a"), tool("b"), tool("c")] }),
      skill("/live", "Live", { state: "in-use", children: [skill("/live/x", "X")] }),
      skill("/read", "Earlier", { state: "read", children: [skill("/read/x", "Y")] }),
      skill("/locked", "Later", { state: "locked", tools: [tool("open_later")] }),
      skill("/empty", "Empty"),
    ]);

    expect(accessible(html, openButton(html, "Contract")).description).toBe("1 skill · 3 tools");
    expect(accessible(html, openButton(html, "Live")).description).toBe("In use");
    expect(accessible(html, openButton(html, "Earlier")).description).toBe("Read");
    expect(accessible(html, openButton(html, "Later")).description).toBe("Locked");
    expect(accessible(html, openButton(html, "Empty")).description).toBeUndefined();
    expect(html).not.toMatch(/mono|tabular-nums/);
  });

  it("gives a leaf skill no toggle but still the trailing chevron", () => {
    const html = tree([skill("/leaf", "Leaf", { description: "Nothing below it." })]);

    expect(buttonsIn(html).filter((button) => attributeOf(button, "aria-expanded"))).toEqual([]);
    expect(trailingIcon(openButton(html, "Leaf"))).toContain("lucide-chevron-right");
  });

  it("gives an expanded skill's sub-skills the same row, with or without a description", () => {
    const html = tree([claims], ["/schaden"]);
    const vehicle = openButton(html, "Kfz");
    const property = openButton(html, "Hausrat");

    expect(buttonsIn(html).find((button) => attributeOf(button, "aria-label") === "Collapse Schaden melden")).toBeDefined();
    expect(accessible(html, vehicle).description).toBe("Unfall und Glasbruch am Fahrzeug. | 1 tool");
    expect(trailingIcon(vehicle)).toContain("lucide-chevron-right");
    expect(accessible(html, property).description).toBe("1 tool");
    expect(property.inner).not.toContain("text-[0.8125rem]");
  });
});
