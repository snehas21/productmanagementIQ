import express from 'express';
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ── LOCAL DATA (bundled from edisoncruz/lennys-wisdom-mcp) ──
const episodes = JSON.parse(readFileSync('./data/episodes.json', 'utf8'));

// ── MCP-STYLE TOOL IMPLEMENTATIONS ──

function list_episodes() {
  const lines = episodes.map(ep => `${ep.guest_name} — ${ep.title}`);
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

function search_transcripts({ query }) {
  const q = query.toLowerCase();
  const results = [];

  for (const ep of episodes) {
    const matchingInsights = ep.key_insights.filter(ins =>
      ins.quote.toLowerCase().includes(q) ||
      ins.insight.toLowerCase().includes(q) ||
      ins.context.toLowerCase().includes(q) ||
      ins.topics.some(t => t.toLowerCase().includes(q))
    );

    const themeMatch = ep.key_themes?.filter(t =>
      t.theme.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
    ) || [];

    const topicMatch = ep.topics?.some(t => t.toLowerCase().includes(q));
    const titleMatch = ep.title.toLowerCase().includes(q) || ep.description.toLowerCase().includes(q);

    if (matchingInsights.length > 0 || themeMatch.length > 0 || topicMatch || titleMatch) {
      const insightsToShow = matchingInsights.length > 0 ? matchingInsights : ep.key_insights.slice(0, 3);
      results.push({
        guest: ep.guest_name,
        title: ep.title,
        insights: insightsToShow.slice(0, 4),
        themes: themeMatch.slice(0, 2),
        topics: ep.topics,
      });
    }
  }

  if (results.length === 0) {
    return { content: [{ type: 'text', text: `No results found for "${query}"` }] };
  }

  const text = results.slice(0, 12).map(r => {
    const insightLines = r.insights.map(i =>
      `• "${i.quote}"\n  → ${i.insight}`
    ).join('\n\n');
    return `## ${r.guest}\n**${r.title}**\n\n${insightLines}`;
  }).join('\n\n---\n\n');

  return { content: [{ type: 'text', text }] };
}

function get_episode({ guest }) {
  const ep = episodes.find(e =>
    e.guest_name.toLowerCase().includes(guest.toLowerCase()) ||
    e.id.toLowerCase().includes(guest.toLowerCase())
  );

  if (!ep) {
    return { content: [{ type: 'text', text: `Episode not found: ${guest}` }] };
  }

  const insightLines = ep.key_insights.map(i =>
    `• [${i.timestamp}] "${i.quote}"\n  → ${i.insight}`
  ).join('\n\n');

  const themes = ep.key_themes?.map(t => `• ${t.theme}: ${t.description}`).join('\n') || '';

  const text = `# ${ep.guest_name}\n**${ep.title}**\n\n${ep.description}\n\n## Key Themes\n${themes}\n\n## Insights\n${insightLines}`;

  return { content: [{ type: 'text', text }] };
}

// ── REST API ──

app.get('/api/episodes', (req, res) => {
  try {
    res.json({ ok: true, data: list_episodes() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/search', (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ ok: false, error: 'q parameter required' });
  try {
    res.json({ ok: true, data: search_transcripts({ query: q }) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/episode/:guest', (req, res) => {
  try {
    res.json({ ok: true, data: get_episode({ guest: req.params.guest }) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Raw structured data endpoints for the frontend
app.get('/api/data/episodes', (req, res) => res.json(episodes));

app.get('/api/data/search', (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json([]);
  const query = q.toLowerCase();
  const out = [];

  for (const ep of episodes) {
    const matchingInsights = ep.key_insights.filter(ins =>
      ins.quote.toLowerCase().includes(query) ||
      ins.insight.toLowerCase().includes(query) ||
      (ins.topics||[]).some(t => t.toLowerCase().includes(query))
    );
    const topicMatch = ep.topics?.some(t => t.toLowerCase().includes(query));
    const titleMatch = ep.title.toLowerCase().includes(query) || ep.description.toLowerCase().includes(query);
    const themeMatch = ep.key_themes?.some(t =>
      t.theme.toLowerCase().includes(query) || t.description.toLowerCase().includes(query)
    );

    if (matchingInsights.length > 0 || topicMatch || titleMatch || themeMatch) {
      out.push({
        ...ep,
        _matched_insights: matchingInsights.length > 0 ? matchingInsights : ep.key_insights.slice(0, 3),
      });
    }
  }
  res.json(out.slice(0, 20));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ProductManagementIQ running on http://localhost:${PORT}`));
