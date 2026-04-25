module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  const { token, pageId, anthropicKey } = req.body;
  if (!token || !pageId) return res.status(400).json({ error: 'Missing token or pageId' });
  if (!anthropicKey) return res.status(400).json({ error: 'Missing anthropicKey' });
 
  const N_BASE = 'https://api.notion.com/v1';
  const N_HEADERS = {
    'Authorization': 'Bearer ' + token,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };
 
  async function nGet(path) {
    const r = await fetch(N_BASE + path, { headers: N_HEADERS });
    const d = await r.json();
    if (!r.ok) throw new Error('Notion ' + r.status + ': ' + (d.message || ''));
    return d;
  }
 
  function parseBlocks(blocks) {
    let text = '';
    const childPages = [];
    for (const b of blocks) {
      const bd = b[b.type];
      if (!bd) continue;
      if (bd.rich_text) text += bd.rich_text.map(x => x.plain_text || '').join('') + '\n';
      if (b.type === 'child_page') childPages.push({ id: b.id, title: bd.title || 'Untitled' });
      if (['heading_1','heading_2','heading_3'].includes(b.type) && bd.rich_text)
        text += '\n## ' + bd.rich_text.map(x => x.plain_text || '').join('') + '\n';
      if (['bulleted_list_item','numbered_list_item'].includes(b.type) && bd.rich_text)
        text += '• ' + bd.rich_text.map(x => x.plain_text || '').join('') + '\n';
    }
    return { text, childPages };
  }
 
  async function getAllBlocks(id) {
    let results = [];
    let cursor = null;
    do {
      const url = '/blocks/' + id + '/children?page_size=100' + (cursor ? '&start_cursor=' + cursor : '');
      const d = await nGet(url);
      results = results.concat(d.results);
      cursor = d.next_cursor;
    } while (cursor);
    return results;
  }
 
  async function readPage(id, title, depth) {
    const blocks = await getAllBlocks(id);
    const { text, childPages } = parseBlocks(blocks);
    const result = { id, title, content: text.trim(), children: [] };
    if (depth < 2) {
      for (const cp of childPages) {
        if (cp.title.includes('答題統計') || cp.title.includes('容易答錯')) continue;
        try {
          const child = await readPage(cp.id, cp.title, depth + 1);
          if (child.content.length > 20 || child.children.length > 0) result.children.push(child);
        } catch (e) { /* skip */ }
      }
    }
    return result;
  }
 
  function flattenPages(node, parentTitle) {
    const pages = [];
    const fullTitle = parentTitle ? parentTitle + ' > ' + node.title : node.title;
    if (node.content && node.content.length > 50) pages.push({ id: node.id, title: fullTitle, content: node.content });
    for (const child of (node.children || [])) pages.push(...flattenPages(child, node.title));
    return pages;
  }
 
  function guessSubject(title) {
    const t = title.toLowerCase();
    if (/card|cv$|ekg|echo|arrhyth|heart|homc|pericardi|tampon|wpw|noac/.test(t)) return 'cardiology';
    if (/chest|pulmon|asthma|copd|pneumon|tb|ild|abpa|lung/.test(t)) return 'pulmonology';
    if (/nephro|renal|kidney|glomerul|tma|hus|ttp|bartter|gitelman|rta|ckd|adpkd/.test(t)) return 'nephrology';
    if (/gi|gastro|liver|hepat|bowel|colon|pancreat|achalasia|ulcer/.test(t)) return 'gi';
    if (/endocrine|thyroid|diabet|adrenal|pituitar|men[12]|aldoster|pheo|osteo/.test(t)) return 'endocrine';
    if (/hematol|blood|lymph|myelom|leukemi|anemia|itp|pnh|aplastic|cll|aml|all/.test(t)) return 'hematology';
    return 'other';
  }
 
  async function generateQuestions(page, anthropicKey) {
    const shortTitle = page.title.split(' > ').pop();
    const subject = guessSubject(shortTitle);
 
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: '你是台灣醫師國考出題老師，精通內科。根據提供的 Notion 筆記內容，找出 5-8 個重要考點並生成對應的四選一選擇題。只回傳純 JSON 陣列，不含任何其他文字或 markdown：[{"question":"題目","options":["選項1","選項2","選項3","選項4"],"answer":正確答案索引0-3,"explanation":"詳細解析含病生理機轉","subject":"' + subject + '","source":"' + shortTitle + '"}]',
        messages: [{ role: 'user', content: '頁面：' + page.title + '\n\n內容：\n' + page.content.slice(0, 5000) }],
      }),
    });
 
    const data = await r.json();
    if (!r.ok) throw new Error('Claude ' + r.status + ': ' + (data.error?.message || ''));
 
    const raw = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    const s = clean.indexOf('['), e = clean.lastIndexOf(']');
    if (s === -1 || e === -1) return [];
 
    const arr = JSON.parse(clean.slice(s, e + 1));
    return arr
      .filter(q => q.question && Array.isArray(q.options) && q.options.length >= 4)
      .map((q, i) => ({
        id: 'v_' + shortTitle.slice(0, 8).replace(/\W/g, '_') + '_' + Date.now() + '_' + i,
        question: q.question,
        options: q.options.slice(0, 4),
        answer: Math.min(Math.max(parseInt(q.answer) || 0, 0), 3),
        explanation: q.explanation || '請參考教科書',
        subject: q.subject || subject,
        source: q.source || shortTitle,
      }));
  }
 
  try {
    const mainPage = await nGet('/pages/' + pageId);
    const mainTitle =
      mainPage.properties?.title?.title?.[0]?.plain_text ||
      mainPage.properties?.Name?.title?.[0]?.plain_text || '內科';
 
    const tree = await readPage(pageId, mainTitle, 0);
    const allPages = flattenPages(tree, '').filter(pg =>
      !pg.title.includes('答題統計') && !pg.title.includes('容易答錯')
    );
 
    if (!allPages.length) return res.status(200).json({ success: false, error: '找不到有效頁面，請確認 integration 已被邀請' });
 
    const allQuestions = [];
    const pageResults = [];
    const delay = ms => new Promise(r => setTimeout(r, ms));
 
    for (let i = 0; i < allPages.length; i++) {
      const pg = allPages[i];
      try {
        const qs = await generateQuestions(pg, anthropicKey);
        allQuestions.push(...qs);
        pageResults.push({ title: pg.title.split(' > ').pop(), count: qs.length, status: 'ok' });
      } catch (e) {
        pageResults.push({ title: pg.title.split(' > ').pop(), count: 0, status: 'error', error: e.message });
      }
      if (i < allPages.length - 1) await delay(500);
    }
 
    return res.status(200).json({ success: true, questions: allQuestions, pages: pageResults, total: allQuestions.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
