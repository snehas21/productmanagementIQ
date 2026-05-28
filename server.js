import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const app = express();
app.use(express.json());
app.use(express.static('public'));

const MCP_URL = 'https://lenny-mcp.onrender.com/mcp';

async function createMCPClient() {
  const client = new Client({ name: 'productmanagementiq', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  await client.connect(transport);
  return client;
}

async function callTool(toolName, args) {
  const client = await createMCPClient();
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    return result;
  } finally {
    await client.close();
  }
}

app.get('/api/episodes', async (req, res) => {
  try {
    const result = await callTool('list_episodes', {});
    res.json({ ok: true, data: result });
  } catch (err) {
    console.error('list_episodes error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ ok: false, error: 'q parameter required' });
  try {
    const result = await callTool('search_transcripts', { query: q });
    res.json({ ok: true, data: result });
  } catch (err) {
    console.error('search_transcripts error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/episode/:guest', async (req, res) => {
  const { guest } = req.params;
  try {
    const result = await callTool('get_episode', { guest });
    res.json({ ok: true, data: result });
  } catch (err) {
    console.error('get_episode error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ProductManagementIQ running on http://localhost:${PORT}`));
