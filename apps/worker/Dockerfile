ARG PYTHON_IMAGE=public.ecr.aws/docker/library/python:3.11-slim-bookworm
FROM ${PYTHON_IMAGE}

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    curl \
    libcurl4 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY apps/worker/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY apps/worker /app
ENV HOST=0.0.0.0
ENV PORT=8787
ENV CUTMUCK_DATA=/data
ENV PUBLIC_BASE_URL=http://127.0.0.1:8787
ENV WEB_ORIGIN=http://localhost:3000

# Fail the image build if the app cannot import (catches Docker path bugs early)
RUN CUTMUCK_DATA=/tmp/cutmuck-data python -c "from app.main import app; print('ok', app.title)"

EXPOSE 8787
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8787"]
