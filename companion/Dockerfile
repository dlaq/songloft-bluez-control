FROM python:3.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir --disable-pip-version-check -r requirements.txt \
    && groupadd --system --gid 10001 bluezpanel \
    && useradd --system --uid 10001 --gid bluezpanel --home-dir /nonexistent --shell /usr/sbin/nologin bluezpanel

COPY app.py ./
COPY static ./static

USER 10001:10001
EXPOSE 8080

CMD ["python", "/app/app.py"]
