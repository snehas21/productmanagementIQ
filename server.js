import express from 'express';
import { readFileSync } from 'fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ── BUNDLED DATA (20 curated episodes, always available) ──
const bundledEpisodes = JSON.parse(readFileSync('./data/episodes.json', 'utf8'));

// ── MCP CLIENT (connects to local lenny-mcp subprocess if running on :3001) ──
const MCP_URL = process.env.MCP_URL || 'http://localhost:3001/mcp';
let mcpAvailable = false;

async function callMCP(toolName, args) {
  const client = new Client({ name: 'productmanagementiq', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  await client.connect(transport);
  try {
    return await client.callTool({ name: toolName, arguments: args });
  } finally {
    await client.close();
  }
}

async function checkMCP() {
  try {
    await callMCP('list_episodes', {});
    mcpAvailable = true;
    console.log('MCP server connected at', MCP_URL);
  } catch {
    mcpAvailable = false;
    console.log('MCP unavailable — using bundled data');
  }
}
checkMCP();

// ── BUNDLED FALLBACK TOOLS ──

function bundledSearch(query) {
  const q = query.toLowerCase();
  const out = [];
  for (const ep of bundledEpisodes) {
    const matched = ep.key_insights.filter(ins =>
      ins.quote.toLowerCase().includes(q) ||
      ins.insight.toLowerCase().includes(q) ||
      ins.context.toLowerCase().includes(q) ||
      (ins.topics || []).some(t => t.toLowerCase().includes(q))
    );
    const topicMatch = (ep.topics || []).some(t => t.toLowerCase().includes(q));
    const titleMatch = ep.title.toLowerCase().includes(q) || ep.description.toLowerCase().includes(q);
    const themeMatch = (ep.key_themes || []).some(t =>
      t.theme.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
    );
    if (matched.length > 0 || topicMatch || titleMatch || themeMatch) {
      out.push({ ...ep, _matched_insights: matched.length > 0 ? matched : ep.key_insights.slice(0, 3) });
    }
  }
  return out.slice(0, 20);
}

// ── REST API ──

app.get('/api/status', (req, res) => {
  res.json({ mcp: mcpAvailable, bundled: bundledEpisodes.length, mcpUrl: MCP_URL });
});

// MCP-proxied endpoints (fall back to bundled data)
app.get('/api/episodes', async (req, res) => {
  try {
    if (mcpAvailable) {
      const result = await callMCP('list_episodes', {});
      res.json({ ok: true, source: 'mcp', data: result });
    } else {
      const lines = bundledEpisodes.map(ep => `${ep.guest_name} — ${ep.title}`).join('\n');
      res.json({ ok: true, source: 'bundled', data: { content: [{ type: 'text', text: lines }] } });
    }
  } catch (err) {
    mcpAvailable = false;
    const lines = bundledEpisodes.map(ep => `${ep.guest_name} — ${ep.title}`).join('\n');
    res.json({ ok: true, source: 'bundled', data: { content: [{ type: 'text', text: lines }] } });
  }
});

app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ ok: false, error: 'q required' });
  try {
    if (mcpAvailable) {
      const result = await callMCP('search_transcripts', { query: q });
      res.json({ ok: true, source: 'mcp', data: result });
    } else {
      throw new Error('MCP unavailable');
    }
  } catch {
    mcpAvailable = false;
    const text = bundledEpisodes
      .filter(ep => ep.title.toLowerCase().includes(q.toLowerCase()) || (ep.topics||[]).some(t=>t.toLowerCase().includes(q.toLowerCase())))
      .map(ep => `## ${ep.guest_name}\n**${ep.title}**`)
      .join('\n\n');
    res.json({ ok: true, source: 'bundled', data: { content: [{ type: 'text', text }] } });
  }
});

app.get('/api/episode/:guest', async (req, res) => {
  const { guest } = req.params;
  try {
    if (mcpAvailable) {
      const result = await callMCP('get_episode', { guest });
      res.json({ ok: true, source: 'mcp', data: result });
    } else {
      throw new Error('MCP unavailable');
    }
  } catch {
    mcpAvailable = false;
    const ep = bundledEpisodes.find(e => e.guest_name.toLowerCase().includes(guest.toLowerCase()));
    if (!ep) return res.json({ ok: false, error: 'Not found' });
    res.json({ ok: true, source: 'bundled', data: { content: [{ type: 'text', text: ep.key_insights.map(i => `• "${i.quote}"\n  → ${i.insight}`).join('\n\n') }] } });
  }
});

// Structured data endpoints (always use bundled data for UI)
app.get('/api/data/episodes', (req, res) => res.json(bundledEpisodes));

app.get('/api/data/search', (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  res.json(bundledSearch(q));
});

// MCP raw search — returns transcript excerpts from all 303 episodes
app.get('/api/mcp/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ ok: false, error: 'q required' });
  if (!mcpAvailable) return res.json({ ok: false, error: 'MCP not available', fallback: bundledSearch(q) });
  try {
    const result = await callMCP('search_transcripts', { query: q });
    res.json({ ok: true, data: result });
  } catch (err) {
    mcpAvailable = false;
    res.json({ ok: false, error: err.message, fallback: bundledSearch(q) });
  }
});

app.get('/api/mcp/episode/:guest', async (req, res) => {
  const { guest } = req.params;
  if (!mcpAvailable) return res.json({ ok: false, error: 'MCP not available' });
  try {
    const result = await callMCP('get_episode', { guest });
    res.json({ ok: true, data: result });
  } catch (err) {
    mcpAvailable = false;
    res.json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ProductManagementIQ running on http://localhost:${PORT}`));
