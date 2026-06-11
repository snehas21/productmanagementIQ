import express from 'express';
import { readFileSync, existsSync, mkdirSync, createWriteStream } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { promisify } from 'util';
import FlexSearch from 'flexsearch';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ── BUNDLED CURATED DATA (20 episodes, always available instantly) ──
const bundledEpisodes = JSON.parse(readFileSync('./data/episodes.json', 'utf8'));

// ── TRANSCRIPT STORE ──
const TRANSCRIPTS_DIR = join(__dirname, 'transcripts');
const GITHUB_ZIP = 'https://github.com/ChatPRD/lennys-podcast-transcripts/archive/refs/heads/main.zip';

let transcriptEpisodes = [];  // { guest, content }
let searchIndex = null;
let indexReady = false;

// ── TRANSCRIPT HELPERS ──

function stripFrontmatter(content) {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('---', 3);
  return end === -1 ? content : content.slice(end + 3).trim();
}

function guestFromFrontmatter(content) {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('---', 3);
  if (end === -1) return null;
  const m = content.slice(0, end).match(/^guest:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

function folderToGuest(folder) {
  return folder.replace(/[-_]\d+$/, '').split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function extractSnippet(content, terms, len = 600) {
  const lower = content.toLowerCase();
  let best = -1;
  for (const t of terms) {
    const pos = lower.indexOf(t.toLowerCase());
    if (pos !== -1 && (best === -1 || pos < best)) best = pos;
  }
  const start = best === -1 ? Math.min(2000, content.length) : Math.max(0, best - 200);
  const end = Math.min(content.length, start + len);
  let snippet = content.slice(start, end);
  if (start > 0) snippet = '…' + snippet;
  if (end < content.length) snippet += '…';
  return snippet.trim();
}

// ── DOWNLOAD + INDEX ──

async function downloadTranscripts() {
  if (existsSync(TRANSCRIPTS_DIR)) {
    const entries = await readdir(TRANSCRIPTS_DIR, { withFileTypes: true });
    if (entries.filter(e => e.isDirectory()).length > 100) {
      console.log('Transcripts already cached.');
      return;
    }
  }

  console.log('Downloading transcripts from GitHub (~9 MB)…');
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

  const zipPath = '/tmp/lenny-transcripts.zip';
  const response = await fetch(GITHUB_ZIP, { headers: { 'User-Agent': 'productmanagementiq/1.0' } });
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);

  const writer = createWriteStream(zipPath);
  const reader = response.body.getReader();
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    writer.write(value);
    bytes += value.length;
  }
  writer.end();
  console.log(`Downloaded ${Math.round(bytes / 1024 / 1024)} MB`);

  const tmp = '/tmp/lenny-extract';
  await execAsync(`rm -rf "${tmp}"`);
  await execAsync(`unzip -o "${zipPath}" -d "${tmp}"`);
  await execAsync(`cp -r "${tmp}/lennys-podcast-transcripts-main/episodes/"* "${TRANSCRIPTS_DIR}/"`);
  await execAsync(`rm -rf "${tmp}" "${zipPath}"`);
  console.log('Transcripts extracted.');
}

async function loadAndIndex() {
  const entries = await readdir(TRANSCRIPTS_DIR, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory());
  console.log(`Indexing ${dirs.length} episodes…`);

  const episodes = [];
  for (const dir of dirs) {
    const path = join(TRANSCRIPTS_DIR, dir.name, 'transcript.md');
    try {
      const raw = await readFile(path, 'utf8');
      const guest = guestFromFrontmatter(raw) || folderToGuest(dir.name);
      const content = stripFrontmatter(raw);
      episodes.push({ guest, content });
    } catch { /* skip dirs without transcript.md */ }
  }

  const idx = new FlexSearch.Document({
    document: { id: 'guest', index: ['guest', 'content'], store: ['guest', 'content'] },
    tokenize: 'forward',
    resolution: 9,
    cache: true,
  });
  for (const ep of episodes) idx.add(ep);

  transcriptEpisodes = episodes;
  searchIndex = idx;
  indexReady = true;
  console.log(`Index ready: ${episodes.length} episodes`);
}

async function initTranscripts() {
  try {
    await downloadTranscripts();
    await loadAndIndex();
  } catch (err) {
    console.error('Transcript init failed, using bundled data:', err.message);
  }
}

initTranscripts();

// ── SEARCH ──

function searchTranscripts(query, limit = 10) {
  if (!indexReady) return [];
  const results = searchIndex.search(query, { limit: limit * 2, enrich: true });
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const seen = new Set();
  const out = [];

  for (const field of results) {
    for (const item of (field.result || [])) {
      const guest = typeof item === 'string' ? item : (item.id || item.doc?.guest);
      if (!guest || seen.has(guest)) continue;
      seen.add(guest);
      const ep = transcriptEpisodes.find(e => e.guest === guest);
      if (!ep) continue;
      out.push({ guest, snippet: extractSnippet(ep.content, terms) });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  return out;
}

function getEpisode(guest) {
  return transcriptEpisodes.find(e => e.guest.toLowerCase().includes(guest.toLowerCase()));
}

// ── BUNDLED SEARCH (curated 20 episodes) ──

function bundledSearch(q) {
  const query = q.toLowerCase();
  const words = query.split(/\s+/).filter(Boolean);
  // Normalize a string for matching: lowercase and replace hyphens/underscores with spaces
  const norm = s => s.toLowerCase().replace(/[-_]/g, ' ');
  const matchesQuery = s => norm(s).includes(query) || words.every(w => norm(s).includes(w));
  const topicMatches = t => norm(t).includes(query) || words.some(w => norm(t).includes(w));

  return bundledEpisodes.filter(ep =>
    matchesQuery(ep.title) ||
    matchesQuery(ep.description) ||
    (ep.topics || []).some(topicMatches) ||
    (ep.key_themes || []).some(t => matchesQuery(t.theme) || matchesQuery(t.description)) ||
    ep.key_insights.some(i =>
      matchesQuery(i.quote) ||
      matchesQuery(i.insight) ||
      (i.topics || []).some(topicMatches)
    )
  ).map(ep => {
    const matched = ep.key_insights.filter(i =>
      matchesQuery(i.quote) ||
      matchesQuery(i.insight) ||
      (i.topics || []).some(topicMatches)
    );
    return { ...ep, _matched_insights: matched.length ? matched : ep.key_insights.slice(0, 3) };
  }).slice(0, 20);
}

// ── REST API ──

app.get('/api/status', (req, res) => {
  res.json({
    ready: indexReady,
    episodes: indexReady ? transcriptEpisodes.length : bundledEpisodes.length,
    source: indexReady ? 'transcripts' : 'bundled',
  });
});

app.get('/api/search', (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ ok: false, error: 'q required' });

  if (indexReady) {
    const results = searchTranscripts(q);
    return res.json({ ok: true, source: 'transcripts', results });
  }
  res.json({ ok: true, source: 'bundled', results: bundledSearch(q) });
});

app.get('/api/episode/:guest', (req, res) => {
  if (indexReady) {
    const ep = getEpisode(req.params.guest);
    if (ep) return res.json({ ok: true, source: 'transcripts', guest: ep.guest, content: ep.content });
  }
  const ep = bundledEpisodes.find(e => e.guest_name.toLowerCase().includes(req.params.guest.toLowerCase()));
  if (!ep) return res.status(404).json({ ok: false, error: 'Not found' });
  res.json({ ok: true, source: 'bundled', data: ep });
});

// Structured curated data (always available for the insights UI)
app.get('/api/data/episodes', (req, res) => res.json(bundledEpisodes));

app.get('/api/data/search', (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  res.json(bundledSearch(q));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ProductManagementIQ on http://localhost:${PORT}`));
