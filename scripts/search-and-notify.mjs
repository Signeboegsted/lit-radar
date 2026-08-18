// Runs once a month (via GitHub Actions). For every registered project:
//   1. Search Semantic Scholar, arXiv, PubMed and CrossRef for papers from the last ~35 days
//   2. Rank them against the project description using free local embeddings
//   3. Skip anything already sent before
//   4. Email the top 10 via Resend
//
// Needs three secrets, set as GitHub Actions repo secrets (see README):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY

import { createClient } from '@supabase/supabase-js';
import { pipeline } from '@xenova/transformers';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'Lit Radar <onboarding@resend.dev>';
const TOP_N = 7;               // upper cap — never send more than this, even if many pass the threshold
const MIN_SCORE = 0.1;         // only papers scoring at or above this get sent (0 to 1, higher = stricter)
const LOOKBACK_DAYS = 32;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ---------- helpers ----------

function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ---------- source: Semantic Scholar ----------

async function searchSemanticScholar(query, sinceDate) {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&fields=title,abstract,authors,url,externalIds,publicationDate&limit=50`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data || [])
    .filter(p => p.abstract && p.publicationDate && p.publicationDate >= sinceDate)
    .map(p => ({
      id: `s2:${p.paperId || p.externalIds?.DOI || p.title}`,
      title: p.title,
      abstract: p.abstract,
      authors: (p.authors || []).map(a => a.name).join(', '),
      url: p.url,
      source: 'Semantic Scholar',
    }));
}

// ---------- source: arXiv ----------

async function searchArxiv(query, sinceDate) {
  const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&sortBy=submittedDate&sortOrder=descending&max_results=30`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const xml = await res.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
  const since = new Date(sinceDate);
  return entries
    .map(e => {
      const title = (e.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1].trim().replace(/\s+/g, ' ');
      const abstract = (e.match(/<summary>([\s\S]*?)<\/summary>/) || [, ''])[1].trim().replace(/\s+/g, ' ');
      const published = (e.match(/<published>([\s\S]*?)<\/published>/) || [, ''])[1];
      const id = (e.match(/<id>([\s\S]*?)<\/id>/) || [, ''])[1];
      const authors = [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(a => a[1]).join(', ');
      return { title, abstract, published, id, authors };
    })
    .filter(p => p.abstract && p.published && new Date(p.published) >= since)
    .map(p => ({
      id: `arxiv:${p.id}`,
      title: p.title,
      abstract: p.abstract,
      authors: p.authors,
      url: p.id,
      source: 'arXiv',
    }));
}

// ---------- source: PubMed ----------

async function searchPubmed(query, sinceDate) {
  const since = sinceDate.replace(/-/g, '/');
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '/');
  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&datetype=pdat&mindate=${since}&maxdate=${today}&retmax=30&retmode=json`;
  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) return [];
  const searchData = await searchRes.json();
  const ids = searchData.esearchresult?.idlist || [];
  if (ids.length === 0) return [];

  const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${ids.join(',')}&rettype=abstract&retmode=xml`;
  const summaryRes = await fetch(summaryUrl);
  if (!summaryRes.ok) return [];
  const xml = await summaryRes.text();
  const articles = [...xml.matchAll(/<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g)].map(m => m[1]);

  return articles
    .map(a => {
      const title = (a.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/) || [, ''])[1].replace(/<[^>]+>/g, '').trim();
      const abstractParts = [...a.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)].map(m => m[1]);
      const abstract = abstractParts.join(' ').replace(/<[^>]+>/g, '').trim();
      const pmid = (a.match(/<PMID[^>]*>([\s\S]*?)<\/PMID>/) || [, ''])[1];
      const authors = [...a.matchAll(/<LastName>([\s\S]*?)<\/LastName>/g)].map(m => m[1]).join(', ');
      return { title, abstract, pmid, authors };
    })
    .filter(p => p.abstract && p.title)
    .map(p => ({
      id: `pubmed:${p.pmid}`,
      title: p.title,
      abstract: p.abstract,
      authors: p.authors,
      url: `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`,
      source: 'PubMed',
    }));
}

// ---------- ranking ----------

let embedder;
async function getEmbedder() {
  if (!embedder) {
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedder;
}

async function embed(text) {
  const model = await getEmbedder();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// ---------- email ----------

// Escapes text pulled from external sources (paper titles/abstracts) and
// from user-submitted form fields (project description) before it's
// dropped into HTML, so neither can inject markup into the email.
function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendDigest(project, papers) {
  const rows = papers.map(p => `
    <tr>
      <td style="padding:16px 0;border-top:1px solid #e5e0d3;">
        <div style="font-family:monospace;font-size:11px;color:#b8912f;text-transform:uppercase;letter-spacing:.06em;">${escapeHtml(p.source)} · ${Math.round(p.score * 100)}% match</div>
        <div style="font-size:17px;font-weight:600;margin:4px 0 6px;"><a href="${encodeURI(p.url)}" style="color:#10161c;text-decoration:none;">${escapeHtml(p.title)}</a></div>
        <div style="font-size:13px;color:#666;margin-bottom:6px;">${escapeHtml(p.authors) || 'Authors unavailable'}</div>
        <div style="font-size:14px;color:#333;line-height:1.5;">${escapeHtml(p.abstract.slice(0, 320))}${p.abstract.length > 320 ? '…' : ''}</div>
      </td>
    </tr>`).join('');

  const shortDesc = escapeHtml(project.description.slice(0, 60)) + (project.description.length > 60 ? '…' : '');
  const html = `
  <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
    <h2 style="font-family:serif;">This month's papers for "${shortDesc}"</h2>
    <table style="width:100%;border-collapse:collapse;">${rows}</table>
    <p style="font-size:12px;color:#999;margin-top:24px;">Ranked against your project description using local embeddings. Reply to whoever manages this tool to update your keywords.</p>
  </div>`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: project.email,
      subject: `Lit Radar — ${papers.length} papers this month`,
      html,
    }),
  });
}

// ---------- main ----------

async function processProject(project) {
  const sinceDate = daysAgoISO(LOOKBACK_DAYS);
  const query = project.keywords.join(' ');

  const [s2, arxiv, pubmed] = await Promise.all([
    searchSemanticScholar(query, sinceDate).catch(() => []),
    searchArxiv(query, sinceDate).catch(() => []),
    searchPubmed(query, sinceDate).catch(() => []),
  ]);

  const candidates = [...s2, ...arxiv, ...pubmed];

  // dedupe by normalized title
  const seenTitles = new Set();
  const deduped = candidates.filter(p => {
    const key = p.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
    if (seenTitles.has(key)) return false;
    seenTitles.add(key);
    return true;
  });

  // filter out already-sent papers
  const { data: sentRows } = await supabase
    .from('sent_papers')
    .select('paper_id')
    .eq('project_id', project.id);
  const sentIds = new Set((sentRows || []).map(r => r.paper_id));
  const fresh = deduped.filter(p => !sentIds.has(p.id));

  if (fresh.length === 0) {
    console.log(`[${project.email}] no new candidates this month`);
    return;
  }

  const projectVec = await embed(project.description);
  const scored = [];
  for (const p of fresh) {
    const vec = await embed(`${p.title}. ${p.abstract}`);
    scored.push({ ...p, score: cosineSim(projectVec, vec) });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter(p => p.score >= MIN_SCORE).slice(0, TOP_N);

  if (top.length === 0) {
    console.log(`[${project.email}] ${scored.length} candidates found, none met the ${MIN_SCORE} relevance threshold`);
    return;
  }

  await sendDigest(project, top);

  await supabase.from('sent_papers').insert(
    top.map(p => ({ project_id: project.id, paper_id: p.id }))
  );

  console.log(`[${project.email}] sent ${top.length} papers`);
}

async function main() {
  const { data: projects, error } = await supabase.from('projects').select('*');
  if (error) throw error;

  for (const project of projects) {
    try {
      await processProject(project);
    } catch (err) {
      console.error(`Failed for ${project.email}:`, err);
    }
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
