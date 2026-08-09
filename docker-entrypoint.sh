#!/bin/sh
# Release phase: migrate, then serve. A failed migration aborts the container
# so a broken deploy is visible instead of silently serving a stale schema.
set -e

echo "Running database migrations..."
node /app/migrate.cjs

echo "Starting server..."
exec node server.js
