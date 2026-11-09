/**
 * Reads an integer token at a JSON object/array path without converting it to
 * JavaScript Number. Callers must JSON.parse the document first to validate it.
 */
export function extractJsonIntegerToken(
  json: string,
  path: readonly (string | number)[]
): string | undefined {
  if (!Array.isArray(path) || path.length === 0) return undefined;
  return extractAt(json, skipWhitespace(json, 0), path);
}

function extractAt(json: string, start: number, path: readonly (string | number)[]): string | undefined {
  if (path.length === 0) {
    const end = primitiveEnd(json, start);
    const token = json.slice(start, end);
    return /^(?:0|[1-9]\d*)$/.test(token) ? token : undefined;
  }

  const part = path[0];
  if (typeof part === "string") {
    if (json[start] !== "{") return undefined;
    let cursor = start + 1;
    let found = false;
    let result: string | undefined;
    while (true) {
      cursor = skipWhitespace(json, cursor);
      if (json[cursor] === "}") return found ? result : undefined;
      const keyEnd = stringEnd(json, cursor);
      if (keyEnd < 0) return undefined;
      let key: unknown;
      try { key = JSON.parse(json.slice(cursor, keyEnd)); } catch { return undefined; }
      cursor = skipWhitespace(json, keyEnd);
      if (json[cursor] !== ":") return undefined;
      cursor = skipWhitespace(json, cursor + 1);
      if (key === part) {
        if (found) return undefined;
        found = true;
        result = extractAt(json, cursor, path.slice(1));
      }
      const next = skipJsonValue(json, cursor);
      if (next < 0) return undefined;
      cursor = skipWhitespace(json, next);
      if (json[cursor] === ",") { cursor++; continue; }
      if (json[cursor] === "}") return found ? result : undefined;
      return undefined;
    }
  }

  if (!Number.isSafeInteger(part) || part < 0 || json[start] !== "[") return undefined;
  let cursor = start + 1;
  let index = 0;
  while (true) {
    cursor = skipWhitespace(json, cursor);
    if (json[cursor] === "]") return undefined;
    if (index === part) return extractAt(json, cursor, path.slice(1));
    const next = skipJsonValue(json, cursor);
    if (next < 0) return undefined;
    cursor = skipWhitespace(json, next);
    if (json[cursor] === ",") { cursor++; index++; continue; }
    return undefined;
  }
}

function skipWhitespace(value: string, start: number): number {
  while (start < value.length && /\s/.test(value[start]!)) start++;
  return start;
}

function stringEnd(value: string, start: number): number {
  if (value[start] !== '"') return -1;
  for (let index = start + 1; index < value.length; index++) {
    if (value[index] === "\\") { index++; continue; }
    if (value[index] === '"') return index + 1;
  }
  return -1;
}

function primitiveEnd(value: string, start: number): number {
  let end = start;
  while (end < value.length && !/[\s,}\]]/.test(value[end]!)) end++;
  return end;
}

function skipComposite(value: string, start: number): number {
  const first = value[start];
  if (first !== "{" && first !== "[") return -1;
  const stack: string[] = [first === "{" ? "}" : "]"];
  let inString = false;
  for (let index = start + 1; index < value.length; index++) {
    const character = value[index]!;
    if (inString) {
      if (character === "\\") index++;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") stack.push(character === "{" ? "}" : "]");
    else if (character === "}" || character === "]") {
      if (stack.pop() !== character) return -1;
      if (stack.length === 0) return index + 1;
    }
  }
  return -1;
}

function skipJsonValue(value: string, start: number): number {
  const character = value[start];
  if (character === '"') return stringEnd(value, start);
  if (character === "{" || character === "[") return skipComposite(value, start);
  const end = primitiveEnd(value, start);
  return end > start ? end : -1;
}
