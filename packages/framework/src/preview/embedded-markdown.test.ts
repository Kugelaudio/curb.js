import { afterEach, expect, it, vi } from "vitest";
import { parseSkillBlueprint } from "./skill-blueprint.js";
import { pageBase } from "./preview-route.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("preloads and refreshes a namespaced document before its inactive skill branch opens", async () => {
  const root = { dataset: { curbBase: "/embedded" } } as { dataset: DOMStringMap };
  vi.stubGlobal("window", {});
  const files = ["overview.md", "billing/inactive.md"];
  let content = "# Inactive branch";
  const fetch = vi.fn(async (path: string) => {
    if (path === "/embedded/context.index.json") return Response.json(files);
    if (path === "/embedded/overview.md") return new Response("# Overview");
    if (path === "/embedded/billing/inactive.md") return new Response(content);
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  const { listPublicMarkdown, preloadPublicMarkdown, resolvePublicMarkdown } = await import("../public-context.js");
  expect(listPublicMarkdown()).toEqual([]);

  const blueprint = parseSkillBlueprint(`
    export default function Billing() {
      return ready ? <Text src="billing/inactive.md" /> : <Text src="overview.md" />;
    }
  `);
  const inactive = blueprint.nodes[0].sections?.find((section) => section.id === "true")?.children[0];
  expect(inactive).toMatchObject({ kind: "context", label: "billing/inactive.md" });

  // Loading follows the host index even while the skill renders the other branch.
  await preloadPublicMarkdown(pageBase(root));
  expect(resolvePublicMarkdown(inactive!.label)).toBe(content);
  expect(fetch.mock.calls.map(([path]) => path)).toEqual([
    "/embedded/context.index.json", "/embedded/overview.md", "/embedded/billing/inactive.md",
  ]);

  content = "# Updated before activation";
  await preloadPublicMarkdown(pageBase(root));
  expect(resolvePublicMarkdown("billing/inactive.md")).toBe(content);
});

it("keeps the newest embedded markdown when an older request finishes last", async () => {
  vi.stubGlobal("window", {});
  let finishOlder!: (response: Response) => void;
  const delayed = new Promise<Response>((resolve) => { finishOlder = resolve; });
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json(["billing.md"]))
    .mockReturnValueOnce(delayed)
    .mockResolvedValueOnce(Response.json(["billing.md"]))
    .mockResolvedValueOnce(new Response("# Current"));
  vi.stubGlobal("fetch", fetch);
  const { preloadPublicMarkdown, resolvePublicMarkdown } = await import("../public-context.js");

  const older = preloadPublicMarkdown("/embedded");
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await preloadPublicMarkdown("/embedded");
  finishOlder(new Response("# Old"));
  await older;

  expect(resolvePublicMarkdown("billing.md")).toBe("# Current");
});
