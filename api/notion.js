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

  // Extract text + collect child page IDs
  function parseBlocks(blocks) {
    let text = '';
    const childPages = [];
    for (const b of blocks) {
      const bd = b[b.type];
      if (!bd) continue;
      if (bd.rich_text) text += bd.rich_text.map(x => x.plain_text || '').join('') + '\n';
      if (b.type === 'child_page') {
        childPages.push({ id: b.id, title: bd.title || '未命名' });
        text += '[子頁面: ' + (bd.title || '') + ']\n';
      }
      if (b.type === 'bulleted_list_item' || b.type === 'numbered_list_item' || b.type === 'toggle') {
        if (bd.rich_text) text += '• ' + bd.rich_text.map(x => x.plain_text || '').join('') + '\n';
      }
      if (b.type === 'heading_1' || b.type === 'heading_2' || b.type === 'heading_3') {
        if (bd.rich_text) text += '\n## ' + bd.rich_text.map(x => x.plain_text || '').join('') + '\n';
      }
    }
    return { text, childPages };
  }

  // Get all blocks of a page (handles pagination)
  async function getAllBlocks(id) {
    let results = [];
    let cursor = null;
    do {
      const url = '/blocks/' + id + '/children?page_size=100' + (cursor ? '&start_cursor=' + cursor : '');
      const d = await get(url);
      results = results.concat(d.results);
      cursor = d.next_cursor;
    } while (cursor);
    return results;
  }

  // Read page content with 2 levels of depth
  async function readPage(id, title, depth = 0) {
    const blocks = await getAllBlocks(id);
    const { text, childPages } = parseBlocks(blocks);

    const result = { id, title, content: text.trim(), children: [] };

    // Read child pages (max depth 2)
    if (depth < 2) {
      for (const cp of childPages) {
        // Skip stat/error pages
        if (cp.title.includes('答題統計') || cp.title.includes('容易答錯')) continue;
        try {
          const child = await readPage(cp.id, cp.title, depth + 1);
          if (child.content.length > 20 || child.children.length > 0) {
            result.children.push(child);
          }
        } catch (e) {
          console.error('Failed child:', cp.title, e.message);
        }
      }
    }

    return result;
  }

  // Flatten page tree into array
  function flattenPages(node, parentTitle = '') {
    const pages = [];
    const fullTitle = parentTitle ? parentTitle + ' > ' + node.title : node.title;

    if (node.content && node.content.length > 30) {
      pages.push({ id: node.id, title: fullTitle, content: node.content });
    }

    for (const child of (node.children || [])) {
      pages.push(...flattenPages(child, node.title));
    }

    return pages;
  }

  try {
    // Get main page title
    const mainPage = await get('/pages/' + pageId);
    const mainTitle =
      mainPage.properties?.title?.title?.[0]?.plain_text ||
      mainPage.properties?.Name?.title?.[0]?.plain_text ||
      '內科';

    // Read full tree
    const tree = await readPage(pageId, mainTitle, 0);
    const pages = flattenPages(tree);

    return res.status(200).json({ success: true, pages });

  } catch (e) {
    console.error('Error:', e);
    return res.status(500).json({ error: e.message });
  }
};
