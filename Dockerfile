FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public
COPY README.md ./

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=8789

EXPOSE 8789

CMD ["npm", "start"]
