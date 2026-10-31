import { Instruction, Text } from "curb";
import { useCase } from "../store.js";

export const meta = { title: "Contract", description: "Questions about the caller's plan." };

export default function Contract() {
  const customer = useCase((state) => state.customer);
  return (
    <>
      <Instruction>Answer questions about the plan below. Say the caller's name once.</Instruction>
      <Text>{`Caller: ${customer?.name}. Plan: ${customer?.plan}.`}</Text>
    </>
  );
}
