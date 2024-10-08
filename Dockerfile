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
COPY ./package.json ./package-lock.json /api/
RUN npm ci --build-from-source
COPY ./.env ./*.ttf ./server.js /api

FROM node:20.7.0-alpine3.17
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
COPY --from=build /api /api
RUN chown -R appuser:appgroup /api
USER appuser
EXPOSE 50000
VOLUME /public/out
CMD ["npm", "run", "prod"]