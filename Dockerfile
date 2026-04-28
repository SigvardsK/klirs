# Stage 1: Build
FROM node:22-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# NEXT_PUBLIC_* vars must be available at build time (inlined by Next.js)
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY

RUN npm run build

# Stage 2: Production
FROM node:22-slim AS runner
WORKDIR /app

# Install Playwright dependencies (Chromium)
RUN npx playwright install --with-deps chromium

# Copy built app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Install serverExternalPackages with all transitive deps
RUN npm install --no-save playwright-extra@4.3.6 puppeteer-extra-plugin-stealth@2.11.2

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

CMD ["node", "server.js"]
