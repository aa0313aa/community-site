#!/bin/bash
# 두 도메인 자동 배포 스크립트

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 두 도메인 커뮤니티 사이트 배포 시작${NC}"

# 1. 저장소 클론
echo -e "${YELLOW}1️⃣  저장소 클론 중...${NC}"
cd /var/www
git clone https://github.com/aa0313aa/community-site.git
cd community-site

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ 저장소 클론 실패${NC}"
    exit 1
fi

# 2. 의존성 설치
echo -e "${YELLOW}2️⃣  의존성 설치 중...${NC}"
npm install --production

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ npm install 실패${NC}"
    exit 1
fi

# 3. 환경 변수 설정
echo -e "${YELLOW}3️⃣  환경 변수 설정 중...${NC}"
cat > .env << EOF
PORT=4200
NODE_ENV=production
ALLOWED_DOMAINS=휴대폰90프로.store,카드90프로.store,www.휴대폰90프로.store,www.카드90프로.store
PROTOCOL=https
EOF

echo -e "${GREEN}✅ .env 파일 생성 완료${NC}"

# 4. SSL 인증서 설정
echo -e "${YELLOW}4️⃣  SSL 인증서 발급 중...${NC}"

# 휴대폰90프로.store
sudo certbot certonly --standalone \
    -d 휴대폰90프로.store \
    -d www.휴대폰90프로.store \
    --non-interactive \
    --agree-tos \
    -m aa0313aa@gmail.com

# 카드90프로.store
sudo certbot certonly --standalone \
    -d 카드90프로.store \
    -d www.카드90프로.store \
    --non-interactive \
    --agree-tos \
    -m aa0313aa@gmail.com

echo -e "${GREEN}✅ SSL 인증서 설정 완료${NC}"

# 5. NGINX 설정
echo -e "${YELLOW}5️⃣  NGINX 설정 중...${NC}"
sudo tee /etc/nginx/sites-available/community.conf > /dev/null << 'EOF'
# 휴대폰90프로.store
server {
    listen 443 ssl http2;
    server_name 휴대폰90프로.store www.휴대폰90프로.store;

    ssl_certificate /etc/letsencrypt/live/휴대폰90프로.store/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/휴대폰90프로.store/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    gzip on;
    gzip_types text/plain text/css text/javascript application/json;
    gzip_min_length 1024;

    location / {
        proxy_pass http://localhost:4200;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        proxy_pass http://localhost:4200;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}

# 카드90프로.store
server {
    listen 443 ssl http2;
    server_name 카드90프로.store www.카드90프로.store;

    ssl_certificate /etc/letsencrypt/live/카드90프로.store/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/카드90프로.store/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    gzip on;
    gzip_types text/plain text/css text/javascript application/json;
    gzip_min_length 1024;

    location / {
        proxy_pass http://localhost:4200;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        proxy_pass http://localhost:4200;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}

# HTTP → HTTPS 리다이렉트
server {
    listen 80;
    server_name 휴대폰90프로.store www.휴대폰90프로.store 카드90프로.store www.카드90프로.store;
    return 301 https://$server_name$request_uri;
}
EOF

# NGINX 심볼릭 링크
sudo ln -sf /etc/nginx/sites-available/community.conf /etc/nginx/sites-enabled/

# NGINX 설정 검증
sudo nginx -t
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ NGINX 설정 오류${NC}"
    exit 1
fi

# NGINX 재시작
sudo systemctl restart nginx
echo -e "${GREEN}✅ NGINX 설정 완료${NC}"

# 6. PM2 설정
echo -e "${YELLOW}6️⃣  PM2 설정 중...${NC}"
sudo npm install -g pm2

# 기존 프로세스 종료
pm2 delete community 2>/dev/null

# 앱 시작
pm2 start app.js --name "community" -- --env production

# 부팅 시 자동 시작
pm2 startup
pm2 save

echo -e "${GREEN}✅ PM2 설정 완료${NC}"

# 7. 완료 메시지
echo ""
echo -e "${GREEN}🎉 배포 완료!${NC}"
echo ""
echo -e "${YELLOW}📋 배포 정보:${NC}"
echo -e "도메인 1: ${GREEN}https://휴대폰90프로.store${NC}"
echo -e "도메인 2: ${GREEN}https://카드90프로.store${NC}"
echo ""
echo -e "${YELLOW}📊 검색 엔진 등록:${NC}"
echo "1. Google Search Console: https://search.google.com"
echo "2. Naver Search Advisor: https://searchadvisor.naver.com"
echo ""
echo -e "${YELLOW}🔍 검증:${NC}"
echo "- robots.txt: https://휴대폰90프로.store/robots.txt"
echo "- sitemap.xml: https://휴대폰90프로.store/sitemap.xml"
echo ""
echo -e "${YELLOW}📈 모니터링:${NC}"
echo "- PM2: pm2 monit"
echo "- 로그: pm2 logs community"
echo ""
