# Full-stack image: Vite build + ela-explorer. Nginx serves the SPA on :8338 and proxies API/WebSocket to the Go process on :8339.
# The Go app does not serve static files; this layout matches the frontend default baseURL `/api/v1` on the same origin.

FROM node:20-alpine AS frontend
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.ts tsconfig.json tsconfig.node.json postcss.config.js tailwind.config.js ./
COPY public ./public
COPY src ./src
COPY scripts ./scripts

RUN npm run build

FROM golang:1.24-alpine AS backend
WORKDIR /build

RUN apk add --no-cache ca-certificates git

COPY ela-explorer/go.mod ./
COPY ela-explorer/ ./

RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/explorer ./cmd/explorer

FROM alpine:3.19

RUN apk add --no-cache nginx ca-certificates && \
    addgroup -S app && adduser -S -G app app && \
    mkdir -p /var/lib/nginx/tmp /var/log/nginx /run/nginx && \
    chown -R app:app /var/lib/nginx /var/log/nginx /run/nginx

COPY --from=frontend /app/dist /usr/share/nginx/html
COPY --from=backend /out/explorer /usr/local/bin/explorer

# Go listens on an internal port; Nginx is the public listener on 8338.
ENV LISTEN_ADDR=:8339

RUN printf '%s\n' \
  'limit_req_zone $binary_remote_addr zone=api:10m rate=30r/s;' \
  'limit_req_zone $binary_remote_addr zone=rpc:10m rate=5r/s;' \
  'limit_req_zone $binary_remote_addr zone=sitemap:1m rate=1r/s;' \
  '' \
  'server {' \
  '    listen 8338;' \
  '    server_name _;' \
  '    root /usr/share/nginx/html;' \
  '    gzip on;' \
  '    gzip_types text/css application/javascript application/json application/xml image/svg+xml;' \
  '    add_header X-Content-Type-Options "nosniff" always;' \
  '    add_header X-Frame-Options "DENY" always;' \
  '    add_header Referrer-Policy "strict-origin-when-cross-origin" always;' \
  '    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;' \
  '    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;' \
  '    add_header Content-Security-Policy "default-src '"'"'self'"'"'; script-src '"'"'self'"'"' '"'"'unsafe-inline'"'"'; style-src '"'"'self'"'"' '"'"'unsafe-inline'"'"' https://fonts.googleapis.com; font-src '"'"'self'"'"' https://fonts.gstatic.com; img-src '"'"'self'"'"' data: https:; connect-src '"'"'self'"'"' ws: wss:; frame-ancestors '"'"'none'"'"';" always;' \
  '    location /api/ {' \
  '        limit_req zone=api burst=60 nodelay;' \
  '        add_header X-Robots-Tag "noindex, nofollow" always;' \
  '        proxy_pass http://127.0.0.1:8339;' \
  '        proxy_http_version 1.1;' \
  '        proxy_set_header Host $host;' \
  '        proxy_set_header X-Real-IP $remote_addr;' \
  '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;' \
  '        proxy_set_header X-Forwarded-Proto $scheme;' \
  '    }' \
  '    location /ws {' \
  '        proxy_pass http://127.0.0.1:8339;' \
  '        proxy_http_version 1.1;' \
  '        proxy_set_header Upgrade $http_upgrade;' \
  '        proxy_set_header Connection "upgrade";' \
  '        proxy_set_header Host $host;' \
  '        proxy_read_timeout 86400;' \
  '    }' \
  '    location = /health {' \
  '        proxy_pass http://127.0.0.1:8339;' \
  '        proxy_http_version 1.1;' \
  '        proxy_set_header Host $host;' \
  '    }' \
  '    location = /health/detailed {' \
  '        proxy_pass http://127.0.0.1:8339;' \
  '        proxy_http_version 1.1;' \
  '        proxy_set_header Host $host;' \
  '    }' \
  '    location = /ela {' \
  '        limit_req zone=rpc burst=10 nodelay;' \
  '        proxy_pass http://127.0.0.1:8339;' \
  '        proxy_http_version 1.1;' \
  '        proxy_set_header Host $host;' \
  '        proxy_set_header X-Real-IP $remote_addr;' \
  '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;' \
  '        proxy_set_header X-Forwarded-Proto $scheme;' \
  '    }' \
  '    location = /sitemap.xml {' \
  '        limit_req zone=sitemap burst=2 nodelay;' \
  '        proxy_pass http://127.0.0.1:8339;' \
  '        proxy_http_version 1.1;' \
  '        proxy_set_header Host $host;' \
  '        proxy_set_header X-Real-IP $remote_addr;' \
  '    }' \
  '    location /metrics {' \
  '        deny all;' \
  '        return 403;' \
  '    }' \
  '    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {' \
  '        expires 7d;' \
  '        add_header Cache-Control "public, immutable";' \
  '    }' \
  '    location / {' \
  '        try_files $uri $uri/ @seo;' \
  '    }' \
  '    location @seo {' \
  '        proxy_pass http://127.0.0.1:8339;' \
  '        proxy_http_version 1.1;' \
  '        proxy_set_header Host $host;' \
  '        proxy_set_header X-Real-IP $remote_addr;' \
  '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;' \
  '        proxy_set_header X-Forwarded-Proto $scheme;' \
  '    }' \
  '}' \
  > /etc/nginx/http.d/default.conf

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q --spider http://localhost:8338/health || exit 1

RUN sed -i '/^user /d' /etc/nginx/nginx.conf 2>/dev/null || true && \
    sed -i 's|listen 8338;|listen 8338;|' /etc/nginx/http.d/default.conf && \
    chown -R app:app /usr/share/nginx/html /var/lib/nginx /var/log/nginx /run/nginx /etc/nginx

EXPOSE 8338

USER app

CMD ["/bin/sh", "-c", "nginx && exec /usr/local/bin/explorer"]
