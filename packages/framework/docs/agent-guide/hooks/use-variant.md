# `useVariant`

This call's variant of an experiment, or `undefined` where no variants are assigned
([Goals and experiments](../goals-and-experiments.md)).

```ts
import { useVariant } from "curb";

function useVariant(experiment: string): string | undefined;
```

## Example

```tsx
function Greeting() {
  const greeting = useVariant("greeting");
  return <Instruction>{greeting === "short" ? "Greet in three words." : "Greet warmly."}</Instruction>;
}
```

## Version history

| Version | Changes |
|---|---|
| v1.8.0 | `useVariant` introduced |
