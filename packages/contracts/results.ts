import { digest, requireValue } from "./index.ts";

export const RESULT_BODY_LIMIT = 12 * 1024 * 1024;

/** Limit the final UTF-8 JSON request, including escaping and envelope overhead.
 * Only display text is shortened. Checks, revisions, IDs and native cursors stay exact.
 * The caller must durably save the full result at localFile before queuing this copy. */
export function boundResultPayload<T extends { body?: any; result?: any }>(input: T, localFile: string, limit = RESULT_BODY_LIMIT): T {
  const output = structuredClone(input), content = output.body ?? output.result;
  if (Buffer.byteLength(JSON.stringify(output)) <= limit) return output;
  const fields: { object: any; key: string; path: string; original: string }[] = [];
  const add = (object: any, key: string, path: string) => {
    if (typeof object?.[key] === "string") fields.push({ object, key, path, original: object[key] });
  };
  for (const key of ["diff", "stat", "finalResponse"]) add(content, key, key);
  for (const [i, check] of (content.checks ?? []).entries())
    for (const key of ["stdout", "stderr"]) add(check, key, `checks.${i}.${key}`);
  content.truncation = { localFile, fields: [] as any[] };
  while (Buffer.byteLength(JSON.stringify(output)) > limit) {
    fields.sort((a, b) => b.object[b.key].length - a.object[a.key].length);
    const field = fields[0];
    requireValue(field && field.object[field.key].length > 0, "RESULT_METADATA_TOO_LARGE", "Result metadata exceeds the upload limit");
    const text = field.object[field.key] as string;
    let end = Math.floor(text.length / 2);
    if (end && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    field.object[field.key] = text.slice(0, end);
    content.truncation.fields = fields.filter(f => f.original !== f.object[f.key]).map(f => ({
      path: f.path, originalBytes: Buffer.byteLength(f.original), retainedBytes: Buffer.byteLength(f.object[f.key]), sha256: digest(f.original),
    }));
  }
  return output;
}
