import { describe, expect, it } from "vitest";
import { parseSkillBlueprint } from "./skill-blueprint.js";
import { lockReasons } from "./skill-lock.js";

describe("why a skill is locked", () => {
  it("names the skill that links to it and the condition the link waits for", () => {
    const blueprints = new Map([
      [
        "/member-portal",
        parseSkillBlueprint(
          `export default function P() { const [verified] = useState(false);
            return verified ? <Skill path="/member-portal/priority-claim">Priority claim</Skill> : <Text>Locked</Text>; }`,
        ),
      ],
      [
        "/claim-status",
        parseSkillBlueprint(
          `export default function S() { const found = useLookup();
            return <>{!found ? <Skill path="/member-portal/priority-claim">Priority claim</Skill> : null}</>; }`,
        ),
      ],
    ]);

    expect(lockReasons("/member-portal/priority-claim", blueprints)).toEqual([
      { from: "/member-portal", when: { kind: "condition", source: "verified", holds: true } },
      { from: "/claim-status", when: { kind: "condition", source: "found", holds: false } },
    ]);
  });

  it("names the part of a block a link sits in when no condition is involved", () => {
    const blueprints = new Map([
      [
        "/claims",
        parseSkillBlueprint(
          `export default () => <Procedure title="File a claim">
            <Step title="Safety"><Text>Is everyone safe?</Text></Step>
            <Step title="Intake"><Skill path="/claims/upload">Upload</Skill></Step>
          </Procedure>;`,
        ),
      ],
    ]);

    const reasons = lockReasons("/claims/upload", blueprints);
    expect(reasons).toHaveLength(1);
    expect(reasons[0].from).toBe("/claims");
    expect(reasons[0].when.kind).toBe("section");
  });

  it("finds nothing for a skill linked without a condition", () => {
    const blueprints = new Map([["/", parseSkillBlueprint(`export default () => <Skill path="/faq">FAQ</Skill>;`)]]);
    expect(lockReasons("/faq", blueprints)).toEqual([]);
  });
});
