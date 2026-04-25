const NOTION_VERSION = '2022-06-28';
const NOTION_BASE = 'https://api.notion.com/v1';

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token, pageId, action } = req.body;
  if (!token || !pageId) return res.status(400).jso
