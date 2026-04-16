# Backend-only image: API + syncer (no static UI). Requires PostgreSQL and ELA node RPC.
FROM golang:1.24-alpine AS builder

WORKDIR /build

RUN apk add --no-cache ca-certificates git

COPY go.mod ./
COPY . .

RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/explorer ./cmd/explorer

FROM alpine:3.19

RUN apk add --no-cache ca-certificates && \
    addgroup -S explorer && adduser -S explorer -G explorer

COPY --from=builder /out/explorer /usr/local/bin/explorer

USER explorer

EXPOSE 8339

ENTRYPOINT ["/usr/local/bin/explorer"]
