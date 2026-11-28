import { Instruction, Mcp, type SkillMeta } from "../../../../../index.js";

export const meta: SkillMeta = { title: "Orders" };

/** The orders server, inline: its URL is the test's local server (`ORDERS_MCP_URL`). */
export default function Orders() {
  return (
    <>
      <Instruction>Look the order up before you answer.</Instruction>
      <Mcp id="orders" url={process.env.ORDERS_MCP_URL ?? "http://127.0.0.1:9/mcp"} auth={{ kind: "none" }} />
    </>
  );
}
