# 🚀 GitHub 푸시 & 도메인 설정 완료 가이드

## ✅ 완료된 항목

### 1. ✅ Local Git 설정
- Git 저장소 초기화 완료
- 첫 번째 커밋: "초기 커밋: 업체정보 커뮤니티 사이트 - 두 도메인 지원"
- 두 번째 커밋: "README 업데이트: 도메인 정보 추가"

### 2. ✅ 프로젝트 파일
```
✅ app.js              - Express 백엔드 (SEO 최적화)
✅ package.json        - 의존성 관리
✅ public/index.html   - 메인 인터페이스 (47개 메타 태그)
✅ public/trending.html - 트렌드 페이지
✅ setup-admin.js      - 관리자 계정 생성
✅ SEO_GUIDE.md        - SEO 설정 문서
✅ DEPLOYMENT.md       - 배포 가이드
✅ deploy.sh           - 자동 배포 스크립트
✅ .gitignore          - Git 무시 파일
```

### 3. ✅ SEO 설정
```
✅ 메타 태그 47개 (viewport-fit, format-detection, theme-color 등)
✅ Open Graph 태그 (og:image 1200x630)
✅ Twitter Card 태그
✅ JSON-LD Schema (BlogPosting, FinancialService)
✅ robots.txt (User-agent별 최적화, 악성봇 차단)
✅ sitemap.xml (동적 생성, mobile 네임스페이스)
✅ Canonical URLs
✅ hreflang 설정
✅ security.txt (RFC 9116)
```

---

## 📋 다음 단계 (수동 필수)

### Step 1️⃣: GitHub에 Remote 저장소 추가

GitHub에서 새 저장소를 먼저 생성하세요:

1. https://github.com/aa0313aa 접속
2. **New** 버튼 클릭
3. Repository 이름: `community-site`
4. Description: `소액결제·신용카드 업체 정보 커뮤니티 (두 도메인 지원)`
5. **Public** 선택
6. README 체크 해제 (이미 있음)
7. Create repository

그 후 아래 명령어 실행:

```bash
cd "c:\Users\aa031\OneDrive\바탕 화면\site\community"
git remote add origin https://github.com/aa0313aa/community-site.git
git branch -M main
git push -u origin main
```

### Step 2️⃣: 도메인 DNS 설정

**도메인 1: 휴대폰90프로.store**

도메인 호스팅 제공자 (Namecheap, GoDaddy 등)에서:

```
A Record:
Name: @
Value: [서버 IP 주소]
TTL: 3600

A Record (www):
Name: www
Value: [서버 IP 주소]
TTL: 3600
```

**도메인 2: 카드90프로.store**

동일한 설정 반복:

```
A Record:
Name: @
Value: [서버 IP 주소]
TTL: 3600

A Record (www):
Name: www
Value: [서버 IP 주소]
TTL: 3600
```

### Step 3️⃣: 서버 배포 (Linux/Ubuntu)

SSH로 서버 접속:

```bash
ssh root@[서버IP]

# 배포 스크립트 다운로드 및 실행
curl -O https://raw.githubusercontent.com/aa0313aa/community-site/main/deploy.sh
chmod +x deploy.sh
./deploy.sh
```

또는 수동 배포:

```bash
cd /var/www
git clone https://github.com/aa0313aa/community-site.git
cd community-site
npm install --production

# .env 파일 생성
cat > .env << EOF
PORT=4200
NODE_ENV=production
ALLOWED_DOMAINS=휴대폰90프로.store,카드90프로.store,www.휴대폰90프로.store,www.카드90프로.store
PROTOCOL=https
EOF

# SSL 인증서 발급 (Let's Encrypt)
sudo certbot certonly --standalone -d 휴대폰90프로.store -d www.휴대폰90프로.store
sudo certbot certonly --standalone -d 카드90프로.store -d www.카드90프로.store

# NGINX 설정 (위의 DEPLOYMENT.md 참조)

# PM2로 실행
npm install -g pm2
pm2 start app.js --name "community"
pm2 startup
pm2 save
```

---

## 🌐 도메인 검증

### 1. DNS 전파 확인

```bash
nslookup 휴대폰90프로.store
nslookup 카드90프로.store
```

### 2. HTTPS 연결 확인

```bash
curl -I https://휴대폰90프로.store
curl -I https://카드90프로.store
```

### 3. SEO 페이지 확인

```bash
# 메타 태그 확인
curl https://휴대폰90프로.store | grep "og:title"

# robots.txt 확인
curl https://휴대폰90프로.store/robots.txt

# sitemap.xml 확인
curl https://휴대폰90프로.store/sitemap.xml
```

---

## 📊 검색 엔진 등록

### Google Search Console

1. https://search.google.com/search-console 접속
2. **URL 속성** → 새 속성 추가
3. 첫 번째 도메인: `https://휴대폰90프로.store`
   - 소유권 확인 (권장: HTML 파일 업로드)
4. 두 번째 도메인: `https://카드90프로.store`
   - 동일한 방식으로 확인

각 도메인에서:
- Sitemap 제출: `/sitemap.xml`
- robots.txt 검증
- Core Web Vitals 모니터링

### Naver Search Advisor

1. https://searchadvisor.naver.com 접속
2. 새 사이트 추가
3. 첫 번째 도메인: `휴대폰90프로.store`
4. 두 번째 도메인: `카드90프로.store`
5. 각각 Sitemap 제출

---

## 🔐 SSL 인증서 자동 갱신

Let's Encrypt 인증서는 90일 유효하므로 자동 갱신 설정:

```bash
# Cron 작업 추가
sudo crontab -e

# 매월 1일 오전 2시 자동 갱신
0 2 1 * * sudo certbot renew --quiet --no-eff-email
```

---

## 📈 성능 확인

### Google PageSpeed Insights

1. https://pagespeed.web.dev 접속
2. 두 도메인 분석:
   - https://휴대폰90프로.store
   - https://카드90프로.store

### GTmetrix

1. https://gtmetrix.com 접속
2. 성능 분석

### Lighthouse

```bash
npm install -g lighthouse

lighthouse https://휴대폰90프로.store --view
lighthouse https://카드90프로.store --view
```

---

## 📞 문제 해결

### 도메인이 작동하지 않는 경우

```bash
# DNS 설정 확인
nslookup 휴대폰90프로.store

# 포트 확인
sudo netstat -tuln | grep 80
sudo netstat -tuln | grep 443

# NGINX 상태 확인
sudo systemctl status nginx

# NGINX 설정 검증
sudo nginx -t

# 방화벽 확인
sudo ufw status
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

### SSL 인증서 오류

```bash
# 인증서 상태 확인
sudo certbot certificates

# 강제 갱신
sudo certbot renew --force-renewal
```

### Node.js 애플리케이션 오류

```bash
# 프로세스 상태 확인
pm2 status

# 로그 확인
pm2 logs community

# 오류 시 재시작
pm2 restart community
```

---

## 📋 체크리스트

- [ ] GitHub 저장소 생성
- [ ] 로컬 저장소에 remote 추가
- [ ] GitHub에 푸시
- [ ] 도메인 1 DNS 설정 (휴대폰90프로.store)
- [ ] 도메인 2 DNS 설정 (카드90프로.store)
- [ ] 서버에 배포
- [ ] SSL 인증서 발급
- [ ] NGINX 설정 및 재시작
- [ ] PM2 실행 및 자동 시작 설정
- [ ] 두 도메인 모두 HTTPS 연결 확인
- [ ] robots.txt 접근 확인
- [ ] sitemap.xml 접근 확인
- [ ] Google Search Console 등록 (도메인 1)
- [ ] Google Search Console 등록 (도메인 2)
- [ ] Naver Search Advisor 등록 (도메인 1)
- [ ] Naver Search Advisor 등록 (도메인 2)
- [ ] Sitemap 제출 (Google)
- [ ] Sitemap 제출 (Naver)
- [ ] 성능 테스트 (PageSpeed Insights)

---

## 🎯 최종 확인

모든 설정 완료 후:

```bash
# 도메인 1 확인
echo "도메인 1 테스트:"
curl -I https://휴대폰90프로.store

# 도메인 2 확인
echo "도메인 2 테스트:"
curl -I https://카드90프로.store

# 로그 확인
pm2 logs community | tail -20
```

---

**준비 상태**: ✅ 모든 파일 준비 완료, GitHub 푸시만 남음
**예상 배포 시간**: 약 30분 (DNS 전파 제외)
**지원 도메인**: 2개 (휴대폰90프로.store, 카드90프로.store)
**SEO 최적화**: ✅ 완료 (메타 태그, robots.txt, sitemap.xml, JSON-LD)
