const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const RESOLVED_DB_FILE = process.env.DB_FILE && process.env.DB_FILE.trim().length > 0
  ? process.env.DB_FILE.trim()
  : path.join(__dirname, 'community.db');

try {
  const dir = path.dirname(RESOLVED_DB_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
} catch (e) {
  console.warn('DB 디렉터리 생성 경고:', e.message);
}

console.log(`[DB] Using SQLite file: ${RESOLVED_DB_FILE}`);
const db = new sqlite3.Database(RESOLVED_DB_FILE);

// 'aa0313' 사용자를 관리자로 설정
db.run(`UPDATE users SET is_admin = 1 WHERE username = 'aa0313'`, function(err) {
  if (err) {
    console.error('관리자 설정 실패:', err.message);
  } else if (this.changes === 0) {
    console.log('⚠️ 경고: aa0313 사용자를 찾을 수 없습니다.');
    console.log('먼저 aa0313으로 회원가입을 해주세요.');
  } else {
    console.log('✅ aa0313 사용자가 관리자로 설정되었습니다.');
  }
  
  // 설정 후 모든 사용자 조회
  db.all('SELECT id, username, email, is_admin FROM users', (err, rows) => {
    if (err) {
      console.error('사용자 조회 실패:', err.message);
    } else {
      console.log('\n=== 현재 사용자 목록 ===');
      rows.forEach(u => {
        console.log(`ID: ${u.id}, 아이디: ${u.username}, 이메일: ${u.email}, 관리자: ${u.is_admin ? '예' : '아니오'}`);
      });
    }
    db.close();
  });
});
