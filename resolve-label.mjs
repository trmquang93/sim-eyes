import { choice, TypeSafeClient } from "@typesafe-ai/sdk";

const CONFIDENCE_MIN = 0.7;
let typesafeCallCount = 0;

export function getTypesafeCallCount() {
  return typesafeCallCount;
}

export function resetTypesafeCallCount() {
  typesafeCallCount = 0;
}

function exactMatches(label, targets) {
  const needle = label.trim().toLowerCase();
  return targets.filter((t) => t.label.trim().toLowerCase() === needle);
}

export async function resolveLabel(label, targets, { allowExact = true } = {}) {
  if (allowExact) {
    const exact = exactMatches(label, targets);
    if (exact.length === 1) {
      return { target: exact[0], typesafeUsed: false, path: "snapshot-exact" };
    }
  }

  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey || targets.length === 0) {
    return { target: null, typesafeUsed: false, path: "unresolved" };
  }

  const criteria = { none: "No on-screen control matches the requested label." };
  for (const t of targets) {
    criteria[String(t.n)] = `${t.label} at point (${t.x}, ${t.y})`;
  }

  const client = new TypeSafeClient({ apiKey });
  typesafeCallCount += 1;
  const response = await client.systemOne({
    state: {
      requestedLabel: label,
      controls: targets.map((t) => ({
        n: t.n,
        label: t.label,
        point: { x: t.x, y: t.y },
      })),
    },
    questions: {
      pick: choice(
        "Which numbered control is the one the user wants to tap?",
        criteria
      ),
    },
  });

  const answer = response.answers.pick;
  if (
    answer.choice === "none" ||
    answer.confidence < CONFIDENCE_MIN
  ) {
    return { target: null, typesafeUsed: true, path: "typesafe-none" };
  }

  const picked = targets.find((t) => String(t.n) === answer.choice);
  if (!picked) {
    return { target: null, typesafeUsed: true, path: "typesafe-invalid" };
  }

  return { target: picked, typesafeUsed: true, path: "typesafe" };
}
