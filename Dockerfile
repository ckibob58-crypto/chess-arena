FROM node:22-slim
WORKDIR /app
COPY server/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
ENV HOST=0.0.0.0
ENV PORT=8787
ENV CHESS_ARENA_DATA_DIR=/var/data
EXPOSE 8787
CMD ["node", "server/server.cjs"]
