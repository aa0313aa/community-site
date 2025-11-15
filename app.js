const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { Pool: PgPool } = require('pg');
const fs = require('fs');
const bodyParser = require('body-parser');
const compression = require('compression');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 5500;

app.set('trust proxy', 1);

// 자유게시판 카테고리 (향후 확장 가능)
const POST_CATEGORIES = ['free'];

// 간단한 메모리 캐시 (최신 항목용)
const latestCache = {
  posts: { data: null, ts: 0 },
  companies: { data: null, ts: 0 }
};
const LATEST_TTL_MS = 60 * 1000; // 60초

// DB 선택: DATABASE_URL이 있으면 Postgres, 없으면 SQLite
const DATABASE_URL = process.env.DATABASE_URL && process.env.DATABASE_URL.trim();
const usePg = !!DATABASE_URL;

let db;            // sqlite3 Database instance (if SQLite)
let pgPool = null; // pg Pool (if Postgres)
let dbKind = usePg ? 'postgres' : 'sqlite';

if (usePg) {
  // Postgres
  pgPool = new PgPool({ connectionString: DATABASE_URL, ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined });
  console.log(`[DB] Using PostgreSQL: ${DATABASE_URL.replace(/:[^:@/]+@/, '://***:***@')}`);
} else {
  // SQLite (환경변수로 경로 지정 가능: DB_FILE)
  // 예) Render 디스크 사용 시: DB_FILE=/var/data/community.db
  const RESOLVED_DB_FILE = process.env.DB_FILE && process.env.DB_FILE.trim().length > 0
    ? process.env.DB_FILE.trim()
    : path.join(__dirname, 'community.db');

  // DB 파일 디렉터리가 없으면 생성 (예: /var/data)
  try {
    const dir = path.dirname(RESOLVED_DB_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (e) {
    console.warn('DB 디렉터리 생성 경고:', e.message);
  }

  console.log(`[DB] Using SQLite file: ${RESOLVED_DB_FILE}`);
  db = new sqlite3.Database(RESOLVED_DB_FILE);
}

// SQL 헬퍼: '?'-placeholder를 Postgres의 $1, $2... 로 변환
function toPgParams(sql) {
  const parts = String(sql || '').split('?');
  if (parts.length === 1) return sql;
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    out += `$${i}` + parts[i];
  }
  return out;
}

async function pgQuery(sql, params = []) {
  const mapped = toPgParams(sql);
  const res = await pgPool.query(mapped, params);
  return res;
}

// 통합 DB 유틸
async function dbGet(sql, params = []) {
  if (usePg) {
    const r = await pgQuery(sql, params);
    return r.rows[0] || null;
  }
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

async function dbAll(sql, params = []) {
  if (usePg) {
    const r = await pgQuery(sql, params);
    return r.rows || [];
  }
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

async function dbRun(sql, params = []) {
  if (usePg) {
    // INSERT인 경우 id를 반환하도록 RETURNING 추가 (이미 포함돼 있지 않다면)
    let q = sql;
    const isInsert = /^\s*insert\s+/i.test(q);
    const hasReturning = /returning\s+\w+/i.test(q);
    if (isInsert && !hasReturning) {
      q = `${q} RETURNING id`;
    }
    const r = await pgQuery(q, params);
    const lastID = isInsert ? (r.rows && r.rows[0] && (r.rows[0].id || r.rows[0].lastID)) : undefined;
    return { lastID, changes: r.rowCount };
  }
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

async function safeAlter(sql) {
  try {
    await dbRun(sql);
  } catch (e) {
    const msg = String(e && e.message || '');
    if (msg.includes('duplicate column') || msg.includes('already exists')) {
      // ignore
      console.warn('ALTER 무시(이미 존재):', sql);
    } else {
      throw e;
    }
  }
}

// 메일 전송기 생성 (환경변수 기반, 없으면 null)
function createMailTransport() {
  // 우선 SMTP_* 환경변수 기반 설정을 시도
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : undefined;
  const secure = (process.env.SMTP_SECURE || '').toLowerCase();
  const isSecure = secure === 'true' || secure === '1' || secure === 'yes';

  if (host && user && pass) {
    try {
      const transporter = nodemailer.createTransport({
        host,
        port: port || (isSecure ? 465 : 587),
        secure: isSecure,
        auth: { user, pass },
      });
      return transporter;
    } catch (e) {
      console.warn('메일 전송기 생성 실패:', e && e.message);
      return null;
    }
  }
  return null;
}

const mailTransport = createMailTransport();

// DB 초기화 (SQLite/PG 공용)
(async function initDb() {
  try {
    if (usePg) {
      // Postgres 스키마
      await dbRun(`CREATE TABLE IF NOT EXISTS posts (
        id SERIAL PRIMARY KEY,
        title TEXT,
        content TEXT,
        category TEXT DEFAULT 'free',
        writer TEXT,
        created TIMESTAMP DEFAULT NOW()
      )`);

  await safeAlter(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'free'`);
  // 숨김 플래그 컬럼 (게시글 노출 제어)
  await safeAlter(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_hidden INTEGER DEFAULT 0`);
  // 첨부파일 컬럼 (이미지/동영상 경로 JSON 배열)
  await safeAlter(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS attachments TEXT`);

      await dbRun(`CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin INTEGER DEFAULT 0,
        created TIMESTAMP DEFAULT NOW()
      )`);

  await safeAlter(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`);
  await safeAlter(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin INTEGER DEFAULT 0`);

      await dbRun(`CREATE TABLE IF NOT EXISTS password_resets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created TIMESTAMP DEFAULT NOW()
      )`);

      await dbRun(`CREATE TABLE IF NOT EXISTS companies (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        type TEXT NOT NULL,
        website TEXT,
        phone TEXT,
        messenger TEXT,
        messenger_id TEXT,
        description TEXT,
        rating INTEGER DEFAULT 0,
        report_count INTEGER DEFAULT 0,
        writer TEXT,
        created TIMESTAMP DEFAULT NOW()
      )`);

      await dbRun(`CREATE TABLE IF NOT EXISTS company_reviews (
        id SERIAL PRIMARY KEY,
        company_id INTEGER REFERENCES companies(id),
        review_type TEXT NOT NULL,
        rating INTEGER,
        content TEXT,
        writer TEXT,
        created TIMESTAMP DEFAULT NOW()
      )`);

      await dbRun(`CREATE TABLE IF NOT EXISTS post_comments (
        id SERIAL PRIMARY KEY,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        writer TEXT,
        created TIMESTAMP DEFAULT NOW()
      )`);

  await safeAlter(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS messenger TEXT`);
  await safeAlter(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS messenger_id TEXT`);
  await safeAlter(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS is_certified INTEGER DEFAULT 0`);
  await safeAlter(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS certified_by TEXT`);
  await safeAlter(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS certified_at TIMESTAMP`);
    } else {
      // SQLite 스키마
      await dbRun(`CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        content TEXT,
        category TEXT DEFAULT 'free',
        writer TEXT,
        created DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
  await safeAlter(`ALTER TABLE posts ADD COLUMN category TEXT DEFAULT 'free'`);
  // 숨김 플래그 (SQLite)
  await safeAlter(`ALTER TABLE posts ADD COLUMN is_hidden INTEGER DEFAULT 0`);
  // 첨부파일 (SQLite)
  await safeAlter(`ALTER TABLE posts ADD COLUMN attachments TEXT`);

      await dbRun(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin INTEGER DEFAULT 0,
        created DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
  await safeAlter(`ALTER TABLE users ADD COLUMN email TEXT`);
  await safeAlter(`ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0`);

      await dbRun(`CREATE TABLE IF NOT EXISTS password_resets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        created DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`);

      await dbRun(`CREATE TABLE IF NOT EXISTS companies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        type TEXT NOT NULL,
        website TEXT,
        phone TEXT,
        messenger TEXT,
        messenger_id TEXT,
        description TEXT,
        rating INTEGER DEFAULT 0,
        report_count INTEGER DEFAULT 0,
        writer TEXT,
        created DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      await dbRun(`CREATE TABLE IF NOT EXISTS company_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER,
        review_type TEXT NOT NULL,
        rating INTEGER,
        content TEXT,
        writer TEXT,
        created DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(company_id) REFERENCES companies(id)
      )`);

      await dbRun(`CREATE TABLE IF NOT EXISTS post_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        writer TEXT,
        created DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(post_id) REFERENCES posts(id) ON DELETE CASCADE
      )`);

  await safeAlter(`ALTER TABLE companies ADD COLUMN messenger TEXT`);
  await safeAlter(`ALTER TABLE companies ADD COLUMN messenger_id TEXT`);
  await safeAlter(`ALTER TABLE companies ADD COLUMN is_certified INTEGER DEFAULT 0`);
  await safeAlter(`ALTER TABLE companies ADD COLUMN certified_by TEXT`);
  await safeAlter(`ALTER TABLE companies ADD COLUMN certified_at DATETIME`);
    }

    // 🔐 기본 관리자 계정 자동 생성 (처음 한 번만)
    const adminUsername = 'admin';
    const adminEmail = 'admin@community.com';
    const adminPassword = 'Admin@123456';

    const exists = await dbGet('SELECT id FROM users WHERE username = ?', [adminUsername]);
    if (!exists) {
      const hash = bcrypt.hashSync(adminPassword, 10);
      await dbRun('INSERT INTO users (username, email, password_hash, is_admin) VALUES (?,?,?,?)', [adminUsername, adminEmail, hash, 1]);
      console.log('✅ 기본 관리자 계정 자동 생성:');
      console.log(`   아이디: ${adminUsername}`);
      console.log(`   이메일: ${adminEmail}`);
      console.log(`   비밀번호: ${adminPassword}`);
      console.log('   ⚠️ 처음 로그인 후 비밀번호를 변경해주세요!');
    }
  } catch (e) {
    console.error('DB 초기화 오류:', e);
  }
})();

app.use(cors());
// 응답 압축으로 전송량 절감
app.use(compression());
app.use(bodyParser.json({ limit: '50mb' }));
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

// Multer 설정 (파일 업로드)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, 'public', 'uploads'));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB (동영상 지원)
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp|mp4|mov|avi|webm/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('이미지(jpg, png, gif, webp) 또는 동영상(mp4, mov, avi, webm)만 업로드 가능합니다.'));
  }
});

// 정적 파일 캐싱 (브라우저 캐시 활용)
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '7d',
  etag: true,
  lastModified: true
}));

// 모든 POST 요청 로깅 (디버그: 숨김 처리 404 원인 파악)
app.use((req, res, next) => {
  if (req.method === 'POST') {
    console.log('[DEBUG] POST incoming', req.originalUrl);
  }
  next();
});

// 간단 헬스체크 (업타임 모니터/워머용)
app.get('/healthz', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, time: new Date().toISOString(), db: dbKind });
});

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

// dbGet/dbRun/dbAll는 상단의 통합 유틸을 사용합니다.

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
    if (process.env.NODE_ENV !== 'production' || process.env.EMAIL_DEBUG === '1') {
      response.resetUrl = resetUrl;
      response.token = token;
    }

    console.info(`비밀번호 재설정 요청: user=${user.username}, email=${user.email}, resetUrl=${resetUrl}`);

    // 메일 발송 (SMTP 환경변수 설정 시)
    const fromName = process.env.MAIL_NAME || '커뮤니티 비밀번호 재설정';
    const fromEmail = process.env.MAIL_FROM || `no-reply@${(host || '').split(':')[0] || 'localhost'}`;
    if (mailTransport) {
      try {
        await mailTransport.sendMail({
          from: `${fromName} <${fromEmail}>`,
          to: user.email,
          subject: '[커뮤니티] 비밀번호 재설정 안내',
          text: `안녕하세요, ${user.username}님.\n\n아래 링크를 눌러 비밀번호를 재설정하세요. 이 링크는 1시간 동안만 유효합니다.\n\n${resetUrl}\n\n만약 본인이 요청한 것이 아니라면 이 메일을 무시하셔도 됩니다.`,
          html: `<p>안녕하세요, <b>${escapeHtml(user.username)}</b>님.</p>
<p>아래 버튼을 눌러 비밀번호를 재설정하세요. 이 링크는 <b>1시간</b> 동안만 유효합니다.</p>
<p><a href="${resetUrl}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px">비밀번호 재설정</a></p>
<p>링크가 눌리지 않으면 아래 주소를 복사해 브라우저에 붙여넣기 하세요:</p>
<p><code>${escapeHtml(resetUrl)}</code></p>
<hr/>
<p>본인이 요청한 것이 아니라면 이 메일을 무시하세요.</p>`
        });
        console.info('✅ 재설정 메일 발송 완료:', user.email);
      } catch (mailErr) {
        console.warn('⚠️ 재설정 메일 발송 실패:', mailErr && mailErr.message);
      }
    } else {
      console.info('메일 환경이 설정되지 않아 실제 메일은 전송되지 않았습니다. SMTP 환경변수를 설정하면 메일 전송됩니다.');
    }

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
    const nowExpr = usePg ? 'NOW()' : "datetime('now')";
    const resetRow = await dbGet(
      `SELECT pr.id, pr.user_id
       FROM password_resets pr
       WHERE pr.token_hash = ? AND pr.expires_at > ${nowExpr}
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
    '',
    '# 기본 설정 - 모든 크롤러 허용',
    'User-agent: *',
    'Allow: /',
    'Crawl-delay: 1',
    '',
    '# Google 특화 설정',
    'User-agent: Googlebot',
    'Allow: /',
    'Crawl-delay: 0',
    '',
    '# Google 이미지봇',
    'User-agent: Googlebot-Image',
    'Allow: /',
    '',
    '# Google 모바일봇',
    'User-agent: Googlebot-Mobile',
    'Allow: /',
    '',
    '# Naver 크롤러',
    'User-agent: Yeti',
    'Allow: /',
    'Crawl-delay: 1',
    '',
    '# Daum 크롤러',
    'User-agent: Daumoa',
    'Allow: /',
    'Crawl-delay: 1',
    '',
    '# Bing 크롤러',
    'User-agent: Bingbot',
    'Allow: /',
    'Crawl-delay: 1',
    '',
    '# 악성 봇 차단',
    'User-agent: AhrefsBot',
    'Disallow: /',
    '',
    'User-agent: SemrushBot',
    'Disallow: /',
    '',
    'User-agent: MJ12bot',
    'Disallow: /',
    '',
    `Sitemap: ${baseUrl}/sitemap.xml`
  ].join('\n');
  res.set({
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=86400', // 24시간 캐시
    'X-Robots-Tag': 'noindex' // robots.txt 자체는 인덱싱하지 않음
  }).send(content);
});

app.get('/sitemap.xml', async (req, res) => {
  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const [companyRows, postRows] = await Promise.all([
      dbAll('SELECT id, created FROM companies ORDER BY created DESC LIMIT 5000'),
      dbAll('SELECT id, created FROM posts WHERE is_hidden = 0 ORDER BY created DESC LIMIT 5000')
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
    
    // 업체 페이지 (주간 업데이트) - 최신 5개 priority 상향
    companyRows.forEach((row, idx) => {
      entries.push({
        loc: `${baseUrl}/companies/${row.id}`,
        lastmod: toIsoDate(row.created),
        changefreq: 'weekly',
        priority: idx < 5 ? '0.9' : '0.5'
      });
    });
    
    // 게시글 페이지 (일일 업데이트) - 최신 5개 priority 상향
    postRows.forEach((row, idx) => {
      entries.push({
        loc: `${baseUrl}/posts/${row.id}`,
        lastmod: toIsoDate(row.created),
        changefreq: 'daily',
        priority: idx < 5 ? '0.9' : '0.5'
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

    // 개발 중에는 캐시하지 않도록 헤더 설정, 운영에서는 1시간 캐싱
    if (process.env.NODE_ENV !== 'production') {
      res.set('Cache-Control', 'no-store');
    } else {
      res.set('Cache-Control', 'public, max-age=3600');
    }
    res.type('application/xml; charset=utf-8').send(xml);
  } catch (err) {
    console.error('Sitemap 생성 오류', err);
    res.status(500).type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
  }
});

app.get('/api/posts', async (req, res) => {
  try {
    const category = sanitize(req.query.category || '').toLowerCase();
    let query = `SELECT p.id, p.title, p.content, p.category, p.writer, p.created,
      (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id) AS comment_count
      FROM posts p`;
    const params = [];

    if (category && POST_CATEGORIES.includes(category)) {
      query += ' WHERE p.category = ? AND p.is_hidden = 0';
      params.push(category);
    } else {
      query += ' WHERE p.is_hidden = 0';
    }

    query += ' ORDER BY p.id DESC LIMIT 200';

    const rows = await dbAll(query, params);
    res.json({ success: true, posts: rows || [] });
  } catch (err) {
    console.error('게시글 목록 조회 오류', err);
    res.status(500).json({ success: false, error: 'DB 오류' });
  }
});

// 파일 업로드 API (이미지 및 동영상)
app.post('/api/upload', requireAuth, upload.array('files', 5), (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: '파일이 선택되지 않았습니다.' });
    }

    const filePaths = req.files.map(file => `/uploads/${file.filename}`);
    res.json({ success: true, files: filePaths });
  } catch (err) {
    console.error('파일 업로드 오류', err);
    res.status(500).json({ success: false, error: '파일 업로드 실패' });
  }
});

app.post('/api/posts', async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    }

    const title = sanitize(req.body.title || '').slice(0, 120) || '(제목 없음)';
    const content = sanitize(req.body.content || '', 8000);
    const categoryRaw = sanitize(req.body.category || 'free', 20).toLowerCase();
    const category = POST_CATEGORIES.includes(categoryRaw) ? categoryRaw : 'free';
    const writer = req.session.user.username;
    const attachments = req.body.attachments ? JSON.stringify(req.body.attachments) : null;
    if (!content) return res.json({ success: false, error: '내용이 비어 있습니다' });

    const r = await dbRun('INSERT INTO posts (title, content, category, writer, attachments) VALUES (?,?,?,?,?)', [title, content, category, writer, attachments]);
    res.json({ success: true, id: r.lastID });
  } catch (err) {
    console.error('게시글 등록 오류', err);
    res.status(500).json({ success: false, error: 'DB 오류' });
  }
});

app.get('/api/posts/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ success: false, error: '잘못된 게시글 ID' });
    }

    const row = await dbGet('SELECT id, title, content, category, writer, created, is_hidden, attachments FROM posts WHERE id = ?', [id]);
    if (!row || row.is_hidden) {
      return res.status(404).json({ success: false, error: '게시글을 찾을 수 없습니다.' });
    }

    // attachments를 JSON 파싱
    if (row.attachments) {
      try {
        row.attachments = JSON.parse(row.attachments);
      } catch (e) {
        row.attachments = [];
      }
    } else {
      row.attachments = [];
    }

    const comments = await dbAll('SELECT id, post_id, content, writer, created FROM post_comments WHERE post_id = ? ORDER BY id ASC', [id]);
    res.json({ success: true, post: row, comments: comments || [] });
  } catch (err) {
    console.error('게시글 조회 오류', err);
    res.status(500).json({ success: false, error: 'DB 오류' });
  }
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
app.get('/api/companies', async (req, res) => {
  try {
    const { category, type, search } = req.query;
  let query = 'SELECT id, name, category, type, website, phone, messenger, messenger_id, description, rating, report_count, writer, created, is_certified, certified_by, certified_at FROM companies';
    const params = [];
    const conditions = [];

    if (category) {
      conditions.push('category = ?');
      params.push(category);
    }
    if (type) {
      conditions.push('type = ?');
      params.push(type);
    }
    if (search) {
      // Postgres에서는 ILIKE로 변경하면 대소문자 무시 검색이 됩니다. 간단히 LIKE 유지.
      conditions.push('(name LIKE ? OR description LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY created DESC LIMIT 100';

    const rows = await dbAll(query, params);
    // 공개 목록은 단기 캐시 허용 (브라우저)
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ success: true, companies: rows || [] });
  } catch (err) {
    console.error('업체 목록 조회 오류', err);
    res.status(500).json({ success: false, error: 'DB 오류' });
  }
});

// 업체 등록 (로그인 필요)
app.post('/api/companies', requireAuth, async (req, res) => {
  try {
    const name = sanitize(req.body.name || '').slice(0, 100);
    const category = req.body.category; // 'payment' | 'credit' | 'scam' | 'other'
    const type = req.body.type; // 'safe' | 'fraud' | 'other'
    const website = sanitize(req.body.website || '').slice(0, 200);
    const phone = sanitize(req.body.phone || '').slice(0, 50);
    const messenger = sanitize(req.body.messenger || '').slice(0, 50);
    const messenger_id = sanitize(req.body.messenger_id || '').slice(0, 100);
    const description = sanitize(req.body.description || '', 1000);
    const rating = parseInt(req.body.rating) || 0;
    const writer = req.session.user.username; // 로그인된 사용자명으로 고정

    if (!name || !category || !type) {
      return res.json({ success: false, error: '필수 정보가 누락되었습니다' });
    }
    if (!['payment', 'credit', 'scam', 'other'].includes(category)) {
      return res.json({ success: false, error: '잘못된 카테고리입니다' });
    }
    if (!['safe', 'fraud', 'other'].includes(type)) {
      return res.json({ success: false, error: '잘못된 업체 분류입니다' });
    }

    const r = await dbRun('INSERT INTO companies (name, category, type, website, phone, messenger, messenger_id, description, rating, writer) VALUES (?,?,?,?,?,?,?,?,?,?)', 
      [name, category, type, website, phone, messenger, messenger_id, description, rating, writer]);
    res.json({ success: true, id: r.lastID });
  } catch (err) {
    console.error('업체 등록 오류', err);
    res.status(500).json({ success: false, error: 'DB 오류' });
  }
});

// 업체 상세 정보 조회
app.get('/api/companies/:id', async (req, res) => {
  try {
    const companyId = parseInt(req.params.id, 10);
    if (!companyId) return res.status(400).json({ success: false, error: '잘못된 업체 ID' });

    const company = await dbGet('SELECT * FROM companies WHERE id = ?', [companyId]);
    if (!company) return res.status(404).json({ success: false, error: '업체를 찾을 수 없습니다' });

    const reviews = await dbAll('SELECT * FROM company_reviews WHERE company_id = ? ORDER BY created DESC', [companyId]);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ success: true, company, reviews: reviews || [] });
  } catch (err) {
    console.error('업체 상세 조회 오류', err);
    res.status(500).json({ success: false, error: 'DB 오류' });
  }
});

// 업체 리뷰/신고 등록
app.post('/api/companies/:id/reviews', async (req, res) => {
  try {
    const companyId = parseInt(req.params.id, 10);
  const reviewType = req.body.review_type; // 'review' or 'report'
  const rating = parseInt(req.body.rating) || null;
  const content = sanitize(req.body.content || '', 1000);
  const writer = (req.session?.user?.username) || (sanitize(req.body.writer || '익명', 40) || '익명');

    if (!companyId || !reviewType || !content) {
      return res.json({ success: false, error: '필수 정보가 누락되었습니다' });
    }
    if (!['review', 'report'].includes(reviewType)) {
      return res.json({ success: false, error: '잘못된 리뷰 타입입니다' });
    }

    const r = await dbRun('INSERT INTO company_reviews (company_id, review_type, rating, content, writer) VALUES (?,?,?,?,?)', 
      [companyId, reviewType, rating, content, writer]);
    if (reviewType === 'report') {
      await dbRun('UPDATE companies SET report_count = report_count + 1 WHERE id = ?', [companyId]);
    }
    res.json({ success: true, id: r.lastID });
  } catch (err) {
    console.error('업체 리뷰/신고 등록 오류', err);
    res.status(500).json({ success: false, error: 'DB 오류' });
  }
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
      '@type': ['FinancialService','LocalBusiness'],
      name: company.name,
      url: canonical,
      description: metaDescription,
      telephone: company.phone || undefined,
      areaServed: 'KR',
      serviceType: `${categoryLabel} · ${typeLabel}`,
      address: {
        '@type': 'PostalAddress',
        addressCountry: 'KR'
      },
      sameAs: company.website ? [company.website] : undefined,
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

    res.set('Cache-Control', 'public, max-age=300');
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
    const post = await dbGet('SELECT id, title, content, category, writer, created, is_hidden FROM posts WHERE id = ?', [id]);
    if (!post || post.is_hidden) {
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
      '@type': ['Article','BlogPosting'],
      headline: post.title || '자유게시판 글',
      name: post.title || '자유게시판 글',
      articleSection: post.category || 'free',
      inLanguage: 'ko-KR',
      articleBody: post.content,
      author: post.writer ? {
        '@type': 'Person',
        name: post.writer
      } : { '@type':'Organization', name:'익명' },
      url: canonical,
      mainEntityOfPage: canonical,
      datePublished: toIsoDate(post.created),
      dateModified: toIsoDate(post.created),
      publisher: {
        '@type': 'Organization',
        name: '업체정보 커뮤니티',
        logo: {
          '@type': 'ImageObject',
          url: `${baseUrl}/logo.png`
        }
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
    console.warn('[ADMIN] requireAdmin blocked', {
      url: req.originalUrl,
      method: req.method,
      user: req.session && req.session.user ? {
        id: req.session.user.id,
        username: req.session.user.username,
        is_admin: !!req.session.user.is_admin
      } : null
    });
    return res.status(403).json({ success: false, error: '관리자 권한이 필요합니다.' });
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
  }
  next();
}

// 모든 게시글 조회 (관리용)
app.get('/api/admin/posts', requireAdmin, async (req, res) => {
  try {
    const posts = await dbAll(`
      SELECT id, title, content, category, writer, created, 
             (SELECT COUNT(*) FROM post_comments WHERE post_id = posts.id) as comment_count,
             is_hidden
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
    
    const post = await dbGet('SELECT id, attachments FROM posts WHERE id = ?', [id]);
    if (!post) {
      return res.status(404).json({ success: false, error: '게시글을 찾을 수 없습니다.' });
    }

    // 첨부파일 삭제
    if (post.attachments) {
      try {
        const attachments = JSON.parse(post.attachments);
        attachments.forEach(filePath => {
          const fullPath = path.join(__dirname, 'public', filePath);
          fs.unlink(fullPath, (err) => {
            if (err) console.error('파일 삭제 오류:', filePath, err);
            else console.log('파일 삭제 완료:', filePath);
          });
        });
      } catch (e) {
        console.error('첨부파일 삭제 중 오류', e);
      }
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

// 게시글 숨김 (관리용)
app.post('/api/admin/posts/:id/hide', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ success: false, error: '잘못된 게시글 ID입니다.' });
    }
    console.log('[ADMIN] hide post request', { id, user: req.session.user && req.session.user.username });
    const post = await dbGet('SELECT id, is_hidden FROM posts WHERE id = ?', [id]);
    if (!post) return res.status(404).json({ success: false, error: '게시글을 찾을 수 없습니다.' });
    if (post.is_hidden) return res.json({ success: true, message: '이미 숨김 처리된 글입니다.' });
    await dbRun('UPDATE posts SET is_hidden = 1 WHERE id = ?', [id]);
    res.json({ success: true, message: '게시글이 숨김 처리되었습니다.' });
  } catch (e) {
    console.error('게시글 숨김 오류', e);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

// 게시글 숨김 해제 (관리용)
app.post('/api/admin/posts/:id/unhide', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ success: false, error: '잘못된 게시글 ID입니다.' });
    }
    console.log('[ADMIN] unhide post request', { id, user: req.session.user && req.session.user.username });
    const post = await dbGet('SELECT id, is_hidden FROM posts WHERE id = ?', [id]);
    if (!post) return res.status(404).json({ success: false, error: '게시글을 찾을 수 없습니다.' });
    if (!post.is_hidden) return res.json({ success: true, message: '이미 공개 상태입니다.' });
    await dbRun('UPDATE posts SET is_hidden = 0 WHERE id = ?', [id]);
    res.json({ success: true, message: '게시글 숨김이 해제되었습니다.' });
  } catch (e) {
    console.error('게시글 숨김 해제 오류', e);
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

// -------- 미매칭 API 라우트 최종 처리기 (디버그용) --------
// 위에서 처리되지 않은 /api 경로로 오는 모든 요청을 JSON 형태로 404 반환
// (moved) API 404 fallback is registered at the very end after all API routes

// 마이페이지: 내가 쓴 글 조회
app.get('/api/mypage/posts', requireAuth, async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    }
    
    const posts = await dbAll(`
      SELECT id, title, content, category as section, created, is_hidden,
             (SELECT COUNT(*) FROM post_comments WHERE post_id = posts.id) AS comment_count
      FROM posts
      WHERE writer = ?
      ORDER BY created DESC
      LIMIT 100
    `, [req.session.user.username]);
    
    res.json({ success: true, posts: posts || [] });
  } catch (e) {
    console.error('내 글 조회 오류', e);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

// 마이페이지: 내가 쓴 댓글 조회
app.get('/api/mypage/comments', requireAuth, async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    }
    
    const comments = await dbAll(`
      SELECT id, post_id, content, created
      FROM post_comments
      WHERE writer = ?
      ORDER BY created DESC
      LIMIT 100
    `, [req.session.user.username]);
    
    res.json({ success: true, comments: comments || [] });
  } catch (e) {
    console.error('내 댓글 조회 오류', e);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

// 최근 항목 (SEO 내부링크 강화용)
app.get('/api/latest/posts', async (req, res) => {
  try {
    const now = Date.now();
    if (latestCache.posts.data && (now - latestCache.posts.ts) < LATEST_TTL_MS) {
      return res.json({ success: true, posts: latestCache.posts.data });
    }
    const rows = await dbAll(`SELECT id, title, writer, created FROM posts WHERE is_hidden = 0 ORDER BY id DESC LIMIT 8`);
    latestCache.posts = { data: rows || [], ts: now };
    res.json({ success: true, posts: latestCache.posts.data });
  } catch (e) {
    console.error('최근 게시글 조회 오류', e);
    res.status(500).json({ success: false, error: '서버 오류' });
  }
});

app.get('/api/latest/companies', async (req, res) => {
  try {
    const now = Date.now();
    if (latestCache.companies.data && (now - latestCache.companies.ts) < LATEST_TTL_MS) {
      return res.json({ success: true, companies: latestCache.companies.data });
    }
    const rows = await dbAll(`SELECT id, name, category, type, is_certified, rating, created FROM companies ORDER BY id DESC LIMIT 8`);
    latestCache.companies = { data: rows || [], ts: now };
    res.json({ success: true, companies: latestCache.companies.data });
  } catch (e) {
    console.error('최근 업체 조회 오류', e);
    res.status(500).json({ success: false, error: '서버 오류' });
  }
});

// 마이페이지: 내가 등록한 업체 조회
app.get('/api/mypage/companies', requireAuth, async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    }

    const rows = await dbAll(`
      SELECT id, name, category, type, rating, report_count, created
      FROM companies
      WHERE writer = ?
      ORDER BY created DESC
      LIMIT 200
    `, [req.session.user.username]);

    res.json({ success: true, companies: rows || [] });
  } catch (e) {
    console.error('내 업체 조회 오류', e);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

// 관리자: 업체 목록 조회
app.get('/api/admin/companies', requireAdmin, async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT id, name, category, type, website, phone, messenger, messenger_id, description,
             rating, report_count, writer, created, is_certified, certified_by, certified_at
      FROM companies
      ORDER BY created DESC
      LIMIT 1000
    `);
    res.json({ success: true, companies: rows || [] });
  } catch (e) {
    console.error('관리자 업체 목록 조회 오류', e);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

// 관리자: 정상업체 인증 처리
app.post('/api/admin/companies/:id/certify', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ success: false, error: '잘못된 업체 ID입니다.' });
    const company = await dbGet('SELECT id, type FROM companies WHERE id = ?', [id]);
    if (!company) return res.status(404).json({ success: false, error: '업체를 찾을 수 없습니다.' });
    if (company.type !== 'safe') return res.status(400).json({ success: false, error: '정상업체만 인증할 수 있습니다.' });

    const adminUser = req.session?.user?.username || 'admin';
    const now = new Date().toISOString();
    await dbRun('UPDATE companies SET is_certified = 1, certified_by = ?, certified_at = ? WHERE id = ?', [adminUser, now, id]);
    res.json({ success: true });
  } catch (e) {
    console.error('업체 인증 처리 오류', e);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

// 관리자: 정상업체 인증 해제
app.post('/api/admin/companies/:id/uncertify', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ success: false, error: '잘못된 업체 ID입니다.' });
    const company = await dbGet('SELECT id FROM companies WHERE id = ?', [id]);
    if (!company) return res.status(404).json({ success: false, error: '업체를 찾을 수 없습니다.' });

    await dbRun('UPDATE companies SET is_certified = 0, certified_by = NULL, certified_at = NULL WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (e) {
    console.error('업체 인증 해제 오류', e);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

// 관리자: 업체 정보 수정
app.put('/api/admin/companies/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ success: false, error: '잘못된 업체 ID입니다.' });
    }

    const existing = await dbGet('SELECT id FROM companies WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: '업체를 찾을 수 없습니다.' });
    }

    const name = sanitize(req.body.name || '').slice(0, 100);
    const category = String(req.body.category || '').trim();
    const type = String(req.body.type || '').trim();
    const website = sanitize(req.body.website || '').slice(0, 200);
    const phone = sanitize(req.body.phone || '').slice(0, 50);
    const messenger = sanitize(req.body.messenger || '').slice(0, 50);
    const messenger_id = sanitize(req.body.messenger_id || '').slice(0, 100);
    const description = sanitize(req.body.description || '', 1000);
    let rating = parseInt(req.body.rating, 10);

    if (!name || !category || !type) {
      return res.status(400).json({ success: false, error: '필수 정보를 모두 입력해주세요.' });
    }
    if (!['payment', 'credit', 'scam', 'other'].includes(category)) {
      return res.status(400).json({ success: false, error: '잘못된 카테고리입니다.' });
    }
    if (!['safe', 'fraud', 'other'].includes(type)) {
      return res.status(400).json({ success: false, error: '잘못된 분류입니다.' });
    }
    if (Number.isNaN(rating)) rating = 0;
    rating = Math.max(0, Math.min(5, rating));

    await dbRun(
      `UPDATE companies
       SET name = ?, category = ?, type = ?, website = ?, phone = ?, messenger = ?, messenger_id = ?, description = ?, rating = ?
       WHERE id = ?`,
      [name, category, type, website, phone, messenger, messenger_id, description, rating, id]
    );

    res.json({ success: true });
  } catch (e) {
    console.error('관리자 업체 수정 오류', e);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

// 마이페이지: 비밀번호 변경
app.post('/api/change-password', requireAuth, async (req, res) => {
  try {
    if (!req.session.user) {
      return res.status(401).json({ success: false, error: '로그인이 필요합니다.' });
    }

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, error: '현재 비밀번호와 새 비밀번호를 모두 입력해주세요.' });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, error: '새 비밀번호는 8자 이상이어야 합니다.' });
    }

    const user = await dbGet('SELECT id, password_hash FROM users WHERE id = ?', [req.session.user.id]);
    if (!user) {
      return res.status(404).json({ success: false, error: '사용자를 찾을 수 없습니다.' });
    }

    // 현재 비밀번호 확인
    const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ success: false, error: '현재 비밀번호가 일치하지 않습니다.' });
    }

    // 새 비밀번호 해시화
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [hashedPassword, req.session.user.id]);

    res.json({ success: true, message: '비밀번호가 변경되었습니다.' });
  } catch (e) {
    console.error('비밀번호 변경 오류', e);
    res.status(500).json({ success: false, error: '서버 오류가 발생했습니다.' });
  }
});

// -------- 최종 API 404 처리기 (모든 API 라우트 정의 이후) --------
app.all(/^\/api\/.*$/, (req, res) => {
  console.warn('[API 404 Fallback]', req.method, req.originalUrl);
  res.status(404).json({ success: false, error: `Unknown API route: ${req.method} ${req.originalUrl}` });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// www 없는 도메인으로 리다이렉트
app.use((req, res, next) => {
  if (req.headers.host.startsWith('www.')) {
    return res.redirect(301, `${req.protocol}://${req.headers.host.replace('www.', '')}${req.url}`);
  }
  next();
});

app.listen(PORT, () => {
  console.log(`Standalone community listening on http://localhost:${PORT}`);
});
