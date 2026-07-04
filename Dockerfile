FROM node:22-alpine

# tzdata so the container cron fires at local (IST) evening, not UTC
RUN apk add --no-cache tzdata
ENV TZ=Asia/Kolkata

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY config.json ./

# Daily auto run at 18:07 local time; log to the mounted data volume
RUN echo '7 18 * * * cd /app && node src/pipeline.js auto >> /app/data/scan.log 2>&1' > /etc/crontabs/root

# Default: run the cron daemon in the foreground (container stays up, fires daily).
# One-shot alternative: docker run --rm ... <image> node src/pipeline.js auto
CMD ["crond", "-f", "-l", "2"]
