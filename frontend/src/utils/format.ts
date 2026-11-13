export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatJson(value: unknown): string {
  if (value === undefined || value === null) return "No evidence details returned.";
  try { return JSON.stringify(value, null, 2); } catch { return "Evidence details are not displayable."; }
}
