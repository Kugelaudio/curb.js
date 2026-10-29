import { describe, expect, it } from "vitest";
import {
  parseSkillBlueprint,
  resolveSegmentValues,
  skillLinkAvailability,
  type BlueprintNode,
} from "./skill-blueprint.js";

/** Flatten to (kind, label) tuples for compact assertions — descends into
 * children and block sections. */
function flat(nodes: BlueprintNode[]): Array<{ kind: string; label: string }> {
  return nodes.flatMap((node) => [
    { kind: node.kind, label: node.label },
    ...flat(node.children),
    ...flat((node.sections ?? []).flatMap((section) => section.children)),
  ]);
}

/** The one block node in a parsed source, for the single-decision cases. */
function onlyBlock(source: string): BlueprintNode {
  const block = parseSkillBlueprint(source).nodes.find((node) => node.kind === "block");
  if (!block) throw new Error("expected a block node");
  return block;
}

function section(block: BlueprintNode, id: string) {
  return block.sections?.find((candidate) => candidate.id === id);
}

describe("parseSkillBlueprint", () => {
  it("expands a ternary into ONE if-block with both sides as sections", () => {
    const source = `
      import { Page, Text, Tool, Context } from "../../../index.js";
      export default function PropertyDamagePage() {
        const { procedureComplete } = useClaimState();
        return (
          <Page title="Property damage">
            <Instruction>Help the user report property damage.</Instruction>
            <Text src="property-damage/intake-checklist.md" />
            {procedureComplete ? (
              <Tool name="submit_property_damage_claim" description="Submit." />
            ) : (
              <Text>Claim intake is locked.</Text>
            )}
          </Page>
        );
      }
    `;
    const { nodes } = parseSkillBlueprint(source);

    // Unconditional affordances stay at the top level, NOT inside a section.
    expect(nodes.filter((node) => node.kind !== "block").map((node) => node.kind)).toEqual([
      "instruction",
      "context",
    ]);

    // The condition is one decision: same shape a <Gate> emits.
    const decision = onlyBlock(source);
    expect(decision).toMatchObject({
      kind: "block",
      block: "if",
      label: "procedureComplete",
      relation: "oneOf",
    });
    // The gated tool is present EVEN THOUGH procedureComplete is never true here.
    expect(flat(section(decision, "true")?.children ?? [])).toEqual([
      { kind: "tool", label: "submit_property_damage_claim" },
    ]);
    expect(flat(section(decision, "false")?.children ?? [])).toEqual([
      { kind: "text", label: "Claim intake is locked." },
    ]);
  });

  it("keys the sections by the bare test, so `!x ? a : b` pairs with `x ? b : a`", () => {
    const negated = onlyBlock(`
      export default function P() {
        return (
          <Page title="Member portal">
            {!profile ? (
              <Tool name="verify_member_email" description="Verify." />
            ) : (
              <Text>Signed in.</Text>
            )}
          </Page>
        );
      }
    `);
    const plain = onlyBlock(`
      export default function P() {
        return (
          <Page title="Member portal">
            {profile ? (
              <Text>Signed in.</Text>
            ) : (
              <Tool name="verify_member_email" description="Verify." />
            )}
          </Page>
        );
      }
    `);

    // Both spellings describe the SAME decision, so they produce the same tree.
    expect(negated.label).toBe("profile");
    expect(negated).toEqual(plain);
    expect(flat(section(negated, "true")?.children ?? [])).toEqual([
      { kind: "text", label: "Signed in." },
    ]);
    expect(flat(section(negated, "false")?.children ?? [])).toEqual([
      { kind: "tool", label: "verify_member_email" },
    ]);
  });

  it("gives a one-sided condition exactly one section", () => {
    const guard = onlyBlock(`
      export default function P() {
        return <Page title="P">{callerPhone && <Text>Calling from a number.</Text>}</Page>;
      }
    `);
    expect(guard).toMatchObject({ block: "if", label: "callerPhone", relation: "oneOf" });
    expect(guard.sections?.map((candidate) => candidate.id)).toEqual(["true"]);

    // `{cond ? a : null}` is the same decision written differently.
    const ternary = onlyBlock(`
      export default function P() {
        return <Page title="P">{callerPhone ? <Text>Calling from a number.</Text> : null}</Page>;
      }
    `);
    expect(ternary).toEqual(guard);
  });

  it("puts an `||` fallback on the falsy side", () => {
    const fallback = onlyBlock(`
      export default function P() {
        return <Page title="P">{profile || <Tool name="verify" description="Verify." />}</Page>;
      }
    `);
    expect(fallback.sections?.map((candidate) => candidate.id)).toEqual(["false"]);
    expect(flat(section(fallback, "false")?.children ?? [])).toEqual([
      { kind: "tool", label: "verify" },
    ]);
  });

  it("nests conditions instead of accumulating a flat condition list", () => {
    const outer = onlyBlock(`
      export default function P() {
        return (
          <Page title="P">
            {verified ? (
              <>{isAdmin ? <Tool name="admin_tool" description="Admin." /> : null}</>
            ) : null}
          </Page>
        );
      }
    `);
    expect(outer.label).toBe("verified");
    const inner = section(outer, "true")?.children.find((node) => node.kind === "block");
    expect(inner).toMatchObject({ block: "if", label: "isAdmin" });
    expect(flat(section(inner!, "true")?.children ?? [])).toEqual([
      { kind: "tool", label: "admin_tool" },
    ]);
  });

  it("marks a constant condition's dead side unreachable", () => {
    const never = onlyBlock(`
      export default function P() {
        return <Page title="P">{false && <Tool name="dead_tool" description="Dead." />}</Page>;
      }
    `);
    expect(section(never, "true")?.unreachable).toBe(true);

    const always = onlyBlock(`
      export default function P() {
        return <Page title="P">{true ? <Text>Live.</Text> : <Text>Dead.</Text>}</Page>;
      }
    `);
    expect(section(always, "true")?.unreachable).toBeUndefined();
    expect(section(always, "false")?.unreachable).toBe(true);
  });

  it("emits nothing for a condition that contains no affordances", () => {
    const source = `
      export default function P() {
        return <Page title="P">{count > 0 ? "yes" : "no"}</Page>;
      }
    `;
    expect(parseSkillBlueprint(source).nodes).toEqual([]);
  });

  it("expands a <Procedure> into one block node with its steps as sequence sections", () => {
    const source = `
      export default function ClaimProcedurePage() {
        return (
          <Page title="Claim procedure">
            <Procedure title="Three-step order" advanceTool={{ name: "advance" }}>
              <Step title="Confirm safety">Body one.</Step>
              <Step title="Collect evidence">Body two.</Step>
            </Procedure>
          </Page>
        );
      }
    `;
    const { nodes } = parseSkillBlueprint(source);
    const procedure = nodes.find((node) => node.kind === "block");
    expect(procedure).toMatchObject({
      block: "procedure",
      label: "Three-step order",
      relation: "sequence",
    });
    expect(
      procedure?.sections?.map((section) => ({ id: section.id, label: section.label })),
    ).toEqual([
      { id: "step-1", label: "Confirm safety" },
      { id: "step-2", label: "Collect evidence" },
    ]);
  });

  it("shows a procedure's `completed` outcome as the sequence's final section", () => {
    const source = `
      export default function P() {
        return (
          <Procedure
            title="Order"
            advanceTool={{ name: "advance" }}
            completed={
              <>
                <Text>All done. Submit below.</Text>
                <Tool name="submit_prepared_claim" description="Submit." onSubmit={submit} />
              </>
            }
          >
            <Step title="One">Body.</Step>
          </Procedure>
        );
      }
    `;
    const procedure = parseSkillBlueprint(source).nodes.find((node) => node.kind === "block");
    const completed = procedure?.sections?.find((section) => section.id === "completed");
    expect(procedure?.sections?.map((section) => section.id)).toEqual(["step-1", "completed"]);
    expect(flat(completed?.children ?? [])).toContainEqual(
      expect.objectContaining({ kind: "tool", label: "submit_prepared_claim" }),
    );
    expect(flat(completed?.children ?? [])).toContainEqual(
      expect.objectContaining({ kind: "text", label: "All done. Submit below." }),
    );
  });

  it("expands a .map() into a repeated section", () => {
    const source = `
      export default function ListPage() {
        return (
          <Page title="List">
            {items.map((item) => (
              <Skill path={item.path}>{item.label}</Skill>
            ))}
          </Page>
        );
      }
    `;
    const { nodes } = parseSkillBlueprint(source);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: "block", block: "each", label: "items", relation: "each" });
    expect(nodes[0].sections?.[0]?.children).toMatchObject([
      { kind: "skill", label: "item.label", to: "item.path" },
    ]);
  });

  it("captures literal-vs-dynamic segments of templated text", () => {
    const source = `
      export default function P() {
        return (
          <Page title="P">
            <Text>Static only.</Text>
            <Text>Signed in as {profile.email}. Member {profile.id}.</Text>
          </Page>
        );
      }
    `;
    const nodes = parseSkillBlueprint(source).nodes;
    // Purely literal text carries no segments (nothing to highlight).
    expect(nodes[0].segments).toBeUndefined();
    // Templated text splits into literal + {expr} segments.
    expect(nodes[1].segments).toEqual([
      { text: "Signed in as ", dynamic: false },
      { text: "profile.email", dynamic: true },
      { text: ". Member ", dynamic: false },
      { text: "profile.id", dynamic: true },
      { text: ".", dynamic: false },
    ]);
  });

  it("captures plain JSX text as factual content", () => {
    const source = `
      export default function P() {
        return (
          <>
            Plain factual context without a Text wrapper.
            <Text>Explicit text remains supported.</Text>
          </>
        );
      }
    `;

    expect(parseSkillBlueprint(source).nodes).toEqual([
      {
        kind: "text",
        label: "Plain factual context without a Text wrapper.",
        children: [],
      },
      {
        kind: "text",
        label: "Explicit text remains supported.",
        children: [],
      },
    ]);
  });

  it("treats a literal {\" \"} spacing expression as text, not a template hole", () => {
    const source = `
      export default function P() {
        return (
          <Page title="P">
            <Text>Plan {profile.plan}{" "}since {profile.since}.</Text>
          </Page>
        );
      }
    `;
    const [node] = parseSkillBlueprint(source).nodes;
    // The {" "} folds into the surrounding literal — only real data stays dynamic.
    expect(node.segments?.filter((segment) => segment.dynamic).map((s) => s.text)).toEqual([
      "profile.plan",
      "profile.since",
    ]);
    expect(node.segments?.some((segment) => segment.text.trim() === '" "')).toBe(false);
  });

  it("reads prose written as a template literal as text, with only its ${} parts as holes", () => {
    const source = `
      export default function P() {
        return (
          <>
            <Instruction>{\`
              Ask for the case number and the reason.
            \`}</Instruction>
            <Text>{\`Verified as \${customerNumber}.\`}</Text>
          </>
        );
      }
    `;
    const [instruction, text] = parseSkillBlueprint(source).nodes;
    expect(instruction.segments).toBeUndefined();
    expect(text.segments).toEqual([
      { text: "Verified as ", dynamic: false },
      { text: "customerNumber", dynamic: true },
      { text: ".", dynamic: false },
    ]);
  });

  it("expands a credential check written as plain state into one decision", () => {
    // The member portal's login is an ordinary ternary over local state, not a
    // framework pattern. It produces exactly the shape a pattern block emits.
    const source = `
      export default function P() {
        const [email, setEmail] = useState("");
        return (
          <Page title="Member portal">
            {email ? (
              <>
                <Text>Profile of {email}.</Text>
                <Text src="member/unlocked-context.md" />
              </>
            ) : (
              <>
                <Text>Member content stays locked.</Text>
                <Tool name="verify_member_email" description="Verify." icon="lock" />
              </>
            )}
          </Page>
        );
      }
    `;
    const decision = onlyBlock(source);
    expect(decision).toMatchObject({ block: "if", label: "email", relation: "oneOf" });
    expect(decision.sections?.map((candidate) => candidate.id)).toEqual(["true", "false"]);

    const unverified = flat(section(decision, "false")?.children ?? []);
    expect(unverified).toEqual([
      { kind: "text", label: "Member content stays locked." },
      { kind: "tool", label: "verify_member_email" },
    ]);

    const verified = flat(section(decision, "true")?.children ?? []);
    expect(verified).toContainEqual(
      expect.objectContaining({ kind: "context", label: "member/unlocked-context.md" }),
    );
    expect(
      verified.some((node) => node.kind === "text" && node.label.startsWith("Profile of")),
    ).toBe(true);
  });

  it("classifies skill links: inside any block section = conditional", () => {
    const source = `
      export default function P() {
        return (
          <Page title="Member portal">
            <Skill path="/policy-questions">Policy questions</Skill>
            {isBusinessHours ? <Skill path="/callback">Callback</Skill> : null}
            {verified ? (
              <Skill path="/member-portal/priority-claim">Priority claim</Skill>
            ) : null}
          </Page>
        );
      }
    `;
    const { conditional, unconditional } = skillLinkAvailability(
      parseSkillBlueprint(source).nodes,
    );
    expect(unconditional).toEqual(new Set(["/policy-questions"]));
    expect(conditional).toEqual(new Set(["/callback", "/member-portal/priority-claim"]));
  });

  it("returns an empty blueprint for unparseable source instead of throwing", () => {
    const result = parseSkillBlueprint("export default function ( { <<< ");
    expect(result.nodes).toEqual([]);
    expect(result.parseError).toBeTruthy();
  });
});

describe("resolveSegmentValues", () => {
  const segments = [
    { text: "Signed in as ", dynamic: false },
    { text: "profile.email", dynamic: true },
    { text: ".", dynamic: false },
  ];

  it("extracts the current hole values from the rendered text", () => {
    // The compiler joins JSX text parts with spaces — note the gap before ".".
    const values = resolveSegmentValues(segments, [
      "Some other line.",
      "Signed in as max@example.com .",
    ]);
    expect(values).toEqual(["max@example.com"]);
  });

  it("resolves multiple holes in one line", () => {
    const multi = [
      { text: "Member profile: ", dynamic: false },
      { text: "profile.name", dynamic: true },
      { text: ", member ID ", dynamic: false },
      { text: "profile.memberId", dynamic: true },
      { text: ".", dynamic: false },
    ];
    expect(resolveSegmentValues(multi, ["Member profile: Max , member ID MBR-284719 ."])).toEqual([
      "Max",
      "MBR-284719",
    ]);
  });

  it("returns null when the branch isn't rendered (no candidate matches)", () => {
    expect(resolveSegmentValues(segments, ["Member content stays locked."])).toBeNull();
  });

  it("matches no line for text without words of its own, which would fit any line", () => {
    expect(resolveSegmentValues([{ text: "summary", dynamic: true }], ["Ask for the case number."])).toBeNull();
    const nameOnly = [
      { text: "profile.name", dynamic: true },
      { text: ".", dynamic: false },
    ];
    expect(resolveSegmentValues(nameOnly, ["Ask for the case number."])).toBeNull();
  });
});
