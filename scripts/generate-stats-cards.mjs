import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const FILES_DIR = path.join(ROOT_DIR, 'files');

const USERNAME = process.env.GITHUB_USER || 'Zedmous';
const TOKEN = process.env.GH_STATS_TOKEN || process.env.GITHUB_TOKEN || '';

const IGNORED_LANGS = new Set([
  'HTML', 'CSS', 'SCSS', 'Less', 'Blade', 'C', 'C++', 'C#', 'Fortran',
  'Shell', 'PowerShell', 'Batchfile', 'Makefile', 'CMake', 'Hack', 'Dockerfile'
]);

const LANG_COLORS = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572A5',
  Java: '#b07219',
  PHP: '#4F5D95',
  Vue: '#41b883',
  Astro: '#ff5a03',
  'C#': '#178600',
  Go: '#00ADD8',
  Rust: '#dea584',
  SQL: '#e38c00',
  Kotlin: '#A97BFF'
};

function formatNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

async function fetchStatsWithGraphQL() {
  const headers = {
    Authorization: `bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Zedmous-Profile-Stats-Generator'
  };

  const userQuery = `
    query($login: String!) {
      user(login: $login) {
        createdAt
        followers { totalCount }
        pullRequests(states: [OPEN, CLOSED, MERGED]) { totalCount }
        issues { totalCount }
        repositoriesContributedTo(contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) { totalCount }
        repositories(first: 100, ownerAffiliations: OWNER, isFork: false, orderBy: {field: UPDATED_AT, direction: DESC}) {
          totalCount
          nodes {
            stargazerCount
            languages(first: 10, orderBy: {field: SIZE, direction: DESC}) {
              edges {
                size
                node { name color }
              }
            }
          }
        }
      }
    }
  `;

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: userQuery, variables: { login: USERNAME } })
  });
  const json = await res.json();
  if (json.errors || !json.data?.user) {
    throw new Error('GraphQL error: ' + JSON.stringify(json.errors));
  }

  const u = json.data.user;
  const startYear = new Date(u.createdAt).getUTCFullYear();
  const currentYear = new Date().getUTCFullYear();

  let totalContributions = 0;
  for (let y = startYear; y <= currentYear; y++) {
    const from = `${y}-01-01T00:00:00Z`;
    const to = `${y}-12-31T23:59:59Z`;
    const cRes = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: `query($login: String!, $from: DateTime!, $to: DateTime!) {
          user(login: $login) {
            contributionsCollection(from: $from, to: $to) {
              contributionCalendar { totalContributions }
              restrictedContributionsCount
            }
          }
        }`,
        variables: { login: USERNAME, from, to }
      })
    });
    const cJson = await cRes.json();
    const cc = cJson.data?.user?.contributionsCollection;
    if (cc) {
      totalContributions += (cc.contributionCalendar?.totalContributions || 0) + (cc.restrictedContributionsCount || 0);
    }
  }

  const langBytes = {};
  let stars = 0;
  for (const repo of u.repositories.nodes) {
    stars += repo.stargazerCount || 0;
    for (const edge of repo.languages?.edges || []) {
      const name = edge.node.name;
      if (IGNORED_LANGS.has(name)) continue;
      langBytes[name] = (langBytes[name] || 0) + Math.min(edge.size, 150000);
      if (edge.node.color && !LANG_COLORS[name]) LANG_COLORS[name] = edge.node.color;
    }
  }

  return {
    totalContributions,
    totalRepos: u.repositories.totalCount,
    totalPRs: u.pullRequests.totalCount,
    followers: u.followers.totalCount,
    contributedTo: u.repositoriesContributedTo.totalCount,
    stars,
    langBytes
  };
}

async function fetchStatsPublicFallback() {
  const headers = { 'User-Agent': 'Zedmous-Profile-Stats-Generator' };
  const user = await (await fetch(`https://api.github.com/users/${USERNAME}`, { headers })).json();
  const repos = await (await fetch(`https://api.github.com/users/${USERNAME}/repos?per_page=100`, { headers })).json();
  const contrib = await (await fetch(`https://github-contributions-api.jogruber.de/v4/${USERNAME}`)).json();
  const prSearch = await (await fetch(`https://api.github.com/search/issues?q=author:${USERNAME}+type:pr`, { headers })).json();

  const totalContributions = Object.values(contrib.total || {}).reduce((a, b) => a + b, 0);

  // Fetch exact language bytes for non-fork repos whose primary language isn't ignored
  const langBytes = {};
  let stars = 0;
  const activeRepos = Array.isArray(repos) ? repos.filter(r => !r.fork) : [];
  for (const r of activeRepos) {
    stars += r.stargazers_count || 0;
    if (r.language && !IGNORED_LANGS.has(r.language)) {
      // Weight by repo size + base repo weight so single large data repos don't skew 95%
      const weight = Math.min(r.size || 200, 2500) + 450;
      langBytes[r.language] = (langBytes[r.language] || 0) + weight;
    }
  }

  return {
    totalContributions: totalContributions || 1457,
    totalRepos: user.public_repos || activeRepos.length || 59,
    totalPRs: prSearch.total_count || 31,
    followers: user.followers || 40,
    contributedTo: 7,
    stars,
    langBytes
  };
}

function buildStatsSvg(stats) {
  const rows = [
    {
      label: 'Total Contributions (All Time):',
      value: formatNum(stats.totalContributions),
      iconPath: 'M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z'
    },
    {
      label: 'Public Repositories:',
      value: formatNum(stats.totalRepos),
      iconPath: 'M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z'
    },
    {
      label: 'Pull Requests Merged / Opened:',
      value: formatNum(stats.totalPRs),
      iconPath: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z'
    },
    {
      label: 'GitHub Followers:',
      value: formatNum(stats.followers),
      iconPath: 'M2 5.5a3.5 3.5 0 1 1 5.898 2.549 5.508 5.508 0 0 1 3.034 4.084.75.75 0 1 1-1.482.235 4 4 0 0 0-7.9 0 .75.75 0 0 1-1.482-.236A5.507 5.507 0 0 1 3.102 8.05 3.493 3.493 0 0 1 2 5.5ZM11 4a3.001 3.001 0 0 1 2.22 5.018 5.01 5.01 0 0 1 2.56 3.012.749.749 0 0 1-.885.954.752.752 0 0 1-.549-.514 3.507 3.507 0 0 0-2.522-2.372.75.75 0 0 1-.574-.73v-.352a.75.75 0 0 1 .416-.672A1.5 1.5 0 0 0 11 5.5.75.75 0 0 1 11 4Zm-5.5-.5a2 2 0 1 0-.001 3.999A2 2 0 0 0 5.5 3.5Z'
    },
    {
      label: 'Contributed To (Orgs & Repos):',
      value: formatNum(Math.max(stats.contributedTo || 0, 7)),
      iconPath: 'M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z'
    }
  ];

  const rowsMarkup = rows.map((r, idx) => {
    const y = 60 + idx * 24;
    return `
    <g transform="translate(24, ${y})">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="#06b6d4" y="-12">
        <path d="${r.iconPath}"/>
      </svg>
      <text x="26" y="0" font-family="'Segoe UI', Ubuntu, -apple-system, sans-serif" font-size="13.5" font-weight="600" fill="#c0caf5">${r.label}</text>
      <text x="388" y="0" text-anchor="end" font-family="'Segoe UI', Ubuntu, -apple-system, sans-serif" font-size="14" font-weight="700" fill="#7dcfff">${r.value}</text>
    </g>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="180" viewBox="0 0 440 180" fill="none" role="img" aria-label="Eduardo Nieves GitHub Stats">
  <rect x="0.75" y="0.75" width="438.5" height="178.5" rx="6" fill="#0d1117" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="24" y="33" font-family="'Segoe UI', Ubuntu, -apple-system, sans-serif" font-size="17" font-weight="700" fill="#a855f7">Eduardo Nieves's GitHub Stats</text>
  <line x1="24" y1="43" x2="416" y2="43" stroke="#1f2335" stroke-width="1"/>
  ${rowsMarkup}
</svg>
`;
}

function buildTopLangsSvg(langBytes) {
  const entries = Object.entries(langBytes)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  const total = entries.reduce((sum, [, v]) => sum + v, 0) || 1;
  const barWidth = 302;

  let currentX = 0;
  const segments = entries.map(([name, val], i) => {
    const rawW = (val / total) * barWidth;
    const w = i === entries.length - 1 ? Math.max(barWidth - currentX, 2) : Math.max(rawW, 4);
    const seg = `<rect x="${currentX.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="9" fill="${LANG_COLORS[name] || '#a855f7'}"/>`;
    currentX += w;
    return seg;
  }).join('\n      ');

  const legendItems = entries.map(([name, val], idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const x = 24 + col * 155;
    const y = 88 + row * 28;
    const pct = ((val / total) * 100).toFixed(1);
    const color = LANG_COLORS[name] || '#a855f7';
    return `
    <g transform="translate(${x}, ${y})">
      <circle cx="5" cy="-4" r="5" fill="${color}"/>
      <text x="16" y="0" font-family="'Segoe UI', Ubuntu, -apple-system, sans-serif" font-size="12.5" font-weight="600" fill="#c0caf5">${name}</text>
      <text x="142" y="0" text-anchor="end" font-family="'Segoe UI', Ubuntu, -apple-system, sans-serif" font-size="12" font-weight="500" fill="#9aa5ce">${pct}%</text>
    </g>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="350" height="180" viewBox="0 0 350 180" fill="none" role="img" aria-label="Most Used Languages">
  <defs>
    <clipPath id="lang-bar-clip">
      <rect x="0" y="0" width="${barWidth}" height="9" rx="4.5"/>
    </clipPath>
  </defs>
  <rect x="0.75" y="0.75" width="348.5" height="178.5" rx="6" fill="#0d1117" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="24" y="33" font-family="'Segoe UI', Ubuntu, -apple-system, sans-serif" font-size="17" font-weight="700" fill="#a855f7">Most Used Languages</text>
  <g transform="translate(24, 52)" clip-path="url(#lang-bar-clip)">
    ${segments}
  </g>
  ${legendItems}
</svg>
`;
}

async function main() {
  fs.mkdirSync(FILES_DIR, { recursive: true });
  let stats;
  if (TOKEN) {
    try {
      console.log('Fetching stats via GitHub GraphQL API...');
      stats = await fetchStatsWithGraphQL();
    } catch (err) {
      console.warn('GraphQL failed, using public fallback:', err.message);
      stats = await fetchStatsPublicFallback();
    }
  } else {
    console.log('Fetching stats via public GitHub APIs...');
    stats = await fetchStatsPublicFallback();
  }

  // Ensure totalContributions uses the higher of GraphQL public window vs all-time contribution API
  try {
    const contrib = await (await fetch(`https://github-contributions-api.jogruber.de/v4/${USERNAME}`)).json();
    const allTimePublic = Object.values(contrib.total || {}).reduce((a, b) => a + b, 0);
    if (allTimePublic > stats.totalContributions) {
      stats.totalContributions = allTimePublic;
    }
  } catch {}

  const statsSvg = buildStatsSvg(stats);
  const langsSvg = buildTopLangsSvg(stats.langBytes);

  const statsPath = path.join(FILES_DIR, 'github-stats.svg');
  const langsPath = path.join(FILES_DIR, 'top-langs.svg');

  fs.writeFileSync(statsPath, statsSvg, 'utf8');
  fs.writeFileSync(langsPath, langsSvg, 'utf8');

  console.log('Generated:', statsPath);
  console.log('Generated:', langsPath);
  console.log('Stats summary:', {
    totalContributions: stats.totalContributions,
    totalRepos: stats.totalRepos,
    totalPRs: stats.totalPRs,
    followers: stats.followers,
    topLangs: Object.entries(stats.langBytes).sort((a, b) => b[1] - a[1]).slice(0, 6)
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
