export type CheckKey =
  | "reproduced"
  | "tests-run"
  | "tests-pass"
  | "traced-the-code"
  | "confirmed-by-second-agent";

export type CheckResult = { result: "yes" | "no"; note: string };
export type Checks = Record<CheckKey, CheckResult>;

export const CHECK_KEYS: readonly CheckKey[] = [
  "reproduced",
  "tests-run",
  "tests-pass",
  "traced-the-code",
  "confirmed-by-second-agent",
];

export function isCompleteChecks(value: unknown): value is Checks {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return CHECK_KEYS.every((key) => {
    const entry = v[key] as CheckResult | undefined;
    return (
      !!entry &&
      (entry.result === "yes" || entry.result === "no") &&
      typeof entry.note === "string" &&
      entry.note.trim().length > 0
    );
  });
}
