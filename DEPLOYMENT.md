# 🚀 배포 가이드 (두 도메인)

## 📋 도메인 설정

### 1. 도메인 정보
- **도메인 1 (휴대폰)**: `휴대폰90프로.store`
- **도메인 2 (카드)**: `카드90프로.store`

두 도메인 모두 동일한 애플리케이션을 가리키며, 자동으로 SEO가 최적화됩니다.

---

## 🔧 배포 환경 설정

### Node.js 환경 변수 설정

`.env` 파일 생성 (프로젝트 루트):

```env
PORT=4200
NODE_ENV=production

# 도메인 설정 (쉼표로 구분)
ALLOWED_DOMAINS=휴대폰90프로.store,카드90프로.store,www.휴대폰90프로.store,www.카드90프로.store

# 프로토콜
PROTOCOL=https
```

### app.js 환경 변수 지원 추가

```javascript
// app.js 상단에 추가
const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || '').split(',').map(d => d.trim());
const PROTOCOL = process.env.PROTOCOL || 'https';
```

---

## 🌐 NGINX 설정 (리버스 프록시)

`/etc/nginx/sites-available/community.conf`:

```nginx
# 휴대폰90프로.store
server {
    listen 443 ssl http2;
    server_name 휴대폰90프로.store www.휴대폰90프로.store;

    ssl_certificate /etc/letsencrypt/live/휴대폰90프로.store/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/휴대폰90프로.store/privkey.pem;

    location / {
        proxy_pass http://localhost:4200;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# 카드90프로.store
server {
    listen 443 ssl http2;
    server_name 카드90프로.store www.카드90프로.store;

    ssl_certificate /etc/letsencrypt/live/카드90프로.store/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/카드90프로.store/privkey.pem;

    location / {
        proxy_pass http://localhost:4200;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# HTTP → HTTPS 리다이렉트
server {
    listen 80;
    server_name 휴대폰90프로.store www.휴대폰90프로.store 카드90프로.store www.카드90프로.store;
    return 301 https://$server_name$request_uri;
}
```

---

## 🔐 SSL 인증서 설정 (Let's Encrypt)

```bash
# Certbot 설치 (Ubuntu/Debian)
sudo apt-get install certbot python3-certbot-nginx

# 휴대폰90프로.store 인증서
sudo certbot certonly --standalone -d 휴대폰90프로.store -d www.휴대폰90프로.store

# 카드90프로.store 인증서
sudo certbot certonly --standalone -d 카드90프로.store -d www.카드90프로.store

# NGINX 재시작
sudo systemctl restart nginx

# 자동 갱신 설정 (cron)
sudo certbot renew --quiet --no-eff-email
```

---

## 📦 서버 배포 (Linux/Ubuntu)

### 1. 저장소 클론

```bash
cd /var/www
git clone https://github.com/aa0313aa/community-site.git
cd community-site
```

### 2. 의존성 설치

```bash
npm install --production
```

### 3. 데이터베이스 초기화

```bash
# 관리자 계정 생성
node setup-admin.js
```

### 4. PM2로 애플리케이션 실행

```bash
npm install -g pm2

# 앱 시작
pm2 start app.js --name "community"

# 부팅 시 자동 시작
pm2 startup
pm2 save

# 로그 확인
pm2 logs community
```

---

## 🔍 SEO 설정 검증

### Google Search Console
1. `https://search.google.com` 방문
2. 두 도메인 모두 등록:
   - `휴대폰90프로.store`
   - `카드90프로.store`
3. Sitemap 제출:
   - `/sitemap.xml`
4. robots.txt 검증

### Naver Search Advisor
1. `https://searchadvisor.naver.com` 방문
2. 두 도메인 등록
3. Sitemap 제출

### robots.txt 확인
```
GET https://휴대폰90프로.store/robots.txt
GET https://카드90프로.store/robots.txt
```

### sitemap.xml 확인
```
GET https://휴대폰90프로.store/sitemap.xml
GET https://카드90프로.store/sitemap.xml
```

---

## 📊 모니터링 & 로깅

### PM2 모니터링
```bash
pm2 monit
```

### Nginx 로그
```bash
# 접근 로그
tail -f /var/log/nginx/access.log

# 에러 로그
tail -f /var/log/nginx/error.log
```

### 애플리케이션 에러 로그
```bash
pm2 logs community
```

---

## 🚨 트러블슈팅

### 도메인이 작동하지 않는 경우
1. DNS 설정 확인
2. NGINX 설정 문법 검증: `sudo nginx -t`
3. NGINX 재시작: `sudo systemctl restart nginx`

### SSL 인증서 오류
```bash
# 인증서 갱신
sudo certbot renew --force-renewal

# 상태 확인
sudo certbot certificates
```

### 애플리케이션 실행 오류
```bash
# PM2 중지 후 재시작
pm2 stop community
pm2 start app.js --name "community"

# 로그 확인
pm2 logs community
```

---

## 📈 성능 최적화

### GZIP 압축 (NGINX)
```nginx
gzip on;
gzip_types text/plain text/css text/javascript application/json;
gzip_min_length 1024;
```

### 캐시 설정 (NGINX)
```nginx
location ~* \.(js|css|png|jpg|jpeg|gif|ico)$ {
    expires 30d;
    add_header Cache-Control "public, immutable";
}
```

### Node.js 클러스터링
```bash
pm2 start app.js --name "community" -i max
```

---

## 📋 체크리스트

- [ ] GitHub에 코드 푸시
- [ ] 두 도메인 DNS 설정
- [ ] SSL 인증서 발급
- [ ] NGINX 설정 적용
- [ ] Node.js 서버 실행
- [ ] Google Search Console 등록
- [ ] Naver Search Advisor 등록
- [ ] robots.txt 검증
- [ ] sitemap.xml 검증
- [ ] 모바일 테스트
- [ ] 성능 테스트 (PageSpeed Insights)

---

**마지막 업데이트**: 2025년 11월 5일
