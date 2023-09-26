FROM node:20.7.0-alpine3.17
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
COPY ./package.json /api/package.json
RUN npm i --build-from-source
COPY ./.env ./*.ttf ./server.js /api
CMD ["npm", "run", "prod"]