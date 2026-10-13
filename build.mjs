// Build script for the FB Group Comment Saver extension (SPEC.md §2, §9).
//
//   node build.mjs           one-shot build into dist/
//   node build.mjs --watch   rebuild bundles and re-copy static files on change
//
// Output (load dist/ as the unpacked extension):
//   background.js, sidepanel.js, library.js   esbuild bundles (+ linked source maps)
//   *.html, *.css                             copied flat from src/ui/
//   manifest.json                             src/manifest.json with version from package.json
//   icons/icon{16,32,48,128}.png              generated here (no image dependencies)

import { build, context } from 'esbuild';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const UI_DIR = path.join(SRC, 'ui');
const DIST = path.join(ROOT, 'dist');
const ICON_SIZES = [16, 32, 48, 128];
const STATIC_RE = /\.(html|css)$/;

/** @type {import('esbuild').BuildOptions} */
const ESBUILD_OPTIONS = {
  absWorkingDir: ROOT,
  entryPoints: {
    background: 'src/background/service-worker.js',
    sidepanel: 'src/ui/sidepanel.js',
    library: 'src/ui/library.js',
  },
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome118',
  sourcemap: 'linked',
  // Page functions are serialized with fn.toString() and must stay self-contained;
  // minify/keepNames would rename or wrap their internals (SPEC §2, §4).
  minify: false,
  keepNames: false,
  // Dead require() calls inside the prebuilt playwright-crx bundle that can't be resolved
  // (and are never executed in the extension).
  external: ['../playwright', './bidiOverCdp'],
  logLevel: 'warning',
  metafile: true,
};

// ---------------------------------------------------------------------------------------------
// Build steps

async function buildOnce() {
  const started = performance.now();
  const version = await prepareDist();
  try {
    await build(ESBUILD_OPTIONS);
  } catch (err) {
    // esbuild has already printed the formatted errors (logLevel 'warning').
    console.error(`\nBuild failed (${err?.errors?.length ?? 1} error(s)). Static files, manifest and icons were written to dist/.`);
    process.exit(1);
  }
  await printSummary(version, performance.now() - started);
}

async function watch() {
  const version = await prepareDist();
  let firstBuild = true;
  let started = performance.now();

  const ctx = await context({
    ...ESBUILD_OPTIONS,
    plugins: [
      {
        name: 'summary',
        setup(b) {
          b.onStart(() => {
            started = performance.now();
          });
          b.onEnd(async (result) => {
            const ms = performance.now() - started;
            if (result.errors.length) {
              console.error(`[${clock()}] Bundle failed (${result.errors.length} error(s)); waiting for changes...`);
            } else if (firstBuild) {
              await printSummary(version, ms);
            } else {
              const outputs = Object.keys(result.metafile?.outputs ?? {}).filter((f) => !f.endsWith('.map'));
              console.log(`[${clock()}] Rebuilt ${outputs.map((f) => path.basename(f)).join(', ')} in ${Math.round(ms)} ms`);
            }
            if (firstBuild) console.log('Watching src/ for changes (Ctrl+C to stop).');
            firstBuild = false;
          });
        },
      },
    ],
  });
  await ctx.watch();

  // Static UI files: copy (or remove) the changed file.
  if (fs.existsSync(UI_DIR)) {
    fs.watch(UI_DIR, (_event, filename) => {
      if (!filename || !STATIC_RE.test(filename)) return;
      debounced(filename, async () => {
        const from = path.join(UI_DIR, filename);
        const to = path.join(DIST, filename);
        try {
          if (fs.existsSync(from)) {
            await fsp.copyFile(from, to);
            console.log(`[${clock()}] Copied ${filename}`);
          } else {
            await fsp.rm(to, { force: true });
            console.log(`[${clock()}] Removed ${filename}`);
          }
        } catch (err) {
          console.error(`[${clock()}] Copy of ${filename} failed: ${err.message}`);
        }
      });
    });
  } else {
    console.warn('Warning: src/ui/ does not exist; static files are not being watched.');
  }

  // Manifest edits (watch the directory: editors may replace the file on save).
  fs.watch(SRC, (_event, filename) => {
    if (filename !== 'manifest.json') return;
    debounced(filename, () =>
      writeManifest(version).then(
        () => console.log(`[${clock()}] Wrote manifest.json`),
        (err) => console.error(`[${clock()}] manifest.json: ${err.message}`),
      ),
    );
  });

  const shutdown = async () => {
    await ctx.dispose();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** Run `fn` 50 ms after the last call for `key` (editors emit several events per save). */
const debounceTimers = new Map();
function debounced(key, fn) {
  clearTimeout(debounceTimers.get(key));
  debounceTimers.set(
    key,
    setTimeout(() => {
      debounceTimers.delete(key);
      fn();
    }, 50),
  );
}

/**
 * Clean dist/ and write everything that isn't bundled: manifest, icons, static UI files.
 * @returns {Promise<string>} the extension version written to the manifest
 */
async function prepareDist() {
  await fsp.rm(DIST, { recursive: true, force: true });
  await fsp.mkdir(path.join(DIST, 'icons'), { recursive: true });

  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const version = await writeManifest(pkg.version);

  for (const size of ICON_SIZES) {
    const png = encodePng(size, size, renderIcon(size));
    await fsp.writeFile(path.join(DIST, 'icons', `icon${size}.png`), png);
  }

  const copied = await copyStatic();
  const missing = ['sidepanel.html', 'library.html'].filter((f) => !copied.includes(f));
  if (missing.length) console.warn(`Warning: src/ui/ has no ${missing.join(', ')} yet.`);
  return version;
}

/**
 * @param {string} pkgVersion version from package.json
 * @returns {Promise<string>} the version written
 */
async function writeManifest(pkgVersion) {
  const manifest = JSON.parse(await fsp.readFile(path.join(SRC, 'manifest.json'), 'utf8'));
  manifest.version = toChromeVersion(pkgVersion);
  await fsp.writeFile(path.join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest.version;
}

/** Chrome accepts 1-4 dot-separated integers; drop any semver pre-release/build suffix. */
function toChromeVersion(version) {
  const match = /^\d+(\.\d+){0,3}/.exec(String(version ?? ''));
  if (!match) throw new Error(`package.json version "${version}" is not a valid extension version`);
  return match[0];
}

/** Copy src/ui/*.html and *.css flat into dist/. @returns {Promise<string[]>} copied names */
async function copyStatic() {
  const names = await fsp.readdir(UI_DIR).catch(() => []);
  const copied = names.filter((name) => STATIC_RE.test(name));
  await Promise.all(copied.map((name) => fsp.copyFile(path.join(UI_DIR, name), path.join(DIST, name))));
  return copied;
}

async function printSummary(version, ms) {
  const files = (await listFiles(DIST)).sort((a, b) => sortKey(a.rel).localeCompare(sortKey(b.rel)));
  const maps = files.filter((f) => f.rel.endsWith('.map'));
  const shown = files.filter((f) => !f.rel.endsWith('.map'));
  const width = Math.max(...shown.map((f) => f.rel.length));
  console.log(`Built extension v${version} into dist/ in ${Math.round(ms)} ms`);
  for (const f of shown) console.log(`  ${f.rel.padEnd(width)}  ${formatSize(f.size).padStart(9)}`);
  if (maps.length) {
    const total = maps.reduce((sum, f) => sum + f.size, 0);
    console.log(`  + ${maps.length} source map(s), ${formatSize(total)}`);
  }
}

/** Bundles first, then other top-level files, then icons. */
function sortKey(rel) {
  const group = rel.endsWith('.js') ? 0 : rel.includes('/') ? 2 : 1;
  return `${group}${rel}`;
}

/** @returns {Promise<{rel: string, size: number}[]>} */
async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else out.push({ rel: path.relative(base, full).split(path.sep).join('/'), size: (await fsp.stat(full)).size });
  }
  return out;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function clock() {
  return new Date().toLocaleTimeString();
}

// ---------------------------------------------------------------------------------------------
// PNG encoder (RGBA, 8 bits per channel, no interlace, filter type 0 on every row)

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (ISO-HDLC), as required for PNG chunks. @param {Uint8Array} bytes */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC over type + data. */
function pngChunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  typeAndData.copy(out, 4);
  out.writeUInt32BE(crc32(typeAndData), 8 + data.length);
  return out;
}

/**
 * Encode straight-alpha RGBA pixels as a PNG file.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba width*height*4 bytes, row-major
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor + alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method 0
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type byte (0 = None).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Icon drawing: rounded blue square, white speech bubble, blue down-arrow ("save") glyph.
// Shapes are defined in unit coordinates and rendered with supersampling for anti-aliasing.

const BLUE = [0x18, 0x77, 0xf2]; // #1877F2
const WHITE = [0xff, 0xff, 0xff];

/** Signed distance from (px, py) to a rounded rectangle; <= 0 means inside. */
function sdRoundRect(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfH - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function inRect(px, py, x0, y0, x1, y1) {
  return px >= x0 && px <= x1 && py >= y0 && py <= y1;
}

function inTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Color at tile coordinates (x, y) in [0,1]² (the blue square fills the tile), or null if transparent.
 * @param {boolean} detailed draw the small "tray" under the arrow (skipped at 16px where it would blur)
 */
function iconColorAt(x, y, detailed) {
  if (sdRoundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) > 0) return null;

  const inBubble =
    sdRoundRect(x, y, 0.5, 0.45, 0.32, 0.25, 0.13) <= 0 ||
    inTriangle(x, y, [0.27, 0.6], [0.47, 0.65], [0.22, 0.86]); // tail, bottom-left
  if (!inBubble) return BLUE;

  const inGlyph = detailed
    ? inRect(x, y, 0.45, 0.27, 0.55, 0.45) || // shaft
      inTriangle(x, y, [0.34, 0.41], [0.66, 0.41], [0.5, 0.57]) || // head
      sdRoundRect(x, y, 0.5, 0.615, 0.17, 0.028, 0.028) <= 0 // tray
    : inRect(x, y, 0.43, 0.25, 0.57, 0.46) || inTriangle(x, y, [0.29, 0.42], [0.71, 0.42], [0.5, 0.64]);
  return inGlyph ? BLUE : WHITE;
}

/**
 * Render the icon as straight-alpha RGBA pixels.
 * @param {number} size width and height in pixels
 * @param {number} [samples] supersampling grid per pixel axis
 * @returns {Uint8Array}
 */
export function renderIcon(size, samples = 8) {
  // Chrome's guideline for the 128px icon is ~96px of artwork with transparent padding;
  // keep small toolbar sizes full-bleed so they stay legible.
  const inset = size >= 128 ? 8 / 128 : size >= 48 ? 2 / 48 : 0;
  const scale = 1 - 2 * inset;
  const detailed = size >= 32;
  const out = new Uint8Array(size * size * 4);
  const total = samples * samples;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let covered = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const u = (px + (sx + 0.5) / samples) / size;
          const v = (py + (sy + 0.5) / samples) / size;
          const color = iconColorAt((u - inset) / scale, (v - inset) / scale, detailed);
          if (!color) continue;
          covered++;
          r += color[0];
          g += color[1];
          b += color[2];
        }
      }
      const i = (py * size + px) * 4;
      if (covered) {
        // All shapes are opaque, so the straight color is the mean over covered samples.
        out[i] = Math.round(r / covered);
        out[i + 1] = Math.round(g / covered);
        out[i + 2] = Math.round(b / covered);
        out[i + 3] = Math.round((covered / total) * 255);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Entry point. Kept last so every module-level constant is initialized before a build starts;
// importing this file (e.g. to test encodePng/renderIcon) does not run a build.

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const watchMode = process.argv.includes('--watch');
  (watchMode ? watch() : buildOnce()).catch((err) => {
    console.error(`Build failed: ${err?.stack || err}`);
    process.exit(1);
  });
}
