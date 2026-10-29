FROM node:22-alpine
WORKDIR /app
COPY package.json server.js seed-catalog.json ./
COPY .agents ./.agents
COPY public ./public
RUN mkdir -p /app/data
EXPOSE 3050
ENV PORT=3050
CMD ["node", "--no-warnings", "server.js"]
