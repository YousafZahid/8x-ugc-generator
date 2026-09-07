# Render free instance: 512 MB RAM, 0.1 CPU, Docker runtime.
#
# Debian slim rather than Alpine: sharp's prebuilt binaries target glibc, and
# building libvips from source on a free-tier builder is not a fight worth
# having for an image whose size does not matter here.

FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:20-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-slim AS runtime
# ffmpeg is the whole product. fontconfig + DejaVu back the SVG text cards -
# without a resolvable font family sharp rasterises the copy as nothing at all.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        fontconfig \
        fonts-dejavu-core \
        ca-certificates \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/fixtures ./fixtures
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts

# Rendered output is written here at runtime and served as a static file.
RUN mkdir -p /app/public/out

EXPOSE 3000
CMD ["npm", "run", "start"]
