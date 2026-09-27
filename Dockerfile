FROM node:20.7.0-alpine3.17 AS build
WORKDIR /api
RUN apk add --update --no-cache \
    make \
    g++ \
    jpeg-dev \
    cairo-dev \
    giflib-dev \
    pango-dev \
    libtool \
    autoconf \
    automake
COPY ./package.json ./package-lock.json ./
RUN npm ci --build-from-source
COPY ./.env ./*.ttf ./server.js ./api-spec.yaml ./atodo-api-spec.yaml .
COPY ./routes ./routes
COPY ./db ./db
COPY ./lib ./lib
COPY ./scripts ./scripts

FROM node:20.7.0-alpine3.17
# The platform version this image was built as (e.g. 2026.09.27.1; `dev` for
# untagged builds) -- reported by GET /health.
ARG VERSION=dev
ENV APP_VERSION=${VERSION}
RUN apk add --update --no-cache \
    cairo \
    jpeg \
    giflib \
    pango
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
WORKDIR /api
COPY --from=build /api /api
RUN chown -R appuser:appgroup /api
USER appuser
EXPOSE 50000
CMD ["npm", "run", "prod"]