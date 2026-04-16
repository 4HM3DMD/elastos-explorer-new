#!/usr/bin/env node

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGO_JSON_URL = 'https://api.elastos.io/images/logo.json';
const IMAGE_BASE_URL = 'https://api.elastos.io/images/';
const OUT_DIR = join(__dirname, '..', 'public', 'static', 'validator-logos');
const IMAGES_DIR = join(OUT_DIR, 'images');

mkdirSync(IMAGES_DIR, { recursive: true });

async function main() {
  console.log('Fetching logo.json ...');
  const res = await fetch(LOGO_JSON_URL);
  if (!res.ok) throw new Error(`Failed to fetch logo.json: ${res.status}`);
  const data = await res.json();

  writeFileSync(join(OUT_DIR, 'logo.json'), JSON.stringify(data, null, 2));
  console.log(`Saved logo.json (${Object.keys(data).length} entries)`);

  const entries = Object.entries(data).filter(([, v]) => v.logo);
  const unique = [...new Set(entries.map(([, v]) => v.logo))];
  console.log(`Downloading ${unique.length} unique images ...`);

  let ok = 0;
  let fail = 0;

  for (const filename of unique) {
    const dest = join(IMAGES_DIR, filename);
    if (existsSync(dest)) {
      ok++;
      continue;
    }
    try {
      const imgRes = await fetch(IMAGE_BASE_URL + encodeURIComponent(filename));
      if (!imgRes.ok) {
        console.warn(`  SKIP ${filename}: HTTP ${imgRes.status}`);
        fail++;
        continue;
      }
      const buf = Buffer.from(await imgRes.arrayBuffer());
      writeFileSync(dest, buf);
      ok++;
      process.stdout.write(`  ✓ ${filename}\n`);
    } catch (err) {
      console.warn(`  FAIL ${filename}: ${err.message}`);
      fail++;
    }
  }

  console.log(`\nDone: ${ok} downloaded, ${fail} failed.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
