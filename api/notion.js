module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token, pageId, action } = req.body;
  if (!token || !pageId) return res.status(400).json({ error: 'Missing token or pageId' });

  const NOTION_BASE = 'https://api.notion.com/v1';
  const HEADERS = {
    'Authorization': 'Bearer ' + token,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };

  async function get(path) {
    const r = await fetch(NOTION_BASE + path, { headers: HEADERS });
    const d = await r.json();
    if (!r.ok) throw new Error('Notion ' + r.status + ': ' + (d.message || ''));
    return d;
  }

  function getText(blocks) {
    let t = '';
    for (const b of blocks) {
      const bd = b[b.type];
      if (bd && bd.rich_text) t += bd.rich_text.map(x => x.plain_text || '').join('') + '\n';
      if (b.type === 'child_page') t += '[子頁面: ' + (bd.title || '') + ']\n';
    }
    return t;
  }

  async function getChildren(id) {
    const pages = [];
    let cursor = null;
    do {
      const url = '/blocks/' + id + '/children?page_size=100' + (cursor ? '&start_cursor=' + cursor : '');
      const d = await get(url);
      for (const b of d.results) {
        if (b.type === 'child_page') pages.push({ id: b.id, title: b.child_page.title || '未命名' });
      }
      cursor = d.next_cursor;
    } while (cursor);
    return pages;
  }

  async function getContent(id) {
    let text = '';
    let cursor = null;
    do {
      const url = '/blocks/' + id + '/children?page_size=100' + (cursor ? '&start_cursor=' + cursor : '');
      const d = await get(url);
      text += getText(d.results);
      cursor = d.next_cursor;
    } while (cursor);
    return text;
  }

  try {
    const children = await getChildren(pageId);
    const mainPage = await get('/pages/' + pageId);
    const mainTitle = (mainPage.properties?.title?.title?.[0]?.plain_text) || '內科主頁面';
    const allPages = [{ id: pageId, title: mainTitle }, ...children];

    const results = [];
    for (const pg of allPages) {
      try {
        const content = await getContent(pg.id);
        if (content.trim().length > 20) results.push({ id: pg.id, title: pg.title, content: content.trim() });
      } catch (e) { /* skip */ }
    }

    return res.status(200).json({ success: true, pages: results });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
