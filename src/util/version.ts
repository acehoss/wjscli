import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let cached: string | null = null;

// Locate package.json regardless of whether we're running from src/ (tests)
// or dist/ (built binary). Both layouts put package.json two levels above
// any file under src/util/ or dist/util/, but the bin entrypoint at dist/
// or src/ is one level above. Walk up until we find one whose `name` is
// "wikijs-mcp".
export function getVersion(): string {
  if (cached !== null) return cached;
  const here = fileURLToPath(import.meta.url);
  let dir = path.dirname(here);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'package.json');
    try {
      const raw = readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (parsed.name === 'wjscli' && typeof parsed.version === 'string') {
        cached = parsed.version;
        return cached;
      }
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cached = '0.0.0';
  return cached;
}
