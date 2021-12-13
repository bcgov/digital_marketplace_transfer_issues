FROM --platform=linux/amd64 docker.io/node:16-alpine
COPY ./src /usr/app/src
WORKDIR /usr/app
COPY package*.json ./
COPY gruntfile.js ./
COPY ./grunt-configs ./grunt-configs
RUN npm install
RUN npm run front-end:build
RUN npm run back-end:build
RUN chmod -R 775 /usr/app
RUN chown -R node:root /usr/app
EXPOSE 3000
ENTRYPOINT ["/usr/app/src/front-end/docker-entrypoint.sh"]
