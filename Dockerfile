# HowGo —— 生产镜像（零依赖 Node，无需 npm install）
FROM node:20-alpine

WORKDIR /app
# PORT 交给平台注入（Railway/Render 会设），本地不注入时代码兜底 5210
ENV NODE_ENV=production

COPY package.json ./
COPY server.js ./
COPY public ./public

# 数据目录（会话 / 用户 / 词库 / 审计）必须挂卷持久化
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

USER node
EXPOSE 5210

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5210)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
