// api/notion.js - Vercel Serverless Function
// 這個函數作為 Notion API 的後端 proxy，解決前端 CORS 問題

const NOTION_VERSION = '2022-06-28';
const NOTION_BASE = 'https://api.notion.com/v1';

// 從 Notion block 提取純文字
function extractText(blocks) {
  let text = '';
  for (const block of blocks) {
    const type = block.type;
    const data = block[type];
    if (!data) continue;

    if (data.rich_text && Array.isArray(data.rich_text)) {
      text += data.rich_text.map(t => t.plain_text || '').join('') + '\n';
    }
    if (type === 'child_page') {
      text += '[子頁面: ' + (data.title || '') + ']\n';
    }
  }
  return text;
}

async function notionRequest(path, token) {
  const res = await fetch(NOTION_BASE + path, {
    headers: {
      'Authorization': 'Bearer ' + token,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    }
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Notion API ' + res.status + ': ' + (data.message || res.statusText));
  return data;
}

async function getChildPages(pageId, token) {
  const pages = [];
  let cursor = undefined;
  do {
    const url = '/blocks/' + pageId + '/children?page_size=100' + (cursor ? '&start_cursor=' + cursor : '');
    const data = await notionRequest(url, token);
    for (const block of data.results) {
      if (block.type === 'child_page') {
        pages.push({ id: block.id, title: block.child_page?.title || '未命名' });
      }
    }
    cursor = data.next_cursor;
  } while (cursor);
  return pages;
}

async function getPageContent(pageId, token) {
  let text = '';
  let cursor = undefined;
  do {
    const url = '/blocks/' + pageId + '/children?page_size=100' + (cursor ? '&start_cursor=' + cursor : '');
    const data = await notionRequest(url, token);
    text += extractText(data.results);
    cursor = data.next_cursor;
  } while (cursor);
  return text;
}

export default async function handler(req, res) {
  // CORS headers - 允許所有來源（包含 claude.ai artifact）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token, pageId, action } = req.body;

  if (!token || !pageId) {
    return res.status(400).json({ error: 'Missing token or pageId' });
  }

  try {
    if (action === 'list') {
      // 取得所有子頁面清單
      const childPages = await getChildPages(pageId, token);
      const mainPage = await notionRequest('/pages/' + pageId, token);
      const mainTitle =
        mainPage.properties?.title?.title?.[0]?.plain_text ||
        mainPage.properties?.Name?.title?.[0]?.plain_text ||
        '內科主頁面';

      return res.status(200).json({
        success: true,
        pages: [{ id: pageId, title: mainTitle }, ...childPages]
      });

    } else if (action === 'content') {
      // 取得單一頁面內容
      const content = await getPageContent(pageId, token);
      return res.status(200).json({ success: true, content });

    } else if (action === 'all') {
      // 一次取得所有頁面（主頁面 + 所有子頁面）的內容
      const childPages = await getChildPages(pageId, token);
      const mainPage = await notionRequest('/pages/' + pageId, token);
      const mainTitle =
        mainPage.properties?.title?.title?.[0]?.plain_text ||
        mainPage.properties?.Name?.title?.[0]?.plain_text ||
        '內科主頁面';

      const allPages = [{ id: pageId, title: mainTitle }, ...childPages];
      const results = [];

      for (const pg of allPages) {
        try {
          const content = await getPageContent(pg.id, token);
          if (content.trim().length > 20) {
            results.push({ id: pg.id, title: pg.title, content: content.trim() });
          }
        } catch (e) {
          console.error('Failed to read page:', pg.title, e.message);
        }
      }

      return res.status(200).json({ success: true, pages: results });

    } else {
      return res.status(400).json({ error: 'Invalid action. Use: list, content, all' });
    }

  } catch (e) {
    console.error('Error:', e);
    return res.status(500).json({ error: e.message });
  }
}
