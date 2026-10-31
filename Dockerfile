FROM node:22-alpine AS web
WORKDIR /w
COPY web/ web/
RUN cd web && npm ci && npm run build

FROM python:3.12-slim
WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server/app.py .
COPY --from=web /w/web/dist /app/static
ENV STATIC_DIR=/app/static
EXPOSE 8000
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}
