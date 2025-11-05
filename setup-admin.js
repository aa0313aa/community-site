const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_FILE = path.join(__dirname, 'community.db');
const db = new sqlite3.Database(DB_FILE);

// 첫 번째 사용자를 관리자로 설정
db.run(`UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)`, function(err) {
  if (err) {
    console.error('관리자 설정 실패:', err.message);
  } else {
    console.log('첫 번째 사용자가 관리자로 설정되었습니다.');
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
