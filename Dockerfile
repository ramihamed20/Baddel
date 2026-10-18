FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data
WORKDIR /app
RUN addgroup --system baddel && adduser --system --ingroup baddel baddel
COPY --chown=baddel:baddel server.py ./server.py
COPY --chown=baddel:baddel public/ ./public/
RUN mkdir -p /app/data && chown -R baddel:baddel /app/data
USER baddel
EXPOSE 8787
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=4s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8787/api/health',timeout=3)" || exit 1
CMD ["python", "server.py"]
