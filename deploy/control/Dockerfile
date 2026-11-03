# Build the matching runtime image first; both services share the compatibility lock.
FROM dsh-cloud-runtime:0.1.3
USER root
RUN mkdir -p /data/artifacts && chown -R node:node /data
COPY deploy/templates.json /app/deploy/templates.json
USER node
ENV CLOUD_HOST=0.0.0.0 CLOUD_PORT=8787 CLOUD_DATABASE=/data/control.sqlite CLOUD_ARTIFACT_ROOT=/data/artifacts CLOUD_WEB_ROOT=/app/dist/web CLOUD_TEMPLATES=/app/deploy/templates.json NODE_USE_ENV_PROXY=1
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/app/dist/apps/control/main.js"]
