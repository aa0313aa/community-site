const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 4200;

app.set('trust proxy', 1);

// 자유게시판 카테고리 (향후 확장 가능)
const POST_CATEGORIES = ['free'];

// DB
const DB_FILE = path.join(__dirname, 'community.db');
const db = new sqlite3.Database(DB_FILE);

db.serialize(() => {
  // 기존 게시글 테이블
  db.run(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    content TEXT,
    category TEXT DEFAULT 'free',
    writer TEXT,
    created DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 기존 DB에 category 컬럼이 없다면 추가 (한 번만 실행됨)
  db.run(`ALTER TABLE posts ADD COLUMN category TEXT DEFAULT 'free'`, (err) => {
    if (err && !String(err.message || '').includes('duplicate column name')) {
      console.error('posts 테이블 category 컬럼 추가 실패:', err.message);
    }
  });

  // 회원 테이블
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER DEFAULT 0,
    created DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`ALTER TABLE users ADD COLUMN email TEXT`, (err) => {
    if (err && !String(err.message || '').includes('duplicate column name')) {
      console.error('users 테이블 email 컬럼 추가 실패:', err.message);
    }
  });

  db.run(`ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0`, (err) => {
    if (err && !String(err.message || '').includes('duplicate column name')) {
      console.error('users 테이블 is_admin 컬럼 추가 실패:', err.message);
    }
  });

  db.run(`CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    created DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  // 업체 정보 테이블
  db.run(`CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL, -- 'payment'(소액결제) | 'credit'(신용카드) | 'scam'(사기사이트) | 'other'(기타)
    type TEXT NOT NULL,     -- 'safe'(정상업체) | 'fraud'(사기업체) | 'other'(기타)
    website TEXT,
    phone TEXT,
    messenger TEXT,
    messenger_id TEXT,
    description TEXT,
    rating INTEGER DEFAULT 0, -- 1-5 별점
    report_count INTEGER DEFAULT 0,
    writer TEXT,
    created DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 업체 리뷰/신고 테이블
  db.run(`CREATE TABLE IF NOT EXISTS company_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER,
    review_type TEXT NOT NULL, -- 'review' (리뷰) 또는 'report' (신고)
    rating INTEGER,            -- 1-5 별점 (리뷰인 경우)
    content TEXT,
    writer TEXT,
    created DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(company_id) REFERENCES companies(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS post_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    writer TEXT,
    created DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
  )`);

  // 기존 테이블에 메신저 필드 추가 (있으면 무시)
  db.run(`ALTER TABLE companies ADD COLUMN messenger TEXT`, (err) => {
    if (err && !String(err.message || '').includes('duplicate column name')) {
      console.error('companies 테이블 messenger 컬럼 추가 실패:', err.message);
    }
  });

  db.run(`ALTER TABLE companies ADD COLUMN messenger_id TEXT`, (err) => {
    if (err && !String(err.message || '').includes('duplicate column name')) {
      console.error('companies 테이블 messenger_id 컬럼 추가 실패:', err.message);
    }
  });

  // 🔐 기본 관리자 계정 자동 생성 (처음 한 번만)
  const bcrypt = require('bcryptjs');
  const adminUsername = 'admin';
  const adminEmail = 'admin@community.com';
  const adminPassword = 'Admin@123456'; // 기본 비밀번호

  db.get('SELECT id FROM users WHERE username = ?', [adminUsername], (err, row) => {
    if (err) return console.error('관리자 확인 오류:', err.message);
    
    if (!row) {
      // 관리자가 없으면 생성
      const hash = bcrypt.hashSync(adminPassword, 10);
      db.run(
        'INSERT INTO users (username, email, password_hash, is_admin) VALUES (?,?,?,?)',
        [adminUsername, adminEmail, hash, 1],
        (err) => {
          if (err) {
            console.error('관리자 계정 생성 실패:', err.message);
          } else {
            console.log('✅ 기본 관리자 계정 자동 생성:');
            console.log(`   아이디: ${adminUsername}`);
            console.log(`   이메일: ${adminEmail}`);
            console.log(`   비밀번호: ${adminPassword}`);
            console.log('   ⚠️ 처음 로그인 후 비밀번호를 변경해주세요!');
          }
        }
      );
    }
  });
});

app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));
app.use(session({
  name: 'community.sid',
  secret: process.env.SESSION_SECRET || 'community-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7일
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

function sanitize(str, max = 5000) {
  const s = String(str || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, max);
}

function sanitizeUsername(str, max = 20) {
  const s = String(str || '').trim().replace(/[^A-Za-z0-9_.-]/g, '');
  return s.slice(0, max);
}

function sanitizeEmail(str, max = 120) {
  const s = String(str || '').trim().toLowerCase();
  return s.slice(0, max);
}

function isValidEmail(str) {
  const emailRegex = /^[\w.!#$%&'*+/=?`{|}~-]+@[\w-]+(?:\.[\w-]+)+$/;
  return emailRegex.test(str);
}

function validatePassword(str) {
  const s = String(str || '');
  return s.length >= 6 && s.length <= 64;
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    bcrypt.hash(password, 10, (err, hash) => {
      if (err) return reject(err);
      resolve(hash);
    });
  });
}

function comparePassword(password, hash) {
  return new Promise((resolve, reject) => {
    bcrypt.compare(password, hash, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildMetaDescription(text, fallback = '') {
  const clean = sanitize(text || fallback || '', 600);
  return clean.length > 155 ? `${clean.slice(0, 152)}...` : clean;
}

function toIsoDate(dateValue) {
  if (!dateValue) {
    return new Date().toISOString();
  }
  const parsed = new Date(`${dateValue}Z`);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }
  const fallback = new Date(dateValue);
  if (!Number.isNaN(fallback.getTime())) {
    return fallback.toISOString();
  }
  return new Date().toISOString();
}

function getCompanyCategoryLabel(category) {
  switch (category) {
    case 'payment':
      return '소액결제';
    case 'credit':
      return '신용카드';
    case 'scam':
      return '사기사이트';
    case 'other':
      return '기타';
    default:
      return '기타';
  }
}

function getCompanyTypeLabel(type) {
  switch (type) {
    case 'safe':
      return '정상업체';
    case 'fraud':
      return '사기업체';
    case 'other':
      return '기타';
    default:
      return '기타';
  }
}

function getRatingLabel(rating) {
  if (!rating || rating <= 0) return '평점 없음';
  const stars = '⭐'.repeat(Math.min(5, Math.max(1, rating)));
  return `${stars} ${rating}점`;
}

function renderSeoDocument({
  title,
  description,
  canonical,
  ogType = 'website',
  robots = 'index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1',
  ogImage,
  structuredData,
  bodyContent = ''
}) {
  const safeTitle = escapeHtml(title || '업체정보 커뮤니티');
  const safeDescription = escapeHtml(description || '소액결제 및 신용카드 업체 정보를 공유하는 커뮤니티');
  const safeCanonical = escapeHtml(canonical || '/');
  const ogImageTag = ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:image" content="${escapeHtml(ogImage)}" />` : '';
  const ldJsonTag = structuredData ? `\n  <script type="application/ld+json">${structuredData}</script>` : '';

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${safeTitle}</title>
  <link rel="canonical" href="${safeCanonical}" />
  <meta name="description" content="${safeDescription}" />
  <meta name="robots" content="${robots}" />
  <meta name="theme-color" content="#1d4ed8" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="format-detection" content="telephone=no" />
  
  <!-- Open Graph / Facebook -->
  <meta property="og:locale" content="ko_KR" />
  <meta property="og:site_name" content="업체정보 커뮤니티" />
  <meta property="og:type" content="${escapeHtml(ogType)}" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDescription}" />
  <meta property="og:url" content="${safeCanonical}" />
  ${ogImageTag}
  
  <!-- Twitter / X -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${safeTitle}" />
  <meta name="twitter:description" content="${safeDescription}" />
  <meta name="twitter:url" content="${safeCanonical}" />
  <meta name="twitter:creator" content="@community" />
  
  <!-- Schema.org Structured Data -->${ldJsonTag}
  
  <style>
    body { font-family: 'Noto Sans KR', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#f9fafb; color:#1f2937; margin:0; }
    main { max-width: 768px; margin: 0 auto; padding: 48px 16px; }
    header { margin-bottom: 32px; }
    h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; color:#1d4ed8; }
    h2 { font-size: 20px; font-weight: 600; margin-top: 24px; margin-bottom: 12px; }
    .meta { color:#6b7280; font-size:14px; margin-bottom:16px; }
    section { background:#ffffff; border-radius:16px; padding:24px; box-shadow:0 6px 24px rgba(15,23,42,0.08); margin-bottom: 24px; }
    section p { line-height:1.7; margin:12px 0; }
    section ul { margin: 12px 0; }
    section li { margin-bottom:8px; line-height: 1.6; }
    a { color: #1d4ed8; text-decoration: none; }
    a:hover { text-decoration: underline; }
    a.cta { display:inline-block; margin-top:24px; padding:12px 20px; background:#1d4ed8; color:#ffffff; border-radius:999px; text-decoration:none; font-weight:600; }
    a.cta:hover { background: #1e40af; }
    footer { text-align:center; margin-top:40px; padding-top: 24px; border-top: 1px solid #e5e7eb; font-size:14px; color:#6b7280; }
  </style>
</head>
<body>
  ${bodyContent}
</body>
</html>`;
}


app.post('/api/auth/register', async (req, res) => {
  try {
    const username = sanitizeUsername(req.body.username || '', 20);
    const emailRaw = sanitizeEmail(req.body.email || '', 120);
    const password = String(req.body.password || '');

    if (!username || username.length < 3) {
      return res.status(400).json({ success: false, error: '아이디는 3~20자의 영문/숫자/_.- 만 사용할 수 있습니다.' });
    }
    if (!emailRaw || !isValidEmail(emailRaw)) {
      return res.status(400).json({ success: false, error: '올바른 이메일 주소를 입력해주세요.' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ success: false, error: '비밀번호는 6~64자로 입력해주세요.' });
    }

    const existing = await dbGet('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) {
      return res.status(409).json({ success: false, error: '이미 사용 중인 아이디입니다.' });
    }

    const emailExists = await dbGet('SELECT id FROM users WHERE email = ?', [emailRaw]);
    if (emailExists) {
      return res.status(409).json({ success: false, error: '이미 사용 중인 이메일입니다.' });
    }

    const passwordHash = await hashPassword(password);
    const result = await dbRun('INSERT INTO users (email, username, password_hash, is_admin) VALUES (?,?,?,?)', [emailRaw, username, passwordHash, 0]);
    req.session.user = { id: result.lastID, username, email: emailRaw, is_admin: false };
    res.json({ success: true, user: req.session.user });
  } catch (err) {
    console.error('회원가입 오류', err);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = sanitizeUsername(req.body.username || '', 20);
    const password = String(req.body.password || '');

    if (!username || !password) {
      return res.status(400).json({ success: false, error: '아이디와 비밀번호를 입력해주세요.' });
    }

    const user = await dbGet('SELECT id, username, email, password_hash, is_admin FROM users WHERE username = ?', [username]);
    if (!user) {
      return res.status(401).json({ success: false, error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }

    const match = await comparePassword(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ success: false, error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }

    req.session.user = { id: user.id, username: user.username, email: user.email, is_admin: user.is_admin ? true : false };
    res.json({ success: true, user: req.session.user });
  } catch (err) {
    console.error('로그인 오류', err);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('로그아웃 오류', err);
      return res.status(500).json({ success: false, error: '로그아웃 중 오류가 발생했습니다.' });
    }
    res.clearCookie('community.sid');
    res.json({ success: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ success: true, user: req.session.user || null });
});

app.post('/api/auth/request-reset', async (req, res) => {
  try {
    const emailRaw = sanitizeEmail(req.body.email || '', 120);
    if (!emailRaw || !isValidEmail(emailRaw)) {
      return res.status(400).json({ success: false, error: '올바른 이메일 주소를 입력해주세요.' });
    }

    const user = await dbGet('SELECT id, email, username FROM users WHERE email = ?', [emailRaw]);
    if (!user) {
      // 존재 여부를 노출하지 않음
      return res.json({ success: true, message: '비밀번호 재설정 안내를 확인해주세요.' });
    }

    await dbRun('DELETE FROM password_resets WHERE user_id = ?', [user.id]);

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60).toISOString(); // 1시간

    await dbRun('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?,?,?)', [user.id, tokenHash, expiresAt]);

    const host = req.get('host');
    const protocol = req.protocol;
    const resetUrl = `${protocol}://${host}/reset-password?token=${token}`;

    const response = { success: true, message: '비밀번호 재설정 안내를 확인해주세요.' };
    if (process.env.NODE_ENV !== 'production') {
      response.resetUrl = resetUrl;
      response.token = token;
    }

    console.info(`비밀번호 재설정 요청: user=${user.username}, email=${user.email}, resetUrl=${resetUrl}`);

    res.json(response);
  } catch (err) {
    console.error('비밀번호 재설정 요청 오류', err);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const token = String(req.body.token || '').trim();
    const newPassword = String(req.body.password || '');

    if (!token) {
      return res.status(400).json({ success: false, error: '토큰이 필요합니다.' });
    }
    if (!validatePassword(newPassword)) {
      return res.status(400).json({ success: false, error: '비밀번호는 6~64자로 입력해주세요.' });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const resetRow = await dbGet(
      `SELECT pr.id, pr.user_id
       FROM password_resets pr
       WHERE pr.token_hash = ? AND pr.expires_at > datetime('now')
       ORDER BY pr.id DESC
       LIMIT 1`,
      [tokenHash]
    );

    if (!resetRow) {
      return res.status(400).json({ success: false, error: '유효하지 않거나 만료된 토큰입니다.' });
    }

    const passwordHash = await hashPassword(newPassword);
    await dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, resetRow.user_id]);
    await dbRun('DELETE FROM password_resets WHERE user_id = ?', [resetRow.user_id]);

    res.json({ success: true, message: '비밀번호가 변경되었습니다. 새 비밀번호로 로그인해주세요.' });
  } catch (err) {
    console.error('비밀번호 재설정 오류', err);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

app.get('/robots.txt', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const content = [
    '# 🤖 커뮤니티 사이트 SEO 설정',
    'User-agent: *',
    'Allow: /',
    '',
    '# 느린 크롤러 제한',
    'User-agent: *',
    'Crawl-delay: 1',
    'Request-rate: 30/60',
    '',
    '# Google 특화',
    'User-agent: Googlebot',
    'Allow: /',
    'Crawl-delay: 0',
    '',
    '# Naver 특화',
    'User-agent: Yeti',
    'Allow: /',
    '',
    '# Daum 특화',
    'User-agent: Daumoa',
    'Allow: /',
    '',
    '# Bingbot',
    'User-agent: Bingbot',
    'Allow: /',
    '',
    '# 악성 봇 차단',
    'User-agent: AhrefsBot',
    'Disallow: /',
    'User-agent: SemrushBot',
    'Disallow: /',
    '',
    `Sitemap: ${baseUrl}/sitemap.xml`
  ].join('\n');
  res.type('text/plain; charset=utf-8').send(content);
});

app.get('/sitemap.xml', async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const [companyRows, postRows] = await Promise.all([
      dbAll('SELECT id, created FROM companies ORDER BY created DESC LIMIT 5000'),
      dbAll('SELECT id, created FROM posts ORDER BY created DESC LIMIT 5000')
    ]);

    const nowIso = new Date().toISOString();
    const entries = [];
    
    // 홈페이지 (매일 업데이트)
    entries.push({ 
      loc: `${baseUrl}/`, 
      lastmod: nowIso, 
      changefreq: 'daily', 
      priority: '1.0' 
    });
    
    // 사기 정보 페이지 (매시간 업데이트)
    entries.push({ 
      loc: `${baseUrl}/trending`, 
      lastmod: nowIso, 
      changefreq: 'hourly', 
      priority: '0.95' 
    });
    
    // 업체 페이지 (주간 업데이트)
    companyRows.forEach((row) => {
      entries.push({
        loc: `${baseUrl}/companies/${row.id}`,
        lastmod: toIsoDate(row.created),
        changefreq: 'weekly',
        priority: '0.8'
      });
    });
    
    // 게시글 페이지 (일일 업데이트)
    postRows.forEach((row) => {
      entries.push({
        loc: `${baseUrl}/posts/${row.id}`,
        lastmod: toIsoDate(row.created),
        changefreq: 'daily',
        priority: '0.7'
      });
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"
        xmlns:mobile="http://www.google.com/schemas/sitemap-mobile/1.0">
${entries.map((entry) => `  <url>
    <loc>${escapeHtml(entry.loc)}</loc>
    <lastmod>${escapeHtml(entry.lastmod)}</lastmod>
    <changefreq>${escapeHtml(entry.changefreq)}</changefreq>
    <priority>${escapeHtml(entry.priority)}</priority>
    <mobile:mobile/>
  </url>`).join('\n')}
</urlset>`;

    res.type('application/xml; charset=utf-8').send(xml);
  } catch (err) {
    console.error('Sitemap 생성 오류', err);
    res.status(500).type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
  }
});

app.get('/api/posts', (req, res) => {
  const category = sanitize(req.query.category || '').toLowerCase();
  let query = `SELECT p.id, p.title, p.content, p.category, p.writer, p.created,
    (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id) AS comment_count
    FROM posts p`;
  const params = [];

  if (category && POST_CATEGORIES.includes(category)) {
    query += ' WHERE p.category = ?';
    params.push(category);
  }

  query += ' ORDER BY p.id DESC LIMIT 200';

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: 'DB 오류' });
    res.json({ success: true, posts: rows || [] });
  });
});

app.post('/api/posts', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
  }

  const title = sanitize(req.body.title || '').slice(0, 120) || '(제목 없음)';
  const content = sanitize(req.body.content || '', 8000);
  const categoryRaw = sanitize(req.body.category || 'free', 20).toLowerCase();
  const category = POST_CATEGORIES.includes(categoryRaw) ? categoryRaw : 'free';
  const writer = req.session.user.username;
  if (!content) return res.json({ success: false, error: '내용이 비어 있습니다' });
  db.run('INSERT INTO posts (title, content, category, writer) VALUES (?,?,?,?)', [title, content, category, writer], function (err) {
    if (err) return res.status(500).json({ success: false, error: 'DB 오류' });
    res.json({ success: true, id: this.lastID });
  });
});

app.get('/api/posts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    return res.status(400).json({ success: false, error: '잘못된 게시글 ID' });
  }

  db.get('SELECT id, title, content, category, writer, created FROM posts WHERE id = ?', [id], (err, row) => {
    if (err) {
      console.error('게시글 조회 오류', err);
      return res.status(500).json({ success: false, error: 'DB 오류' });
    }
    if (!row) {
      return res.status(404).json({ success: false, error: '게시글을 찾을 수 없습니다.' });
    }

    db.all('SELECT id, post_id, content, writer, created FROM post_comments WHERE post_id = ? ORDER BY id ASC', [id], (cErr, comments) => {
      if (cErr) {
        console.error('게시글 댓글 조회 오류', cErr);
        return res.status(500).json({ success: false, error: '댓글을 불러오지 못했습니다.' });
      }
      res.json({ success: true, post: row, comments: comments || [] });
    });
  });
});

app.post('/api/posts/:id/comments', async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
  }

  const postId = parseInt(req.params.id, 10);
  if (Number.isNaN(postId)) {
    return res.status(400).json({ success: false, error: '잘못된 게시글 ID' });
  }

  const raw = String(req.body.content || '').replace(/\r\n?/g, '\n').trim();
  if (!raw) {
    return res.status(400).json({ success: false, error: '댓글 내용을 입력해주세요.' });
  }
  const content = raw.slice(0, 2000);

  try {
    const postExists = await dbGet('SELECT id FROM posts WHERE id = ?', [postId]);
    if (!postExists) {
      return res.status(404).json({ success: false, error: '게시글을 찾을 수 없습니다.' });
    }

    const writer = req.session.user.username || '익명';
    const insertResult = await dbRun('INSERT INTO post_comments (post_id, content, writer) VALUES (?,?,?)', [postId, content, writer]);
    const comment = await dbGet('SELECT id, post_id, content, writer, created FROM post_comments WHERE id = ?', [insertResult.lastID]);
    const comments = await dbAll('SELECT id, post_id, content, writer, created FROM post_comments WHERE post_id = ? ORDER BY id ASC', [postId]);

    res.json({ success: true, comment, comments });
  } catch (err) {
    console.error('댓글 등록 오류', err);
    res.status(500).json({ success: false, error: '댓글을 저장하지 못했습니다.' });
  }
});

// 업체 목록 조회
app.get('/api/companies', (req, res) => {
  const { category, type, search } = req.query;
  let query = 'SELECT id, name, category, type, website, phone, messenger, messenger_id, description, rating, report_count, writer, created FROM companies';
  let params = [];
  let conditions = [];

  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }
  if (type) {
    conditions.push('type = ?');
    params.push(type);
  }
  if (search) {
    conditions.push('(name LIKE ? OR description LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY created DESC LIMIT 100';

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, error: 'DB 오류' });
    res.json({ success: true, companies: rows || [] });
  });
});

// 업체 등록
app.post('/api/companies', (req, res) => {
  const name = sanitize(req.body.name || '').slice(0, 100);
  const category = req.body.category; // 'payment' | 'credit' | 'scam' | 'other'
  const type = req.body.type; // 'safe' | 'fraud' | 'other'
  const website = sanitize(req.body.website || '').slice(0, 200);
  const phone = sanitize(req.body.phone || '').slice(0, 50);
  const messenger = sanitize(req.body.messenger || '').slice(0, 50);
  const messenger_id = sanitize(req.body.messenger_id || '').slice(0, 100);
  const description = sanitize(req.body.description || '', 1000);
  const rating = parseInt(req.body.rating) || 0;
  const writer = sanitize(req.body.writer || '익명', 40) || '익명';

  if (!name || !category || !type) {
    return res.json({ success: false, error: '필수 정보가 누락되었습니다' });
  }
  if (!['payment', 'credit', 'scam', 'other'].includes(category)) {
    return res.json({ success: false, error: '잘못된 카테고리입니다' });
  }
  if (!['safe', 'fraud', 'other'].includes(type)) {
    return res.json({ success: false, error: '잘못된 업체 분류입니다' });
  }

  db.run('INSERT INTO companies (name, category, type, website, phone, messenger, messenger_id, description, rating, writer) VALUES (?,?,?,?,?,?,?,?,?,?)', 
    [name, category, type, website, phone, messenger, messenger_id, description, rating, writer], function (err) {
    if (err) return res.status(500).json({ success: false, error: 'DB 오류' });
    res.json({ success: true, id: this.lastID });
  });
});

// 업체 상세 정보 조회
app.get('/api/companies/:id', (req, res) => {
  const companyId = parseInt(req.params.id);
  if (!companyId) return res.status(400).json({ success: false, error: '잘못된 업체 ID' });

  db.get('SELECT * FROM companies WHERE id = ?', [companyId], (err, company) => {
    if (err) return res.status(500).json({ success: false, error: 'DB 오류' });
    if (!company) return res.status(404).json({ success: false, error: '업체를 찾을 수 없습니다' });

    // 리뷰도 함께 조회
    db.all('SELECT * FROM company_reviews WHERE company_id = ? ORDER BY created DESC', [companyId], (err, reviews) => {
      if (err) return res.status(500).json({ success: false, error: 'DB 오류' });
      res.json({ success: true, company, reviews: reviews || [] });
    });
  });
});

// 업체 리뷰/신고 등록
app.post('/api/companies/:id/reviews', (req, res) => {
  const companyId = parseInt(req.params.id);
  const reviewType = req.body.review_type; // 'review' or 'report'
  const rating = parseInt(req.body.rating) || null;
  const content = sanitize(req.body.content || '', 1000);
  const writer = sanitize(req.body.writer || '익명', 40) || '익명';

  if (!companyId || !reviewType || !content) {
    return res.json({ success: false, error: '필수 정보가 누락되었습니다' });
  }
  if (!['review', 'report'].includes(reviewType)) {
    return res.json({ success: false, error: '잘못된 리뷰 타입입니다' });
  }

  db.run('INSERT INTO company_reviews (company_id, review_type, rating, content, writer) VALUES (?,?,?,?,?)', 
    [companyId, reviewType, rating, content, writer], function (err) {
    if (err) return res.status(500).json({ success: false, error: 'DB 오류' });
    
    // 신고 수 업데이트
    if (reviewType === 'report') {
      db.run('UPDATE companies SET report_count = report_count + 1 WHERE id = ?', [companyId]);
    }
    
    res.json({ success: true, id: this.lastID });
  });
});

app.get('/companies/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    const canonical = `${req.protocol}://${req.get('host')}/companies/${escapeHtml(req.params.id)}`;
    return res.status(404).send(renderSeoDocument({
      title: '업체 정보를 찾을 수 없습니다',
      description: '요청하신 업체 정보를 찾지 못했습니다.',
      canonical,
      ogType: 'website',
      bodyContent: '<main><header><h1>업체 정보를 찾을 수 없습니다.</h1><p class="meta">입력한 주소가 정확한지 확인해주세요.</p></header><section><p>해당 업체 정보가 존재하지 않거나 삭제되었습니다.</p><p><a class="cta" href="/">커뮤니티 홈으로 이동</a></p></section></main>'
    }));
  }

  try {
    const company = await dbGet('SELECT id, name, category, type, website, phone, messenger, messenger_id, description, rating, report_count, writer, created FROM companies WHERE id = ?', [id]);
    if (!company) {
      const canonical = `${req.protocol}://${req.get('host')}/companies/${id}`;
      return res.status(404).send(renderSeoDocument({
        title: '업체 정보를 찾을 수 없습니다',
        description: '요청한 업체가 존재하지 않습니다.',
        canonical,
        ogType: 'website',
        bodyContent: '<main><header><h1>업체 정보를 찾을 수 없습니다.</h1><p class="meta">요청하신 업체 정보를 찾지 못했습니다.</p></header><section><p>업체 정보가 삭제되었거나 주소가 잘못되었을 수 있습니다.</p><p><a class="cta" href="/">커뮤니티 홈으로 이동</a></p></section></main>'
      }));
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const canonical = `${baseUrl}/companies/${company.id}`;
    const categoryLabel = getCompanyCategoryLabel(company.category);
    const typeLabel = getCompanyTypeLabel(company.type);
    const metaDescription = buildMetaDescription(company.description, `${company.name} ${categoryLabel} ${typeLabel} 정보`);
    const structuredData = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'FinancialService',
      name: company.name,
      url: canonical,
      description: metaDescription,
      telephone: company.phone || undefined,
      areaServed: 'South Korea',
      serviceType: `${categoryLabel} · ${typeLabel}`,
      datePublished: toIsoDate(company.created),
      dateModified: toIsoDate(company.created),
      aggregateRating: company.rating ? {
        '@type': 'AggregateRating',
        ratingValue: company.rating,
        reviewCount: Math.max(1, company.rating)
      } : undefined,
      founder: company.writer && company.writer !== '익명' ? {
        '@type': 'Person',
        name: company.writer
      } : undefined
    });

    const reviews = await dbAll('SELECT review_type, rating, content, writer, created FROM company_reviews WHERE company_id = ? ORDER BY id DESC LIMIT 10', [company.id]);

    const reviewSection = reviews.length
      ? `<section style="margin-top:24px;"><h2 style="font-size:20px; margin-bottom:12px;">최근 이용 후기 및 신고</h2><ul>${reviews.map((review) => {
        const label = review.review_type === 'report' ? '🚨 신고' : '💬 리뷰';
        const ratingText = review.rating ? ` (${getRatingLabel(review.rating)})` : '';
        const author = escapeHtml(review.writer || '익명');
        const created = escapeHtml(new Date(`${review.created}Z`).toLocaleDateString('ko-KR'));
        return `<li><strong>${label}${ratingText}</strong> · ${author} · ${created}<br>${escapeHtml(review.content || '')}</li>`;
      }).join('')}</ul></section>`
      : '';

    const contactDetails = [
      `<p><strong>카테고리:</strong> ${escapeHtml(categoryLabel)} · ${escapeHtml(typeLabel)}</p>`,
      company.website ? `<p><strong>공식 웹사이트:</strong> <a rel="nofollow" href="${escapeHtml(company.website)}">${escapeHtml(company.website)}</a></p>` : '',
      company.phone ? `<p><strong>연락처:</strong> ${escapeHtml(company.phone)}</p>` : '',
      company.messenger && company.messenger_id ? `<p><strong>메신저:</strong> ${escapeHtml(company.messenger)} - ${escapeHtml(company.messenger_id)}</p>` : '',
      company.rating ? `<p><strong>평점:</strong> ${escapeHtml(getRatingLabel(company.rating))}</p>` : '',
      company.report_count ? `<p><strong>신고 누적:</strong> 🚨 ${escapeHtml(company.report_count)}</p>` : ''
    ].filter(Boolean).join('\n');

    const bodyContent = `
<main>
  <header>
    <h1>${escapeHtml(company.name)}</h1>
    <p class="meta">등록: ${escapeHtml(company.writer || '익명')} · ${escapeHtml(new Date(`${company.created}Z`).toLocaleString('ko-KR'))}</p>
  </header>
  <section>
    ${contactDetails}
    <p>${escapeHtml(company.description || '상세 설명이 등록되지 않았습니다.')}</p>
    <p><a class="cta" href="/?company=${company.id}">커뮤니티에서 이 업체 보기</a></p>
  </section>
  ${reviewSection}
  <footer>
    <p><a href="/">업체정보 커뮤니티 홈으로 돌아가기</a></p>
  </footer>
</main>`;

    res.type('text/html; charset=utf-8').send(renderSeoDocument({
      title: `${company.name} - ${categoryLabel} ${typeLabel} 정보`,
      description: metaDescription,
      canonical,
      ogType: 'article',
      structuredData,
      bodyContent
    }));
  } catch (err) {
    console.error('업체 SEO 페이지 렌더링 오류', err);
    const canonical = `${req.protocol}://${req.get('host')}/companies/${id}`;
    res.status(500).send(renderSeoDocument({
      title: '서버 오류가 발생했습니다',
      description: '요청을 처리하는 중 문제가 발생했습니다.',
      canonical,
      ogType: 'website',
      bodyContent: '<main><header><h1>잠시 후 다시 시도해주세요.</h1></header><section><p>죄송합니다. 서버 처리 중 문제가 발생했습니다.</p><p><a class="cta" href="/">커뮤니티 홈으로 이동</a></p></section></main>'
    }));
  }
});

app.get('/posts/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    const canonical = `${req.protocol}://${req.get('host')}/posts/${escapeHtml(req.params.id)}`;
    return res.status(404).send(renderSeoDocument({
      title: '게시글을 찾을 수 없습니다',
      description: '요청하신 게시글을 찾을 수 없습니다.',
      canonical,
      ogType: 'website',
      bodyContent: '<main><header><h1>게시글을 찾을 수 없습니다.</h1><p class="meta">주소를 다시 확인해주세요.</p></header><section><p>해당 게시글이 삭제되었거나 비공개 상태일 수 있습니다.</p><p><a class="cta" href="/">커뮤니티 홈으로 이동</a></p></section></main>'
    }));
  }

  try {
    const post = await dbGet('SELECT id, title, content, category, writer, created FROM posts WHERE id = ?', [id]);
    if (!post) {
      const canonical = `${req.protocol}://${req.get('host')}/posts/${id}`;
      return res.status(404).send(renderSeoDocument({
        title: '게시글을 찾을 수 없습니다',
        description: '요청하신 게시글이 존재하지 않습니다.',
        canonical,
        ogType: 'website',
        bodyContent: '<main><header><h1>게시글을 찾을 수 없습니다.</h1><p class="meta">게시글이 삭제되었거나 주소가 잘못되었습니다.</p></header><section><p><a class="cta" href="/">커뮤니티 홈으로 이동</a></p></section></main>'
      }));
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const canonical = `${baseUrl}/posts/${post.id}`;
    const metaTitle = (post.title && post.title !== '(제목 없음)') ? `${post.title} - 자유게시판 글` : '자유게시판 게시글';
    const metaDescription = buildMetaDescription(post.content, `${post.writer || '익명'}님의 자유게시판 글`);
    const structuredData = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title || '자유게시판 글',
      articleBody: post.content,
      author: post.writer ? {
        '@type': 'Person',
        name: post.writer
      } : undefined,
      url: canonical,
      datePublished: toIsoDate(post.created),
      dateModified: toIsoDate(post.created),
      publisher: {
        '@type': 'Organization',
        name: '업체정보 커뮤니티'
      }
    });

    const formattedContent = escapeHtml(post.content || '')
      .replace(/\n{2,}/g, '</p><p>')
      .replace(/\n/g, '<br />');

    const bodyContent = `
<main>
  <header>
    <h1>${escapeHtml(post.title || '자유게시판 글')}</h1>
    <p class="meta">작성자: ${escapeHtml(post.writer || '익명')} · ${escapeHtml(new Date(`${post.created}Z`).toLocaleString('ko-KR'))}</p>
  </header>
  <section>
    <p><strong>카테고리:</strong> ${escapeHtml(post.category || '자유게시판')}</p>
    <p>${formattedContent || '내용이 비어있습니다.'}</p>
    <p><a class="cta" href="/?post=${post.id}">커뮤니티에서 이 글 보기</a></p>
  </section>
  <footer>
    <p><a href="/">업체정보 커뮤니티 홈으로 돌아가기</a></p>
  </footer>
</main>`;

    res.type('text/html; charset=utf-8').send(renderSeoDocument({
      title: metaTitle,
      description: metaDescription,
      canonical,
      ogType: 'article',
      structuredData,
      bodyContent
    }));
  } catch (err) {
    console.error('게시글 SEO 페이지 렌더링 오류', err);
    const canonical = `${req.protocol}://${req.get('host')}/posts/${id}`;
    res.status(500).send(renderSeoDocument({
      title: '서버 오류가 발생했습니다',
      description: '요청을 처리하는 중 문제가 발생했습니다.',
      canonical,
      ogType: 'website',
      bodyContent: '<main><header><h1>잠시 후 다시 시도해주세요.</h1></header><section><p>서버 처리 중 오류가 발생했습니다.</p><p><a class="cta" href="/">커뮤니티 홈으로 이동</a></p></section></main>'
    }));
  }
});

app.get('/trending', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'trending.html'));
});

app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== 관리자 API ==========

// 미들웨어: 관리자 확인
function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.is_admin) {
    return res.status(403).json({ success: false, error: '관리자 권한이 필요합니다.' });
  }
  next();
}

// 모든 게시글 조회 (관리용)
app.get('/api/admin/posts', requireAdmin, async (req, res) => {
  try {
    const posts = await dbAll(`
      SELECT id, title, content, category, writer, created, 
             (SELECT COUNT(*) FROM post_comments WHERE post_id = posts.id) as comment_count
      FROM posts
      ORDER BY created DESC
      LIMIT 1000
    `);
    res.json({ success: true, posts });
  } catch (e) {
    console.error('관리자 게시글 조회 오류', e);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

// 게시글 삭제 (관리용)
app.delete('/api/admin/posts/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ success: false, error: '잘못된 게시글 ID입니다.' });
    }
    
    const post = await dbGet('SELECT id FROM posts WHERE id = ?', [id]);
    if (!post) {
      return res.status(404).json({ success: false, error: '게시글을 찾을 수 없습니다.' });
    }
    
    // post_comments도 함께 삭제됨 (FOREIGN KEY CASCADE)
    await dbRun('DELETE FROM posts WHERE id = ?', [id]);
    res.json({ success: true, message: '게시글이 삭제되었습니다.' });
  } catch (e) {
    console.error('게시글 삭제 오류', e);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

// 게시글 편집 (관리용)
app.put('/api/admin/posts/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const title = sanitize(req.body.title || '', 200);
    const content = sanitize(req.body.content || '', 5000);
    
    if (Number.isNaN(id)) {
      return res.status(400).json({ success: false, error: '잘못된 게시글 ID입니다.' });
    }
    
    const post = await dbGet('SELECT id FROM posts WHERE id = ?', [id]);
    if (!post) {
      return res.status(404).json({ success: false, error: '게시글을 찾을 수 없습니다.' });
    }
    
    await dbRun('UPDATE posts SET title = ?, content = ? WHERE id = ?', [title, content, id]);
    res.json({ success: true, message: '게시글이 수정되었습니다.' });
  } catch (e) {
    console.error('게시글 수정 오류', e);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

// 댓글 삭제 (관리용)
app.delete('/api/admin/comments/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ success: false, error: '잘못된 댓글 ID입니다.' });
    }
    
    const comment = await dbGet('SELECT id FROM post_comments WHERE id = ?', [id]);
    if (!comment) {
      return res.status(404).json({ success: false, error: '댓글을 찾을 수 없습니다.' });
    }
    
    await dbRun('DELETE FROM post_comments WHERE id = ?', [id]);
    res.json({ success: true, message: '댓글이 삭제되었습니다.' });
  } catch (e) {
    console.error('댓글 삭제 오류', e);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

// 모든 회원 조회 (관리용)
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await dbAll(`
      SELECT id, username, email, is_admin, created
      FROM users
      ORDER BY created DESC
      LIMIT 1000
    `);
    res.json({ success: true, users });
  } catch (e) {
    console.error('회원 조회 오류', e);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

// 회원 관리자 권한 변경 (관리용)
app.put('/api/admin/users/:id/toggle-admin', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ success: false, error: '잘못된 사용자 ID입니다.' });
    }
    
    // 자신의 관리자 권한은 변경할 수 없음
    if (id === req.session.user.id) {
      return res.status(400).json({ success: false, error: '자신의 권한은 변경할 수 없습니다.' });
    }
    
    const user = await dbGet('SELECT id, is_admin FROM users WHERE id = ?', [id]);
    if (!user) {
      return res.status(404).json({ success: false, error: '사용자를 찾을 수 없습니다.' });
    }
    
    const newAdminStatus = user.is_admin ? 0 : 1;
    await dbRun('UPDATE users SET is_admin = ? WHERE id = ?', [newAdminStatus, id]);
    res.json({ success: true, message: newAdminStatus ? '관리자로 설정되었습니다.' : '일반 사용자로 설정되었습니다.' });
  } catch (e) {
    console.error('관리자 권한 변경 오류', e);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

// 회원 삭제 (관리용)
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ success: false, error: '잘못된 사용자 ID입니다.' });
    }
    
    // 자신을 삭제할 수 없음
    if (id === req.session.user.id) {
      return res.status(400).json({ success: false, error: '자신을 삭제할 수 없습니다.' });
    }
    
    const user = await dbGet('SELECT id FROM users WHERE id = ?', [id]);
    if (!user) {
      return res.status(404).json({ success: false, error: '사용자를 찾을 수 없습니다.' });
    }
    
    await dbRun('DELETE FROM users WHERE id = ?', [id]);
    res.json({ success: true, message: '회원이 삭제되었습니다.' });
  } catch (e) {
    console.error('회원 삭제 오류', e);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Standalone community listening on http://localhost:${PORT}`);
});
